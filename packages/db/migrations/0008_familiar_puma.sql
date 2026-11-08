CREATE TABLE "processing_retry" (
	"organization_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"source_id" text NOT NULL,
	"source_revision" integer NOT NULL,
	"prior_attempts" integer NOT NULL,
	"actor" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_retry_organization_id_idempotency_key_pk" PRIMARY KEY("organization_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "processing_retry" ADD CONSTRAINT "processing_retry_organization_id_source_id_source_revision_source_revision_organization_id_source_id_revision_fk" FOREIGN KEY ("organization_id","source_id","source_revision") REFERENCES "public"."source_revision"("organization_id","source_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER processing_retry_immutable BEFORE UPDATE OR DELETE ON processing_retry FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
