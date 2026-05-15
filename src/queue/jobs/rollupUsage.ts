import type { Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { logger } from '../../lib/logger.js';

/**
 * Daily rollup of per-tenant counters from audit_log and job_steps into
 * usage_daily. Runs once per day at ~03:10 UTC (scheduled via the queue).
 *
 * Idempotent: each run computes counts for "yesterday" (UTC) and upserts.
 */
export async function rollupUsageJob(job: Job): Promise<unknown> {
  const target = new Date();
  target.setUTCDate(target.getUTCDate() - 1);
  const day = target.toISOString().slice(0, 10);
  logger.info({ jobId: job.id, day }, 'rollupUsage starting');

  await db.execute(sql`
    INSERT INTO usage_daily AS u (
      hub_id, day, webhooks, phobs_calls, hubspot_calls, quotes_created, emails_sent
    )
    SELECT
      a.hub_id,
      ${day}::date,
      COALESCE(SUM((a.kind LIKE 'webhook%')::int), 0) AS webhooks,
      COALESCE(SUM((a.kind LIKE 'phobs%')::int), 0) AS phobs_calls,
      COALESCE(SUM((a.kind LIKE 'hubspot%')::int), 0) AS hubspot_calls,
      COALESCE(SUM((a.kind = 'process_deal.completed')::int), 0) AS quotes_created,
      0 AS emails_sent
    FROM audit_log a
    WHERE a.created_at >= ${day}::date
      AND a.created_at < (${day}::date + INTERVAL '1 day')
    GROUP BY a.hub_id
    ON CONFLICT (hub_id, day) DO UPDATE SET
      webhooks       = EXCLUDED.webhooks,
      phobs_calls    = EXCLUDED.phobs_calls,
      hubspot_calls  = EXCLUDED.hubspot_calls,
      quotes_created = EXCLUDED.quotes_created
  `);

  logger.info({ jobId: job.id, day }, 'rollupUsage complete');
  return { day };
}
