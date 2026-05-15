import type { Client as HubSpotClient } from '@hubspot/api-client';
import { AssociationSpecAssociationCategoryEnum } from '@hubspot/api-client/lib/codegen/crm/line_items/index.js';
import { callWithRetry } from '../lib/retry.js';
import { ExternalServiceError } from '../lib/errors.js';

const HUBSPOT_DEFINED = AssociationSpecAssociationCategoryEnum.HubspotDefined;
const ASSOC_LINE_ITEM_TO_PRODUCT = 20;
const ASSOC_LINE_ITEM_TO_DEAL = 19;

export interface CreateLineItemInput {
  productId: string;
  dealId: bigint;
  name: string;
  quantity: number;
  price: number;
  currency: string;
  description?: string;
}

export interface LineItemRef {
  id: string;
}

export async function createLineItem(
  hs: HubSpotClient,
  input: CreateLineItemInput,
): Promise<LineItemRef> {
  return callWithRetry('hubspot', 'lineItem.create', async () => {
    try {
      const properties: Record<string, string> = {
        hs_product_id: input.productId,
        name: input.name,
        quantity: input.quantity.toString(),
        price: input.price.toString(),
      };
      if (input.description) properties.description = input.description;

      const created = await hs.crm.lineItems.basicApi.create({
        properties,
        associations: [
          {
            to: { id: input.productId },
            types: [
              {
                associationCategory: HUBSPOT_DEFINED,
                associationTypeId: ASSOC_LINE_ITEM_TO_PRODUCT,
              },
            ],
          },
          {
            to: { id: input.dealId.toString() },
            types: [
              {
                associationCategory: HUBSPOT_DEFINED,
                associationTypeId: ASSOC_LINE_ITEM_TO_DEAL,
              },
            ],
          },
        ],
      });
      return { id: created.id };
    } catch (err) {
      const status = extractStatus(err);
      throw new ExternalServiceError(
        'hubspot',
        `lineItem.create failed: ${String(err)}`,
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
