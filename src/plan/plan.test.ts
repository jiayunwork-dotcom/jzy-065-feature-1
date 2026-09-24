import { describe, expect, it } from 'vitest';
import { validateDayPlan, validateMaxCycleStep } from './validation';
import { solveDayPlan } from './plan';
import { solveTiming } from '../timing/timing';
import { DEFAULT_MAX_CYCLE_STEP } from '../domain/constants';

/** Baseline 3-period plan, L = 10, s = 1000 veh/h per phase. */
function planBody(overrides: { periods?: unknown[]; phases?: unknown[]; lostTime?: number } = {}) {
  return {
    lostTime: overrides.lostTime ?? 10,
    phases: overrides.phases ?? [{ s: 1000 }, { s: 1000 }, { s: 1000 }],
    periods: overrides.periods ?? [
      { start: 0, end: 480, label: 'off-peak AM', q: [300, 200, 100] }, // Y=0.6, C0=50
      { start: 480, end: 960, label: 'peak', q: [400, 300, 100] }, // Y=0.8, C0=100
      { start: 960, end: 1440, label: 'off-peak PM', q: [300, 200, 100] }, // Y=0.6, C0=50
    ],
  };
}

describe('day-plan validation runs before any solving', () => {
  it('accepts a seamless plan tiling the whole day', () => {
    const plan = validateDayPlan(planBody());
    expect(plan.periods).toHaveLength(3);
    expect(plan.phases).toHaveLength(3);
    expect(plan.lostTime).toBe(10);
  });

  it('rejects a gap between two periods and names both of them', () => {
    const body = planBody({
      periods: [
        { start: 0, end: 480, q: [300, 200, 100] },
        { start: 500, end: 960, q: [400, 300, 100] }, // 20 min gap after period 0
        { start: 960, end: 1440, q: [300, 200, 100] },
      ],
    });
    expect(() => validateDayPlan(body)).toThrowError(
      expect.objectContaining({
        code: 'PLAN_GAP',
        details: expect.objectContaining({ periodIndex: 0, nextPeriodIndex: 1 }),
      }),
    );
  });

  it('rejects an overlap between two periods and names both of them', () => {
    const body = planBody({
      periods: [
        { start: 0, end: 500, q: [300, 200, 100] },
        { start: 480, end: 960, q: [400, 300, 100] }, // 20 min overlap with period 0
        { start: 960, end: 1440, q: [300, 200, 100] },
      ],
    });
    expect(() => validateDayPlan(body)).toThrowError(
      expect.objectContaining({
        code: 'PLAN_OVERLAP',
        details: expect.objectContaining({ periodIndex: 0, nextPeriodIndex: 1 }),
      }),
    );
  });

  it('rejects a plan that does not start at 00:00 or end at 24:00', () => {
    const lateStart = planBody({
      periods: [
        { start: 60, end: 960, q: [300, 200, 100] },
        { start: 960, end: 1440, q: [300, 200, 100] },
      ],
    });
    expect(() => validateDayPlan(lateStart)).toThrowError(
      expect.objectContaining({
        code: 'PLAN_GAP',
        details: expect.objectContaining({ between: 'dayStart', periodIndex: 0 }),
      }),
    );

    const earlyEnd = planBody({
      periods: [
        { start: 0, end: 960, q: [300, 200, 100] },
        { start: 960, end: 1400, q: [300, 200, 100] },
      ],
    });
    expect(() => validateDayPlan(earlyEnd)).toThrowError(
      expect.objectContaining({
        code: 'PLAN_GAP',
        details: expect.objectContaining({ between: 'dayEnd', periodIndex: 1 }),
      }),
    );
  });

  it('rejects inverted or out-of-day period times', () => {
    expect(() =>
      validateDayPlan(planBody({ periods: [{ start: 500, end: 500, q: [1, 1, 1] }] })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PERIOD_TIME' }));
    expect(() =>
      validateDayPlan(planBody({ periods: [{ start: 0, end: 1500, q: [1, 1, 1] }] })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PERIOD_TIME' }));
    expect(() =>
      validateDayPlan(planBody({ periods: [{ start: -5, end: 1440, q: [1, 1, 1] }] })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PERIOD_TIME' }));
  });

  it('requires one arrival flow per phase in every period', () => {
    expect(() =>
      validateDayPlan(planBody({ periods: [{ start: 0, end: 1440, q: [100, 200] }] })),
    ).toThrowError(expect.objectContaining({ code: 'PERIOD_FLOW_MISMATCH' }));
    expect(() =>
      validateDayPlan(planBody({ periods: [{ start: 0, end: 1440, q: [100, -1, 50] }] })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ARRIVAL_FLOW' }));
  });

  it('reuses the shared validation rules for phases and lost time', () => {
    expect(() => validateDayPlan(planBody({ lostTime: 0 }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_LOST_TIME' }),
    );
    expect(() => validateDayPlan(planBody({ phases: [{ s: 1000 }] }))).toThrowError(
      expect.objectContaining({ code: 'TOO_FEW_PHASES' }),
    );
    expect(() =>
      validateDayPlan(planBody({ phases: [{ s: 1000 }, { s: 0 }, { s: 1000 }] })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SATURATION_FLOW' }));
  });

  it('validates the per-cycle max step', () => {
    expect(validateMaxCycleStep(undefined)).toBe(DEFAULT_MAX_CYCLE_STEP);
    expect(validateMaxCycleStep(7.5)).toBe(7.5);
    for (const bad of [0, -3, NaN, 'fast']) {
      expect(() => validateMaxCycleStep(bad)).toThrowError(
        expect.objectContaining({ code: 'INVALID_MAX_STEP' }),
      );
    }
  });
});

describe('per-period solving', () => {
  it('solves each period independently with its own arrival flows', () => {
    const result = solveDayPlan(validateDayPlan(planBody()), 10);
    expect(result.periods).toHaveLength(3);
    expect(result.periods.map((p) => p.status)).toEqual(['ok', 'ok', 'ok']);
    expect(result.periods[0]!.timing!.Y).toBeCloseTo(0.6, 12);
    expect(result.periods[1]!.timing!.Y).toBeCloseTo(0.8, 12);
    expect(result.periods[2]!.timing!.Y).toBeCloseTo(0.6, 12);
    expect(result.periods[0]!.timing!.cycle).toBeCloseTo(50, 9);
    expect(result.periods[1]!.timing!.cycle).toBeCloseTo(100, 9);
    // and each period's timing is exactly what the single-instant chain gives
    const solo = solveTiming({
      lostTime: 10,
      phases: [
        { q: 400, s: 1000 },
        { q: 300, s: 1000 },
        { q: 100, s: 1000 },
      ],
    });
    expect(result.periods[1]!.timing).toEqual(solo);
  });

  it('raising one period’s flows moves only that period; the others are untouched', () => {
    const before = solveDayPlan(validateDayPlan(planBody()), 10);
    const heavier = planBody({
      periods: [
        { start: 0, end: 480, q: [300, 200, 100] },
        { start: 480, end: 960, q: [450, 340, 110] }, // Y: 0.8 -> 0.9
        { start: 960, end: 1440, q: [300, 200, 100] },
      ],
    });
    const after = solveDayPlan(validateDayPlan(heavier), 10);

    expect(after.periods[1]!.timing!.cycle).toBeGreaterThan(before.periods[1]!.timing!.cycle);
    expect(after.periods[1]!.timing!.totalDelayRate).toBeGreaterThan(
      before.periods[1]!.timing!.totalDelayRate,
    );
    // untouched periods produce bit-identical results
    expect(after.periods[0]!.timing).toEqual(before.periods[0]!.timing);
    expect(after.periods[2]!.timing).toEqual(before.periods[2]!.timing);
  });

  it('marks an oversaturated period without poisoning the rest of the plan', () => {
    const body = planBody({
      periods: [
        { start: 0, end: 480, q: [300, 200, 100] },
        { start: 480, end: 960, q: [500, 400, 90] }, // Y = 0.99 -> oversaturated
        { start: 960, end: 1440, q: [300, 200, 100] },
      ],
    });
    const result = solveDayPlan(validateDayPlan(body), 10);
    expect(result.periods.map((p) => p.status)).toEqual(['ok', 'error', 'ok']);
    expect(result.periods[1]!.error!.code).toBe('OVERSATURATED_Y');
    expect(result.periods[0]!.timing!.cycle).toBeCloseTo(50, 9);
    expect(result.periods[2]!.timing!.cycle).toBeCloseTo(50, 9);
    // transitions touching the broken period are unavailable; the midnight
    // wrap between the two healthy periods still computes
    expect(result.transitions.map((t) => t.status)).toEqual([
      'unavailable',
      'unavailable',
      'feasible',
    ]);
    expect(result.transitions[2]!.fromPeriod).toBe(2);
    expect(result.transitions[2]!.toPeriod).toBe(0);
    expect(result.transitions[0]!.reason).toContain('period 1');
  });

  it('marks a period whose phase saturates and identifies the phase', () => {
    const body = {
      lostTime: 10,
      phases: [{ s: 1000, minGreen: 35 }, { s: 1000 }, { s: 1000 }],
      periods: [
        { start: 0, end: 720, q: [400, 300, 200] }, // Y=0.9, phase 0 not pinned
        { start: 720, end: 1440, q: [100, 500, 300] }, // minGreen pins phase 0, starves phase 1
      ],
    };
    const result = solveDayPlan(validateDayPlan(body), 10);
    expect(result.periods[0]!.status).toBe('ok');
    expect(result.periods[1]!.status).toBe('error');
    expect(result.periods[1]!.error!.code).toBe('PHASE_SATURATED');
    expect(result.periods[1]!.error!.details).toMatchObject({ phaseIndex: 1 });
  });

  it('a single-period plan tiles the day and needs no transitions', () => {
    const body = planBody({ periods: [{ start: 0, end: 1440, q: [300, 200, 100] }] });
    const result = solveDayPlan(validateDayPlan(body), 10);
    expect(result.periods).toHaveLength(1);
    expect(result.periods[0]!.status).toBe('ok');
    expect(result.transitions).toEqual([]);
  });
});

describe('transitions are generated for every adjacent pair, midnight included', () => {
  it('produces one transition per period with the last wrapping to the first', () => {
    const result = solveDayPlan(validateDayPlan(planBody()), 10);
    expect(result.transitions).toHaveLength(3);
    expect(result.transitions.map((t) => [t.fromPeriod, t.toPeriod])).toEqual([
      [0, 1],
      [1, 2],
      [2, 0],
    ]);
    // 50 -> 100 in 5 steps, 100 -> 50 in 5 steps, 50 -> 50 in 0 steps
    expect(result.transitions[0]!.steps).toBe(5);
    expect(result.transitions[1]!.steps).toBe(5);
    expect(result.transitions[2]!.steps).toBe(0);
    for (const t of result.transitions) {
      expect(t.status).toBe('feasible');
      expect(t.cycles[0]!.cycle).toBeCloseTo(t.fromCycle!, 9);
      expect(t.cycles[t.cycles.length - 1]!.cycle).toBeCloseTo(t.toCycle!, 12);
    }
  });

  it('a larger cycle gap with the same max step means more transition steps', () => {
    const base = solveDayPlan(validateDayPlan(planBody()), 10);
    const heavierPeak = planBody({
      periods: [
        { start: 0, end: 480, q: [300, 200, 100] },
        { start: 480, end: 960, q: [410, 310, 100] }, // Y=0.82, C0 ~ 111
        { start: 960, end: 1440, q: [300, 200, 100] },
      ],
    });
    const stretched = solveDayPlan(validateDayPlan(heavierPeak), 10);
    const t0Base = base.transitions[0]!;
    const t0Stretched = stretched.transitions[0]!;
    expect(t0Stretched.toCycle!).toBeGreaterThan(t0Base.toCycle!);
    expect(t0Stretched.steps!).toBeGreaterThan(t0Base.steps!);
    // both ends still lock exactly onto the period cycles
    expect(t0Stretched.cycles[0]!.cycle).toBeCloseTo(50, 9);
    expect(t0Stretched.cycles[t0Stretched.cycles.length - 1]!.cycle).toBeCloseTo(
      stretched.periods[1]!.timing!.cycle,
      12,
    );
  });
});
