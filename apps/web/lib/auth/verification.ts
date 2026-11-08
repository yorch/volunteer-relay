import { createHash, randomBytes } from "node:crypto";
import { type Database, sql } from "@relay/db";
import { recordMailDeliveryFailure } from "./delivery.ts";
import type { AuthMailCallbacks } from "./mail.ts";

// Pending verification and reset tokens kept per account. A request beyond the
// cap invalidates the oldest pending token, so repeated requests cannot grow
// the verification table without bound.
export const maxOutstandingTokensPerUser = 3;

const prefix = "email-verification:v1:";
function identity(token: string): string {
  return prefix + createHash("sha256").update(token).digest("hex");
}

/** Private auth persistence, deliberately separate from the SDK's replayable JWT. */
export function createEmailVerification(
  db: Database,
  appUrl: string,
  mail?: AuthMailCallbacks,
) {
  return {
    configured: Boolean(mail?.sendEmailVerification),
    async request(email: string): Promise<void> {
      const token = randomBytes(32).toString("base64url");
      const result = await db.execute(sql`
        select id, email, name from "user" where lower(email) = ${email.toLowerCase()} and email_verified = false
      `);
      const user = result.rows[0] as
        | { id: string; email: string; name: string }
        | undefined;
      if (!user) return;
      const id = identity(token);
      await db.execute(sql`
        insert into verification (id, identifier, value, expires_at, created_at, updated_at)
        values (${id}, ${prefix + user.id}, ${JSON.stringify({ userId: user.id, email: user.email })}, now() + interval '1 hour', now(), now())
      `);
      await db.execute(sql`
        delete from verification
        where identifier = ${prefix + user.id}
          and id not in (
            select id from verification
            where identifier = ${prefix + user.id} and expires_at > now()
            order by created_at desc, id desc
            limit ${maxOutstandingTokensPerUser}
          )
      `);
      const url = new URL("/verify-email", appUrl);
      url.searchParams.set("token", token);
      try {
        await mail?.sendEmailVerification?.({
          to: user.email,
          name: user.name,
          verificationUrl: url.toString(),
          token,
        });
      } catch {
        // Recipient-specific delivery failure cannot enumerate accounts, so the
        // caller still sees success. Leave an operator-visible trace that says
        // only that delivery failed: no address, no token, no driver detail.
        // The error object is deliberately not inspected — `name` and `message`
        // are mutable transport strings, not a trusted category. The pending row
        // survives, so /verify-email can send a fresh link.
        recordMailDeliveryFailure("verification");
        console.warn("auth.verification.delivery_failed");
      }
    },
    async confirm(token: string): Promise<boolean> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
      return db.transaction(async (tx) => {
        // DELETE locks the unique PK: a concurrent consumer sees no row after
        // commit; a failed user update rolls back both mutations.
        const consumed = await tx.execute(sql`
          delete from verification where id = ${identity(token)} and expires_at > clock_timestamp() returning value
        `);
        const row = consumed.rows[0] as { value: string } | undefined;
        if (!row) return false;
        const binding: unknown = JSON.parse(row.value);
        if (
          typeof binding !== "object" ||
          binding === null ||
          !("userId" in binding) ||
          !("email" in binding) ||
          typeof binding.userId !== "string" ||
          typeof binding.email !== "string"
        )
          return false;
        const updated = await tx.execute(sql`
          update "user" set email_verified = true, updated_at = now()
          where id = ${binding.userId} and email = ${binding.email} and email_verified = false returning id
        `);
        return updated.rows.length === 1;
      });
    },
  };
}
