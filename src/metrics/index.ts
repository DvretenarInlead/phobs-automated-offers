import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig } from '../config.js';

const config = loadConfig();
const registry = new Registry();
registry.setDefaultLabels({ service: 'phobs-automated-offers' });
collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['route', 'method', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['route', 'method'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const webhookSignatureFailures = new Counter({
  name: 'webhook_signature_failures_total',
  help: 'Webhook signature/JWT verification failures',
  labelNames: ['route', 'reason'] as const,
  registers: [registry],
});

export const webhookDuplicates = new Counter({
  name: 'webhook_duplicates_total',
  help: 'Webhooks rejected because of idempotency key collision',
  labelNames: ['hub_id'] as const,
  registers: [registry],
});

export const jobProcessed = new Counter({
  name: 'job_processed_total',
  help: 'Jobs processed by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const jobStepDuration = new Histogram({
  name: 'job_step_duration_seconds',
  help: 'Per-step job duration',
  labelNames: ['step', 'status'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const externalApiCalls = new Counter({
  name: 'external_api_calls_total',
  help: 'External API calls',
  labelNames: ['target', 'op', 'status_class'] as const,
  registers: [registry],
});

export const externalApiDuration = new Histogram({
  name: 'external_api_duration_seconds',
  help: 'External API call latency',
  labelNames: ['target', 'op'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const externalApiRetries = new Counter({
  name: 'external_api_retries_total',
  help: 'External API retries',
  labelNames: ['target', 'op', 'reason'] as const,
  registers: [registry],
});

export const queueWaiting = new Gauge({
  name: 'queue_jobs_waiting',
  help: 'BullMQ jobs waiting',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const queueActive = new Gauge({
  name: 'queue_jobs_active',
  help: 'BullMQ jobs active',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const queueFailed = new Gauge({
  name: 'queue_jobs_failed',
  help: 'BullMQ jobs failed',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export function registerMetricsRoute(app: FastifyInstance): void {
  // Token auth on /metrics — prevents random scrapers + reduces lateral
  // exposure if the public listener is open. Set METRICS_TOKEN in env if you
  // want token gating; otherwise the endpoint is restricted to localhost only.
  const expectedToken = process.env.METRICS_TOKEN;

  app.get('/metrics', async (req, reply) => {
    if (expectedToken) {
      const auth = req.headers.authorization ?? '';
      const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
      const a = Buffer.from(provided);
      const b = Buffer.from(expectedToken);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    } else if (config.NODE_ENV === 'production' && req.ip !== '127.0.0.1' && req.ip !== '::1') {
      return reply.code(401).send({ error: 'metrics_token_required' });
    }
    void reply.header('content-type', registry.contentType);
    return reply.send(await registry.metrics());
  });
}

export { registry as metricsRegistry };
