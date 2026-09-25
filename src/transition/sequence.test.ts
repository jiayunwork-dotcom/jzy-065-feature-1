import { describe, expect, it } from 'vitest';
import { cycleSequence, MAX_TRANSITION_STEPS } from './sequence';
import { TimingError } from '../domain/errors';

/**
 * The cycle walk is pure arithmetic: it must not know anything about flow
 * ratios or green splits. Physics for each walked cycle lives in
 * src/transition/transition.ts and is tested separately.
 */
describe('cycle transition sequence', () => {
  it('walks up monotonically in minimum steps with the last step landing exactly on target', () => {
    const { cycles, steps } = cycleSequence(60, 105, 15);
    expect(cycles).toEqual([60, 75, 90, 105]);
    expect(steps).toBe(3);
    for (let i = 1; i < cycles.length; i += 1) {
      expect(cycles[i]! - cycles[i - 1]!).toBeLessThanOrEqual(15);
      expect(cycles[i]).toBeGreaterThan(cycles[i - 1]!);
    }
    expect(cycles[cycles.length - 1]).toBe(105);
  });

  it('walks down monotonically, never overshooting and turning back', () => {
    const { cycles, steps } = cycleSequence(120, 70, 20);
    expect(cycles).toEqual([120, 100, 80, 70]);
    expect(steps).toBe(3);
    for (let i = 1; i < cycles.length; i += 1) {
      expect(cycles[i - 1]! - cycles[i]!).toBeLessThanOrEqual(20);
      expect(cycles[i]).toBeLessThan(cycles[i - 1]!);
    }
    // The minimum of the walk is the target itself: no value crossed past it.
    expect(Math.min(...cycles)).toBe(70);
  });

  it('uses a shorter final step when the gap is not a multiple of the budget', () => {
    // gap 35 with budget 20: n = ceil(35/20) = 2; final step is 15, exact.
    const { cycles, steps } = cycleSequence(50, 85, 20);
    expect(steps).toBe(2);
    expect(cycles[0]).toBe(50);
    expect(cycles[1]! - cycles[0]!).toBeLessThanOrEqual(20);
    expect(cycles[2]).toBe(85);
    expect(Math.abs(cycles[cycles.length - 1]! - 85)).toBe(0);
  });

  it('lengthening the cycle gap at a fixed step budget produces more steps', () => {
    const near = cycleSequence(60, 100, 10);
    const far = cycleSequence(60, 200, 10);
    expect(far.steps).toBeGreaterThan(near.steps);
    expect(near.steps).toBe(4); // 40/10
    expect(far.steps).toBe(14); // 140/10
  });

  it('returns the single-cycle walk when start equals target', () => {
    const { cycles, steps } = cycleSequence(77, 77, 10);
    expect(cycles).toEqual([77]);
    expect(steps).toBe(0);
  });

  it('is robust for fractional inputs: endpoints match the inputs bit-for-bit', () => {
    const from = 76.66666666666667;
    const target = 44.44444444444444;
    const { cycles } = cycleSequence(from, target, 20);
    expect(cycles[0]).toBe(from);
    expect(cycles[cycles.length - 1]).toBe(target);
    for (let i = 1; i < cycles.length; i += 1) {
      expect(Math.abs(cycles[i]! - cycles[i - 1]!)).toBeLessThanOrEqual(20 + 1e-9);
    }
  });

  it('rejects non-positive budgets, cycles and non-finite inputs', () => {
    expect(() => cycleSequence(60, 100, 0)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CYCLE_ADJUSTMENT' }),
    );
    expect(() => cycleSequence(60, 100, -5)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CYCLE_ADJUSTMENT' }),
    );
    expect(() => cycleSequence(-60, 100, 10)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CYCLE' }),
    );
    expect(() => cycleSequence(60, NaN, 10)).toThrowError(TimingError);
  });

  it('caps absurdly long walks instead of building an unbounded array', () => {
    expect(() => cycleSequence(1, 1 + (MAX_TRANSITION_STEPS + 10) * 0.001, 0.001)).toThrowError(
      expect.objectContaining({ code: 'TRANSITION_TOO_MANY_STEPS' }),
    );
  });
});
