import { z } from 'zod';

const base64Bytes = (min: number) =>
  z.string().refine(
    (v) => {
      try {
        return Buffer.from(v, 'base64').length >= min;
      } catch {
        return false;
      }
    },
    { message: `must decode to >= ${min} bytes of base64` },
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  PUBLIC_BASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  TOKEN_VAULT_KEY: base64Bytes(32),
  TOKEN_VAULT_KEY_PREV: base64Bytes(32).optional(),

  SESSION_SECRET: base64Bytes(32),

  HUBSPOT_CLIENT_ID: z.string().min(1),
  HUBSPOT_CLIENT_SECRET: z.string().min(1),
  HUBSPOT_APP_ID: z.string().min(1),
  HUBSPOT_REDIRECT_URI: z.string().url(),
  HUBSPOT_SCOPES: z.string().min(1),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  ADMIN_IP_ALLOWLIST: z.string().optional().default(''),
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
