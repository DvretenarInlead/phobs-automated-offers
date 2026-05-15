import { TOTP, Secret } from 'otpauth';
import { createHash, randomBytes } from 'node:crypto';
import { safeEquals } from '../crypto/tokenVault.js';

const ISSUER = 'Phobs Offers';
const STEP_SECONDS = 30;
const WINDOW = 1; // ± one step tolerance

export interface NewTotp {
  base32Secret: string;
  uri: string; // otpauth:// URL for QR
}

export function generateTotp(email: string): NewTotp {
  const secret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: STEP_SECONDS,
    secret,
  });
  return { base32Secret: secret.base32, uri: totp.toString() };
}

export function verifyTotp(base32Secret: string, code: string): boolean {
  const totp = new TOTP({
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: 6,
    period: STEP_SECONDS,
    secret: Secret.fromBase32(base32Secret),
  });
  const delta = totp.validate({ token: code, window: WINDOW });
  return delta !== null;
}

/**
 * Recovery codes are 10 codes of 10 characters each. We store SHA-256 hashes
 * (no salt — high entropy means no rainbow-table risk and we need O(1) check
 * across the list).
 */
export function generateRecoveryCodes(count = 10): {
  plain: string[];
  hashes: string[];
} {
  const plain: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = randomBytes(8).toString('hex'); // 16 hex chars
    plain.push(code);
    hashes.push(createHash('sha256').update(code).digest('hex'));
  }
  return { plain, hashes };
}

/** Returns the index of the consumed recovery code, or -1 if none matched. */
export function findRecoveryMatch(stored: string[], submitted: string): number {
  const want = createHash('sha256').update(submitted.trim()).digest('hex');
  for (let i = 0; i < stored.length; i++) {
    const s = stored[i];
    if (s && safeEquals(s, want)) return i;
  }
  return -1;
}
