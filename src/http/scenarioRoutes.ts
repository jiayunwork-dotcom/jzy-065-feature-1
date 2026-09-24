import type { FastifyInstance } from 'fastify';
import { TimingError } from '../domain/errors';
import { validateTimingInput } from '../domain/validation';
import { solveParsed } from '../timing/timing';
import { serializeResult } from './timingRoutes';
import { serializeScanView } from './scanRoutes';

interface NameParam {
  Params: { name: string };
}

/**
 * Named scenario archive.
 *
 *   PUT    /api/scenarios/:name        create/replace a case (definition only)
 *   GET    /api/scenarios              list cases
 *   GET    /api/scenarios/:name        fetch the definition
 *   DELETE /api/scenarios/:name        remove
 *   POST   /api/scenarios/:name/timing   Y + C0 + green ratios for the stored case
 *   POST   /api/scenarios/:name/evaluate optional {cycle}; delays recomputed from the stored q/s/L
 *   POST   /api/scenarios/:name/scan     {cycles} -> interruptible sweep of the stored case
 */
export async function scenarioRoutes(app: FastifyInstance): Promise<void> {
  app.put<NameParam>('/api/scenarios/:name', async (request) => {
    const name = checkName(request.params.name);
    const parsed = validateTimingInput(request.body, { allowCycle: false });
    const record = await app.ctx.store.upsert(name, {
      phases: parsed.phases.map((p) => ({
        q: p.q,
        s: p.s,
        ...(p.minGreen !== null ? { minGreen: p.minGreen } : {}),
        ...(p.label !== null ? { label: p.label } : {}),
      })),
      lostTime: parsed.lostTime,
    });
    return record;
  });

  app.get('/api/scenarios', async () => ({
    scenarios: await app.ctx.store.list(),
  }));

  app.get<NameParam>('/api/scenarios/:name', async (request) => {
    const name = checkName(request.params.name);
    const record = await app.ctx.store.get(name);
    if (!record) {
      throw new TimingError('NOT_FOUND', `scenario ${name} not found`, { name });
    }
    return record;
  });

  app.delete<NameParam>('/api/scenarios/:name', async (request, reply) => {
    const name = checkName(request.params.name);
    const removed = await app.ctx.store.delete(name);
    if (!removed) {
      throw new TimingError('NOT_FOUND', `scenario ${name} not found`, { name });
    }
    void reply.status(204);
  });

  app.post<NameParam>('/api/scenarios/:name/timing', async (request) => {
    const scenario = await loadScenario(app, request.params.name);
    const parsed = validateTimingInput(scenario, { allowCycle: false });
    const result = solveParsed(parsed);
    return {
      scenario: scenario.name,
      Y: result.Y,
      lostTime: result.lostTime,
      optimalCycle: result.optimalCycle,
      cycle: result.cycle,
      phases: result.phases.map((p) => ({
        index: p.index,
        label: p.label,
        y: p.y,
        g: p.g,
        lambda: p.lambda,
        minGreen: p.minGreen,
        x: p.x,
      })),
    };
  });

  app.post<NameParam>('/api/scenarios/:name/evaluate', async (request) => {
    const scenario = await loadScenario(app, request.params.name);
    const body = (request.body ?? {}) as { cycle?: unknown };
    const parsed = validateTimingInput(
      { ...scenario, cycle: body.cycle },
      { allowCycle: true },
    );
    return { scenario: scenario.name, ...serializeResult(solveParsed(parsed)) };
  });

  app.post<NameParam>('/api/scenarios/:name/scan', async (request, reply) => {
    const scenario = await loadScenario(app, request.params.name);
    const body = (request.body ?? {}) as { cycles?: unknown; pointDelayMs?: unknown };
    const view = app.ctx.scans.create({
      phases: scenario.phases,
      lostTime: scenario.lostTime,
      cycles: body.cycles,
      ...(body.pointDelayMs !== undefined ? { pointDelayMs: body.pointDelayMs } : {}),
    });
    void reply.status(202);
    return { scenario: scenario.name, ...serializeScanView(view) };
  });
}

async function loadScenario(app: FastifyInstance, rawName: string) {
  const name = checkName(rawName);
  const record = await app.ctx.store.get(name);
  if (!record) {
    throw new TimingError('NOT_FOUND', `scenario ${name} not found`, { name });
  }
  return record;
}

function checkName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
    throw new TimingError('INVALID_REQUEST', 'scenario name must be a non-empty string (<=128 chars)');
  }
  return name;
}
