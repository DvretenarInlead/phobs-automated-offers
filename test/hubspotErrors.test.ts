import { describe, expect, it } from 'vitest';
import { hubspotError } from '../src/hubspot/errors.js';
import { ExternalServiceError } from '../src/lib/errors.js';

// Shape of @hubspot/api-client's ApiException as thrown at runtime.
function apiException(code: number, body: unknown, headers: Record<string, string>): unknown {
  const err = new Error(
    `HTTP-Code: ${code}\nMessage: HTTP-Code: ${code}\nBody: ${JSON.stringify(body)}\nHeaders: ${JSON.stringify(headers)}`,
  );
  return Object.assign(err, { code, body, headers });
}

describe('hubspotError', () => {
  it('keeps status, category, short message and correlation id only', () => {
    const body = {
      status: 'error',
      message: 'Property values were not valid: [{"isValid":false,"message":"Property \\"child_age_1\\" does not exist","name":"child_age_1","localizedErrorMessage":"guest email guest@example.com"}]',
      correlationId: 'abc-123',
      category: 'VALIDATION_ERROR',
    };
    const err = hubspotError('deal.update', apiException(400, body, { 'x-hubspot-correlation-id': 'abc-123', 'set-cookie': 'secret' }));
    expect(err).toBeInstanceOf(ExternalServiceError);
    expect(err.upstreamStatus).toBe(400);
    expect(err.message).toBe(
      `deal.update failed: HTTP 400: VALIDATION_ERROR: ${body.message.slice(0, 200)}: corr=abc-123`,
    );
    expect(err.message).not.toContain('Headers');
    expect(err.message).not.toContain('set-cookie');
    expect(err.message.length).toBeLessThan(320);
    // The full exception remains reachable for server-side logging.
    expect(err.cause).toBeDefined();
  });

  it('handles non-JSON bodies and plain errors', () => {
    const err = hubspotError('quote.create', apiException(502, '<html>Bad Gateway</html>', {}));
    expect(err.message).toBe('quote.create failed: HTTP 502: HTTP-Code: 502');
    expect(err.upstreamStatus).toBe(502);

    const plain = hubspotError('deal.get', new Error('socket hang up'));
    expect(plain.message).toBe('deal.get failed: socket hang up');
    expect(plain.upstreamStatus).toBeUndefined();
  });
});
