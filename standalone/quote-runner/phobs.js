/**
 * Phobs availability client — builds PCPropertyAvailabilityRQ XML, POSTs it,
 * parses the response. XXE-safe (external entities disabled). No external deps
 * besides fast-xml-parser.
 */

const { XMLBuilder, XMLParser } = require('fast-xml-parser');

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

function buildRequest(input) {
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

function parseResponse(xml) {
  const doc = parser.parse(xml);
  const root = doc.PCPropertyAvailabilityRS ?? {};
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
          bookUrl: s(u.BookUrl).trim(),
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

async function fetchAvailability(opts, req) {
  const url = new URL(opts.endpoint);
  if (url.protocol !== 'https:') {
    const err = new Error('phobs endpoint must be https://');
    err.code = 'insecure_endpoint';
    throw err;
  }

  const xml = buildRequest(req);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
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
    const err = new Error(`phobs HTTP ${res.status}`);
    err.upstreamStatus = res.status;
    err.upstreamBody = text.slice(0, 2000);
    throw err;
  }
  return parseResponse(text);
}

module.exports = { fetchAvailability, buildRequest, parseResponse };
