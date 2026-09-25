import { describe, expect, it } from 'vitest';
import { validateDailyPlan } from '../plan/planValidation';
import { solveDailyPlan, segmentTimingInput } from '../plan/solvePlan';
import { solveTiming } from '../timing/timing';
import { BALANCE_TOLERANCE } from '../domain/constants';
import type { DailyPlanInput } from '../domain/types';

/**
 * Transition semantics under test:
 *
 * Every walked cycle is solved FRESH at its OWN length with the DEPARTING
 * segment's arrival rates (the cycles are executed inside that period's tail,
 * before the boundary). The last walked cycle length equals the arriving
 * segment's optimal cycle; the pattern then switches on the boundary.
 */

function simpleDay(
  a: number[],
  b: number[],
  extra: { minGreen0?: number; minGreen1?: number } = {},
): DailyPlanInput {
  return {
    lostTime: 10,
    phases: [
      { s: 1000, ...(extra.minGreen0 !== undefined ? { minGreen: extra.minGreen0 } : {}) },
      { s: 1000, ...(extra.minGreen1 !== undefined ? { minGreen: extra.minGreen1 } : {}) },
    ],
    segments: [
      { start: '00:00', end: '12:00', label: 'A', flows: a },
      { start: '12:00', end: '24:00', label: 'B', flows: b },
    ],
  };
}

describe('feasible transition walks', () => {
  it('anchors the walk exactly on both optimal cycles and re-allocates greens per cycle', () => {
    const parsed = validateDailyPlan(simpleDay([300, 200], [500, 300]));
    const solved = solveDailyPlan(parsed, 20);
    const cA = solved.segments[0]!.result!.cycle;
    const cB = solved.segments[1]!.result!.cycle;
    expect(cB).toBeGreaterThan(cA);

    const t = solved.transitions[0]!;
    expect(t.status).toBe('feasible');
    expect(t.fromSegment).toBe(0);
    expect(t.toSegment).toBe(1);
    expect(t.fromCycle).toBe(cA);
    expect(t.toCycle).toBe(cB);

    const entries = t.cycles;
    expect(entries[0]!.cycle).toBe(cA);
    expect(entries[entries.length - 1]!.cycle).toBe(cB);

    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i]!.cycle - entries[i - 1]!.cycle).toBeLessThanOrEqual(20 + 1e-9);
    }
  });

  it('widening the cycle gap at a fixed per-cycle budget makes the walk longer', () => {
    const near = solveDailyPlan(validateDailyPlan(simpleDay([300, 200], [400, 250])), 10);
    const far = solveDailyPlan(validateDailyPlan(simpleDay([300, 200], [600, 250])), 10);
    const nearSteps = near.transitions[0]!.cycles.length - 1;
    const farSteps = far.transitions[0]!.cycles.length - 1;
    expect(farSteps).toBeGreaterThan(nearSteps);
    expect(near.transitions[0]!.status).toBe('feasible');
    expect(far.transitions[0]!.status).toBe('feasible');
  });

  it('recomputes each intermediate cycle green balance against ITS OWN cycle and the departing flows', () => {
    // A: Y=.75 C0=92 (Ccrit 40); B: Y=.60 C0=50; downward walk never approaches
    // A's critical cycle, so every walked length is genuinely serviceable.
    const parsed = validateDailyPlan(simpleDay([600, 150], [350, 250]));
    const solved = solveDailyPlan(parsed, 20);
    const t = solved.transitions[0]!;
    expect(t.status).toBe('feasible');
    expect(t.cycles.length).toBeGreaterThan(2);

    for (const entry of t.cycles) {
      expect(entry.status).toBe('ok');
      const r = entry.result!;

      // (a) strict green balance for THIS cycle length
      const sumG = r.phases.reduce((a, p) => a + p.g, 0);
      expect(Math.abs(sumG + r.lostTime - entry.cycle)).toBeLessThanOrEqual(BALANCE_TOLERANCE);
      expect(r.greenBalanceResidual).toBeLessThanOrEqual(BALANCE_TOLERANCE);

      // (b) not merely a pretty number list: an independent fresh solve at this
      //     cycle with the DEPARTING segment's flows reproduces the allocation
      const independent = solveTiming(
        segmentTimingInput(parsed, parsed.segments[0]!, entry.cycle),
      );
      expect(independent.cycle).toBeCloseTo(entry.cycle, 12);
      r.phases.forEach((p, i) => {
        expect(p.g).toBeCloseTo(independent.phases[i]!.g, 9);
        expect(p.lambda).toBeCloseTo(independent.phases[i]!.lambda, 12);
        expect(p.x).toBeCloseTo(independent.phases[i]!.x, 12);
        expect(p.x).toBeLessThan(1);
      });
    }

    // Final landed length is the arriving segment's optimal cycle.
    expect(t.cycles[t.cycles.length - 1]!.cycle).toBeCloseTo(
      solved.segments[1]!.result!.cycle,
      12,
    );
  });

  it('uses the departing flows (not the arriving ones): the final walk greens serve period A', () => {
    const parsed = validateDailyPlan(simpleDay([600, 150], [350, 250]));
    const solved = solveDailyPlan(parsed, 20);
    const last = solved.transitions[0]!.cycles.at(-1)!;
    // Same cycle length, but different demand => the walk carries A's flow,
    // so its lambdas must match an A solve and differ from B's own optimum.
    const withA = solveTiming(segmentTimingInput(parsed, parsed.segments[0]!, last.cycle));
    const withB = solveTiming(segmentTimingInput(parsed, parsed.segments[1]!, last.cycle));
    last.result!.phases.forEach((p, i) => {
      expect(p.lambda).toBeCloseTo(withA.phases[i]!.lambda, 12);
      expect(p.lambda).not.toBeCloseTo(withB.phases[i]!.lambda, 9);
    });
  });

  it('emits a one-cycle walk when adjacent periods share the same optimal cycle', () => {
    const parsed = validateDailyPlan(simpleDay([400, 200], [200, 400]));
    const solved = solveDailyPlan(parsed, 20);
    const t = solved.transitions[0]!;
    expect(solved.segments[0]!.result!.cycle).toBeCloseTo(solved.segments[1]!.result!.cycle, 9);
    expect(t.status).toBe('feasible');
    expect(t.cycles).toHaveLength(1);
  });
});

describe('infeasible transition walks', () => {
  // A heavy: y=(.7,.1) C0=100, phase1 protected with minGreen 15.
  // B light: y=(.55,.1) C0≈57.14 (its own optimum is feasible).
  // Under A's flows, once the cycle drops to where phase1 is pinned at 15 s,
  // phase0 needs lambda >= .7: that holds only while C >= 50/0.6 ≈ 83.33 s.
  const day = simpleDay([700, 100], [550, 100], { minGreen1: 15 });

  it('flags the walk infeasible at the interior step where a phase saturates, naming phase and step', () => {
    const parsed = validateDailyPlan(day);
    const solved = solveDailyPlan(parsed, 10);
    // 100 -> 90 -> 80 -> 70 -> 60 -> 57.14 ; 80 s is the first unservable cycle.
    const t = solved.transitions[0]!;
    expect(t.status).toBe('infeasible');

    const cycles = t.cycles;
    expect(cycles.map((c) => c.step)).toEqual([0, 1, 2]);
    [100, 90, 80].forEach((expected, i) =>
      expect(cycles[i]!.cycle).toBeCloseTo(expected, 9),
    );
    expect(cycles[0]!.status).toBe('ok');
    expect(cycles[1]!.status).toBe('ok');

    const broken = cycles[2]!;
    expect(broken.status).toBe('error');
    expect(broken.step).toBe(2);
    expect(broken.error!.code).toBe('PHASE_SATURATED');
    expect(broken.error!.details!.phaseIndex).toBe(0);
    expect(broken.error!.details!.segmentIndex).toBe(0);
  });

  it('the failing step moves with the step budget; feasibility never pretends past it', () => {
    const parsed = validateDailyPlan(day);

    const big = solveDailyPlan(parsed, 20).transitions[0]!; // 100 -> 80 -> 60 -> 57.14
    expect(big.status).toBe('infeasible');
    expect(big.cycles).toHaveLength(2);
    expect(big.cycles[0]!.cycle).toBeCloseTo(100, 9);
    expect(big.cycles[1]!.cycle).toBeCloseTo(80, 9);
    expect(big.cycles.at(-1)!.step).toBe(1);

    const small = solveDailyPlan(parsed, 5).transitions[0]!; // 5 s steps
    expect(small.status).toBe('infeasible');
    expect(small.cycles.at(-1)!.cycle).toBeCloseTo(80, 9);
    expect(small.cycles.at(-1)!.step).toBe(4);
    // No fabricated entries beyond the first failure.
    expect(small.cycles.length).toBe(5);
  });

  it('leaves neighbouring, well-behaved transitions feasible in a three-period plan', () => {
    const parsed = validateDailyPlan({
      lostTime: 10,
      phases: [
        { s: 1000 },
        { s: 1000, minGreen: 15 },
      ],
      segments: [
        { start: '00:00', end: '08:00', label: 'heavy', flows: [700, 100] },
        { start: '08:00', end: '16:00', label: 'light', flows: [550, 100] },
        { start: '16:00', end: '24:00', label: 'busty', flows: [600, 100] },
      ],
    });
    const solved = solveDailyPlan(parsed, 10);
    expect(solved.segments.every((s) => s.status === 'ok')).toBe(true);
    expect(solved.transitions[0]!.status).toBe('infeasible');
    expect(solved.transitions[1]!.status).toBe('feasible');
    // The feasible upward walk still closes both identities at every cycle.
    for (const entry of solved.transitions[1]!.cycles) {
      const sumG = entry.result!.phases.reduce((a, p) => a + p.g, 0);
      expect(Math.abs(sumG + 10 - entry.cycle)).toBeLessThanOrEqual(BALANCE_TOLERANCE);
    }
  });
});
