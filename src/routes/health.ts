import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { makeRedis } from '../queue/index.js';
import { logger } from '../lib/logger.js';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = { db: 'fail', redis: 'fail' };
    try {
      await db.execute(sql`SELECT 1`);
      checks.db = 'ok';
    } catch (err) {
      logger.warn({ err }, 'readyz: db check failed');
    }
    let redis: ReturnType<typeof makeRedis> | null = null;
    try {
      redis = makeRedis();
      const pong = await redis.ping();
      if (pong === 'PONG') checks.redis = 'ok';
    } catch (err) {
      logger.warn({ err }, 'readyz: redis check failed');
    } finally {
      if (redis) redis.disconnect();
    }
    const ready = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'degraded', checks });
  });
}
