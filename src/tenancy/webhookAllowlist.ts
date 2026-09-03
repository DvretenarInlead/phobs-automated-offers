import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenantConfig } from '../db/schema.js';
import { compileAllowlist } from '../lib/ipAllowlist.js';
import type { CompiledAllowlist } from '../lib/ipAllowlist.js';

/**
 * Per-tenant webhook guard data — IP allow-list and the URL-token hash —
 * loaded together and cached briefly so the hot webhook path costs one
 * small SELECT per tenant per 30 s. Admin changes call
 * `invalidateWebhookAllowlist` so they apply immediately on this instance
 * (and within the TTL on any other instance).
 */

export interface WebhookGuard {
  /** Empty = no IP restriction. */
  allowlist: CompiledAllowlist;
  /** null = no config row / no token issued yet → every delivery is refused. */
  tokenHash: string | null;
}

interface CacheEntry {
  guard: WebhookGuard;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

export async function loadWebhookGuard(hubId: bigint): Promise<WebhookGuard> {
  const key = hubId.toString();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.guard;

  const [row] = await db
    .select({
      webhookIpAllowlistCidrs: tenantConfig.webhookIpAllowlistCidrs,
      webhookTokenHash: tenantConfig.webhookTokenHash,
    })
    .from(tenantConfig)
    .where(eq(tenantConfig.hubId, hubId))
    .limit(1);

  const cidrs = (row?.webhookIpAllowlistCidrs as string[] | null) ?? [];
  const guard: WebhookGuard = {
    allowlist: compileAllowlist(cidrs),
    tokenHash: row?.webhookTokenHash ?? null,
  };
  cache.set(key, { guard, expiresAt: now + CACHE_TTL_MS });
  return guard;
}

export async function loadWebhookAllowlist(hubId: bigint): Promise<CompiledAllowlist> {
  return (await loadWebhookGuard(hubId)).allowlist;
}

/** Evicts a tenant so the next call re-reads from DB. */
export function invalidateWebhookAllowlist(hubId: bigint): void {
  cache.delete(hubId.toString());
}
