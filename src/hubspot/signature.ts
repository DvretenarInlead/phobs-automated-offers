import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HubSpot Webhook Signature v3.
 *
 * Spec: https://developers.hubspot.com/docs/api/webhooks/validating-requests
 *
 *   signature = base64( HMAC-SHA256( clientSecret,
 *                 requestMethod + requestUri + requestBody + timestamp ) )
 *
 * Order matters: method, then URI, then body, then the timestamp header
 * value verbatim (string, not re-serialised). `uri` MUST be the full URL
 * HubSpot called — scheme, host, path and query string — after decoding the
 * specific percent-encoded characters HubSpot's reference implementation
 * decodes before hashing (see `normaliseUri`).
 */
export interface SignatureInput {
  clientSecret: string;
  method: string;
  /** Full URI HubSpot called, e.g. `https://app.example.com/webhooks/hubspot/123` */
  uri: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  /** Allowed clock skew. Defaults to 5 min. */
  maxAgeMs?: number;
  now?: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' };

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

// HubSpot decodes exactly these sequences in the URI before signing.
const URI_DECODE: Record<string, string> = {
  '%3A': ':',
  '%2F': '/',
  '%3F': '?',
  '%40': '@',
  '%21': '!',
  '%24': '$',
  '%27': "'",
  '%28': '(',
  '%29': ')',
  '%2A': '*',
  '%2C': ',',
  '%3B': ';',
};

export function normaliseUri(uri: string): string {
  return uri.replace(/%[0-9A-Fa-f]{2}/g, (m) => URI_DECODE[m.toUpperCase()] ?? m);
}

export function verifyHubSpotSignatureV3(input: SignatureInput): VerifyResult {
  const { signatureHeader, timestampHeader } = input;
  if (!signatureHeader || !timestampHeader) {
    return { ok: false, reason: 'missing_headers' };
  }

  // Timestamp must be a plain integer string (ms since epoch); anything else
  // is treated as stale/invalid rather than coerced.
  if (!/^\d{1,16}$/.test(timestampHeader)) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  const ts = Number(timestampHeader);
  const now = input.now ?? Date.now();
  const maxAge = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (Math.abs(now - ts) > maxAge) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const base = Buffer.concat([
    Buffer.from(input.method.toUpperCase(), 'utf8'),
    Buffer.from(normaliseUri(input.uri), 'utf8'),
    input.rawBody,
    Buffer.from(timestampHeader, 'utf8'),
  ]);

  const expected = createHmac('sha256', input.clientSecret).update(base).digest();
  const provided = safeBase64Decode(signatureHeader);
  if (!provided || provided.length !== expected.length) {
    return { ok: false, reason: 'bad_signature' };
  }
  return timingSafeEqual(provided, expected) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

function safeBase64Decode(s: string): Buffer | null {
  try {
    const b = Buffer.from(s, 'base64');
    // Round-trip check: malformed base64 silently truncates.
    if (b.toString('base64').replace(/=+$/, '') !== s.replace(/=+$/, '')) return null;
    return b;
  } catch {
    return null;
  }
}
