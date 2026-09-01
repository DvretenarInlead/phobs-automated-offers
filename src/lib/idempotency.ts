import { createHash } from 'node:crypto';
import { lt, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';

export function idempotencyKeyFor(hubId: bigint, dealId: number | bigint, rawBody: Buffer): string {
  const h = createHash('sha256').update(rawBody).digest('hex');
  return createHash('sha256')
    .update(`${hubId.toString()}|${dealId.toString()}|${h}`)
    .digest('hex');
}

/**
 * Deterministic BullMQ job id for an idempotency key. BullMQ forbids ':' in
 * custom ids (and we don't want a raw client key in Redis anyway), so hash
 * it. Same key → same id, so a concurrent duplicate that slips past the DB
 * claim is still de-duplicated by the queue.
 */
export function jobIdFor(prefix: string, hubId: bigint, dealId: bigint, idemKey: string): string {
  const h = createHash('sha256').update(idemKey).digest('hex').slice(0, 16);
  return `${prefix}-${hubId.toString()}-${dealId.toString()}-${h}`;
}

/**
 * Returns true if this key was newly inserted (first-seen), false if it was
 * already present (HubSpot retry / duplicate webhook).
 */
export async function claimIdempotencyKey(
  key: string,
  jobId: string,
  hubId: bigint,
): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO ${idempotencyKeys} (key, job_id, hub_id)
    VALUES (${key}, ${jobId}, ${hubId})
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `);
  return result.length > 0;
}

/**
 * Undo a claim when the enqueue that followed it failed, so the next
 * delivery of the same event is processed instead of reported as a
 * duplicate forever.
 */
export async function releaseIdempotencyKey(key: string): Promise<void> {
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
}

/** Drops keys older than `days`. Called from the daily maintenance job. */
export async function purgeIdempotencyKeys(days = 7): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const res = await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, cutoff));
  return Number(res.count ?? 0);
}
