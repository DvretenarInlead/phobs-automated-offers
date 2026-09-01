-- TOTP replay protection: remember the last accepted time-step per admin.
ALTER TABLE "admin_users" ADD COLUMN "totp_last_step" bigint;
--> statement-breakpoint
-- Earlier builds persisted the full tenant context (including decrypted Phobs
-- credentials and the loyalty access code) into job_steps.output for the
-- load_tenant step, and the raw Phobs XML for the availability step. Scrub
-- existing rows; the worker no longer writes either.
UPDATE "job_steps"
SET "output" = '{"redacted": true, "reason": "security_hardening_0004"}'::jsonb
WHERE "step" = 'load_tenant' AND "output" IS NOT NULL;
--> statement-breakpoint
UPDATE "job_steps"
SET "output" = ("output" - 'rawXml')
WHERE "step" = 'phobs.availability' AND "output" ? 'rawXml';
