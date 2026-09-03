-- Loyalty access code moves into the vault (AES-256-GCM, AAD-bound). The
-- legacy plaintext column stays until the maintenance job has re-sealed every
-- row (it nulls access_code as it goes); a later migration drops it.
ALTER TABLE "tenant_config" ADD COLUMN "access_code_ct" bytea;
--> statement-breakpoint
ALTER TABLE "tenant_config" ADD COLUMN "access_code_iv" bytea;
--> statement-breakpoint
ALTER TABLE "tenant_config" ADD COLUMN "access_code_tag" bytea;
--> statement-breakpoint
-- Data-subject erasure and retention purges look rows up by deal.
CREATE INDEX IF NOT EXISTS "job_steps_deal_idx" ON "job_steps" ("deal_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_steps_created_idx" ON "job_steps" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_created_idx" ON "audit_log" ("created_at");
--> statement-breakpoint
-- Public HubSpot quote links were persisted in earlier builds; they are
-- reproducible from HubSpot with proper auth and are no longer stored.
UPDATE "job_steps"
SET "output" = ("output" - 'link')
WHERE "step" = 'quote.create_approve_fetch' AND "output" ? 'link';
--> statement-breakpoint
UPDATE "audit_log"
SET "response" = ("response" - 'quoteLink')
WHERE "kind" = 'process_deal.completed' AND "response" ? 'quoteLink';
