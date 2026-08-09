import type { FastifyInstance } from 'fastify';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { request as httpRequest } from 'undici';
import { sql } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { logger } from '../lib/logger.js';
import { db } from '../db/client.js';
import { tenants, oauthTokens } from '../db/schema.js';
import { seal } from '../crypto/tokenVault.js';
import { ExternalServiceError } from '../lib/errors.js';

const config = loadConfig();

const HUBSPOT_AUTH_URL = 'https://app.hubspot.com/oauth/authorize';
const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const HUBSPOT_ACCOUNT_INFO_URL = 'https://api.hubapi.com/account-info/v3/details';

// Per-IP rate limit — a compromised HubSpot install could otherwise be
// weaponised to POST malformed states in a loop; harmless individually but
// each callback spends an argon2-comparable amount of CPU parsing + HMAC.
const OAUTH_RL = { max: 30, timeWindow: '1 minute' };

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface AccountInfo {
  portalId: number;
  uiDomain?: string;
  accountType?: string;
}

// Domain-separator prefix so an HMAC over an oauth state can never be
// mistaken for a CSRF token or an invite token, even if their shapes ever
// collide. (Invite tokens already use the "invite|" prefix — this pairs.)
const STATE_HMAC_DOMAIN = 'oauth-state|';

function signState(payload: { nonce: string; ts: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', config.sessionSecret)
    .update(STATE_HMAC_DOMAIN + body)
    .digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state: string, maxAgeMs = 10 * 60 * 1000): { nonce: string } | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = createHmac('sha256', config.sessionSecret)
    .update(STATE_HMAC_DOMAIN + body)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      nonce: string;
      ts: number;
    };
    if (typeof decoded.ts !== 'number') return null;
    if (Date.now() - decoded.ts > maxAgeMs) return null;
    return { nonce: decoded.nonce };
  } catch {
    return null;
  }
}

export const rateLimits = { OAUTH_RL };

export function registerOAuthRoutes(app: FastifyInstance): void {
  app.get(
    '/oauth/install',
    { config: { rateLimit: OAUTH_RL } },
    (_req, reply) => {
      const state = signState({ nonce: randomBytes(16).toString('hex'), ts: Date.now() });
      const url = new URL(HUBSPOT_AUTH_URL);
      url.searchParams.set('client_id', config.HUBSPOT_CLIENT_ID);
      url.searchParams.set('redirect_uri', config.HUBSPOT_REDIRECT_URI);
      url.searchParams.set('scope', config.hubspotScopes.join(' '));
      url.searchParams.set('state', state);
      return reply.redirect(url.toString(), 302);
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/oauth/callback',
    { config: { rateLimit: OAUTH_RL } },
    async (req, reply) => {
      const { code, state, error } = req.query;
      // Don't echo the upstream 'error' verbatim — HubSpot may pass through
      // client-controlled text.
      if (error) return reply.code(400).send({ error: 'oauth_error' });
      if (!code || !state) return reply.code(400).send({ error: 'missing_code_or_state' });
      if (!verifyState(state)) return reply.code(400).send({ error: 'bad_state' });

      // Exchange code for tokens
      const tokens = await exchangeCode(code);

      // Discover portalId
      const account = await fetchAccountInfo(tokens.access_token);
      const hubId = BigInt(account.portalId);

      const accessSealed = seal(tokens.access_token, `oauth_access:${hubId}`);
      const refreshSealed = seal(tokens.refresh_token, `oauth_refresh:${hubId}`);
      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

      await db.transaction(async (tx) => {
        await tx
          .insert(tenants)
          .values({ hubId, name: account.uiDomain ?? `Portal ${hubId.toString()}` })
          .onConflictDoUpdate({
            target: tenants.hubId,
            set: { name: account.uiDomain ?? sql`${tenants.name}` },
          });
        await tx
          .insert(oauthTokens)
          .values({
            hubId,
            accessTokenCt: accessSealed.ct,
            accessTokenIv: accessSealed.iv,
            accessTokenTag: accessSealed.tag,
            accessTokenExpires: expiresAt,
            refreshTokenCt: refreshSealed.ct,
            refreshTokenIv: refreshSealed.iv,
            refreshTokenTag: refreshSealed.tag,
            scopes: config.hubspotScopes,
          })
          .onConflictDoUpdate({
            target: oauthTokens.hubId,
            set: {
              accessTokenCt: accessSealed.ct,
              accessTokenIv: accessSealed.iv,
              accessTokenTag: accessSealed.tag,
              accessTokenExpires: expiresAt,
              refreshTokenCt: refreshSealed.ct,
              refreshTokenIv: refreshSealed.iv,
              refreshTokenTag: refreshSealed.tag,
              scopes: config.hubspotScopes,
              updatedAt: new Date(),
            },
          });
      });

      logger.info({ hubId: hubId.toString() }, 'oauth install complete');
      return reply
        .code(200)
        .send({ ok: true, hubId: hubId.toString(), name: account.uiDomain ?? null });
    },
  );
}

async function exchangeCode(code: string): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.HUBSPOT_CLIENT_ID,
    client_secret: config.HUBSPOT_CLIENT_SECRET,
    redirect_uri: config.HUBSPOT_REDIRECT_URI,
    code,
  });
  const res = await httpRequest(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    body: form.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (res.statusCode >= 400) {
    // Log the upstream body server-side (may contain diagnostic info from
    // HubSpot) but never let it bubble into an error message that the top
    // error-handler could surface to the caller.
    const body = await res.body.text();
    logger.warn(
      { upstreamStatus: res.statusCode, upstreamBody: body.slice(0, 500) },
      'oauth token exchange failed',
    );
    throw new ExternalServiceError('hubspot', 'token_exchange_failed', res.statusCode);
  }
  return (await res.body.json()) as TokenResponse;
}

async function fetchAccountInfo(accessToken: string): Promise<AccountInfo> {
  const res = await httpRequest(HUBSPOT_ACCOUNT_INFO_URL, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (res.statusCode >= 400) {
    const body = await res.body.text();
    logger.warn(
      { upstreamStatus: res.statusCode, upstreamBody: body.slice(0, 500) },
      'account-info fetch failed',
    );
    throw new ExternalServiceError('hubspot', 'account_info_failed', res.statusCode);
  }
  return (await res.body.json()) as AccountInfo;
}
