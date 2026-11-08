import { describe, expect, it, vi } from "vitest";
import {
  createProductHandler,
  type ProductHttpDependencies,
} from "../../../apps/web/lib/product/http.ts";
import type { TenantContext } from "../../../packages/contracts/src/index.ts";

const context: TenantContext = {
  organizationId: "org",
  actor: { kind: "user", userId: "u", membershipId: "m", role: "volunteer" },
  correlationId: "c",
};
const ok = (value: unknown) => ({ ok: true as const, value });
function fixture() {
  const deps = {
    appUrl: "http://localhost:3000",
    resolve: vi.fn(async () =>
      ok({
        context,
        organization: {
          organizationId: "org",
          membershipId: "m",
          name: "Org",
          slug: "org",
          role: "volunteer",
        },
      }),
    ),
    authorization: { require: vi.fn(async () => ok(undefined)) },
    sources: {
      accept: vi.fn(async () =>
        ok({
          sourceId: "s",
          revision: 1,
          status: "received",
          correlationId: "c",
        }),
      ),
    },
    processing: {
      getSource: vi.fn(async () => ({
        ok: false as const,
        error: {
          code: "NOT_FOUND",
          message: "missing",
          correlationId: "c",
          retryable: false,
        },
      })),
      listSourceStatuses: vi.fn(async () => ok([])),
      listQueue: vi.fn(async () => ok([])),
      decide: vi.fn(),
    },
    ledger: {
      listContributions: vi.fn(async () => ok([])),
      summarize: vi.fn(),
    },
    needs: { list: vi.fn() },
    members: vi.fn(),
  };
  return {
    deps,
    handler: createProductHandler(deps as unknown as ProductHttpDependencies),
  };
}
const submit = (body: unknown, origin = "http://localhost:3000") =>
  new Request("http://localhost:3000/api/product/sources", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
describe("product HTTP trust boundary", () => {
  it("denies cross-origin mutation before touching session or persistence", async () => {
    const { deps, handler } = fixture();
    expect(
      (await handler(submit({ text: "x" }, "https://evil.invalid"))).status,
    ).toBe(403);
    expect(deps.resolve).not.toHaveBeenCalled();
  });
  it("rejects tenant/author injection and oversized body", async () => {
    const { deps, handler } = fixture();
    expect(
      (
        await handler(
          submit({
            schemaVersion: 1,
            idempotencyKey: "k",
            text: "helped",
            organizationId: "foreign",
          }),
        )
      ).status,
    ).toBe(422);
    expect((await handler(submit({ text: "x".repeat(70000) }))).status).toBe(
      422,
    );
    expect(deps.sources.accept).not.toHaveBeenCalled();
  });
  it("derives source identity and author only from verified membership", async () => {
    const { deps, handler } = fixture();
    const response = await handler(
      submit({
        schemaVersion: 1,
        idempotencyKey: "retry-key",
        text: "Helped for 60 minutes",
      }),
    );
    expect(response.status).toBe(200);
    expect(deps.sources.accept).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        organizationId: "org",
        channel: "web",
        author: { membershipId: "m", externalIdentity: "u" },
        attachments: [],
        occurredAt: null,
      }),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("conceals staff records in the volunteer projection", async () => {
    const { deps, handler } = fixture();
    const response = await handler(
      new Request("http://localhost:3000/api/product/workspace"),
    );
    expect(response.status).toBe(200);
    expect(deps.processing.listQueue).not.toHaveBeenCalled();
    expect(deps.needs.list).not.toHaveBeenCalled();
    expect(deps.members).not.toHaveBeenCalled();
  });
});
