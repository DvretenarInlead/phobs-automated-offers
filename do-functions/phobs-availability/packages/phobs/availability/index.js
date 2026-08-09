/**
 * DigitalOcean Function — Phobs availability probe.
 *
 * A self-contained handler that:
 *   1. builds a `PCPropertyAvailabilityRQ` XML request
 *   2. POSTs it to the Phobs endpoint
 *   3. parses the XML response into a JSON structure
 *
 * No database, no queue, no HubSpot — pure Phobs I/O. Useful for isolating the
 * upstream integration when debugging.
 *
 * ---
 * DO Functions handler signature:
 *   async function main(args) => { body?, statusCode?, headers? }
 * When invoked over HTTP, `args` contains the parsed JSON body plus any URL /
 * query parameters. When invoked from `doctl serverless functions invoke` the
 * same object is passed in via --param.
 *
 * Local test:
 *   npm install
 *   node index.js '{"propertyId":"P1","checkInDate":"2026-07-20","nights":5, ...}'
 * or set env PHOBS_PROBE_INPUT to the JSON string.
 */

const { XMLBuilder, XMLParser } = require('fast-xml-parser');

// ---------- credentials (from env) ---------------------------------------
//
// PHOBS_SITE_ID / PHOBS_USERNAME / PHOBS_PASSWORD / PHOBS_ENDPOINT are set in
// the DO Functions environment (see project.yml) and populated with secrets
// at deploy time via `doctl serverless deploy . --env-file .env` or the DO
// Functions UI. They never appear in the request body or the response.
//
// For local testing (`node index.js '{...}'`) you can either export them:
//   PHOBS_SITE_ID=... PHOBS_USERNAME=... PHOBS_PASSWORD=... PHOBS_ENDPOINT=... \
//     node index.js "$(cat my-input.json)"
// or pass them inside the JSON payload — env wins if both are set.

function readCreds(args) {
  return {
    siteId: process.env.PHOBS_SITE_ID || args.siteId || '',
    username: process.env.PHOBS_USERNAME || args.username || '',
    password: process.env.PHOBS_PASSWORD || args.password || '',
    endpoint: process.env.PHOBS_ENDPOINT || args.endpoint || '',
  };
}

// ---------- input schema (validated by hand — no external deps) ----------

const REQUIRED_QUERY_FIELDS = ['propertyId', 'checkInDate', 'nights', 'adults'];
const REQUIRED_CRED_FIELDS = ['siteId', 'username', 'password', 'endpoint'];

function validate(args, creds) {
  const errors = [];
  for (const k of REQUIRED_QUERY_FIELDS) {
    if (args[k] === undefined || args[k] === null || args[k] === '') {
      errors.push(`missing: ${k}`);
    }
  }
  for (const k of REQUIRED_CRED_FIELDS) {
    if (!creds[k]) errors.push(`missing env: PHOBS_${k === 'siteId' ? 'SITE_ID' : k.toUpperCase()}`);
  }
  if (args.checkInDate && !/^\d{4}-\d{2}-\d{2}$/.test(args.checkInDate)) {
    errors.push('checkInDate must be YYYY-MM-DD');
  }
  if (args.nights !== undefined && (!Number.isFinite(args.nights) || args.nights < 1)) {
    errors.push('nights must be a positive number');
  }
  if (args.adults !== undefined && (!Number.isFinite(args.adults) || args.adults < 0)) {
    errors.push('adults must be a non-negative number');
  }
  if (args.childAges && !Array.isArray(args.childAges)) {
    errors.push('childAges must be an array of numbers');
  }
  if (args.unitIds && !Array.isArray(args.unitIds)) {
    errors.push('unitIds must be an array of strings');
  }
  if (creds.endpoint) {
    try {
      const u = new URL(creds.endpoint);
      if (u.protocol !== 'https:') errors.push('PHOBS_ENDPOINT must be https://');
    } catch (_e) {
      errors.push('PHOBS_ENDPOINT is not a valid URL');
    }
  }
  return errors;
}

// ---------- XML builder ---------------------------------------------------

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

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: false,
    processEntities: true, // escape < > & " ' correctly
  });
  return builder.build(doc);
}

// ---------- XML parser (XXE-safe) ----------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false, // no external-entity resolution -> no XXE
  allowBooleanAttributes: false,
  parseTagValue: true,
  parseAttributeValue: true,
  trimValues: true,
});

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
  const root = (doc.PCPropertyAvailabilityRS ?? {});
  const availability = root.AvailabilityList ?? {};
  const rpContainer = availability.RatePlans ?? {};
  const ratePlans = toArray(rpContainer.RatePlan);

  const rates = ratePlans.map((rp) => {
    const uc = rp.Units ?? {};
    const units = toArray(uc.Unit);
    const restrictions = rp.Restrictions ?? {};
    return {
      rateId: s(rp['@_RateId']),
      name: s(rp.Name),
      shortDescription: s(rp.ShortDescription),
      stayMinNights: restrictions.StayMin != null ? n(restrictions.StayMin) : null,
      units: units.map((u) => {
        const rate = u.Rate ?? {};
        const price = rate.Price ?? {};
        const stayTotal = rate.StayTotal ?? {};
        const breakdown = rate.PriceBreakdown ?? {};
        const days = toArray(breakdown.PriceDay);
        return {
          unitId: s(u['@_UnitId']),
          name: s(u.Name),
          occupancy: {
            max: n(u['@_OccupancyMax']),
            min: n(u['@_OccupancyMin']),
            current: n(u['@_Occupancy']),
            maxAdult: n(u['@_OccupancyMaxAdult']),
            maxChdAge: n(u['@_OccupancyMaxChdAge']),
          },
          availableUnits: n(u['@_AvailableUnits']),
          board: s(rate.Board),
          pricePerNight: n(
            typeof price === 'object' && price !== null
              ? price['#text'] ?? rate.Price
              : rate.Price,
          ),
          stayTotal: n(stayTotal.Price),
          currency: s(stayTotal.Currency ?? price['@_Currency']),
          bookUrl: s(u.BookUrl).trim(),
          priceBreakdown: days.map((d) => {
            const dp = d.Price ?? {};
            return {
              date: s(d.Date),
              price: n(typeof dp === 'object' && dp !== null ? dp['#text'] ?? d.Price : d.Price),
            };
          }),
        };
      }),
    };
  });

  const responseType = root.ResponseType ?? {};
  const success = 'Success' in responseType;
  const sessionId = root.SessionID ? s(root.SessionID) : null;
  const error =
    'Errors' in responseType && responseType.Errors && responseType.Errors.Error
      ? s(responseType.Errors.Error.Message ?? responseType.Errors.Error)
      : null;

  return { success, sessionId, error, rates };
}

// ---------- HTTP ----------------------------------------------------------

async function post(url, body, timeoutMs) {
  // Node 18+ ships fetch. DO Functions run on Node 18, so no dependency needed.
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs || 15000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/xml; charset=utf-8' },
      signal: ac.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(t);
  }
}

// ---------- handler -------------------------------------------------------

/**
 * DO Functions entry point. `args` is a merged object of query + body params.
 * Returns `{ statusCode, body }` in DO's response envelope.
 */
async function main(args) {
  const started = Date.now();
  const creds = readCreds(args);
  const errors = validate(args, creds);
  if (errors.length > 0) {
    return {
      statusCode: 400,
      body: { error: 'validation_failed', details: errors },
    };
  }

  const xmlRequest = buildAvailabilityRequest({
    propertyId: args.propertyId,
    checkInDate: args.checkInDate,
    nights: args.nights,
    adults: args.adults,
    childAges: args.childAges || [],
    unitIds: args.unitIds || [],
    lang: args.lang,
    accessCode: args.accessCode,
    includeRestricted: args.includeRestricted,
    siteId: creds.siteId,
    username: creds.username,
    password: creds.password,
  });

  let httpRes;
  try {
    httpRes = await post(creds.endpoint, xmlRequest, args.timeoutMs);
  } catch (err) {
    return {
      statusCode: 502,
      body: {
        error: 'network_error',
        message: String(err && err.message ? err.message : err),
        latencyMs: Date.now() - started,
      },
    };
  }

  if (httpRes.status >= 400) {
    return {
      statusCode: 502,
      body: {
        error: 'upstream_error',
        upstreamStatus: httpRes.status,
        upstreamBody: httpRes.text.slice(0, 2000),
        latencyMs: Date.now() - started,
      },
    };
  }

  let parsed;
  try {
    parsed = parseAvailabilityResponse(httpRes.text);
  } catch (err) {
    return {
      statusCode: 502,
      body: {
        error: 'parse_error',
        message: String(err && err.message ? err.message : err),
        rawXml: httpRes.text.slice(0, 2000),
        latencyMs: Date.now() - started,
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: parsed.success,
      sessionId: parsed.sessionId,
      error: parsed.error,
      rates: parsed.rates,
      rateCount: parsed.rates.length,
      unitCount: parsed.rates.reduce((sum, r) => sum + r.units.length, 0),
      latencyMs: Date.now() - started,
      // Include the request XML in debug mode for troubleshooting; never in
      // prod because it contains the Phobs credentials.
      ...(args.debug ? { requestXml: xmlRequest } : {}),
    },
  };
}

module.exports = { main, buildAvailabilityRequest, parseAvailabilityResponse };

// ---------- Local runner --------------------------------------------------
//
// If invoked directly (`node index.js '{...}'`) run the handler once with the
// argv/env payload and print the result. Useful before deploying.

if (require.main === module) {
  const raw = process.argv[2] || process.env.PHOBS_PROBE_INPUT;
  if (!raw) {
    console.error('Usage: node index.js \'{"propertyId":"...","checkInDate":"YYYY-MM-DD",...}\'');
    console.error('Or set PHOBS_PROBE_INPUT to the same JSON string.');
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
