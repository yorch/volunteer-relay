CREATE TABLE "delivery_attempt" (
	"organization_id" text NOT NULL,
	"job_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"accepted" boolean NOT NULL,
	"provider_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "delivery_attempt_organization_id_job_id_attempt_pk" PRIMARY KEY("organization_id","job_id","attempt")
);
--> statement-breakpoint
CREATE TABLE "delivery_job" (
	"organization_id" text NOT NULL,
	"id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"channel" text NOT NULL,
	"delivery_key" text NOT NULL,
	"template" text NOT NULL,
	"app_path" text NOT NULL,
	"need_id" text NOT NULL,
	"need_deadline" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"retry_after" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"provider_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "delivery_job_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "delivery_job_organization_id_delivery_key_unique" UNIQUE("organization_id","delivery_key"),
	CONSTRAINT "delivery_channel_check" CHECK ("delivery_job"."channel" in ('email','telegram')),
	CONSTRAINT "delivery_attempts_check" CHECK ("delivery_job"."attempts" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "follow_through_command" (
	"organization_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"operation" text NOT NULL,
	"digest" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_through_command_organization_id_idempotency_key_pk" PRIMARY KEY("organization_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "in_app_notification" (
	"organization_id" text NOT NULL,
	"id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"type" text NOT NULL,
	"need_id" text NOT NULL,
	"title" text NOT NULL,
	"app_path" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "in_app_notification_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "in_app_notification_organization_id_recipient_id_dedupe_key_unique" UNIQUE("organization_id","recipient_id","dedupe_key"),
	CONSTRAINT "notification_type_check" CHECK ("in_app_notification"."type" in ('need-assigned','need-overdue'))
);
--> statement-breakpoint
CREATE TABLE "need_escalation" (
	"organization_id" text NOT NULL,
	"need_id" text NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"level" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "need_escalation_organization_id_need_id_deadline_level_pk" PRIMARY KEY("organization_id","need_id","deadline","level")
);
--> statement-breakpoint
CREATE TABLE "notification_event" (
	"organization_id" text NOT NULL,
	"event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_event_organization_id_event_id_pk" PRIMARY KEY("organization_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "notification_preference" (
	"organization_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"email" boolean DEFAULT false NOT NULL,
	"telegram" boolean DEFAULT false NOT NULL,
	CONSTRAINT "notification_preference_organization_id_membership_id_pk" PRIMARY KEY("organization_id","membership_id")
);
--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"timezone" text NOT NULL,
	"automation_policy" text NOT NULL,
	"policy_version" text NOT NULL,
	"routing" jsonb NOT NULL,
	"fallback_membership_id" text,
	"ack_minutes" integer NOT NULL,
	"retention_days" integer NOT NULL,
	CONSTRAINT "settings_revision_check" CHECK ("organization_settings"."revision">0),
	CONSTRAINT "settings_policy_check" CHECK ("organization_settings"."automation_policy" in ('review-all','validated-auto-record')),
	CONSTRAINT "settings_ack_check" CHECK ("organization_settings"."ack_minutes" between 1 and 10080),
	CONSTRAINT "settings_retention_check" CHECK ("organization_settings"."retention_days" between 1 and 3650)
);
--> statement-breakpoint
CREATE TABLE "telegram_identity" (
	"identity" text NOT NULL,
	"organization_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "telegram_identity_identity_organization_id_pk" PRIMARY KEY("identity","organization_id"),
	CONSTRAINT "telegram_identity_organization_id_membership_id_unique" UNIQUE("organization_id","membership_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_link_token" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_selection" (
	"identity" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_attempt" ADD CONSTRAINT "delivery_attempt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_job" ADD CONSTRAINT "delivery_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_through_command" ADD CONSTRAINT "follow_through_command_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "in_app_notification" ADD CONSTRAINT "in_app_notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "need_escalation" ADD CONSTRAINT "need_escalation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_event" ADD CONSTRAINT "notification_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_identity" ADD CONSTRAINT "telegram_identity_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_link_token" ADD CONSTRAINT "telegram_link_token_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_selection" ADD CONSTRAINT "telegram_selection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER follow_through_command_immutable BEFORE UPDATE ON follow_through_command FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
--> statement-breakpoint
CREATE TRIGGER delivery_attempt_immutable BEFORE UPDATE ON delivery_attempt FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
--> statement-breakpoint
CREATE TRIGGER need_escalation_immutable BEFORE UPDATE ON need_escalation FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
