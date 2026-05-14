import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
  }
}

export function registerRequestId(app: FastifyInstance): void {
  app.decorateRequest('requestId', '');
  app.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers['x-request-id'];
    req.requestId =
      typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
    void reply.header('x-request-id', req.requestId);
  });
}
