import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HubSpot Webhook Signature v3.
 *
 * Spec: https://developers.hubspot.com/docs/api/webhooks/validating-requests
 *
 * Signature is base64(HMAC-SHA256(clientSecret, timestamp + method + uri + rawBody)).
 *
 * `uri` MUST be the full URL HubSpot called, including scheme, host, path, and
 * query string — exactly as configured in the workflow webhook action.
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

export function verifyHubSpotSignatureV3(input: SignatureInput): VerifyResult {
  const { signatureHeader, timestampHeader } = input;
  if (!signatureHeader || !timestampHeader) {
    return { ok: false, reason: 'missing_headers' };
  }

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  const now = input.now ?? Date.now();
  const maxAge = input.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (Math.abs(now - ts) > maxAge) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const base = Buffer.concat([
    Buffer.from(String(ts), 'utf8'),
    Buffer.from(input.method.toUpperCase(), 'utf8'),
    Buffer.from(input.uri, 'utf8'),
    input.rawBody,
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
