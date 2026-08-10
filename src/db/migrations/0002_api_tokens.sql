CREATE TABLE "api_tokens" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"hub_id" bigint NOT NULL,
	"name" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_admin_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_hub_id_tenants_hub_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."tenants"("hub_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_hash_uq" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_hub_idx" ON "api_tokens" USING btree ("hub_id");
