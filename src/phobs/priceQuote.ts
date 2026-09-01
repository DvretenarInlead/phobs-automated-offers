import { XMLBuilder } from 'fast-xml-parser';
import type { PhobsAuth } from './buildRequest.js';
import { parseRatePlans, parseResponseType, parseXml, str } from './parseResponse.js';
import type { PhobsRate, XmlObj } from './parseResponse.js';

/**
 * PCPriceQuoteRQ / PCPriceQuoteRS.
 *
 * A firm price for ONE unit + rate + stay. The request mirrors the
 * availability request (same <Auth> and <UnitFilter> conventions) with the
 * root element swapped and a concrete RateId / UnitId.
 *
 * The response parser is deliberately defensive: the legacy Make.com scenario
 * never exercised this call, so the exact RS layout is unverified against a
 * live endpoint. We accept `PCPriceQuoteRS` or any `*RS` root, look for the
 * rate-plan list in several container names, and always keep the raw XML so
 * the first live call can be inspected from the admin probe.
 */

export interface PhobsPriceQuoteRequest {
  lang: string;
  propertyId: string;
  rateId: string;
  unitId: string;
  date: string; // YYYY-MM-DD
  nights: number;
  adults: number;
  childAges: number[];
  includeRestricted?: boolean;
  accessCode?: string;
  auth: PhobsAuth;
}

export interface PhobsPriceQuote {
  rateId: string;
  rateName: string;
  unitId: string;
  unitName: string;
  board: string;
  pricePerNight: number;
  stayTotal: number;
  currency: string;
  priceBreakdown: { date: string; price: number }[];
}

export interface PhobsPriceQuoteResponse {
  success: boolean;
  error: string | null;
  sessionId: string | null;
  /** Flattened first rate × unit — the common single-unit case. */
  quote: PhobsPriceQuote | null;
  rates: PhobsRate[];
  rawXml: string;
}

interface XmlNode {
  [k: string]: unknown;
}

export function buildPriceQuoteRequest(input: PhobsPriceQuoteRequest): string {
  const unitFilter: XmlNode = {
    Date: input.date,
    Nights: input.nights,
    UnitId: input.unitId,
    UnitItem: {
      Item: {
        Adults: input.adults,
        ...(input.childAges.length > 0 ? { Children: { ChildAge: input.childAges } } : {}),
      },
    },
    IncludeRestricted: input.includeRestricted ?? false,
  };
  if (input.accessCode) unitFilter.AccessCode = input.accessCode;

  const doc: XmlNode = {
    '?xml': { '@_version': '1.0', '@_encoding': 'utf-8' },
    PCPriceQuoteRQ: {
      '@_Lang': input.lang,
      Auth: {
        SiteId: input.auth.siteId,
        Username: input.auth.username,
        Password: input.auth.password,
      },
      PropertyId: input.propertyId,
      RateId: input.rateId,
      UnitFilter: unitFilter,
    },
  };

  // Structured builder, never string interpolation — tenant/webhook strings
  // cannot inject elements or attributes.
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    format: false,
    suppressEmptyNode: false,
    processEntities: true,
  });
  return builder.build(doc);
}

export function parsePriceQuoteResponse(xml: string): PhobsPriceQuoteResponse {
  const doc = parseXml(xml);

  let rootRaw = doc.PCPriceQuoteRS;
  if (!rootRaw || typeof rootRaw !== 'object') {
    const rsKey = Object.keys(doc).find((k) => k.endsWith('RS'));
    rootRaw = rsKey ? doc[rsKey] : undefined;
  }
  const root: XmlObj = rootRaw && typeof rootRaw === 'object' ? (rootRaw as XmlObj) : {};

  const { success, error } = parseResponseType(root);
  const sessionId = root.SessionID ? str(root.SessionID) : null;

  // Rate plans may sit directly on the root or inside a list container,
  // depending on Phobs version.
  const containerRaw =
    root.PriceQuoteList ?? root.QuoteList ?? root.AvailabilityList ?? root;
  const container: XmlObj =
    containerRaw && typeof containerRaw === 'object' ? (containerRaw as XmlObj) : {};
  const rates = parseRatePlans(container);

  const first = rates[0];
  const firstUnit = first?.units[0];
  const quote: PhobsPriceQuote | null =
    first && firstUnit
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

  return { success, error, sessionId, quote, rates, rawXml: xml };
}
