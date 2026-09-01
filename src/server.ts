// Tracing must be imported before anything else so auto-instrumentation can
// patch http/redis/pg/undici before those modules are required.
import './lib/tracing.js';
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
import { registerAdminJobsRoutes } from './routes/adminJobs.js';
import { registerAdminApiTokenRoutes } from './routes/adminApiTokens.js';
import { registerApiTriggerRoutes } from './routes/apiTrigger.js';
import { registerAdminAuthHook } from './admin/auth.js';
import { registerMetricsRoute, httpRequestDuration, httpRequestsTotal } from './metrics/index.js';
import { makeRedis } from './queue/index.js';
import { AppError } from './lib/errors.js';
import { ZodError } from 'zod';

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
    // Trust exactly the number of proxy hops in front of the app (DO App
    // Platform terminates TLS at 1 hop). `true` here would let any client
    // spoof req.ip via X-Forwarded-For and bypass the admin IP allow-list,
    // login-lockout, and metrics localhost fallback.
    // Fastify 5.12 types no longer accept a hop count directly; this function
    // is exactly what proxy-addr compiles a numeric count into (trust hop i
    // iff i < N, hop 0 = the socket peer). N=0 trusts nothing.
    trustProxy: (_address: string, hop: number): boolean => hop < config.TRUST_PROXY_HOPS,
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
        // Tailwind emits utility classes as static CSS; the SPA never inlines
        // styles at runtime. `'unsafe-inline'` is here only for pragmatic
        // compatibility with third-party components in dev. Drop it if the
        // SPA passes a run without inline <style> after `npm run build:ui`.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
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
  registerApiTriggerRoutes(app);
  registerAdminAuthRoutes(app, ADMIN_API_PREFIX);
  registerAdminUserRoutes(app, ADMIN_API_PREFIX);
  registerAdminApiRoutes(app, ADMIN_API_PREFIX);
  registerAdminApiTokenRoutes(app, ADMIN_API_PREFIX);
  registerAdminJobsRoutes(app, ADMIN_API_PREFIX);
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

  // Only surface error messages for types we own; everything else is opaque
  // to prevent leaking stack traces, upstream response bodies, Zod tree
  // dumps, or DB-driver messages like "duplicate key value violates unique
  // constraint" (which is a working oracle for user enumeration).
  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    req.log.error({ err }, 'request failed');
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid_payload', requestId: req.requestId });
    }
    // Fastify's own validation errors carry `validation` and `statusCode: 400`.
    if (err.validation) {
      return reply.code(400).send({ error: 'invalid_payload', requestId: req.requestId });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: 'client_error', requestId: req.requestId });
    }
    return reply.code(500).send({ error: 'internal_error', requestId: req.requestId });
  });

  return app;
}

async function start(): Promise<void> {
  try {
    const app = await buildApp();
    await app.listen({ host: '0.0.0.0', port: config.PORT });
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'web server listening');
  } catch (err) {
    logger.fatal({ err }, 'failed to start server');
    process.exit(1);
  }
}

// Prevent asynchronous errors from silently degrading the process.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException — exiting');
  process.exit(1);
});

void start();
