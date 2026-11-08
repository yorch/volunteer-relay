import type { NeedRecord, TenantContext } from "@relay/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createSafeTestTransport,
  createTelegramTransport,
  evaluateNeedDeadlines,
  routeNeedNotification,
  safeAppPath,
} from "./index.js";

const context: TenantContext = {
  organizationId: "org",
  actor: { kind: "system", service: "worker" },
  correlationId: "corr",
};
const need = (status: NeedRecord["status"]): NeedRecord => ({
  schemaVersion: 1,
  organizationId: "org",
  needId: "n1",
  revision: 1,
  category: "food",
  urgency: "urgent",
  summary: "Food needed",
  provisional: false,
  status,
  ownerMembershipId: status === "new" ? null : "owner",
  dueAt: null,
  acknowledgeBy: "2026-01-01T00:00:00.000Z",
  acknowledgedAt: status === "acknowledged" ? "2025-12-31T00:00:00.000Z" : null,
  acknowledgedByMembershipId: status === "acknowledged" ? "owner" : null,
  resolvedAt: status === "resolved" ? "2025-12-31T00:00:00.000Z" : null,
  resolution: status === "resolved" ? "Done" : null,
  origin: { kind: "source", sourceId: "s", sourceRevision: 1 },
  createdAt: "2025-12-30T00:00:00.000Z",
  updatedAt: "2025-12-30T00:00:00.000Z",
});

describe("notification adapters and routing", () => {
  it("deduplicates accepted replay keys and rejects external links", async () => {
    const adapter = createSafeTestTransport();
    const msg = {
      deliveryKey: "d1",
      recipientId: "m1",
      template: "urgent",
      appPath: "/workspace/inbox",
    };
    const first = await adapter.deliver(context, msg);
    const replay = await adapter.deliver(context, msg);
    expect(first).toEqual(replay);
    expect(
      (await adapter.deliver(context, { ...msg, appPath: "https://evil.test" }))
        .ok,
    ).toBe(false);
    expect(safeAppPath("//evil.test/workspace")).toBeNull();
  });

  it("posts only to fixed Telegram endpoint and returns acceptance without human acknowledgment", async () => {
    const fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }), {
          status: 200,
        }),
    );
    const adapter = createTelegramTransport({
      botToken: "secret",
      resolveChat: async () => "chat",
      fetch,
    });
    const result = await adapter.deliver(context, {
      deliveryKey: "d",
      recipientId: "m",
      template: "urgent",
      appPath: "/workspace/inbox",
    });
    expect(result).toEqual({
      ok: true,
      value: { providerId: "telegram-8", status: "accepted" },
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://api.telegram.org/botsecret/sendMessage",
    );
  });

  it("classifies timeout as retryable with an indeterminate outcome and reuses fetch injection", async () => {
    const fetch = vi.fn(async () => {
      throw new DOMException("timeout", "TimeoutError");
    });
    const adapter = createTelegramTransport({
      botToken: "token",
      resolveChat: async () => "c",
      fetch,
      timeoutMs: 1,
    });
    const result = await adapter.deliver(context, {
      deliveryKey: "d",
      recipientId: "m",
      template: "x",
      appPath: "/workspace/inbox",
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        retryable: true,
        message: "Delivery outcome indeterminate after timeout",
      },
    });
  });

  it("routes by category/fallback and filters removed memberships", () => {
    const rules = {
      version: 1 as const,
      categoryRoutes: { food: ["a", "removed"] },
      urgentFallback: ["b"],
      routineFallback: ["c"],
    };
    expect(
      routeNeedNotification(need("new"), rules, new Set(["a", "b"])),
    ).toEqual({ membershipIds: ["a"], ruleVersion: 1, reason: "category" });
  });

  it("does not send reminders after acknowledgment or resolution", () => {
    const active = new Set(["owner"]);
    const now = new Date("2026-01-02T00:00:00.000Z");
    expect(
      evaluateNeedDeadlines(
        [need("assigned"), need("acknowledged"), need("resolved")],
        now,
        active,
      ),
    ).toEqual([
      {
        needId: "n1",
        action: "escalate",
        deadline: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(evaluateNeedDeadlines([need("assigned")], now, new Set())).toEqual(
      [],
    );
  });
});
