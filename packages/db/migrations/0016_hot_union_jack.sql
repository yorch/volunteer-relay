CREATE TABLE "platform_audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"operator_user_id" text NOT NULL,
	"action" text NOT NULL,
	"target_organization_id" text,
	"query" text,
	"correlation_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_audit_event" DROP CONSTRAINT "organization_audit_action_check";--> statement-breakpoint
ALTER TABLE "in_app_notification" DROP CONSTRAINT "notification_type_check";--> statement-breakpoint
ALTER TABLE "in_app_notification" ALTER COLUMN "need_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "platform_audit_actor_idx" ON "platform_audit_event" USING btree ("operator_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "platform_audit_organization_idx" ON "platform_audit_event" USING btree ("target_organization_id","occurred_at");--> statement-breakpoint
ALTER TABLE "organization_audit_event" ADD CONSTRAINT "organization_audit_action_check" CHECK ("organization_audit_event"."action" in ('settings.update','member.role','member.remove','member.invite','member.add','organization.create','organization.update'));--> statement-breakpoint
ALTER TABLE "in_app_notification" ADD CONSTRAINT "notification_type_check" CHECK ("in_app_notification"."type" in ('need-assigned','need-overdue','ownership-changed'));--> statement-breakpoint
CREATE TRIGGER platform_audit_event_immutable BEFORE UPDATE OR DELETE ON platform_audit_event FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
--> statement-breakpoint
-- Last-owner invariant: a row that is currently an owner may only stop being an
-- owner (or move organization) when another owner remains. The check takes a
-- transaction-scoped advisory lock keyed on the organization instead of a row
-- lock, because the tenant settings path already locks member rows and the
-- organization row in the opposite order; a row lock here would deadlock against
-- it and would also block every foreign-key insert that references the
-- organization. The count reads the transaction's own view after the lock is
-- held, so a concurrent change either has committed (and is counted) or waits
-- for this lock. The named constraint lets callers map the refusal to a
-- user-facing conflict instead of a retryable outage.
CREATE OR REPLACE FUNCTION relay_assert_organization_owner() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organization WHERE id = OLD.organization_id) THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-owner:' || OLD.organization_id, 0));
  IF (
    SELECT count(*) FROM (
      SELECT 1 FROM member WHERE organization_id = OLD.organization_id AND role = 'owner' FOR UPDATE
    ) remaining
  ) = 0 THEN
    RAISE EXCEPTION 'organization must keep at least one owner'
      USING ERRCODE = '23514', CONSTRAINT = 'organization_last_owner_check';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER member_last_owner_on_update AFTER UPDATE OF role, organization_id ON member FOR EACH ROW
  WHEN (OLD.role = 'owner' AND (NEW.role <> 'owner' OR NEW.organization_id <> OLD.organization_id))
  EXECUTE FUNCTION relay_assert_organization_owner();
--> statement-breakpoint
CREATE TRIGGER member_last_owner_on_delete AFTER DELETE ON member FOR EACH ROW
  WHEN (OLD.role = 'owner')
  EXECUTE FUNCTION relay_assert_organization_owner();
