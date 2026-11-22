-- Follow-up to 0016. Two independent corrections, in one forward migration
-- because 0016 is merged:
--   1. The last-owner trigger no longer takes row locks. `for update` inside the
--      trigger deadlocks two concurrent tenant demotions against each other,
--      deadlocks against the tenant settings save, and blocks every foreign-key
--      insert that references an owner membership. It is not needed: the
--      advisory lock above already serializes every writer of this
--      organization's ownership under READ COMMITTED, and each plpgsql statement
--      takes a fresh snapshot after acquiring it.
--   2. The ownership-notification schema change bundled into 0016 is reverted.
--      Ownership notifications were deferred, so nothing writes a notification
--      without a need or with the unused 'ownership-changed' type.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM in_app_notification WHERE need_id IS NULL) THEN
    RAISE EXCEPTION 'in_app_notification.need_id contains rows without a need; resolve them before restoring not null'
      USING ERRCODE = '23502', CONSTRAINT = 'in_app_notification_need_id_not_null';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "in_app_notification" DROP CONSTRAINT "notification_type_check";--> statement-breakpoint
ALTER TABLE "in_app_notification" ALTER COLUMN "need_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "in_app_notification" ADD CONSTRAINT "notification_type_check" CHECK ("in_app_notification"."type" in ('need-assigned','need-overdue'));--> statement-breakpoint
-- Replaces the 0016 definition. Unchanged behaviour: the organization row being
-- gone (an organization cascade) skips the check, and the refusal keeps SQLSTATE
-- 23514 with the named constraint so both member endpoints and the console can
-- answer CONFLICT instead of a retryable outage. Changed: the remaining-owner
-- count is a plain read.
--
-- Why no row lock:
--   * READ COMMITTED. The advisory lock is the serialization point. A waiter
--     acquires it only after the earlier transaction finished, and the count in
--     this statement then runs on a snapshot that includes that commit, so a
--     demotion that left one owner is seen as one owner, not two.
--   * REPEATABLE READ / SERIALIZABLE. The transaction's snapshot is fixed at its
--     first statement, so a fresh snapshot is not available: lock the owner rows
--     `for share` instead, which turns a concurrently committed change into a
--     serialization failure (40001) rather than a stale count.
--   * A `for update` here would also conflict with `for share` readers and with
--     `for key share` foreign-key checks, so the tenant settings save and any
--     insert referencing an owner membership would wait on it.
CREATE OR REPLACE FUNCTION relay_assert_organization_owner() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organization WHERE id = OLD.organization_id) THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-owner:' || OLD.organization_id, 0));
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    PERFORM 1 FROM member WHERE organization_id = OLD.organization_id AND role = 'owner' FOR SHARE;
  END IF;
  IF (
    SELECT count(*) FROM member
    WHERE organization_id = OLD.organization_id AND role = 'owner'
  ) = 0 THEN
    RAISE EXCEPTION 'organization must keep at least one owner'
      USING ERRCODE = '23514', CONSTRAINT = 'organization_last_owner_check';
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
-- The trigger pair is unchanged from 0016; recreated so this migration owns the
-- definition it depends on.
DROP TRIGGER IF EXISTS member_last_owner_on_update ON member;--> statement-breakpoint
DROP TRIGGER IF EXISTS member_last_owner_on_delete ON member;--> statement-breakpoint
CREATE TRIGGER member_last_owner_on_update AFTER UPDATE OF role, organization_id ON member FOR EACH ROW
  WHEN (OLD.role = 'owner' AND (NEW.role <> 'owner' OR NEW.organization_id <> OLD.organization_id))
  EXECUTE FUNCTION relay_assert_organization_owner();--> statement-breakpoint
CREATE TRIGGER member_last_owner_on_delete AFTER DELETE ON member FOR EACH ROW
  WHEN (OLD.role = 'owner')
  EXECUTE FUNCTION relay_assert_organization_owner();
