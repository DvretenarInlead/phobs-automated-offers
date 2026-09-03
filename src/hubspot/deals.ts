import type { Client as HubSpotClient } from '@hubspot/api-client';
import { callWithRetry } from '../lib/retry.js';
import { hubspotError } from './errors.js';

export async function updateDeal(
  hs: HubSpotClient,
  dealId: bigint,
  properties: Record<string, string>,
): Promise<void> {
  await callWithRetry('hubspot', 'deal.update', async () => {
    try {
      await hs.crm.deals.basicApi.update(dealId.toString(), { properties });
    } catch (err) {
      throw hubspotError('deal.update', err);
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
      throw hubspotError('deal.get', err);
    }
  });
}
