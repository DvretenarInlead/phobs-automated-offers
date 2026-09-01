import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { logger } from '../lib/logger.js';
import { verifyHubSpotSignatureV3 } from '../hubspot/signature.js';
import { verifyExtensionJwt, extractHubId } from '../hubspot/jwt.js';
import {
  claimIdempotencyKey,
  idempotencyKeyFor,
  jobIdFor,
  releaseIdempotencyKey,
} from '../lib/idempotency.js';
import { enqueueProcessDeal } from '../queue/index.js';
import { liveEmit } from '../lib/liveEmit.js';
import { normaliseClientIp } from '../lib/ipAllowlist.js';
import { loadWebhookAllowlist } from '../tenancy/webhookAllowlist.js';
import { writeAudit } from '../lib/audit.js';
import {
  webhookDuplicates,
  webhookSignatureFailures,
} from '../metrics/index.js';

const config = loadConfig();

/**
 * HubSpot Workflow "Send a webhook" action payloads are arrays of objects.
 * We accept either the array form (real HubSpot) or a single object (manual
 * curl tests). The first deal in the array is the one processed.
 */
const HubSpotItem = z
  .object({
    hs_object_id: z.union([z.number(), z.string()]),
  })
  .passthrough();

const HubSpotPayload = z.union([z.array(HubSpotItem).min(1), HubSpotItem]);

// Webhook rate limit keyed by source IP + portalId. HubSpot itself is
// rate-limited on its side, so a legitimate portal will not exceed this. The
// IP component stops an attacker who discovers the URL pattern from minting
// unlimited buckets by rotating portal ids (each request buffers up to 1 MB,
// computes HMAC, hits Redis+DB, enqueues to BullMQ); the portal component
// keeps one noisy tenant from starving another behind the same egress IP.
const WEBHOOK_RL = {
  max: 120,
  timeWindow: '1 minute',
  keyGenerator: (req: FastifyRequest): string => {
    const params = req.params as { portalId?: string } | undefined;
    return `webhook:${req.ip}:${params?.portalId ?? 'unknown'}`;
  },
};
const EXTENSION_RL = { max: 120, timeWindow: '1 minute' };

export const rateLimits = { WEBHOOK_RL, EXTENSION_RL };

export function registerWebhookRoutes(app: FastifyInstance): void {
  // Route A: "Send a webhook" workflow action, HMAC v3.
  app.post<{ Params: { portalId: string } }>(
    '/webhooks/hubspot/:portalId',
    {
      config: { rawBody: true, rateLimit: WEBHOOK_RL },
      schema: {
        params: {
          type: 'object',
          required: ['portalId'],
          properties: { portalId: { type: 'string', pattern: '^[0-9]{1,20}$' } },
        },
      },
    },
    async (req, reply) => {
      const portalId = BigInt(req.params.portalId);
      const rawBody = req.rawBody;
      if (!(rawBody instanceof Buffer)) {
        return reply.code(400).send({ error: 'raw_body_missing' });
      }

      const uri = `${config.PUBLIC_BASE_URL}${req.raw.url ?? req.url}`;
      const verdict = verifyHubSpotSignatureV3({
        clientSecret: config.HUBSPOT_CLIENT_SECRET,
        method: req.method,
        uri,
        rawBody,
        signatureHeader: req.headers['x-hubspot-signature-v3'] as string | undefined,
        timestampHeader: req.headers['x-hubspot-request-timestamp'] as string | undefined,
      });
      if (!verdict.ok) {
        webhookSignatureFailures.labels('webhook', verdict.reason).inc();
        liveEmit('webhooks', portalId, {
          ts: Date.now(),
          type: 'signature_failed',
          hubId: portalId.toString(),
          data: { reason: verdict.reason },
        });
        logger.warn(
          { hubId: portalId.toString(), reason: verdict.reason, requestId: req.requestId },
          'webhook signature verification failed',
        );
        return reply.code(401).send({ error: 'unauthorized' });
      }

      // Per-tenant IP allow-list (defence-in-depth after HMAC). Empty list =
      // no restriction. HubSpot fires from AWS ranges; leave empty unless
      // you're locking down to a specific egress proxy.
      if (!(await checkTenantIp(portalId, req, 'webhook'))) {
        return reply.code(403).send({ error: 'ip_not_allowed' });
      }

      return handleAccepted(app, reply, {
        hubId: portalId,
        rawBody,
        body: req.body,
        source: 'webhook',
        requestId: req.requestId,
      });
    },
  );

  // Route B: Workflow Extension (custom action), JWT.
  app.post(
    '/workflow-actions/process-deal',
    { config: { rawBody: true, rateLimit: EXTENSION_RL } },
    async (req, reply) => {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'missing_bearer' });
      }
      const token = auth.slice('Bearer '.length).trim();
      let hubId: bigint | null;
      try {
        const { payload } = await verifyExtensionJwt(token);
        hubId = extractHubId(payload);
      } catch (err) {
        webhookSignatureFailures.labels('extension', 'bad_jwt').inc();
        logger.warn({ err: { name: (err as Error).name } }, 'workflow extension JWT invalid');
        return reply.code(401).send({ error: 'bad_jwt' });
      }
      if (!hubId) return reply.code(400).send({ error: 'missing_hub_id_claim' });

      // Per-tenant IP allow-list after JWT verification.
      if (!(await checkTenantIp(hubId, req, 'extension'))) {
        return reply.code(403).send({ error: 'ip_not_allowed' });
      }

      const rawBody = req.rawBody;
      if (!(rawBody instanceof Buffer)) {
        return reply.code(400).send({ error: 'raw_body_missing' });
      }

      return handleAccepted(app, reply, {
        hubId,
        rawBody,
        body: req.body,
        source: 'extension',
        requestId: req.requestId,
      });
    },
  );
}

async function checkTenantIp(
  hubId: bigint,
  req: FastifyRequest,
  source: 'webhook' | 'extension',
): Promise<boolean> {
  const allowlist = await loadWebhookAllowlist(hubId);
  if (allowlist.empty) return true;
  const ip = normaliseClientIp(req.ip);
  if (allowlist.contains(ip)) return true;

  logger.warn(
    { hubId: hubId.toString(), ip, source, requestId: req.requestId },
    'tenant IP allow-list rejected request',
  );
  liveEmit('webhooks', hubId, {
    ts: Date.now(),
    type: 'ip_denied',
    hubId: hubId.toString(),
    data: { source, ip },
  });
  await writeAudit({
    hubId,
    requestId: req.requestId,
    kind: `${source}.ip_denied`,
    status: 'error',
    request: { ip, source },
    error: 'ip_not_allowed',
  });
  return false;
}

interface AcceptInput {
  hubId: bigint;
  rawBody: Buffer;
  body: unknown;
  source: 'webhook' | 'extension';
  requestId: string;
}

async function handleAccepted(app: FastifyInstance, reply: FastifyReply, input: AcceptInput) {
  const parsed = HubSpotPayload.safeParse(input.body);
  if (!parsed.success) {
    app.log.warn(
      { hubId: input.hubId.toString(), detail: parsed.error.format() },
      'webhook rejected: invalid payload',
    );
    return reply.code(400).send({ error: 'invalid_payload' });
  }
  const first = Array.isArray(parsed.data) ? parsed.data[0]! : parsed.data;
  const dealIdRaw = first.hs_object_id;
  const dealId = typeof dealIdRaw === 'string' ? BigInt(dealIdRaw) : BigInt(dealIdRaw);

  const idemKey = idempotencyKeyFor(input.hubId, dealId, input.rawBody);

  // Deterministic job id derived from the idempotency key so duplicates
  // dedupe at the queue as well as in the DB.
  const jobIdWanted = jobIdFor(input.source, input.hubId, dealId, idemKey);
  const fresh = await claimIdempotencyKey(idemKey, jobIdWanted, input.hubId);
  if (!fresh) {
    webhookDuplicates.labels(input.hubId.toString()).inc();
    liveEmit('webhooks', input.hubId, {
      ts: Date.now(),
      type: 'duplicate',
      hubId: input.hubId.toString(),
      dealId: dealId.toString(),
    });
    return reply.code(200).send({ accepted: true, duplicate: true });
  }

  let jobId: string;
  try {
    jobId = await enqueueProcessDeal(
      {
        hubId: input.hubId.toString(),
        source: input.source,
        requestId: input.requestId,
        rawPayload: parsed.data,
      },
      { jobId: jobIdWanted },
    );
  } catch (err) {
    // Enqueue failed (Redis down): release the claim so HubSpot's retry is
    // processed instead of being answered as a duplicate forever.
    await releaseIdempotencyKey(idemKey).catch(() => undefined);
    throw err;
  }

  app.log.info(
    { hubId: input.hubId.toString(), dealId: dealId.toString(), jobId, requestId: input.requestId },
    'webhook accepted',
  );
  liveEmit('webhooks', input.hubId, {
    ts: Date.now(),
    type: 'accepted',
    hubId: input.hubId.toString(),
    dealId: dealId.toString(),
    jobId,
    data: { source: input.source },
  });

  return reply.code(200).send({ accepted: true, duplicate: false, jobId });
}
