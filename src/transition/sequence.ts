import { TimingError } from '../domain/errors';
import { isFiniteNumber } from '../domain/constants';

/**
 * Safety ceiling on the number of transition cycles generated for one pair
 * of segments. Without it, a tiny adjustment against a huge cycle gap would
 * allocate an unbounded array; real controllers transition over a handful of
 * cycles, so a five-figure walk is a misconfigured request, not a plan.
 */
export const MAX_TRANSITION_STEPS = 10_000;

export interface CycleWalk {
  /**
   * Strictly monotone cycle walk [from, ..., target]:
   * every adjacent change is in one direction, no change exceeds
   * `maxAdjustment`, and the last value equals `target` exactly.
   */
  cycles: number[];
  /** number of steps (changes); cycles.length - 1 */
  steps: number;
}

/**
 * Generate the shortest strictly monotone walk from `fromCycle` to
 * `targetCycle` that moves at most `maxAdjustment` per step and lands on the
 * target EXACTLY with the final step — no overshooting and turning back.
 *
 * Minimum steps n = ceil(|target - from| / maxAdjustment). Every step except
 * the last takes the full allowed budget towards the target; the last closes
 * the remaining gap. This gives the fewest steps, keeps the walk strictly
 * monotone, and keeps the final landing exact in floating point by writing
 * the target literal rather than accumulating deltas.
 *
 * Equal endpoints yield the single-element walk [from].
 */
export function cycleSequence(
  fromCycle: number,
  targetCycle: number,
  maxAdjustment: number,
): CycleWalk {
  if (![fromCycle, targetCycle, maxAdjustment].every(isFiniteNumber)) {
    throw new TimingError('INVALID_CYCLE_ADJUSTMENT', 'cycle walk inputs must all be finite numbers', {
      fromCycle,
      targetCycle,
      maxAdjustment,
    });
  }
  if (maxAdjustment <= 0) {
    throw new TimingError(
      'INVALID_CYCLE_ADJUSTMENT',
      'maxCycleAdjustment must be positive',
      { maxAdjustment },
    );
  }
  if (fromCycle <= 0 || targetCycle <= 0) {
    throw new TimingError('INVALID_CYCLE', 'cycle lengths must be positive', {
      fromCycle,
      targetCycle,
    });
  }

  const gap = targetCycle - fromCycle;
  if (gap === 0) {
    return { cycles: [fromCycle], steps: 0 };
  }

  const steps = Math.ceil(Math.abs(gap) / maxAdjustment - 1e-12);
  if (steps > MAX_TRANSITION_STEPS) {
    throw new TimingError(
      'TRANSITION_TOO_MANY_STEPS',
      `transition from ${fromCycle}s to ${targetCycle}s with at most ${maxAdjustment}s/cycle needs ${steps} steps (limit ${MAX_TRANSITION_STEPS})`,
      { fromCycle, targetCycle, maxAdjustment, steps, limit: MAX_TRANSITION_STEPS },
    );
  }

  const direction = Math.sign(gap);
  const cycles: number[] = [fromCycle];
  for (let step = 1; step < steps; step += 1) {
    cycles.push(fromCycle + direction * maxAdjustment * step);
  }
  // The last entry is the target literal: exact landing, never an accumulated
  // float that could miss by an epsilon and never an overshoot.
  cycles.push(targetCycle);
  return { cycles, steps };
}
