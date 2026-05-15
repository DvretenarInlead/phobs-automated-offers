import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import rawBody from 'fastify-raw-body';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { logger } from './lib/logger.js';
import { registerRequestId } from './lib/requestId.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebhookRoutes } from './routes/webhook.js';
import { registerOAuthRoutes } from './routes/oauth.js';
import { registerAdminAuthRoutes } from './routes/adminAuth.js';
import { registerAdminApiRoutes } from './routes/adminApi.js';
import { registerAdminUserRoutes } from './routes/adminUsers.js';
import { registerAdminLiveRoutes } from './routes/adminLive.js';
import { registerAdminAuthHook } from './admin/auth.js';
import { registerMetricsRoute, httpRequestDuration, httpRequestsTotal } from './metrics/index.js';
import { makeRedis } from './queue/index.js';

const config = loadConfig();
const ADMIN_API_PREFIX = '/api/admin';

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
    bodyLimit: 1_000_000,
    disableRequestLogging: false,
    genReqId: () => randomUUID(),
  });

  await app.register(cookie, { hook: 'onRequest' });

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
    encoding: false,
  });

  registerRequestId(app);

  // Metric middleware — observes every request.
  app.addHook('onResponse', (req, reply, done) => {
    const route = req.routeOptions?.url ?? req.url.split('?')[0] ?? 'unknown';
    httpRequestsTotal.labels(route, req.method, String(reply.statusCode)).inc();
    httpRequestDuration.labels(route, req.method).observe(reply.elapsedTime / 1000);
    done();
  });

  // Admin auth hook runs first for /api/admin/* (skips /login + /csrf).
  registerAdminAuthHook(app, ADMIN_API_PREFIX);

  registerHealthRoutes(app);
  registerMetricsRoute(app);
  registerWebhookRoutes(app);
  registerOAuthRoutes(app);
  registerAdminAuthRoutes(app, ADMIN_API_PREFIX);
  registerAdminUserRoutes(app, ADMIN_API_PREFIX);
  registerAdminApiRoutes(app, ADMIN_API_PREFIX);
  registerAdminLiveRoutes(app, ADMIN_API_PREFIX);

  // ---- Admin SPA static files ----
  // Built by `vite build` to dist/admin/. We serve them at /admin/ with an
  // HTML5 history fallback so client-side routing works for deep links.
  const __filename = fileURLToPath(import.meta.url);
  const adminRoot = resolve(dirname(__filename), '..', 'dist', 'admin');
  if (existsSync(adminRoot)) {
    await app.register(staticPlugin, {
      root: adminRoot,
      prefix: '/admin/',
      decorateReply: false,
      wildcard: false,
    });
    // Fallback: any /admin/* path that didn't match a real file → serve index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/admin/') && req.method === 'GET') {
        return reply.sendFile('index.html', join(adminRoot));
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  } else {
    logger.warn(
      { adminRoot },
      'admin SPA bundle not found — run `npm run build:ui` to enable /admin/',
    );
  }

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
