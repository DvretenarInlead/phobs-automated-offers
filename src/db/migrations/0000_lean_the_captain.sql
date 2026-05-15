CREATE EXTENSION IF NOT EXISTS "citext";
--> statement-breakpoint
CREATE TABLE "admin_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"admin_user_id" bigint NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"ip" "inet",
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"sid" text PRIMARY KEY NOT NULL,
	"admin_user_id" bigint NOT NULL,
	"ip" "inet" NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_ct" "bytea",
	"totp_secret_iv" "bytea",
	"totp_secret_tag" "bytea",
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"recovery_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"role" text NOT NULL,
	"scoped_hub_id" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"hub_id" bigint NOT NULL,
	"deal_id" bigint,
	"request_id" text,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"request" jsonb,
	"response" jsonb,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"hub_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_steps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"hub_id" bigint NOT NULL,
	"deal_id" bigint,
	"step" text NOT NULL,
	"step_index" smallint NOT NULL,
	"status" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"hub_id" bigint PRIMARY KEY NOT NULL,
	"access_token_ct" "bytea" NOT NULL,
	"access_token_iv" "bytea" NOT NULL,
	"access_token_tag" "bytea" NOT NULL,
	"access_token_expires" timestamp with time zone NOT NULL,
	"refresh_token_ct" "bytea" NOT NULL,
	"refresh_token_iv" "bytea" NOT NULL,
	"refresh_token_tag" "bytea" NOT NULL,
	"scopes" text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_config" (
	"hub_id" bigint PRIMARY KEY NOT NULL,
	"phobs_endpoint" text NOT NULL,
	"phobs_site_id" text NOT NULL,
	"phobs_auth_user_ct" "bytea" NOT NULL,
	"phobs_auth_user_iv" "bytea" NOT NULL,
	"phobs_auth_user_tag" "bytea" NOT NULL,
	"phobs_auth_pass_ct" "bytea" NOT NULL,
	"phobs_auth_pass_iv" "bytea" NOT NULL,
	"phobs_auth_pass_tag" "bytea" NOT NULL,
	"hubdb_table_id" text NOT NULL,
	"hubdb_column_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quote_template_id" text NOT NULL,
	"owner_id" bigint NOT NULL,
	"access_code" text,
	"property_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rate_filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trigger_mode" text DEFAULT 'webhook' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_config_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"hub_id" bigint NOT NULL,
	"admin_user_id" bigint NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"hub_id" bigint PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"hub_id" bigint NOT NULL,
	"day" date NOT NULL,
	"webhooks" integer DEFAULT 0 NOT NULL,
	"phobs_calls" integer DEFAULT 0 NOT NULL,
	"hubspot_calls" integer DEFAULT 0 NOT NULL,
	"quotes_created" integer DEFAULT 0 NOT NULL,
	"emails_sent" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_hub_id_day_pk" PRIMARY KEY("hub_id","day")
);
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_hub_id_tenants_hub_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."tenants"("hub_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_config" ADD CONSTRAINT "tenant_config_hub_id_tenants_hub_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."tenants"("hub_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_user_idx" ON "admin_audit" USING btree ("admin_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_uq" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "audit_log_hub_created_idx" ON "audit_log" USING btree ("hub_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_deal_idx" ON "audit_log" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "job_steps_job_idx" ON "job_steps" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_steps_hub_created_idx" ON "job_steps" USING btree ("hub_id","created_at");