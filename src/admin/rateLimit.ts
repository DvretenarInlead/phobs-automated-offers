import { setTimeout as delay } from 'node:timers/promises';
import { makeRedis } from '../queue/index.js';
import type { Redis } from 'ioredis';

let r: Redis | null = null;
function redis(): Redis {
  // Request-path client: fail fast on a Redis outage rather than hang logins.
  if (!r) r = makeRedis({ failFast: true });
  return r;
}

// Login throttling, two layers:
//
//   * SOFT (per email): progressive delays (100ms → ~4s) after a few failed
//     attempts. Still lets the correct password through, so a shared
//     corporate NAT can't lock a colleague out. Slows credential stuffing.
//   * HARD (per email + client IP): full lock for the window. Scoped to the
//     IP so an attacker who merely knows an admin's email cannot lock the
//     real admin out from their own network. Superadmins can clear it from
//     the Users page (POST /users/:id/unlock).
//
// Counters are bumped only on an actual failed credential/MFA check, never on
// requests that fail CSRF or validation — those can't be used to lock anyone.

export const LOGIN_SOFT_LIMIT = 5;
export const LOGIN_HARD_LOCK = 25;
export const LOGIN_WINDOW_SEC = 60 * 60; // 1 h

function softKey(email: string): string {
  return `login:fail:${email.toLowerCase()}`;
}
function hardKey(email: string, ip: string): string {
  return `login:hardfail:${email.toLowerCase()}:${ip}`;
}

async function bump(k: string, windowSec: number): Promise<number> {
  const tx = redis().multi();
  tx.incr(k);
  tx.expire(k, windowSec, 'NX');
  const results = await tx.exec();
  const first = results?.[0]?.[1];
  return typeof first === 'number' ? first : Number(first ?? 0);
}

async function get(k: string): Promise<number> {
  const v = await redis().get(k);
  return v ? Number(v) : 0;
}

/** Current failure counts for an account before an attempt is evaluated. */
export async function getLoginFailures(
  email: string,
  ip: string,
): Promise<{ soft: number; hard: number }> {
  const [soft, hard] = await Promise.all([get(softKey(email)), get(hardKey(email, ip))]);
  return { soft, hard };
}

/** Records a failed login. Returns the updated counts. */
export async function bumpLoginFailure(
  email: string,
  ip: string,
): Promise<{ soft: number; hard: number }> {
  const [soft, hard] = await Promise.all([
    bump(softKey(email), LOGIN_WINDOW_SEC),
    bump(hardKey(email, ip), LOGIN_WINDOW_SEC),
  ]);
  return { soft, hard };
}

/** Clears the soft counter after a successful login (hard counters for other IPs stay). */
export async function resetLoginFailures(email: string, ip?: string): Promise<void> {
  await redis().del(softKey(email));
  if (ip) await redis().del(hardKey(email, ip));
}

/**
 * Superadmin unlock: clears the soft counter and every hard-lock counter for
 * the account regardless of IP.
 */
export async function unlockAccount(email: string): Promise<number> {
  const pattern = `login:hardfail:${email.toLowerCase()}:*`;
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await redis().scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    if (keys.length > 0) removed += await redis().del(...keys);
  } while (cursor !== '0');
  removed += await redis().del(softKey(email));
  return removed;
}

/**
 * Progressive delay based on the failure count so far. 100ms → 200ms → 500ms
 * → 1s → 2s → 4s (capped). Keeps the response constant-time-ish for
 * enumeration mitigation while penalising stuffing bots.
 */
export function progressiveDelayMs(failureCount: number): number {
  if (failureCount <= 0) return 0;
  const steps = [100, 200, 500, 1000, 2000, 4000];
  return steps[Math.min(failureCount - 1, steps.length - 1)]!;
}

export async function applyLoginBackoff(count: number): Promise<void> {
  const ms = progressiveDelayMs(count);
  if (ms > 0) await delay(ms);
}

// ---------- SSE per-user connection cap ------------------------------------

const SSE_CAP_PER_USER = 8;
const SSE_TTL_SEC = 60 * 60;

/**
 * Register an SSE connection for an admin user. Returns { ok: true, count }
 * if under the cap, or { ok: false, count } if the user already holds
 * SSE_CAP_PER_USER connections. Callers must invoke `releaseSseSlot` on
 * disconnect regardless of the accept outcome (release is a no-op if the
 * slot was never claimed).
 */
export async function acquireSseSlot(adminUserId: bigint): Promise<{ ok: boolean; count: number }> {
  const k = `sse:cap:${adminUserId.toString()}`;
  const tx = redis().multi();
  tx.incr(k);
  tx.expire(k, SSE_TTL_SEC, 'NX');
  const results = await tx.exec();
  const rawFirst = results?.[0]?.[1];
  const count = typeof rawFirst === 'number' ? rawFirst : Number(rawFirst ?? 0);
  if (count > SSE_CAP_PER_USER) {
    await redis().decr(k).catch(() => undefined);
    return { ok: false, count: count - 1 };
  }
  return { ok: true, count };
}

export async function releaseSseSlot(adminUserId: bigint): Promise<void> {
  const k = `sse:cap:${adminUserId.toString()}`;
  // Never let the counter go negative — clean up if we hit 0.
  const remaining = await redis().decr(k).catch(() => 0);
  if (remaining <= 0) await redis().del(k).catch(() => undefined);
}
