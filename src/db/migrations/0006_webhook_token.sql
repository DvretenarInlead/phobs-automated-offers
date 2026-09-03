-- Per-tenant webhook URL token (hash only). HubSpot signs deliveries with the
-- public app's client secret, shared by every installed portal; the token in
-- the signed URI binds a delivery to one tenant.
ALTER TABLE "tenant_config" ADD COLUMN "webhook_token_hash" text;
--> statement-breakpoint
ALTER TABLE "tenant_config" ADD COLUMN "webhook_token_created_at" timestamp with time zone;
