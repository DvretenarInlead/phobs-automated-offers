import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifyApiToken } from '../lib/apiTokens.js';
import {
  claimIdempotencyKey,
  idempotencyKeyFor,
  jobIdFor,
  releaseIdempotencyKey,
} from '../lib/idempotency.js';
import { enqueueProcessDeal } from '../queue/index.js';
import { liveEmit } from '../lib/liveEmit.js';
import { writeAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { compileAllowlist, normaliseClientIp } from '../lib/ipAllowlist.js';

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

// Per-IP + per-token-prefix rate limit. Keying by the prefix alone would let
// one client mint unlimited fresh buckets by rotating fake prefixes; the IP
// component bounds that to what a single source can do.
const TRIGGER_RL = {
  max: 300,
  timeWindow: '1 minute',
  keyGenerator: (req: FastifyRequest): string => {
    const auth = req.headers.authorization ?? '';
    const prefix = auth.startsWith('Bearer phk_') ? auth.slice(7, 19) : 'anon';
    return `trigger:${req.ip}:${prefix}`;
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

      // Per-token IP allow-list. Empty list = no restriction (safe default
      // for tokens that predate the ip_allowlist_cidrs column).
      const allowlist = compileAllowlist(token.ipAllowlistCidrs);
      if (!allowlist.empty) {
        const clientIp = normaliseClientIp(req.ip);
        if (!allowlist.contains(clientIp)) {
          logger.warn(
            {
              hubId: token.hubId.toString(),
              tokenPrefix: token.tokenPrefix,
              ip: clientIp,
              requestId: req.requestId,
            },
            'api trigger: IP not in allow-list',
          );
          await writeAudit({
            hubId: token.hubId,
            requestId: req.requestId,
            kind: 'api.trigger.ip_denied',
            status: 'error',
            request: { tokenPrefix: token.tokenPrefix, ip: clientIp },
            error: 'ip_not_allowed',
          });
          return reply.code(403).send({ error: 'ip_not_allowed' });
        }
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
      // Accept only scalar values for hs_object_id (webhook payloads sometimes
      // stuff objects here from misconfigured HubSpot workflows).
      if (
        typeof dealIdRaw !== 'string' &&
        typeof dealIdRaw !== 'number' &&
        typeof dealIdRaw !== 'bigint'
      ) {
        return reply.code(400).send({ error: 'bad_hs_object_id' });
      }
      let dealId: bigint;
      try {
        dealId = BigInt(dealIdRaw);
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

      // Job id is a hash of the key: BullMQ forbids ':' in custom ids and the
      // hash keeps distinct client keys distinct (a truncated raw key would
      // collide every client-keyed job of a hub onto one id).
      const jobIdWanted = jobIdFor('api', token.hubId, dealId, idemKey);
      const fresh = await claimIdempotencyKey(idemKey, jobIdWanted, token.hubId);
      if (!fresh) {
        return reply.code(200).send({ ok: true, duplicate: true });
      }

      let jobId: string;
      try {
        jobId = await enqueueProcessDeal(
          {
            hubId: token.hubId.toString(),
            source: 'manual',
            requestId: req.requestId,
            rawPayload: body.payload,
          },
          { jobId: jobIdWanted },
        );
      } catch (err) {
        // Don't leave a claimed key behind with no job — the caller's retry
        // must be processed, not reported as a duplicate.
        await releaseIdempotencyKey(idemKey).catch(() => undefined);
        throw err;
      }

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
