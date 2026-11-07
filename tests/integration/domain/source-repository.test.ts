import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ApiError,
  Result,
  SourceEnvelope,
  TenantContext,
} from "../../../packages/contracts/src/index.ts";
import {
  and,
  createMembershipReader,
  createSourceStore,
  type Database,
  eq,
  schema,
  seedOrganizations,
  sql,
} from "../../../packages/db/src/index.ts";
import { createAuthorizationService } from "../../../packages/domain/auth/src/index.ts";
import { createSourceRepository } from "../../../packages/domain/core/src/sources/index.ts";
import { openTestDatabase, resetAuthTables } from "../auth/support.ts";

const {
  member,
  outboxEvent,
  sourceAttachmentIdentity,
  sourceAuthor,
  sourceRevision,
} = schema;

let db: Database;
let close: () => Promise<void>;
let store: ReturnType<typeof createSourceStore>;
let authorization: ReturnType<typeof createAuthorizationService>;
let repository: ReturnType<typeof createSourceRepository>;

const organizationId = "tidepath";
const otherOrganizationId = "harbor";

function envelope(overrides: Partial<SourceEnvelope> = {}): SourceEnvelope {
  return {
    schemaVersion: 1,
    organizationId,
    sourceId: "source-test-1",
    revision: 1,
    channel: "web",
    channelIdentity: "web-tidepath",
    externalMessageId: "external-1",
    idempotencyKey: "idem-1",
    author: { externalIdentity: "Mira", membershipId: "tidepath-mira" },
    occurredAt: "2026-11-04T15:00:00Z",
    receivedAt: "2026-11-04T15:01:00Z",
    timezone: "America/New_York",
    text: "Synthetic source text for tenant isolation coverage.",
    attachments: [],
    replyToSourceId: null,
    replacesRevision: null,
    original: {
      mediaType: "text/plain",
      payload: "Synthetic source text for tenant isolation coverage.",
    },
    ...overrides,
  };
}

async function context(
  userId: string,
  organization: string,
  correlationId: string,
) {
  const resolved = await authorization.resolve(
    userId,
    organization,
    correlationId,
  );
  if (!resolved.ok) throw new Error(`context failed: ${resolved.error.code}`);
  return resolved.value;
}

async function counts() {
  const result = await db.execute(
    sql`select
      (select count(*)::int from source) as sources,
      (select count(*)::int from source_revision) as revisions,
      (select count(*)::int from source_attachment) as attachments,
      (select count(*)::int from outbox_event) as events`,
  );
  return result.rows[0] as {
    sources: number;
    revisions: number;
    attachments: number;
    events: number;
  };
}

function errorOf<T>(result: Result<T>): ApiError["error"] {
  if (result.ok) throw new Error("expected a failure result");
  return result.error;
}

beforeAll(async () => {
  const opened = await openTestDatabase();
  db = opened.db;
  close = opened.close;
  authorization = createAuthorizationService({
    memberships: createMembershipReader(db),
  });
  store = createSourceStore(db);
  repository = createSourceRepository({ authorization, store });
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await resetAuthTables(db);
  await seedOrganizations(db);
});

describe("accept: idempotent, atomic source persistence", () => {
  it("persists one revision and one outbox event for a volunteer's own submission", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-accept");

    const result = await repository.accept(volunteer, envelope());
    expect(result).toEqual({
      ok: true,
      value: {
        sourceId: "source-test-1",
        revision: 1,
        status: "received",
        correlationId: "corr-accept",
      },
    });

    expect(await counts()).toEqual({
      sources: 1,
      revisions: 1,
      attachments: 0,
      events: 1,
    });

    const [event] = await db
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.organizationId, organizationId));
    expect(event?.type).toBe("source.received");
    expect(event?.aggregateId).toBe("source-test-1");
    expect(event?.aggregateRevision).toBe(1);
    expect(event?.correlationId).toBe("corr-accept");
    expect(event?.dispatchedAt).toBeNull();
    expect(event?.payload).toEqual({
      sourceId: "source-test-1",
      sourceRevision: 1,
    });
    expect(event?.actor).toEqual(volunteer.actor);
  });

  it("returns the original receipt for an identical replay without new effects", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-first");
    const source = envelope();
    const first = await repository.accept(volunteer, source);
    expect(first.ok).toBe(true);

    // Same validated envelope, different caller correlation.
    const retry = await context("user-mira", organizationId, "corr-retry");
    const replay = await repository.accept(retry, source);
    expect(replay).toEqual({
      ok: true,
      value: {
        sourceId: "source-test-1",
        revision: 1,
        status: "received",
        correlationId: "corr-first",
      },
    });

    expect(await counts()).toEqual({
      sources: 1,
      revisions: 1,
      attachments: 0,
      events: 1,
    });
  });

  it("rejects a changed payload under the same idempotency key as CONFLICT", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-x");
    await repository.accept(volunteer, envelope());

    const changed = envelope({ text: "Different synthetic text, same key." });
    const result = await repository.accept(volunteer, changed);
    const error = errorOf(result);
    expect(error.code).toBe("CONFLICT");
    expect(error.message).not.toContain("Different synthetic text");
    expect((await counts()).revisions).toBe(1);
  });

  it("treats a property-order-only difference as the same envelope", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-order");
    await repository.accept(volunteer, envelope());

    const reordered: SourceEnvelope = {
      original: envelope().original,
      replacesRevision: null,
      replyToSourceId: null,
      attachments: [],
      text: envelope().text,
      timezone: "America/New_York",
      receivedAt: "2026-11-04T15:01:00Z",
      occurredAt: "2026-11-04T15:00:00Z",
      author: { membershipId: "tidepath-mira", externalIdentity: "Mira" },
      idempotencyKey: "idem-1",
      externalMessageId: "external-1",
      channelIdentity: "web-tidepath",
      channel: "web",
      revision: 1,
      sourceId: "source-test-1",
      organizationId,
      schemaVersion: 1,
    };
    const result = await repository.accept(volunteer, reordered);
    expect(result).toMatchObject({
      ok: true,
      value: { correlationId: "corr-order" },
    });
    expect((await counts()).revisions).toBe(1);
  });

  it("keeps one revision and one event under concurrent identical accepts", async () => {
    const first = await context("user-mira", organizationId, "corr-c1");
    const second = await context("user-mira", organizationId, "corr-c2");
    const source = envelope();

    const results = await Promise.all([
      repository.accept(first, source),
      repository.accept(second, source),
    ]);

    for (const result of results) {
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.value.revision).toBe(1);
      // One of the two won; both callers see the winner's receipt correlation.
      expect(["corr-c1", "corr-c2"]).toContain(result.value.correlationId);
    }
    const correlations = new Set(
      results.map((result) => (result.ok ? result.value.correlationId : null)),
    );
    expect(correlations.size).toBe(1);

    expect(await counts()).toEqual({
      sources: 1,
      revisions: 1,
      attachments: 0,
      events: 1,
    });
  });

  it("leaves neither side persisted when the revision insert is rejected", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-fail");
    const duplicateAttachments = envelope({
      attachments: [
        {
          id: "attachment-dup",
          organizationId,
          storageKey: "private/first.png",
          sha256: "c".repeat(64),
          mimeType: "image/png",
          bytes: 10,
        },
        {
          id: "attachment-dup",
          organizationId,
          storageKey: "private/second.png",
          sha256: "d".repeat(64),
          mimeType: "image/png",
          bytes: 11,
        },
      ],
    });

    const result = await repository.accept(volunteer, duplicateAttachments);
    expect(result.ok).toBe(false);
    // The revision row and its outbox event were rolled back together.
    expect(await counts()).toEqual({
      sources: 0,
      revisions: 0,
      attachments: 0,
      events: 0,
    });
  });

  it("conceals a cross-tenant envelope and persists nothing", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-tenant");
    const result = await repository.accept(
      volunteer,
      envelope({ organizationId: otherOrganizationId }),
    );
    const error = errorOf(result);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("Organization not available");
    expect((await counts()).revisions).toBe(0);
  });

  it("rejects an author membership from another organization", async () => {
    const owner = await context("user-rae", organizationId, "corr-author");
    const result = await repository.accept(
      owner,
      envelope({
        author: { externalIdentity: "Nico", membershipId: "harbor-nico" },
      }),
    );
    const error = errorOf(result);
    expect(error.code).toBe("VALIDATION");
    expect(error.fields?.author?.length).toBe(1);
    expect((await counts()).revisions).toBe(0);
  });

  it("rejects a reply target outside the tenant", async () => {
    const owner = await context("user-rae", organizationId, "corr-reply");
    const result = await repository.accept(
      owner,
      envelope({
        sourceId: "source-reply",
        externalMessageId: "external-reply",
        idempotencyKey: "idem-reply",
        replyToSourceId: "source-does-not-exist",
      }),
    );
    expect(errorOf(result).code).toBe("VALIDATION");
    expect((await counts()).revisions).toBe(0);
  });

  it("keeps an attachment's tenant and revision linkage", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-attach");
    const result = await repository.accept(
      volunteer,
      envelope({
        attachments: [
          {
            id: "attachment-1",
            organizationId,
            storageKey: "private/synthetic.png",
            sha256: "a".repeat(64),
            mimeType: "image/png",
            bytes: 68,
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);

    const rows = await db.execute(
      sql`select a.organization_id, a.source_id, a.revision, i.sha256
          from source_attachment a
          join source_attachment_identity i
            on i.organization_id = a.organization_id
           and i.source_id = a.source_id
           and i.attachment_id = a.attachment_id`,
    );
    expect(rows.rows).toEqual([
      {
        organization_id: organizationId,
        source_id: "source-test-1",
        revision: 1,
        sha256: "a".repeat(64),
      },
    ]);
  });
});

describe("accept: revision sequence and stable identity", () => {
  it("appends sequential revisions and preserves history", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-r1");
    const first = await repository.accept(volunteer, envelope());
    expect(first.ok).toBe(true);

    const second = await repository.accept(
      volunteer,
      envelope({
        revision: 2,
        replacesRevision: 1,
        idempotencyKey: "idem-2",
        text: "Revised synthetic source text.",
        receivedAt: "2026-11-04T15:05:00Z",
      }),
    );
    expect(second).toMatchObject({ ok: true, value: { revision: 2 } });

    const revisions = await db
      .select({
        revision: sourceRevision.revision,
        text: sourceRevision.textBody,
      })
      .from(sourceRevision)
      .where(eq(sourceRevision.sourceId, "source-test-1"))
      .orderBy(sourceRevision.revision);
    expect(revisions.map((row) => row.revision)).toEqual([1, 2]);
    expect(revisions[1]?.text).toBe("Revised synthetic source text.");

    expect((await counts()).events).toBe(2);
  });

  it("rejects a gapped or stale replacement", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-gap");
    await repository.accept(volunteer, envelope());

    const gapped = await repository.accept(
      volunteer,
      envelope({
        revision: 3,
        replacesRevision: 2,
        idempotencyKey: "idem-gap",
      }),
    );
    expect(errorOf(gapped).code).toBe("CONFLICT");

    const duplicateFirst = await repository.accept(
      volunteer,
      envelope({ idempotencyKey: "idem-first-again" }),
    );
    expect(errorOf(duplicateFirst).code).toBe("CONFLICT");
    expect((await counts()).revisions).toBe(1);
  });

  it("rejects a revision that changes the stable channel identity", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-stable");
    await repository.accept(volunteer, envelope());

    const drifted = await repository.accept(
      volunteer,
      envelope({
        revision: 2,
        replacesRevision: 1,
        idempotencyKey: "idem-2",
        externalMessageId: "external-changed",
      }),
    );
    expect(errorOf(drifted).code).toBe("CONFLICT");
    expect((await counts()).revisions).toBe(1);
  });

  it("keeps a source id independent per tenant", async () => {
    const tidepathOwner = await context("user-rae", organizationId, "corr-a");
    const harborVolunteer = await context(
      "user-nico",
      otherOrganizationId,
      "corr-b",
    );

    const first = await repository.accept(tidepathOwner, envelope());
    const second = await repository.accept(
      harborVolunteer,
      envelope({
        organizationId: otherOrganizationId,
        author: { externalIdentity: "Nico", membershipId: "harbor-nico" },
      }),
    );

    expect(first.ok).toBe(true);
    // Same sourceId, different tenant: a separate identity, not a conflict.
    expect(second.ok).toBe(true);
    expect((await counts()).sources).toBe(2);
  });
});

describe("authorization boundaries", () => {
  it("denies a volunteer submitting as another author", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-own");
    const result = await repository.accept(
      volunteer,
      envelope({
        author: { externalIdentity: "Sol", membershipId: "tidepath-sol" },
      }),
    );
    const error = errorOf(result);
    expect(error.code).toBe("FORBIDDEN");
    expect((await counts()).revisions).toBe(0);
  });

  it("denies an unmapped external author to a volunteer", async () => {
    const volunteer = await context(
      "user-mira",
      organizationId,
      "corr-unmapped",
    );
    const result = await repository.accept(
      volunteer,
      envelope({
        author: { externalIdentity: "Anonymous", membershipId: null },
      }),
    );
    expect(errorOf(result).code).toBe("FORBIDDEN");
  });

  it("lets staff submit for a mapped member or an unmapped author", async () => {
    const coordinator = await context("user-rae", organizationId, "corr-staff");
    const mapped = await repository.accept(
      coordinator,
      envelope({
        author: { externalIdentity: "Sol", membershipId: "tidepath-sol" },
      }),
    );
    expect(mapped.ok).toBe(true);

    const unmapped = await repository.accept(
      coordinator,
      envelope({
        sourceId: "source-unmapped",
        externalMessageId: "external-unmapped",
        idempotencyKey: "idem-unmapped",
        author: { externalIdentity: "Anonymous", membershipId: null },
      }),
    );
    expect(unmapped.ok).toBe(true);
  });

  it("denies report-readers and system actors submission", async () => {
    const reader = await context(
      "user-rae",
      otherOrganizationId,
      "corr-reader",
    );
    const submission = envelope({
      organizationId: otherOrganizationId,
      author: { externalIdentity: "Nico", membershipId: "harbor-nico" },
    });
    expect(errorOf(await repository.accept(reader, submission)).code).toBe(
      "FORBIDDEN",
    );

    const systemContext: TenantContext = {
      organizationId,
      actor: { kind: "system", service: "worker" },
      correlationId: "corr-system",
    };
    expect(
      errorOf(await repository.accept(systemContext, envelope())).code,
    ).toBe("FORBIDDEN");
    expect((await counts()).revisions).toBe(0);
  });

  it("re-checks live membership before returning a replay", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-live");
    const source = envelope();
    expect((await repository.accept(volunteer, source)).ok).toBe(true);

    await db
      .delete(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.id, "tidepath-mira"),
        ),
      );

    const error = errorOf(await repository.accept(volunteer, source));
    expect(error.code).toBe("FORBIDDEN");
    expect((await counts()).revisions).toBe(1);
  });
});

describe("get: evidence access", () => {
  beforeEach(async () => {
    const volunteer = await context("user-mira", organizationId, "corr-seed");
    await repository.accept(
      volunteer,
      envelope({
        attachments: [
          {
            id: "attachment-1",
            organizationId,
            storageKey: "private/synthetic.png",
            sha256: "b".repeat(64),
            mimeType: "image/png",
            bytes: 68,
          },
        ],
      }),
    );
  });

  it("returns the stored envelope for staff with review authority", async () => {
    const owner = await context("user-rae", organizationId, "corr-read");
    const result = await repository.get(owner, "source-test-1", 1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected envelope");
    expect(result.value.organizationId).toBe(organizationId);
    expect(result.value.author).toEqual({
      externalIdentity: "Mira",
      membershipId: "tidepath-mira",
    });
    expect(result.value.attachments).toEqual([
      {
        id: "attachment-1",
        organizationId,
        storageKey: "private/synthetic.png",
        sha256: "b".repeat(64),
        mimeType: "image/png",
        bytes: 68,
      },
    ]);
    // The accepted envelope is preserved verbatim, offset and all.
    expect(result.value.receivedAt).toBe("2026-11-04T15:01:00Z");
    expect(result.value.occurredAt).toBe("2026-11-04T15:00:00Z");
  });

  it("lets a volunteer read only their own submission", async () => {
    const own = await context("user-mira", organizationId, "corr-own-read");
    expect((await repository.get(own, "source-test-1", 1)).ok).toBe(true);

    const other = await context("user-sol", organizationId, "corr-other-read");
    const denied = await repository.get(other, "source-test-1", 1);
    // Someone else's source is concealed exactly like an unknown one.
    expect(errorOf(denied).code).toBe("NOT_FOUND");
    expect(errorOf(denied).message).toBe("Source revision not found");
  });

  it("denies report-readers and system actors any evidence", async () => {
    const reader = await context(
      "user-rae",
      otherOrganizationId,
      "corr-no-evidence",
    );
    const readerResult = await repository.get(reader, "source-test-1", 1);
    expect(errorOf(readerResult).code).toBe("FORBIDDEN");

    const systemContext: TenantContext = {
      organizationId,
      actor: { kind: "system", service: "scheduler" },
      correlationId: "corr-system-read",
    };
    expect(
      errorOf(await repository.get(systemContext, "source-test-1", 1)).code,
    ).toBe("FORBIDDEN");
  });

  it("conceals unknown revisions and cross-tenant source ids", async () => {
    const owner = await context("user-rae", organizationId, "corr-missing");
    const missing = await repository.get(owner, "source-test-1", 2);
    expect(errorOf(missing).code).toBe("NOT_FOUND");
    expect(errorOf(missing).message).toBe("Source revision not found");

    // A harbor volunteer asking for a tidepath source id gets no hint it exists.
    const harborVolunteer = await context(
      "user-nico",
      otherOrganizationId,
      "corr-cross",
    );
    const cross = await repository.get(harborVolunteer, "source-test-1", 1);
    expect(errorOf(cross).code).toBe("NOT_FOUND");
  });

  it("denies reads after the reader's membership is revoked", async () => {
    const owner = await context("user-rae", organizationId, "corr-revoked");
    expect((await repository.get(owner, "source-test-1", 1)).ok).toBe(true);

    await db
      .delete(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.id, "tidepath-rae"),
        ),
      );

    expect(errorOf(await repository.get(owner, "source-test-1", 1)).code).toBe(
      "FORBIDDEN",
    );
  });
});

describe("historical authorship and revocation", () => {
  it("preserves the accepted evidence when the author's membership is deleted", async () => {
    const volunteer = await context(
      "user-mira",
      organizationId,
      "corr-before-revoke",
    );
    const source = envelope();
    expect((await repository.accept(volunteer, source)).ok).toBe(true);

    const staff = await context(
      "user-rae",
      organizationId,
      "corr-staff-history",
    );
    const before = await repository.get(staff, "source-test-1", 1);
    if (!before.ok) throw new Error("expected evidence");

    // Row deletion is the P1-01 revocation representation.
    await db
      .delete(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.id, "tidepath-mira"),
        ),
      );

    // The historical anchor keeps the recorded author and only clears the live pointer.
    const [anchor] = await db
      .select()
      .from(sourceAuthor)
      .where(eq(sourceAuthor.membershipId, "tidepath-mira"));
    expect(anchor?.membershipId).toBe("tidepath-mira");
    expect(anchor?.currentMembershipId).toBeNull();

    const [revision] = await db
      .select()
      .from(sourceRevision)
      .where(eq(sourceRevision.sourceId, "source-test-1"));
    expect(revision?.authorMembershipId).toBe("tidepath-mira");
    expect(revision?.envelope.author.membershipId).toBe("tidepath-mira");
    expect(revision?.textBody).toBe(source.text);

    // Staff still see exactly the accepted evidence.
    const after = await repository.get(staff, "source-test-1", 1);
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error("expected evidence");
    expect(after.value).toEqual(before.value);

    // The revoked author can neither read nor resubmit.
    expect(
      errorOf(await repository.get(volunteer, "source-test-1", 1)).code,
    ).toBe("FORBIDDEN");
    expect(errorOf(await repository.accept(volunteer, source)).code).toBe(
      "FORBIDDEN",
    );
    expect((await counts()).revisions).toBe(1);
  });

  it("loses staff evidence access when the role is downgraded", async () => {
    const volunteer = await context(
      "user-mira",
      organizationId,
      "corr-seed-downgrade",
    );
    await repository.accept(volunteer, envelope());

    const staff = await context(
      "user-rae",
      organizationId,
      "corr-staff-downgrade",
    );
    expect((await repository.get(staff, "source-test-1", 1)).ok).toBe(true);

    await db
      .update(member)
      .set({ role: "volunteer" })
      .where(eq(member.id, "tidepath-rae"));

    // No review authority any more, and this source belongs to another author.
    expect(errorOf(await repository.get(staff, "source-test-1", 1)).code).toBe(
      "NOT_FOUND",
    );
  });
});

describe("immutability and evidence preservation", () => {
  it("keeps an attachment's identity immutable across revisions", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-att-r1");
    const attachment = {
      id: "attachment-stable",
      organizationId,
      storageKey: "private/stable.png",
      sha256: "e".repeat(64),
      mimeType: "image/png" as const,
      bytes: 32,
    };
    expect(
      (
        await repository.accept(
          volunteer,
          envelope({ attachments: [attachment] }),
        )
      ).ok,
    ).toBe(true);

    // Same id and metadata on a later revision is allowed.
    const sameIdentity = await repository.accept(
      volunteer,
      envelope({
        revision: 2,
        replacesRevision: 1,
        idempotencyKey: "idem-r2",
        attachments: [attachment],
      }),
    );
    expect(sameIdentity.ok).toBe(true);

    // The same id with different metadata in another revision is rejected.
    const mutated = await repository.accept(
      volunteer,
      envelope({
        revision: 3,
        replacesRevision: 2,
        idempotencyKey: "idem-r3",
        attachments: [{ ...attachment, sha256: "f".repeat(64) }],
      }),
    );
    expect(errorOf(mutated).code).toBe("CONFLICT");
    expect(errorOf(mutated).message).toBe(
      "Attachment identity does not match its stored metadata",
    );

    const identities = await db.select().from(sourceAttachmentIdentity);
    expect(identities).toHaveLength(1);
    expect(identities[0]?.sha256).toBe("e".repeat(64));
  });

  it("rejects direct rewrites of source evidence but allows dispatch metadata", async () => {
    const volunteer = await context(
      "user-mira",
      organizationId,
      "corr-immutable",
    );
    await repository.accept(volunteer, envelope());

    await expect(
      db.execute(
        sql`update source_revision set text_body = 'rewritten' where source_id = 'source-test-1'`,
      ),
    ).rejects.toThrow();

    const [revision] = await db
      .select({ text: sourceRevision.textBody })
      .from(sourceRevision)
      .where(eq(sourceRevision.sourceId, "source-test-1"));
    expect(revision?.text).toBe(envelope().text);

    // Outbox dispatch metadata is mutable (no dispatch happens in this slice).
    await db.execute(
      sql`update outbox_event set dispatched_at = now() where aggregate_id = 'source-test-1'`,
    );
    const [event] = await db
      .select({ dispatchedAt: outboxEvent.dispatchedAt })
      .from(outboxEvent)
      .where(eq(outboxEvent.aggregateId, "source-test-1"));
    expect(event?.dispatchedAt).not.toBeNull();
  });
});

describe("same identity across tenants", () => {
  it("accepts the same sourceId, externalMessageId and key in two tenants", async () => {
    const tidepath = await context("user-rae", organizationId, "corr-t1");
    const harbor = await context("user-nico", otherOrganizationId, "corr-t2");
    const shared = {
      sourceId: "source-shared",
      externalMessageId: "external-shared",
      idempotencyKey: "idem-shared",
    };

    const first = await repository.accept(tidepath, envelope(shared));
    const second = await repository.accept(
      harbor,
      envelope({
        ...shared,
        organizationId: otherOrganizationId,
        author: { externalIdentity: "Nico", membershipId: "harbor-nico" },
      }),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const stats = await counts();
    expect(stats.revisions).toBe(2);
    expect(stats.events).toBe(2);
    expect(stats.sources).toBe(2);

    // Each tenant resolves the shared id to its own revision.
    const tidepathRead = await repository.get(tidepath, "source-shared", 1);
    if (!tidepathRead.ok) throw new Error("expected tidepath evidence");
    expect(tidepathRead.value.author.membershipId).toBe("tidepath-mira");
    expect(tidepathRead.value.text).toBe(envelope().text);

    const harborRead = await repository.get(harbor, "source-shared", 1);
    if (!harborRead.ok) throw new Error("expected harbor evidence");
    expect(harborRead.value.organizationId).toBe(otherOrganizationId);
    expect(harborRead.value.author.membershipId).toBe("harbor-nico");

    // A tenant with no such source still gets concealment, not a cross-tenant row.
    const harborOnlyId = await repository.get(tidepath, "harbor-only", 1);
    expect(errorOf(harborOnlyId).code).toBe("NOT_FOUND");
  });
});

describe("revision lineage (review corrections)", () => {
  it("rejects a null predecessor on a later revision as CONFLICT", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-null");
    await repository.accept(volunteer, envelope());

    const nullPredecessor = await repository.accept(
      volunteer,
      envelope({ revision: 2, idempotencyKey: "idem-null-pred" }),
    );
    const error = errorOf(nullPredecessor);
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toBe(
      "Source revision is not the next revision for this source",
    );
    expect((await counts()).revisions).toBe(1);

    // The database constraint also rejects a NULL predecessor, not only equality.
    await expect(
      db.execute(
        sql`insert into source_revision
              (organization_id, source_id, revision, channel, channel_identity,
               external_message_id, idempotency_key, author_external_identity,
               received_at, timezone, text_body, original_media_type,
               original_payload, canonical_digest, envelope, correlation_id)
            values (${organizationId}, 'source-test-1', 2, 'web', 'web-tidepath',
                    'external-null', 'idem-null-db', 'Mira', now(), 'UTC', 'text',
                    'text/plain', 'text', 'digest', '{}'::jsonb, 'corr-db')`,
      ),
    ).rejects.toThrow();
  });

  it("rejects a wrong or skipped predecessor as CONFLICT", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-wrong");
    await repository.accept(volunteer, envelope());
    await repository.accept(
      volunteer,
      envelope({
        revision: 2,
        replacesRevision: 1,
        idempotencyKey: "idem-r2",
      }),
    );

    const skipped = await repository.accept(
      volunteer,
      envelope({
        revision: 4,
        replacesRevision: 3,
        idempotencyKey: "idem-r4",
      }),
    );
    expect(errorOf(skipped).code).toBe("CONFLICT");

    const wrong = await repository.accept(
      volunteer,
      envelope({
        revision: 3,
        replacesRevision: 1,
        idempotencyKey: "idem-r3-wrong",
      }),
    );
    expect(errorOf(wrong).code).toBe("CONFLICT");
    expect((await counts()).revisions).toBe(2);
  });
});

describe("typed sanitized storage failures", () => {
  it("maps a self-reply to VALIDATION without leaking source text", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-self");
    const source = envelope({
      replyToSourceId: "source-test-1",
      sourceId: "source-test-1",
      text: "SECRET-SYNTHETIC-SOURCE-TEXT",
    });

    const result = await repository.accept(volunteer, source);
    const error = errorOf(result);
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toBe("A source cannot reply to itself");
    expect(error.retryable).toBe(false);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET-SYNTHETIC-SOURCE-TEXT");
    expect(serialized.toLowerCase()).not.toContain("violates");
    expect(serialized.toLowerCase()).not.toContain("constraint");
    expect((await counts()).revisions).toBe(0);
  });

  it("keeps a generic retryable failure free of driver detail", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-driver");
    // A store that throws a driver-shaped error must not surface its message.
    const throwingStore = {
      async insertRevision() {
        throw Object.assign(new Error("secret driver detail SECRET-TEXT"), {
          code: "XX000",
          detail: "Key (text)=(SECRET-TEXT)",
        });
      },
      async findRevision() {
        return null;
      },
    };
    const isolated = createSourceRepository({
      authorization,
      store: throwingStore,
    });
    const result = await isolated.accept(volunteer, envelope());
    const error = errorOf(result);
    expect(error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET-TEXT");
  });
});

describe("authorized replay after the historical author left", () => {
  it("returns the original receipt to staff while denying the removed author", async () => {
    const volunteer = await context(
      "user-mira",
      organizationId,
      "corr-original",
    );
    const source = envelope();
    expect((await repository.accept(volunteer, source)).ok).toBe(true);

    await db
      .delete(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.id, "tidepath-mira"),
        ),
      );

    // Still-authorized staff replaying the identical envelope gets the receipt.
    const staff = await context(
      "user-rae",
      organizationId,
      "corr-staff-replay",
    );
    const replay = await repository.accept(staff, source);
    expect(replay).toEqual({
      ok: true,
      value: {
        sourceId: "source-test-1",
        revision: 1,
        status: "received",
        correlationId: "corr-original",
      },
    });

    // A revoked caller is still denied, and a new mapped-author acceptance fails.
    expect(errorOf(await repository.accept(volunteer, source)).code).toBe(
      "FORBIDDEN",
    );
    const newSource = envelope({
      sourceId: "source-after-removal",
      externalMessageId: "external-after",
      idempotencyKey: "idem-after",
    });
    expect(errorOf(await repository.accept(staff, newSource)).code).toBe(
      "VALIDATION",
    );
    expect((await counts()).revisions).toBe(1);
  });
});

describe("tenant-scoped identity hardening", () => {
  it("rejects a live author pointer that names another tenant's membership", async () => {
    await expect(
      db.execute(
        sql`insert into source_author (organization_id, membership_id, current_membership_id)
            values (${organizationId}, 'cross-tenant-pointer', 'harbor-nico')`,
      ),
    ).rejects.toThrow();
  });

  it("allows the same outbox event id in two tenants", async () => {
    const tidepath = await context("user-rae", organizationId, "corr-outbox-a");
    const harbor = await context(
      "user-nico",
      otherOrganizationId,
      "corr-outbox-b",
    );
    await repository.accept(
      tidepath,
      envelope({
        sourceId: "source-outbox-a",
        externalMessageId: "external-outbox-a",
        idempotencyKey: "idem-outbox-a",
      }),
    );
    await repository.accept(
      harbor,
      envelope({
        organizationId: otherOrganizationId,
        sourceId: "source-outbox-b",
        externalMessageId: "external-outbox-b",
        idempotencyKey: "idem-outbox-b",
        author: { externalIdentity: "Nico", membershipId: "harbor-nico" },
      }),
    );

    // Event identity is organization-scoped, so one id can exist per tenant.
    // The accept above already produced one event per revision; replace those
    // rows (outbox rows are mutable, unlike evidence) to reuse a single id.
    await db.execute(
      sql`delete from outbox_event where aggregate_id like 'source-outbox-%'`,
    );
    const shared = "evt:shared-identity";
    const aggregates = [
      { organization: organizationId, aggregate: "source-outbox-a" },
      { organization: otherOrganizationId, aggregate: "source-outbox-b" },
    ];
    for (const { organization, aggregate } of aggregates) {
      await db.execute(
        sql`insert into outbox_event
              (organization_id, id, type, aggregate_id, aggregate_revision, payload,
               actor, correlation_id, occurred_at)
            values (${organization}, ${shared}, 'source.received', ${aggregate}, 1,
                    '{}'::jsonb, '{"kind":"system","service":"worker"}'::jsonb,
                    'corr-manual', now())`,
      );
    }
    const rows = await db.execute(
      sql`select organization_id from outbox_event where id = ${shared} order by organization_id`,
    );
    expect(rows.rows.length).toBe(2);
  });

  it("rejects rewrites of attachment revision links", async () => {
    const volunteer = await context("user-mira", organizationId, "corr-links");
    await repository.accept(
      volunteer,
      envelope({
        attachments: [
          {
            id: "attachment-link",
            organizationId,
            storageKey: "private/link.png",
            sha256: "a".repeat(64),
            mimeType: "image/png",
            bytes: 12,
          },
        ],
      }),
    );

    await expect(
      db.execute(
        sql`update source_attachment set revision = revision where source_id = 'source-test-1'`,
      ),
    ).rejects.toThrow();
  });
});
