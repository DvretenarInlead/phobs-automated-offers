import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenantConfig, tenants } from '../db/schema.js';
import { openUtf8 } from '../crypto/tokenVault.js';
import { TenantNotFoundError, TenantSuspendedError } from '../lib/errors.js';
import type { PropertyRules } from './childAgeRules.js';
import type { RateFilters } from './rateFilters.js';
import { resolveOverrides } from './overrides.js';
import type { Overrides } from './overrides.js';

export interface HubdbColumnMap {
  unit_id_column?: string;
  property_id_column?: string;
  [k: string]: string | undefined;
}

export interface TenantContext {
  hubId: bigint;
  status: string;
  phobs: {
    endpoint: string;
    siteId: string;
    username: string;
    password: string;
  };
  hubdbTableId: string;
  hubdbColumnMap: HubdbColumnMap;
  quoteTemplateId: string;
  ownerId: bigint;
  accessCode: string | null;
  propertyRules: PropertyRules;
  rateFilters: RateFilters | Record<string, never>;
  triggerMode: 'webhook' | 'workflow_extension';
  overrides: Overrides;
}

/** AAD for the vaulted loyalty access code. */
export function accessCodeAad(hubId: bigint): string {
  return `phobs_access_code:${hubId}`;
}

/**
 * Reads the loyalty access code: vaulted columns first, legacy plaintext
 * column as fallback (until the maintenance job has re-sealed it).
 */
export function readAccessCode(
  cfg: Pick<
    typeof tenantConfig.$inferSelect,
    'hubId' | 'accessCode' | 'accessCodeCt' | 'accessCodeIv' | 'accessCodeTag'
  >,
): string | null {
  if (cfg.accessCodeCt && cfg.accessCodeIv && cfg.accessCodeTag) {
    return openUtf8(
      { ct: cfg.accessCodeCt, iv: cfg.accessCodeIv, tag: cfg.accessCodeTag },
      accessCodeAad(cfg.hubId),
    );
  }
  return cfg.accessCode ?? null;
}

export function hasAccessCode(
  cfg: Pick<typeof tenantConfig.$inferSelect, 'accessCode' | 'accessCodeCt'>,
): boolean {
  return Boolean(cfg.accessCodeCt) || Boolean(cfg.accessCode);
}

export async function loadTenantContext(hubId: bigint): Promise<TenantContext> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.hubId, hubId)).limit(1);
  if (!tenant) throw new TenantNotFoundError(hubId);
  if (tenant.status !== 'active') throw new TenantSuspendedError(hubId);

  const [cfg] = await db
    .select()
    .from(tenantConfig)
    .where(eq(tenantConfig.hubId, hubId))
    .limit(1);
  if (!cfg) throw new TenantNotFoundError(hubId);

  const username = openUtf8(
    { ct: cfg.phobsAuthUserCt, iv: cfg.phobsAuthUserIv, tag: cfg.phobsAuthUserTag },
    `phobs_user:${hubId}`,
  );
  const password = openUtf8(
    { ct: cfg.phobsAuthPassCt, iv: cfg.phobsAuthPassIv, tag: cfg.phobsAuthPassTag },
    `phobs_pass:${hubId}`,
  );

  return {
    hubId,
    status: tenant.status,
    phobs: {
      endpoint: cfg.phobsEndpoint,
      siteId: cfg.phobsSiteId,
      username,
      password,
    },
    hubdbTableId: cfg.hubdbTableId,
    hubdbColumnMap: cfg.hubdbColumnMap as HubdbColumnMap,
    quoteTemplateId: cfg.quoteTemplateId,
    ownerId: cfg.ownerId,
    accessCode: readAccessCode(cfg),
    propertyRules: cfg.propertyRules as PropertyRules,
    rateFilters: cfg.rateFilters as RateFilters,
    triggerMode: (cfg.triggerMode as 'webhook' | 'workflow_extension') ?? 'webhook',
    overrides: resolveOverrides(cfg.overrides),
  };
}
