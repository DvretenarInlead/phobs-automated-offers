import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from '../config.js';
import { AuthError } from '../lib/errors.js';
import { compileAllowlist, normaliseClientIp } from '../lib/ipAllowlist.js';
import { SESSION_COOKIE_NAME, findSession, touchSession } from './sessions.js';
import { csrfCookieName, csrfHeaderName, verifyCsrfToken } from './csrf.js';
import type { AdminUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    adminUser?: AdminUser;
  }
}

const config = loadConfig();

// ADMIN_IP_ALLOWLIST accepts single IPs and CIDRs (IPv4 + IPv6). Compiled
// once at boot; invalid entries are logged by config validation upstream.
// Empty list = no IP restriction.
const adminAllowlist = compileAllowlist(config.adminIpAllowlist);

function ipAllowed(ip: string): boolean {
  if (adminAllowlist.empty) return true;
  return adminAllowlist.contains(normaliseClientIp(ip));
}

/**
 * Routes under the admin prefix that legitimately run without a session:
 * login, CSRF bootstrap, and the invite-acceptance pair (the invitee has no
 * account yet). Each carries its own per-route rate limit. Everything else
 * under the prefix requires a valid session + CSRF on mutations.
 */
const SESSIONLESS_SUFFIXES = ['/login', '/csrf', '/users/invite/preview', '/users/invite/accept'];

function isSessionless(routePath: string, prefix: string): boolean {
  return SESSIONLESS_SUFFIXES.some((s) => routePath === `${prefix}${s}`);
}

/**
 * The path used for the prefix / exemption decisions is the *matched route
 * pattern* (`req.routeOptions.url`), not the raw request URL. The router
 * decodes percent-escapes when matching, so `/api/%61dmin/tenants` reaches
 * the admin handler while `req.url` still reads `/api/%61dmin/…` — matching
 * on the raw URL would skip this hook. For unmatched URLs (404s) the raw
 * path is used, which only ever makes the check stricter.
 */
function requestPath(req: FastifyRequest): string {
  const matched = req.routeOptions?.url;
  if (typeof matched === 'string' && matched.length > 0) return matched;
  return req.url.split('?')[0] ?? req.url;
}

export function registerAdminAuthHook(app: FastifyInstance, prefix: string): void {
  app.addHook('onRequest', async (req, reply) => {
    const path = requestPath(req);
    const rawPath = req.url.split('?')[0] ?? req.url;
    // Either view of the path landing under the admin prefix puts the
    // request in scope; belt and braces against router quirks.
    if (!path.startsWith(prefix) && !rawPath.startsWith(prefix)) return;

    // IP allow-list applies to the whole admin surface, login included — a
    // non-allow-listed client must not even get to try passwords.
    if (!ipAllowed(req.ip)) {
      throw new AuthError('ip_not_allowed', 403);
    }

    if (isSessionless(path, prefix)) return;

    const sid = req.cookies?.[SESSION_COOKIE_NAME];
    if (!sid) throw new AuthError('no_session');
    const found = await findSession(sid);
    if (!found) throw new AuthError('session_invalid');

    // CSRF: required on state-changing methods.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const headerToken = req.headers[csrfHeaderName];
      const cookieToken = req.cookies?.[csrfCookieName];
      if (
        typeof headerToken !== 'string' ||
        typeof cookieToken !== 'string' ||
        headerToken !== cookieToken ||
        !verifyCsrfToken(headerToken)
      ) {
        throw new AuthError('bad_csrf', 403);
      }
    }

    req.adminUser = found.user;
    // Best-effort idle bump
    void touchSession(sid);
    void reply; // keep Fastify happy that reply was referenced
  });
}

export type RequireRoleOptions = {
  /** When set on a `tenant_admin` route, ensures the request targets their own hubId. */
  hubIdParam?: string;
  /** Allow superadmin in addition to the named role. Default true. */
  allowSuperadmin?: boolean;
};

export function requireRole(
  role: 'superadmin' | 'tenant_admin',
  opts: RequireRoleOptions = {},
) {
  const allowSuper = opts.allowSuperadmin ?? true;
  // eslint-disable-next-line @typescript-eslint/require-await
  return async function (req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const user = req.adminUser;
    if (!user) throw new AuthError('unauthenticated');

    if (allowSuper && user.role === 'superadmin') return;
    if (user.role !== role) throw new AuthError('forbidden', 403);

    if (role === 'tenant_admin' && opts.hubIdParam) {
      const params = (req.params as Record<string, string> | undefined) ?? {};
      const raw = params[opts.hubIdParam];
      if (!raw) throw new AuthError('missing_hub_id', 403);
      let hubId: bigint;
      try {
        hubId = BigInt(raw);
      } catch {
        throw new AuthError('bad_hub_id', 403);
      }
      if (user.scopedHubId === null || user.scopedHubId !== hubId) {
        throw new AuthError('cross_tenant_denied', 403);
      }
    }
  };
}
