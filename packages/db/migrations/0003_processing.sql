CREATE TABLE "extraction_run" (
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_revision" integer NOT NULL,
	"proposal" jsonb NOT NULL,
	"status" text DEFAULT 'review' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_run_organization_id_run_id_pk" PRIMARY KEY("organization_id","run_id"),
	CONSTRAINT "extraction_run_organization_id_source_id_source_revision_unique" UNIQUE("organization_id","source_id","source_revision"),
	CONSTRAINT "extraction_run_status_check" CHECK ("extraction_run"."status" in ('review','accepted','rejected')),
	CONSTRAINT "extraction_run_revision_check" CHECK ("extraction_run"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "processing_work" (
	"organization_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_revision" integer NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"retry_after" timestamp with time zone,
	"failed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "processing_work_organization_id_source_id_source_revision_pk" PRIMARY KEY("organization_id","source_id","source_revision"),
	CONSTRAINT "processing_work_attempts_check" CHECK ("processing_work"."attempts" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "review_decision" (
	"organization_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"run_id" text NOT NULL,
	"command" jsonb NOT NULL,
	"outcome" jsonb NOT NULL,
	"actor" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_decision_organization_id_idempotency_key_pk" PRIMARY KEY("organization_id","idempotency_key"),
	CONSTRAINT "review_decision_organization_id_run_id_unique" UNIQUE("organization_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "extraction_run" ADD CONSTRAINT "extraction_run_organization_id_source_id_source_revision_source_revision_organization_id_source_id_revision_fk" FOREIGN KEY ("organization_id","source_id","source_revision") REFERENCES "public"."source_revision"("organization_id","source_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_work" ADD CONSTRAINT "processing_work_organization_id_source_id_source_revision_source_revision_organization_id_source_id_revision_fk" FOREIGN KEY ("organization_id","source_id","source_revision") REFERENCES "public"."source_revision"("organization_id","source_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decision" ADD CONSTRAINT "review_decision_organization_id_run_id_extraction_run_organization_id_run_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."extraction_run"("organization_id","run_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER review_decision_immutable BEFORE UPDATE OR DELETE ON review_decision FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
--> statement-breakpoint
CREATE FUNCTION relay_guard_extraction_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.source_revision IS DISTINCT FROM OLD.source_revision OR NEW.proposal IS DISTINCT FROM OLD.proposal OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.status <> 'review' OR NEW.status NOT IN ('accepted','rejected') OR NEW.revision <> OLD.revision + 1 THEN
  RAISE EXCEPTION 'immutable extraction run';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER extraction_run_guard BEFORE UPDATE OR DELETE ON extraction_run FOR EACH ROW EXECUTE FUNCTION relay_guard_extraction_run();
