import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyHubSpotSignatureV3 } from '../src/hubspot/signature.js';

const SECRET = 'super-secret';
const URI = 'https://app.example.com/webhooks/hubspot/123';
const METHOD = 'POST';

function sign(ts: number, body: Buffer): string {
  return createHmac('sha256', SECRET)
    .update(Buffer.from(String(ts)))
    .update(METHOD)
    .update(URI)
    .update(body)
    .digest('base64');
}

describe('verifyHubSpotSignatureV3', () => {
  const body = Buffer.from(JSON.stringify([{ hs_object_id: 1 }]));
  const ts = 1_700_000_000_000;

  it('accepts a valid signature within window', () => {
    const r = verifyHubSpotSignatureV3({
      clientSecret: SECRET,
      method: METHOD,
      uri: URI,
      rawBody: body,
      signatureHeader: sign(ts, body),
      timestampHeader: String(ts),
      now: ts + 1000,
    });
    expect(r).toEqual({ ok: true });
  });

  it('rejects missing headers', () => {
    expect(
      verifyHubSpotSignatureV3({
        clientSecret: SECRET,
        method: METHOD,
        uri: URI,
        rawBody: body,
        signatureHeader: undefined,
        timestampHeader: String(ts),
      }),
    ).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('rejects stale timestamp', () => {
    const r = verifyHubSpotSignatureV3({
      clientSecret: SECRET,
      method: METHOD,
      uri: URI,
      rawBody: body,
      signatureHeader: sign(ts, body),
      timestampHeader: String(ts),
      now: ts + 10 * 60 * 1000, // 10 min skew
    });
    expect(r).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects body tampering', () => {
    const tamperedBody = Buffer.from(JSON.stringify([{ hs_object_id: 999 }]));
    const r = verifyHubSpotSignatureV3({
      clientSecret: SECRET,
      method: METHOD,
      uri: URI,
      rawBody: tamperedBody,
      signatureHeader: sign(ts, body),
      timestampHeader: String(ts),
      now: ts + 1000,
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
      timestampHeader: String(ts),
      now: ts + 1000,
    });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects wrong secret', () => {
    const wrongSig = createHmac('sha256', 'not-the-secret')
      .update(Buffer.from(String(ts)))
      .update(METHOD)
      .update(URI)
      .update(body)
      .digest('base64');
    const r = verifyHubSpotSignatureV3({
      clientSecret: SECRET,
      method: METHOD,
      uri: URI,
      rawBody: body,
      signatureHeader: wrongSig,
      timestampHeader: String(ts),
      now: ts + 1000,
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
      timestampHeader: String(ts),
      now: ts + 1000,
    });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
