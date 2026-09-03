import { ExternalServiceError } from '../lib/errors.js';

/**
 * Turns a HubSpot SDK failure into an ExternalServiceError whose *message* is
 * safe to persist and display.
 *
 * The SDK's ApiException stringifies as
 *   "HTTP-Code: 400\nMessage: …\nBody: {…full JSON…}\nHeaders: {…}"
 * — the body echoes submitted property values and the headers are opaque
 * third-party content. Neither belongs in job_steps.error, BullMQ
 * failedReason (kept for days), SSE events or the admin UI. We keep status,
 * HubSpot's error `category`/`correlationId` and a short message; the full
 * exception stays on `cause` for server-side logging only.
 */
export function hubspotError(op: string, err: unknown): ExternalServiceError {
  const e = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: number;
    response?: { status?: number };
    body?: unknown;
    message?: string;
  };
  const status = typeof e.code === 'number' ? e.code : e.response?.status;

  let category: string | undefined;
  let correlationId: string | undefined;
  let message: string | undefined;
  const body = parseBody(e.body);
  if (body) {
    if (typeof body.category === 'string') category = body.category;
    if (typeof body.correlationId === 'string') correlationId = body.correlationId;
    if (typeof body.message === 'string') message = body.message;
  }
  if (!message && typeof e.message === 'string') message = firstLine(e.message);

  const parts = [`${op} failed`];
  if (status) parts.push(`HTTP ${status}`);
  if (category) parts.push(category);
  if (message) parts.push(message.slice(0, 200));
  if (correlationId) parts.push(`corr=${correlationId}`);

  return new ExternalServiceError('hubspot', parts.join(': '), status, err);
}

function parseBody(body: unknown): Record<string, unknown> | null {
  if (body && typeof body === 'object') return body as Record<string, unknown>;
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function firstLine(s: string): string {
  // ApiException.message starts with "HTTP-Code: …"; skip to the "Message:" line if present.
  const m = /Message:\s*(.*)/.exec(s);
  const line = (m?.[1] ?? s).split('\n')[0] ?? '';
  return line.trim();
}
