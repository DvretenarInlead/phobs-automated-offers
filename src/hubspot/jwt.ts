import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyResult } from 'jose';
import { loadConfig } from '../config.js';

/**
 * HubSpot Workflow Extension signed-request verifier.
 *
 * HubSpot signs custom workflow action invocations with a JWT in the
 * `Authorization: Bearer <jwt>` header. The JWT is signed by HubSpot using
 * keys published at a JWKS endpoint.
 *
 * NOTE: The exact JWKS URL must be confirmed in HubSpot's developer docs for
 * your account region. Set HUBSPOT_JWKS_URL in env to override the default.
 */
const DEFAULT_JWKS_URL = 'https://api.hubapi.com/.well-known/jwks.json';

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks) {
    const url = new URL(process.env.HUBSPOT_JWKS_URL ?? DEFAULT_JWKS_URL);
    jwks = createRemoteJWKSet(url, {
      cacheMaxAge: 60 * 60 * 1000, // 1h
      cooldownDuration: 30 * 1000,
    });
  }
  return jwks;
}

export interface ExtensionClaims extends JWTPayload {
  hub_id?: number;
  portalId?: number;
  user_id?: number;
}

export async function verifyExtensionJwt(token: string): Promise<JWTVerifyResult<ExtensionClaims>> {
  const cfg = loadConfig();
  return jwtVerify<ExtensionClaims>(token, getJwks(), {
    issuer: 'https://api.hubspot.com',
    audience: cfg.HUBSPOT_APP_ID,
    clockTolerance: 30,
  });
}

export function extractHubId(claims: ExtensionClaims): bigint | null {
  const v = claims.hub_id ?? claims.portalId;
  return typeof v === 'number' ? BigInt(v) : null;
}
