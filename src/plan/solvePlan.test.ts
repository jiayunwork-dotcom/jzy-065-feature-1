import { describe, expect, it } from 'vitest';
import { validateDailyPlan } from './planValidation';
import { solveDailyPlan, segmentTimingInput } from './solvePlan';
import { solveTiming } from '../timing/timing';
import { BALANCE_TOLERANCE } from '../domain/constants';
import type { DailyPlanInput } from '../domain/types';

const phases = [
  { s: 1000, label: 'P0' },
  { s: 1000, label: 'P1' },
  { s: 1000, label: 'P2' },
];

function plan(segments: Array<[string, string, number[]]>, lostTime = 10): DailyPlanInput {
  return {
    lostTime,
    phases,
    segments: segments.map(([start, end, flows]) => ({ start, end, flows })),
  };
}

describe('per-segment independent solving', () => {
  it('solves every segment independently through the same Webster chain, in clock order', () => {
    const input = plan([
      ['00:00', '08:00', [100, 200, 150]],
      ['08:00', '16:00', [600, 200, 100]],
      ['16:00', '24:00', [300, 300, 50]],
    ]);
    const parsed = validateDailyPlan(input);
    const solved = solveDailyPlan(parsed, 20);

    expect(solved.segments).toHaveLength(3);
    solved.segments.forEach((seg, i) => {
      expect(seg.start).toBe(['00:00', '08:00', '16:00'][i]);
      expect(seg.end).toBe(['08:00', '16:00', '24:00'][i]);
      expect(seg.status).toBe('ok');
      // Independent recomputation via the single-case chain must agree.
      const standalone = solveTiming(segmentTimingInput(parsed, parsed.segments[i]!));
      expect(seg.result!.cycle).toBeCloseTo(standalone.cycle, 9);
      expect(seg.result!.Y).toBeCloseTo(standalone.Y, 12);
      expect(seg.result!.totalDelayRate).toBeCloseTo(standalone.totalDelayRate, 6);
    });
  });

  it('raising arrival flows in ONE segment raises its cycle and delay; the others are untouched', () => {
    const base = plan([
      ['00:00', '08:00', [300, 200, 100]],
      ['08:00', '16:00', [300, 200, 100]],
      ['16:00', '24:00', [300, 200, 100]],
    ]);
    const before = solveDailyPlan(validateDailyPlan(base), 20);

    const changed = plan([
      ['00:00', '08:00', [300, 200, 100]],
      ['08:00', '16:00', [550, 250, 100]], // middle period busier
      ['16:00', '24:00', [300, 200, 100]],
    ]);
    const after = solveDailyPlan(validateDailyPlan(changed), 20);

    const midBefore = before.segments[1]!.result!;
    const midAfter = after.segments[1]!.result!;
    expect(midAfter.Y).toBeGreaterThan(midBefore.Y);
    expect(midAfter.optimalCycle).toBeGreaterThan(midBefore.optimalCycle);
    expect(midAfter.totalDelayRate).toBeGreaterThan(midBefore.totalDelayRate);

    // Neighbouring segments: bit-for-bit identical, not even a rounding wobble.
    expect(after.segments[0]!.result!.cycle).toBe(before.segments[0]!.result!.cycle);
    expect(after.segments[2]!.result!.cycle).toBe(before.segments[2]!.result!.cycle);
    expect(after.segments[0]!.result!.totalDelayRate).toBe(
      before.segments[0]!.result!.totalDelayRate,
    );
    expect(after.segments[2]!.result!.totalDelayRate).toBe(
      before.segments[2]!.result!.totalDelayRate,
    );
  });

  it('marks an OVERSATURATED segment (which period, which flows) but still solves the rest', () => {
    const input = plan([
      ['00:00', '08:00', [300, 200, 100]], // healthy
      ['08:00', '16:00', [990, 5, 0]], // Y = 0.995 -> rejected
      ['16:00', '24:00', [150, 150, 150]], // healthy
    ]);
    const solved = solveDailyPlan(validateDailyPlan(input), 20);

    expect(solved.segments[0]!.status).toBe('ok');
    expect(solved.segments[2]!.status).toBe('ok');

    const bad = solved.segments[1]!;
    expect(bad.status).toBe('error');
    expect(bad.error!.code).toBe('OVERSATURATED_Y');
    expect(bad.error!.details!.segmentIndex).toBe(1);
    expect(bad.error!.details!.Y).toBeCloseTo(0.995, 10);
    expect(bad.result).toBeUndefined();
  });

  it('marks a zero-flow segment with ZERO_FLOW locally instead of crashing the day', () => {
    const input = plan([
      ['00:00', '06:00', [0, 0, 0]],
      ['06:00', '24:00', [300, 200, 100]],
    ]);
    const solved = solveDailyPlan(validateDailyPlan(input), 20);
    expect(solved.segments[0]!.status).toBe('error');
    expect(solved.segments[0]!.error!.code).toBe('ZERO_FLOW');
    expect(solved.segments[1]!.status).toBe('ok');
  });

  it('skips the transitions touching a broken segment while the other pair is walked', () => {
    const input = plan([
      ['00:00', '08:00', [300, 200, 100]],
      ['08:00', '16:00', [990, 5, 0]], // oversaturated
      ['16:00', '24:00', [150, 150, 150]],
    ]);
    const solved = solveDailyPlan(validateDailyPlan(input), 20);
    expect(solved.transitions).toHaveLength(2);
    expect(solved.transitions[0]!.status).toBe('skipped');
    expect(solved.transitions[1]!.status).toBe('skipped');
    expect(solved.transitions[0]!.cycles).toEqual([]);
  });

  it('echoes the per-segment green balance identity even across very different demands', () => {
    const input = plan([
      ['00:00', '06:00', [60, 40, 20]],
      ['06:00', '10:00', [700, 150, 100]],
      ['10:00', '24:00', [200, 400, 300]],
    ]);
    const solved = solveDailyPlan(validateDailyPlan(input), 20);
    for (const seg of solved.segments) {
      const r = seg.result!;
      const sumG = r.phases.reduce((a, p) => a + p.g, 0);
      expect(Math.abs(sumG + r.lostTime - r.cycle)).toBeLessThanOrEqual(BALANCE_TOLERANCE);
    }
  });
});
