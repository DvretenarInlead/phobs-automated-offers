import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Job } from 'bullmq';
import { and, eq, gte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { usageDaily } from '../db/schema.js';
import { getQueue, makeRedis, QUEUE_NAME } from '../queue/index.js';
import { requireRole } from '../admin/auth.js';
import { writeAdminAudit } from '../admin/audit.js';

const failedListSchema = z.object({
  hubId: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const jobIdSchema = z.object({ jobId: z.string().min(1).max(256) });

const usageRangeSchema = z.object({
  hubId: z.string().regex(/^\d+$/),
  days: z.coerce.number().int().min(1).max(90).default(14),
});

export function registerAdminJobsRoutes(app: FastifyInstance, prefix = '/api/admin'): void {
  // GET /jobs/failed — list failed jobs, optionally filtered by hub_id
  app.get(`${prefix}/jobs/failed`, { preHandler: requireRole('tenant_admin') }, async (req, reply) => {
    const q = failedListSchema.parse(req.query);
    const user = req.adminUser!;
    const targetHubId =
      user.role === 'tenant_admin'
        ? user.scopedHubId
        : q.hubId
          ? BigInt(q.hubId)
          : null;

    const queue = getQueue();
    const failed = await queue.getJobs(['failed'], 0, q.limit, false);

    const items = failed
      .filter((j): j is Job => Boolean(j))
      .map((j) => {
        const data = j.data as { hubId?: string; source?: string } | undefined;
        return {
          id: j.id,
          name: j.name,
          attemptsMade: j.attemptsMade,
          failedReason: j.failedReason ?? null,
          timestamp: j.timestamp,
          processedOn: j.processedOn ?? null,
          finishedOn: j.finishedOn ?? null,
          hubId: data?.hubId ?? null,
          source: data?.source ?? null,
        };
      })
      .filter((j) => (targetHubId === null ? true : j.hubId === targetHubId.toString()));

    return reply.send({ items });
  });

  // POST /jobs/:jobId/retry — re-queue a failed job
  app.post(
    `${prefix}/jobs/:jobId/retry`,
    { preHandler: requireRole('tenant_admin') },
    async (req, reply) => {
      const { jobId } = jobIdSchema.parse(req.params);
      const queue = getQueue();
      const job = await queue.getJob(jobId);
      if (!job) return reply.code(404).send({ error: 'job_not_found' });

      const user = req.adminUser!;
      const data = job.data as { hubId?: string } | undefined;
      if (
        user.role === 'tenant_admin' &&
        (data?.hubId === undefined || user.scopedHubId?.toString() !== data.hubId)
      ) {
        return reply.code(403).send({ error: 'cross_tenant_denied' });
      }

      await job.retry();
      await writeAdminAudit({
        adminUserId: user.id,
        action: 'job.retry',
        target: `job_id=${jobId}`,
        ip: req.ip,
      });
      return reply.send({ ok: true, jobId });
    },
  );

  // POST /jobs/:jobId/discard — remove a failed job
  app.post(
    `${prefix}/jobs/:jobId/discard`,
    { preHandler: requireRole('tenant_admin') },
    async (req, reply) => {
      const { jobId } = jobIdSchema.parse(req.params);
      const queue = getQueue();
      const job = await queue.getJob(jobId);
      if (!job) return reply.code(404).send({ error: 'job_not_found' });

      const user = req.adminUser!;
      const data = job.data as { hubId?: string } | undefined;
      if (
        user.role === 'tenant_admin' &&
        (data?.hubId === undefined || user.scopedHubId?.toString() !== data.hubId)
      ) {
        return reply.code(403).send({ error: 'cross_tenant_denied' });
      }

      await job.remove();
      await writeAdminAudit({
        adminUserId: user.id,
        action: 'job.discard',
        target: `job_id=${jobId}`,
        ip: req.ip,
      });
      return reply.send({ ok: true });
    },
  );

  // GET /queue/stats — counts of waiting/active/failed/completed
  app.get(`${prefix}/queue/stats`, { preHandler: requireRole('tenant_admin') }, async (_req, reply) => {
    const redis = makeRedis();
    try {
      const [waiting, active, failed, completed, delayed] = await Promise.all([
        redis.llen(`bull:${QUEUE_NAME}:wait`),
        redis.llen(`bull:${QUEUE_NAME}:active`),
        redis.zcard(`bull:${QUEUE_NAME}:failed`),
        redis.zcard(`bull:${QUEUE_NAME}:completed`),
        redis.zcard(`bull:${QUEUE_NAME}:delayed`),
      ]);
      return reply.send({ waiting, active, failed, completed, delayed });
    } finally {
      redis.disconnect();
    }
  });

  // GET /tenants/:hubId/usage?days=14 — daily rollup chart data
  app.get(
    `${prefix}/tenants/:hubId/usage`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    async (req, reply) => {
      const params = usageRangeSchema.parse({ ...(req.params as object), ...(req.query as object) });
      const hubId = BigInt(params.hubId);
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - params.days);
      const sinceStr = since.toISOString().slice(0, 10);

      const rows = await db
        .select()
        .from(usageDaily)
        .where(and(eq(usageDaily.hubId, hubId), gte(usageDaily.day, sinceStr)));
      return reply.send({
        days: rows
          .map((r) => ({
            day: r.day,
            webhooks: r.webhooks,
            phobsCalls: r.phobsCalls,
            hubspotCalls: r.hubspotCalls,
            quotesCreated: r.quotesCreated,
            emailsSent: r.emailsSent,
          }))
          .sort((a, b) => a.day.localeCompare(b.day)),
      });
    },
  );

}
