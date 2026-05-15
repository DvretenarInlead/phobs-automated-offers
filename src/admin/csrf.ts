import { createHmac, randomBytes } from 'node:crypto';
import { loadConfig } from '../config.js';
import { safeEquals } from '../crypto/tokenVault.js';

const config = loadConfig();
const CSRF_COOKIE_NAME = '__Host-csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_TTL_MS = 24 * 60 * 60 * 1000;

export const csrfCookieName = CSRF_COOKIE_NAME;
export const csrfHeaderName = CSRF_HEADER_NAME;

/**
 * Issues a signed CSRF token. Double-submit pattern:
 *   - cookie holds `<random>.<sig>`
 *   - clients echo the same value in the `X-CSRF-Token` header
 *   - we verify both halves match AND the signature is valid
 *
 * SameSite=Strict already blocks cross-origin form submission; this is layered
 * defence and covers same-site framing attacks.
 */
export function issueCsrfToken(): string {
  const payload = `${Date.now().toString()}.${randomBytes(24).toString('base64url')}`;
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

export function verifyCsrfToken(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [tsStr, nonce, sig] = parts as [string, string, string];
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return false;
  if (Date.now() - ts > CSRF_TTL_MS) return false;
  const expected = sign(`${tsStr}.${nonce}`);
  return safeEquals(sig, expected);
}

function sign(input: string): string {
  return createHmac('sha256', config.sessionSecret).update(input).digest('base64url');
}
