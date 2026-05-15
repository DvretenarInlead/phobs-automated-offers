import { pino } from 'pino';
import { loadConfig } from '../config.js';

const config = loadConfig();

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hubspot-signature-v3"]',
  '*.access_token',
  '*.refresh_token',
  '*.client_secret',
  '*.password',
  '*.totp_secret',
  '*.bluesunrewards___loyaltyid',
  'phobs_auth_user',
  'phobs_auth_pass',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: { service: 'phobs-automated-offers' },
  ...(config.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', singleLine: false },
        },
      }
    : {}),
});

export type Logger = typeof logger;
