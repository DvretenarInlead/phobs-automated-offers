import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { makeRedis } from '../queue/index.js';
import { requireRole } from '../admin/auth.js';
import { liveChannelKey } from '../lib/liveEmit.js';
import type { LiveChannel } from '../lib/liveEmit.js';
import { logger } from '../lib/logger.js';

const MAX_EVENTS_PER_SECOND = 500;

const hubParam = z.object({ hubId: z.string().regex(/^\d+$/) });

export function registerAdminLiveRoutes(app: FastifyInstance, prefix = '/api/admin'): void {
  const open = (channel: LiveChannel) =>
    async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
      const { hubId: hubIdStr } = hubParam.parse(req.params);
      const hubId = BigInt(hubIdStr);

      // tenant_admin scope is enforced by the route-level preHandler; this is
      // a defence-in-depth assertion.
      if (
        req.adminUser?.role === 'tenant_admin' &&
        req.adminUser.scopedHubId !== hubId
      ) {
        return reply.code(403).send({ error: 'cross_tenant_denied' });
      }

      await streamSse(reply, req, liveChannelKey(channel, hubId));
    };

  app.get(
    `${prefix}/live/webhooks/:hubId`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    open('webhooks'),
  );
  app.get(
    `${prefix}/live/jobs/:hubId`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    open('jobs'),
  );
  app.get(
    `${prefix}/live/ext/:hubId`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    open('ext'),
  );
  app.get(
    `${prefix}/live/filter/:hubId`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    open('filter'),
  );
}

async function streamSse(
  reply: FastifyReply,
  req: FastifyRequest,
  channelKey: string,
): Promise<void> {
  const raw = reply.raw;
  raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
  raw.setHeader('cache-control', 'no-store');
  raw.setHeader('connection', 'keep-alive');
  raw.setHeader('x-accel-buffering', 'no');
  raw.flushHeaders?.();

  // Per-connection rate guard
  let windowStart = Date.now();
  let windowCount = 0;

  // Periodic keep-alive comment so proxies don't kill idle connections.
  const ka = setInterval(() => {
    if (!raw.writableEnded) raw.write(`: keepalive ${Date.now().toString()}\n\n`);
  }, 25_000);

  // Subscribe to the Redis channel; we get a dedicated subscriber per
  // connection (cheap, lazy-connected). BullMQ shares its own connections.
  const sub = makeRedis();
  try {
    await sub.subscribe(channelKey);
  } catch (err) {
    logger.warn({ err, channelKey }, 'SSE subscribe failed');
    clearInterval(ka);
    sub.disconnect();
    raw.end();
    return;
  }

  const onMessage = (_chan: string, payload: string): void => {
    if (raw.writableEnded) return;

    // Sliding 1-second window for overflow protection.
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      windowCount = 0;
    }
    windowCount++;
    if (windowCount > MAX_EVENTS_PER_SECOND) {
      if (windowCount === MAX_EVENTS_PER_SECOND + 1) {
        raw.write(`event: meta\ndata: ${JSON.stringify({ overflow: true })}\n\n`);
      }
      return;
    }
    raw.write(`data: ${payload}\n\n`);
  };
  sub.on('message', onMessage);

  // initial hello so the client knows the stream is live
  raw.write(`event: hello\ndata: ${JSON.stringify({ channel: channelKey, ts: Date.now() })}\n\n`);

  const cleanup = (): void => {
    clearInterval(ka);
    sub.off('message', onMessage);
    void sub.unsubscribe(channelKey).catch(() => undefined);
    sub.disconnect();
  };

  req.raw.once('close', cleanup);
  req.raw.once('end', cleanup);
  raw.once('close', cleanup);

  // Hold the request open until the client disconnects.
  await new Promise<void>((resolve) => {
    raw.once('close', () => resolve());
  });
}
