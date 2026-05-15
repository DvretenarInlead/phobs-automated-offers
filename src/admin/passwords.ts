import argon2 from 'argon2';
import { z } from 'zod';

/**
 * OWASP-aligned argon2id parameters. Memory cost is the dominant factor.
 * 19 MiB / 2 passes / parallelism 1 is the OWASP minimum for argon2id.
 */
const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

/** Permissive but enforces minimum length + some entropy. */
export const passwordSchema = z
  .string()
  .min(12, 'password must be at least 12 characters')
  .max(256)
  .refine((s) => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s), {
    message: 'password must include upper, lower, and digit',
  });

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
