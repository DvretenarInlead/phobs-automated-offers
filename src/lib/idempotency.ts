import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { idempotencyKeys } from '../db/schema.js';

export function idempotencyKeyFor(hubId: bigint, dealId: number | bigint, rawBody: Buffer): string {
  const h = createHash('sha256').update(rawBody).digest('hex');
  return createHash('sha256')
    .update(`${hubId.toString()}|${dealId.toString()}|${h}`)
    .digest('hex');
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
