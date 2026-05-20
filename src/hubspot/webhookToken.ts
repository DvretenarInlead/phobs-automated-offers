import { createHmac } from 'node:crypto';
import { loadConfig } from '../config.js';
import { safeEquals } from '../crypto/tokenVault.js';

/**
 * Per-tenant webhook token.
 *
 * HubSpot's v3 webhook signature is computed with the shared *app* client
 * secret, so it proves "some portal that installed this app", not *which*
 * portal. The `:portalId` path segment alone is therefore attacker-chosen: a
 * tenant could point their workflow's webhook at another tenant's portalId.
 *
 * To bind a webhook URL to a single tenant we add an unguessable token derived
 * from the server-side `SESSION_SECRET`. Only the server can compute it, so a
 * tenant cannot forge another tenant's URL. It is deterministic (no storage)
 * and rotates with `SESSION_SECRET`.
 */
export function webhookTokenFor(hubId: bigint): string {
  const { sessionSecret } = loadConfig();
  return createHmac('sha256', sessionSecret)
    .update(`webhook:${hubId.toString()}`)
    .digest('base64url');
}

export function verifyWebhookToken(hubId: bigint, token: string): boolean {
  return safeEquals(token, webhookTokenFor(hubId));
}

export function webhookUrlFor(publicBaseUrl: string, hubId: bigint): string {
  return `${publicBaseUrl}/webhooks/hubspot/${hubId.toString()}/${webhookTokenFor(hubId)}`;
}
