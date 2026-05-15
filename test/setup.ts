import { randomBytes } from 'node:crypto';

// Provide minimum env for loadConfig() in tests that import modules using it.
process.env.NODE_ENV = 'test';
process.env.PORT = '8080';
process.env.PUBLIC_BASE_URL = 'http://localhost:8080';
process.env.LOG_LEVEL = 'error';
process.env.TOKEN_VAULT_KEY ??= randomBytes(32).toString('base64');
process.env.SESSION_SECRET ??= randomBytes(32).toString('base64');
process.env.HUBSPOT_CLIENT_ID ??= 'test-client';
process.env.HUBSPOT_CLIENT_SECRET ??= 'test-secret';
process.env.HUBSPOT_APP_ID ??= '1';
process.env.HUBSPOT_REDIRECT_URI ??= 'http://localhost:8080/oauth/callback';
process.env.HUBSPOT_SCOPES ??= 'crm.objects.deals.read';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
