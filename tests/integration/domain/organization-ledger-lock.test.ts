// Database-backed: runs only with an explicit *_test TEST_DATABASE_URL.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ExtractionProposal,
  SourceEnvelope,
} from "../../../packages/contracts/src/index.ts";
import { sql } from "../../../packages/db/src/index.ts";
import { lockOrganizationLedger } from "../../../packages/db/src/repositories/domain.ts";
import { createFollowThroughRepository } from "../../../packages/db/src/repositories/follow-through.ts";
import { createProcessingRepository } from "../../../packages/db/src/repositories/processing.ts";
import { createSourceStore } from "../../../packages/db/src/repositories/sources.ts";
import { seedOrganizations } from "../../../packages/db/src/seed-data.ts";
import { createSourceRepository } from "../../../packages/domain/core/src/sources/index.ts";
import { resetAuthTables } from "../auth/support.ts";
import {
  context,
  type DomainFixture,
  openDomainFixture,
  seedDomainMembers,
  systemContext,
} from "./domain-support.ts";

const DAY = "2026-11-04";
const TEXT = "Helped at the pantry";

function sourceFor(sourceId: string): SourceEnvelope {
  return {
    schemaVersion: 1,
    organizationId: "tidepath",
    sourceId,
    revision: 1,
    channel: "web",
    channelIdentity: "web",
    externalMessageId: `ext-${sourceId}`,
    idempotencyKey: `idem-${sourceId}`,
    author: { externalIdentity: "Mira", membershipId: "tidepath-mira" },
    occurredAt: null,
    receivedAt: "2026-11-04T15:01:00Z",
    timezone: "UTC",
    text: TEXT,
    attachments: [],
    replyToSourceId: null,
    replacesRevision: null,
    original: { mediaType: "text/plain", payload: TEXT },
  };
}

function proposalFor(
  sourceId: string,
  options: { localDate?: string; urgentNeed?: boolean } = {},
): ExtractionProposal {
  const evidence = [
    {
      kind: "text" as const,
      field: "activity",
      sourceId,
      sourceRevision: 1,
      start: 0,
      end: 6,
      quote: "Helped",
    },
  ];
  const items: ExtractionProposal["items"] = [
    {
      kind: "activity",
      key: "a",
      activityKind: "visit",
      localDate: options.localDate ?? DAY,
      datePrecision: "day",
      beneficiaryReference: null,
      evidence,
    },
    {
      kind: "contribution",
      key: "c",
      activityKey: "a",
      membershipId: "tidepath-mira",
      durationMinutes: 60,
      evidence,
    },
  ];
  if (options.urgentNeed)
    items.push({
      kind: "need",
      key: "n",
      category: "food",
      urgency: "urgent",
      summary: "Food tonight",
      provisional: true,
      evidence,
    });
  return {
    schemaVersion: 1,
    organizationId: "tidepath",
    sourceId,
    sourceRevision: 1,
    runId: `run-${sourceId}`,
    modelVersion: "model",
    promptVersion: "prompt",
    policyVersion: "1",
    unresolved: [],
    items,
  };
}

type Tracked<T> = { promise: Promise<T>; settled: () => boolean };
function track<T>(promise: Promise<T>): Tracked<T> {
  let done = false;
  const wrapped = promise.finally(() => {
    done = true;
  });
  return { promise: wrapped, settled: () => done };
}

const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;

run("organization ledger lock", { timeout: 30_000 }, () => {
  let fixture: DomainFixture;
  beforeAll(async () => {
    fixture = await openDomainFixture();
  });
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    await resetAuthTables(fixture.db);
    await seedOrganizations(fixture.db);
    await seedDomainMembers(fixture.db);
  });

  async function enableAutomaticPolicy(): Promise<void> {
    const owner = await context(
      fixture.authorization,
      "user-rae",
      "tidepath",
      "owner",
    );
    const updated = await createFollowThroughRepository(
      fixture.db,
    ).updateSettings(owner, {
      expectedRevision: 1,
      idempotencyKey: "settings",
      timezone: "UTC",
      automationPolicy: "validated-auto-record",
      policyVersion: "1",
      routing: {},
      fallbackMembershipId: null,
      ackMinutes: 60,
      retentionDays: 365,
    });
    expect(updated.ok).toBe(true);
  }

  // Accepts each source and persists its proposal, leaving runs in review.
  async function prepare(
    proposals: ExtractionProposal[],
  ): Promise<SourceEnvelope[]> {
    const mira = await context(
      fixture.authorization,
      "user-mira",
      "tidepath",
      "source",
    );
    const sources = createSourceRepository({
      authorization: fixture.authorization,
      store: createSourceStore(fixture.db),
    });
    const envelopes = proposals.map((p) => sourceFor(p.sourceId));
    for (const envelope of envelopes)
      expect((await sources.accept(mira, envelope)).ok).toBe(true);
    const repo = createProcessingRepository(fixture.db);
    const leases = await repo.pendingSources(10);
    for (const proposal of proposals) {
      const lease = leases.find((l) => l.source.sourceId === proposal.sourceId);
      if (!lease) throw new Error(`missing lease ${proposal.sourceId}`);
      const persisted = await repo.persistProposal(
        systemContext("tidepath"),
        lease.source,
        proposal,
        lease.leaseToken,
      );
      expect(persisted.ok).toBe(true);
    }
    return envelopes;
  }

  // Holds one organization's ledger lock in an open transaction, optionally
  // writing inside it, until released.
  async function holdLedger(
    organizationId: string,
    during?: (
      tx: Parameters<typeof lockOrganizationLedger>[0],
    ) => Promise<void>,
  ) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired = () => {};
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const done = fixture.db.transaction(async (tx) => {
      await lockOrganizationLedger(tx, organizationId);
      if (during) await during(tx);
      acquired();
      await gate;
    });
    await Promise.race([ready, done]);
    return async () => {
      release();
      await done;
    };
  }

  async function waitForAdvisoryWaiters(count: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const rows = await fixture.db.execute(
        sql`select count(*)::int as count from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())`,
      );
      if ((rows.rows[0]?.count as number) >= count) return;
      if (Date.now() > deadline)
        throw new Error(`expected ${count} advisory waiters`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function within<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("blocked")), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function runStatuses(): Promise<Record<string, string>> {
    const rows = await fixture.db.execute(
      sql`select source_id,status from extraction_run where organization_id='tidepath' order by source_id`,
    );
    return Object.fromEntries(
      rows.rows.map((r) => [r.source_id as string, r.status as string]),
    );
  }

  it("makes automatic acceptance wait for an in-flight same-organization writer and see its activity", async () => {
    await enableAutomaticPolicy();
    const [s1] = await prepare([proposalFor("s1")]);
    if (!s1) throw new Error("missing source");
    const release = await holdLedger("tidepath", async (tx) => {
      await tx.execute(
        sql`insert into activity (organization_id,id,revision,kind,local_date,date_precision,beneficiary_reference,origin_kind,origin_reason) values ('tidepath','held-visit',1,'visit',${DAY},'day',null,'staff','Concurrent staff visit')`,
      );
    });
    const auto = track(
      createProcessingRepository(fixture.db).applyValidatedPolicy(s1),
    );
    try {
      await waitForAdvisoryWaiters(1);
      expect(auto.settled()).toBe(false);
    } finally {
      await release();
    }
    expect(await within(auto.promise)).toEqual({
      ok: true,
      value: { applied: false },
    });
    expect(await runStatuses()).toEqual({ s1: "review" });
    const approved = await fixture.db.execute(
      sql`select count(*)::int as count from contribution where organization_id='tidepath' and status='approved'`,
    );
    expect(approved.rows[0]?.count).toBe(0);
  });

  it("lets only one of two concurrent automatic acceptances record the same day", async () => {
    await enableAutomaticPolicy();
    const [s1, s2] = await prepare([proposalFor("s1"), proposalFor("s2")]);
    if (!s1 || !s2) throw new Error("missing sources");
    const repo = createProcessingRepository(fixture.db);
    const release = await holdLedger("tidepath");
    const first = track(repo.applyValidatedPolicy(s1));
    const second = track(repo.applyValidatedPolicy(s2));
    try {
      await waitForAdvisoryWaiters(2);
      expect(first.settled() || second.settled()).toBe(false);
    } finally {
      await release();
    }
    const results = await within(Promise.all([first.promise, second.promise]));
    const applied = results.map((r) => r.ok && r.value.applied);
    expect(applied.filter(Boolean)).toHaveLength(1);
    expect(Object.values(await runStatuses()).sort()).toEqual([
      "accepted",
      "review",
    ]);
    const activities = await fixture.db.execute(
      sql`select count(*)::int as count from activity where organization_id='tidepath' and local_date=${DAY}`,
    );
    expect(activities.rows[0]?.count).toBe(1);
  });

  it("makes human ledger, need, review and provisional-need writers take the same lock", async () => {
    const [review] = await prepare([proposalFor("s1")]);
    if (!review) throw new Error("missing source");
    const kai = await context(
      fixture.authorization,
      "user-kai",
      "tidepath",
      "staff",
    );
    const mira = await context(
      fixture.authorization,
      "user-mira",
      "tidepath",
      "source",
    );
    const sources = createSourceRepository({
      authorization: fixture.authorization,
      store: createSourceStore(fixture.db),
    });
    const urgent = sourceFor("s2");
    expect((await sources.accept(mira, urgent)).ok).toBe(true);
    const repo = createProcessingRepository(fixture.db);
    const [lease] = await repo.pendingSources(10);
    if (lease?.source.sourceId !== "s2") throw new Error("missing lease s2");

    const release = await holdLedger("tidepath");
    const writers = [
      track(
        fixture.ledger.recordActivity(kai, {
          schemaVersion: 1,
          idempotencyKey: "staff-visit",
          kind: "visit",
          localDate: DAY,
          datePrecision: "day",
          beneficiaryReference: null,
          origin: { kind: "staff", reason: "Staff visit" },
          contributions: [],
        }),
      ),
      track(
        fixture.needs.create(kai, {
          schemaVersion: 1,
          idempotencyKey: "staff-need",
          category: "food",
          urgency: "routine",
          summary: "Pantry restock",
          provisional: false,
          dueAt: null,
          acknowledgeBy: null,
          origin: { kind: "staff", reason: "Staff need" },
        }),
      ),
      track(
        repo.decide(kai, {
          runId: "run-s1",
          expectedRevision: 1,
          idempotencyKey: "human-accept",
          decision: "accept",
          reason: "confirmed",
        }),
      ),
      track(
        repo.persistProposal(
          systemContext("tidepath"),
          lease.source,
          proposalFor("s2", { urgentNeed: true }),
          lease.leaseToken,
        ),
      ),
    ];
    try {
      await waitForAdvisoryWaiters(writers.length);
      expect(writers.map((w) => w.settled())).toEqual([
        false,
        false,
        false,
        false,
      ]);
    } finally {
      await release();
    }
    const results = await within(Promise.all(writers.map((w) => w.promise)));
    for (const result of results) expect(result.ok).toBe(true);
  });

  it("does not block another organization's writers", async () => {
    await enableAutomaticPolicy();
    const [s1] = await prepare([proposalFor("s1")]);
    if (!s1) throw new Error("missing source");
    const holdHarbor = await holdLedger("harbor");
    try {
      expect(
        await within(
          createProcessingRepository(fixture.db).applyValidatedPolicy(s1),
          5_000,
        ),
      ).toEqual({ ok: true, value: { applied: true } });
    } finally {
      await holdHarbor();
    }
    const ive = await context(
      fixture.authorization,
      "user-ive",
      "harbor",
      "staff",
    );
    const holdTidepath = await holdLedger("tidepath");
    try {
      const recorded = await within(
        fixture.ledger.recordActivity(ive, {
          schemaVersion: 1,
          idempotencyKey: "harbor-visit",
          kind: "visit",
          localDate: DAY,
          datePrecision: "day",
          beneficiaryReference: null,
          origin: { kind: "staff", reason: "Harbor visit" },
          contributions: [],
        }),
        5_000,
      );
      expect(recorded.ok).toBe(true);
    } finally {
      await holdTidepath();
    }
  });
});
