import { z } from 'zod';

const base64BytesExactly = (len: number) =>
  z.string().refine(
    (v) => {
      try {
        return Buffer.from(v, 'base64').length === len;
      } catch {
        return false;
      }
    },
    { message: `must decode to exactly ${len} bytes of base64` },
  );

// Platform secret stores (DO App Platform included) inject declared-but-unset
// secrets as "" — treat that as absent for optional keys.
const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_BASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // AES-256-GCM requires exactly 32 bytes.
  TOKEN_VAULT_KEY: base64BytesExactly(32),
  TOKEN_VAULT_KEY_PREV: z.preprocess(emptyToUndefined, base64BytesExactly(32).optional()),

  SESSION_SECRET: base64BytesExactly(32),

  HUBSPOT_CLIENT_ID: z.string().min(1),
  HUBSPOT_CLIENT_SECRET: z.string().min(1),
  HUBSPOT_APP_ID: z.string().min(1),
  HUBSPOT_REDIRECT_URI: z.string().url(),
  HUBSPOT_SCOPES: z.string().min(1),

  DATABASE_URL: z.string().url(),
  /**
   * PEM CA certificate for the Postgres server. Required in production so
   * TLS actually verifies the server (DO managed DBs use a private CA —
   * bind `${db.CA_CERT}` in app.yaml). When unset in production we still
   * verify against the system trust store.
   */
  DATABASE_CA_CERT: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  REDIS_URL: z.string().url(),

  ADMIN_IP_ALLOWLIST: z.string().optional().default(''),

  // How many trusted proxies terminate in front of the app. Default 0 =
  // trust nothing (req.ip is the socket peer). DO App Platform puts exactly
  // one edge LB in front, so set 1 there (app.yaml does). Never guess high:
  // every extra hop lets clients spoof req.ip via X-Forwarded-For and walk
  // past the admin IP allow-list, login counters and the metrics gate.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
});

export type AppConfig = z.infer<typeof envSchema> & {
  tokenVaultKey: Buffer;
  tokenVaultKeyPrev: Buffer | null;
  sessionSecret: Buffer;
  hubspotScopes: string[];
  adminIpAllowlist: string[];
};

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.parse(env);
  cached = {
    ...parsed,
    tokenVaultKey: Buffer.from(parsed.TOKEN_VAULT_KEY, 'base64'),
    tokenVaultKeyPrev: parsed.TOKEN_VAULT_KEY_PREV
      ? Buffer.from(parsed.TOKEN_VAULT_KEY_PREV, 'base64')
      : null,
    sessionSecret: Buffer.from(parsed.SESSION_SECRET, 'base64'),
    hubspotScopes: parsed.HUBSPOT_SCOPES.split(/\s+/).filter(Boolean),
    adminIpAllowlist: parsed.ADMIN_IP_ALLOWLIST.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}
