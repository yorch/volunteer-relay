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
  REPORT_DETAIL_WEEKS,
  reportDashboardSchema,
  reportWeekRange,
  type TenantContext,
} from "../../../packages/contracts/src/index.ts";
import { sql } from "../../../packages/db/src/index.ts";
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
  it("serves a byte-identical aggregate CSV whether or not view=summary is given", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
    const csv = async (search: string) => {
      const { handler, context } = fixture("coordinator");
      const result = await handler(
        context,
        "reports.csv",
        new Request(`http://localhost/api/product/reports.csv${search}`),
      );
      if (!(result instanceof Response)) throw new Error("Expected CSV");
      return result.text();
    };
    const plain = await csv("?program=Garden");
    expect(await csv("?program=Garden&view=summary")).toBe(plain);
    expect(plain.split("\r\n").filter(Boolean)).toHaveLength(2);
    expect(plain).not.toMatch(/view|member-a|volunteerName/);
  });
  it("does not echo the CSV view in the JSON report query", async () => {
    const { handler, context } = fixture("coordinator");
    const result = await handler(
      context,
      "reports",
      new Request("http://localhost/api/product/reports?view=volunteers"),
    );
    if (result instanceof Response || !result?.ok)
      throw new Error("Expected a report");
    expect((result.value as ProductReport).query).toEqual({});
  });
  it.each(["report-reader", "volunteer"] as const)(
    "denies the per-volunteer CSV to a %s before any lookup",
    async (role) => {
      const { handler, context, execute } = fixture(role);
      expect(
        await handler(
          context,
          "reports.csv",
          new Request(
            "http://localhost/api/product/reports.csv?view=volunteers",
          ),
        ),
      ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it("rejects an unknown report view", async () => {
    const { handler, context, execute } = fixture("coordinator");
    expect(
      await handler(
        context,
        "reports.csv",
        new Request("http://localhost/api/product/reports.csv?view=sources"),
      ),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(execute).not.toHaveBeenCalled();
  });
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

  const zeroWeeks = (lastMinutes: number) =>
    Array.from({ length: REPORT_DETAIL_WEEKS }, (_, i) =>
      i === REPORT_DETAIL_WEEKS - 1 ? lastMinutes : 0,
    );
  async function detail(actor: string, search: string) {
    const value = await staffReport(actor, search);
    expect(
      reportDashboardSchema.safeParse({
        volunteerDetail: value.volunteerDetail,
      }).success,
    ).toBe(true);
    const found = value.volunteerDetail;
    if (!found) throw new Error("Expected a volunteer detail");
    expect(found.weeks?.at(-1)?.weekStart).toBe(weekDate);
    if (!found.byActivityTruncated)
      expect(
        found.byActivity.reduce((sum, a) => sum + a.approvedMinutes, 0),
        "byActivity partitions the volunteer's approved total",
      ).toBe(value.ledger.approvedMinutes);
    return { value, found };
  }
  it("adds the volunteer detail only for a volunteer filter", async () => {
    expect(await staffReport("kai")).not.toHaveProperty("volunteerDetail");
    const { found } = await detail("kai", "?membershipId=tidepath-mira");
    // The old shift is ten weeks back, outside the eight-week window.
    expect(found.weeks?.map((w) => w.approvedMinutes)).toEqual(zeroWeeks(30));
    expect(found.unknownDateContributions).toBe(0);
    expect(found.byActivity).toEqual([
      {
        activityId: expect.any(String),
        kind: "Kitchen shift",
        localDate: oldDate,
        approvedMinutes: 60,
        approvedContributions: 1,
      },
      {
        activityId: expect.any(String),
        kind: "Garden",
        localDate: weekDate,
        approvedMinutes: 30,
        approvedContributions: 1,
      },
    ]);
    expect(found.byActivityTruncated).toBe(false);
  });
  it("counts unknown-date approved time apart from every week", async () => {
    const { found } = await detail("kai", "?membershipId=tidepath-luz");
    expect(found.weeks?.map((w) => w.approvedMinutes)).toEqual(zeroWeeks(0));
    expect(found.unknownDateContributions).toBe(1);
    expect(found.byActivity).toEqual([
      {
        activityId: expect.any(String),
        kind: "Kitchen shift",
        localDate: null,
        approvedMinutes: 15,
        approvedContributions: 1,
      },
    ]);
    // A dated filter drops the unknown-date activity but not the count.
    const dated = await detail(
      "kai",
      `?membershipId=tidepath-luz&from=${oldDate}`,
    );
    expect(dated.found.byActivity).toEqual([]);
    expect(dated.found.unknownDateContributions).toBe(1);
  });
  it("keeps the program filter in both the weeks and byActivity", async () => {
    const { found } = await detail(
      "kai",
      "?membershipId=tidepath-mira&program=Garden",
    );
    expect(found.weeks?.map((w) => w.approvedMinutes)).toEqual(zeroWeeks(30));
    expect(found.byActivity.map((a) => a.kind)).toEqual(["Garden"]);
  });
  it("never reveals another organization's volunteer detail", async () => {
    const { found } = await detail("kai", "?membershipId=harbor-nico");
    expect(found.weeks?.map((w) => w.approvedMinutes)).toEqual(zeroWeeks(0));
    expect(found.byActivity).toEqual([]);
    expect(found.unknownDateContributions).toBe(0);
    const harbor = await detail("ive", "?membershipId=tidepath-mira");
    expect(harbor.found.byActivity).toEqual([]);
    expect(JSON.stringify(harbor.value)).not.toMatch(/Kitchen|Garden/);
  });
  it("omits the volunteer detail for a report reader", async () => {
    const reader = await report("ren", "?membershipId=tidepath-mira");
    if (reader instanceof Response || !reader?.ok)
      throw new Error("Expected a report");
    expect(reader.value).not.toHaveProperty("volunteerDetail");
  });

  async function csv(actor: string, search: string) {
    const selected = actors[actor];
    if (!selected) throw new Error(`unknown actor ${actor}`);
    return handler(
      selected,
      "reports.csv",
      new Request(`http://localhost/api/product/reports.csv${search}`),
    );
  }
  const csvHeader =
    '"membershipId","volunteerName","approvedMinutes","approvedHours","weekApprovedMinutes","approvedContributions","pendingContributions","pendingUnknownDuration"';
  it("exports one CSV row per volunteer, with names, for staff", async () => {
    const result = await csv("kai", "?view=volunteers");
    if (!(result instanceof Response)) throw new Error("Expected CSV");
    expect(result.headers.get("content-disposition")).toBe(
      "attachment; filename=volunteer-hours.csv",
    );
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("x-report-truncated")).toBe("false");
    expect(await result.text()).toBe(
      [
        csvHeader,
        '"tidepath-mira","Mira","90","1.5","30","2","0","0"',
        '"tidepath-sol","Sol","45","0.75","0","1","1","0"',
        '"tidepath-luz","Luz","15","0.25","0","1","1","1"',
        "",
      ].join("\r\n"),
    );
    const harbor = await csv("ive", "?view=volunteers");
    if (!(harbor instanceof Response)) throw new Error("Expected CSV");
    expect(await harbor.text()).toBe(
      [csvHeader, '"harbor-nico","Nico","90","1.5","90","1","0","0"', ""].join(
        "\r\n",
      ),
    );
  });
  it("applies the roster filters to the volunteer CSV", async () => {
    const result = await csv("kai", "?view=volunteers&program=Garden");
    if (!(result instanceof Response)) throw new Error("Expected CSV");
    expect((await result.text()).split("\r\n")).toEqual([
      csvHeader,
      '"tidepath-mira","Mira","30","0.5","30","1","0","0"',
      '"tidepath-luz","Luz","0","0","0","0","1","1"',
      "",
    ]);
  });
  it("neutralizes a spreadsheet formula in a volunteer's display name", async () => {
    await db.db.execute(
      sql`update "user" set name=${'=HYPERLINK("x")'} where id='user-sol'`,
    );
    try {
      const result = await csv(
        "kai",
        "?view=volunteers&membershipId=tidepath-sol",
      );
      if (!(result instanceof Response)) throw new Error("Expected CSV");
      expect((await result.text()).split("\r\n")[1]).toBe(
        '"tidepath-sol","\'=HYPERLINK(""x"")","45","0.75","0","1","1","0"',
      );
    } finally {
      await db.db.execute(
        sql`update "user" set name='Sol' where id='user-sol'`,
      );
    }
  });
  it("keeps the default CSV byte-identical and free of per-member rows", async () => {
    const plain = await csv("kai", "");
    const summary = await csv("kai", "?view=summary");
    if (!(plain instanceof Response) || !(summary instanceof Response))
      throw new Error("Expected CSV");
    const text = await plain.text();
    expect(await summary.text()).toBe(text);
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(2);
    expect(text).not.toMatch(/tidepath-|Mira|volunteerName/);
  });
  it("denies the volunteer CSV to a report reader and a volunteer", async () => {
    expect(await csv("ren", "?view=volunteers")).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await csv("mira", "?view=volunteers")).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });
});

// The organization week follows its own timezone: America/Los_Angeles is
// UTC-8 in November, so 2026-11-09T07:30Z is still Sunday 2026-11-08 there
// and 08:30Z is already Monday 2026-11-09. Expected weeks are hand-authored.
describe("volunteer detail weeks in a non-UTC organization timezone", () => {
  let db: DomainFixture;
  let kai: TenantContext;
  const handlerAt = (instant: string) =>
    createProductExtensions({
      db: db.db,
      authorization: db.authorization,
      timezone: async () => "America/Los_Angeles",
      now: () => new Date(instant),
    } as unknown as Parameters<typeof createProductExtensions>[0]);
  const sundayNight = "2026-11-09T07:30:00Z";
  const mondayMorning = "2026-11-09T08:30:00Z";

  beforeAll(async () => {
    db = await openDomainFixture();
    kai = await resolveContext(
      db.authorization,
      "user-kai",
      TIDEPATH,
      "tz-kai",
    );
    const entries: Array<[string, string, string | null, number]> = [
      ["tz-sep14", "Garden", "2026-09-14", 25],
      ["tz-oct20", "Kitchen shift", "2026-10-20", 20],
      ["tz-sun", "Garden", "2026-11-08", 40],
      ["tz-mon", "Garden", "2026-11-09", 50],
      ["tz-undated", "Garden", null, 10],
    ];
    for (const [key, kind, localDate, minutes] of entries) {
      const recorded = await db.ledger.recordActivity(kai, {
        schemaVersion: 1,
        idempotencyKey: key,
        kind,
        localDate,
        datePrecision: localDate ? "day" : "unknown",
        beneficiaryReference: null,
        origin: staffOrigin,
        contributions: [
          { membershipId: "tidepath-mira", durationMinutes: minutes },
        ],
      });
      if (!recorded.ok) throw new Error(`record ${key}`);
      const approved = await db.ledger.transitionContribution(kai, {
        schemaVersion: 1,
        idempotencyKey: `${key}-approve`,
        contributionId: recorded.value.contributions[0]?.contributionId ?? "",
        expectedRevision: 1,
        action: "approve",
      });
      if (!approved.ok) throw new Error(`approve ${key}`);
    }
  }, 60000);
  afterAll(async () => {
    await db?.close();
  });

  async function at(instant: string, search = "") {
    const result = await handlerAt(instant)(
      kai,
      "reports",
      new Request(
        `http://localhost/api/product/reports?membershipId=tidepath-mira${search}`,
      ),
    );
    if (result instanceof Response || !result?.ok)
      throw new Error("Expected a report");
    const value = result.value as ProductReport;
    if (!value.volunteerDetail) throw new Error("Expected a detail");
    return value;
  }
  it("ends on the local Sunday-night week before Monday 00:00", async () => {
    const value = await at(sundayNight);
    expect(value.weekRange).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(value.volunteerDetail?.weeks).toEqual([
      { weekStart: "2026-09-14", approvedMinutes: 25 },
      { weekStart: "2026-09-21", approvedMinutes: 0 },
      { weekStart: "2026-09-28", approvedMinutes: 0 },
      { weekStart: "2026-10-05", approvedMinutes: 0 },
      { weekStart: "2026-10-12", approvedMinutes: 0 },
      { weekStart: "2026-10-19", approvedMinutes: 20 },
      { weekStart: "2026-10-26", approvedMinutes: 0 },
      { weekStart: "2026-11-02", approvedMinutes: 40 },
    ]);
    expect(value.volunteers?.[0]?.weekApprovedMinutes).toBe(40);
  });
  it("rolls to the new week just after local Monday 00:00", async () => {
    const value = await at(mondayMorning);
    expect(value.weekRange).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    expect(value.volunteerDetail?.weeks).toEqual([
      { weekStart: "2026-09-21", approvedMinutes: 0 },
      { weekStart: "2026-09-28", approvedMinutes: 0 },
      { weekStart: "2026-10-05", approvedMinutes: 0 },
      { weekStart: "2026-10-12", approvedMinutes: 0 },
      { weekStart: "2026-10-19", approvedMinutes: 20 },
      { weekStart: "2026-10-26", approvedMinutes: 0 },
      { weekStart: "2026-11-02", approvedMinutes: 40 },
      { weekStart: "2026-11-09", approvedMinutes: 50 },
    ]);
    expect(value.volunteers?.[0]?.weekApprovedMinutes).toBe(50);
    expect(value.volunteerDetail?.unknownDateContributions).toBe(1);
    // Every activity, including the unknown-date one, sums to the total.
    expect(
      value.volunteerDetail?.byActivity.reduce(
        (sum, a) => sum + a.approvedMinutes,
        0,
      ),
    ).toBe(145);
    expect(value.ledger.approvedMinutes).toBe(145);
  });
  it("narrows byActivity to from/to while the weeks ignore them", async () => {
    const value = await at(mondayMorning, "&from=2026-11-01&to=2026-11-08");
    expect(value.volunteerDetail?.byActivity).toEqual([
      {
        activityId: expect.any(String),
        kind: "Garden",
        localDate: "2026-11-08",
        approvedMinutes: 40,
        approvedContributions: 1,
      },
    ]);
    expect(value.volunteerDetail?.weeks?.map((w) => w.approvedMinutes)).toEqual(
      [0, 0, 0, 0, 20, 0, 40, 50],
    );
    expect(value.volunteerDetail?.unknownDateContributions).toBe(1);
  });
});
