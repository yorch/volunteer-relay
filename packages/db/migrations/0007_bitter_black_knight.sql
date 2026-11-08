CREATE TABLE "model_budget_reservation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"request_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"model" text NOT NULL,
	"input_token_limit" integer NOT NULL,
	"output_token_limit" integer NOT NULL,
	"input_rate" bigint NOT NULL,
	"output_rate" bigint NOT NULL,
	"reserved_micro_usd" bigint NOT NULL,
	"status" text NOT NULL,
	"actual_input" integer,
	"actual_output" integer,
	"actual_micro_usd" bigint,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_budget_reservation_organization_id_request_id_unique" UNIQUE("organization_id","request_id"),
	CONSTRAINT "budget_reservation_status_check" CHECK ("model_budget_reservation"."status" in ('reserved','sent','settled','cancelled')),
	CONSTRAINT "budget_reservation_values_check" CHECK ("model_budget_reservation"."input_token_limit">=0 and "model_budget_reservation"."output_token_limit">=0 and "model_budget_reservation"."input_rate">=0 and "model_budget_reservation"."output_rate">=0 and "model_budget_reservation"."reserved_micro_usd">=0),
	CONSTRAINT "budget_reservation_actual_check" CHECK (("model_budget_reservation"."status"='settled' and "model_budget_reservation"."actual_input" is not null and "model_budget_reservation"."actual_output" is not null and "model_budget_reservation"."actual_micro_usd" is not null and "model_budget_reservation"."actual_input">=0 and "model_budget_reservation"."actual_output">=0 and "model_budget_reservation"."actual_micro_usd">=0) or ("model_budget_reservation"."status"<>'settled' and "model_budget_reservation"."actual_input" is null and "model_budget_reservation"."actual_output" is null and "model_budget_reservation"."actual_micro_usd" is null))
);
--> statement-breakpoint
CREATE TABLE "model_budget_window" (
	"window_start" timestamp with time zone PRIMARY KEY NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"limit_micro_usd" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "budget_window_limit_check" CHECK ("model_budget_window"."limit_micro_usd">0)
);
--> statement-breakpoint
ALTER TABLE "model_budget_reservation" ADD CONSTRAINT "model_budget_reservation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_budget_reservation" ADD CONSTRAINT "model_budget_reservation_window_start_model_budget_window_window_start_fk" FOREIGN KEY ("window_start") REFERENCES "public"."model_budget_window"("window_start") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER model_budget_window_immutable BEFORE UPDATE OR DELETE ON model_budget_window FOR EACH ROW EXECUTE FUNCTION relay_reject_evidence_update();
--> statement-breakpoint
CREATE FUNCTION relay_guard_model_budget() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable budget history'; END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.window_start IS DISTINCT FROM OLD.window_start OR NEW.model IS DISTINCT FROM OLD.model OR NEW.input_token_limit IS DISTINCT FROM OLD.input_token_limit OR NEW.output_token_limit IS DISTINCT FROM OLD.output_token_limit OR NEW.input_rate IS DISTINCT FROM OLD.input_rate OR NEW.output_rate IS DISTINCT FROM OLD.output_rate OR NEW.reserved_micro_usd IS DISTINCT FROM OLD.reserved_micro_usd OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NOT ((OLD.status='reserved' AND NEW.status IN ('sent','cancelled')) OR (OLD.status='sent' AND NEW.status='settled')) THEN RAISE EXCEPTION 'immutable budget history'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER model_budget_reservation_guard BEFORE UPDATE OR DELETE ON model_budget_reservation FOR EACH ROW EXECUTE FUNCTION relay_guard_model_budget();
