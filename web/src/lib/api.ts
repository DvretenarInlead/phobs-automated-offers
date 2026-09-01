/**
 * Tiny fetch wrapper that automatically:
 *  - sends credentials (so the __Host-sid cookie goes with every request)
 *  - reads CSRF token from the __Host-csrf cookie (or in-memory fallback)
 *  - attaches X-CSRF-Token header on non-GET requests
 *  - parses JSON, throws ApiError on non-2xx with the body's error code
 *  - broadcasts `auth:expired` on 401 so the app can bounce to /login
 */

export interface ApiIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: unknown,
    public issues: ApiIssue[] = [],
  ) {
    super(message);
  }
}

/** Human-readable text for an error, for inline display. */
export function describeError(err: unknown, fallback = 'request_failed'): string {
  if (!(err instanceof ApiError)) return fallback;
  if (err.issues.length > 0) {
    return err.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
  }
  const detail = err.detail as { invalid?: string[] } | null;
  if (err.message === 'invalid_cidrs' && detail?.invalid?.length) {
    return `Invalid entries: ${detail.invalid.join(', ')}`;
  }
  return FRIENDLY[err.message] ?? err.message;
}

const FRIENDLY: Record<string, string> = {
  bad_credentials: 'Wrong email or password.',
  bad_mfa: 'That code was not accepted.',
  bad_totp: 'That authenticator code was not accepted.',
  bad_password: 'Wrong password.',
  bad_recovery_code: 'That recovery code was not accepted.',
  mfa_required: 'An authenticator or recovery code is required.',
  locked: 'Too many failed attempts. Try again later.',
  bad_csrf: 'Session token mismatch — reload the page and try again.',
  no_session: 'You are not signed in.',
  session_invalid: 'Your session has expired. Sign in again.',
  ip_not_allowed: 'Your IP address is not on the admin allow-list.',
  forbidden: 'You do not have permission to do that.',
  cross_tenant_denied: 'That tenant is outside your scope.',
  invalid_or_expired: 'This invite link is invalid or has expired.',
  invalid_or_expired_invite: 'This invite link is invalid or has expired.',
  invite_already_used: 'This invite has already been used.',
  email_exists: 'An admin with that email already exists.',
  cannot_deactivate_self: 'You cannot deactivate your own account.',
  totp_already_enabled: 'MFA is already enabled — disable it first to re-enrol.',
  no_pending_totp: 'Start the authenticator setup first.',
  tenant_not_found: 'Tenant not found.',
  job_not_found: 'Job not found (already retried or pruned?).',
  invalid_payload: 'Some fields are invalid.',
  rate_limited: 'Too many requests — slow down.',
  too_many_sse_connections: 'Too many live streams open — close other tabs.',
  phobs_error: 'Phobs returned an error.',
  hubspot_error: 'HubSpot returned an error.',
};

let cachedCsrfToken: string | null = null;

function readCsrfFromCookie(): string | null {
  // __Host-csrf is set HttpOnly:false (we need to read it), Secure, SameSite=Strict
  const m = document.cookie.match(/(?:^|;\s*)__Host-csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

export async function ensureCsrf(): Promise<string> {
  const fromCookie = readCsrfFromCookie();
  if (fromCookie) {
    cachedCsrfToken = fromCookie;
    return fromCookie;
  }
  if (cachedCsrfToken) return cachedCsrfToken;
  const res = await fetch('/api/admin/csrf', { credentials: 'include' });
  if (!res.ok) throw new ApiError('csrf_fetch_failed', res.status);
  const body = (await res.json()) as { csrfToken: string };
  cachedCsrfToken = body.csrfToken;
  return body.csrfToken;
}

export interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export const AUTH_EXPIRED_EVENT = 'auth:expired';

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toApiError(res: Response, parsed: unknown): ApiError {
  const body = (parsed ?? {}) as {
    error?: string;
    issues?: ApiIssue[];
  };
  const code = body.error ?? `HTTP ${String(res.status)}`;
  return new ApiError(code, res.status, parsed, Array.isArray(body.issues) ? body.issues : []);
}

export async function api<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (method !== 'GET') {
    headers['x-csrf-token'] = await ensureCsrf();
  }
  const res = await fetch(`/api/admin${path}`, {
    method,
    credentials: 'include',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  const parsed = parseBody(await res.text());
  if (!res.ok) {
    const err = toApiError(res, parsed);
    // A dead session anywhere in the app should bounce to /login once, with
    // a message, instead of every page failing individually.
    if (res.status === 401 && path !== '/me' && path !== '/logout') {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT, { detail: err.message }));
    }
    throw err;
  }
  return parsed as T;
}

export interface MeResponse {
  id: string;
  email: string;
  role: 'superadmin' | 'tenant_admin';
  scopedHubId: string | null;
  totpEnabled: boolean;
}

export async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await api<MeResponse>('/me');
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return null;
    throw err;
  }
}

export interface LoginInput {
  email: string;
  password: string;
  totpCode?: string;
  recoveryCode?: string;
}

export interface LoginOk {
  ok: true;
  user: MeResponse;
  csrfToken: string;
}
export interface LoginNeedsMfa {
  needsMfa: true;
}
export type LoginResult = LoginOk | LoginNeedsMfa;

export async function login(input: LoginInput): Promise<LoginResult> {
  await ensureCsrf();
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': cachedCsrfToken ?? '',
    },
    body: JSON.stringify(input),
  });
  const parsed = parseBody(await res.text());
  const body = (parsed ?? {}) as Record<string, unknown>;
  if (res.status === 202 && body.needsMfa) {
    return { needsMfa: true };
  }
  if (!res.ok) throw toApiError(res, parsed);
  cachedCsrfToken = (body.csrfToken as string) ?? cachedCsrfToken;
  const user = body.user as Omit<MeResponse, 'totpEnabled'> & { totpEnabled?: boolean };
  return {
    ok: true,
    user: { ...user, totpEnabled: user.totpEnabled ?? false },
    csrfToken: body.csrfToken as string,
  };
}

export async function logout(): Promise<void> {
  try {
    await api<{ ok: true }>('/logout', { method: 'POST' });
  } finally {
    cachedCsrfToken = null;
  }
}
