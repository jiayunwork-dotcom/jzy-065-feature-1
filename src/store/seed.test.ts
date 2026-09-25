import { describe, it, expect } from 'vitest';
import { assertDemoSane, demoScenario, DEMO_SCENARIO_NAME } from './seed';
import { assertDemoPlanSane, demoDailyPlanInput, DEMO_PLAN_NAME } from './planSeed';
import { validateDailyPlan } from '../plan/planValidation';
import { solveDailyPlan } from '../plan/solvePlan';
import { solveTiming } from '../timing/timing';

describe('seed four-phase scenario', () => {
  it('is mathematically sane and sits in the literature range', () => {
    expect(DEMO_SCENARIO_NAME).toBe('demo-four-phase');
    expect(demoScenario.phases).toHaveLength(4);
    assertDemoSane();
  });

  it('has four phases, Y about 0.7, L ~ 12 s, C0 ~ 76.7 s', () => {
    const r = solveTiming(demoScenario);
    expect(r.phases).toHaveLength(4);
    expect(r.Y).toBeCloseTo(0.7, 12);
    expect(r.lostTime).toBe(12);
    expect(r.optimalCycle).toBeCloseTo(76.6666666667, 6);
  });
});

describe('seed daily plan', () => {
  it('tiles the day with five segments and every segment solves and every transition is feasible', () => {
    expect(DEMO_PLAN_NAME).toBe('demo-day-plan');
    expect(demoDailyPlanInput.phases).toHaveLength(4);
    assertDemoPlanSane();

    const solved = solveDailyPlan(validateDailyPlan(demoDailyPlanInput), 20);
    expect(solved.segments).toHaveLength(5);
    expect(solved.segments[0]!.start).toBe('00:00');
    expect(solved.segments[4]!.end).toBe('24:00');
    expect(solved.segments.every((s) => s.status === 'ok')).toBe(true);
    expect(solved.transitions.every((t) => t.status === 'feasible')).toBe(true);
    // The peak period genuinely needs a longer cycle than the night.
    expect(solved.segments[1]!.result!.cycle).toBeGreaterThan(
      solved.segments[0]!.result!.cycle,
    );
  });
});
