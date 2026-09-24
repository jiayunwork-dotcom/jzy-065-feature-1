import { describe, it, expect } from 'vitest';
import { assertDemoSane, demoScenario, DEMO_SCENARIO_NAME } from './seed';
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
