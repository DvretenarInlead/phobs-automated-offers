import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../admin/auth.js';
import { writeAdminAudit } from '../admin/audit.js';
import { listApiTokens, mintApiToken, revokeApiToken } from '../lib/apiTokens.js';

const hubIdParam = z.object({ hubId: z.string().regex(/^\d+$/) });
const mintSchema = z.object({ name: z.string().min(1).max(128) });
const tokenIdParam = z.object({
  hubId: z.string().regex(/^\d+$/),
  tokenId: z.string().regex(/^\d+$/),
});

export function registerAdminApiTokenRoutes(
  app: FastifyInstance,
  prefix = '/api/admin',
): void {
  // LIST — hashes only, no plaintext
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
          createdAt: t.createdAt.toISOString(),
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
          revokedAt: t.revokedAt?.toISOString() ?? null,
        })),
      });
    },
  );

  // MINT — plaintext returned ONCE in the response. Never retrievable again.
  app.post(
    `${prefix}/tenants/:hubId/api-tokens`,
    { preHandler: requireRole('tenant_admin', { hubIdParam: 'hubId' }) },
    async (req, reply) => {
      const { hubId } = hubIdParam.parse(req.params);
      const body = mintSchema.parse(req.body);
      const minted = await mintApiToken({
        hubId: BigInt(hubId),
        name: body.name,
        createdByAdminUserId: req.adminUser!.id,
      });
      await writeAdminAudit({
        adminUserId: req.adminUser!.id,
        action: 'api_token.mint',
        target: `hub_id=${hubId} token_id=${minted.id.toString()}`,
        ip: req.ip,
        after: { name: minted.name, prefix: minted.prefix },
      });
      return reply.send({
        ok: true,
        id: minted.id.toString(),
        name: minted.name,
        prefix: minted.prefix,
        token: minted.plaintext,
        createdAt: minted.createdAt.toISOString(),
        warning:
          'Store this token now. It is not retrievable later — only the hash is kept.',
      });
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
}
