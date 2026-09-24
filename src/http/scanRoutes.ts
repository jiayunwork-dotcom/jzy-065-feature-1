import type { FastifyInstance } from 'fastify';
import { TimingError } from '../domain/errors';
import type { ScanJobView } from '../domain/types';

/**
 * (3) Cycle scan — interruptible long job.
 *
 *   POST   /api/scans          submit {phases, lostTime, cycles, pointDelayMs?}
 *   GET    /api/scans/:id      poll state; points appear only once complete
 *   DELETE /api/scans/:id      cancel; a cancelled job never exposes partial points
 */
export async function scanRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/scans', async (request, reply) => {
    const view = app.ctx.scans.create(request.body);
    void reply.status(202);
    return serializeScanView(view);
  });

  app.get<{ Params: { id: string } }>('/api/scans/:id', async (request) => {
    const { id } = request.params;
    const view = app.ctx.scans.get(id);
    if (!view) {
      throw new TimingError('SCAN_NOT_FOUND', `scan job ${id} not found`, { id });
    }
    return serializeScanView(view);
  });

  app.delete<{ Params: { id: string } }>('/api/scans/:id', async (request) => {
    const { id } = request.params;
    const view = app.ctx.scans.cancel(id);
    return serializeScanView(view);
  });
}

export function serializeScanView(view: ScanJobView) {
  return {
    id: view.id,
    state: view.state,
    total: view.total,
    completed: view.completed,
    createdAt: view.createdAt,
    finishedAt: view.finishedAt,
    cancelled: view.state === 'cancelled',
    ...(view.error !== undefined ? { error: view.error } : {}),
    // Half-computed points are never delivered as a complete curve.
    points: view.state === 'completed' ? view.points : [],
  };
}
