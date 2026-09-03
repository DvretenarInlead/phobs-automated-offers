import { Client as HubSpotClient } from '@hubspot/api-client';
import { request as httpRequest } from 'undici';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { db } from '../db/client.js';
import { oauthTokens } from '../db/schema.js';
import { seal, openUtf8 } from '../crypto/tokenVault.js';
import { ExternalServiceError, TenantNotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const config = loadConfig();
const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const REFRESH_LEAD_MS = 2 * 60 * 1000; // refresh if <2 min remaining

interface TokenRow {
  accessToken: string;
  expiresAt: Date;
  refreshToken: string;
}

async function loadTokens(hubId: bigint): Promise<TokenRow> {
  const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.hubId, hubId)).limit(1);
  if (!row) throw new TenantNotFoundError(hubId);
  return {
    accessToken: openUtf8(
      { ct: row.accessTokenCt, iv: row.accessTokenIv, tag: row.accessTokenTag },
      `oauth_access:${hubId}`,
    ),
    refreshToken: openUtf8(
      { ct: row.refreshTokenCt, iv: row.refreshTokenIv, tag: row.refreshTokenTag },
      `oauth_refresh:${hubId}`,
    ),
    expiresAt: row.accessTokenExpires,
  };
}

async function refreshTokens(hubId: bigint, refreshToken: string): Promise<TokenRow> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.HUBSPOT_CLIENT_ID,
    client_secret: config.HUBSPOT_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  const res = await httpRequest(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    body: form.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (res.statusCode >= 400) {
    // Keep only HubSpot's error category; never persist the raw body.
    let category = 'unknown';
    try {
      const body = (await res.body.json()) as { category?: string; status?: string };
      category = body.category ?? body.status ?? 'unknown';
    } catch {
      /* non-JSON body */
    }
    throw new ExternalServiceError(
      'hubspot',
      `token refresh failed: HTTP ${res.statusCode}: ${category}`,
      res.statusCode,
    );
  }
  const payload = (await res.body.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  const newAccess = seal(payload.access_token, `oauth_access:${hubId}`);
  const newRefresh = seal(payload.refresh_token, `oauth_refresh:${hubId}`);
  const expiresAt = new Date(Date.now() + payload.expires_in * 1000);

  await db
    .update(oauthTokens)
    .set({
      accessTokenCt: newAccess.ct,
      accessTokenIv: newAccess.iv,
      accessTokenTag: newAccess.tag,
      accessTokenExpires: expiresAt,
      refreshTokenCt: newRefresh.ct,
      refreshTokenIv: newRefresh.iv,
      refreshTokenTag: newRefresh.tag,
      updatedAt: new Date(),
    })
    .where(eq(oauthTokens.hubId, hubId));

  logger.info({ hubId: hubId.toString(), expiresAt }, 'hubspot token refreshed');

  return { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt };
}

export async function getAccessToken(hubId: bigint, opts: { force?: boolean } = {}): Promise<string> {
  const tokens = await loadTokens(hubId);
  if (opts.force || tokens.expiresAt.getTime() - Date.now() <= REFRESH_LEAD_MS) {
    const refreshed = await refreshTokens(hubId, tokens.refreshToken);
    return refreshed.accessToken;
  }
  return tokens.accessToken;
}

export async function getHubSpotClient(
  hubId: bigint,
  opts: { forceRefresh?: boolean } = {},
): Promise<HubSpotClient> {
  const accessToken = await getAccessToken(hubId, { force: opts.forceRefresh });
  return new HubSpotClient({ accessToken });
}

/**
 * Runs `fn` with a client; if HubSpot answers 401 (token revoked or expired
 * early, before our stored expiry says so) the token is refreshed once and
 * `fn` is retried with a fresh client. Any other failure propagates.
 */
export async function withHubSpotClient<T>(
  hubId: bigint,
  fn: (hs: HubSpotClient) => Promise<T>,
): Promise<T> {
  try {
    return await fn(await getHubSpotClient(hubId));
  } catch (err) {
    if (err instanceof ExternalServiceError && err.upstreamStatus === 401) {
      logger.warn({ hubId: hubId.toString() }, 'hubspot 401 — forcing token refresh and retrying once');
      return fn(await getHubSpotClient(hubId, { forceRefresh: true }));
    }
    throw err;
  }
}
