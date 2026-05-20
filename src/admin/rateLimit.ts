import { makeRedis } from '../queue/index.js';
import type { Redis } from 'ioredis';

let r: Redis | null = null;
function redis(): Redis {
  if (!r) r = makeRedis();
  return r;
}

/**
 * Sliding-window counter. Used to throttle login attempts per (email, ip).
 * Returns the new count after this increment.
 */
export async function bumpLoginAttempt(key: string, windowSec = 900): Promise<number> {
  const k = `login:fail:${key}`;
  const r = redis();
  const tx = r.multi();
  tx.incr(k);
  tx.expire(k, windowSec, 'NX');
  const results = await tx.exec();
  const first = results?.[0]?.[1];
  return typeof first === 'number' ? first : Number(first ?? 0);
}

export async function resetLoginAttempts(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await redis().del(...keys.map((k) => `login:fail:${k}`));
}

/** Per (email, ip) — stops a single source brute-forcing one account. */
export const LOGIN_LOCKOUT_THRESHOLD = 10;
/**
 * Per account (email, any ip) — stops distributed credential stuffing that
 * rotates source IPs to evade the per-(email,ip) counter. Set higher and on a
 * longer window so legitimate multi-location logins aren't locked out.
 */
export const ACCOUNT_LOCKOUT_THRESHOLD = 50;
export const ACCOUNT_LOCKOUT_WINDOW_SEC = 3600;
