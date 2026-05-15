/**
 * Tiny fetch wrapper that automatically:
 *  - sends credentials (so the __Host-sid cookie goes with every request)
 *  - reads CSRF token from the __Host-csrf cookie (or in-memory fallback)
 *  - attaches X-CSRF-Token header on non-GET requests
 *  - parses JSON, throws ApiError on non-2xx with the body's error message
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: unknown,
  ) {
    super(message);
  }
}

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
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const msg =
      (parsed as { error?: string } | null)?.error ?? `HTTP ${String(res.status)}`;
    throw new ApiError(msg, res.status, parsed);
  }
  return parsed as T;
}

export interface MeResponse {
  id: string;
  email: string;
  role: 'superadmin' | 'tenant_admin';
  scopedHubId: string | null;
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
  const body = (await res.json()) as Record<string, unknown>;
  if (res.status === 202 && body.needsMfa) {
    return { needsMfa: true };
  }
  if (!res.ok) {
    throw new ApiError(
      (body.error as string | undefined) ?? `HTTP ${String(res.status)}`,
      res.status,
      body,
    );
  }
  cachedCsrfToken = (body.csrfToken as string) ?? cachedCsrfToken;
  return body as unknown as LoginOk;
}

export async function logout(): Promise<void> {
  await api<{ ok: true }>('/logout', { method: 'POST' });
  cachedCsrfToken = null;
}
