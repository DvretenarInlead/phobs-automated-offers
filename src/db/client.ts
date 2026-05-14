import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadConfig } from '../config.js';
import * as schema from './schema.js';

const config = loadConfig();

const sql = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  prepare: true,
  ssl: config.NODE_ENV === 'production' ? 'require' : false,
});

export const db = drizzle(sql, { schema, logger: false });
export const pg = sql;
export type DB = typeof db;
