CREATE TABLE "review_effect" (
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"item_key" text NOT NULL,
	"kind" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"aggregate_revision" integer NOT NULL,
	CONSTRAINT "review_effect_organization_id_run_id_item_key_pk" PRIMARY KEY("organization_id","run_id","item_key"),
	CONSTRAINT "review_effect_kind_check" CHECK ("review_effect"."kind" in ('activity','contribution','need')),
	CONSTRAINT "review_effect_revision_check" CHECK ("review_effect"."aggregate_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "processing_work" ADD COLUMN "lease_token" text;--> statement-breakpoint
ALTER TABLE "review_effect" ADD CONSTRAINT "review_effect_organization_id_run_id_extraction_run_organization_id_run_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."extraction_run"("organization_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER review_effect_immutable BEFORE UPDATE OR DELETE ON review_effect FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
