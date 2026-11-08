import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ApiError,
  Result,
  SourceEnvelope,
} from "../../../packages/contracts/src/index.ts";
import { createSourceStore } from "../../../packages/db/src/index.ts";
import { seedOrganizations } from "../../../packages/db/src/seed-data.ts";
import { createSourceRepository } from "../../../packages/domain/core/src/index.ts";
import { resetAuthTables } from "../auth/support.ts";
import {
  context,
  createReader,
  type DomainFixture,
  HARBOR,
  openDomainFixture,
  seedDomainMembers,
  systemContext,
  TIDEPATH,
} from "./domain-support.ts";

let fixture: DomainFixture;
let repository: ReturnType<typeof createSourceRepository>;

beforeAll(async () => {
  fixture = await openDomainFixture();
  repository = createSourceRepository({
    authorization: fixture.authorization,
    store: createSourceStore(fixture.db),
  });
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  await resetAuthTables(fixture.db);
  await seedOrganizations(fixture.db);
  await seedDomainMembers(fixture.db);
});

function errorOf<T>(result: Result<T>): ApiError["error"] {
  if (result.ok) throw new Error("expected a failure result");
  return result.error;
}

const tidepathBytes = new Uint8Array([11, 22, 33, 44]);
const harborBytes = new Uint8Array([99, 88, 77]);

function envelopeFor(
  organizationId: string,
  membershipId: string,
  externalIdentity: string,
  bytes: Uint8Array,
  storageKey: string,
): SourceEnvelope {
  return {
    schemaVersion: 1,
    organizationId,
    sourceId: "source-with-photos",
    revision: 1,
    channel: "web",
    channelIdentity: `web-${organizationId}`,
    externalMessageId: `external-${organizationId}`,
    idempotencyKey: `idem-src-${organizationId}`,
    author: { externalIdentity, membershipId },
    occurredAt: "2026-11-04T15:00:00Z",
    receivedAt: "2026-11-04T15:01:00Z",
    timezone: "America/New_York",
    text: "Synthetic source text with an attachment.",
    attachments: [
      {
        id: "attachment-1",
        organizationId,
        storageKey,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mimeType: "image/png",
        bytes: bytes.length,
      },
    ],
    replyToSourceId: null,
    replacesRevision: null,
    original: {
      mediaType: "text/plain",
      payload: "Synthetic source text with an attachment.",
    },
  };
}

async function seedSources(): Promise<Map<string, Uint8Array>> {
  const blobs = new Map<string, Uint8Array>([
    ["private/tidepath-photo.png", tidepathBytes],
    ["private/harbor-photo.png", harborBytes],
  ]);
  const mira = await context(
    fixture.authorization,
    "user-mira",
    TIDEPATH,
    "corr-src-tidepath",
  );
  expect(
    (
      await repository.accept(
        mira,
        envelopeFor(
          TIDEPATH,
          "tidepath-mira",
          "Mira",
          tidepathBytes,
          "private/tidepath-photo.png",
        ),
      )
    ).ok,
  ).toBe(true);
  const nico = await context(
    fixture.authorization,
    "user-nico",
    HARBOR,
    "corr-src-harbor",
  );
  expect(
    (
      await repository.accept(
        nico,
        envelopeFor(
          HARBOR,
          "harbor-nico",
          "Nico",
          harborBytes,
          "private/harbor-photo.png",
        ),
      )
    ).ok,
  ).toBe(true);
  return blobs;
}

describe("attachment reads", () => {
  it("lets staff read any attachment in the tenant", async () => {
    const blobs = await seedSources();
    const reader = createReader(fixture, blobs);
    const kai = await context(
      fixture.authorization,
      "user-kai",
      TIDEPATH,
      "corr-staff-read",
    );
    const result = await reader.read(kai, "source-with-photos", "attachment-1");
    expect(result).toEqual({
      ok: true,
      value: { bytes: tidepathBytes, mimeType: "image/png" },
    });
  });

  it("lets the authoring volunteer read, and conceals others", async () => {
    const blobs = await seedSources();
    const reader = createReader(fixture, blobs);

    const mira = await context(
      fixture.authorization,
      "user-mira",
      TIDEPATH,
      "corr-author-read",
    );
    const own = await reader.read(mira, "source-with-photos", "attachment-1");
    expect(own.ok).toBe(true);

    const sol = await context(
      fixture.authorization,
      "user-sol",
      TIDEPATH,
      "corr-other-read",
    );
    const denied = await reader.read(sol, "source-with-photos", "attachment-1");
    expect(errorOf(denied).code).toBe("NOT_FOUND");
  });

  it("returns NOT_FOUND for Harbor staff reading Tidepath attachments", async () => {
    // Only Tidepath holds a source with this identity in this test.
    const blobs = new Map<string, Uint8Array>([
      ["private/tidepath-photo.png", tidepathBytes],
    ]);
    const mira = await context(
      fixture.authorization,
      "user-mira",
      TIDEPATH,
      "corr-src-only",
    );
    expect(
      (
        await repository.accept(
          mira,
          envelopeFor(
            TIDEPATH,
            "tidepath-mira",
            "Mira",
            tidepathBytes,
            "private/tidepath-photo.png",
          ),
        )
      ).ok,
    ).toBe(true);
    const reader = createReader(fixture, blobs);
    const ive = await context(
      fixture.authorization,
      "user-ive",
      HARBOR,
      "corr-harbor-staff",
    );
    const result = await reader.read(ive, "source-with-photos", "attachment-1");
    expect(errorOf(result).code).toBe("NOT_FOUND");
  });

  it("returns each tenant's own bytes for identical attachment ids", async () => {
    const blobs = await seedSources();
    const reader = createReader(fixture, blobs);

    const kai = await context(
      fixture.authorization,
      "user-kai",
      TIDEPATH,
      "corr-t-read",
    );
    const tidepathRead = await reader.read(
      kai,
      "source-with-photos",
      "attachment-1",
    );
    expect(tidepathRead.ok && tidepathRead.value.bytes).toEqual(tidepathBytes);

    const ive = await context(
      fixture.authorization,
      "user-ive",
      HARBOR,
      "corr-h-read",
    );
    const harborRead = await reader.read(
      ive,
      "source-with-photos",
      "attachment-1",
    );
    expect(harborRead.ok && harborRead.value.bytes).toEqual(harborBytes);
  });

  it("denies report-readers and system actors before any blob read", async () => {
    const blobs = await seedSources();
    const calls: string[] = [];
    const reader = createReader(fixture, blobs, calls);

    const ren = await context(
      fixture.authorization,
      "user-ren",
      TIDEPATH,
      "corr-reader-deny",
    );
    expect(
      errorOf(await reader.read(ren, "source-with-photos", "attachment-1"))
        .code,
    ).toBe("FORBIDDEN");
    expect(
      errorOf(
        await reader.read(
          systemContext(TIDEPATH),
          "source-with-photos",
          "attachment-1",
        ),
      ).code,
    ).toBe("FORBIDDEN");
    expect(calls).toHaveLength(0);
  });

  it("maps a missing blob and a digest mismatch to DEPENDENCY_UNAVAILABLE", async () => {
    const blobs = await seedSources();
    const kai = await context(
      fixture.authorization,
      "user-kai",
      TIDEPATH,
      "corr-integrity",
    );

    const empty = createReader(fixture, new Map());
    const missing = await empty.read(kai, "source-with-photos", "attachment-1");
    const missingError = errorOf(missing);
    expect(missingError.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(missingError.retryable).toBe(true);

    blobs.set("private/tidepath-photo.png", new Uint8Array([1, 2, 3]));
    const tampered = createReader(fixture, blobs);
    const mismatch = await tampered.read(
      kai,
      "source-with-photos",
      "attachment-1",
    );
    const mismatchError = errorOf(mismatch);
    expect(mismatchError.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(mismatchError.retryable).toBe(false);
  });
});
