import type { FastifyInstance } from 'fastify';
import { TimingError } from '../domain/errors';
import type { DayPlanResult, TimingResult, TransitionResult } from '../domain/types';
import { validateDayPlan, validateMaxCycleStep } from '../plan/validation';
import { solveDayPlan } from '../plan/plan';
import { serializeResult } from './timingRoutes';

interface NameParam {
  Params: { name: string };
}

function serializeTransition(t: TransitionResult) {
  return {
    fromPeriod: t.fromPeriod,
    toPeriod: t.toPeriod,
    fromCycle: t.fromCycle,
    toCycle: t.toCycle,
    maxStep: t.maxStep,
    flowBasis: t.flowBasis,
    status: t.status,
    steps: t.steps,
    ...(t.reason !== undefined ? { reason: t.reason } : {}),
    ...(t.failure !== undefined ? { failure: t.failure } : {}),
    cycles: t.cycles.map((c) => ({
      step: c.step,
      role: c.role,
      ...serializeResult(c.timing),
    })),
  };
}

export function serializeDayPlan(result: DayPlanResult) {
  return {
    lostTime: result.lostTime,
    maxCycleStep: result.maxCycleStep,
    periods: result.periods.map((p) => ({
      index: p.index,
      start: p.start,
      end: p.end,
      label: p.label,
      status: p.status,
      ...(p.status === 'ok'
        ? { timing: serializeResult(p.timing as TimingResult) }
        : { error: p.error }),
    })),
    transitions: result.transitions.map(serializeTransition),
  };
}

/**
 * Time-of-day day plans.
 *
 *   POST   /api/plans/solve        solve an ad-hoc plan definition
 *   PUT    /api/plans/:name        create/replace a named plan (definition only)
 *   GET    /api/plans              list named plans
 *   GET    /api/plans/:name        fetch the definition
 *   DELETE /api/plans/:name        remove
 *   POST   /api/plans/:name/solve  re-solve the stored plan (periods + transitions)
 *
 * The solve body is the plan definition plus an optional `maxCycleStep`
 * (seconds of cycle-length change allowed per cycle during transitions,
 * default 10). Only definitions persist; every solve re-runs the full chain.
 */
export async function planRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/plans/solve', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const maxCycleStep = validateMaxCycleStep(body.maxCycleStep);
    const plan = validateDayPlan(body);
    return serializeDayPlan(solveDayPlan(plan, maxCycleStep));
  });

  app.put<NameParam>('/api/plans/:name', async (request) => {
    const name = checkName(request.params.name);
    const plan = validateDayPlan(request.body);
    const record = await app.ctx.plans.upsert(name, {
      lostTime: plan.lostTime,
      phases: plan.phases.map((p) => ({
        s: p.s,
        ...(p.minGreen !== null ? { minGreen: p.minGreen } : {}),
        ...(p.label !== null ? { label: p.label } : {}),
      })),
      periods: plan.periods.map((p) => ({
        start: p.start,
        end: p.end,
        q: p.q,
        ...(p.label !== null ? { label: p.label } : {}),
      })),
    });
    return record;
  });

  app.get('/api/plans', async () => ({
    plans: await app.ctx.plans.list(),
  }));

  app.get<NameParam>('/api/plans/:name', async (request) => {
    const name = checkName(request.params.name);
    const record = await app.ctx.plans.get(name);
    if (!record) {
      throw new TimingError('PLAN_NOT_FOUND', `plan ${name} not found`, { name });
    }
    return record;
  });

  app.delete<NameParam>('/api/plans/:name', async (request, reply) => {
    const name = checkName(request.params.name);
    const removed = await app.ctx.plans.delete(name);
    if (!removed) {
      throw new TimingError('PLAN_NOT_FOUND', `plan ${name} not found`, { name });
    }
    void reply.status(204);
  });

  app.post<NameParam>('/api/plans/:name/solve', async (request) => {
    const name = checkName(request.params.name);
    const record = await app.ctx.plans.get(name);
    if (!record) {
      throw new TimingError('PLAN_NOT_FOUND', `plan ${name} not found`, { name });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const maxCycleStep = validateMaxCycleStep(body.maxCycleStep);
    // The stored definition is re-validated and re-solved from scratch;
    // nothing computed is ever read back from the archive.
    const plan = validateDayPlan(record);
    return { plan: record.name, ...serializeDayPlan(solveDayPlan(plan, maxCycleStep)) };
  });
}

function checkName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
    throw new TimingError('INVALID_REQUEST', 'plan name must be a non-empty string (<=128 chars)');
  }
  return name;
}
