CREATE TABLE "user_last_organization" (
	"user_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_last_organization" ADD CONSTRAINT "user_last_organization_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_last_organization" ADD CONSTRAINT "user_last_organization_membership_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "public"."member"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;