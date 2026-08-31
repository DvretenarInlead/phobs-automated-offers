/**
 * Phobs PC API client — XML build/parse for:
 *   - PCPropertyAvailabilityRQ / PCPropertyAvailabilityRS
 *   - PCPriceQuoteRQ / PCPriceQuoteRS
 *
 * XXE-safe (external entities disabled). Only dep: fast-xml-parser.
 *
 * Note on PCPriceQuoteRQ: the request mirrors the availability request
 * (same <Auth> + <UnitFilter> conventions) but targets a single unit + rate.
 * The response parser is deliberately defensive — it extracts the common
 * price fields when present and always returns the full parsed document
 * under `raw`, so nothing Phobs sends is lost even if the shape differs
 * between Phobs versions.
 */

import { XMLBuilder, XMLParser } from 'fast-xml-parser';

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: false,
  processEntities: true, // escape <>&"' correctly in text nodes
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

// ---------- helpers --------------------------------------------------------

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
function num(v) {
  const x = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(x) ? x : 0;
}
function str(v) {
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

function authBlock(creds) {
  return {
    SiteId: creds.siteId,
    Username: creds.username,
    Password: creds.password,
  };
}

function unitFilterBlock(input) {
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
  if (input.unitId) unitFilter.UnitId = input.unitId;
  if (input.accessCode) unitFilter.AccessCode = input.accessCode;
  return unitFilter;
}

async function postXml(endpoint, xml, timeoutMs) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') {
    throw Object.assign(new Error('Phobs endpoint must be https://'), {
      code: 'insecure_endpoint',
    });
  }
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
  return text;
}

function parseResponseType(root) {
  const responseType = root.ResponseType ?? {};
  const success = 'Success' in responseType;
  const error =
    'Errors' in responseType && responseType.Errors && responseType.Errors.Error
      ? str(responseType.Errors.Error.Message ?? responseType.Errors.Error)
      : null;
  return { success, error };
}

function parseUnit(u) {
  const rate = u.Rate ?? {};
  const price = rate.Price ?? {};
  const stayTotal = rate.StayTotal ?? {};
  const breakdown = rate.PriceBreakdown ?? {};
  const days = toArray(breakdown.PriceDay);
  return {
    unitId: str(u['@_UnitId']),
    name: str(u.Name),
    availableUnits: num(u['@_AvailableUnits']),
    occupancy: {
      max: num(u['@_OccupancyMax']),
      min: num(u['@_OccupancyMin']),
      maxAdult: num(u['@_OccupancyMaxAdult']),
      maxChdAge: num(u['@_OccupancyMaxChdAge']),
    },
    board: str(rate.Board),
    pricePerNight: num(
      typeof price === 'object' && price !== null ? price['#text'] ?? rate.Price : rate.Price,
    ),
    stayTotal: num(stayTotal.Price),
    currency: str(stayTotal.Currency ?? price['@_Currency']),
    bookUrl: str(u.BookUrl).trim(),
    priceBreakdown: days.map((d) => {
      const dp = d.Price ?? {};
      return {
        date: str(d.Date),
        price: num(typeof dp === 'object' && dp !== null ? dp['#text'] ?? d.Price : d.Price),
      };
    }),
  };
}

function parseRatePlans(container) {
  const ratePlans = toArray((container?.RatePlans ?? {}).RatePlan);
  return ratePlans.map((rp) => {
    const units = toArray((rp.Units ?? {}).Unit);
    const restrictions = rp.Restrictions ?? {};
    return {
      rateId: str(rp['@_RateId']),
      name: str(rp.Name),
      shortDescription: str(rp.ShortDescription),
      stayMinNights: restrictions.StayMin != null ? num(restrictions.StayMin) : null,
      units: units.map(parseUnit),
    };
  });
}

// ---------- PCPropertyAvailabilityRQ --------------------------------------

export function buildAvailabilityRequest(input, creds) {
  const doc = {
    '?xml': { '@_version': '1.0', '@_encoding': 'utf-8' },
    PCPropertyAvailabilityRQ: {
      '@_Lang': input.lang || 'en',
      Auth: authBlock(creds),
      PropertyId: input.propertyId,
      RateId: '',
      UnitFilter: unitFilterBlock(input),
    },
  };
  return builder.build(doc);
}

export function parseAvailabilityResponse(xml) {
  const doc = parser.parse(xml);
  const root = doc.PCPropertyAvailabilityRS ?? {};
  const { success, error } = parseResponseType(root);
  const rates = parseRatePlans(root.AvailabilityList ?? {});
  const sessionId = root.SessionID ? str(root.SessionID) : null;
  return { success, error, sessionId, rates };
}

export async function fetchAvailability(creds, input) {
  const xml = buildAvailabilityRequest(input, creds);
  const text = await postXml(creds.endpoint, xml, input.timeoutMs);
  const parsed = parseAvailabilityResponse(text);
  if (input.includeRawXml) parsed.rawXml = text;
  return parsed;
}

// ---------- PCPriceQuoteRQ -------------------------------------------------

export function buildPriceQuoteRequest(input, creds) {
  const doc = {
    '?xml': { '@_version': '1.0', '@_encoding': 'utf-8' },
    PCPriceQuoteRQ: {
      '@_Lang': input.lang || 'en',
      Auth: authBlock(creds),
      PropertyId: input.propertyId,
      RateId: input.rateId ?? '',
      UnitFilter: unitFilterBlock(input),
    },
  };
  return builder.build(doc);
}

export function parsePriceQuoteResponse(xml) {
  const doc = parser.parse(xml);
  // Defensive root lookup — accept PCPriceQuoteRS or fall back to the first
  // *RS element so a naming difference between Phobs versions doesn't lose
  // the payload.
  let root = doc.PCPriceQuoteRS;
  if (!root) {
    const rsKey = Object.keys(doc).find((k) => k.endsWith('RS'));
    root = rsKey ? doc[rsKey] : {};
  }
  const { success, error } = parseResponseType(root);
  const sessionId = root.SessionID ? str(root.SessionID) : null;

  // Rate plans can appear directly on the root or inside a list container
  // (AvailabilityList / PriceQuoteList / QuoteList) depending on version.
  const container =
    root.PriceQuoteList ?? root.QuoteList ?? root.AvailabilityList ?? root;
  const rates = parseRatePlans(container);

  // Also surface a flattened "quote" view of the first rate × unit, which is
  // the common case for a single-unit price quote.
  const first = rates[0];
  const firstUnit = first?.units?.[0];
  const quote = firstUnit
    ? {
        rateId: first.rateId,
        rateName: first.name,
        unitId: firstUnit.unitId,
        unitName: firstUnit.name,
        board: firstUnit.board,
        pricePerNight: firstUnit.pricePerNight,
        stayTotal: firstUnit.stayTotal,
        currency: firstUnit.currency,
        priceBreakdown: firstUnit.priceBreakdown,
      }
    : null;

  return { success, error, sessionId, quote, rates, raw: root };
}

export async function fetchPriceQuote(creds, input) {
  const endpoint = creds.priceQuoteEndpoint || creds.endpoint;
  const xml = buildPriceQuoteRequest(input, creds);
  const text = await postXml(endpoint, xml, input.timeoutMs);
  const parsed = parsePriceQuoteResponse(text);
  if (input.includeRawXml) parsed.rawXml = text;
  return parsed;
}
