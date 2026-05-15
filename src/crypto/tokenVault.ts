import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadConfig } from '../config.js';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM standard
const TAG_LENGTH = 16;

export interface SealedBytes {
  ct: Buffer; // ciphertext
  iv: Buffer; // 12 bytes
  tag: Buffer; // 16 bytes
}

export interface Sealed extends SealedBytes {
  /** Indicates which key was used. Forward-compatible for rotation. */
  version: 1;
}

/**
 * Encrypts a plaintext value with AES-256-GCM, binding it to an AAD string so
 * a ciphertext from one context cannot be decrypted as another.
 *
 * AAD convention: `"<kind>:<id>"` e.g. `"oauth_token:12345"` or
 * `"phobs_pass:12345"`. This pairs each ciphertext to its row.
 */
export function seal(plaintext: string | Buffer, aad: string): Sealed {
  const { tokenVaultKey } = loadConfig();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, tokenVaultKey, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([
    cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return { ct, iv, tag, version: 1 };
}

/**
 * Decrypts. Tries the primary key first; on auth tag failure, falls back to
 * `TOKEN_VAULT_KEY_PREV` if configured. Returns plaintext bytes.
 */
export function open(sealed: SealedBytes, aad: string): Buffer {
  const { tokenVaultKey, tokenVaultKeyPrev } = loadConfig();
  try {
    return decryptWith(tokenVaultKey, sealed, aad);
  } catch (primaryErr) {
    if (tokenVaultKeyPrev) {
      try {
        return decryptWith(tokenVaultKeyPrev, sealed, aad);
      } catch {
        throw primaryErr;
      }
    }
    throw primaryErr;
  }
}

export function openUtf8(sealed: SealedBytes, aad: string): string {
  return open(sealed, aad).toString('utf8');
}

function decryptWith(key: Buffer, sealed: SealedBytes, aad: string): Buffer {
  if (sealed.iv.length !== IV_LENGTH) throw new Error('vault: bad IV length');
  if (sealed.tag.length !== TAG_LENGTH) throw new Error('vault: bad tag length');
  const decipher = createDecipheriv(ALGO, key, sealed.iv, { authTagLength: TAG_LENGTH });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ct), decipher.final()]);
}

/**
 * Constant-time equality for any token comparison (e.g. CSRF, recovery codes).
 */
export function safeEquals(a: Buffer | string, b: Buffer | string): boolean {
  const ba = typeof a === 'string' ? Buffer.from(a) : a;
  const bb = typeof b === 'string' ? Buffer.from(b) : b;
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
