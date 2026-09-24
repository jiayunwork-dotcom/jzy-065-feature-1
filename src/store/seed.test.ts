import { describe, it, expect } from 'vitest';
import {
  assertDemoSane,
  assertDemoPlanSane,
  demoScenario,
  demoDayPlan,
  DEMO_SCENARIO_NAME,
  DEMO_PLAN_NAME,
} from './seed';
import { solveTiming } from '../timing/timing';
import { validateDayPlan } from '../plan/validation';
import { solveDayPlan } from '../plan/plan';
import { DEFAULT_MAX_CYCLE_STEP } from '../domain/constants';

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

describe('seed time-of-day plan', () => {
  it('is mathematically sane: every period solves, every transition is feasible', () => {
    expect(DEMO_PLAN_NAME).toBe('demo-day-plan');
    assertDemoPlanSane();
  });

  it('tiles the full day seamlessly and reproduces the demo scenario at the AM peak', () => {
    const plan = validateDayPlan(demoDayPlan);
    expect(plan.periods[0]!.start).toBe(0);
    expect(plan.periods[plan.periods.length - 1]!.end).toBe(1440);
    for (let i = 1; i < plan.periods.length; i += 1) {
      expect(plan.periods[i]!.start).toBe(plan.periods[i - 1]!.end);
    }
    const result = solveDayPlan(plan, DEFAULT_MAX_CYCLE_STEP);
    const amPeak = result.periods[2]!;
    expect(amPeak.status).toBe('ok');
    expect(amPeak.timing!.Y).toBeCloseTo(0.7, 12);
    expect(amPeak.timing!.cycle).toBeCloseTo(76.6666666667, 6);
    // the wrap transition closes the loop: last period back to the first
    const wrap = result.transitions[result.transitions.length - 1]!;
    expect(wrap.fromPeriod).toBe(5);
    expect(wrap.toPeriod).toBe(0);
    expect(wrap.status).toBe('feasible');
  });
});
