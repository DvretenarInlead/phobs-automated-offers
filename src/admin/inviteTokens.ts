import { createHmac } from 'node:crypto';
import { loadConfig } from '../config.js';
import { safeEquals } from '../crypto/tokenVault.js';

const config = loadConfig();
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface InvitePayload {
  /** admin_users.id of the row that was inserted in pending state */
  userId: string;
  /** lowercase email at issue time */
  email: string;
  /** issued-at, ms since epoch */
  iat: number;
}

/**
 * Format: base64url(JSON(payload)) + '.' + base64url(HMAC).
 * Bound to `sessionSecret`, single-purpose (no shared usage with CSRF tokens
 * because the payload shape differs and the field names are explicit).
 */
export function signInvite(p: InvitePayload): string {
  const body = Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
  const sig = mac(`invite|${body}`);
  return `${body}.${sig}`;
}

export function verifyInvite(token: string): InvitePayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = mac(`invite|${body}`);
  if (!safeEquals(sig, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isPayload(parsed)) return null;
  if (Date.now() - parsed.iat > TTL_MS) return null;
  return parsed;
}

function isPayload(v: unknown): v is InvitePayload {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as InvitePayload).userId === 'string' &&
    typeof (v as InvitePayload).email === 'string' &&
    typeof (v as InvitePayload).iat === 'number'
  );
}

function mac(input: string): string {
  return createHmac('sha256', config.sessionSecret).update(input).digest('base64url');
}
