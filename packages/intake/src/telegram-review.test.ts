import type { PrivateBlobStore } from "@relay/blob";
import type { Result, SourceEnvelope, TenantContext } from "@relay/contracts";
import { describe, expect, it, vi } from "vitest";
import type { TelegramUpdate } from "./index.ts";
import {
  createTelegramRuntime,
  createTelegramUpdateAttempts,
  handleTelegramUpdate,
  type TelegramIngressDependencies,
} from "./telegram-ingress.ts";
import {
  createTelegramPhotoDownloader,
  TelegramPhotoError,
} from "./telegram-photo.ts";

// Synthetic tenant and sender; no real identities.
const context: TenantContext = {
  organizationId: "org-synthetic",
  actor: {
    kind: "user",
    membershipId: "member-synthetic",
    userId: "user-synthetic",
    role: "volunteer",
  },
  correlationId: "corr-synthetic",
};
const SENDER = 4401;
const BASE_DATE = 1_800_000_000;
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

const failure = (code: string): Result<never> =>
  ({
    ok: false,
    error: { code, message: "synthetic", retryable: false, correlationId: "c" },
  }) as Result<never>;

function deps(overrides: Partial<TelegramIngressDependencies["links"]> = {}) {
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
  const value = {
    links: {
      consumeTelegramLink: async () => ({ ok: true as const, value: {} }),
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
      ...overrides,
    },
    sources: { accept },
    authorization: {},
    needs: { transition: vi.fn() },
    timezone: async () => "UTC",
  };
  return {
    accept,
    deps: value as unknown as Omit<TelegramIngressDependencies, "secret">,
  };
}
function message(
  updateId: number,
  fields: Record<string, unknown> & { edit_date?: number } = {},
): TelegramUpdate {
  const body = {
    message_id: 31,
    chat: { id: SENDER, type: "private" },
    from: { id: SENDER },
    date: BASE_DATE,
    text: "Sorted donations for 45 minutes",
    ...fields,
  };
  return (
    fields.edit_date === undefined
      ? { update_id: updateId, message: body }
      : { update_id: updateId, edited_message: body }
  ) as TelegramUpdate;
}

describe("Telegram terminal versus transient outcomes", () => {
  it("answers terminal cases with 200 so Telegram stops redelivering", async () => {
    const unlinked = deps({
      resolveTelegramIdentity: async () => failure("NOT_FOUND"),
    });
    const notConnected = await handleTelegramUpdate(unlinked.deps, message(1));
    expect(notConnected.status).toBe(200);
    expect(await notConnected.json()).toMatchObject({
      method: "sendMessage",
      chat_id: SENDER,
    });

    const badLink = deps({
      consumeTelegramLink: async () => failure("NOT_FOUND"),
    });
    const link = await handleTelegramUpdate(
      badLink.deps,
      message(2, { text: "/link expired-code" }),
    );
    expect(link.status).toBe(200);
    expect(await link.json()).toMatchObject({ method: "sendMessage" });

    const group = deps();
    const posted = await handleTelegramUpdate(
      group.deps,
      message(3, { chat: { id: -900, type: "group" } }),
    );
    expect(posted.status).toBe(200);
    expect(await posted.json()).toEqual({ ok: true });
    expect(group.accept).not.toHaveBeenCalled();

    const orphan = deps();
    const edit = await handleTelegramUpdate(
      orphan.deps,
      message(4, { edit_date: BASE_DATE + 60 }),
    );
    expect(edit.status).toBe(200);
    expect(orphan.accept).not.toHaveBeenCalled();
  });

  it("keeps dependency outages retryable, including organization selection", async () => {
    const org = deps({
      selectTelegramOrganization: async () => failure("DEPENDENCY_UNAVAILABLE"),
    });
    expect(
      (await handleTelegramUpdate(org.deps, message(5, { text: "/org o2" })))
        .status,
    ).toBe(503);
    const denied = deps({
      selectTelegramOrganization: async () => failure("FORBIDDEN"),
    });
    expect(
      (await handleTelegramUpdate(denied.deps, message(6, { text: "/org o2" })))
        .status,
    ).toBe(200);
    const resolve = deps({
      resolveTelegramIdentity: async () => failure("DEPENDENCY_UNAVAILABLE"),
    });
    expect((await handleTelegramUpdate(resolve.deps, message(7))).status).toBe(
      503,
    );
  });

  it("ignores an edit that is not newer than the stored revision", async () => {
    const f = deps();
    expect((await handleTelegramUpdate(f.deps, message(10))).status).toBe(200);
    const newer = message(12, {
      edit_date: BASE_DATE + 300,
      text: "Sorted donations for 60 minutes",
    });
    expect((await handleTelegramUpdate(f.deps, newer)).status).toBe(200);
    // Delivered late: edited at +120s, after the +300s edit was stored.
    const stale = message(11, {
      edit_date: BASE_DATE + 120,
      text: "Sorted donations for 50 minutes",
    });
    const response = await handleTelegramUpdate(f.deps, stale);
    expect(response.status).toBe(200);
    expect(f.accept).toHaveBeenCalledTimes(2);
    expect(f.accept.mock.calls.at(-1)?.[1].text).toBe(
      "Sorted donations for 60 minutes",
    );
  });

  it("replies to a permanently unusable photo and retries a transient one", async () => {
    const photoUpdate = message(20, {
      text: undefined,
      caption: "Pantry shelf",
      photo: [{ file_id: "synthetic_file_1" }],
    });
    const permanent = deps();
    const rejected = await handleTelegramUpdate(
      {
        ...permanent.deps,
        photo: async () => {
          throw new TelegramPhotoError(true, "Unsupported image");
        },
      },
      photoUpdate,
    );
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({ method: "sendMessage" });
    expect(permanent.accept).not.toHaveBeenCalled();

    const flaky = deps();
    const retry = await handleTelegramUpdate(
      {
        ...flaky.deps,
        photo: async () => {
          throw new TelegramPhotoError(false, "Photo unavailable");
        },
      },
      photoUpdate,
    );
    expect(retry.status).toBe(503);
  });
});

describe("Telegram photo download classification", () => {
  const telegram = (
    file: { status: number; body?: BodyInit },
    info: { file_path?: string; file_size?: number } = {
      file_path: "photos/file_1.jpg",
      file_size: PNG.byteLength,
    },
  ) =>
    vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/getFile")
        ? Response.json({ ok: true, result: info })
        : new Response(file.body ?? null, { status: file.status }),
    ) as unknown as typeof fetch;
  const classify = async (download: () => Promise<unknown>) =>
    download().then(
      () => "stored",
      (error: unknown) =>
        error instanceof TelegramPhotoError
          ? error.permanent
            ? "permanent"
            : "transient"
          : "other",
    );

  it("separates permanent file problems from provider outages", async () => {
    const make = (fetch: typeof globalThis.fetch, transform = vi.fn()) =>
      createTelegramPhotoDownloader({
        botToken: "synthetic-token",
        maxBytes: 64,
        transform: transform.mockResolvedValue(new Uint8Array([1, 2, 3])),
        fetch,
      });
    expect(
      await classify(() =>
        make(telegram({ status: 200, body: PNG }))("synthetic_file"),
      ),
    ).toBe("stored");
    expect(
      await classify(() =>
        make(
          telegram(
            { status: 200, body: PNG },
            {
              file_path: "photos/file_1.jpg",
              file_size: 65,
            },
          ),
        )("synthetic_file"),
      ),
    ).toBe("permanent");
    expect(
      await classify(() =>
        make(telegram({ status: 200, body: new Uint8Array([1, 2, 3, 4]) }))(
          "synthetic_file",
        ),
      ),
    ).toBe("permanent");
    const undecodable = vi.fn().mockRejectedValue(new Error("warning"));
    expect(
      await classify(() =>
        createTelegramPhotoDownloader({
          botToken: "synthetic-token",
          maxBytes: 64,
          transform: undecodable,
          fetch: telegram({ status: 200, body: PNG }),
        })("synthetic_file"),
      ),
    ).toBe("permanent");
    expect(
      await classify(() => make(telegram({ status: 502 }))("synthetic_file")),
    ).toBe("transient");
    const offline = vi
      .fn()
      .mockRejectedValue(
        new TypeError("fetch failed"),
      ) as unknown as typeof fetch;
    expect(await classify(() => make(offline)("synthetic_file"))).toBe(
      "transient",
    );
  });
});

describe("Telegram runtime transaction boundary", () => {
  it("downloads and decodes the photo before opening the transaction", async () => {
    const order: string[] = [];
    const f = deps();
    const store = {
      put: vi.fn(async () => {
        order.push("put");
        return {
          storageKey: "ab/synthetic",
          sha256: "synthetic",
          mimeType: "image/png" as const,
          bytes: 3,
        };
      }),
    } as unknown as PrivateBlobStore;
    const runtime = createTelegramRuntime({
      secret: "",
      botToken: "synthetic-token",
      maxBytes: 64,
      store,
      transform: async () => {
        order.push("transform");
        return new Uint8Array([7, 7, 7]);
      },
      fetch: vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith("/getFile")
          ? Response.json({
              ok: true,
              result: { file_path: "photos/a.jpg", file_size: 12 },
            })
          : new Response(PNG),
      ) as unknown as typeof fetch,
      transaction: async (work) => {
        order.push("begin");
        const result = await work({
          deps: f.deps,
          lockBlob: async () => {
            order.push("lock");
          },
        });
        order.push("commit");
        return result;
      },
    });
    const response = await runtime.handleUpdate(
      message(30, {
        text: undefined,
        caption: "Pantry shelf",
        photo: [{ file_id: "synthetic_file_2" }],
      }),
    );
    expect(response.status).toBe(200);
    expect(order).toEqual(["transform", "begin", "lock", "put", "commit"]);
    expect(f.accept.mock.calls[0]?.[1].attachments).toHaveLength(1);
  });

  it("returns 503 for a transient download without opening a transaction", async () => {
    const transaction = vi.fn();
    const runtime = createTelegramRuntime({
      secret: "",
      botToken: "synthetic-token",
      maxBytes: 64,
      store: {} as PrivateBlobStore,
      transform: async (bytes) => bytes,
      fetch: vi.fn(
        async () => new Response(null, { status: 503 }),
      ) as unknown as typeof fetch,
      transaction,
    });
    const response = await runtime.handleUpdate(
      message(31, { photo: [{ file_id: "synthetic_file_3" }] }),
    );
    expect(response.status).toBe(503);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not fetch a photo from an unlinked sender", async () => {
    const fetcher = vi.fn();
    const f = deps({
      resolveTelegramIdentity: async () => failure("NOT_FOUND"),
    });
    const runtime = createTelegramRuntime({
      secret: "",
      botToken: "synthetic-token",
      maxBytes: 64,
      store: {} as PrivateBlobStore,
      transform: async (bytes) => bytes,
      fetch: fetcher as unknown as typeof fetch,
      linked: async () => false,
      transaction: async (work) =>
        work({ deps: f.deps, lockBlob: async () => {} }),
    });
    const response = await runtime.handleUpdate(
      message(32, { photo: [{ file_id: "synthetic_file_4" }] }),
    );
    expect(response.status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Telegram poller attempt cap", () => {
  it("skips an update only after repeated consecutive transient failures", () => {
    const attempts = createTelegramUpdateAttempts(3);
    expect(attempts.failed(100)).toBe(false);
    expect(attempts.failed(100)).toBe(false);
    expect(attempts.failed(100)).toBe(true);
    attempts.settled(100);
    // A different update starts a fresh count.
    expect(attempts.failed(101)).toBe(false);
    attempts.settled(101);
    expect(attempts.failed(101)).toBe(false);
  });
});
