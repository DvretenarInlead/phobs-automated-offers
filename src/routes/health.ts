import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sharedFailFastRedis } from '../admin/rateLimit.js';
import { logger } from '../lib/logger.js';

const CHECK_TIMEOUT_MS = 1_500;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', () => ({ status: 'ok' }));

  // Readiness: DB + Redis reachable. Both probes are bounded so an outage
  // makes this answer 503 promptly rather than hang, and the Redis probe
  // reuses the long-lived fail-fast client instead of opening (and, during
  // an outage, leaking) a new connection per call.
  app.get(
    '/readyz',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      const checks: Record<string, 'ok' | 'fail'> = { db: 'fail', redis: 'fail' };
      try {
        await withTimeout(db.execute(sql`SELECT 1`), CHECK_TIMEOUT_MS, 'db');
        checks.db = 'ok';
      } catch (err) {
        logger.warn({ err }, 'readyz: db check failed');
      }
      try {
        const redis = await withTimeout(sharedFailFastRedis(), CHECK_TIMEOUT_MS, 'redis-connect');
        const pong = await withTimeout(redis.ping(), CHECK_TIMEOUT_MS, 'redis-ping');
        if (pong === 'PONG') checks.redis = 'ok';
      } catch (err) {
        logger.warn({ err }, 'readyz: redis check failed');
      }
      const ready = Object.values(checks).every((v) => v === 'ok');
      return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'degraded', checks });
    },
  );
}
