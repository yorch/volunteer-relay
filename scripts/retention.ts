import { readFile, writeFile } from "node:fs/promises";
import {
  redactionLedgerRecordSchema,
  signedRedactionLedgerSchema,
} from "../packages/contracts/src/index.ts";
import {
  createDatabase,
  createMembershipReader,
  createRetentionRepository,
  sql,
} from "../packages/db/src/index.ts";
import { createAuthorizationService } from "../packages/domain/auth/src/index.ts";
import { createRedactionSigner } from "../packages/domain/core/src/retention/ledger-signing.ts";

const [command, ...argv] = process.argv.slice(2),
  args = new Map<string, string>();
for (let i = 0; i < argv.length; i += 2) {
  const option = argv[i],
    value = argv[i + 1];
  if (!option?.startsWith("--") || !value)
    throw new Error("Expected --name value arguments");
  args.set(option.slice(2), value);
}
const connection = process.env.DATABASE_URL,
  key = process.env.RETENTION_LEDGER_KEY,
  file = args.get("file"),
  all = command?.endsWith("-all");
if (
  !connection ||
  !key ||
  !file ||
  !["export", "restore", "export-all", "restore-all"].includes(command ?? "")
)
  throw new Error(
    "Use retention.ts export[-all]|restore[-all] --file PATH; organization mode also needs --organization ID --owner USER. DATABASE_URL and RETENTION_LEDGER_KEY required.",
  );
const signer = createRedactionSigner(key),
  opened = createDatabase(connection),
  org = args.get("organization"),
  user = args.get("owner");
try {
  let context:
    | Awaited<
        ReturnType<ReturnType<typeof createAuthorizationService>["resolve"]>
      >
    | undefined;
  if (!all) {
    if (!org || !user) throw new Error("Organization and owner required");
    context = await createAuthorizationService({
      memberships: createMembershipReader(opened.db),
    }).resolve(user, org, "operator-retention-ledger");
    if (
      !context.ok ||
      context.value.actor.kind !== "user" ||
      context.value.actor.role !== "owner"
    )
      throw new Error("Current owner authority required");
  }
  if (command?.startsWith("export")) {
    let records: Array<
      import("../packages/contracts/src/index.ts").RedactionLedgerRecord
    >;
    if (all) {
      const rows = await opened.db.execute(
        sql`select organization_id as "organizationId",source_id as "sourceId",expected_revision as "latestRevision",source_digest as "sourceDigest",redaction_id as "redactionId",reason_hash as "reasonHash",redacted_at as "redactedAt" from source_redaction order by organization_id,source_id`,
      );
      records = rows.rows.map((row) =>
        redactionLedgerRecordSchema.parse({
          ...row,
          redactedAt: new Date(row.redactedAt as string | Date).toISOString(),
        }),
      );
    } else {
      if (!context?.ok) throw new Error("Owner required");
      const result = await createRetentionRepository(
        opened.db,
      ).listRedactionLedger(context.value);
      if (!result.ok) throw new Error("Export unavailable");
      records = result.value;
    }
    const data = {
      version: 1 as const,
      scope: all ? ("deployment" as const) : ("organization" as const),
      exportedAt: new Date().toISOString(),
      records: records.map((record) => ({
        record,
        signature: signer.sign(record),
      })),
    };
    const output = `${JSON.stringify({ ...data, manifestSignature: signer.signManifest(data) }, null, 2)}\n`;
    if (file === "-") process.stdout.write(output);
    else {
      await writeFile(file, output, { flag: "wx", mode: 0o600 });
      console.info(
        JSON.stringify({
          event: "retention-ledger-exported",
          records: records.length,
        }),
      );
    }
  } else {
    const bytes = await readFile(file);
    if (bytes.length > 10485760) throw new Error("Ledger too large");
    const parsed = signedRedactionLedgerSchema.safeParse(
      JSON.parse(bytes.toString("utf8")),
    );
    if (!parsed.success) throw new Error("Invalid ledger");
    const { manifestSignature, ...data } = parsed.data;
    if (
      !signer.verifyManifest(data, manifestSignature) ||
      (all && data.scope !== "deployment") ||
      data.records.some(
        (item) =>
          (!all && item.record.organizationId !== org) ||
          !signer.verify(item.record, item.signature),
      )
    )
      throw new Error("Invalid signed ledger");
    await opened.db.transaction(async (tx) => {
      const repository = createRetentionRepository(
        tx as unknown as typeof opened.db,
        { verifyRedactionLedger: signer.verify },
      );
      for (const item of data.records) {
        const present = await tx.execute(
          sql`select 1 from source where organization_id=${item.record.organizationId} and id=${item.record.sourceId}`,
        );
        if (!present.rows.length) continue;
        const result = await repository.restoreRedactionLedger(
          item.record,
          item.signature,
        );
        if (!result.ok)
          throw new Error("Ledger restore conflicts; keep target offline");
      }
    });
    console.info(
      JSON.stringify({
        event: "retention-ledger-restored",
        records: data.records.length,
      }),
    );
  }
} catch {
  console.error(
    "Retention ledger operation failed; keep any restore target offline and inspect configuration/history",
  );
  process.exitCode = 1;
} finally {
  await opened.close();
}
