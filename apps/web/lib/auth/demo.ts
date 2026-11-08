import { type Database, schema, sql } from "@relay/db";
import type { Auth } from "./auth.ts";

// Intentionally public SYNTHETIC demo inputs. Never use these credentials for
// ordinary accounts. All identities are fictional and cannot receive mail.
export const demoPassword = "Public-Synthetic-Demo-Only-2026!";
const demoPeople = [
  { key: "owner", name: "Demo Owner", role: "owner" },
  { key: "coordinator", name: "Demo Coordinator", role: "coordinator" },
  { key: "volunteer", name: "Demo Volunteer", role: "volunteer" },
  { key: "reader", name: "Demo Reader", role: "report-reader" },
  { key: "multi", name: "Demo Multi", role: "owner" },
] as const;

const tenants = [
  { id: "tidepath", slug: "tidepath", name: "Tidepath Mutual Aid" },
  { id: "harbor", slug: "harbor", name: "Harbor Neighbour Network" },
];

export function requireDemoProfile(
  args: readonly string[],
  env: Record<string, string | undefined>,
): void {
  if (
    args.length !== 1 ||
    args[0] !== "--demo" ||
    env.DEMO_MODE !== "true" ||
    !["development", "test"].includes(env.NODE_ENV ?? "")
  )
    throw new Error(
      "Demo provisioning requires --demo, DEMO_MODE=true and development/test",
    );
}

/**
 * No signup endpoint, session or mail side effects. Existing auth supplies its
 * configured credential hashing/verifier. The explicit fixture profile alone
 * creates verified emails; ordinary registration/verification is unchanged.
 *
 * Create absent complete identities; reuse only exact complete identities with
 * matching credentials and roster. Partial identities or collisions abort the
 * entire transaction, preserving existing passwords, memberships and accounts.
 */
export async function provisionDemo(
  dependencies: { db: Database; auth: Pick<Auth, "$context"> },
  args: readonly string[],
  env: Record<string, string | undefined>,
): Promise<{ createdUsers: number; reusedUsers: number }> {
  requireDemoProfile(args, env);
  try {
    const { db, auth } = dependencies;
    const { password } = await auth.$context;
    return await db.transaction(async (tx) => {
      // Rare opt-in setup operation: serialize all relevant writers, including
      // ordinary auth writers, so checks and inserts cannot race a password or
      // role update. Acquire locks in a fixed order; no external side effects.
      await tx.execute(
        sql`lock table "organization", "user", "account", "member" in share row exclusive mode`,
      );
      const conflict = () => {
        throw new Error("Demo profile conflict");
      };
      const missingTenants: typeof tenants = [];
      for (const tenant of tenants) {
        const rows = await tx
          .select()
          .from(schema.organization)
          .where(
            sql`${schema.organization.id} = ${tenant.id} or ${schema.organization.slug} = ${tenant.slug}`,
          );
        if (!rows.length) missingTenants.push(tenant);
        else if (
          rows.length !== 1 ||
          rows[0]?.id !== tenant.id ||
          rows[0]?.slug !== tenant.slug ||
          rows[0]?.name !== tenant.name
        )
          conflict();
      }
      const missingPeople: Array<(typeof demoPeople)[number]> = [];
      for (const person of demoPeople) {
        const id = `demo-${person.key}`;
        const email = `${id}@example.invalid`;
        const expectedMembers = [
          {
            id: `tidepath-${id}`,
            organizationId: "tidepath",
            userId: id,
            role: person.role,
          },
          ...(person.key === "multi"
            ? [
                {
                  id: `harbor-${id}`,
                  organizationId: "harbor",
                  userId: id,
                  role: "report-reader",
                },
              ]
            : []),
        ];
        const users = await tx
          .select()
          .from(schema.user)
          .where(
            sql`${schema.user.id} = ${id} or lower(${schema.user.email}) = ${email}`,
          );
        const accounts = await tx
          .select()
          .from(schema.account)
          .where(
            sql`${schema.account.userId} = ${id} or ${schema.account.id} = ${id} or (${schema.account.providerId} = 'credential' and ${schema.account.accountId} = ${id})`,
          );
        const members = await tx
          .select()
          .from(schema.member)
          .where(
            sql`${schema.member.userId} = ${id} or ${schema.member.id} in (${sql.join(
              expectedMembers.map((m) => sql`${m.id}`),
              sql`, `,
            )})`,
          );
        if (!users.length) {
          if (accounts.length || members.length) conflict();
          missingPeople.push(person);
          continue;
        }
        const stored = users[0];
        const credential = accounts[0];
        if (
          users.length !== 1 ||
          stored?.id !== id ||
          stored.email !== email ||
          stored.name !== person.name ||
          !stored.emailVerified ||
          accounts.length !== 1 ||
          credential?.id !== id ||
          credential.userId !== id ||
          credential.accountId !== id ||
          credential.providerId !== "credential" ||
          !credential.password
        )
          conflict();
        if (
          !credential?.password ||
          !(await password.verify({
            hash: credential.password,
            password: demoPassword,
          }))
        )
          conflict();
        if (
          members.length !== expectedMembers.length ||
          expectedMembers.some(
            (expected) =>
              !members.some(
                (m) =>
                  m.id === expected.id &&
                  m.userId === expected.userId &&
                  m.organizationId === expected.organizationId &&
                  m.role === expected.role,
              ),
          )
        )
          conflict();
      }
      // Only after every collision check passes do any rows change.
      for (const tenant of missingTenants)
        await tx.insert(schema.organization).values(tenant);
      for (const person of missingPeople) {
        const id = `demo-${person.key}`;
        await tx.insert(schema.user).values({
          id,
          name: person.name,
          email: `${id}@example.invalid`,
          emailVerified: true,
        });
        await tx.insert(schema.account).values({
          id,
          accountId: id,
          providerId: "credential",
          userId: id,
          password: await password.hash(demoPassword),
        });
        await tx.insert(schema.member).values({
          id: `tidepath-${id}`,
          organizationId: "tidepath",
          userId: id,
          role: person.role,
        });
        if (person.key === "multi")
          await tx.insert(schema.member).values({
            id: `harbor-${id}`,
            organizationId: "harbor",
            userId: id,
            role: "report-reader",
          });
      }
      return {
        createdUsers: missingPeople.length,
        reusedUsers: demoPeople.length - missingPeople.length,
      };
    });
  } catch {
    // No driver details, identifiers, passwords, hashes or tokens escape.
    throw new Error(
      "Demo provisioning refused: conflict or unavailable dependency",
    );
  }
}
