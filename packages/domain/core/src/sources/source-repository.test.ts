import type {
  AuthorizationService,
  SourceEnvelope,
  TenantContext,
} from "@relay/contracts";
import { describe, expect, it } from "vitest";
import { createSourceRepository } from "./source-repository.ts";
import type {
  RevisionInsertOutcome,
  SourceStore,
  StoredRevision,
} from "./source-store.ts";

const organizationId = "tidepath";
const otherOrganizationId = "harbor";

type Role = "owner" | "coordinator" | "volunteer" | "report-reader";

const permissionsByRole: Record<Role, string[]> = {
  owner: ["source:submit", "review:write", "need:manage", "report:read"],
  coordinator: ["source:submit", "review:write", "need:manage", "report:read"],
  volunteer: ["source:submit"],
  "report-reader": ["report:read"],
};

function authorization(): AuthorizationService {
  return {
    async resolve(userId, organization, correlationId) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "not used in these tests",
          correlationId,
          retryable: false,
        },
      };
    },
    async require(context, permission) {
      if (context.actor.kind === "system")
        return {
          ok: false,
          error: {
            code: "FORBIDDEN",
            message: "system",
            correlationId: context.correlationId,
            retryable: false,
          },
        };
      const granted =
        permissionsByRole[context.actor.role].includes(permission);
      return granted
        ? { ok: true, value: undefined }
        : {
            ok: false,
            error: {
              code: "FORBIDDEN",
              message: "not granted",
              correlationId: context.correlationId,
              retryable: false,
            },
          };
    },
  };
}

function context(
  role: Role,
  overrides: Partial<TenantContext> = {},
): TenantContext {
  return {
    organizationId,
    actor: {
      kind: "user",
      userId: `user-${role}`,
      membershipId: "tidepath-mira",
      role,
    },
    correlationId: `corr-${role}`,
    ...overrides,
  };
}

function envelope(overrides: Partial<SourceEnvelope> = {}): SourceEnvelope {
  return {
    schemaVersion: 1,
    organizationId,
    sourceId: "source-01",
    revision: 1,
    channel: "web",
    channelIdentity: "web-tidepath",
    externalMessageId: "external-1",
    idempotencyKey: "idem-1",
    author: { externalIdentity: "Mira", membershipId: "tidepath-mira" },
    occurredAt: "2026-11-04T15:00:00Z",
    receivedAt: "2026-11-04T15:01:00Z",
    timezone: "America/New_York",
    text: "Synthetic text.",
    attachments: [],
    replyToSourceId: null,
    replacesRevision: null,
    original: { mediaType: "text/plain", payload: "Synthetic text." },
    ...overrides,
  };
}

function storedRevision(
  overrides: Partial<StoredRevision> = {},
): StoredRevision {
  return {
    organizationId,
    sourceId: "source-01",
    revision: 1,
    channel: "web",
    channelIdentity: "web-tidepath",
    externalMessageId: "external-1",
    idempotencyKey: "idem-1",
    authorExternalIdentity: "Mira",
    authorMembershipId: "tidepath-mira",
    occurredAt: new Date("2026-11-04T15:00:00Z"),
    receivedAt: new Date("2026-11-04T15:01:00Z"),
    timezone: "America/New_York",
    text: "Synthetic text.",
    originalMediaType: "text/plain",
    originalPayload: "Synthetic text.",
    replyToSourceId: null,
    replacesRevision: null,
    canonicalDigest: "digest",
    envelope: envelope(),
    correlationId: "corr-original",
    attachments: [],
    ...overrides,
  };
}

function fakeStore(outcome: RevisionInsertOutcome) {
  const inserted: Array<{ revision: StoredRevision; event: unknown }> = [];
  const store: SourceStore = {
    async insertRevision(revision, event) {
      inserted.push({ revision, event });
      if (outcome.kind === "inserted" || outcome.kind === "replay")
        return outcome;
      if (outcome.kind === "invalid-target") return outcome;
      return outcome;
    },
    async findRevision() {
      return outcome.kind === "inserted" || outcome.kind === "replay"
        ? outcome.stored
        : null;
    },
  };
  return { store, inserted };
}

describe("accept: authorization mapping", () => {
  it("denies system actors", async () => {
    const { store, inserted } = fakeStore({
      kind: "inserted",
      stored: storedRevision(),
    });
    const repository = createSourceRepository({
      authorization: authorization(),
      store,
    });
    const result = await repository.accept(
      {
        organizationId,
        actor: { kind: "system", service: "worker" },
        correlationId: "corr-system",
      },
      envelope(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("FORBIDDEN");
    expect(inserted).toHaveLength(0);
  });

  it("conceals a cross-tenant envelope before touching the store", async () => {
    const { store, inserted } = fakeStore({
      kind: "inserted",
      stored: storedRevision(),
    });
    const repository = createSourceRepository({
      authorization: authorization(),
      store,
    });
    const result = await repository.accept(
      context("volunteer"),
      envelope({ organizationId: otherOrganizationId }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("NOT_FOUND");
    expect(inserted).toHaveLength(0);
  });

  it("rejects an invalid envelope as VALIDATION", async () => {
    const { store } = fakeStore({ kind: "inserted", stored: storedRevision() });
    const repository = createSourceRepository({
      authorization: authorization(),
      store,
    });
    const result = await repository.accept(
      context("volunteer"),
      envelope({ revision: 0 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("VALIDATION");
  });

  it("keeps a volunteer to their own membership", async () => {
    const { store } = fakeStore({ kind: "inserted", stored: storedRevision() });
    const repository = createSourceRepository({
      authorization: authorization(),
      store,
    });

    const own = await repository.accept(context("volunteer"), envelope());
    expect(own.ok).toBe(true);

    const other = await repository.accept(
      context("volunteer"),
      envelope({
        idempotencyKey: "idem-2",
        externalMessageId: "external-2",
        author: { externalIdentity: "Sol", membershipId: "tidepath-sol" },
      }),
    );
    expect(other.ok).toBe(false);
    if (other.ok) throw new Error("expected failure");
    expect(other.error.code).toBe("FORBIDDEN");
  });

  it("lets staff submit for another mapped member", async () => {
    const { store } = fakeStore({ kind: "inserted", stored: storedRevision() });
    const repository = createSourceRepository({
      authorization: authorization(),
      store,
    });
    const result = await repository.accept(
      context("owner"),
      envelope({
        author: { externalIdentity: "Sol", membershipId: "tidepath-sol" },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("denies report-readers submission", async () => {
    const { store } = fakeStore({ kind: "inserted", stored: storedRevision() });
    const repository = createSourceRepository({
      authorization: authorization(),
      store,
    });
    const result = await repository.accept(
      context("report-reader"),
      envelope(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("FORBIDDEN");
  });
});

describe("accept: outcome mapping", () => {
  it("returns the stored receipt on replay", async () => {
    const { store } = fakeStore({ kind: "replay", stored: storedRevision() });
    const repository = createSourceRepository({
      authorization: authorization(),
      store,
    });
    const result = await repository.accept(context("volunteer"), envelope());
    expect(result).toEqual({
      ok: true,
      value: {
        sourceId: "source-01",
        revision: 1,
        status: "received",
        correlationId: "corr-original",
      },
    });
  });

  it("maps conflict reasons to CONFLICT", async () => {
    for (const reason of [
      "digest",
      "revision",
      "external-message",
      "attachment-identity",
    ] as const) {
      const { store } = fakeStore({ kind: "conflict", reason });
      const repository = createSourceRepository({
        authorization: authorization(),
        store,
      });
      const result = await repository.accept(context("volunteer"), envelope());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  it("maps an out-of-tenant reference to a field-level VALIDATION error", async () => {
    const { store } = fakeStore({
      kind: "invalid-target",
      field: "author-membership",
    });
    const repository = createSourceRepository({
      authorization: authorization(),
      store,
    });
    const result = await repository.accept(context("owner"), envelope());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fields?.author).toEqual([
      "membershipId is not part of this organization",
    ]);
  });

  it("passes a stable event with actor and correlation provenance to the store", async () => {
    const { store, inserted } = fakeStore({
      kind: "inserted",
      stored: storedRevision(),
    });
    const repository = createSourceRepository({
      authorization: authorization(),
      store,
      now: () => new Date("2026-11-04T16:00:00Z"),
    });
    await repository.accept(context("volunteer"), envelope());

    const record = inserted[0];
    expect(record?.revision.canonicalDigest).toMatch(/^[a-f0-9]{64}$/);
    const event = record?.event as {
      id: string;
      type: string;
      aggregateId: string;
      aggregateRevision: number;
      correlationId: string;
      occurredAt: Date;
      actor: unknown;
    };
    expect(event.type).toBe("source.received");
    expect(event.aggregateId).toBe("source-01");
    expect(event.aggregateRevision).toBe(1);
    expect(event.correlationId).toBe("corr-volunteer");
    expect(event.occurredAt.toISOString()).toBe("2026-11-04T16:00:00.000Z");
    expect(event.actor).toEqual(context("volunteer").actor);
    expect(event.id.startsWith("evt:")).toBe(true);
  });
});

describe("get: evidence access rules", () => {
  it("allows staff, denies report-readers", async () => {
    const { store } = fakeStore({ kind: "inserted", stored: storedRevision() });
    const repository = createSourceRepository({
      authorization: authorization(),
      store,
    });

    expect((await repository.get(context("owner"), "source-01", 1)).ok).toBe(
      true,
    );
    expect(
      (await repository.get(context("coordinator"), "source-01", 1)).ok,
    ).toBe(true);

    const reader = await repository.get(
      context("report-reader"),
      "source-01",
      1,
    );
    expect(reader.ok).toBe(false);
    if (reader.ok) throw new Error("expected failure");
    expect(reader.error.code).toBe("FORBIDDEN");
  });

  it("restricts volunteers to their own submissions", async () => {
    const { store } = fakeStore({ kind: "inserted", stored: storedRevision() });
    const repository = createSourceRepository({
      authorization: authorization(),
      store,
    });

    expect(
      (await repository.get(context("volunteer"), "source-01", 1)).ok,
    ).toBe(true);

    const other = await repository.get(
      context("volunteer", {
        actor: {
          kind: "user",
          userId: "user-sol",
          membershipId: "tidepath-sol",
          role: "volunteer",
        },
      }),
      "source-01",
      1,
    );
    expect(other.ok).toBe(false);
    if (other.ok) throw new Error("expected failure");
    // Concealed like an unknown source, never disclosed as another author's.
    expect(other.error.code).toBe("NOT_FOUND");
  });

  it("returns NOT_FOUND for an unknown revision and denies system actors", async () => {
    const { store } = fakeStore({ kind: "conflict", reason: "revision" });
    const repository = createSourceRepository({
      authorization: authorization(),
      store,
    });

    const missing = await repository.get(context("owner"), "source-01", 2);
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("expected failure");
    expect(missing.error.code).toBe("NOT_FOUND");

    const system = await repository.get(
      {
        organizationId,
        actor: { kind: "system", service: "worker" },
        correlationId: "corr-sys",
      },
      "source-01",
      1,
    );
    expect(system.ok).toBe(false);
    if (system.ok) throw new Error("expected failure");
    expect(system.error.code).toBe("FORBIDDEN");
  });
});
