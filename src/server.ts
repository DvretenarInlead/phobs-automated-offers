// Tracing must be imported before anything else so auto-instrumentation can
// patch http/redis/pg/undici before those modules are required.
import './lib/tracing.js';
import Fastify from 'fastify';
import type { FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import rawBody from 'fastify-raw-body';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
      // Fastify's default req serializer logs the full URL including the
      // query string — which is where OAuth `code`/`state` and admin invite
      // `token` values travel. Log the path only. Headers and bodies are
      // never logged (the default serializer omits them; the redact list is
      // belt-and-braces for any custom log call that includes req.headers).
      serializers: {
        req: (req: { method?: string; url?: string; ip?: string; id?: unknown }) => ({
          id: req.id,
          method: req.method,
          path: (req.url ?? '').split('?')[0],
          remoteAddress: req.ip,
        }),
      },
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
    // Platform terminates TLS at 1 hop; default 0 = trust nothing). `true`
    // would let any client spoof req.ip via X-Forwarded-For and bypass the
    // admin IP allow-list, login-lockout, and metrics localhost fallback.
    // Fastify 5.12 types no longer accept a hop count directly; this function
    // is exactly what proxy-addr compiles a numeric count into (trust hop i
    // iff i < N, hop 0 = the socket peer).
    trustProxy: (_address: string, hop: number): boolean => hop < config.TRUST_PROXY_HOPS,
    bodyLimit: 1_000_000,
    disableRequestLogging: false,
    genReqId: () => randomUUID(),
  });

  // ---- Error + not-found handlers FIRST ----
  // Fastify binds these to routes at registration time, so they must exist
  // before any route is added or the defaults (which echo driver/library
  // error messages — a working oracle for e.g. "duplicate key" enumeration)
  // silently apply instead.
  //
  // Only surface error messages for types we own; everything else is opaque
  // to prevent leaking stack traces, upstream response bodies, Zod tree
  // dumps, or DB-driver messages.
  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    req.log.error({ err }, 'request failed');
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      // Field paths + zod's own messages only (never the offending values) so
      // the admin UI can point at the field instead of a bare "invalid".
      const issues = err.issues.slice(0, 20).map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      return reply
        .code(400)
        .send({ error: 'invalid_payload', issues, requestId: req.requestId });
    }
    // Fastify's own validation errors carry `validation` and `statusCode: 400`.
    if (err.validation) {
      return reply.code(400).send({ error: 'invalid_payload', requestId: req.requestId });
    }
    if (err.statusCode === 429) {
      return reply.code(429).send({ error: 'rate_limited', requestId: req.requestId });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: 'client_error', requestId: req.requestId });
    }
    return reply.code(500).send({ error: 'internal_error', requestId: req.requestId });
  });

  // ---- Admin SPA static files ----
  // Built by `vite build` to dist/admin-ui/ (NOT dist/admin/ — that is where
  // tsc emits src/admin/*.js, and Vite empties its outDir on build). Served
  // at /admin/ with an HTML5 history fallback so deep links work.
  const __filename = fileURLToPath(import.meta.url);
  const adminRoot = resolve(dirname(__filename), '..', 'dist', 'admin-ui');
  const spaEnabled = existsSync(join(adminRoot, 'index.html'));
  // index.html read once at boot; served for /admin/ and every deep link.
  // `decorateReply:false` on the static plugin means there is no
  // reply.sendFile — we deliberately don't depend on it.
  const indexHtml = spaEnabled ? readFileSync(join(adminRoot, 'index.html'), 'utf8') : '';
  const sendIndex = (reply: FastifyReply): FastifyReply =>
    reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(indexHtml);

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (
      spaEnabled &&
      path.startsWith('/admin/') &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      !path.startsWith('/admin/assets/')
    ) {
      return sendIndex(reply);
    }
    return reply.code(404).send({ error: 'not_found' });
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
    // Fail fast when Redis is unreachable: limited routes answer 5xx at once
    // instead of hanging on an offline queue. Deliberately fail-closed.
    redis: makeRedis({ failFast: true }),
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
    // Only matched route patterns become label values — raw URLs of 404s
    // would let anyone grow label cardinality without bound.
    const route = req.routeOptions?.url ?? 'unmatched';
    httpRequestsTotal.labels(route, req.method, String(reply.statusCode)).inc();
    httpRequestDuration.labels(route, req.method).observe(reply.elapsedTime / 1000);
    done();
  });

  // Admin auth hook runs first for /api/admin/* (skips /login, /csrf and the
  // invite-acceptance pair).
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

  if (spaEnabled) {
    await app.register(staticPlugin, {
      root: adminRoot,
      prefix: '/admin/',
      decorateReply: false,
      wildcard: false,
      // Hashed asset filenames → safe to cache hard; index.html is served by
      // the fallback above with no-store.
      maxAge: '1y',
      immutable: true,
      index: false,
    });
    app.get('/admin', (_req, reply) => reply.redirect('/admin/', 301));
    app.get('/admin/', (_req, reply) => sendIndex(reply));
  } else {
    logger.warn(
      { adminRoot },
      'admin SPA bundle not found — run `npm run build:ui` to enable /admin/',
    );
  }

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
