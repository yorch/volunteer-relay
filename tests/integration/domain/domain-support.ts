import type { TenantContext } from "../../../packages/contracts/src/index.ts";
import {
  createAttachmentMetadataStore,
  createDomainStore,
  createMembershipReader,
  type Database,
  schema,
  sql,
} from "../../../packages/db/src/index.ts";
import { seedOrganizations } from "../../../packages/db/src/seed-data.ts";
import { createAuthorizationService } from "../../../packages/domain/auth/src/index.ts";
import {
  createAttachmentReader,
  createLedgerService,
  createNeedService,
} from "../../../packages/domain/core/src/index.ts";
import { openTestDatabase, resetAuthTables } from "../auth/support.ts";

export const TIDEPATH = "tidepath";
export const HARBOR = "harbor";

// Extra synthetic members on top of seedOrganizations: Tidepath gets a
// coordinator and a report-reader, Harbor a coordinator. All ids are invented
// fixtures, never real people.
const extraUsers = [
  { id: "user-kai", name: "Kai", email: "kai@example.invalid" },
  { id: "user-ren", name: "Ren", email: "ren@example.invalid" },
  { id: "user-ive", name: "Ive", email: "ive@example.invalid" },
];
const extraMemberships = [
  {
    id: "tidepath-kai",
    organizationId: "tidepath",
    userId: "user-kai",
    role: "coordinator",
  },
  {
    id: "tidepath-ren",
    organizationId: "tidepath",
    userId: "user-ren",
    role: "report-reader",
  },
  {
    id: "harbor-ive",
    organizationId: "harbor",
    userId: "user-ive",
    role: "coordinator",
  },
];

export async function seedDomainMembers(db: Database): Promise<void> {
  await db.insert(schema.user).values(extraUsers).onConflictDoNothing();
  await db.insert(schema.member).values(extraMemberships).onConflictDoNothing();
}

export interface DomainFixture {
  db: Database;
  close: () => Promise<void>;
  authorization: ReturnType<typeof createAuthorizationService>;
  store: ReturnType<typeof createDomainStore>;
  ledger: ReturnType<typeof createLedgerService>;
  needs: ReturnType<typeof createNeedService>;
}

export async function openDomainFixture(
  ids?: () => string,
): Promise<DomainFixture> {
  const opened = await openTestDatabase();
  const db = opened.db;
  await resetAuthTables(db);
  await seedOrganizations(db);
  await seedDomainMembers(db);
  const authorization = createAuthorizationService({
    memberships: createMembershipReader(db),
  });
  const store = createDomainStore(db);
  const injected = ids ? { ids } : {};
  const ledger = createLedgerService({ authorization, store, ...injected });
  const needs = createNeedService({ authorization, store, ...injected });
  return { db, close: opened.close, authorization, store, ledger, needs };
}

export async function context(
  authorization: ReturnType<typeof createAuthorizationService>,
  userId: string,
  organizationId: string,
  correlationId: string,
): Promise<TenantContext> {
  const resolved = await authorization.resolve(
    userId,
    organizationId,
    correlationId,
  );
  if (!resolved.ok)
    throw new Error(`context failed for ${userId}: ${resolved.error.code}`);
  return resolved.value;
}

export function systemContext(
  organizationId: string,
  correlationId = "corr-system",
): TenantContext {
  return {
    organizationId,
    actor: { kind: "system", service: "worker" },
    correlationId,
  };
}

export function createReader(
  fixture: DomainFixture,
  blobs: Map<string, Uint8Array>,
  calls: string[] = [],
) {
  return createAttachmentReader({
    authorization: fixture.authorization,
    metadata: createAttachmentMetadataStore(fixture.db),
    blobs: {
      async read(storageKey) {
        calls.push(storageKey);
        return blobs.get(storageKey) ?? null;
      },
    },
  });
}

export const staffOrigin = {
  kind: "staff",
  reason: "Coordinator shift log",
} as const;

export async function auditRows(
  db: Database,
  organizationId: string,
  aggregateType: string,
  aggregateId: string,
) {
  const rows = await db
    .select()
    .from(schema.domainAuditEvent)
    .where(
      sql`${schema.domainAuditEvent.organizationId} = ${organizationId}
        and ${schema.domainAuditEvent.aggregateType} = ${aggregateType}
        and ${schema.domainAuditEvent.aggregateId} = ${aggregateId}`,
    )
    .orderBy(schema.domainAuditEvent.aggregateRevision);
  return rows;
}

export async function outboxRows(
  db: Database,
  organizationId: string,
  type?: string,
) {
  const rows = await db
    .select()
    .from(schema.outboxEvent)
    .where(
      type
        ? sql`${schema.outboxEvent.organizationId} = ${organizationId} and ${schema.outboxEvent.type} = ${type}`
        : sql`${schema.outboxEvent.organizationId} = ${organizationId}`,
    )
    .orderBy(
      schema.outboxEvent.aggregateId,
      schema.outboxEvent.aggregateRevision,
    );
  return rows;
}

export async function tableCounts(db: Database, organizationId: string) {
  const result = await db.execute(sql`
    select
      (select count(*)::int from activity where organization_id = ${organizationId}) as activities,
      (select count(*)::int from contribution where organization_id = ${organizationId}) as contributions,
      (select count(*)::int from need where organization_id = ${organizationId}) as needs,
      (select count(*)::int from domain_audit_event where organization_id = ${organizationId}) as audit,
      (select count(*)::int from domain_command where organization_id = ${organizationId}) as commands,
      (select count(*)::int from outbox_event where organization_id = ${organizationId}) as events
  `);
  return result.rows[0] as {
    activities: number;
    contributions: number;
    needs: number;
    audit: number;
    commands: number;
    events: number;
  };
}

export function onlyContribution<
  T extends { contributions: Array<{ contributionId: string }> },
>(recorded: T): T["contributions"][number] {
  const contribution = recorded.contributions[0];
  if (!contribution) throw new Error("expected a contribution");
  return contribution;
}
