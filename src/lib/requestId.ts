import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

// Accept only characters safe to echo in an HTTP header and safe to embed in
// a JSON log line without terminator injection.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function registerRequestId(app: FastifyInstance): void {
  app.decorateRequest('requestId', '');
  app.addHook('onRequest', (req, reply, done) => {
    const incoming = req.headers['x-request-id'];
    req.requestId =
      typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    void reply.header('x-request-id', req.requestId);
    done();
  });
}
