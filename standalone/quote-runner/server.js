/**
 * Standalone quote runner.
 *
 *   POST /run
 *   Content-Type: application/json
 *   Authorization: Bearer <API_TOKEN>          (only if API_TOKEN is set in env)
 *
 *   {
 *     "dealId": "12345",             // HubSpot deal to attach the quote to
 *     "propertyId": "P1",            // Phobs property id
 *     "checkInDate": "2026-07-20",   // YYYY-MM-DD
 *     "nights": 5,
 *     "adults": 2,
 *     "childAges": [8, 3],           // optional
 *     "unitIds": ["U1","U2"],        // optional filter
 *     "lang": "en",                  // optional
 *     "accessCode": "LOY-42",        // optional (loyalty)
 *     "currency": "EUR",             // optional; falls back to Phobs response
 *     "title": "Your offer",         // optional; defaults to a template
 *     "expirationDays": 3,           // optional; falls back to env
 *     "maxResults": 5                // optional cap on line items
 *   }
 *
 * Response (200):
 *   {
 *     "ok": true,
 *     "quote": { "id": "...", "link": "...", "expirationDate": "YYYY-MM-DD" },
 *     "lineItems": [{ "id": "...", "productId": "...", "name": "...",
 *                     "quantity": 5, "price": 100, "unitId": "U1", "rateId": "R1" }],
 *     "rates": { "found": 12, "selected": 3 },
 *     "latencyMs": 4213
 *   }
 *
 * Empty-availability outcome (200):
 *   { "ok": true, "outcome": "no_availability", "rates": { "found": 0, "selected": 0 } }
 *
 * All configuration comes from env vars — see README.md.
 */

const http = require('node:http');
const { fetchAvailability } = require('./phobs.js');
const {
  upsertProductBySku,
  createLineItem,
  createQuote,
  approveQuote,
  pollQuoteLink,
  updateDealProperties,
} = require('./hubspot.js');

const PORT = Number(process.env.PORT ?? 8080);
const MAX_BODY_BYTES = 1024 * 128; // 128 KiB — plenty for a booking payload

function cfg() {
  return {
    phobs: {
      endpoint: process.env.PHOBS_ENDPOINT || '',
      siteId: process.env.PHOBS_SITE_ID || '',
      username: process.env.PHOBS_USERNAME || '',
      password: process.env.PHOBS_PASSWORD || '',
    },
    hubspot: {
      token: process.env.HUBSPOT_ACCESS_TOKEN || '',
      quoteTemplateId: process.env.HUBSPOT_QUOTE_TEMPLATE_ID || '',
      ownerId: process.env.HUBSPOT_OWNER_ID || '',
    },
    quote: {
      expirationDays: Number(process.env.QUOTE_EXPIRATION_DAYS ?? 3),
      defaultCurrency: process.env.QUOTE_DEFAULT_CURRENCY || 'EUR',
      writeStatusToDeal: process.env.QUOTE_WRITEBACK_STATUS !== 'false',
    },
    apiToken: process.env.API_TOKEN || '',
  };
}

function assertEnv(c) {
  const missing = [];
  if (!c.phobs.endpoint) missing.push('PHOBS_ENDPOINT');
  if (!c.phobs.siteId) missing.push('PHOBS_SITE_ID');
  if (!c.phobs.username) missing.push('PHOBS_USERNAME');
  if (!c.phobs.password) missing.push('PHOBS_PASSWORD');
  if (!c.hubspot.token) missing.push('HUBSPOT_ACCESS_TOKEN');
  if (!c.hubspot.quoteTemplateId) missing.push('HUBSPOT_QUOTE_TEMPLATE_ID');
  return missing;
}

function validatePayload(body) {
  const errors = [];
  const s = (k, v) => {
    if (typeof v !== 'string' || v.length === 0) errors.push(`${k} required (string)`);
  };
  const num = (k, v, { min = 0 } = {}) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < min) errors.push(`${k} required (number ≥ ${min})`);
    return n;
  };

  s('dealId', body.dealId);
  s('propertyId', body.propertyId);
  s('checkInDate', body.checkInDate);
  if (body.checkInDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.checkInDate)) {
    errors.push('checkInDate must be YYYY-MM-DD');
  }
  const nights = num('nights', body.nights, { min: 1 });
  const adults = num('adults', body.adults, { min: 0 });
  if (nights > 60) errors.push('nights must be <= 60');
  if (adults > 20) errors.push('adults must be <= 20');
  // Arrays are typed strictly: an object element would be serialised by the
  // XML builder as nested elements inside <ChildAge>/<UnitId>.
  if (
    body.childAges !== undefined &&
    (!Array.isArray(body.childAges) ||
      body.childAges.length > 10 ||
      !body.childAges.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 17))
  ) {
    errors.push('childAges must be an array of up to 10 numbers (0-17)');
  }
  if (
    body.unitIds !== undefined &&
    (!Array.isArray(body.unitIds) ||
      body.unitIds.length > 50 ||
      !body.unitIds.every((u) => typeof u === 'string' && u.length > 0 && u.length <= 64))
  ) {
    errors.push('unitIds must be an array of up to 50 strings');
  }
  if (body.maxResults !== undefined) {
    const m = Number(body.maxResults);
    if (!Number.isFinite(m) || m < 1 || m > 50) errors.push('maxResults must be 1-50');
  }
  if (body.expirationDays !== undefined) {
    const d = Number(body.expirationDays);
    if (!Number.isFinite(d) || d < 1 || d > 365) errors.push('expirationDays must be 1-365');
  }
  // Scalars must be strings: an object here would be serialised by the XML
  // builder as nested elements (tag-name injection into the request).
  for (const k of ['accessCode', 'lang', 'dealId', 'propertyId', 'checkInDate', 'currency', 'title']) {
    if (body[k] !== undefined && (typeof body[k] !== 'string' || body[k].length > 500)) {
      errors.push(`${k} must be a string of at most 500 characters`);
    }
  }
  if (body.includeRestricted !== undefined && typeof body.includeRestricted !== 'boolean') {
    errors.push('includeRestricted must be a boolean');
  }
  return errors;
}

function selectOffers(rates, opts) {
  // Flatten (rate × unit) pairs, drop zero-availability + zero-price rows,
  // sort by price ascending, cap at maxResults.
  const flat = [];
  for (const rate of rates) {
    for (const unit of rate.units) {
      if (unit.availableUnits <= 0) continue;
      if (unit.pricePerNight <= 0) continue;
      flat.push({ rate, unit });
    }
  }
  flat.sort((a, b) => a.unit.pricePerNight - b.unit.pricePerNight);
  const cap = opts.maxResults ?? flat.length;
  return flat.slice(0, cap);
}

async function runPipeline(payload) {
  const c = cfg();
  const started = Date.now();

  // 1. Phobs availability
  const availability = await fetchAvailability(
    { endpoint: c.phobs.endpoint },
    {
      lang: payload.lang || 'en',
      propertyId: payload.propertyId,
      checkInDate: payload.checkInDate,
      nights: payload.nights,
      adults: payload.adults,
      childAges: payload.childAges || [],
      unitIds: payload.unitIds || [],
      accessCode: payload.accessCode,
      siteId: c.phobs.siteId,
      username: c.phobs.username,
      password: c.phobs.password,
    },
  );

  if (!availability.success) {
    const err = new Error(availability.error || 'phobs returned no Success');
    err.code = 'phobs_error';
    throw err;
  }

  // 2. Select offers (simple sort-by-price + cap)
  const selected = selectOffers(availability.rates, { maxResults: payload.maxResults });
  const ratesFound = availability.rates.reduce((sum, r) => sum + r.units.length, 0);

  if (selected.length === 0) {
    if (c.quote.writeStatusToDeal) {
      try {
        await updateDealProperties(c.hubspot.token, payload.dealId, {
          phobs_availability_status: 'no_availability',
        });
      } catch {
        // best-effort — surface pipeline outcome regardless
      }
    }
    return {
      ok: true,
      outcome: 'no_availability',
      rates: { found: ratesFound, selected: 0 },
      latencyMs: Date.now() - started,
    };
  }

  const currency =
    payload.currency || selected[0].unit.currency || c.quote.defaultCurrency;

  // 3. Products (find-or-create per rate×unit)
  const productIds = [];
  for (const sel of selected) {
    const sku = `${payload.propertyId}:${sel.unit.unitId}:${sel.rate.rateId}`;
    const p = await upsertProductBySku(c.hubspot.token, {
      sku,
      name: `${sel.unit.name} — ${sel.rate.name}`,
      description: sel.rate.shortDescription,
      price: sel.unit.pricePerNight,
      currency,
    });
    productIds.push(p.id);
  }

  // 4. Line items
  const lineItems = [];
  for (let i = 0; i < selected.length; i++) {
    const sel = selected[i];
    const productId = productIds[i];
    const li = await createLineItem(c.hubspot.token, {
      productId,
      dealId: payload.dealId,
      name: `${sel.unit.name} — ${sel.rate.name}`,
      quantity: payload.nights,
      price: sel.unit.pricePerNight,
      currency,
      description: sel.rate.shortDescription,
    });
    lineItems.push({
      id: li.id,
      productId,
      name: `${sel.unit.name} — ${sel.rate.name}`,
      quantity: payload.nights,
      price: sel.unit.pricePerNight,
      currency,
      unitId: sel.unit.unitId,
      rateId: sel.rate.rateId,
    });
  }

  // 5. Quote (create + approve + poll for link)
  const expirationDays = Number(payload.expirationDays ?? c.quote.expirationDays);
  const quote = await createQuote(c.hubspot.token, {
    dealId: payload.dealId,
    quoteTemplateId: c.hubspot.quoteTemplateId,
    ownerId: c.hubspot.ownerId || null,
    lineItemIds: lineItems.map((li) => li.id),
    title: payload.title || `This is your personalized offer #${payload.dealId}`,
    expirationDays,
    currency,
  });
  await approveQuote(c.hubspot.token, quote.id);
  const link = await pollQuoteLink(c.hubspot.token, quote.id);

  // 6. Write quote id + link back to the deal (best-effort)
  if (c.quote.writeStatusToDeal) {
    try {
      const props = { quote_id: quote.id, phobs_availability_status: 'available' };
      if (link) props.quote_link_custom = link;
      await updateDealProperties(c.hubspot.token, payload.dealId, props);
    } catch {
      // do not fail the response for a writeback error
    }
  }

  return {
    ok: true,
    quote: { id: quote.id, link, expirationDate: quote.expirationDate },
    lineItems,
    rates: { found: ratesFound, selected: selected.length },
    latencyMs: Date.now() - started,
  };
}

// ---- HTTP plumbing --------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('payload_too_large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function timingSafeTokenEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return require('node:crypto').timingSafeEqual(ab, bb);
}

async function handle(req, res) {
  if (req.method === 'GET' && req.url === '/healthz') {
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'POST' || req.url !== '/run') {
    return send(res, 404, { error: 'not_found' });
  }

  const c = cfg();

  // Auth before anything else — unauthenticated callers learn nothing about
  // the deployment (not even which env vars are missing).
  if (c.apiToken) {
    const auth = req.headers.authorization || '';
    const supplied = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!timingSafeTokenEq(supplied, c.apiToken)) {
      return send(res, 401, { error: 'unauthorized' });
    }
  }

  const missing = assertEnv(c);
  if (missing.length > 0) {
    return send(res, 500, { error: 'server_misconfigured', missing });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    return send(res, err.statusCode || 400, { error: err.message });
  }
  let body;
  try {
    body = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return send(res, 400, { error: 'invalid_json' });
  }

  const errors = validatePayload(body);
  if (errors.length > 0) {
    return send(res, 400, { error: 'validation_failed', details: errors });
  }

  try {
    const result = await runPipeline(body);
    return send(res, 200, result);
  } catch (err) {
    const payload = {
      error: err.code || 'pipeline_error',
      message: err.message,
    };
    if (err.upstreamStatus) payload.upstreamStatus = err.upstreamStatus;
    if (err.upstreamBody) payload.upstreamBody = err.upstreamBody;
    return send(res, 502, payload);
  }
}

if (require.main === module) {
  // This service writes to your CRM with a private-app token. Refuse to
  // start without a bearer token unless explicitly overridden (e.g. behind
  // your own authenticating proxy / Cloud Run IAM).
  if (!cfg().apiToken && process.env.ALLOW_UNAUTHENTICATED !== 'true') {
    // eslint-disable-next-line no-console
    console.error(
      'quote-runner: API_TOKEN is not set. Set it, or set ALLOW_UNAUTHENTICATED=true if an upstream proxy authenticates callers.',
    );
    process.exit(2);
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Last-resort catch — handle() already sends its own errors.
      // eslint-disable-next-line no-console
      console.error('unhandled', err);
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
    });
  });
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`quote-runner listening on :${PORT}`);
  });
}

module.exports = { runPipeline, selectOffers, validatePayload };
