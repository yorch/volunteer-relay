CREATE TABLE "processing_policy_snapshot" (
	"organization_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_revision" integer NOT NULL,
	"generation" integer NOT NULL,
	"automation_policy" text NOT NULL,
	"policy_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_policy_snapshot_pk" PRIMARY KEY("organization_id","source_id","source_revision","generation"),
	CONSTRAINT "processing_policy_mode_check" CHECK ("processing_policy_snapshot"."automation_policy" in ('review-all','validated-auto-record')),
	CONSTRAINT "processing_policy_generation_check" CHECK ("processing_policy_snapshot"."generation">0)
);
--> statement-breakpoint
CREATE TABLE "processing_reprocess" (
	"organization_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"source_id" text NOT NULL,
	"source_revision" integer NOT NULL,
	"generation" integer NOT NULL,
	"actor" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_reprocess_organization_id_idempotency_key_pk" PRIMARY KEY("organization_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "extraction_run" DROP CONSTRAINT "extraction_run_organization_id_source_id_source_revision_unique";--> statement-breakpoint
ALTER TABLE "extraction_run" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "processing_work" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "processing_policy_snapshot" ADD CONSTRAINT "processing_policy_snapshot_source_fk" FOREIGN KEY ("organization_id","source_id","source_revision") REFERENCES "public"."source_revision"("organization_id","source_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_reprocess" ADD CONSTRAINT "processing_reprocess_snapshot_fk" FOREIGN KEY ("organization_id","source_id","source_revision","generation") REFERENCES "public"."processing_policy_snapshot"("organization_id","source_id","source_revision","generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_run" ADD CONSTRAINT "extraction_run_organization_id_source_id_source_revision_generation_unique" UNIQUE("organization_id","source_id","source_revision","generation");
--> statement-breakpoint
INSERT INTO processing_policy_snapshot(organization_id,source_id,source_revision,generation,automation_policy,policy_version) SELECT organization_id,source_id,revision,1,'review-all','1' FROM source_revision;
--> statement-breakpoint
ALTER TABLE "extraction_run" ADD CONSTRAINT "extraction_run_snapshot_fk" FOREIGN KEY ("organization_id","source_id","source_revision","generation") REFERENCES "public"."processing_policy_snapshot"("organization_id","source_id","source_revision","generation") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "processing_work" ADD CONSTRAINT "processing_work_snapshot_fk" FOREIGN KEY ("organization_id","source_id","source_revision","generation") REFERENCES "public"."processing_policy_snapshot"("organization_id","source_id","source_revision","generation") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER processing_policy_snapshot_immutable BEFORE UPDATE OR DELETE ON processing_policy_snapshot FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
--> statement-breakpoint
CREATE TRIGGER processing_reprocess_immutable BEFORE UPDATE OR DELETE ON processing_reprocess FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION relay_guard_extraction_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM source_redaction r WHERE r.organization_id=OLD.organization_id AND r.source_id=OLD.source_id) AND NEW.proposal='{"redacted":true}'::jsonb AND (to_jsonb(NEW)-'proposal')=(to_jsonb(OLD)-'proposal') THEN RETURN NEW; END IF;
 IF TG_OP = 'DELETE' OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.source_revision IS DISTINCT FROM OLD.source_revision OR NEW.generation IS DISTINCT FROM OLD.generation OR NEW.proposal IS DISTINCT FROM OLD.proposal OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.status <> 'review' OR NEW.status NOT IN ('accepted','rejected') OR NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'immutable extraction run'; END IF;
 RETURN NEW;
END $$;
