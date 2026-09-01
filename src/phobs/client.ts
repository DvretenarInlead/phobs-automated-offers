import { request as httpRequest } from 'undici';
import { ExternalServiceError } from '../lib/errors.js';
import { callWithRetry } from '../lib/retry.js';
import { buildAvailabilityRequest } from './buildRequest.js';
import type { PhobsAvailabilityRequest } from './buildRequest.js';
import { parseAvailabilityResponse } from './parseResponse.js';
import type { PhobsAvailabilityResponse } from './parseResponse.js';
import { buildPriceQuoteRequest, parsePriceQuoteResponse } from './priceQuote.js';
import type { PhobsPriceQuoteRequest, PhobsPriceQuoteResponse } from './priceQuote.js';

export interface PhobsClientOpts {
  endpoint: string;
  timeoutMs?: number;
}

/**
 * Allow-list of acceptable Phobs endpoint hosts. Tenants supply this via the
 * admin UI; we enforce it both server-side at save time and at call time to
 * prevent SSRF (a compromised admin can't aim us at an internal IP).
 */
const ALLOWED_HOSTS_RE = /(^|\.)phobs\.net$/i;

export function assertAllowedEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ExternalServiceError('phobs', 'invalid_endpoint_url');
  }
  if (url.protocol !== 'https:') {
    throw new ExternalServiceError('phobs', 'endpoint_must_be_https');
  }
  if (!ALLOWED_HOSTS_RE.test(url.hostname)) {
    throw new ExternalServiceError('phobs', `endpoint_host_not_allowlisted: ${url.hostname}`);
  }
  return url;
}

export async function fetchAvailability(
  opts: PhobsClientOpts,
  req: PhobsAvailabilityRequest,
): Promise<PhobsAvailabilityResponse> {
  const url = assertAllowedEndpoint(opts.endpoint);
  const xml = buildAvailabilityRequest(req);

  return callWithRetry('phobs', 'availability', async () => {
    const res = await httpRequest(url, {
      method: 'POST',
      body: xml,
      headers: { 'content-type': 'application/xml; charset=utf-8' },
      headersTimeout: opts.timeoutMs ?? 15_000,
      bodyTimeout: opts.timeoutMs ?? 15_000,
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      throw new ExternalServiceError(
        'phobs',
        `availability HTTP ${res.statusCode}`,
        res.statusCode,
      );
    }
    return parseAvailabilityResponse(text);
  });
}

/**
 * PCPriceQuoteRQ — firm price for one unit + rate. Same SSRF guard, timeout
 * and retry policy as availability. `opts.endpoint` may be the tenant's
 * dedicated price-quote URL (overrides.price_quote.endpoint) or the shared
 * Phobs endpoint; either way it must pass the host allow-list.
 */
export async function fetchPriceQuote(
  opts: PhobsClientOpts,
  req: PhobsPriceQuoteRequest,
): Promise<PhobsPriceQuoteResponse> {
  const url = assertAllowedEndpoint(opts.endpoint);
  const xml = buildPriceQuoteRequest(req);

  return callWithRetry('phobs', 'price_quote', async () => {
    const res = await httpRequest(url, {
      method: 'POST',
      body: xml,
      headers: { 'content-type': 'application/xml; charset=utf-8' },
      headersTimeout: opts.timeoutMs ?? 15_000,
      bodyTimeout: opts.timeoutMs ?? 15_000,
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      throw new ExternalServiceError(
        'phobs',
        `price_quote HTTP ${res.statusCode}`,
        res.statusCode,
      );
    }
    return parsePriceQuoteResponse(text);
  });
}
