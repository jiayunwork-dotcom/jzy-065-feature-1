import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { MemoryScenarioStore, MemoryPlanStore } from '../store/memory';
import { demoScenario, demoPlanDefinition, DEMO_SCENARIO_NAME, DEMO_PLAN_NAME } from '../store/seed';

let app: FastifyInstance;

beforeAll(async () => {
  const store = new MemoryScenarioStore();
  const planStore = new MemoryPlanStore();
  // Mirror server startup: both seed definitions are loaded for sanity checks.
  await store.upsert(DEMO_SCENARIO_NAME, {
    phases: demoScenario.phases,
    lostTime: demoScenario.lostTime,
  });
  const demoPlan = demoPlanDefinition();
  await planStore.upsert(demoPlan.name, {
    lostTime: demoPlan.lostTime,
    phases: demoPlan.phases,
    periods: demoPlan.periods,
  });
  app = await buildApp({ store, planStore });
});

/** Baseline 3-period plan: 50 s off-peak cycles, 100 s peak cycle (L = 10). */
function planBody(overrides: Record<string, unknown> = {}) {
  return {
    lostTime: 10,
    phases: [{ s: 1000 }, { s: 1000 }, { s: 1000 }],
    periods: [
      { start: 0, end: 480, label: 'off-peak AM', q: [300, 200, 100] },
      { start: 480, end: 960, label: 'peak', q: [400, 300, 100] },
      { start: 960, end: 1440, label: 'off-peak PM', q: [300, 200, 100] },
    ],
    ...overrides,
  };
}

interface TransitionView {
  fromPeriod: number;
  toPeriod: number;
  fromCycle: number | null;
  toCycle: number | null;
  maxStep: number;
  flowBasis: string;
  status: string;
  steps: number | null;
  reason?: string;
  failure?: { step: number; cycle: number; code: string; phaseIndex?: number };
  cycles: Array<{
    step: number;
    role: string;
    cycle: number;
    lostTime: number;
    greenBalanceResidual: number;
    phases: Array<{ q: number; g: number; lambda: number; x: number }>;
  }>;
}

describe('POST /api/plans/solve', () => {
  it('solves every period and every adjacent transition (midnight wrap included)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/plans/solve', payload: planBody() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.periods).toHaveLength(3);
    expect(body.periods.map((p: { status: string }) => p.status)).toEqual(['ok', 'ok', 'ok']);
    expect(body.periods[0].timing.cycle).toBeCloseTo(50, 9);
    expect(body.periods[1].timing.cycle).toBeCloseTo(100, 9);
    expect(body.periods[2].timing.cycle).toBeCloseTo(50, 9);

    expect(body.transitions).toHaveLength(3);
    expect(body.transitions.map((t: TransitionView) => [t.fromPeriod, t.toPeriod])).toEqual([
      [0, 1],
      [1, 2],
      [2, 0],
    ]);
    expect(body.transitions[0].steps).toBe(5);
    expect(body.transitions[1].steps).toBe(5);
    expect(body.transitions[2].steps).toBe(0);
  });

  it('locks every transition onto its endpoint cycles with bounded steps and balanced greens', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plans/solve',
      payload: planBody({ maxCycleStep: 7 }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const t of body.transitions as TransitionView[]) {
      expect(t.status).toBe('feasible');
      expect(t.maxStep).toBe(7);
      // head and tail lock exactly onto the period cycles
      expect(t.cycles[0]!.cycle).toBeCloseTo(t.fromCycle!, 9);
      expect(t.cycles[t.cycles.length - 1]!.cycle).toBeCloseTo(t.toCycle!, 12);
      for (let i = 1; i < t.cycles.length; i += 1) {
        const step = Math.abs(t.cycles[i]!.cycle - t.cycles[i - 1]!.cycle);
        expect(step).toBeLessThanOrEqual(7 + 1e-9);
        expect(step).toBeGreaterThan(0);
      }
      // every cycle on the path is a genuine fresh solve: greens balance and
      // no phase is saturated at its own cycle length
      for (const c of t.cycles) {
        expect(c.greenBalanceResidual).toBeLessThanOrEqual(1e-9);
        const sumG = c.phases.reduce((a, p) => a + p.g, 0);
        expect(Math.abs(sumG + c.lostTime - c.cycle)).toBeLessThanOrEqual(1e-9);
        for (const p of c.phases) {
          expect(p.x).toBeLessThan(1);
          expect(p.lambda).toBeCloseTo(p.g / c.cycle, 10);
        }
      }
      // transition cycles (step >= 1) are solved against the ARRIVING period
      const target = body.periods[t.toPeriod];
      for (const c of t.cycles.slice(1)) {
        expect(c.phases.map((p) => p.q)).toEqual(target.timing.phases.map((p: { q: number }) => p.q));
      }
    }
  });

  it('rejects plans with gaps or overlaps before solving anything', async () => {
    const gap = planBody({
      periods: [
        { start: 0, end: 480, q: [300, 200, 100] },
        { start: 500, end: 960, q: [500, 400, 90] }, // also oversaturated — tiling still wins
        { start: 960, end: 1440, q: [300, 200, 100] },
      ],
    });
    const gapRes = await app.inject({ method: 'POST', url: '/api/plans/solve', payload: gap });
    expect(gapRes.statusCode).toBe(400);
    expect(gapRes.json().error.code).toBe('PLAN_GAP');
    expect(gapRes.json().error.details).toMatchObject({ periodIndex: 0, nextPeriodIndex: 1 });

    const overlap = planBody({
      periods: [
        { start: 0, end: 500, q: [300, 200, 100] },
        { start: 480, end: 960, q: [400, 300, 100] },
        { start: 960, end: 1440, q: [300, 200, 100] },
      ],
    });
    const overlapRes = await app.inject({ method: 'POST', url: '/api/plans/solve', payload: overlap });
    expect(overlapRes.statusCode).toBe(400);
    expect(overlapRes.json().error.code).toBe('PLAN_OVERLAP');
    expect(overlapRes.json().error.details).toMatchObject({ periodIndex: 0, nextPeriodIndex: 1 });
  });

  it('marks an oversaturated period but still solves the rest of the day', async () => {
    const body = planBody({
      periods: [
        { start: 0, end: 480, q: [300, 200, 100] },
        { start: 480, end: 960, q: [500, 400, 90] }, // Y = 0.99
        { start: 960, end: 1440, q: [300, 200, 100] },
      ],
    });
    const res = await app.inject({ method: 'POST', url: '/api/plans/solve', payload: body });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.periods.map((p: { status: string }) => p.status)).toEqual(['ok', 'error', 'ok']);
    expect(json.periods[1].error.code).toBe('OVERSATURATED_Y');
    const statuses = json.transitions.map((t: TransitionView) => t.status);
    expect(statuses).toEqual(['unavailable', 'unavailable', 'feasible']);
    expect(json.transitions[0].reason).toContain('period 1');
  });

  it('judges a transition infeasible when the step is too small to clear the saturated band', async () => {
    // Off-peak cycle 33.3 s; the peak period needs at least Ccrit = 50 s.
    const body = planBody({
      periods: [
        { start: 0, end: 480, q: [200, 150, 50] }, // Y=0.4, C0=33.33
        { start: 480, end: 960, q: [400, 300, 100] }, // Y=0.8, C0=100, Ccrit=50
        { start: 960, end: 1440, q: [300, 200, 100] },
      ],
      maxCycleStep: 10,
    });
    const res = await app.inject({ method: 'POST', url: '/api/plans/solve', payload: body });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    const [t01, t12, t20] = json.transitions as TransitionView[];
    // 33.3 + 10 = 43.3 < 50: the first transition cycle already saturates
    expect(t01!.status).toBe('infeasible');
    expect(t01!.failure!.step).toBe(1);
    expect(t01!.failure!.cycle).toBeCloseTo(43.3333, 4);
    expect(t01!.failure!.code).toBe('PHASE_SATURATED');
    expect(typeof t01!.failure!.phaseIndex).toBe('number');
    expect(t01!.cycles).toHaveLength(1); // only the start cycle
    // the other boundaries still produce their sequences
    expect(t12!.status).toBe('feasible');
    expect(t12!.cycles.length).toBeGreaterThan(1);
    expect(t20!.status).toBe('feasible');

    // the same plan with a larger allowed step clears the band in one move
    const bigStep = await app.inject({
      method: 'POST',
      url: '/api/plans/solve',
      payload: { ...body, maxCycleStep: 20 },
    });
    const cleared = bigStep.json().transitions[0] as TransitionView;
    expect(cleared.status).toBe('feasible');
    expect(cleared.steps).toBe(4);
    expect(cleared.cycles[cleared.cycles.length - 1]!.cycle).toBeCloseTo(100, 9);
  });

  it('rejects a non-positive maxCycleStep', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/plans/solve',
      payload: planBody({ maxCycleStep: 0 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_MAX_STEP');
  });
});

describe('named day-plan archive', () => {
  it('stores definitions only and re-solves everything on demand', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/plans/commuter',
      payload: planBody(),
    });
    expect(put.statusCode).toBe(200);
    const record = put.json();
    expect(record.name).toBe('commuter');
    expect(record.periods).toHaveLength(3);
    // the archive holds the definition — never a solved cycle or transition
    expect(record).not.toHaveProperty('timing');
    expect(record).not.toHaveProperty('transitions');

    const fetched = await app.inject({ method: 'GET', url: '/api/plans/commuter' });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).not.toHaveProperty('transitions');
    expect(fetched.json().periods[1].q).toEqual([400, 300, 100]);

    const listed = await app.inject({ method: 'GET', url: '/api/plans' });
    expect(listed.json().plans.some((p: { name: string }) => p.name === 'commuter')).toBe(true);
    expect(listed.json().plans.some((p: { name: string }) => p.name === DEMO_PLAN_NAME)).toBe(true);

    // re-solve from the archive: same result as the ad-hoc solve
    const adhoc = (await app.inject({ method: 'POST', url: '/api/plans/solve', payload: planBody() })).json();
    const solved = await app.inject({ method: 'POST', url: '/api/plans/commuter/solve', payload: {} });
    expect(solved.statusCode).toBe(200);
    expect(solved.json().plan).toBe('commuter');
    expect(solved.json().periods).toEqual(adhoc.periods);
    expect(solved.json().transitions).toEqual(adhoc.transitions);

    // updating the definition changes the next solve (nothing is replayed)
    const updated = planBody({
      periods: [
        { start: 0, end: 480, q: [300, 200, 100] },
        { start: 480, end: 960, q: [410, 310, 100] }, // heavier peak
        { start: 960, end: 1440, q: [300, 200, 100] },
      ],
    });
    await app.inject({ method: 'PUT', url: '/api/plans/commuter', payload: updated });
    const resolved = await app.inject({ method: 'POST', url: '/api/plans/commuter/solve', payload: {} });
    expect(resolved.json().periods[1].timing.cycle).toBeCloseTo(111.111, 3);
    expect(resolved.json().periods[1].timing.cycle).toBeGreaterThan(
      solved.json().periods[1].timing.cycle,
    );

    const del = await app.inject({ method: 'DELETE', url: '/api/plans/commuter' });
    expect(del.statusCode).toBe(204);
    const gone = await app.inject({ method: 'GET', url: '/api/plans/commuter' });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe('PLAN_NOT_FOUND');
  });

  it('refuses to archive a plan whose periods do not tile the day', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/plans/broken',
      payload: planBody({
        periods: [
          { start: 0, end: 480, q: [300, 200, 100] },
          { start: 500, end: 1440, q: [300, 200, 100] },
        ],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PLAN_GAP');
    const check = await app.inject({ method: 'GET', url: '/api/plans/broken' });
    expect(check.statusCode).toBe(404);
  });

  it('404s unknown plans on fetch, solve and delete', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/plans/nope' });
    expect(get.statusCode).toBe(404);
    const solve = await app.inject({ method: 'POST', url: '/api/plans/nope/solve', payload: {} });
    expect(solve.statusCode).toBe(404);
    expect(solve.json().error.code).toBe('PLAN_NOT_FOUND');
    const del = await app.inject({ method: 'DELETE', url: '/api/plans/nope' });
    expect(del.statusCode).toBe(404);
  });

  it('solves the seeded demo plan: six periods, six feasible transitions', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/plans/${DEMO_PLAN_NAME}/solve`, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.periods).toHaveLength(6);
    expect(body.periods.every((p: { status: string }) => p.status === 'ok')).toBe(true);
    expect(body.transitions).toHaveLength(6);
    expect(body.transitions.every((t: TransitionView) => t.status === 'feasible')).toBe(true);
    // the AM peak period reproduces the demo scenario's 76.67 s optimum
    const amPeak = body.periods[2];
    expect(amPeak.label).toBe('AM peak');
    expect(amPeak.timing.cycle).toBeCloseTo(76.6667, 3);
  });
});
