import type { FastifyInstance } from 'fastify';
import { TimingError } from '../domain/errors';
import type {
  DailyPlanRecord,
  SolvedDailyPlan,
  SolvedSegment,
  TransitionResult,
} from '../domain/types';
import { validateDailyPlan, validateMaxAdjustment } from '../plan/planValidation';
import { solveDailyPlan } from '../plan/solvePlan';
import { serializeResult } from './timingRoutes';

interface NameParam {
  Params: { name: string };
}

/**
 * Daily time-of-day plans.
 *
 *   POST   /api/plans/solve            plan definition + maxCycleAdjustment -> full day
 *   PUT    /api/plans/:name            store the DEFINITION (timeline + flows) only
 *   GET    /api/plans                  list stored definitions
 *   GET    /api/plans/:name            fetch one definition
 *   DELETE /api/plans/:name            remove
 *   POST   /api/plans/:name/solve      body {"maxCycleAdjustment": n}; re-solve from the stored definition
 *
 * Structural timeline problems (gaps, overlaps, day not covered) are rejected
 * BEFORE solving (400); a bad segment or an infeasible transition is part of
 * the 200 result and reported in place.
 */
export async function planRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/plans/solve', async (request) => {
    const plan = validateDailyPlan(request.body);
    const maxAdjustment = readMaxAdjustment(request.body);
    return serializeSolvedPlan(solveDailyPlan(plan, maxAdjustment));
  });

  app.put<NameParam>('/api/plans/:name', async (request) => {
    const name = checkName(request.params.name);
    const plan = validateDailyPlan(request.body);
    const record = await app.ctx.plans.upsert(name, {
      lostTime: plan.lostTime,
      phases: plan.phases.map((p) => ({
        s: p.s,
        ...(p.minGreen !== null ? { minGreen: p.minGreen } : {}),
        ...(p.label !== null ? { label: p.label } : {}),
      })),
      segments: plan.segments.map((s) => ({
        start: minuteToClock(s.startMinute),
        end: minuteToClock(s.endMinute),
        ...(s.label !== null ? { label: s.label } : {}),
        flows: s.flows.map((q) => q),
      })),
    });
    return record;
  });

  app.get('/api/plans', async () => ({
    plans: await app.ctx.plans.list(),
  }));

  app.get<NameParam>('/api/plans/:name', async (request) => {
    return loadPlan(app, request.params.name);
  });

  app.delete<NameParam>('/api/plans/:name', async (request, reply) => {
    const name = checkName(request.params.name);
    const removed = await app.ctx.plans.delete(name);
    if (!removed) {
      throw new TimingError('NOT_FOUND', `plan ${name} not found`, { name });
    }
    void reply.status(204);
  });

  app.post<NameParam>('/api/plans/:name/solve', async (request) => {
    const record = await loadPlan(app, request.params.name);
    const plan = validateDailyPlan({
      lostTime: record.lostTime,
      phases: record.phases,
      segments: record.segments,
    });
    const maxAdjustment = readMaxAdjustment(request.body);
    return { plan: record.name, ...serializeSolvedPlan(solveDailyPlan(plan, maxAdjustment)) };
  });
}

function readMaxAdjustment(body: unknown): number {
  const b = (body ?? {}) as Record<string, unknown>;
  return validateMaxAdjustment(b.maxCycleAdjustment);
}

function minuteToClock(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

async function loadPlan(app: FastifyInstance, rawName: string): Promise<DailyPlanRecord> {
  const name = checkName(rawName);
  const record = await app.ctx.plans.get(name);
  if (!record) {
    throw new TimingError('NOT_FOUND', `plan ${name} not found`, { name });
  }
  return record;
}

function checkName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
    throw new TimingError('INVALID_PLAN', 'plan name must be a non-empty string (<=128 chars)');
  }
  return name;
}

function serializeSegment(segment: SolvedSegment) {
  const common = {
    index: segment.index,
    start: segment.start,
    end: segment.end,
    label: segment.label,
    status: segment.status,
  };
  if (segment.status === 'ok' && segment.result) {
    return { ...common, ...serializeResult(segment.result) };
  }
  return { ...common, error: segment.error };
}

function serializeTransition(transition: TransitionResult) {
  return {
    fromSegment: transition.fromSegment,
    toSegment: transition.toSegment,
    fromCycle: transition.fromCycle,
    toCycle: transition.toCycle,
    maxAdjustment: transition.maxAdjustment,
    status: transition.status,
    ...(transition.reason !== undefined ? { reason: transition.reason } : {}),
    cycles: transition.cycles.map((entry) => {
      const common = { step: entry.step, cycle: entry.cycle, status: entry.status };
      if (entry.status === 'ok' && entry.result) {
        return { ...common, ...serializeResult(entry.result) };
      }
      return { ...common, error: entry.error };
    }),
  };
}

export function serializeSolvedPlan(solved: SolvedDailyPlan) {
  return {
    lostTime: solved.lostTime,
    maxAdjustment: solved.maxAdjustment,
    segments: solved.segments.map(serializeSegment),
    transitions: solved.transitions.map(serializeTransition),
  };
}
