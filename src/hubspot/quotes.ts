import type { Client as HubSpotClient } from '@hubspot/api-client';
import { AssociationSpecAssociationCategoryEnum } from '@hubspot/api-client/lib/codegen/crm/quotes/index.js';
import { setTimeout as delay } from 'node:timers/promises';
import { callWithRetry } from '../lib/retry.js';
import { ExternalServiceError } from '../lib/errors.js';

const HUBSPOT_DEFINED = AssociationSpecAssociationCategoryEnum.HubspotDefined;
const ASSOC_QUOTE_TO_TEMPLATE = 286;
const ASSOC_QUOTE_TO_DEAL = 64;
const ASSOC_QUOTE_TO_LINE_ITEM = 67;

export interface CreateQuoteInput {
  dealId: bigint;
  quoteTemplateId: string;
  ownerId: bigint;
  lineItemIds: string[];
  title: string;
  expirationDays: number;
  currency: string;
}

export interface QuoteRef {
  id: string;
  link: string | null;
}

export async function createApprovedQuote(
  hs: HubSpotClient,
  input: CreateQuoteInput,
): Promise<QuoteRef> {
  const expiration = new Date(Date.now() + input.expirationDays * 86_400_000);
  const expirationDate = expiration.toISOString().split('T')[0]!;

  const created = await callWithRetry('hubspot', 'quote.create', async () => {
    try {
      const res = await hs.crm.quotes.basicApi.create({
        properties: {
          hs_title: input.title,
          hs_expiration_date: expirationDate,
          hs_currency: input.currency,
          hubspot_owner_id: input.ownerId.toString(),
        },
        associations: [
          {
            to: { id: input.quoteTemplateId },
            types: [
              {
                associationCategory: HUBSPOT_DEFINED,
                associationTypeId: ASSOC_QUOTE_TO_TEMPLATE,
              },
            ],
          },
          {
            to: { id: input.dealId.toString() },
            types: [
              {
                associationCategory: HUBSPOT_DEFINED,
                associationTypeId: ASSOC_QUOTE_TO_DEAL,
              },
            ],
          },
          ...input.lineItemIds.map((id) => ({
            to: { id },
            types: [
              {
                associationCategory: HUBSPOT_DEFINED,
                associationTypeId: ASSOC_QUOTE_TO_LINE_ITEM,
              },
            ],
          })),
        ],
      });
      return res.id;
    } catch (err) {
      const status = extractStatus(err);
      throw new ExternalServiceError(
        'hubspot',
        `quote.create failed: ${String(err)}`,
        status,
        err,
      );
    }
  });

  await callWithRetry('hubspot', 'quote.approve', async () => {
    try {
      await hs.crm.quotes.basicApi.update(created, {
        properties: { hs_status: 'APPROVED' },
      });
    } catch (err) {
      const status = extractStatus(err);
      throw new ExternalServiceError(
        'hubspot',
        `quote.approve failed: ${String(err)}`,
        status,
        err,
      );
    }
  });

  const link = await pollQuoteLink(hs, created);
  return { id: created, link };
}

/**
 * After APPROVED, HubSpot needs a moment to materialise `hs_quote_link`.
 * Poll up to ~10s with 1s spacing — replaces the legacy `setTimeout(6000)`.
 */
async function pollQuoteLink(hs: HubSpotClient, quoteId: string): Promise<string | null> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const q = await hs.crm.quotes.basicApi.getById(quoteId, ['hs_quote_link']);
      const link = q.properties.hs_quote_link;
      if (link) return link;
    } catch {
      // ignore and retry
    }
    await delay(1000);
  }
  return null;
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const e = err as { code?: number; response?: { status?: number } };
    return e.code ?? e.response?.status;
  }
  return undefined;
}
