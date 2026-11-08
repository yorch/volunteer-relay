CREATE TABLE "provisional_need" (
	"organization_id" text NOT NULL,
	"run_id" text NOT NULL,
	"item_key_hash" text NOT NULL,
	"need_id" text NOT NULL,
	CONSTRAINT "provisional_need_organization_id_run_id_item_key_hash_pk" PRIMARY KEY("organization_id","run_id","item_key_hash"),
	CONSTRAINT "provisional_need_organization_id_need_id_unique" UNIQUE("organization_id","need_id")
);
--> statement-breakpoint
ALTER TABLE "provisional_need" ADD CONSTRAINT "provisional_need_organization_id_need_id_need_organization_id_id_fk" FOREIGN KEY ("organization_id","need_id") REFERENCES "public"."need"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisional_need" ADD CONSTRAINT "provisional_need_organization_id_run_id_extraction_run_organization_id_run_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."extraction_run"("organization_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER provisional_need_immutable BEFORE UPDATE OR DELETE ON provisional_need FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
