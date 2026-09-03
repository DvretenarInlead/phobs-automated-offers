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
import { and, eq, like } from 'drizzle-orm';
import { db, pg } from '../db/client.js';
import { auditLog, idempotencyKeys, jobSteps } from '../db/schema.js';
import { getQueue } from '../queue/index.js';
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
  // job for this hub whose raw payload mentions the deal id (manual triggers
  // have random ids).
  const queue = getQueue();
  const jobs = await queue.getJobs(['completed', 'failed', 'delayed', 'waiting', 'active', 'paused'], 0, 5000, false);
  for (const job of jobs) {
    if (!job) continue;
    const data = job.data as { hubId?: string; rawPayload?: unknown } | undefined;
    const idMatch = typeof job.id === 'string' && job.id.includes(idFragment);
    const payloadMatch =
      data?.hubId === hubRaw && JSON.stringify(data.rawPayload ?? null).includes(dealRaw);
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
