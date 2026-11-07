CREATE TABLE "outbox_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"aggregate_revision" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_event_type_check" CHECK ("outbox_event"."type" in ('source.received'))
);
--> statement-breakpoint
CREATE TABLE "source" (
	"organization_id" text NOT NULL,
	"id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_organization_id_id_pk" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "source_attachment" (
	"organization_id" text NOT NULL,
	"source_id" text NOT NULL,
	"revision" integer NOT NULL,
	"attachment_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_attachment_organization_id_source_id_revision_attachment_id_pk" PRIMARY KEY("organization_id","source_id","revision","attachment_id")
);
--> statement-breakpoint
CREATE TABLE "source_attachment_identity" (
	"organization_id" text NOT NULL,
	"source_id" text NOT NULL,
	"attachment_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_attachment_identity_organization_id_source_id_attachment_id_pk" PRIMARY KEY("organization_id","source_id","attachment_id"),
	CONSTRAINT "source_attachment_identity_digest_check" CHECK ("source_attachment_identity"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "source_attachment_identity_mime_check" CHECK ("source_attachment_identity"."mime_type" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "source_attachment_identity_bytes_check" CHECK ("source_attachment_identity"."bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "source_author" (
	"organization_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"current_membership_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_author_organization_id_membership_id_pk" PRIMARY KEY("organization_id","membership_id")
);
--> statement-breakpoint
CREATE TABLE "source_revision" (
	"organization_id" text NOT NULL,
	"source_id" text NOT NULL,
	"revision" integer NOT NULL,
	"channel" text NOT NULL,
	"channel_identity" text NOT NULL,
	"external_message_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"author_external_identity" text NOT NULL,
	"author_membership_id" text,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"text_body" text NOT NULL,
	"original_media_type" text NOT NULL,
	"original_payload" text NOT NULL,
	"reply_to_source_id" text,
	"replaces_revision" integer,
	"canonical_digest" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_revision_organization_id_source_id_revision_pk" PRIMARY KEY("organization_id","source_id","revision"),
	CONSTRAINT "source_revision_channel_check" CHECK ("source_revision"."channel" in ('web', 'import', 'telegram')),
	CONSTRAINT "source_revision_sequence_check" CHECK (("source_revision"."revision" = 1 and "source_revision"."replaces_revision" is null) or ("source_revision"."revision" > 1 and "source_revision"."replaces_revision" = "source_revision"."revision" - 1)),
	CONSTRAINT "source_revision_reply_check" CHECK ("source_revision"."reply_to_source_id" is null or "source_revision"."reply_to_source_id" <> "source_revision"."source_id")
);
--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_source_revision_fk" FOREIGN KEY ("organization_id","aggregate_id","aggregate_revision") REFERENCES "public"."source_revision"("organization_id","source_id","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_attachment" ADD CONSTRAINT "source_attachment_revision_fk" FOREIGN KEY ("organization_id","source_id","revision") REFERENCES "public"."source_revision"("organization_id","source_id","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_attachment" ADD CONSTRAINT "source_attachment_identity_fk" FOREIGN KEY ("organization_id","source_id","attachment_id") REFERENCES "public"."source_attachment_identity"("organization_id","source_id","attachment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_attachment_identity" ADD CONSTRAINT "source_attachment_identity_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "public"."source"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_author" ADD CONSTRAINT "source_author_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_author" ADD CONSTRAINT "source_author_current_membership_id_member_id_fk" FOREIGN KEY ("current_membership_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revision" ADD CONSTRAINT "source_revision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revision" ADD CONSTRAINT "source_revision_source_fk" FOREIGN KEY ("organization_id","source_id") REFERENCES "public"."source"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revision" ADD CONSTRAINT "source_revision_author_reference_fk" FOREIGN KEY ("organization_id","author_membership_id") REFERENCES "public"."source_author"("organization_id","membership_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_revision" ADD CONSTRAINT "source_revision_reply_fk" FOREIGN KEY ("organization_id","reply_to_source_id") REFERENCES "public"."source"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_event_aggregate_unique" ON "outbox_event" USING btree ("organization_id","type","aggregate_id","aggregate_revision");--> statement-breakpoint
CREATE INDEX "outbox_event_pending_idx" ON "outbox_event" USING btree ("organization_id","dispatched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "source_revision_idempotency_unique" ON "source_revision" USING btree ("organization_id","channel","channel_identity","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "source_revision_external_message_unique" ON "source_revision" USING btree ("organization_id","channel","channel_identity","external_message_id","revision");--> statement-breakpoint
CREATE INDEX "source_revision_author_idx" ON "source_revision" USING btree ("organization_id","author_membership_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION relay_reject_evidence_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'relation % is immutable evidence; preserve revisions instead of rewriting them', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER source_revision_immutable BEFORE UPDATE ON "source_revision" FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();--> statement-breakpoint
CREATE TRIGGER source_attachment_identity_immutable BEFORE UPDATE ON "source_attachment_identity" FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
