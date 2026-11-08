CREATE TABLE "activity" (
	"organization_id" text NOT NULL,
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"local_date" date,
	"date_precision" text NOT NULL,
	"beneficiary_reference" text,
	"origin_kind" text NOT NULL,
	"origin_source_id" text,
	"origin_source_revision" integer,
	"origin_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "activity_revision_check" CHECK ("activity"."revision" >= 1),
	CONSTRAINT "activity_date_precision_check" CHECK ("activity"."date_precision" in ('day', 'unknown') and ("activity"."date_precision" = 'day') = ("activity"."local_date" is not null)),
	CONSTRAINT "activity_origin_check" CHECK ((
    ("activity"."origin_kind" = 'source'
      and "activity"."origin_source_id" is not null
      and "activity"."origin_source_revision" is not null
      and "activity"."origin_reason" is null)
    or ("activity"."origin_kind" = 'staff'
      and "activity"."origin_reason" is not null
      and "activity"."origin_source_id" is null
      and "activity"."origin_source_revision" is null)
  ))
);
--> statement-breakpoint
CREATE TABLE "contribution" (
	"organization_id" text NOT NULL,
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"activity_id" text NOT NULL,
	"membership_id" text,
	"duration_minutes" integer,
	"status" text NOT NULL,
	"origin_kind" text NOT NULL,
	"origin_source_id" text,
	"origin_source_revision" integer,
	"origin_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contribution_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "contribution_revision_check" CHECK ("contribution"."revision" >= 1),
	CONSTRAINT "contribution_status_check" CHECK ("contribution"."status" in ('pending', 'approved', 'rejected', 'superseded')),
	CONSTRAINT "contribution_duration_check" CHECK ("contribution"."duration_minutes" is null or ("contribution"."duration_minutes" >= 1 and "contribution"."duration_minutes" <= 1440)),
	CONSTRAINT "contribution_approved_check" CHECK ("contribution"."status" <> 'approved' or ("contribution"."membership_id" is not null and "contribution"."duration_minutes" is not null)),
	CONSTRAINT "contribution_origin_check" CHECK ((
    ("contribution"."origin_kind" = 'source'
      and "contribution"."origin_source_id" is not null
      and "contribution"."origin_source_revision" is not null
      and "contribution"."origin_reason" is null)
    or ("contribution"."origin_kind" = 'staff'
      and "contribution"."origin_reason" is not null
      and "contribution"."origin_source_id" is null
      and "contribution"."origin_source_revision" is null)
  ))
);
--> statement-breakpoint
CREATE TABLE "domain_audit_event" (
	"organization_id" text NOT NULL,
	"id" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"aggregate_revision" integer NOT NULL,
	"action" text NOT NULL,
	"actor" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"reason" text,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_audit_event_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "domain_audit_event_aggregate_type_check" CHECK ("domain_audit_event"."aggregate_type" in ('activity', 'contribution', 'need'))
);
--> statement-breakpoint
CREATE TABLE "domain_command" (
	"organization_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_type" text NOT NULL,
	"command_digest" text NOT NULL,
	"result" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_command_organization_id_idempotency_key_pk" PRIMARY KEY("organization_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "need" (
	"organization_id" text NOT NULL,
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"category" text NOT NULL,
	"urgency" text NOT NULL,
	"summary" text NOT NULL,
	"provisional" boolean NOT NULL,
	"status" text NOT NULL,
	"owner_membership_id" text,
	"acknowledged_by_membership_id" text,
	"due_at" timestamp with time zone,
	"acknowledge_by" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"origin_kind" text NOT NULL,
	"origin_source_id" text,
	"origin_source_revision" integer,
	"origin_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "need_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "need_revision_check" CHECK ("need"."revision" >= 1),
	CONSTRAINT "need_urgency_check" CHECK ("need"."urgency" in ('routine', 'urgent')),
	CONSTRAINT "need_status_check" CHECK ("need"."status" in ('new', 'assigned', 'acknowledged', 'resolved', 'cancelled')),
	CONSTRAINT "need_status_fields_check" CHECK ((
        ("need"."status" = 'new'
          and "need"."owner_membership_id" is null
          and "need"."acknowledged_at" is null
          and "need"."acknowledged_by_membership_id" is null
          and "need"."resolved_at" is null
          and "need"."resolution" is null)
        or ("need"."status" = 'assigned'
          and "need"."owner_membership_id" is not null
          and "need"."acknowledged_at" is null
          and "need"."acknowledged_by_membership_id" is null
          and "need"."resolved_at" is null
          and "need"."resolution" is null)
        or ("need"."status" = 'acknowledged'
          and "need"."owner_membership_id" is not null
          and "need"."acknowledged_at" is not null
          and "need"."acknowledged_by_membership_id" is not null
          and "need"."resolved_at" is null
          and "need"."resolution" is null)
        or ("need"."status" = 'resolved'
          and "need"."resolved_at" is not null
          and "need"."resolution" is not null
          and (("need"."acknowledged_at" is not null and "need"."acknowledged_by_membership_id" is not null)
            or ("need"."acknowledged_at" is null and "need"."acknowledged_by_membership_id" is null)))
        or ("need"."status" = 'cancelled'
          and "need"."resolved_at" is null
          and "need"."resolution" is null
          and (("need"."acknowledged_at" is not null and "need"."acknowledged_by_membership_id" is not null)
            or ("need"."acknowledged_at" is null and "need"."acknowledged_by_membership_id" is null)))
      )),
	CONSTRAINT "need_origin_check" CHECK ((
    ("need"."origin_kind" = 'source'
      and "need"."origin_source_id" is not null
      and "need"."origin_source_revision" is not null
      and "need"."origin_reason" is null)
    or ("need"."origin_kind" = 'staff'
      and "need"."origin_reason" is not null
      and "need"."origin_source_id" is null
      and "need"."origin_source_revision" is null)
  ))
);
--> statement-breakpoint
ALTER TABLE "outbox_event" DROP CONSTRAINT "outbox_event_type_check";--> statement-breakpoint
ALTER TABLE "outbox_event" DROP CONSTRAINT "outbox_event_source_revision_fk";
--> statement-breakpoint
ALTER TABLE "outbox_event" ADD COLUMN "source_ref_id" text GENERATED ALWAYS AS (case when type = 'source.received' then aggregate_id end) STORED;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD COLUMN "source_ref_revision" integer GENERATED ALWAYS AS (case when type = 'source.received' then aggregate_revision end) STORED;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_origin_source_fk" FOREIGN KEY ("organization_id","origin_source_id","origin_source_revision") REFERENCES "public"."source_revision"("organization_id","source_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution" ADD CONSTRAINT "contribution_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution" ADD CONSTRAINT "contribution_activity_fk" FOREIGN KEY ("organization_id","activity_id") REFERENCES "public"."activity"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution" ADD CONSTRAINT "contribution_membership_fk" FOREIGN KEY ("organization_id","membership_id") REFERENCES "public"."source_author"("organization_id","membership_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution" ADD CONSTRAINT "contribution_origin_source_fk" FOREIGN KEY ("organization_id","origin_source_id","origin_source_revision") REFERENCES "public"."source_revision"("organization_id","source_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_audit_event" ADD CONSTRAINT "domain_audit_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_command" ADD CONSTRAINT "domain_command_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "need" ADD CONSTRAINT "need_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "need" ADD CONSTRAINT "need_owner_fk" FOREIGN KEY ("organization_id","owner_membership_id") REFERENCES "public"."source_author"("organization_id","membership_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "need" ADD CONSTRAINT "need_acknowledger_fk" FOREIGN KEY ("organization_id","acknowledged_by_membership_id") REFERENCES "public"."source_author"("organization_id","membership_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "need" ADD CONSTRAINT "need_origin_source_fk" FOREIGN KEY ("organization_id","origin_source_id","origin_source_revision") REFERENCES "public"."source_revision"("organization_id","source_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contribution_active_membership_unique" ON "contribution" USING btree ("organization_id","activity_id","membership_id") WHERE "contribution"."membership_id" is not null and "contribution"."status" in ('pending', 'approved');--> statement-breakpoint
CREATE UNIQUE INDEX "domain_audit_event_revision_unique" ON "domain_audit_event" USING btree ("organization_id","aggregate_type","aggregate_id","aggregate_revision");--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_source_revision_fk" FOREIGN KEY ("organization_id","source_ref_id","source_ref_revision") REFERENCES "public"."source_revision"("organization_id","source_id","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_type_check" CHECK ("outbox_event"."type" in ('source.received', 'ledger.changed', 'need.changed'));--> statement-breakpoint
CREATE TRIGGER domain_audit_event_immutable BEFORE UPDATE ON "domain_audit_event" FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();--> statement-breakpoint
CREATE TRIGGER domain_command_immutable BEFORE UPDATE ON "domain_command" FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
