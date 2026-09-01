import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadConfig } from '../config.js';
import * as schema from './schema.js';

const config = loadConfig();

// In production the server certificate is verified — `ssl: 'require'` alone
// would set rejectUnauthorized:false in postgres.js and accept any cert on
// the wire (MITM on the DB link). DO managed Postgres uses a private CA, so
// bind DATABASE_CA_CERT from ${db.CA_CERT}; other hosts fall back to the
// system trust store.
const ssl =
  config.NODE_ENV === 'production'
    ? { rejectUnauthorized: true, ...(config.DATABASE_CA_CERT ? { ca: config.DATABASE_CA_CERT } : {}) }
    : false;

const sql = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  prepare: true,
  ssl,
});

export const db = drizzle(sql, { schema, logger: false });
export const pg = sql;
export type DB = typeof db;
