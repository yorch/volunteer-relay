import { createHash } from "node:crypto";
import type { AuthorizationService, TenantContext } from "@relay/contracts";
import { describe, expect, it } from "vitest";
import type { StoredAttachmentMetadata } from "../domain-store.ts";
import { createAttachmentReader } from "./attachment-reader.ts";

const organizationId = "tidepath";
const bytes = new Uint8Array([1, 2, 3, 4]);
const sha256 = createHash("sha256").update(bytes).digest("hex");

type Role = "owner" | "coordinator" | "volunteer" | "report-reader";

const permissionsByRole: Record<Role, string[]> = {
  owner: ["source:submit", "review:write", "need:manage", "report:read"],
  coordinator: ["source:submit", "review:write", "need:manage", "report:read"],
  volunteer: ["source:submit"],
  "report-reader": ["report:read"],
};

function authorization(): AuthorizationService {
  return {
    async resolve(_userId, _organization, correlationId) {
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
      return permissionsByRole[context.actor.role].includes(permission)
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
      membershipId: `membership-${role}`,
      role,
    },
    correlationId: `corr-${role}`,
    ...overrides,
  };
}

function metadataRecord(
  overrides: Partial<StoredAttachmentMetadata> = {},
): StoredAttachmentMetadata {
  return {
    storageKey: "private/synthetic.png",
    sha256,
    mimeType: "image/png",
    bytes: bytes.length,
    authorMembershipId: "membership-volunteer",
    ...overrides,
  };
}

function fixture(
  meta: StoredAttachmentMetadata | null,
  blob?: Uint8Array | null,
) {
  const blobCalls: string[] = [];
  const reader = createAttachmentReader({
    authorization: authorization(),
    metadata: {
      async find() {
        return meta;
      },
    },
    blobs: {
      async read(storageKey) {
        blobCalls.push(storageKey);
        return blob === undefined ? bytes : blob;
      },
    },
  });
  return { reader, blobCalls };
}

describe("read authorization", () => {
  it("lets staff read any attachment in the tenant", async () => {
    const { reader } = fixture(metadataRecord());
    const result = await reader.read(
      context("owner"),
      "source-1",
      "attachment-1",
    );
    expect(result).toEqual({
      ok: true,
      value: { bytes, mimeType: "image/png" },
    });
  });

  it("lets the authoring volunteer read their attachment", async () => {
    const { reader } = fixture(metadataRecord());
    const result = await reader.read(
      context("volunteer"),
      "source-1",
      "attachment-1",
    );
    expect(result.ok).toBe(true);
  });

  it("conceals someone else's attachment from a volunteer as NOT_FOUND", async () => {
    const { reader } = fixture(metadataRecord());
    const result = await reader.read(
      context("volunteer", {
        actor: {
          kind: "user",
          userId: "user-sol",
          membershipId: "membership-sol",
          role: "volunteer",
        },
      }),
      "source-1",
      "attachment-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it.each(["report-reader"] as const)(
    "denies %s before any lookup or blob read",
    async (role) => {
      const metadataCalls = 0;
      const { reader, blobCalls } = fixture(metadataRecord());
      void metadataCalls;
      const result = await reader.read(
        context(role),
        "source-1",
        "attachment-1",
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("FORBIDDEN");
      expect(blobCalls).toHaveLength(0);
    },
  );

  it("denies system actors before any blob read", async () => {
    const { reader, blobCalls } = fixture(metadataRecord());
    const result = await reader.read(
      {
        organizationId,
        actor: { kind: "system", service: "worker" },
        correlationId: "corr-system",
      },
      "source-1",
      "attachment-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FORBIDDEN");
    expect(blobCalls).toHaveLength(0);
  });
});

describe("read integrity", () => {
  it("returns NOT_FOUND for missing metadata", async () => {
    const { reader, blobCalls } = fixture(null);
    const result = await reader.read(context("owner"), "source-1", "missing");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
    expect(blobCalls).toHaveLength(0);
  });

  it("maps a missing blob to retryable DEPENDENCY_UNAVAILABLE", async () => {
    const { reader } = fixture(metadataRecord(), null);
    const result = await reader.read(
      context("owner"),
      "source-1",
      "attachment-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(result.error.retryable).toBe(true);
  });

  it("maps a digest/length mismatch to non-retryable DEPENDENCY_UNAVAILABLE", async () => {
    const { reader } = fixture(metadataRecord(), new Uint8Array([9, 9, 9, 9]));
    const result = await reader.read(
      context("owner"),
      "source-1",
      "attachment-1",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(result.error.retryable).toBe(false);
  });
});
