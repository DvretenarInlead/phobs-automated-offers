import type { Client as HubSpotClient } from '@hubspot/api-client';
import { callWithRetry } from '../lib/retry.js';
import { ExternalServiceError } from '../lib/errors.js';

export async function updateDeal(
  hs: HubSpotClient,
  dealId: bigint,
  properties: Record<string, string>,
): Promise<void> {
  await callWithRetry('hubspot', 'deal.update', async () => {
    try {
      await hs.crm.deals.basicApi.update(dealId.toString(), { properties });
    } catch (err) {
      const status = extractStatus(err);
      throw new ExternalServiceError('hubspot', `deal.update failed: ${String(err)}`, status, err);
    }
  });
}

export async function fetchDeal(
  hs: HubSpotClient,
  dealId: bigint,
  propertyNames: string[],
): Promise<Record<string, string | null>> {
  return callWithRetry('hubspot', 'deal.get', async () => {
    try {
      const res = await hs.crm.deals.basicApi.getById(dealId.toString(), propertyNames);
      return res.properties;
    } catch (err) {
      const status = extractStatus(err);
      throw new ExternalServiceError('hubspot', `deal.get failed: ${String(err)}`, status, err);
    }
  });
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const e = err as { code?: number; response?: { status?: number } };
    return e.code ?? e.response?.status;
  }
  return undefined;
}
