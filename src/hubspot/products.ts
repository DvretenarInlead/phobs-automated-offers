import type { Client as HubSpotClient } from '@hubspot/api-client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/products/index.js';
import { callWithRetry } from '../lib/retry.js';
import { ExternalServiceError } from '../lib/errors.js';

export interface ProductRef {
  id: string;
  sku: string;
}

export interface UpsertProductInput {
  sku: string;
  name: string;
  description: string;
  price: number;
  currency: string;
}

/**
 * Find a product by SKU, or create one. SKU pattern:
 *   `<portalId>:<unitId>:<rateId>`
 * is encoded by the caller; this module just trusts the supplied sku.
 */
export async function upsertProductBySku(
  hs: HubSpotClient,
  input: UpsertProductInput,
): Promise<ProductRef> {
  const existing = await findBySku(hs, input.sku);
  if (existing) return existing;

  return callWithRetry('hubspot', 'product.create', async () => {
    try {
      const created = await hs.crm.products.basicApi.create({
        properties: {
          name: input.name,
          description: input.description,
          price: input.price.toString(),
          hs_sku: input.sku,
        },
        associations: [],
      });
      return { id: created.id, sku: input.sku };
    } catch (err) {
      const status = extractStatus(err);
      throw new ExternalServiceError(
        'hubspot',
        `product.create failed: ${String(err)}`,
        status,
        err,
      );
    }
  });
}

async function findBySku(hs: HubSpotClient, sku: string): Promise<ProductRef | null> {
  return callWithRetry('hubspot', 'product.search', async () => {
    try {
      const res = await hs.crm.products.searchApi.doSearch({
        filterGroups: [
          {
            filters: [{ propertyName: 'hs_sku', operator: FilterOperatorEnum.Eq, value: sku }],
          },
        ],
        properties: ['hs_sku'],
        limit: 1,
        after: '0',
        sorts: [],
      });
      const first = res.results[0];
      return first ? { id: first.id, sku } : null;
    } catch (err) {
      const status = extractStatus(err);
      throw new ExternalServiceError(
        'hubspot',
        `product.search failed: ${String(err)}`,
        status,
        err,
      );
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
