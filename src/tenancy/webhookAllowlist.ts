import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenantConfig } from '../db/schema.js';
import { compileAllowlist } from '../lib/ipAllowlist.js';
import type { CompiledAllowlist } from '../lib/ipAllowlist.js';

/**
 * Loads and caches the webhook IP allow-list for a tenant. Cache TTL is
 * short (30s) so admin changes in the UI propagate quickly without waiting
 * for a full deploy or restart. Cache miss = one small SELECT.
 *
 * `null` result means "no tenant config row" (which we treat as no
 * restriction; the signature/JWT check has already established the caller
 * is legitimate HubSpot for that hub_id).
 */

interface CacheEntry {
  compiled: CompiledAllowlist;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

export async function loadWebhookAllowlist(hubId: bigint): Promise<CompiledAllowlist> {
  const key = hubId.toString();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.compiled;

  const [row] = await db
    .select({ webhookIpAllowlistCidrs: tenantConfig.webhookIpAllowlistCidrs })
    .from(tenantConfig)
    .where(eq(tenantConfig.hubId, hubId))
    .limit(1);

  const cidrs = (row?.webhookIpAllowlistCidrs as string[] | null) ?? [];
  const compiled = compileAllowlist(cidrs);
  cache.set(key, { compiled, expiresAt: now + CACHE_TTL_MS });
  return compiled;
}

/** Test helper — evicts a tenant so the next call re-reads from DB. */
export function invalidateWebhookAllowlist(hubId: bigint): void {
  cache.delete(hubId.toString());
}
