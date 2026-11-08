ALTER TABLE "delivery_job" ADD COLUMN "need_revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "need_escalation" ADD COLUMN "assignment_revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DROP TRIGGER need_escalation_immutable ON need_escalation;
--> statement-breakpoint
UPDATE need_escalation e SET assignment_revision=n.revision FROM need n WHERE n.organization_id=e.organization_id AND n.id=e.need_id AND n.status='assigned' AND n.acknowledge_by=e.deadline;
--> statement-breakpoint
CREATE TRIGGER need_escalation_immutable BEFORE UPDATE ON need_escalation FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
--> statement-breakpoint
ALTER TABLE "need_escalation" DROP CONSTRAINT "need_escalation_organization_id_need_id_deadline_level_pk";
--> statement-breakpoint
ALTER TABLE "need_escalation" ADD CONSTRAINT "need_escalation_organization_id_need_id_deadline_assignment_revision_level_pk" PRIMARY KEY("organization_id","need_id","deadline","assignment_revision","level");
