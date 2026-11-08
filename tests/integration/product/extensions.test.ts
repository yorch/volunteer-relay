import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createProductExtensions } from "../../../apps/web/lib/product/extensions.ts";
import {
  type ProductReport,
  reportDashboardSchema,
  reportWeekRange,
  type TenantContext,
} from "../../../packages/contracts/src/index.ts";
import {
  type DomainFixture,
  HARBOR,
  openDomainFixture,
  context as resolveContext,
  staffOrigin,
  TIDEPATH,
} from "../domain/domain-support.ts";

type Role = "owner" | "coordinator" | "volunteer" | "report-reader";
const grants: Record<Role, string[]> = {
  owner: ["source:submit", "review:write", "need:manage", "report:read"],
  coordinator: ["source:submit", "review:write", "need:manage", "report:read"],
  volunteer: ["source:submit"],
  "report-reader": ["report:read"],
};
const contextFor = (role: Role): TenantContext => ({
  organizationId: "org",
  actor: { kind: "user", userId: "u", membershipId: "m", role },
  correlationId: "c",
});
const context = contextFor("coordinator");

function fixture(role: Role = "coordinator") {
  const execute = vi
    .fn()
    .mockResolvedValueOnce({
      rows: [
        {
          minutes: 120,
          approved: 2,
          visits: 1,
          pending: 1,
          unknown: 1,
          unresolved: 0,
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: [{ open: 2, resolved: 1, ack: null, unassigned: 1 }],
    })
    .mockResolvedValueOnce({ rows: [{ count: 0 }] })
    // Current week.
    .mockResolvedValueOnce({ rows: [{ minutes: 30 }] })
    // Staff only: contributors, then the oldest queued review.
    .mockResolvedValueOnce({
      rows: [{ membership_id: "member-a", minutes: 120, approved: 2 }],
    })
    .mockResolvedValueOnce({
      rows: [{ oldest: new Date("2026-11-07T09:00:00Z") }],
    })
    // Staff only: the volunteer roster.
    .mockResolvedValueOnce({
      rows: [
        {
          membership_id: "member-a",
          minutes: 120,
          approved: 2,
          pending: 0,
          unknown: 0,
          week_minutes: 30,
        },
        {
          membership_id: "member-b",
          minutes: 0,
          approved: 0,
          pending: 1,
          unknown: 1,
          week_minutes: 0,
        },
      ],
    })
    .mockResolvedValue({ rows: [] });
  const options = {
    db: { execute },
    authorization: {
      require: async (_: TenantContext, permission: string) =>
        grants[role].includes(permission)
          ? { ok: true, value: undefined }
          : {
              ok: false,
              error: {
                code: "FORBIDDEN",
                message: "Forbidden",
                correlationId: "c",
                retryable: false,
              },
            },
    },
    sources: {},
    processing: {},
    attachments: {},
    root: "/tmp/unused",
    maxBytes: 10485760,
  };
  return {
    execute,
    context: contextFor(role),
    handler: createProductExtensions(
      options as unknown as Parameters<typeof createProductExtensions>[0],
    ),
  };
}
afterEach(() => {
  vi.useRealTimers();
});
describe("aggregate report boundary", () => {
  it("exports the same approved aggregate projection and neutralizes spreadsheet formulas", async () => {
    const { handler } = fixture();
    const req = new Request(
      "http://localhost/api/product/reports.csv?program=%3DHYPERLINK(%22evil%22)",
    );
    const result = await handler(context, "reports.csv", req);
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) throw new Error("Expected CSV");
    expect(await result.text()).toContain('"\'=HYPERLINK(""evil"")"');
    expect(result.headers.get("cache-control")).toBe("no-store");
  });
  it("preserves unknown acknowledgment rather than displaying a made-up zero", async () => {
    const { handler } = fixture();
    expect(
      await handler(
        context,
        "reports",
        new Request("http://localhost/api/product/reports"),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        approvedHours: 2,
        ledger: {
          approvedMinutes: 120,
          activitiesWithApprovedContributions: 1,
          pendingUnknownDuration: 1,
        },
        averageAcknowledgmentMinutes: null,
      },
    });
  });
  it("rejects invalid date filters and tenant injection before data lookup", async () => {
    const { handler, execute } = fixture();
    expect(
      await handler(
        context,
        "reports",
        new Request(
          "http://localhost/api/product/reports?from=2026-11-08&to=2026-11-01",
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(
      await handler(
        context,
        "reports",
        new Request(
          "http://localhost/api/product/reports?organizationId=foreign",
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(execute).not.toHaveBeenCalled();
  });
  it("gives staff the dashboard fields for the current local week", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
    const { handler, context } = fixture("coordinator");
    const result = await handler(
      context,
      "reports",
      new Request("http://localhost/api/product/reports"),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        weekRange: { from: "2026-11-09", to: "2026-11-15" },
        weekApprovedMinutes: 30,
        weekHours: 0.5,
        unassignedOpenNeeds: 1,
        topContributors: [
          {
            membershipId: "member-a",
            approvedMinutes: 120,
            approvedContributions: 2,
          },
        ],
        oldestQueuedReviewAt: "2026-11-07T09:00:00.000Z",
        volunteers: [
          {
            membershipId: "member-a",
            approvedMinutes: 120,
            weekApprovedMinutes: 30,
            approvedContributions: 2,
            pendingContributions: 0,
            pendingUnknownDuration: 0,
          },
          {
            membershipId: "member-b",
            approvedMinutes: 0,
            weekApprovedMinutes: 0,
            approvedContributions: 0,
            pendingContributions: 1,
            pendingUnknownDuration: 1,
          },
        ],
        volunteersTruncated: false,
      },
    });
  });
  it("scopes the staff roster query to the server-resolved organization with bound parameters", async () => {
    const { handler, context, execute } = fixture("coordinator");
    await handler(
      context,
      "reports",
      new Request(
        "http://localhost/api/product/reports?from=2026-11-01&program=Garden",
      ),
    );
    expect(execute).toHaveBeenCalledTimes(7);
    const roster = JSON.stringify(execute.mock.calls[6]?.[0]);
    expect(roster).toContain("group by c.membership_id");
    expect(roster).toContain('"org"');
    expect(roster).toContain('"2026-11-01"');
    expect(roster).toContain('"Garden"');
    // Values are bound, never spliced into the SQL text.
    expect(roster).not.toMatch(/a\.kind='Garden'/);
  });
  it("gives a report reader aggregates only: no per-member or queue fields", async () => {
    const { handler, context, execute } = fixture("report-reader");
    const result = await handler(
      context,
      "reports",
      new Request("http://localhost/api/product/reports"),
    );
    if (result instanceof Response || !result?.ok)
      throw new Error("Expected a report");
    expect(result.value).not.toHaveProperty("topContributors");
    expect(result.value).not.toHaveProperty("oldestQueuedReviewAt");
    expect(result.value).not.toHaveProperty("volunteers");
    expect(result.value).not.toHaveProperty("volunteersTruncated");
    expect(result.value).toMatchObject({ unassignedOpenNeeds: 1 });
    // Totals, needs, unknown dates and the week; no staff-only lookups.
    expect(execute).toHaveBeenCalledTimes(4);
  });
  it("serves a report reader the CSV with a header row", async () => {
    const { handler, context } = fixture("report-reader");
    const result = await handler(
      context,
      "reports.csv",
      new Request("http://localhost/api/product/reports.csv"),
    );
    if (!(result instanceof Response)) throw new Error("Expected CSV");
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const [header] = (await result.text()).split("\r\n");
    expect(header?.startsWith('"timezone","from","to"')).toBe(true);
    expect(header).not.toMatch(/topContributors|oldestQueued|source/);
  });
  it.each(["reports", "reports.csv"])(
    "denies a volunteer %s before any lookup",
    async (path) => {
      const { handler, context, execute } = fixture("volunteer");
      expect(
        await handler(
          context,
          path,
          new Request(`http://localhost/api/product/${path}`),
        ),
      ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it("rejects a malformed CSV query", async () => {
    const { handler, context } = fixture("report-reader");
    expect(
      await handler(
        context,
        "reports.csv",
        new Request("http://localhost/api/product/reports.csv?from=not-a-date"),
      ),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });
});

// DB-backed: requires TEST_DATABASE_URL naming a disposable *_test database.
// All people, programs and minutes are synthetic; expected rows below are
// authored by hand from the recorded fixture, not copied from output.
describe("volunteer hours roster against PostgreSQL", () => {
  let db: DomainFixture;
  let handler: ReturnType<typeof createProductExtensions>;
  const actors: Record<string, TenantContext> = {};
  // The report week is the current UTC week; "old" is well before it.
  const week = reportWeekRange("UTC", new Date());
  if (!week) throw new Error("UTC always has a week");
  const weekDate = week.from;
  const oldDate = new Date(
    Date.parse(`${week.from}T00:00:00Z`) - 70 * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);

  async function record(
    actor: TenantContext,
    key: string,
    kind: string,
    localDate: string | null,
    contributions: Array<{
      membershipId: string;
      durationMinutes: number | null;
      approve: boolean;
    }>,
  ) {
    const recorded = await db.ledger.recordActivity(actor, {
      schemaVersion: 1,
      idempotencyKey: key,
      kind,
      localDate,
      datePrecision: localDate ? "day" : "unknown",
      beneficiaryReference: null,
      origin: staffOrigin,
      contributions: contributions.map(({ membershipId, durationMinutes }) => ({
        membershipId,
        durationMinutes,
      })),
    });
    if (!recorded.ok) throw new Error(`record ${key}: ${recorded.error.code}`);
    for (const [index, draft] of recorded.value.contributions.entries()) {
      if (!contributions[index]?.approve) continue;
      const approved = await db.ledger.transitionContribution(actor, {
        schemaVersion: 1,
        idempotencyKey: `${key}-approve-${index}`,
        contributionId: draft.contributionId,
        expectedRevision: 1,
        action: "approve",
      });
      if (!approved.ok)
        throw new Error(`approve ${key}: ${approved.error.code}`);
    }
  }

  beforeAll(async () => {
    db = await openDomainFixture();
    const ctx = (user: string, org: string) =>
      resolveContext(db.authorization, user, org, `roster-${user}-${org}`);
    actors.kai = await ctx("user-kai", TIDEPATH);
    actors.ren = await ctx("user-ren", TIDEPATH);
    actors.mira = await ctx("user-mira", TIDEPATH);
    actors.ive = await ctx("user-ive", HARBOR);
    handler = createProductExtensions({
      db: db.db,
      authorization: db.authorization,
    } as unknown as Parameters<typeof createProductExtensions>[0]);
    const kai = actors.kai;
    await record(kai, "roster-old-kitchen", "Kitchen shift", oldDate, [
      { membershipId: "tidepath-mira", durationMinutes: 60, approve: true },
      { membershipId: "tidepath-sol", durationMinutes: 45, approve: true },
    ]);
    await record(kai, "roster-week-garden", "Garden", weekDate, [
      { membershipId: "tidepath-mira", durationMinutes: 30, approve: true },
      // Unknown duration stays pending and is never zero minutes.
      { membershipId: "tidepath-luz", durationMinutes: null, approve: false },
    ]);
    await record(kai, "roster-week-kitchen", "Kitchen shift", weekDate, [
      // A known but unapproved duration is still not approved time.
      { membershipId: "tidepath-sol", durationMinutes: 20, approve: false },
    ]);
    await record(kai, "roster-undated", "Kitchen shift", null, [
      { membershipId: "tidepath-luz", durationMinutes: 15, approve: true },
    ]);
    await record(actors.ive, "roster-harbor", "Kitchen shift", weekDate, [
      { membershipId: "harbor-nico", durationMinutes: 90, approve: true },
    ]);
  }, 60000);

  afterAll(async () => {
    await db?.close();
  });

  async function report(actor: string, search = "") {
    const selected = actors[actor];
    if (!selected) throw new Error(`unknown actor ${actor}`);
    return handler(
      selected,
      "reports",
      new Request(`http://localhost/api/product/reports${search}`),
    );
  }
  async function staffReport(actor: string, search = "") {
    const result = await report(actor, search);
    if (result instanceof Response || !result?.ok)
      throw new Error("Expected a report");
    const value = result.value as ProductReport;
    // The response stays inside the published dashboard contract.
    expect(
      reportDashboardSchema.safeParse({
        volunteers: value.volunteers,
        volunteersTruncated: value.volunteersTruncated,
      }).success,
    ).toBe(true);
    // The roster partitions the same approved ledger as the totals.
    expect(
      (value.volunteers ?? []).reduce((sum, v) => sum + v.approvedMinutes, 0),
    ).toBe(value.ledger.approvedMinutes);
    return value;
  }
  const row = (
    membershipId: string,
    approvedMinutes: number,
    weekApprovedMinutes: number,
    approvedContributions: number,
    pendingContributions = 0,
    pendingUnknownDuration = 0,
  ) => ({
    membershipId,
    approvedMinutes,
    weekApprovedMinutes,
    approvedContributions,
    pendingContributions,
    pendingUnknownDuration,
  });

  it("lists every Tidepath member with contributions for a coordinator, Harbor never included", async () => {
    const value = await staffReport("kai");
    expect(value.volunteers).toEqual([
      row("tidepath-mira", 90, 30, 2),
      row("tidepath-sol", 45, 0, 1, 1, 0),
      row("tidepath-luz", 15, 0, 1, 1, 1),
    ]);
    expect(value.volunteersTruncated).toBe(false);
    expect(JSON.stringify(value)).not.toContain("harbor");
  });
  it("gives the Harbor coordinator only Harbor members", async () => {
    const value = await staffReport("ive");
    expect(value.volunteers).toEqual([row("harbor-nico", 90, 90, 1)]);
    expect(JSON.stringify(value)).not.toContain("tidepath");
  });
  it("honors the program filter", async () => {
    const value = await staffReport("kai", "?program=Garden");
    expect(value.volunteers).toEqual([
      row("tidepath-mira", 30, 30, 1),
      row("tidepath-luz", 0, 0, 0, 1, 1),
    ]);
  });
  it("honors from/to like approvedMinutes while the week figure ignores them", async () => {
    expect((await staffReport("kai", `?from=${weekDate}`)).volunteers).toEqual([
      row("tidepath-mira", 30, 30, 1),
      row("tidepath-luz", 0, 0, 0, 1, 1),
      row("tidepath-sol", 0, 0, 0, 1, 0),
    ]);
    // Through the old date: this week's approved time still shows.
    expect((await staffReport("kai", `?to=${oldDate}`)).volunteers).toEqual([
      row("tidepath-mira", 60, 30, 1),
      row("tidepath-sol", 45, 0, 1),
    ]);
  });
  it("honors the volunteer filter", async () => {
    expect(
      (await staffReport("kai", "?membershipId=tidepath-sol")).volunteers,
    ).toEqual([row("tidepath-sol", 45, 0, 1, 1, 0)]);
    expect(
      (await staffReport("kai", "?membershipId=harbor-nico")).volunteers,
    ).toEqual([]);
  });
  it("omits the roster for a report reader and denies a volunteer", async () => {
    const reader = await report("ren");
    if (reader instanceof Response || !reader?.ok)
      throw new Error("Expected a report");
    expect(reader.value).not.toHaveProperty("volunteers");
    expect(reader.value).not.toHaveProperty("volunteersTruncated");
    expect(await report("mira")).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });
});
