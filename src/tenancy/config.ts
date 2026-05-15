import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenantConfig, tenants } from '../db/schema.js';
import { openUtf8 } from '../crypto/tokenVault.js';
import { TenantNotFoundError, TenantSuspendedError } from '../lib/errors.js';
import type { PropertyRules } from './childAgeRules.js';
import type { RateFilters } from './rateFilters.js';

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
    accessCode: cfg.accessCode,
    propertyRules: cfg.propertyRules as PropertyRules,
    rateFilters: cfg.rateFilters as RateFilters,
    triggerMode: (cfg.triggerMode as 'webhook' | 'workflow_extension') ?? 'webhook',
  };
}
