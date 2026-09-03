import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Per-tenant webhook URL token.
 *
 * HubSpot signs "Send a webhook" deliveries with the *public app's* client
 * secret, which every portal the app is installed on shares. The signature
 * therefore proves "this came from HubSpot", not "from this tenant's
 * portal". The token in the path is a per-tenant secret that only the
 * tenant's admin knows (shown once in the admin UI); because HubSpot signs
 * the full URI, a portal that does not know the token cannot produce a
 * valid delivery for that tenant's endpoint.
 *
 * Stored as a SHA-256 hash, like API tokens.
 */

export const WEBHOOK_TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

export function generateWebhookToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('base64url'); // 32 chars
  return { token, hash: hashWebhookToken(token) };
}

export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function verifyWebhookToken(token: string, storedHash: string | null): boolean {
  if (!storedHash || !WEBHOOK_TOKEN_RE.test(token)) return false;
  const a = Buffer.from(hashWebhookToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function webhookPath(hubId: bigint | string, token: string): string {
  return `/webhooks/hubspot/${hubId.toString()}/${token}`;
}
