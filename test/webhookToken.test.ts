import { describe, expect, it } from 'vitest';
import { verifyWebhookToken, webhookTokenFor, webhookUrlFor } from '../src/hubspot/webhookToken.js';

describe('webhookToken', () => {
  it('is deterministic per hubId', () => {
    expect(webhookTokenFor(123n)).toBe(webhookTokenFor(123n));
  });

  it('differs across hubIds (cross-tenant binding)', () => {
    expect(webhookTokenFor(123n)).not.toBe(webhookTokenFor(456n));
  });

  it('verifies its own token', () => {
    const t = webhookTokenFor(123n);
    expect(verifyWebhookToken(123n, t)).toBe(true);
  });

  it("rejects another tenant's token", () => {
    const t = webhookTokenFor(456n);
    expect(verifyWebhookToken(123n, t)).toBe(false);
  });

  it('rejects garbage and empty tokens', () => {
    expect(verifyWebhookToken(123n, 'nope')).toBe(false);
    expect(verifyWebhookToken(123n, '')).toBe(false);
  });

  it('builds a url containing the bound token', () => {
    const url = webhookUrlFor('https://app.example.com', 123n);
    expect(url).toBe(`https://app.example.com/webhooks/hubspot/123/${webhookTokenFor(123n)}`);
  });
});
