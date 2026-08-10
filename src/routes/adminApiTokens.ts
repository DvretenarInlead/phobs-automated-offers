import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenantConfig } from '../db/schema.js';
import { requireRole } from '../admin/auth.js';
import { writeAdminAudit } from '../admin/audit.js';
import {
  listApiTokens,
  mintApiToken,
  revokeApiToken,
  updateApiTokenAllowlist,
} from '../lib/apiTokens.js';
import { compileAllowlist } from '../lib/ipAllowlist.js';
import { invalidateWebhookAllowlist } from '../tenancy/webhookAllowlist.js';

const hubIdParam = z.object({ hubId: z.string().regex(/^\d+$/) });
const cidrs = z.array(z.string().min(1).max(64)).max(256).default([]);
const mintSchema = z.object({
  name: z.string().min(1).max(128),
  ip_allowlist_cidrs: cidrs.optional(),
});
const updateAllowlistSchema = z.object({ ip_allowlist_cidrs: cidrs });
const webhookAllowlistSchema = z.object({ webhook_ip_allowlist_cidrs: cidrs });
const tokenIdParam = z.object({
  hubId: z.string().regex(/^\d+$/),
  tokenId: z.string().regex(/^\d+$/),
});

export function registerAdminApiTokenRoutes(
  app: FastifyInstance,
  prefix = '/api/admin',
): void {
  // LIST — hashes only, no plaintext, includes ip_allowlist_cidrs
  app.get(
    `${prefix}/tenants/:hubId/api-tokens`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    async (req, reply) => {
      const { hubId } = hubIdParam.parse(req.params);
      const rows = await listApiTokens(BigInt(hubId));
      return reply.send({
        tokens: rows.map((t) => ({
          id: t.id.toString(),
          name: t.name,
          prefix: t.tokenPrefix,
          ip_allowlist_cidrs: t.ipAllowlistCidrs,
          createdAt: t.createdAt.toISOString(),
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
          revokedAt: t.revokedAt?.toISOString() ?? null,
        })),
      });
    },
  );

  // MINT — plaintext returned ONCE. Optional IP allow-list at creation time.
  app.post(
    `${prefix}/tenants/:hubId/api-tokens`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    async (req, reply) => {
      const { hubId } = hubIdParam.parse(req.params);
      const body = mintSchema.parse(req.body);
      const validated = validateCidrs(body.ip_allowlist_cidrs ?? []);
      if (validated.invalid.length > 0) {
        return reply
          .code(400)
          .send({ error: 'invalid_cidrs', invalid: validated.invalid });
      }
      const minted = await mintApiToken({
        hubId: BigInt(hubId),
        name: body.name,
        ipAllowlistCidrs: body.ip_allowlist_cidrs ?? [],
        createdByAdminUserId: req.adminUser!.id,
      });
      await writeAdminAudit({
        adminUserId: req.adminUser!.id,
        action: 'api_token.mint',
        target: `hub_id=${hubId} token_id=${minted.id.toString()}`,
        ip: req.ip,
        after: {
          name: minted.name,
          prefix: minted.prefix,
          ip_allowlist_cidrs: minted.ipAllowlistCidrs,
        },
      });
      return reply.send({
        ok: true,
        id: minted.id.toString(),
        name: minted.name,
        prefix: minted.prefix,
        ip_allowlist_cidrs: minted.ipAllowlistCidrs,
        token: minted.plaintext,
        createdAt: minted.createdAt.toISOString(),
        warning:
          'Store this token now. It is not retrievable later — only the hash is kept.',
      });
    },
  );

  // UPDATE ip_allowlist_cidrs on an existing token
  app.put(
    `${prefix}/tenants/:hubId/api-tokens/:tokenId/allowlist`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    async (req, reply) => {
      const { hubId, tokenId } = tokenIdParam.parse(req.params);
      const body = updateAllowlistSchema.parse(req.body);
      const validated = validateCidrs(body.ip_allowlist_cidrs);
      if (validated.invalid.length > 0) {
        return reply
          .code(400)
          .send({ error: 'invalid_cidrs', invalid: validated.invalid });
      }
      const ok = await updateApiTokenAllowlist(
        BigInt(hubId),
        BigInt(tokenId),
        body.ip_allowlist_cidrs,
      );
      if (!ok) {
        return reply.code(404).send({ error: 'not_found_or_revoked' });
      }
      await writeAdminAudit({
        adminUserId: req.adminUser!.id,
        action: 'api_token.allowlist_update',
        target: `hub_id=${hubId} token_id=${tokenId}`,
        ip: req.ip,
        after: { ip_allowlist_cidrs: body.ip_allowlist_cidrs },
      });
      return reply.send({ ok: true });
    },
  );

  // REVOKE
  app.post(
    `${prefix}/tenants/:hubId/api-tokens/:tokenId/revoke`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    async (req, reply) => {
      const { hubId, tokenId } = tokenIdParam.parse(req.params);
      const revoked = await revokeApiToken(BigInt(hubId), BigInt(tokenId));
      if (!revoked) {
        return reply.code(404).send({ error: 'not_found_or_already_revoked' });
      }
      await writeAdminAudit({
        adminUserId: req.adminUser!.id,
        action: 'api_token.revoke',
        target: `hub_id=${hubId} token_id=${tokenId}`,
        ip: req.ip,
      });
      return reply.send({ ok: true });
    },
  );

  // Webhook IP allow-list (per tenant) — read + write. Empty array = allow
  // all, which is the safe default. Enforced in src/routes/webhook.ts after
  // signature/JWT verification.
  app.get(
    `${prefix}/tenants/:hubId/webhook-allowlist`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    async (req, reply) => {
      const { hubId } = hubIdParam.parse(req.params);
      const [row] = await db
        .select({ webhookIpAllowlistCidrs: tenantConfig.webhookIpAllowlistCidrs })
        .from(tenantConfig)
        .where(eq(tenantConfig.hubId, BigInt(hubId)))
        .limit(1);
      return reply.send({
        webhook_ip_allowlist_cidrs:
          (row?.webhookIpAllowlistCidrs as string[] | null) ?? [],
      });
    },
  );

  app.put(
    `${prefix}/tenants/:hubId/webhook-allowlist`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    async (req, reply) => {
      const { hubId } = hubIdParam.parse(req.params);
      const body = webhookAllowlistSchema.parse(req.body);
      const validated = validateCidrs(body.webhook_ip_allowlist_cidrs);
      if (validated.invalid.length > 0) {
        return reply
          .code(400)
          .send({ error: 'invalid_cidrs', invalid: validated.invalid });
      }
      await db
        .update(tenantConfig)
        .set({
          webhookIpAllowlistCidrs: body.webhook_ip_allowlist_cidrs,
          updatedAt: new Date(),
        })
        .where(eq(tenantConfig.hubId, BigInt(hubId)));
      invalidateWebhookAllowlist(BigInt(hubId));
      await writeAdminAudit({
        adminUserId: req.adminUser!.id,
        action: 'tenant.webhook_allowlist_update',
        target: `hub_id=${hubId}`,
        ip: req.ip,
        after: { webhook_ip_allowlist_cidrs: body.webhook_ip_allowlist_cidrs },
      });
      return reply.send({ ok: true });
    },
  );
}

function validateCidrs(list: string[]): { invalid: string[] } {
  const compiled = compileAllowlist(list);
  return { invalid: compiled.invalid };
}
