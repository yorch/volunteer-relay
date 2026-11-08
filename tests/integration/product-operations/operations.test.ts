import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOperationsHttp } from "../../../apps/web/lib/product/operations.ts";
import {
  createDeterministicProvider,
  createExtractionService,
} from "../../../packages/ai/src/index.ts";
import { createFilesystemBlobStore } from "../../../packages/blob/src/index.ts";
import type {
  SourceEnvelope,
  TenantContext,
} from "../../../packages/contracts/src/index.ts";
import {
  createProcessingRepository,
  createSourceStore,
  sql,
} from "../../../packages/db/src/index.ts";
import { createSourceRepository } from "../../../packages/domain/core/src/sources/index.ts";
import {
  context,
  type DomainFixture,
  openDomainFixture,
  staffOrigin,
  systemContext,
} from "../domain/domain-support.ts";

let fixture: DomainFixture;
let owner: TenantContext;
let coordinator: TenantContext;
let reader: TenantContext;
let harbor: TenantContext;
let needId: string;
let handler: ReturnType<typeof createOperationsHttp>;
const call = (actor: TenantContext, path: string) =>
  handler(
    actor,
    path.split("?")[0] ?? "",
    new Request(`http://localhost/api/product/${path}`),
  );
beforeAll(async () => {
  fixture = await openDomainFixture();
  owner = await context(fixture.authorization, "user-rae", "tidepath", "owner");
  coordinator = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "staff",
  );
  reader = await context(
    fixture.authorization,
    "user-ren",
    "tidepath",
    "reader",
  );
  harbor = await context(fixture.authorization, "user-ive", "harbor", "harbor");
  handler = createOperationsHttp(
    fixture.db,
    createFilesystemBlobStore({ root: "/tmp" }),
  );
  const need = await fixture.needs.create(coordinator, {
    schemaVersion: 1,
    idempotencyKey: "need",
    category: "food",
    urgency: "urgent",
    summary: "Synthetic need",
    provisional: true,
    dueAt: null,
    acknowledgeBy: "2020-01-01T00:00:00Z",
    origin: staffOrigin,
  });
  if (!need.ok) throw new Error("Need creation failed");
  needId = need.value.needId;
  await fixture.db.execute(
    sql`insert into notification_preference(organization_id,membership_id,email,telegram) values ('tidepath','tidepath-kai',true,false)`,
  );
  await fixture.db.execute(sql`insert into delivery_job(organization_id,id,recipient_id,channel,delivery_key,template,app_path,need_id,need_revision,attempts,accepted_at,created_at) values
    ('tidepath','pending','tidepath-kai','email','p','need-assigned','/workspace/inbox',${needId},1,0,null,now()),
    ('tidepath','failed','tidepath-kai','email','f','need-assigned','/workspace/inbox',${needId},1,3,null,now()),
    ('tidepath','obsolete','tidepath-kai','email','o','need-assigned','/workspace/inbox',${needId},2,0,null,now()),
    ('tidepath','accepted','tidepath-kai','email','a','need-assigned','/workspace/inbox',${needId},1,1,now(),now()),
    ('harbor','foreign','harbor-ive','email','foreign','need-assigned','/workspace/inbox','foreign',1,0,null,now())`);
  await fixture.db.execute(
    sql`insert into model_budget_window(window_start,window_end,limit_micro_usd,created_at) values ('2025-01-01','2030-01-01',100000,now()) on conflict do nothing`,
  );
  await fixture.db.execute(sql`insert into model_budget_reservation(id,organization_id,request_id,window_start,model,input_token_limit,output_token_limit,input_rate,output_rate,reserved_micro_usd,status,actual_input,actual_output,actual_micro_usd,created_at,updated_at) values
    ('reserved','tidepath','reserved','2025-01-01','fixture',1,1,1,1,120,'sent',null,null,null,now(),now()),
    ('settled','tidepath','settled','2025-01-01','fixture',1,1,1,1,200,'settled',1,1,75,now(),now()),
    ('foreign','harbor','foreign','2025-01-01','fixture',1,1,1,1,9000,'reserved',null,null,null,now(),now())`);
});
afterAll(async () => {
  await fixture?.close();
});

it("requires a current matching staff role and owner for operations", async () => {
  expect(await call(reader, "audit")).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  expect(await call(coordinator, "operations")).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  if (reader.actor.kind !== "user") throw new Error("Expected user");
  expect(
    await call(
      { ...reader, actor: { ...reader.actor, role: "owner" } },
      "operations",
    ),
  ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  await fixture.db.execute(sql`delete from member where id='tidepath-ren'`);
  expect(await call(reader, "deliveries")).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
});

it("returns tenant-scoped audit events and validates filters", async () => {
  expect(
    await call(coordinator, `audit?aggregateId=${encodeURIComponent(needId)}`),
  ).toMatchObject({
    ok: true,
    value: {
      entries: [
        {
          aggregateType: "need",
          aggregateId: needId,
          action: "create",
          revision: 1,
        },
      ],
    },
  });
  expect(
    await call(harbor, `audit?aggregateId=${encodeURIComponent(needId)}`),
  ).toEqual({ ok: true, value: { entries: [] } });
  expect(await call(owner, "audit?before=bad")).toMatchObject({
    ok: false,
    error: { code: "VALIDATION" },
  });
});

it("shows delivery lifecycle without recipient addresses and scopes metrics to the tenant", async () => {
  const deliveries = await call(coordinator, "deliveries");
  expect(deliveries?.ok).toBe(true);
  if (!deliveries?.ok) throw new Error("Delivery read failed");
  const values = deliveries.value as { id: string; status: string }[];
  expect(
    Object.fromEntries(values.map((value) => [value.id, value.status])),
  ).toEqual({
    pending: "pending",
    failed: "failed",
    obsolete: "obsolete",
    accepted: "accepted",
  });
  expect(JSON.stringify(values)).not.toContain("@example");
  expect(await call(owner, "operations")).toMatchObject({
    ok: true,
    value: {
      queuedSources: 0,
      failedSources: 0,
      unresolvedUrgentNeeds: 1,
      overdueAcknowledgments: 1,
      failedDeliveries: 1,
      modelReservedMicroUsd: 120,
      modelSettledMicroUsd: 75,
      availableStorageBytes: expect.any(Number),
    },
  });
  expect(await call(harbor, "deliveries")).toMatchObject({
    ok: true,
    value: [{ id: "foreign", status: "obsolete" }],
  });
});

it("reclassifies pending deliveries after recipient membership is revoked", async () => {
  await fixture.db.execute(
    sql`update member set role='volunteer' where id='tidepath-kai'`,
  );
  const result = await call(owner, "deliveries");
  if (!result?.ok) throw new Error("Delivery read failed");
  const statuses = Object.fromEntries(
    (result.value as { id: string; status: string }[]).map((entry) => [
      entry.id,
      entry.status,
    ]),
  );
  expect(statuses).toMatchObject({
    pending: "obsolete",
    failed: "obsolete",
    accepted: "accepted",
  });
  expect(await call(coordinator, "audit")).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  expect(await call(owner, "operations")).toMatchObject({
    ok: true,
    value: { failedDeliveries: 0 },
  });
});

it("projects source review and retry history without exposing proposal bodies", async () => {
  const sources = JSON.parse(
    await readFile("fixtures/sources.json", "utf8"),
  ) as SourceEnvelope[];
  const source = sources[7];
  if (!source) throw new Error("Missing synthetic source");
  const intake = createSourceRepository({
    authorization: fixture.authorization,
    store: createSourceStore(fixture.db),
  });
  expect((await intake.accept(owner, source)).ok).toBe(true);
  const processing = createProcessingRepository(fixture.db);
  const [lease] = await processing.pendingSources(1);
  if (!lease) throw new Error("Missing lease");
  const proposal = await createExtractionService({
    provider: createDeterministicProvider(),
  }).extract(systemContext("tidepath"), source, {
    model: "test",
    prompt: "test",
    policy: lease.policy.policyVersion,
  });
  if (!proposal.ok) throw new Error("Missing proposal");
  expect(
    (
      await processing.persistProposal(
        systemContext("tidepath"),
        source,
        proposal.value,
        lease.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(
    (
      await processing.decide(owner, {
        runId: proposal.value.runId,
        expectedRevision: 1,
        idempotencyKey: "audit-review",
        decision: "reject",
        reason: "Rejected synthetic instruction",
      })
    ).ok,
  ).toBe(true);
  await fixture.db.execute(
    sql`insert into processing_retry(organization_id,idempotency_key,source_id,source_revision,prior_attempts,actor,correlation_id) values ('tidepath','audit-retry',${source.sourceId},1,3,${JSON.stringify(owner.actor)}::jsonb,'audit')`,
  );
  const result = await call(owner, `audit?aggregateId=${source.sourceId}`);
  expect(result).toMatchObject({
    ok: true,
    value: {
      entries: expect.arrayContaining([
        expect.objectContaining({
          aggregateType: "source",
          action: "review:reject",
        }),
        expect.objectContaining({ aggregateType: "source", action: "retry" }),
      ]),
    },
  });
  expect(JSON.stringify(result)).not.toContain(source.text);
});
