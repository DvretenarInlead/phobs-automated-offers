import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import rawBody from 'fastify-raw-body';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { logger } from './lib/logger.js';
import { registerRequestId } from './lib/requestId.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebhookRoutes } from './routes/webhook.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { makeRedis } from './queue/index.js';

const config = loadConfig();

async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-hubspot-signature-v3"]',
        ],
        censor: '[REDACTED]',
      },
    },
    trustProxy: true,
    bodyLimit: 1_000_000, // 1 MB cap on webhook payloads
    disableRequestLogging: false,
    genReqId: () => randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
  });

  await app.register(rateLimit, {
    global: false,
    redis: makeRedis(),
    nameSpace: 'rl:',
  });

  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    runFirst: true,
    encoding: false, // store as Buffer
  });

  registerRequestId(app);
  registerHealthRoutes(app);
  registerWebhookRoutes(app);
  registerOAuthRoutes(app);

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    req.log.error({ err }, 'request failed');
    const statusCode = err.statusCode ?? 500;
    return reply.code(statusCode).send({ error: err.message });
  });

  return app;
}

async function start() {
  try {
    const app = await buildApp();
    await app.listen({ host: '0.0.0.0', port: config.PORT });
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'web server listening');
  } catch (err) {
    logger.fatal({ err }, 'failed to start server');
    process.exit(1);
  }
}

void start();
