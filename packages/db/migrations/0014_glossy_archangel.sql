CREATE TABLE "organization_audit_event" (
	"organization_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"phase" text NOT NULL,
	"action" text NOT NULL,
	"target_id" text NOT NULL,
	"actor" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "organization_audit_event_organization_id_operation_id_phase_pk" PRIMARY KEY("organization_id","operation_id","phase"),
	CONSTRAINT "organization_audit_phase_check" CHECK ("organization_audit_event"."phase" in ('requested','succeeded','failed','applied')),
	CONSTRAINT "organization_audit_action_check" CHECK ("organization_audit_event"."action" in ('settings.update','member.role','member.remove','member.invite'))
);
--> statement-breakpoint
ALTER TABLE "organization_audit_event" ADD CONSTRAINT "organization_audit_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_audit_terminal_unique" ON "organization_audit_event" USING btree ("organization_id","operation_id") WHERE "organization_audit_event"."phase" in ('succeeded','failed');--> statement-breakpoint
CREATE TRIGGER organization_audit_event_immutable BEFORE UPDATE OR DELETE ON organization_audit_event FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
