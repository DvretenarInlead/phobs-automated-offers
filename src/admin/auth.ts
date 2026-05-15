import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from '../config.js';
import { AuthError } from '../lib/errors.js';
import { SESSION_COOKIE_NAME, findSession, touchSession } from './sessions.js';
import { csrfCookieName, csrfHeaderName, verifyCsrfToken } from './csrf.js';
import type { AdminUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    adminUser?: AdminUser;
  }
}

const config = loadConfig();

function ipAllowed(ip: string): boolean {
  if (config.adminIpAllowlist.length === 0) return true;
  // Simple exact-match / prefix check. CIDR ranges out-of-scope for v1.
  return config.adminIpAllowlist.some((entry) => ip === entry || ip.startsWith(entry));
}

export function registerAdminAuthHook(app: FastifyInstance, prefix: string): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith(prefix)) return;
    if (req.url.startsWith(`${prefix}/login`) || req.url.startsWith(`${prefix}/csrf`)) return;

    if (!ipAllowed(req.ip)) {
      throw new AuthError('ip_not_allowed');
    }

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
        throw new AuthError('bad_csrf');
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
    if (user.role !== role) throw new AuthError('forbidden');

    if (role === 'tenant_admin' && opts.hubIdParam) {
      const params = (req.params as Record<string, string> | undefined) ?? {};
      const raw = params[opts.hubIdParam];
      if (!raw) throw new AuthError('missing_hub_id');
      let hubId: bigint;
      try {
        hubId = BigInt(raw);
      } catch {
        throw new AuthError('bad_hub_id');
      }
      if (user.scopedHubId === null || user.scopedHubId !== hubId) {
        throw new AuthError('cross_tenant_denied');
      }
    }
  };
}
