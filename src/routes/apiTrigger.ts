import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifyApiToken } from '../lib/apiTokens.js';
import { claimIdempotencyKey, idempotencyKeyFor } from '../lib/idempotency.js';
import { enqueueProcessDeal } from '../queue/index.js';
import { liveEmit } from '../lib/liveEmit.js';
import { writeAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';

/**
 * Public bearer-token trigger endpoint.
 *
 *   POST /api/trigger
 *   Authorization: Bearer phk_<...>
 *   Content-Type: application/json
 *   Idempotency-Key: <optional>
 *
 *   { "payload": { "hs_object_id": 12345, ... } }
 *
 * Auth: per-tenant API tokens (see src/lib/apiTokens.ts). Token maps to
 * exactly one hub_id; no cross-tenant capability.
 *
 * Idempotency: if `Idempotency-Key` header is set, the same key + hub_id
 * dedupes across retries within 7 days. Otherwise a fresh key is derived
 * from (hub_id, deal_id, payload hash) so accidental double-fires from the
 * same JSON body still dedupe.
 *
 * Response: 200 { ok, jobId, duplicate: false }
 *           200 { ok, duplicate: true }  (same idempotency key seen already)
 *           401 { error: 'unauthorized' }
 *           400 { error: 'invalid_payload' }
 *           429 { ... }  (rate limit)
 */

const bodySchema = z.object({
  payload: z.record(z.string(), z.unknown()).or(z.array(z.record(z.string(), z.unknown())).min(1)),
});

// Per-token rate limit — a compromised token can't flood us into OOM.
// 300/min is well above any legitimate integration.
const TRIGGER_RL = {
  max: 300,
  timeWindow: '1 minute',
  keyGenerator: (req: FastifyRequest): string => {
    const auth = req.headers.authorization ?? '';
    // key by token prefix so limits are per-token; falls back to IP if
    // the caller forgot the header (they'll get 401 anyway, but this
    // prevents a bare-request flood from starving legit callers).
    if (auth.startsWith('Bearer phk_')) return `trigger:${auth.slice(7, 19)}`;
    return `trigger:ip:${req.ip}`;
  },
};

export function registerApiTriggerRoutes(app: FastifyInstance): void {
  app.post(
    '/api/trigger',
    { config: { rateLimit: TRIGGER_RL } },
    async (req, reply) => {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const plaintext = auth.slice('Bearer '.length).trim();

      const token = await verifyApiToken(plaintext);
      if (!token) {
        logger.warn({ ip: req.ip, requestId: req.requestId }, 'api trigger: bad token');
        return reply.code(401).send({ error: 'unauthorized' });
      }

      let body: z.infer<typeof bodySchema>;
      try {
        body = bodySchema.parse(req.body);
      } catch {
        return reply.code(400).send({ error: 'invalid_payload' });
      }

      const item = Array.isArray(body.payload) ? body.payload[0]! : body.payload;
      const dealIdRaw = item.hs_object_id;
      if (dealIdRaw === undefined || dealIdRaw === null) {
        return reply.code(400).send({ error: 'missing_hs_object_id' });
      }
      let dealId: bigint;
      try {
        dealId = BigInt(String(dealIdRaw));
      } catch {
        return reply.code(400).send({ error: 'bad_hs_object_id' });
      }

      // Idempotency: prefer client-supplied key; otherwise derive from body.
      const idemHeader = req.headers['idempotency-key'];
      const rawKeyBytes = Buffer.from(JSON.stringify(body.payload));
      const idemKey =
        typeof idemHeader === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(idemHeader)
          ? `client:${token.hubId.toString()}:${idemHeader}`
          : idempotencyKeyFor(token.hubId, dealId, rawKeyBytes);

      const provisionalJobId = `api-${token.hubId.toString()}-${dealId.toString()}-${idemKey.slice(0, 12)}`;
      const fresh = await claimIdempotencyKey(idemKey, provisionalJobId, token.hubId);
      if (!fresh) {
        return reply.code(200).send({ ok: true, duplicate: true });
      }

      const jobId = await enqueueProcessDeal(
        {
          hubId: token.hubId.toString(),
          source: 'manual',
          requestId: req.requestId,
          rawPayload: body.payload,
        },
        { jobId: provisionalJobId },
      );

      liveEmit('webhooks', token.hubId, {
        ts: Date.now(),
        type: 'accepted',
        hubId: token.hubId.toString(),
        dealId: dealId.toString(),
        jobId,
        data: { source: 'api_trigger', tokenPrefix: token.tokenPrefix },
      });

      await writeAudit({
        hubId: token.hubId,
        dealId,
        requestId: req.requestId,
        kind: 'api.trigger',
        status: 'ok',
        request: { tokenPrefix: token.tokenPrefix, hasIdempotencyKey: Boolean(idemHeader) },
        response: { jobId },
      });

      return reply.code(200).send({ ok: true, jobId, duplicate: false });
    },
  );
}

export const rateLimits = { TRIGGER_RL };
