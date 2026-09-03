/**
 * DigitalOcean Function — availability sync + line-item creation.
 *
 * Invoke it via its web URL (a plain webhook):
 *   1. builds a `PCPropertyAvailabilityRQ`, POSTs it to Phobs, parses the XML
 *   2. selects offers: drops zero-availability / zero-price rows, sorts by
 *      price ascending, caps at `maxResults`
 *   3. upserts a HubSpot product per offer (hs_sku = propertyId:unitId:rateId)
 *   4. creates a HubSpot line item per offer, associated to the deal
 *   5. (optional) writes `phobs_availability_status` back to the deal
 *
 * Stops there — no quote. Use standalone/quote-runner (in this repo) if you
 * also want quote creation, or the main app for the full pipeline.
 *
 * Config comes from env (see project.yml / .env.example):
 *   PHOBS_ENDPOINT, PHOBS_SITE_ID, PHOBS_USERNAME, PHOBS_PASSWORD
 *   HUBSPOT_ACCESS_TOKEN   — Private App token
 *   API_TOKEN              — optional; when set, callers must send
 *                            `Authorization: Bearer <API_TOKEN>`
 *   WRITEBACK_STATUS       — set to 'false' to skip the deal status writeback
 *
 * Example webhook payload — see README.md for the full field list:
 *   {
 *     "dealId": "12345",
 *     "propertyId": "P1",
 *     "checkInDate": "2026-07-20",
 *     "nights": 5,
 *     "adults": 2,
 *     "childAges": [8, 3],
 *     "unitIds": ["17173"],
 *     "maxResults": 5
 *   }
 *
 * Local test:
 *   npm install
 *   PHOBS_ENDPOINT=... PHOBS_SITE_ID=... PHOBS_USERNAME=... PHOBS_PASSWORD=... \
 *   HUBSPOT_ACCESS_TOKEN=... node index.js '{"dealId":"12345", ...}'
 */

const { XMLBuilder, XMLParser } = require('fast-xml-parser');
const crypto = require('node:crypto');

// ---------- Phobs XML ------------------------------------------------------

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: false,
  processEntities: true, // escape <>&"' correctly
});

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false, // no external-entity resolution -> no XXE
  allowBooleanAttributes: false,
  parseTagValue: true,
  parseAttributeValue: true,
  trimValues: true,
});

function buildAvailabilityRequest(input) {
  const unitFilter = {
    Date: input.checkInDate,
    Nights: input.nights,
    UnitItem: {
      Item: {
        Adults: input.adults,
        ...(input.childAges && input.childAges.length > 0
          ? { Children: { ChildAge: input.childAges } }
          : {}),
      },
    },
    IncludeRestricted: input.includeRestricted ?? false,
  };
  if (input.unitIds && input.unitIds.length > 0) unitFilter.UnitId = input.unitIds;
  if (input.accessCode) unitFilter.AccessCode = input.accessCode;

  const doc = {
    '?xml': { '@_version': '1.0', '@_encoding': 'utf-8' },
    PCPropertyAvailabilityRQ: {
      '@_Lang': input.lang || 'en',
      Auth: {
        SiteId: input.siteId,
        Username: input.username,
        Password: input.password,
      },
      PropertyId: input.propertyId,
      RateId: '',
      UnitFilter: unitFilter,
    },
  };
  return builder.build(doc);
}

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
function n(v) {
  const x = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(x) ? x : 0;
}
function s(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object' && '#text' in v) {
    const t = v['#text'];
    if (typeof t === 'string') return t;
    if (typeof t === 'number') return String(t);
  }
  return '';
}

function parseAvailabilityResponse(xml) {
  const doc = parser.parse(xml);
  const root = doc.PCPropertyAvailabilityRS ?? {};
  const availability = root.AvailabilityList ?? {};
  const ratePlans = toArray((availability.RatePlans ?? {}).RatePlan);

  const rates = ratePlans.map((rp) => {
    const units = toArray((rp.Units ?? {}).Unit);
    return {
      rateId: s(rp['@_RateId']),
      name: s(rp.Name),
      shortDescription: s(rp.ShortDescription),
      units: units.map((u) => {
        const rate = u.Rate ?? {};
        const price = rate.Price ?? {};
        const stayTotal = rate.StayTotal ?? {};
        return {
          unitId: s(u['@_UnitId']),
          name: s(u.Name),
          availableUnits: n(u['@_AvailableUnits']),
          board: s(rate.Board),
          pricePerNight: n(
            typeof price === 'object' && price !== null
              ? price['#text'] ?? rate.Price
              : rate.Price,
          ),
          stayTotal: n(stayTotal.Price),
          currency: s(stayTotal.Currency ?? price['@_Currency']),
        };
      }),
    };
  });

  const responseType = root.ResponseType ?? {};
  const success = 'Success' in responseType;
  const error =
    'Errors' in responseType && responseType.Errors && responseType.Errors.Error
      ? s(responseType.Errors.Error.Message ?? responseType.Errors.Error)
      : null;

  return { success, error, rates };
}

async function fetchAvailability(endpoint, req, timeoutMs) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') {
    throw Object.assign(new Error('PHOBS_ENDPOINT must be https://'), { code: 'insecure_endpoint' });
  }
  const xml = buildAvailabilityRequest(req);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs ?? 15_000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      body: xml,
      headers: { 'content-type': 'application/xml; charset=utf-8' },
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (res.status >= 400) {
    throw Object.assign(new Error(`phobs HTTP ${res.status}`), {
      code: 'phobs_http_error',
      upstreamStatus: res.status,
      upstreamBody: text.slice(0, 2000),
    });
  }
  return parseAvailabilityResponse(text);
}

// ---------- HubSpot (raw CRM v3 REST) -------------------------------------

const HS_BASE = 'https://api.hubapi.com';
const ASSOC = { LINE_ITEM_TO_PRODUCT: 20, LINE_ITEM_TO_DEAL: 19 };

async function hs(token, method, path, body) {
  const res = await fetch(`${HS_BASE}${path}`, {
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

async function upsertProductBySku(token, input) {
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

async function createLineItem(token, input) {
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

async function updateDealProperties(token, dealId, properties) {
  await hs(token, 'PATCH', `/crm/v3/objects/deals/${encodeURIComponent(String(dealId))}`, {
    properties,
  });
}

// ---------- selection + validation ----------------------------------------

function selectOffers(rates, maxResults) {
  const flat = [];
  for (const rate of rates) {
    for (const unit of rate.units) {
      if (unit.availableUnits <= 0) continue;
      if (unit.pricePerNight <= 0) continue;
      flat.push({ rate, unit });
    }
  }
  flat.sort((a, b) => a.unit.pricePerNight - b.unit.pricePerNight);
  return flat.slice(0, maxResults ?? flat.length);
}

function validate(args, creds) {
  const errors = [];
  const str = (k) => {
    const v = args[k];
    if (typeof v !== 'string' || v.length === 0) errors.push(`${k} required (string)`);
  };
  const num = (k, min) => {
    const v = args[k];
    const x = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(x) || x < min) errors.push(`${k} required (number >= ${min})`);
  };

  str('dealId');
  str('propertyId');
  str('checkInDate');
  if (args.checkInDate && !/^\d{4}-\d{2}-\d{2}$/.test(args.checkInDate)) {
    errors.push('checkInDate must be YYYY-MM-DD');
  }
  num('nights', 1);
  num('adults', 0);
  if (Number(args.nights) > 60) errors.push('nights must be <= 60');
  if (Number(args.adults) > 20) errors.push('adults must be <= 20');
  // Arrays are typed strictly: an object element would be serialised by the
  // XML builder as nested elements inside <ChildAge>/<UnitId>.
  if (
    args.childAges !== undefined &&
    (!Array.isArray(args.childAges) ||
      args.childAges.length > 10 ||
      !args.childAges.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 17))
  ) {
    errors.push('childAges must be an array of up to 10 numbers (0-17)');
  }
  if (
    args.unitIds !== undefined &&
    (!Array.isArray(args.unitIds) ||
      args.unitIds.length > 50 ||
      !args.unitIds.every((u) => typeof u === 'string' && u.length > 0 && u.length <= 64))
  ) {
    errors.push('unitIds must be an array of up to 50 strings');
  }
  if (args.maxResults !== undefined) {
    const m = Number(args.maxResults);
    if (!Number.isFinite(m) || m < 1 || m > 50) errors.push('maxResults must be 1-50');
  }
  // Scalars must be strings: an object here would be serialised by the XML
  // builder as nested elements (tag-name injection into the request).
  for (const k of ['accessCode', 'lang', 'dealId', 'propertyId', 'checkInDate']) {
    if (args[k] !== undefined && (typeof args[k] !== 'string' || args[k].length > 128)) {
      errors.push(`${k} must be a string of at most 128 characters`);
    }
  }
  if (args.includeRestricted !== undefined && typeof args.includeRestricted !== 'boolean') {
    errors.push('includeRestricted must be a boolean');
  }

  if (!creds.endpoint) errors.push('missing env: PHOBS_ENDPOINT');
  if (!creds.siteId) errors.push('missing env: PHOBS_SITE_ID');
  if (!creds.username) errors.push('missing env: PHOBS_USERNAME');
  if (!creds.password) errors.push('missing env: PHOBS_PASSWORD');
  if (!creds.hubspotToken) errors.push('missing env: HUBSPOT_ACCESS_TOKEN');
  return errors;
}

function timingSafeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------- handler --------------------------------------------------------

async function main(args) {
  const started = Date.now();

  // Bearer gate — mandatory. This action writes to the CRM with a private-app
  // token, so it must never be reachable unauthenticated.
  const apiToken = process.env.API_TOKEN || '';
  if (!apiToken) {
    return { statusCode: 500, body: { error: 'server_misconfigured', message: 'API_TOKEN not set' } };
  }
  {
    const headers = args.__ow_headers || {};
    const auth = headers.authorization || '';
    const supplied = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!timingSafeEq(supplied, apiToken)) {
      return { statusCode: 401, body: { error: 'unauthorized' } };
    }
  }

  const creds = {
    endpoint: process.env.PHOBS_ENDPOINT || '',
    siteId: process.env.PHOBS_SITE_ID || '',
    username: process.env.PHOBS_USERNAME || '',
    password: process.env.PHOBS_PASSWORD || '',
    hubspotToken: process.env.HUBSPOT_ACCESS_TOKEN || '',
  };
  const writeback = process.env.WRITEBACK_STATUS !== 'false';

  const errors = validate(args, creds);
  if (errors.length > 0) {
    return { statusCode: 400, body: { error: 'validation_failed', details: errors } };
  }

  const nights = Number(args.nights);
  const adults = Number(args.adults);

  // 1. Phobs availability
  let availability;
  try {
    availability = await fetchAvailability(creds.endpoint, {
      lang: args.lang || 'en',
      propertyId: args.propertyId,
      checkInDate: args.checkInDate,
      nights,
      adults,
      childAges: args.childAges || [],
      unitIds: args.unitIds || [],
      accessCode: args.accessCode,
      includeRestricted: args.includeRestricted,
      siteId: creds.siteId,
      username: creds.username,
      password: creds.password,
    }, args.timeoutMs);
  } catch (err) {
    return {
      statusCode: 502,
      body: {
        error: err.code || 'phobs_error',
        message: err.message,
        upstreamStatus: err.upstreamStatus,
        latencyMs: Date.now() - started,
      },
    };
  }

  if (!availability.success) {
    return {
      statusCode: 502,
      body: {
        error: 'phobs_error',
        message: availability.error || 'phobs returned no Success',
        latencyMs: Date.now() - started,
      },
    };
  }

  // 2. Select offers
  const maxResults = args.maxResults !== undefined ? Number(args.maxResults) : undefined;
  const selected = selectOffers(availability.rates, maxResults);
  const ratesFound = availability.rates.reduce((sum, r) => sum + r.units.length, 0);

  if (selected.length === 0) {
    if (writeback) {
      try {
        await updateDealProperties(creds.hubspotToken, args.dealId, {
          phobs_availability_status: 'no_availability',
        });
      } catch {
        // best-effort
      }
    }
    return {
      statusCode: 200,
      body: {
        ok: true,
        outcome: 'no_availability',
        rates: { found: ratesFound, selected: 0 },
        lineItems: [],
        latencyMs: Date.now() - started,
      },
    };
  }

  // 3 + 4. Products + line items
  const lineItems = [];
  try {
    for (const sel of selected) {
      const sku = `${args.propertyId}:${sel.unit.unitId}:${sel.rate.rateId}`;
      const product = await upsertProductBySku(creds.hubspotToken, {
        sku,
        name: `${sel.unit.name} — ${sel.rate.name}`,
        description: sel.rate.shortDescription,
        price: sel.unit.pricePerNight,
      });
      const li = await createLineItem(creds.hubspotToken, {
        productId: product.id,
        dealId: args.dealId,
        name: `${sel.unit.name} — ${sel.rate.name}`,
        quantity: nights,
        price: sel.unit.pricePerNight,
        description: sel.rate.shortDescription,
      });
      lineItems.push({
        id: li.id,
        productId: product.id,
        productCreated: product.created,
        sku,
        name: `${sel.unit.name} — ${sel.rate.name}`,
        quantity: nights,
        pricePerNight: sel.unit.pricePerNight,
        stayTotal: sel.unit.stayTotal,
        currency: sel.unit.currency,
        board: sel.unit.board,
        unitId: sel.unit.unitId,
        rateId: sel.rate.rateId,
      });
    }
  } catch (err) {
    return {
      statusCode: 502,
      body: {
        error: err.code || 'hubspot_error',
        message: err.message,
        upstreamStatus: err.upstreamStatus,
        // partial progress so the caller can see what was already created
        createdLineItems: lineItems,
        latencyMs: Date.now() - started,
      },
    };
  }

  // 5. Deal status writeback (best-effort)
  if (writeback) {
    try {
      await updateDealProperties(creds.hubspotToken, args.dealId, {
        phobs_availability_status: 'available',
      });
    } catch {
      // do not fail the response for a writeback error
    }
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      dealId: args.dealId,
      rates: { found: ratesFound, selected: selected.length },
      lineItems,
      latencyMs: Date.now() - started,
    },
  };
}

module.exports = { main, selectOffers, validate, parseAvailabilityResponse };

// ---------- local runner ---------------------------------------------------

if (require.main === module) {
  const raw = process.argv[2];
  if (!raw) {
    console.error('Usage: node index.js \'{"dealId":"...","propertyId":"...","checkInDate":"YYYY-MM-DD","nights":5,"adults":2}\'');
    process.exit(1);
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    console.error('Invalid JSON:', e.message);
    process.exit(1);
  }
  main(input)
    .then((r) => {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      process.exit(r.statusCode >= 400 ? 1 : 0);
    })
    .catch((e) => {
      console.error('handler crashed:', e);
      process.exit(1);
    });
}
