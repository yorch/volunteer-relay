CREATE FUNCTION relay_reject_redacted_source_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM source WHERE organization_id=NEW.organization_id AND id=NEW.source_id FOR KEY SHARE;
 IF EXISTS (SELECT 1 FROM source_redaction r WHERE r.organization_id=NEW.organization_id AND r.source_id=NEW.source_id) THEN
  RAISE EXCEPTION 'source evidence is redacted' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER source_revision_redaction_fence BEFORE INSERT ON source_revision FOR EACH ROW EXECUTE FUNCTION relay_reject_redacted_source_insert();
--> statement-breakpoint
CREATE TRIGGER source_attachment_identity_redaction_fence BEFORE INSERT ON source_attachment_identity FOR EACH ROW EXECUTE FUNCTION relay_reject_redacted_source_insert();
--> statement-breakpoint
CREATE TRIGGER source_attachment_redaction_fence BEFORE INSERT ON source_attachment FOR EACH ROW EXECUTE FUNCTION relay_reject_redacted_source_insert();
--> statement-breakpoint
CREATE TRIGGER extraction_run_redaction_fence BEFORE INSERT ON extraction_run FOR EACH ROW EXECUTE FUNCTION relay_reject_redacted_source_insert();
