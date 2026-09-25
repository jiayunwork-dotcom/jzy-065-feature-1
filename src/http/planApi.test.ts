import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { MemoryScenarioStore } from '../store/memory';
import { DEMO_PLAN_NAME, demoPlanDefinition, assertDemoPlanSane } from '../store/planSeed';

let app: FastifyInstance;

beforeAll(async () => {
  // Mirrors server startup: seed scenario archive + plan archive.
  const store = new MemoryScenarioStore();
  app = await buildApp({ store });
  const demo = demoPlanDefinition();
  await app.ctx.plans.upsert(DEMO_PLAN_NAME, {
    lostTime: demo.lostTime,
    phases: demo.phases,
    segments: demo.segments,
  });
});

const body = {
  lostTime: 10,
  maxCycleAdjustment: 20,
  phases: [
    { s: 1000, label: 'A' },
    { s: 1000, label: 'B' },
  ],
  segments: [
    { start: '00:00', end: '06:00', label: 'night', flows: [150, 50] },
    { start: '06:00', end: '10:00', label: 'peak', flows: [700, 100] },
    { start: '10:00', end: '16:00', label: 'mid', flows: [400, 300] },
    { start: '16:00', end: '20:00', label: 'evening', flows: [600, 200] },
    { start: '20:00', end: '24:00', label: 'late', flows: [400, 300] },
  ],
};

describe('POST /api/plans/solve', () => {
  it('solves every segment and returns a transition per adjacent pair', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/plans/solve', payload: body });
    expect(res.statusCode).toBe(200);
    const solved = res.json();
    expect(solved.segments).toHaveLength(5);
    expect(solved.transitions).toHaveLength(4);
    for (const seg of solved.segments) {
      expect(seg.status).toBe('ok');
      const sumG = seg.phases.reduce((a: number, p: { g: number }) => a + p.g, 0);
      expect(Math.abs(sumG + seg.lostTime - seg.cycle)).toBeLessThan(1e-8);
    }
  });

  it('anchors transition endpoints exactly on the two optimal cycles and bounds every step', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/plans/solve', payload: body });
    const solved = res.json();
    solved.transitions.forEach(
      (t: {
        fromSegment: number;
        toSegment: number;
        fromCycle: number;
        toCycle: number;
        maxAdjustment: number;
        cycles: Array<{ cycle: number; status: string }>;
      }) => {
        expect(t.fromCycle).toBeCloseTo(solved.segments[t.fromSegment].cycle, 9);
        expect(t.toCycle).toBeCloseTo(solved.segments[t.toSegment].cycle, 9);
        expect(t.cycles[0]!.cycle).toBeCloseTo(t.fromCycle, 9);
        expect(t.cycles[t.cycles.length - 1]!.cycle).toBeCloseTo(t.toCycle, 9);
        for (let i = 1; i < t.cycles.length; i += 1) {
          expect(Math.abs(t.cycles[i]!.cycle - t.cycles[i - 1]!.cycle)).toBeLessThanOrEqual(
            t.maxAdjustment + 1e-9,
          );
        }
      },
    );
  });

  it('rejects a gap and an overlap BEFORE solving (400, naming the pair)', async () => {
    const gapped = {
      ...body,
      segments: [
        { start: '00:00', end: '05:30', flows: [150, 50] },
        ...body.segments.slice(1),
      ],
    };
    const gap = await app.inject({ method: 'POST', url: '/api/plans/solve', payload: gapped });
    expect(gap.statusCode).toBe(400);
    expect(gap.json().error.code).toBe('SEGMENT_GAP');
    expect(gap.json().error.details.between).toEqual([0, 1]);

    const overlap = {
      ...body,
      segments: [
        body.segments[0],
        { start: '05:30', end: '10:00', flows: [700, 100] },
        ...body.segments.slice(2),
      ],
    };
    const ov = await app.inject({ method: 'POST', url: '/api/plans/solve', payload: overlap });
    expect(ov.statusCode).toBe(400);
    expect(ov.json().error.code).toBe('SEGMENT_OVERLAP');
  });

  it('400s when the day is not fully covered or maxCycleAdjustment is bad', async () => {
    const earlyEnd = {
      ...body,
      segments: [...body.segments.slice(0, -1), { start: '20:00', end: '23:00', flows: [200, 100] }],
    };
    const res = await app.inject({ method: 'POST', url: '/api/plans/solve', payload: earlyEnd });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('DAY_NOT_COVERED');

    const noStep = await app.inject({
      method: 'POST',
      url: '/api/plans/solve',
      payload: { ...body, maxCycleAdjustment: 0 },
    });
    expect(noStep.statusCode).toBe(400);
    expect(noStep.json().error.code).toBe('INVALID_CYCLE_ADJUSTMENT');
  });

  it('keeps an oversaturated segment local (200) and skips its transitions', async () => {
    const bad = {
      ...body,
      segments: body.segments.map((s, i) => (i === 2 ? { ...s, flows: [990, 0] } : s)),
    };
    const res = await app.inject({ method: 'POST', url: '/api/plans/solve', payload: bad });
    expect(res.statusCode).toBe(200);
    const solved = res.json();
    expect(solved.segments[2].status).toBe('error');
    expect(solved.segments[2].error.code).toBe('OVERSATURATED_Y');
    expect(solved.segments.filter((s: { status: string }) => s.status === 'ok')).toHaveLength(4);
    // transitions touching the broken segment (index 1 and 2) are skipped;
    // the other two pairs remain feasible.
    expect(solved.transitions.map((t: { status: string }) => t.status)).toEqual([
      'feasible',
      'skipped',
      'skipped',
      'feasible',
    ]);
  });

  it('reports an infeasible transition at the exact step and phase that saturate', async () => {
    const payload = {
      lostTime: 10,
      maxCycleAdjustment: 10,
      phases: [
        { s: 1000 },
        { s: 1000, minGreen: 15 },
      ],
      segments: [
        { start: '00:00', end: '12:00', flows: [700, 100] },
        { start: '12:00', end: '24:00', flows: [550, 100] },
      ],
    };
    const res = await app.inject({ method: 'POST', url: '/api/plans/solve', payload });
    expect(res.statusCode).toBe(200);
    const t = res.json().transitions[0];
    expect(t.status).toBe('infeasible');
    const broken = t.cycles[t.cycles.length - 1];
    expect(broken.step).toBe(2);
    expect(broken.status).toBe('error');
    expect(broken.error.code).toBe('PHASE_SATURATED');
    expect(broken.error.details.phaseIndex).toBe(0);
    // Every published ok cycle itself closes the green-balance identity.
    for (const c of t.cycles.slice(0, -1)) {
      const sumG = c.phases.reduce((a: number, p: { g: number }) => a + p.g, 0);
      expect(Math.abs(sumG + 10 - c.cycle)).toBeLessThan(1e-8);
    }
  });
});

describe('named daily plans archive', () => {
  it('PUT stores only the definition; GET returns it; POST solve recomputes fresh; DELETE removes', async () => {
    const def = {
      lostTime: body.lostTime,
      phases: body.phases,
      segments: body.segments.map(({ label: _label, ...rest }) => rest),
    };

    const put = await app.inject({
      method: 'PUT',
      url: '/api/plans/test-plan',
      payload: def,
    });
    expect(put.statusCode).toBe(200);
    const stored = put.json();
    expect(stored.segments).toHaveLength(5);
    // No computed results are persisted on the record.
    expect(stored.optimalCycle).toBeUndefined();
    expect(stored.transitions).toBeUndefined();

    const get = await app.inject({ method: 'GET', url: '/api/plans/test-plan' });
    expect(get.statusCode).toBe(200);
    expect(get.json().segments[0].flows).toEqual([150, 50]);

    const list = await app.inject({ method: 'GET', url: '/api/plans' });
    expect(list.json().plans.some((p: { name: string }) => p.name === 'test-plan')).toBe(true);
    expect(list.json().plans.some((p: { name: string }) => p.name === DEMO_PLAN_NAME)).toBe(true);

    const solve1 = await app.inject({
      method: 'POST',
      url: '/api/plans/test-plan/solve',
      payload: { maxCycleAdjustment: 30 },
    });
    expect(solve1.statusCode).toBe(200);
    expect(solve1.json().maxAdjustment).toBe(30);
    expect(solve1.json().segments).toHaveLength(5);

    // Re-solve with a DIFFERENT operating parameter: walks recompute, the
    // stored definition does not encode any prior result.
    const solve2 = await app.inject({
      method: 'POST',
      url: '/api/plans/test-plan/solve',
      payload: { maxCycleAdjustment: 10 },
    });
    const long = solve1.json().transitions.map(
      (t: { cycles: unknown[] }) => t.cycles.length,
    );
    const short = solve2.json().transitions.map(
      (t: { cycles: unknown[] }) => t.cycles.length,
    );
    expect(short.some((n: number, i: number) => n >= long[i])).toBe(true);

    const missing = await app.inject({ method: 'GET', url: '/api/plans/nope' });
    expect(missing.statusCode).toBe(404);

    const del = await app.inject({ method: 'DELETE', url: '/api/plans/test-plan' });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: '/api/plans/test-plan' });
    expect(after.statusCode).toBe(404);
  });

  it('rejects a non-tiling definition on PUT', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/plans/bad-plan',
      payload: {
        lostTime: 10,
        phases: body.phases,
        segments: [
          { start: '01:00', end: '12:00', flows: [1, 1] },
          { start: '12:00', end: '24:00', flows: [2, 2] },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('DAY_NOT_COVERED');
  });

  it('the shipped seed plan solves with every transition feasible', () => {
    expect(() => assertDemoPlanSane()).not.toThrow();
  });
});
