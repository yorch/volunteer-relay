CREATE TABLE "blob_erasure_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"status" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blob_erasure_job" (
	"storage_key" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"retry_after" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_redaction" (
	"organization_id" text NOT NULL,
	"source_id" text NOT NULL,
	"redaction_id" text NOT NULL,
	"expected_revision" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"reason" text NOT NULL,
	"reason_hash" text NOT NULL,
	"source_digest" text NOT NULL,
	"actor" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"redacted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "source_redaction_organization_id_source_id_pk" PRIMARY KEY("organization_id","source_id"),
	CONSTRAINT "source_redaction_organization_id_idempotency_key_unique" UNIQUE("organization_id","idempotency_key"),
	CONSTRAINT "source_redaction_redaction_id_unique" UNIQUE("redaction_id")
);
--> statement-breakpoint
ALTER TABLE "source_redaction" ADD CONSTRAINT "source_redaction_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER source_redaction_immutable BEFORE UPDATE OR DELETE ON source_redaction FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
--> statement-breakpoint
CREATE TRIGGER blob_erasure_attempt_immutable BEFORE UPDATE OR DELETE ON blob_erasure_attempt FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
--> statement-breakpoint
CREATE FUNCTION relay_redact_record(value jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result jsonb; entry record;
BEGIN
 IF value IS NULL OR value = 'null'::jsonb THEN RETURN value; END IF;
 IF jsonb_typeof(value)='array' THEN SELECT coalesce(jsonb_agg(relay_redact_record(v)),'[]'::jsonb) INTO result FROM jsonb_array_elements(value) v; RETURN result; END IF;
 IF jsonb_typeof(value)='string' THEN RETURN '"[redacted]"'::jsonb; END IF;
 IF jsonb_typeof(value)<>'object' THEN RETURN value; END IF;
 result='{}'::jsonb;
 FOR entry IN SELECT key,val FROM jsonb_each(value) AS e(key,val) LOOP
  IF entry.key='beneficiaryReference' THEN result=result||jsonb_build_object(entry.key,NULL);
  ELSIF jsonb_typeof(entry.val)='string' AND entry.key NOT IN ('organizationId','activityId','contributionId','needId','membershipId','sourceId','ownerMembershipId','acknowledgedByMembershipId','status','datePrecision','createdAt','updatedAt','dueAt','acknowledgeBy','acknowledgedAt','resolvedAt') THEN
   IF entry.key='kind' AND entry.val IN ('"source"'::jsonb,'"staff"'::jsonb) THEN result=result||jsonb_build_object(entry.key,entry.val); ELSE result=result||jsonb_build_object(entry.key,'[redacted]'::text); END IF;
  ELSE result=result||jsonb_build_object(entry.key,relay_redact_record(entry.val)); END IF;
 END LOOP;
 RETURN result;
END $$;
--> statement-breakpoint
CREATE FUNCTION relay_aggregate_redacted(org text, kind text, aggregate text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM source_redaction r WHERE r.organization_id=org AND (
  (kind='activity' AND EXISTS(SELECT 1 FROM activity a WHERE a.organization_id=org AND a.id=aggregate AND a.origin_kind='source' AND a.origin_source_id=r.source_id)) OR
  (kind='contribution' AND EXISTS(SELECT 1 FROM contribution c WHERE c.organization_id=org AND c.id=aggregate AND c.origin_kind='source' AND c.origin_source_id=r.source_id)) OR
  (kind='need' AND EXISTS(SELECT 1 FROM need n WHERE n.organization_id=org AND n.id=aggregate AND n.origin_kind='source' AND n.origin_source_id=r.source_id))));
$$;
--> statement-breakpoint
CREATE FUNCTION relay_guard_source_redaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM source_redaction r WHERE r.organization_id=OLD.organization_id AND r.source_id=OLD.source_id) AND NEW.text_body='' AND NEW.original_payload='' AND NEW.author_external_identity='[redacted]' AND NEW.envelope='{"redacted":true}'::jsonb AND (to_jsonb(NEW)-ARRAY['text_body','original_payload','author_external_identity','envelope'])=(to_jsonb(OLD)-ARRAY['text_body','original_payload','author_external_identity','envelope']) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'immutable source evidence' USING ERRCODE='55000';
END $$;
--> statement-breakpoint
DROP TRIGGER source_revision_immutable ON source_revision;
--> statement-breakpoint
CREATE TRIGGER source_revision_immutable BEFORE UPDATE ON source_revision FOR EACH ROW EXECUTE FUNCTION relay_guard_source_redaction();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION relay_guard_extraction_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM source_redaction r WHERE r.organization_id=OLD.organization_id AND r.source_id=OLD.source_id) AND NEW.proposal='{"redacted":true}'::jsonb AND (to_jsonb(NEW)-'proposal')=(to_jsonb(OLD)-'proposal') THEN RETURN NEW; END IF;
 IF TG_OP = 'DELETE' OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.source_id IS DISTINCT FROM OLD.source_id OR NEW.source_revision IS DISTINCT FROM OLD.source_revision OR NEW.proposal IS DISTINCT FROM OLD.proposal OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.status <> 'review' OR NEW.status NOT IN ('accepted','rejected') OR NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'immutable extraction run'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION relay_guard_review_redaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.command='{"redacted":true}'::jsonb AND (to_jsonb(NEW)-'command')=(to_jsonb(OLD)-'command') AND EXISTS(SELECT 1 FROM extraction_run e JOIN source_redaction r ON r.organization_id=e.organization_id AND r.source_id=e.source_id WHERE e.organization_id=OLD.organization_id AND e.run_id=OLD.run_id) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'immutable review decision' USING ERRCODE='55000';
END $$;
--> statement-breakpoint
DROP TRIGGER review_decision_immutable ON review_decision;
--> statement-breakpoint
CREATE TRIGGER review_decision_immutable BEFORE UPDATE OR DELETE ON review_decision FOR EACH ROW EXECUTE FUNCTION relay_guard_review_redaction();
--> statement-breakpoint
CREATE FUNCTION relay_guard_audit_redaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF relay_aggregate_redacted(OLD.organization_id,OLD.aggregate_type,OLD.aggregate_id) AND NEW.before IS NOT DISTINCT FROM relay_redact_record(OLD.before) AND NEW.after IS NOT DISTINCT FROM relay_redact_record(OLD.after) AND NEW.reason IS NOT DISTINCT FROM (CASE WHEN OLD.reason IS NULL THEN NULL ELSE '[redacted]' END) AND (to_jsonb(NEW)-ARRAY['before','after','reason'])=(to_jsonb(OLD)-ARRAY['before','after','reason']) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'immutable domain audit' USING ERRCODE='55000';
END $$;
--> statement-breakpoint
DROP TRIGGER domain_audit_event_immutable ON domain_audit_event;
--> statement-breakpoint
CREATE TRIGGER domain_audit_event_immutable BEFORE UPDATE ON domain_audit_event FOR EACH ROW EXECUTE FUNCTION relay_guard_audit_redaction();
--> statement-breakpoint
CREATE FUNCTION relay_guard_command_redaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.result=relay_redact_record(OLD.result) AND (to_jsonb(NEW)-'result')=(to_jsonb(OLD)-'result') AND EXISTS(SELECT 1 FROM source_redaction r WHERE r.organization_id=OLD.organization_id AND jsonb_path_exists(OLD.result,'$.** ? (@.sourceId == $id)',jsonb_build_object('id',r.source_id))) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'immutable domain command' USING ERRCODE='55000';
END $$;
--> statement-breakpoint
DROP TRIGGER domain_command_immutable ON domain_command;
--> statement-breakpoint
CREATE TRIGGER domain_command_immutable BEFORE UPDATE ON domain_command FOR EACH ROW EXECUTE FUNCTION relay_guard_command_redaction();
--> statement-breakpoint
CREATE FUNCTION relay_guard_effect_redaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.item_key='redacted:'||encode(sha256(convert_to(OLD.item_key,'UTF8')),'hex') AND (to_jsonb(NEW)-'item_key')=(to_jsonb(OLD)-'item_key') AND EXISTS(SELECT 1 FROM extraction_run e JOIN source_redaction r ON r.organization_id=e.organization_id AND r.source_id=e.source_id WHERE e.organization_id=OLD.organization_id AND e.run_id=OLD.run_id) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'immutable review effect' USING ERRCODE='55000';
END $$;
--> statement-breakpoint
DROP TRIGGER review_effect_immutable ON review_effect;
--> statement-breakpoint
CREATE TRIGGER review_effect_immutable BEFORE UPDATE OR DELETE ON review_effect FOR EACH ROW EXECUTE FUNCTION relay_guard_effect_redaction();
