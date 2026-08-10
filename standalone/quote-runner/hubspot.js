/**
 * Minimal HubSpot v3 CRM client (raw fetch — no @hubspot/api-client dep).
 *
 * Only the endpoints the quote pipeline needs:
 *   - product.search by hs_sku, product.create
 *   - lineItem.create with product + deal associations
 *   - quote.create with template + deal + line-item associations
 *   - quote.update (approve)
 *   - quote.get (poll for hs_quote_link)
 *
 * All calls carry the Private App bearer token from env; caller supplies it via
 * the `token` parameter.
 */

const BASE = 'https://api.hubapi.com';

// HubSpot association type IDs (see docs: crm/v4/schema/associations).
const ASSOC = {
  LINE_ITEM_TO_PRODUCT: 20,
  LINE_ITEM_TO_DEAL: 19,
  QUOTE_TO_TEMPLATE: 286,
  QUOTE_TO_DEAL: 64,
  QUOTE_TO_LINE_ITEM: 67,
};

async function hs(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (res.status >= 400) {
    const err = new Error(
      `hubspot ${method} ${path} failed: ${res.status} ${typeof parsed === 'string' ? parsed : (parsed && parsed.message) || ''}`,
    );
    err.upstreamStatus = res.status;
    err.upstreamBody = parsed;
    throw err;
  }
  return parsed;
}

async function findProductBySku(token, sku) {
  const body = {
    filterGroups: [{ filters: [{ propertyName: 'hs_sku', operator: 'EQ', value: sku }] }],
    properties: ['hs_sku'],
    limit: 1,
  };
  const res = await hs(token, 'POST', '/crm/v3/objects/products/search', body);
  const first = res && Array.isArray(res.results) ? res.results[0] : undefined;
  return first ? { id: first.id, sku } : null;
}

async function upsertProductBySku(token, input) {
  const existing = await findProductBySku(token, input.sku);
  if (existing) return existing;
  const created = await hs(token, 'POST', '/crm/v3/objects/products', {
    properties: {
      name: input.name,
      description: input.description || '',
      price: String(input.price),
      hs_sku: input.sku,
    },
  });
  return { id: created.id, sku: input.sku };
}

async function createLineItem(token, input) {
  const properties = {
    hs_product_id: input.productId,
    name: input.name,
    quantity: String(input.quantity),
    price: String(input.price),
  };
  if (input.description) properties.description = input.description;

  const associations = [
    {
      to: { id: input.productId },
      types: [
        { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.LINE_ITEM_TO_PRODUCT },
      ],
    },
    {
      to: { id: String(input.dealId) },
      types: [
        { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.LINE_ITEM_TO_DEAL },
      ],
    },
  ];
  const created = await hs(token, 'POST', '/crm/v3/objects/line_items', {
    properties,
    associations,
  });
  return { id: created.id };
}

async function createQuote(token, input) {
  const expiration = new Date(Date.now() + input.expirationDays * 86_400_000)
    .toISOString()
    .split('T')[0];

  const associations = [
    {
      to: { id: input.quoteTemplateId },
      types: [
        { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.QUOTE_TO_TEMPLATE },
      ],
    },
    {
      to: { id: String(input.dealId) },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.QUOTE_TO_DEAL }],
    },
    ...input.lineItemIds.map((id) => ({
      to: { id },
      types: [
        { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOC.QUOTE_TO_LINE_ITEM },
      ],
    })),
  ];

  const properties = {
    hs_title: input.title,
    hs_expiration_date: expiration,
    hs_currency: input.currency,
  };
  if (input.ownerId) properties.hubspot_owner_id = String(input.ownerId);

  const created = await hs(token, 'POST', '/crm/v3/objects/quotes', {
    properties,
    associations,
  });
  return { id: created.id, expirationDate: expiration };
}

async function approveQuote(token, quoteId) {
  await hs(token, 'PATCH', `/crm/v3/objects/quotes/${encodeURIComponent(quoteId)}`, {
    properties: { hs_status: 'APPROVED' },
  });
}

async function pollQuoteLink(token, quoteId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    try {
      const q = await hs(
        token,
        'GET',
        `/crm/v3/objects/quotes/${encodeURIComponent(quoteId)}?properties=hs_quote_link`,
      );
      const link = q && q.properties ? q.properties.hs_quote_link : null;
      if (link) return link;
    } catch {
      // ignore transient errors while polling
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function updateDealProperties(token, dealId, properties) {
  await hs(token, 'PATCH', `/crm/v3/objects/deals/${encodeURIComponent(String(dealId))}`, {
    properties,
  });
}

module.exports = {
  upsertProductBySku,
  createLineItem,
  createQuote,
  approveQuote,
  pollQuoteLink,
  updateDealProperties,
};
