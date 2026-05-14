import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { logger } from '../lib/logger.js';
import { verifyHubSpotSignatureV3 } from '../hubspot/signature.js';
import { verifyExtensionJwt, extractHubId } from '../hubspot/jwt.js';
import { claimIdempotencyKey, idempotencyKeyFor } from '../lib/idempotency.js';
import { enqueueProcessDeal } from '../queue/index.js';

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

export function registerWebhookRoutes(app: FastifyInstance): void {
  // Route A: "Send a webhook" workflow action, HMAC v3.
  app.post<{ Params: { portalId: string } }>(
    '/webhooks/hubspot/:portalId',
    {
      config: { rawBody: true },
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
        logger.warn(
          { hubId: portalId.toString(), reason: verdict.reason, requestId: req.requestId },
          'webhook signature verification failed',
        );
        return reply.code(401).send({ error: verdict.reason });
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
    { config: { rawBody: true } },
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
        logger.warn({ err: { name: (err as Error).name } }, 'workflow extension JWT invalid');
        return reply.code(401).send({ error: 'bad_jwt' });
      }
      if (!hubId) return reply.code(400).send({ error: 'missing_hub_id_claim' });

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
    return reply.code(400).send({ error: 'invalid_payload', detail: parsed.error.format() });
  }
  const first = Array.isArray(parsed.data) ? parsed.data[0]! : parsed.data;
  const dealIdRaw = first.hs_object_id;
  const dealId = typeof dealIdRaw === 'string' ? BigInt(dealIdRaw) : BigInt(dealIdRaw);

  const idemKey = idempotencyKeyFor(input.hubId, dealId, input.rawBody);

  // Pre-generate the job id for the idempotency record so duplicates dedupe.
  const provisionalJobId = `${input.hubId.toString()}-${dealId.toString()}-${idemKey.slice(0, 12)}`;
  const fresh = await claimIdempotencyKey(idemKey, provisionalJobId, input.hubId);
  if (!fresh) {
    return reply.code(200).send({ accepted: true, duplicate: true });
  }

  const jobId = await enqueueProcessDeal(
    {
      hubId: input.hubId.toString(),
      source: input.source,
      requestId: input.requestId,
      rawPayload: parsed.data,
    },
    { jobId: provisionalJobId },
  );

  app.log.info(
    { hubId: input.hubId.toString(), dealId: dealId.toString(), jobId, requestId: input.requestId },
    'webhook accepted',
  );

  return reply.code(200).send({ accepted: true, duplicate: false, jobId });
}
