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
import { overridesSchema, resolveOverrides } from '../tenancy/overrides.js';
import { seal } from '../crypto/tokenVault.js';
import { enqueueProcessDeal } from '../queue/index.js';
import { assertAllowedEndpoint, fetchAvailability, fetchPriceQuote } from '../phobs/client.js';
import { accessCodeAad, hasAccessCode, loadTenantContext } from '../tenancy/config.js';
import { invalidateWebhookAllowlist } from '../tenancy/webhookAllowlist.js';
import { generateWebhookToken, webhookPath } from '../lib/webhookToken.js';
import { loadConfig } from '../config.js';
import { buildWorkflowActionDefinition } from '../hubspot/workflowActionDefinition.js';

const config = loadConfig();
const hubIdParamSchema = z.object({ hubId: z.string().regex(/^\d+$/) });

// Admin routes that reach Phobs or the queue get their own per-user limits:
// an authenticated tenant_admin must not be able to flood Redis with 1 MB
// dead-letter payloads or use the app as a Phobs egress proxy.
const ADMIN_HEAVY_RL = {
  max: 30,
  timeWindow: '1 minute',
  keyGenerator: (req: { adminUser?: { id: bigint }; ip: string }): string =>
    `admin-heavy:${req.adminUser?.id.toString() ?? req.ip}`,
};
const ADMIN_HEAVY_BODY_LIMIT = 64 * 1024;

// Value the GET handler returns in place of secrets. A PUT carrying it back
// means "unchanged" and is ignored (never stored) — protects against a UI
// round-tripping the mask into the vault.
const MASK = '••••••••';
const notMask = (s: z.ZodString) =>
  s.refine((v) => v !== MASK, { message: 'masked placeholder is not a valid value' });

const updateConfigSchema = z.object({
  phobs_endpoint: z.string().url().max(512).optional(),
  phobs_site_id: z.string().min(1).max(128).optional(),
  phobs_auth_user: notMask(z.string().min(1).max(256)).optional(),
  phobs_auth_pass: notMask(z.string().min(1).max(256)).optional(),
  hubdb_table_id: z.string().min(1).max(64).optional(),
  hubdb_column_map: z.record(z.string().max(64), z.string().max(128)).optional(),
  quote_template_id: z.string().min(1).max(64).optional(),
  owner_id: z
    .union([z.string().regex(/^\d{1,20}$/, 'owner_id must be numeric'), z.number().int().nonnegative()])
    .optional(),
  // null clears; the mask string is treated as "unchanged" (see handler).
  access_code: z.string().max(128).nullable().optional(),
  property_rules: propertyRulesSchema.optional(),
  rate_filters: rateFiltersSchema.optional(),
  trigger_mode: z.enum(['webhook', 'workflow_extension']).optional(),
  overrides: overridesSchema.optional(),
});

// Same shape the webhook route accepts: one deal object or a non-empty array
// of them, with bounded keys. Anything else is rejected here rather than
// becoming a dead-letter job.
const dealObject = z
  .object({ hs_object_id: z.union([z.number(), z.string().regex(/^\d{1,20}$/)]) })
  .catchall(z.unknown())
  .refine((o) => Object.keys(o).length <= 200, { message: 'too many properties' });
const manualTriggerSchema = z.object({
  hubId: z.string().regex(/^\d+$/),
  payload: z.union([dealObject, z.array(dealObject).min(1).max(1)]),
});

const probeSchema = z.object({
  hubId: z.string().regex(/^\d+$/),
  propertyId: z.string().min(1).max(128),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nights: z.number().int().positive().max(60),
  adults: z.number().int().nonnegative().max(20),
  childAges: z.array(z.number().nonnegative().max(17)).max(10).default([]),
  unitIds: z.array(z.string().max(64)).max(50).default([]),
  lang: z.string().min(1).max(8).default('en'),
  /** availability = PCPropertyAvailabilityRQ (default); price_quote = PCPriceQuoteRQ */
  mode: z.enum(['availability', 'price_quote']).default('availability'),
  rateId: z.string().max(64).optional(),
  unitId: z.string().max(64).optional(),
  accessCode: z.string().max(64).optional(),
  /** Return the raw response XML (no credentials in responses). */
  includeRawXml: z.boolean().default(false),
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
        phobs_auth_user: MASK,
        phobs_auth_pass: MASK,
        hubdb_table_id: cfg.hubdbTableId,
        hubdb_column_map: cfg.hubdbColumnMap,
        quote_template_id: cfg.quoteTemplateId,
        owner_id: cfg.ownerId.toString(),
        // Loyalty access code is a shared secret with Phobs; mask like Phobs
        // creds. UI shows whether it's set via `access_code_set`.
        access_code: hasAccessCode(cfg) ? MASK : null,
        access_code_set: hasAccessCode(cfg),
        property_rules: cfg.propertyRules,
        rate_filters: cfg.rateFilters,
        trigger_mode: cfg.triggerMode,
        // Overrides is normalised through the zod schema so the UI always
        // receives a fully-populated object (defaults applied for missing
        // keys) — makes the form dead simple to render.
        overrides: resolveOverrides(cfg.overrides),
        // The token itself is never returned (hash only); the URL is shown
        // once at creation / rotation.
        webhook_token_set: Boolean(cfg.webhookTokenHash),
        webhook_token_created_at: cfg.webhookTokenCreatedAt?.toISOString() ?? null,
        webhook_url_pattern: `${config.PUBLIC_BASE_URL}${webhookPath(hubIdStr, '<token>')}`,
        updated_at: cfg.updatedAt.toISOString(),
      });
    },
  );

  // POST /tenants/:hubId/webhook-token/rotate — mint a new URL token. The
  // old URL stops working immediately; the plaintext is returned once.
  app.post(
    `${prefix}/tenants/:hubId/webhook-token/rotate`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    async (req, reply) => {
      const { hubId: hubIdStr } = hubIdParamSchema.parse(req.params);
      const hubId = BigInt(hubIdStr);
      const { token, hash } = generateWebhookToken();
      const updated = await db
        .update(tenantConfig)
        .set({ webhookTokenHash: hash, webhookTokenCreatedAt: new Date(), updatedAt: new Date() })
        .where(eq(tenantConfig.hubId, hubId))
        .returning({ hubId: tenantConfig.hubId });
      if (updated.length === 0) return reply.code(404).send({ error: 'config_not_initialized' });
      invalidateWebhookAllowlist(hubId);
      await writeAdminAudit({
        adminUserId: req.adminUser!.id,
        action: 'tenant.webhook_token_rotate',
        target: `hub_id=${hubIdStr}`,
        ip: req.ip,
      });
      return reply.send({
        ok: true,
        webhook_token: token,
        webhook_url: `${config.PUBLIC_BASE_URL}${webhookPath(hubIdStr, token)}`,
        warning: 'Copy this URL into the HubSpot workflow now. It is not retrievable later.',
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
      if (body.phobs_endpoint !== undefined) {
        // Same SSRF allow-list the client enforces at call time — fail the
        // save with a clear error instead of every job later.
        try {
          assertAllowedEndpoint(body.phobs_endpoint);
        } catch {
          return reply
            .code(400)
            .send({ error: 'invalid_phobs_endpoint', message: 'must be an https://*.phobs.net URL' });
        }
        updates.phobsEndpoint = body.phobs_endpoint;
      }
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
      if (body.access_code !== undefined && body.access_code !== MASK) {
        // Always vaulted; the legacy plaintext column is cleared on every write.
        updates.accessCode = null;
        if (body.access_code === null || body.access_code === '') {
          updates.accessCodeCt = null;
          updates.accessCodeIv = null;
          updates.accessCodeTag = null;
        } else {
          const s = seal(body.access_code, accessCodeAad(hubId));
          updates.accessCodeCt = s.ct;
          updates.accessCodeIv = s.iv;
          updates.accessCodeTag = s.tag;
        }
      }
      if (body.property_rules !== undefined) updates.propertyRules = body.property_rules;
      if (body.rate_filters !== undefined) updates.rateFilters = body.rate_filters;
      if (body.trigger_mode !== undefined) updates.triggerMode = body.trigger_mode;
      if (body.overrides !== undefined) updates.overrides = body.overrides;

      // ---- First-time configuration: create the row -----------------------
      // OAuth install only creates `tenants` + `oauth_tokens`; the config row
      // is created here, from the admin UI, once the full set of required
      // fields is supplied. A fresh webhook URL token is minted with it.
      if (!existing) {
        const [tenant] = await db
          .select({ hubId: tenantsTable.hubId })
          .from(tenantsTable)
          .where(eq(tenantsTable.hubId, hubId))
          .limit(1);
        if (!tenant) return reply.code(404).send({ error: 'tenant_not_found' });

        const missing: string[] = [];
        if (!updates.phobsEndpoint) missing.push('phobs_endpoint');
        if (!updates.phobsSiteId) missing.push('phobs_site_id');
        if (!updates.phobsAuthUserCt) missing.push('phobs_auth_user');
        if (!updates.phobsAuthPassCt) missing.push('phobs_auth_pass');
        if (!updates.hubdbTableId) missing.push('hubdb_table_id');
        if (!updates.quoteTemplateId) missing.push('quote_template_id');
        if (updates.ownerId === undefined) missing.push('owner_id');
        if (missing.length > 0) {
          return reply.code(400).send({ error: 'config_incomplete', missing });
        }

        const { token, hash } = generateWebhookToken();
        const insertRow: typeof tenantConfig.$inferInsert = {
          hubId,
          phobsEndpoint: updates.phobsEndpoint!,
          phobsSiteId: updates.phobsSiteId!,
          phobsAuthUserCt: updates.phobsAuthUserCt!,
          phobsAuthUserIv: updates.phobsAuthUserIv!,
          phobsAuthUserTag: updates.phobsAuthUserTag!,
          phobsAuthPassCt: updates.phobsAuthPassCt!,
          phobsAuthPassIv: updates.phobsAuthPassIv!,
          phobsAuthPassTag: updates.phobsAuthPassTag!,
          hubdbTableId: updates.hubdbTableId!,
          hubdbColumnMap: updates.hubdbColumnMap ?? {
            unit_id_column: 'phobs_unit_id',
            property_id_column: 'property_id',
          },
          quoteTemplateId: updates.quoteTemplateId!,
          ownerId: updates.ownerId!,
          accessCode: null,
          accessCodeCt: updates.accessCodeCt ?? null,
          accessCodeIv: updates.accessCodeIv ?? null,
          accessCodeTag: updates.accessCodeTag ?? null,
          propertyRules: updates.propertyRules ?? {},
          rateFilters: updates.rateFilters ?? {},
          triggerMode: updates.triggerMode ?? 'webhook',
          overrides: updates.overrides ?? {},
          webhookTokenHash: hash,
          webhookTokenCreatedAt: new Date(),
          updatedAt: new Date(),
        };
        await db.insert(tenantConfig).values(insertRow);
        const [created] = await db
          .select()
          .from(tenantConfig)
          .where(eq(tenantConfig.hubId, hubId))
          .limit(1);
        const afterSafe = created ? redactConfig(created) : null;
        await db.insert(tenantConfigHistory).values({
          hubId,
          adminUserId: req.adminUser!.id,
          before: null,
          after: afterSafe,
        });
        await writeAdminAudit({
          adminUserId: req.adminUser!.id,
          action: 'tenant_config.create',
          target: `hub_id=${hubIdStr}`,
          ip: req.ip,
          after: afterSafe,
        });
        invalidateWebhookAllowlist(hubId);
        return reply.send({
          ok: true,
          created: true,
          webhook_token: token,
          webhook_url: `${config.PUBLIC_BASE_URL}${webhookPath(hubIdStr, token)}`,
          warning: 'Copy this URL into the HubSpot workflow now. It is not retrievable later.',
        });
      }

      // ---- Update ---------------------------------------------------------
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
      invalidateWebhookAllowlist(hubId);

      return reply.send({ ok: true, created: false });
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
  app.post(
    `${prefix}/manual-trigger`,
    {
      preHandler: requireRole('tenant_admin'),
      bodyLimit: ADMIN_HEAVY_BODY_LIMIT,
      config: { rateLimit: ADMIN_HEAVY_RL },
    },
    async (req, reply) => {
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
  },
  );

  // GET /workflow-action-definition — superadmin only; returns the JSON
  // definition to paste into the HubSpot dev portal (Workflow Extensions).
  app.get(
    `${prefix}/workflow-action-definition`,
    { preHandler: requireRole('superadmin', { allowSuperadmin: false }) },
    (_req, reply) => reply.send(buildWorkflowActionDefinition()),
  );

  // POST /phobs-probe — diagnostic; queries Phobs without mutating HubSpot
  app.post(
    `${prefix}/phobs-probe`,
    {
      preHandler: requireRole('tenant_admin'),
      bodyLimit: ADMIN_HEAVY_BODY_LIMIT,
      config: { rateLimit: ADMIN_HEAVY_RL },
    },
    async (req, reply) => {
    const body = probeSchema.parse(req.body);
    const user = req.adminUser!;
    if (user.role === 'tenant_admin' && user.scopedHubId?.toString() !== body.hubId) {
      return reply.code(403).send({ error: 'cross_tenant_denied' });
    }
    const ctx = await loadTenantContext(BigInt(body.hubId));
    const auth = {
      siteId: ctx.phobs.siteId,
      username: ctx.phobs.username,
      password: ctx.phobs.password,
    };

    if (body.mode === 'price_quote') {
      if (!body.unitId) {
        return reply.code(400).send({ error: 'unit_id_required_for_price_quote' });
      }
      const res = await fetchPriceQuote(
        { endpoint: ctx.overrides.price_quote.endpoint ?? ctx.phobs.endpoint },
        {
          lang: body.lang,
          propertyId: body.propertyId,
          rateId: body.rateId ?? '',
          unitId: body.unitId,
          date: body.date,
          nights: body.nights,
          adults: body.adults,
          childAges: body.childAges,
          accessCode: body.accessCode,
          auth,
        },
      );
      await writeAdminAudit({
        adminUserId: user.id,
        action: 'phobs_probe.price_quote',
        target: `hub_id=${body.hubId} prop=${body.propertyId} unit=${body.unitId} rate=${body.rateId ?? ''}`,
        ip: req.ip,
      });
      return reply.send({
        mode: 'price_quote',
        success: res.success,
        error: res.error,
        sessionId: res.sessionId,
        quote: res.quote,
        rates: res.rates,
        ...(body.includeRawXml ? { rawXml: res.rawXml } : {}),
      });
    }

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
        accessCode: body.accessCode,
        auth,
      },
    );
    await writeAdminAudit({
      adminUserId: user.id,
      action: 'phobs_probe',
      target: `hub_id=${body.hubId} prop=${body.propertyId}`,
      ip: req.ip,
    });
    // Raw XML only on request — large and rarely useful in the UI.
    return reply.send({
      mode: 'availability',
      success: res.success,
      sessionId: res.sessionId,
      rates: res.rates,
      ...(body.includeRawXml ? { rawXml: res.rawXml } : {}),
    });
  },
  );
}

function redactConfig(cfg: typeof tenantConfig.$inferSelect): Record<string, unknown> {
  // Drop ciphertext blobs and the loyalty access code (a shared secret with
  // Phobs); keep everything else. History/audit only record whether it's set.
  const {
    phobsAuthUserCt: _u1,
    phobsAuthUserIv: _u2,
    phobsAuthUserTag: _u3,
    phobsAuthPassCt: _p1,
    phobsAuthPassIv: _p2,
    phobsAuthPassTag: _p3,
    accessCode: _ac,
    accessCodeCt: _ac1,
    accessCodeIv: _ac2,
    accessCodeTag: _ac3,
    ...safe
  } = cfg;
  return {
    accessCodeSet: hasAccessCode(cfg),
    ...safe,
    hubId: safe.hubId.toString(),
    ownerId: safe.ownerId.toString(),
    updatedAt: safe.updatedAt.toISOString(),
  };
}

// Stub: silences unused-import lint on dev paths.
export const __adminApiInternals = { gt };
