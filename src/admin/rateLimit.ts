import { setTimeout as delay } from 'node:timers/promises';
import { makeRedis } from '../queue/index.js';
import type { Redis } from 'ioredis';

let r: Redis | null = null;
function redis(): Redis {
  if (!r) r = makeRedis();
  return r;
}

// Sliding-window counter helpers. Failure counters are keyed by *email* alone
// so a shared corporate NAT (many users behind one IP) can't get self-locked
// by another employee typo-ing their password. Per-IP flood protection lives
// at the Fastify @fastify/rate-limit layer on the login route itself.
//
// Two thresholds:
//   * SOFT — kicks in progressive delays (100ms → up to ~4s) but still lets
//     the correct password through. Protects against automated stuffing.
//   * HARD — full lock, requires admin unlock or 24h expiry. Very high so
//     an attacker who knows the email cannot casually deny service.

export const LOGIN_SOFT_LIMIT = 5;
export const LOGIN_HARD_LOCK = 50;
export const LOGIN_WINDOW_SEC = 60 * 60; // 1 h

async function bump(kind: string, subject: string, windowSec: number): Promise<number> {
  const k = `${kind}:${subject}`;
  const tx = redis().multi();
  tx.incr(k);
  tx.expire(k, windowSec, 'NX');
  const results = await tx.exec();
  const first = results?.[0]?.[1];
  return typeof first === 'number' ? first : Number(first ?? 0);
}

async function reset(kind: string, subject: string): Promise<void> {
  await redis().del(`${kind}:${subject}`);
}

/**
 * Records a failed login for an account (identified by lowercased email).
 * Returns the new failure count. Caller applies progressive delay + hard-lock
 * check based on the returned value.
 */
export function bumpLoginFailure(email: string): Promise<number> {
  return bump('login:fail', email.toLowerCase(), LOGIN_WINDOW_SEC);
}

export function resetLoginFailures(email: string): Promise<void> {
  return reset('login:fail', email.toLowerCase());
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

// ---------- Compat aliases (kept for legacy call sites) --------------------
// The old (email, ip) tuple key is retained as a thin wrapper so any missed
// call site keeps working during the rollout.

export const LOGIN_LOCKOUT_THRESHOLD = LOGIN_HARD_LOCK;
export function bumpLoginAttempt(key: string, windowSec = LOGIN_WINDOW_SEC): Promise<number> {
  return bump('login:fail', key, windowSec);
}
export function resetLoginAttempts(key: string): Promise<void> {
  return reset('login:fail', key);
}
