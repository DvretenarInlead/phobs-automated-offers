import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_TOKEN_RE,
  generateWebhookToken,
  hashWebhookToken,
  verifyWebhookToken,
  webhookPath,
} from '../src/lib/webhookToken.js';

describe('webhook token', () => {
  it('generates URL-safe tokens that verify against their hash only', () => {
    const a = generateWebhookToken();
    const b = generateWebhookToken();
    expect(a.token).toMatch(WEBHOOK_TOKEN_RE);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashWebhookToken(a.token));
    expect(verifyWebhookToken(a.token, a.hash)).toBe(true);
    expect(verifyWebhookToken(b.token, a.hash)).toBe(false);
    expect(verifyWebhookToken(a.token, null)).toBe(false);
    expect(verifyWebhookToken('short', a.hash)).toBe(false);
    expect(verifyWebhookToken(a.token + '/../x', a.hash)).toBe(false);
  });

  it('builds the path HubSpot must be pointed at', () => {
    expect(webhookPath(243719044n, 'abc'.repeat(11))).toBe(
      `/webhooks/hubspot/243719044/${'abc'.repeat(11)}`,
    );
  });
});
