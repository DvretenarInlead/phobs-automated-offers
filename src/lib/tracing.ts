/**
 * OpenTelemetry tracing — initialised only if `OTEL_EXPORTER_OTLP_ENDPOINT` is
 * set in env. Imported at the very top of server.ts and worker.ts so all
 * downstream instrumentation (http, ioredis, pg, undici) is patched before
 * those modules are required.
 *
 * Off by default. Zero runtime cost when disabled (the SDK isn't started).
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();

let sdk: NodeSDK | null = null;

if (endpoint) {
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'phobs-automated-offers',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.0.0',
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/+$/, '')}/v1/traces`,
      headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // Personal data must not leave for the collector:
        //  - ioredis' default serializer records ALL args for EVAL*/INCR/DEL,
        //    i.e. BullMQ's serialised job payloads and `login:fail:<email>`
        //    counters. Record the command name only.
        '@opentelemetry/instrumentation-ioredis': {
          dbStatementSerializer: (cmdName: string) => cmdName,
        },
        //  - HTTP server spans keep the query string; OAuth `code`/`state`
        //    and admin invite `token` travel there.
        '@opentelemetry/instrumentation-http': {
          redactedQueryParams: ['code', 'state', 'token', 'sig', 'signature'],
        },
        //  - pg: statement text without parameter values (the default; pinned
        //    here so an upgrade can't flip it).
        '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: false },
      }),
    ],
  });

  try {
    sdk.start();
    console.error(`[otel] tracing started, exporter=${endpoint}`);
  } catch (err) {
    console.error('[otel] failed to start tracing', err);
  }

  process.on('SIGTERM', () => {
    void sdk?.shutdown().catch(() => undefined);
  });
}

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

export const tracingEnabled = Boolean(endpoint);
