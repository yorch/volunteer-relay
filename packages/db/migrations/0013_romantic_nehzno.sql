CREATE TABLE "need_escalation_state" (
	"organization_id" text NOT NULL,
	"need_id" text NOT NULL,
	"assignment_revision" integer NOT NULL,
	"level" integer NOT NULL,
	"next_at" timestamp with time zone NOT NULL,
	CONSTRAINT "need_escalation_state_organization_id_need_id_pk" PRIMARY KEY("organization_id","need_id"),
	CONSTRAINT "need_escalation_state_level_check" CHECK ("need_escalation_state"."level">0)
);
--> statement-breakpoint
ALTER TABLE "need_escalation" ADD COLUMN "outcome" text DEFAULT 'reminder' NOT NULL;--> statement-breakpoint
ALTER TABLE "need_escalation_state" ADD CONSTRAINT "need_escalation_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "need_escalation" ADD CONSTRAINT "need_escalation_outcome_check" CHECK ("need_escalation"."outcome" in ('reassigned','reminder','unroutable'));--> statement-breakpoint
INSERT INTO need_escalation_state(organization_id,need_id,assignment_revision,level,next_at)
 SELECT DISTINCT ON (n.organization_id,n.id) n.organization_id,n.id,n.revision,e.level,e.created_at + make_interval(mins => coalesce(s.ack_minutes,60))
 FROM need n JOIN need_escalation e ON e.organization_id=n.organization_id AND e.need_id=n.id AND e.assignment_revision=n.revision AND e.deadline=n.acknowledge_by
 LEFT JOIN organization_settings s ON s.organization_id=n.organization_id
 WHERE n.status='assigned' ORDER BY n.organization_id,n.id,e.level DESC,e.created_at DESC;
