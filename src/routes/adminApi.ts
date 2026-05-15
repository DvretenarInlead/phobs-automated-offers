import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  auditLog,
  jobSteps,
  tenantConfig,
  tenantConfigHistory,
  tenants as tenantsTable,
} from '../db/schema.js';
import { requireRole } from '../admin/auth.js';
import { writeAdminAudit } from '../admin/audit.js';
import { propertyRulesSchema } from '../tenancy/childAgeRules.js';
import { rateFiltersSchema } from '../tenancy/rateFilters.js';
import { seal } from '../crypto/tokenVault.js';
import { enqueueProcessDeal } from '../queue/index.js';
import { fetchAvailability } from '../phobs/client.js';
import { loadTenantContext } from '../tenancy/config.js';
import { buildWorkflowActionDefinition } from '../hubspot/workflowActionDefinition.js';

const hubIdParamSchema = z.object({ hubId: z.string().regex(/^\d+$/) });

const updateConfigSchema = z.object({
  phobs_endpoint: z.string().url().optional(),
  phobs_site_id: z.string().min(1).optional(),
  phobs_auth_user: z.string().min(1).optional(),
  phobs_auth_pass: z.string().min(1).optional(),
  hubdb_table_id: z.string().min(1).optional(),
  hubdb_column_map: z.record(z.string(), z.string()).optional(),
  quote_template_id: z.string().min(1).optional(),
  owner_id: z.union([z.string(), z.number()]).optional(),
  access_code: z.string().nullable().optional(),
  property_rules: propertyRulesSchema.optional(),
  rate_filters: rateFiltersSchema.optional(),
  trigger_mode: z.enum(['webhook', 'workflow_extension']).optional(),
});

const manualTriggerSchema = z.object({
  hubId: z.string().regex(/^\d+$/),
  payload: z.unknown(),
});

const probeSchema = z.object({
  hubId: z.string().regex(/^\d+$/),
  propertyId: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nights: z.number().int().positive().max(60),
  adults: z.number().int().nonnegative(),
  childAges: z.array(z.number().nonnegative()).default([]),
  unitIds: z.array(z.string()).default([]),
  lang: z.string().default('en'),
});

export function registerAdminApiRoutes(app: FastifyInstance, prefix = '/api/admin'): void {
  // GET /tenants — list tenants visible to the caller
  app.get(`${prefix}/tenants`, { preHandler: requireRole('tenant_admin') }, async (req, reply) => {
    const user = req.adminUser!;
    let rows: { hubId: bigint; name: string; status: string; createdAt: Date }[];
    if (user.role === 'superadmin') {
      rows = await db.select().from(tenantsTable);
    } else {
      if (user.scopedHubId === null) return reply.send({ tenants: [] });
      rows = await db
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.hubId, user.scopedHubId));
    }
    return reply.send({
      tenants: rows.map((t) => ({
        hubId: t.hubId.toString(),
        name: t.name,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
      })),
    });
  });

  // GET /tenants/:hubId/config — read config (Phobs creds masked)
  app.get(
    `${prefix}/tenants/:hubId/config`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    async (req, reply) => {
      const { hubId: hubIdStr } = hubIdParamSchema.parse(req.params);
      const hubId = BigInt(hubIdStr);
      const [cfg] = await db
        .select()
        .from(tenantConfig)
        .where(eq(tenantConfig.hubId, hubId))
        .limit(1);
      if (!cfg) return reply.code(404).send({ error: 'not_found' });
      return reply.send({
        hubId: hubIdStr,
        phobs_endpoint: cfg.phobsEndpoint,
        phobs_site_id: cfg.phobsSiteId,
        phobs_auth_user: '••••••••',
        phobs_auth_pass: '••••••••',
        hubdb_table_id: cfg.hubdbTableId,
        hubdb_column_map: cfg.hubdbColumnMap,
        quote_template_id: cfg.quoteTemplateId,
        owner_id: cfg.ownerId.toString(),
        access_code: cfg.accessCode,
        property_rules: cfg.propertyRules,
        rate_filters: cfg.rateFilters,
        trigger_mode: cfg.triggerMode,
        updated_at: cfg.updatedAt.toISOString(),
      });
    },
  );

  // PUT /tenants/:hubId/config — partial update; vaulted writes for creds
  app.put(
    `${prefix}/tenants/:hubId/config`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    async (req, reply) => {
      const { hubId: hubIdStr } = hubIdParamSchema.parse(req.params);
      const hubId = BigInt(hubIdStr);
      const body = updateConfigSchema.parse(req.body);

      const [existing] = await db
        .select()
        .from(tenantConfig)
        .where(eq(tenantConfig.hubId, hubId))
        .limit(1);

      const updates: Partial<typeof tenantConfig.$inferInsert> = { updatedAt: new Date() };
      if (body.phobs_endpoint !== undefined) updates.phobsEndpoint = body.phobs_endpoint;
      if (body.phobs_site_id !== undefined) updates.phobsSiteId = body.phobs_site_id;
      if (body.phobs_auth_user !== undefined) {
        const s = seal(body.phobs_auth_user, `phobs_user:${hubId}`);
        updates.phobsAuthUserCt = s.ct;
        updates.phobsAuthUserIv = s.iv;
        updates.phobsAuthUserTag = s.tag;
      }
      if (body.phobs_auth_pass !== undefined) {
        const s = seal(body.phobs_auth_pass, `phobs_pass:${hubId}`);
        updates.phobsAuthPassCt = s.ct;
        updates.phobsAuthPassIv = s.iv;
        updates.phobsAuthPassTag = s.tag;
      }
      if (body.hubdb_table_id !== undefined) updates.hubdbTableId = body.hubdb_table_id;
      if (body.hubdb_column_map !== undefined) updates.hubdbColumnMap = body.hubdb_column_map;
      if (body.quote_template_id !== undefined) updates.quoteTemplateId = body.quote_template_id;
      if (body.owner_id !== undefined) updates.ownerId = BigInt(body.owner_id);
      if (body.access_code !== undefined) updates.accessCode = body.access_code;
      if (body.property_rules !== undefined) updates.propertyRules = body.property_rules;
      if (body.rate_filters !== undefined) updates.rateFilters = body.rate_filters;
      if (body.trigger_mode !== undefined) updates.triggerMode = body.trigger_mode;

      if (!existing) return reply.code(404).send({ error: 'config_not_initialized' });

      // Snapshot the safe-to-log subset (no creds) for history.
      const beforeSafe = redactConfig(existing);
      await db.update(tenantConfig).set(updates).where(eq(tenantConfig.hubId, hubId));
      const [after] = await db
        .select()
        .from(tenantConfig)
        .where(eq(tenantConfig.hubId, hubId))
        .limit(1);
      const afterSafe = after ? redactConfig(after) : null;

      await db.insert(tenantConfigHistory).values({
        hubId,
        adminUserId: req.adminUser!.id,
        before: beforeSafe,
        after: afterSafe,
      });
      await writeAdminAudit({
        adminUserId: req.adminUser!.id,
        action: 'tenant_config.update',
        target: `hub_id=${hubIdStr}`,
        ip: req.ip,
        before: beforeSafe,
        after: afterSafe,
      });

      return reply.send({ ok: true });
    },
  );

  // GET /tenants/:hubId/audit?after=<id>&limit=
  app.get(
    `${prefix}/tenants/:hubId/audit`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    async (req, reply) => {
      const { hubId: hubIdStr } = hubIdParamSchema.parse(req.params);
      const hubId = BigInt(hubIdStr);
      const q = z
        .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
        .parse(req.query);
      const rows = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.hubId, hubId))
        .orderBy(desc(auditLog.createdAt))
        .limit(q.limit);
      return reply.send({
        items: rows.map((r) => ({
          ...r,
          id: r.id.toString(),
          hubId: r.hubId.toString(),
          dealId: r.dealId?.toString() ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
      });
    },
  );

  // GET /jobs/:jobId/steps — bundle inspector
  app.get(
    `${prefix}/jobs/:jobId/steps`,
    { preHandler: requireRole('tenant_admin') },
    async (req, reply) => {
      const params = z.object({ jobId: z.string().min(1).max(128) }).parse(req.params);
      const user = req.adminUser!;
      const where =
        user.role === 'superadmin'
          ? eq(jobSteps.jobId, params.jobId)
          : and(eq(jobSteps.jobId, params.jobId), eq(jobSteps.hubId, user.scopedHubId!));
      const rows = await db
        .select()
        .from(jobSteps)
        .where(where)
        .orderBy(jobSteps.stepIndex);
      return reply.send({
        steps: rows.map((s) => ({
          ...s,
          id: s.id.toString(),
          hubId: s.hubId.toString(),
          dealId: s.dealId?.toString() ?? null,
          createdAt: s.createdAt.toISOString(),
        })),
      });
    },
  );

  // POST /manual-trigger — enqueue processDeal for a hand-crafted payload
  app.post(`${prefix}/manual-trigger`, { preHandler: requireRole('tenant_admin') }, async (req, reply) => {
    const body = manualTriggerSchema.parse(req.body);
    const user = req.adminUser!;
    if (user.role === 'tenant_admin' && user.scopedHubId?.toString() !== body.hubId) {
      return reply.code(403).send({ error: 'cross_tenant_denied' });
    }
    const jobId = await enqueueProcessDeal({
      hubId: body.hubId,
      source: 'manual',
      requestId: `manual-${Date.now().toString(36)}`,
      rawPayload: body.payload,
    });
    await writeAdminAudit({
      adminUserId: user.id,
      action: 'manual_trigger',
      target: `hub_id=${body.hubId}`,
      ip: req.ip,
      after: { jobId },
    });
    return reply.send({ ok: true, jobId });
  });

  // GET /workflow-action-definition — superadmin only; returns the JSON
  // definition to paste into the HubSpot dev portal (Workflow Extensions).
  app.get(
    `${prefix}/workflow-action-definition`,
    { preHandler: requireRole('superadmin', { allowSuperadmin: false }) },
    (_req, reply) => reply.send(buildWorkflowActionDefinition()),
  );

  // POST /phobs-probe — diagnostic; queries Phobs without mutating HubSpot
  app.post(`${prefix}/phobs-probe`, { preHandler: requireRole('tenant_admin') }, async (req, reply) => {
    const body = probeSchema.parse(req.body);
    const user = req.adminUser!;
    if (user.role === 'tenant_admin' && user.scopedHubId?.toString() !== body.hubId) {
      return reply.code(403).send({ error: 'cross_tenant_denied' });
    }
    const ctx = await loadTenantContext(BigInt(body.hubId));
    const res = await fetchAvailability(
      { endpoint: ctx.phobs.endpoint },
      {
        lang: body.lang,
        propertyId: body.propertyId,
        date: body.date,
        nights: body.nights,
        unitIds: body.unitIds,
        adults: body.adults,
        childAges: body.childAges,
        auth: {
          siteId: ctx.phobs.siteId,
          username: ctx.phobs.username,
          password: ctx.phobs.password,
        },
      },
    );
    await writeAdminAudit({
      adminUserId: user.id,
      action: 'phobs_probe',
      target: `hub_id=${body.hubId} prop=${body.propertyId}`,
      ip: req.ip,
    });
    // Strip raw XML from the response — large and not very useful in UI.
    return reply.send({
      success: res.success,
      sessionId: res.sessionId,
      rates: res.rates,
    });
  });
}

function redactConfig(cfg: typeof tenantConfig.$inferSelect): Record<string, unknown> {
  // Drop ciphertext blobs; keep everything else.
  const {
    phobsAuthUserCt: _u1,
    phobsAuthUserIv: _u2,
    phobsAuthUserTag: _u3,
    phobsAuthPassCt: _p1,
    phobsAuthPassIv: _p2,
    phobsAuthPassTag: _p3,
    ...safe
  } = cfg;
  return {
    ...safe,
    hubId: safe.hubId.toString(),
    ownerId: safe.ownerId.toString(),
    updatedAt: safe.updatedAt.toISOString(),
  };
}

// Stub: silences unused-import lint on dev paths.
export const __adminApiInternals = { gt };
