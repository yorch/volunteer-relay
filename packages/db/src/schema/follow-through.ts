import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";

const time = (name: string) => timestamp(name, { withTimezone: true });
export const organizationSettings = pgTable(
  "organization_settings",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    timezone: text("timezone").notNull(),
    automationPolicy: text("automation_policy").notNull(),
    policyVersion: text("policy_version").notNull(),
    routing: jsonb("routing").notNull(),
    fallbackMembershipId: text("fallback_membership_id"),
    ackMinutes: integer("ack_minutes").notNull(),
    retentionDays: integer("retention_days").notNull(),
  },
  (t) => [
    check("settings_revision_check", sql`${t.revision}>0`),
    check(
      "settings_policy_check",
      sql`${t.automationPolicy} in ('review-all','validated-auto-record')`,
    ),
    check("settings_ack_check", sql`${t.ackMinutes} between 1 and 10080`),
    check(
      "settings_retention_check",
      sql`${t.retentionDays} between 1 and 3650`,
    ),
  ],
);
export const followThroughCommand = pgTable(
  "follow_through_command",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    operation: text("operation").notNull(),
    digest: text("digest").notNull(),
    result: jsonb("result").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.idempotencyKey] })],
);
export const inAppNotification = pgTable(
  "in_app_notification",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    recipientId: text("recipient_id").notNull(),
    revision: integer("revision").notNull().default(1),
    type: text("type").notNull(),
    needId: text("need_id").notNull(),
    title: text("title").notNull(),
    appPath: text("app_path").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: time("created_at").notNull(),
    readAt: time("read_at"),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique().on(t.organizationId, t.recipientId, t.dedupeKey),
    check(
      "notification_type_check",
      sql`${t.type} in ('need-assigned','need-overdue')`,
    ),
  ],
);
export const notificationEvent = pgTable(
  "notification_event",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.eventId] })],
);
export const notificationPreference = pgTable(
  "notification_preference",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    membershipId: text("membership_id").notNull(),
    email: boolean("email").notNull().default(false),
    telegram: boolean("telegram").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.membershipId] })],
);
export const deliveryJob = pgTable(
  "delivery_job",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    recipientId: text("recipient_id").notNull(),
    channel: text("channel").notNull(),
    deliveryKey: text("delivery_key").notNull(),
    template: text("template").notNull(),
    appPath: text("app_path").notNull(),
    needId: text("need_id").notNull(),
    needDeadline: time("need_deadline"),
    needRevision: integer("need_revision").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseUntil: time("lease_until"),
    retryAfter: time("retry_after"),
    acceptedAt: time("accepted_at"),
    providerId: text("provider_id"),
    createdAt: time("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.id] }),
    unique().on(t.organizationId, t.deliveryKey),
    check("delivery_channel_check", sql`${t.channel} in ('email','telegram')`),
    check("delivery_attempts_check", sql`${t.attempts} between 0 and 3`),
  ],
);
export const deliveryAttempt = pgTable(
  "delivery_attempt",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    jobId: text("job_id").notNull(),
    attempt: integer("attempt").notNull(),
    accepted: boolean("accepted").notNull(),
    providerId: text("provider_id"),
    occurredAt: time("occurred_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.jobId, t.attempt] })],
);
export const telegramLinkToken = pgTable("telegram_link_token", {
  tokenHash: text("token_hash").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  membershipId: text("membership_id").notNull(),
  expiresAt: time("expires_at").notNull(),
  usedAt: time("used_at"),
  revokedAt: time("revoked_at"),
  createdAt: time("created_at").notNull(),
});
export const telegramIdentity = pgTable(
  "telegram_identity",
  {
    identity: text("identity").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    membershipId: text("membership_id").notNull(),
    createdAt: time("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.identity, t.organizationId] }),
    unique().on(t.organizationId, t.membershipId),
  ],
);
export const telegramSelection = pgTable("telegram_selection", {
  identity: text("identity").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  updatedAt: time("updated_at").notNull(),
});
export const needEscalation = pgTable(
  "need_escalation",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    needId: text("need_id").notNull(),
    deadline: time("deadline").notNull(),
    assignmentRevision: integer("assignment_revision").notNull().default(0),
    level: integer("level").notNull(),
    createdAt: time("created_at").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.organizationId,
        t.needId,
        t.deadline,
        t.assignmentRevision,
        t.level,
      ],
    }),
  ],
);
