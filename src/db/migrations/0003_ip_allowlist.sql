ALTER TABLE "tenant_config" ADD COLUMN "webhook_ip_allowlist_cidrs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "ip_allowlist_cidrs" jsonb DEFAULT '[]'::jsonb NOT NULL;
