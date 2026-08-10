import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { apiTokens } from '../db/schema.js';

/**
 * Per-tenant API tokens for the public `POST /api/trigger` endpoint.
 *
 * Format:      phk_<base64url-32bytes>          (47 chars total, "phk" = phobs key)
 * Prefix:      first 12 chars of the plaintext token (e.g. "phk_YWJjZGVm")
 *              retained in the row so the UI can identify a token without
 *              knowing the plaintext.
 * Storage:     SHA-256 hash. Never store plaintext. Verify constant-time.
 *
 * Threat model: a leaked hash cannot forge a token (SHA-256 preimage
 * resistance). Revoke by setting revokedAt — verify() rejects revoked rows.
 */

const TOKEN_PREFIX = 'phk_';
const TOKEN_ENTROPY_BYTES = 32;

export interface MintedToken {
  id: bigint;
  hubId: bigint;
  name: string;
  /** ONLY returned once, at mint time. Not persisted in plaintext. */
  plaintext: string;
  /** First 12 chars of plaintext, safe to show in the UI list. */
  prefix: string;
  ipAllowlistCidrs: string[];
  createdAt: Date;
}

export interface ApiTokenRow {
  id: bigint;
  hubId: bigint;
  name: string;
  tokenPrefix: string;
  ipAllowlistCidrs: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Generates a new token, hashes it, and inserts the row. Returns the
 * plaintext to the caller — the only opportunity to capture it.
 */
export async function mintApiToken(input: {
  hubId: bigint;
  name: string;
  ipAllowlistCidrs?: string[];
  createdByAdminUserId?: bigint | null;
}): Promise<MintedToken> {
  const plaintext = TOKEN_PREFIX + randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url');
  const prefix = plaintext.slice(0, 12);
  const hash = hashToken(plaintext);
  const ipAllowlistCidrs = input.ipAllowlistCidrs ?? [];

  const [row] = await db
    .insert(apiTokens)
    .values({
      hubId: input.hubId,
      name: input.name,
      tokenPrefix: prefix,
      tokenHash: hash,
      ipAllowlistCidrs,
      createdByAdminUserId: input.createdByAdminUserId ?? null,
    })
    .returning({
      id: apiTokens.id,
      hubId: apiTokens.hubId,
      name: apiTokens.name,
      createdAt: apiTokens.createdAt,
    });
  if (!row) throw new Error('mintApiToken: insert returned no row');

  return {
    id: row.id,
    hubId: row.hubId,
    name: row.name,
    plaintext,
    prefix,
    ipAllowlistCidrs,
    createdAt: row.createdAt,
  };
}

/** Replaces the IP allow-list on an existing token. Empty array clears it. */
export async function updateApiTokenAllowlist(
  hubId: bigint,
  tokenId: bigint,
  cidrs: string[],
): Promise<boolean> {
  const res = await db
    .update(apiTokens)
    .set({ ipAllowlistCidrs: cidrs })
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.hubId, hubId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  return res.length > 0;
}

/**
 * Verifies a bearer token. Returns the token row (with hub_id) if the token
 * is valid and not revoked; null otherwise. Timing-safe against the stored
 * hash (equality of two 64-char hex strings via timingSafeEqual).
 *
 * On success, updates last_used_at asynchronously (fire-and-forget) so hot
 * paths don't wait on it.
 */
export async function verifyApiToken(plaintext: string): Promise<ApiTokenRow | null> {
  if (!plaintext.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(plaintext);

  const [row] = await db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, hash), isNull(apiTokens.revokedAt)))
    .limit(1);
  if (!row) return null;

  // timingSafeEqual is defence-in-depth — the DB lookup by exact hash is
  // already constant-time relative to the token contents; this catches any
  // future refactor that starts scanning a range.
  const a = Buffer.from(row.tokenHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Best-effort last_used bump — don't block the trigger on this.
  void db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, row.id))
    .catch(() => undefined);

  return {
    id: row.id,
    hubId: row.hubId,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    ipAllowlistCidrs: (row.ipAllowlistCidrs as string[] | null) ?? [],
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

export async function listApiTokens(hubId: bigint): Promise<ApiTokenRow[]> {
  const rows = await db
    .select({
      id: apiTokens.id,
      hubId: apiTokens.hubId,
      name: apiTokens.name,
      tokenPrefix: apiTokens.tokenPrefix,
      ipAllowlistCidrs: apiTokens.ipAllowlistCidrs,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      revokedAt: apiTokens.revokedAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.hubId, hubId));
  return rows.map((r) => ({
    ...r,
    ipAllowlistCidrs: (r.ipAllowlistCidrs as string[] | null) ?? [],
  }));
}

export async function revokeApiToken(hubId: bigint, tokenId: bigint): Promise<boolean> {
  const result = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiTokens.id, tokenId),
        eq(apiTokens.hubId, hubId),
        isNull(apiTokens.revokedAt),
      ),
    )
    .returning({ id: apiTokens.id });
  return result.length > 0;
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}
