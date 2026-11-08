import type { NeedRecord, TenantContext } from "@relay/contracts";
import nodemailer from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import {
  createSafeTestTransport,
  createSmtpTransport,
  createTelegramTransport,
  evaluateNeedDeadlines,
  isOrganizationHintId,
  routeNeedNotification,
  safeAppPath,
  withOrganizationHint,
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
    expect(
      await adapter.deliver(context, { ...msg, template: "different" }),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(safeAppPath("//evil.test/workspace")).toBeNull();
  });

  it("isolates tenant keys and shares concurrent deliveries", async () => {
    let resolve!: (value: string) => void;
    const send = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const adapter = createSafeTestTransport(send);
    const message = {
      deliveryKey: "same",
      recipientId: "same",
      template: "urgent",
      appPath: "/workspace/inbox",
    };
    const first = adapter.deliver(context, message);
    const duplicate = adapter.deliver(context, message);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await adapter.deliver(context, { ...message, template: "changed" }),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    resolve("provider-1");
    expect(await first).toEqual(await duplicate);
    const other = adapter.deliver(
      { ...context, organizationId: "other" },
      message,
    );
    expect(send).toHaveBeenCalledTimes(2);
    resolve("provider-2");
    expect(await other).toMatchObject({
      ok: true,
      value: { providerId: "provider-2" },
    });
  });

  it("retains payload identity after a failed delivery while permitting a retry", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce("accepted");
    const adapter = createSafeTestTransport(send);
    const message = {
      deliveryKey: "d",
      recipientId: "m",
      template: "urgent",
      appPath: "/workspace/inbox",
    };
    expect((await adapter.deliver(context, message)).ok).toBe(false);
    expect(
      await adapter.deliver(context, {
        ...message,
        appPath: "/workspace/other",
      }),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(await adapter.deliver(context, message)).toMatchObject({ ok: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("bounds in-process replay memory by age and entry count", async () => {
    let clock = 1_000;
    const send = vi.fn(async (_c: TenantContext, m: { deliveryKey: string }) =>
      Promise.resolve(`p-${m.deliveryKey}`),
    );
    const adapter = createSafeTestTransport(send, {
      maxEntries: 2,
      ttlMs: 100,
      now: () => clock,
    });
    const message = (deliveryKey: string) => ({
      deliveryKey,
      recipientId: "m",
      template: "urgent",
      appPath: "/workspace/inbox",
    });
    await adapter.deliver(context, message("a"));
    await adapter.deliver(context, message("a"));
    expect(send).toHaveBeenCalledTimes(1);
    // Two newer keys push "a" out of a two-entry cache.
    await adapter.deliver(context, message("b"));
    await adapter.deliver(context, message("c"));
    await adapter.deliver(context, message("a"));
    expect(send).toHaveBeenCalledTimes(4);
    // "c" is still cached; after the TTL it is forgotten and resent.
    await adapter.deliver(context, message("c"));
    expect(send).toHaveBeenCalledTimes(4);
    clock += 101;
    await adapter.deliver(context, message("c"));
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("resolves SMTP recipients within their organization", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "mail" });
    const create = vi
      .spyOn(nodemailer, "createTransport")
      .mockReturnValue({ sendMail } as never);
    try {
      const resolveRecipient = vi
        .fn()
        .mockResolvedValue("synthetic@example.test");
      const adapter = createSmtpTransport({
        host: "localhost",
        port: 25,
        secure: false,
        from: "synthetic@example.test",
        resolveRecipient,
      });
      const message = {
        deliveryKey: "d",
        recipientId: "m",
        template: "urgent",
        appPath: "/workspace/inbox",
      };
      await adapter.deliver(context, message);
      await adapter.deliver({ ...context, organizationId: "other" }, message);
      expect(resolveRecipient.mock.calls).toEqual([
        ["org", "m"],
        ["other", "m"],
      ]);
      expect(sendMail).toHaveBeenCalledTimes(2);
    } finally {
      create.mockRestore();
    }
  });

  it("posts only to fixed Telegram endpoint and returns acceptance without human acknowledgment", async () => {
    const tenants: string[] = [];
    const fetch = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }), {
          status: 200,
        }),
    );
    const adapter = createTelegramTransport({
      botToken: "secret",
      resolveChat: async (organizationId) => {
        tenants.push(organizationId);
        return "chat";
      },
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
    expect(tenants).toEqual(["org"]);
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

describe("organization hint links", () => {
  it("sets the hint while preserving query and hash", () => {
    expect(withOrganizationHint("/workspace/needs", "tidepath")).toBe(
      "/workspace/needs?org=tidepath",
    );
    expect(withOrganizationHint("/workspace/needs?org=old#top", "new_2")).toBe(
      "/workspace/needs?org=new_2#top",
    );
  });
  it("refuses bad ids and non-workspace or suspicious paths", () => {
    for (const id of ["", "a b", "a&org=b", "../x", "a%2Fb", "-x", "é"])
      expect(withOrganizationHint("/workspace/needs", id)).toBeNull();
    for (const p of [
      "/other/needs",
      "//evil.test/workspace/x",
      "https://evil.test/workspace/x",
      "/workspace/%2e%2e/admin",
      "/workspace/../x",
      "/workspace/a\\b",
      "/workspace/a\nb",
    ])
      expect(withOrganizationHint(p, "org1")).toBeNull();
    expect(isOrganizationHintId("org:1-a_b")).toBe(true);
  });
  it("accepts valid org links and rejects injected params", () => {
    expect(safeAppPath("/workspace/needs")).toBe("/workspace/needs");
    expect(safeAppPath("/workspace/needs?org=tidepath")).toBe(
      "/workspace/needs?org=tidepath",
    );
    for (const p of [
      "/workspace/needs?org=a&next=https://evil.test",
      "/workspace/needs?next=/x",
      "/workspace/needs?org=a&org=b",
      "/workspace/needs?org=",
      "/workspace/needs?org=a%20b",
      "/workspace/needs?org=https://evil.test",
      "/workspace/needs?org=a\u0001",
    ])
      expect(safeAppPath(p)).toBeNull();
  });
  it("delivers org-hinted links and rejects injected ones", async () => {
    const adapter = createSafeTestTransport();
    const msg = {
      deliveryKey: "dh",
      recipientId: "m1",
      template: "urgent",
      appPath: "/workspace/needs?org=tidepath",
    };
    expect((await adapter.deliver(context, msg)).ok).toBe(true);
    expect(
      (
        await adapter.deliver(context, {
          ...msg,
          deliveryKey: "dh2",
          appPath: "/workspace/needs?next=x",
        })
      ).ok,
    ).toBe(false);
  });
});
