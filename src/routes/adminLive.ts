import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { makeRedis, waitForReady } from '../queue/index.js';
import { requireRole } from '../admin/auth.js';
import { liveChannelKey } from '../lib/liveEmit.js';
import type { LiveChannel } from '../lib/liveEmit.js';
import { acquireSseSlot, releaseSseSlot } from '../admin/rateLimit.js';
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

      // Cap concurrent SSE connections per admin user. Each connection opens
      // a dedicated ioredis subscriber and holds an HTTP socket open, so an
      // attacker with a valid session could otherwise exhaust FDs / Redis
      // client slots by opening thousands of parallel tabs.
      const adminUserId = req.adminUser!.id;
      const acquired = await acquireSseSlot(adminUserId);
      if (!acquired.ok) {
        return reply.code(429).send({ error: 'too_many_sse_connections' });
      }

      try {
        await streamSse(reply, req, liveChannelKey(channel, hubId));
      } finally {
        await releaseSseSlot(adminUserId);
      }
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

  // Dedicated subscriber per connection. Register cleanup BEFORE anything
  // that can block (subscribe), so a client that disconnects while we are
  // still connecting to Redis — or a Redis that never answers — cannot leak
  // the interval, the client or the per-user slot.
  const sub = makeRedis({ failFast: true });
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(ka);
    sub.removeAllListeners('message');
    void sub.unsubscribe(channelKey).catch(() => undefined);
    sub.disconnect();
  };
  req.raw.once('close', cleanup);
  req.raw.once('end', cleanup);
  raw.once('close', cleanup);

  try {
    await waitForReady(sub, 5_000);
    await sub.subscribe(channelKey);
  } catch (err) {
    logger.warn({ err, channelKey }, 'SSE subscribe failed');
    cleanup();
    if (!raw.writableEnded) raw.end();
    return;
  }
  if (cleaned) return; // client went away while we were connecting

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

  // Hold the request open until the client disconnects.
  await new Promise<void>((resolve) => {
    if (cleaned) return resolve();
    raw.once('close', () => resolve());
  });
}
