/**
 * Minimal HubSpot CRM v3 client (raw fetch) — products upsert by hs_sku,
 * line-item creation with deal association, deal property patch.
 * Same logic as standalone/quote-runner, ESM-ified for the MCP server.
 */

const BASE = 'https://api.hubapi.com';
const ASSOC = { LINE_ITEM_TO_PRODUCT: 20, LINE_ITEM_TO_DEAL: 19 };

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
    throw Object.assign(
      new Error(
        `hubspot ${method} ${path} failed: ${res.status} ${typeof parsed === 'string' ? parsed : (parsed && parsed.message) || ''}`,
      ),
      { code: 'hubspot_error', upstreamStatus: res.status, upstreamBody: parsed },
    );
  }
  return parsed;
}

export async function upsertProductBySku(token, input) {
  const search = await hs(token, 'POST', '/crm/v3/objects/products/search', {
    filterGroups: [{ filters: [{ propertyName: 'hs_sku', operator: 'EQ', value: input.sku }] }],
    properties: ['hs_sku'],
    limit: 1,
  });
  const first = search && Array.isArray(search.results) ? search.results[0] : undefined;
  if (first) return { id: first.id, sku: input.sku, created: false };

  const created = await hs(token, 'POST', '/crm/v3/objects/products', {
    properties: {
      name: input.name,
      description: input.description || '',
      price: String(input.price),
      hs_sku: input.sku,
    },
  });
  return { id: created.id, sku: input.sku, created: true };
}

export async function createLineItem(token, input) {
  const properties = {
    hs_product_id: input.productId,
    name: input.name,
    quantity: String(input.quantity),
    price: String(input.price),
  };
  if (input.description) properties.description = input.description;

  const created = await hs(token, 'POST', '/crm/v3/objects/line_items', {
    properties,
    associations: [
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
    ],
  });
  return { id: created.id };
}

export async function updateDealProperties(token, dealId, properties) {
  await hs(token, 'PATCH', `/crm/v3/objects/deals/${encodeURIComponent(String(dealId))}`, {
    properties,
  });
}
