import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_request, reply) => {
    try {
      await app.ctx.store.list();
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'not-ready' });
    }
  });
}
