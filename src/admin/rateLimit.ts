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

export async function resetLoginAttempts(key: string): Promise<void> {
  await redis().del(`login:fail:${key}`);
}

export const LOGIN_LOCKOUT_THRESHOLD = 10;
