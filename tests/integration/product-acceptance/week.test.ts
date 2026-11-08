import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  createDeterministicProvider,
  createExtractionService,
} from "../../../packages/ai/src/index.ts";
import type {
  ReviewDecision,
  SourceEnvelope,
} from "../../../packages/contracts/src/index.ts";
import {
  createFollowThroughRepository,
  createProcessingRepository,
  createSourceStore,
  sql,
} from "../../../packages/db/src/index.ts";
import { createSourceRepository } from "../../../packages/domain/core/src/sources/index.ts";
import {
  context,
  openDomainFixture,
  systemContext,
} from "../domain/domain-support.ts";

it.each(["review-all", "validated-auto-record"] as const)(
  "reviews the complete fictional week under %s",
  async (policy) => {
    const fixture = await openDomainFixture();
    try {
      const sources = JSON.parse(
        await readFile("fixtures/sources.json", "utf8"),
      ) as SourceEnvelope[];
      const oracle = JSON.parse(
        await readFile("fixtures/expected-results.json", "utf8"),
      ) as {
        cases: { sourceId: string }[];
        finalApproved: Record<
          string,
          {
            activities: number;
            contributions: number;
            volunteerMinutes: number;
          }
        >;
      };
      // The checked-in week currently contains 28 sources, not 30.
      expect(sources).toHaveLength(28);
      expect(oracle.cases.map((entry) => entry.sourceId)).toEqual(
        sources.map((entry) => entry.sourceId),
      );
      const repo = createProcessingRepository(fixture.db);
      const intake = createSourceRepository({
        authorization: fixture.authorization,
        store: createSourceStore(fixture.db),
      });
      const settings = createFollowThroughRepository(fixture.db);
      // The seed provides no Harbor owner; promote the synthetic coordinator in this private database.
      await fixture.db.execute(
        sql`update member set role='owner' where id='harbor-ive'`,
      );
      const tide = await context(
        fixture.authorization,
        "user-rae",
        "tidepath",
        "week-tide",
      );
      const harbor = await context(
        fixture.authorization,
        "user-ive",
        "harbor",
        "week-harbor",
      );
      for (const owner of [tide, harbor]) {
        expect(
          (
            await settings.updateSettings(owner, {
              expectedRevision: 1,
              idempotencyKey: `week-${policy}`,
              timezone: "America/New_York",
              automationPolicy: policy,
              policyVersion: "week-1",
              routing: {},
              fallbackMembershipId: null,
              ackMinutes: 60,
              retentionDays: 365,
            })
          ).ok,
        ).toBe(true);
      }
      const extractor = createExtractionService({
        provider: createDeterministicProvider(),
      });
      let automatic = 0;
      for (const source of sources) {
        const actor = source.organizationId === "tidepath" ? tide : harbor;
        const accepted = await intake.accept(actor, source);
        expect(accepted.ok, source.sourceId).toBe(true);
        expect(await intake.accept(actor, source)).toEqual(accepted);
        const [lease] = await repo.pendingSources(1);
        if (!lease || lease.source.sourceId !== source.sourceId)
          throw new Error(`Missing lease ${source.sourceId}`);
        const proposal = await extractor.extract(
          systemContext(source.organizationId),
          lease.source,
          {
            model: "fixture",
            prompt: "fixture",
            policy: lease.policy.policyVersion,
          },
        );
        if (!proposal.ok)
          throw new Error(`Extraction failed ${source.sourceId}`);
        expect(
          (
            await repo.persistProposal(
              systemContext(source.organizationId),
              lease.source,
              proposal.value,
              lease.leaseToken,
            )
          ).ok,
        ).toBe(true);
        const automaticResult = await repo.applyValidatedPolicy(source);
        expect(automaticResult.ok).toBe(true);
        if (!automaticResult.ok) throw new Error("Policy failed");
        if (automaticResult.value.applied) {
          automatic++;
          expect(await repo.applyValidatedPolicy(source)).toEqual(
            automaticResult,
          );
          continue;
        }
        const decision: ReviewDecision = {
          runId: proposal.value.runId,
          expectedRevision: 1,
          idempotencyKey: `week-review-${source.sourceId}`,
          decision: [
            "source-08",
            "source-26",
            "source-27",
            "source-28",
          ].includes(source.sourceId)
            ? "reject"
            : "accept",
          reason: "Staff verified source",
        };
        if (
          source.sourceId === "source-02" ||
          source.sourceId === "source-03"
        ) {
          const activity = proposal.value.items.find(
            (item) => item.kind === "activity",
          );
          const row = (
            await fixture.db.execute(
              sql`select id,revision from activity where organization_id='tidepath' and beneficiary_reference='T-01'`,
            )
          ).rows[0];
          if (!activity || !row) throw new Error("Missing visit");
          decision.activityLinks = {
            [activity.key]: {
              activityId: row.id as string,
              expectedRevision: row.revision as number,
            },
          };
        }
        if (source.sourceId === "source-04") {
          const row = (
            await fixture.db.execute(
              sql`select id,revision from contribution where organization_id='tidepath' and membership_id='tidepath-mira'`,
            )
          ).rows[0];
          const correction = proposal.value.items[0];
          if (!row || correction?.kind !== "correction")
            throw new Error("Missing correction");
          decision.replacementItems = [
            {
              ...correction,
              targetId: row.id as string,
              expectedRevision: row.revision as number,
            },
          ];
        }
        if (
          source.sourceId === "source-08" ||
          Number(source.sourceId.slice(-2)) >= 26
        ) {
          expect(proposal.value.items).toEqual([]);
          expect(proposal.value.unresolved.length).toBeGreaterThan(0);
        }
        const reviewed = await repo.decide(actor, decision);
        expect(reviewed.ok, source.sourceId).toBe(true);
        expect(await repo.decide(actor, decision)).toEqual(reviewed);
      }
      if (policy === "review-all") expect(automatic).toBe(0);
      else expect(automatic).toBeGreaterThan(0);
      for (const organizationId of ["tidepath", "harbor"]) {
        const row = (
          await fixture.db.execute(
            sql`select count(*)::int as contributions,coalesce(sum(duration_minutes),0)::int as minutes,count(distinct activity_id)::int as activities from contribution where organization_id=${organizationId} and status='approved'`,
          )
        ).rows[0];
        const expected = oracle.finalApproved[organizationId];
        expect(row).toEqual({
          contributions: expected?.contributions,
          minutes: expected?.volunteerMinutes,
          activities: expected?.activities,
        });
      }
      expect(await repo.getSource(harbor, "source-01")).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
      expect(await repo.getSource(tide, "source-09")).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
      const pending = await fixture.db.execute(
        sql`select membership_id,duration_minutes,status from contribution where organization_id='tidepath' and status='pending'`,
      );
      expect(pending.rows).toEqual([
        {
          membership_id: "tidepath-luz",
          duration_minutes: null,
          status: "pending",
        },
      ]);
      const needs = await fixture.db.execute(
        sql`select category,urgency,provisional from need where organization_id='tidepath' order by category`,
      );
      expect(needs.rows).toEqual([
        { category: "food", urgency: "urgent", provisional: true },
        { category: "supplies", urgency: "routine", provisional: false },
      ]);
    } finally {
      await fixture.close();
    }
  },
);
