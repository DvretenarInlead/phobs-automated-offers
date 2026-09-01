/**
 * Production migration runner.
 *
 *   node dist/cli/migrate.js
 *
 * Applies pending SQL migrations from src/db/migrations (drizzle-kit output,
 * copied into the runtime image) using drizzle-orm's built-in migrator, so
 * it works in the prod container where drizzle-kit (a devDependency) is not
 * installed. Runs as the DO App Platform PRE_DEPLOY job — see .do/app.yaml.
 *
 * Deliberately does NOT import ../config.js: the only env it needs is
 * DATABASE_URL, so the migrate job doesn't have to carry every app secret.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('migrate: DATABASE_URL is required');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/cli/migrate.js → ../../src/db/migrations (image layout) or the same
// relative path from src/cli during `tsx` dev runs.
const migrationsFolder =
  process.env.MIGRATIONS_DIR ?? path.resolve(here, '../../src/db/migrations');

// Same TLS posture as src/db/client.ts: verify the server in production,
// with the platform CA when provided.
const caCert = process.env.DATABASE_CA_CERT?.trim();
const ssl =
  process.env.NODE_ENV === 'production' || process.env.PGSSLMODE === 'require'
    ? { rejectUnauthorized: true, ...(caCert ? { ca: caCert } : {}) }
    : false;

const sql = postgres(databaseUrl, { max: 1, ssl });
const db = drizzle(sql);

const started = Date.now();
try {
  await migrate(db, { migrationsFolder });
  console.error(`migrate: up to date (${migrationsFolder}) in ${Date.now() - started}ms`);
  await sql.end({ timeout: 5 });
  process.exit(0);
} catch (err) {
  console.error('migrate: FAILED', err instanceof Error ? err.message : err);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
}
