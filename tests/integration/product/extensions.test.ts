import { describe, expect, it, vi } from "vitest";
import { createProductExtensions } from "../../../apps/web/lib/product/extensions.ts";
import type { TenantContext } from "../../../packages/contracts/src/index.ts";

const context: TenantContext = {
  organizationId: "org",
  actor: { kind: "user", userId: "u", membershipId: "m", role: "coordinator" },
  correlationId: "c",
};
function fixture() {
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
    .mockResolvedValueOnce({ rows: [{ open: 2, resolved: 1, ack: null }] })
    .mockResolvedValueOnce({ rows: [{ count: 0 }] });
  const options = {
    db: { execute },
    authorization: { require: async () => ({ ok: true, value: undefined }) },
    sources: {},
    processing: {},
    attachments: {},
    root: "/tmp/unused",
    maxBytes: 10485760,
  };
  return {
    execute,
    handler: createProductExtensions(
      options as unknown as Parameters<typeof createProductExtensions>[0],
    ),
  };
}
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
});
