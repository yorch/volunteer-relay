import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductExtensions } from "../../../apps/web/lib/product/extensions.ts";
import type { TenantContext } from "../../../packages/contracts/src/index.ts";

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
      },
    });
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
