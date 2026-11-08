import type { SourceEnvelope, TenantContext } from "@relay/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createTelegramIngress,
  type TelegramIngressDependencies,
} from "./telegram-ingress.ts";

const context: TenantContext = {
  organizationId: "o",
  actor: { kind: "user", membershipId: "m", userId: "u", role: "volunteer" },
  correlationId: "c",
};
function fixture() {
  let latest: SourceEnvelope | null = null;
  const accept = vi.fn(async (_c: TenantContext, source: SourceEnvelope) => {
    latest = source;
    return {
      ok: true as const,
      value: {
        sourceId: source.sourceId,
        revision: source.revision,
        status: "received" as const,
        correlationId: "c",
      },
    };
  });
  const consume = vi.fn(async () => ({ ok: true as const, value: {} }));
  const deps = {
    secret: "synthetic-webhook-secret",
    links: {
      consumeTelegramLink: consume,
      selectTelegramOrganization: async () => ({
        ok: true as const,
        value: {},
      }),
      resolveTelegramIdentity: async () => ({
        ok: true as const,
        value: { context, organizations: [] },
      }),
      getTelegramSourceRevision: async () => ({
        ok: true as const,
        value: latest,
      }),
    },
    sources: { accept },
    authorization: {
      resolve: async () => ({
        ok: false as const,
        error: {
          code: "FORBIDDEN",
          message: "denied",
          retryable: false,
          correlationId: "c",
        },
      }),
    },
    needs: { transition: vi.fn() },
    timezone: async () => "UTC",
  };
  return {
    accept,
    consume,
    deps,
    handler: createTelegramIngress(
      deps as unknown as TelegramIngressDependencies,
    ),
  };
}
const update = (id: number, edit = false) => ({
  update_id: id,
  [edit ? "edited_message" : "message"]: {
    message_id: 7,
    chat: { id: 12, type: "private" },
    from: { id: 12 },
    date: 1794000000,
    ...(edit ? { edit_date: 1794000000 + id } : {}),
    text: `Helped ${id} minutes`,
  },
});
const request = (body: unknown, secret = "synthetic-webhook-secret") =>
  new Request("http://localhost/api/telegram/webhook", {
    method: "POST",
    headers: {
      "x-telegram-bot-api-secret-token": secret,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
describe("Telegram verified ingress", () => {
  it("rejects forged secret before linking or source persistence", async () => {
    const f = fixture();
    expect((await f.handler(request(update(1), "forged"))).status).toBe(403);
    expect(f.accept).not.toHaveBeenCalled();
    expect(f.consume).not.toHaveBeenCalled();
  });
  it("preserves receipt on replay and allocates successive edit revisions", async () => {
    const f = fixture();
    for (const body of [update(1), update(1), update(2, true), update(3, true)])
      expect((await f.handler(request(body))).status).toBe(200);
    expect(f.accept.mock.calls.map((c) => c[1].revision)).toEqual([1, 1, 2, 3]);
    expect(new Set(f.accept.mock.calls.map((c) => c[1].sourceId)).size).toBe(1);
  });
  it("links only a private sender identity and revalidates acknowledgement authority", async () => {
    const f = fixture();
    const body = {
      update_id: 1,
      message: {
        message_id: 7,
        chat: { id: 12, type: "private" },
        from: { id: 12 },
        date: 1794000000,
        text: "/link single-use-token",
      },
    };
    body.message.text = "/link single-use-token";
    expect((await f.handler(request(body))).status).toBe(200);
    expect(f.consume).toHaveBeenCalledWith("single-use-token", "12");
    body.message.text = "/ack foreign need 1";
    expect((await f.handler(request(body))).status).toBe(403);
    expect(f.deps.needs.transition).not.toHaveBeenCalled();
    body.message.chat.type = "group";
    expect((await f.handler(request(body))).status).toBe(422);
  });
});
