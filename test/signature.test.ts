import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normaliseUri, verifyHubSpotSignatureV3 } from '../src/hubspot/signature.js';

const SECRET = 'super-secret';
const URI = 'https://app.example.com/webhooks/hubspot/123';
const METHOD = 'POST';

// Mirrors HubSpot's documented v3 construction exactly:
//   method + uri + body + timestamp
function sign(ts: string, body: Buffer, uri = URI, secret = SECRET): string {
  return createHmac('sha256', secret)
    .update(METHOD)
    .update(uri)
    .update(body)
    .update(ts)
    .digest('base64');
}

describe('verifyHubSpotSignatureV3', () => {
  const body = Buffer.from(JSON.stringify([{ hs_object_id: 1 }]));
  const ts = '1700000000000';
  const now = 1_700_000_001_000;

  it('accepts a valid signature within window', () => {
    const r = verifyHubSpotSignatureV3({
      clientSecret: SECRET,
      method: METHOD,
      uri: URI,
      rawBody: body,
      signatureHeader: sign(ts, body),
      timestampHeader: ts,
      now,
    });
    expect(r).toEqual({ ok: true });
  });

  it('rejects the old (timestamp-first) construction', () => {
    const legacy = createHmac('sha256', SECRET)
      .update(ts)
      .update(METHOD)
      .update(URI)
      .update(body)
      .digest('base64');
    const r = verifyHubSpotSignatureV3({
      clientSecret: SECRET,
      method: METHOD,
      uri: URI,
      rawBody: body,
      signatureHeader: legacy,
      timestampHeader: ts,
      now,
    });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('decodes HubSpot-listed percent sequences in the URI before hashing', () => {
    const encoded = 'https://app.example.com/webhooks/hubspot/123?x=a%2Cb%3Ac%40d';
    const decoded = 'https://app.example.com/webhooks/hubspot/123?x=a,b:c@d';
    expect(normaliseUri(encoded)).toBe(decoded);
    // Signature computed by HubSpot over the decoded form must verify when we
    // receive the encoded URL.
    const r = verifyHubSpotSignatureV3({
      clientSecret: SECRET,
      method: METHOD,
      uri: encoded,
      rawBody: body,
      signatureHeader: sign(ts, body, decoded),
      timestampHeader: ts,
      now,
    });
    expect(r).toEqual({ ok: true });
    // …but sequences NOT on the list (e.g. %20) are left as-is.
    expect(normaliseUri('a%20b%2Fc')).toBe('a%20b/c');
  });

  it('rejects missing headers', () => {
    expect(
      verifyHubSpotSignatureV3({
        clientSecret: SECRET,
        method: METHOD,
        uri: URI,
        rawBody: body,
        signatureHeader: undefined,
        timestampHeader: ts,
      }),
    ).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('rejects stale and malformed timestamps', () => {
    expect(
      verifyHubSpotSignatureV3({
        clientSecret: SECRET,
        method: METHOD,
        uri: URI,
        rawBody: body,
        signatureHeader: sign(ts, body),
        timestampHeader: ts,
        now: Number(ts) + 10 * 60 * 1000, // 10 min skew
      }),
    ).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(
      verifyHubSpotSignatureV3({
        clientSecret: SECRET,
        method: METHOD,
        uri: URI,
        rawBody: body,
        signatureHeader: sign('1.7e12', body),
        timestampHeader: '1.7e12',
        now,
      }),
    ).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects body tampering', () => {
    const tamperedBody = Buffer.from(JSON.stringify([{ hs_object_id: 999 }]));
    const r = verifyHubSpotSignatureV3({
      clientSecret: SECRET,
      method: METHOD,
      uri: URI,
      rawBody: tamperedBody,
      signatureHeader: sign(ts, body),
      timestampHeader: ts,
      now,
    });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects URI mismatch (could be SSRF / open redirect attempt)', () => {
    const r = verifyHubSpotSignatureV3({
      clientSecret: SECRET,
      method: METHOD,
      uri: 'https://attacker.example/webhooks/hubspot/123',
      rawBody: body,
      signatureHeader: sign(ts, body),
      timestampHeader: ts,
      now,
    });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects wrong secret', () => {
    const r = verifyHubSpotSignatureV3({
      clientSecret: SECRET,
      method: METHOD,
      uri: URI,
      rawBody: body,
      signatureHeader: sign(ts, body, URI, 'not-the-secret'),
      timestampHeader: ts,
      now,
    });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects malformed base64 signature', () => {
    const r = verifyHubSpotSignatureV3({
      clientSecret: SECRET,
      method: METHOD,
      uri: URI,
      rawBody: body,
      signatureHeader: '!!!not-base64!!!',
      timestampHeader: ts,
      now,
    });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
