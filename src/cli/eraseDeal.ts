/**
 * Data-subject erasure for one deal.
 *
 *   node dist/cli/eraseDeal.js --hub <hubId> --deal <dealId> [--dry-run]
 *
 * Removes every record this system holds for a deal: job_steps, audit_log,
 * idempotency keys, and BullMQ jobs (any state) whose id or payload refers to
 * the deal. Prints counts. Does NOT touch HubSpot or Phobs (the controller
 * handles those), platform logs (see GO-LIVE.md), or backups (age out per
 * the provider's retention).
 *
 * Deletion "by email" is not possible here — nothing is keyed by guest
 * identity. Resolve the contact to their deal id(s) in HubSpot first.
 */
import process from 'node:process';
import type { Job } from 'bullmq';
import { and, eq, like } from 'drizzle-orm';
import { db, pg } from '../db/client.js';
import { auditLog, idempotencyKeys, jobSteps } from '../db/schema.js';
import { getQueue } from '../queue/index.js';
import type { ProcessDealPayload } from '../queue/index.js';
import { writeAdminAudit } from '../admin/audit.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const hubRaw = arg('hub');
  const dealRaw = arg('deal');
  const dryRun = process.argv.includes('--dry-run');
  if (!hubRaw || !dealRaw || !/^\d+$/.test(hubRaw) || !/^\d+$/.test(dealRaw)) {
    console.error('Usage: node dist/cli/eraseDeal.js --hub <hubId> --deal <dealId> [--dry-run]');
    process.exit(2);
  }
  const hubId = BigInt(hubRaw);
  const dealId = BigInt(dealRaw);
  const idFragment = `-${hubRaw}-${dealRaw}-`;

  const counts = { jobSteps: 0, auditLog: 0, idempotencyKeys: 0, queueJobs: 0 };

  // Postgres
  if (dryRun) {
    counts.jobSteps = (
      await db.select({ id: jobSteps.id }).from(jobSteps).where(and(eq(jobSteps.hubId, hubId), eq(jobSteps.dealId, dealId)))
    ).length;
    counts.auditLog = (
      await db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.hubId, hubId), eq(auditLog.dealId, dealId)))
    ).length;
    counts.idempotencyKeys = (
      await db.select({ key: idempotencyKeys.key }).from(idempotencyKeys).where(and(eq(idempotencyKeys.hubId, hubId), like(idempotencyKeys.jobId, `%${idFragment}%`)))
    ).length;
  } else {
    counts.jobSteps = Number((await db.delete(jobSteps).where(and(eq(jobSteps.hubId, hubId), eq(jobSteps.dealId, dealId)))).count ?? 0);
    counts.auditLog = Number((await db.delete(auditLog).where(and(eq(auditLog.hubId, hubId), eq(auditLog.dealId, dealId)))).count ?? 0);
    counts.idempotencyKeys = Number(
      (await db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.hubId, hubId), like(idempotencyKeys.jobId, `%${idFragment}%`)))).count ?? 0,
    );
  }

  // Redis / BullMQ: jobs in every state whose id embeds hub+deal, plus any
  // job for this hub whose payload's deal id equals the target exactly
  // (manual triggers have random ids). Paginated so nothing is skipped.
  const queue = getQueue();
  const PAGE = 500;
  const states = ['completed', 'failed', 'delayed', 'waiting', 'active', 'paused'] as const;
  const payloadDealId = (raw: unknown): string | null => {
    const item = Array.isArray(raw) ? raw[0] : raw;
    if (!item || typeof item !== 'object') return null;
    const v = (item as Record<string, unknown>).hs_object_id;
    return typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint' ? String(v) : null;
  };
  for (const state of states) {
    for (let start = 0; ; start += PAGE) {
      // BullMQ's Queue is Queue<any> here; pin the job type for the loop.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const jobs: Job<ProcessDealPayload>[] = await queue.getJobs([state], start, start + PAGE - 1, false);
      if (jobs.length === 0) break;
      for (const job of jobs) {
        if (!job) continue;
        const data = job.data as { hubId?: string; rawPayload?: unknown } | undefined;
        const idMatch = typeof job.id === 'string' && job.id.includes(idFragment);
        const payloadMatch = data?.hubId === hubRaw && payloadDealId(data.rawPayload) === dealRaw;
        if (!idMatch && !payloadMatch) continue;
        counts.queueJobs++;
        if (!dryRun) {
          try {
            await job.remove();
          } catch (err) {
            console.error(`could not remove job ${String(job.id)}:`, err instanceof Error ? err.message : err);
          }
        }
      }
      if (jobs.length < PAGE) break;
    }
  }

  if (!dryRun) {
    // Recorded under the system actor (id 0) — this is a CLI, not a session.
    await writeAdminAudit({
      adminUserId: 0n,
      action: 'data.erase_deal',
      target: `hub_id=${hubRaw} deal_id=${dealRaw}`,
      after: counts,
    });
  }

  console.error(`${dryRun ? '[dry-run] would erase' : 'erased'} hub=${hubRaw} deal=${dealRaw}:`, counts);
  await queue.close();
  await pg.end({ timeout: 5 });
  process.exit(0);
}

main().catch(async (err: unknown) => {
  console.error('eraseDeal failed:', err instanceof Error ? err.message : err);
  await pg.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
});
