import { TimingError } from '../domain/errors';
import { X_EPSILON } from '../domain/constants';

/**
 * Degree of saturation x = q / (lambda * s) = (q/s) / lambda = y / lambda.
 * A zero-flow phase is never saturated (x := 0) even when it receives no green.
 */
export function degreeOfSaturation(y: number, lambda: number): number {
  if (y === 0) return 0;
  return y / lambda;
}

/**
 * Per-phase saturation guard. Even with Y < 1 a short cycle (or green stolen
 * by other phases / minimum greens) can push an individual phase to x >= 1.
 * That phase is reported specifically rather than producing a non-physical
 * delay (the Webster denominator 1 - lambda*x would go negative).
 */
export function assertPhaseWithinCapacity(
  phaseIndex: number,
  x: number,
  context: { y: number; lambda: number; cycle: number; label: string | null },
): void {
  if (x >= 1 - X_EPSILON) {
    throw new TimingError(
      'PHASE_SATURATED',
      `phase ${phaseIndex} is saturated: x=${x} at cycle ${context.cycle}s (lambda=${context.lambda}, y=${context.y})`,
      {
        phaseIndex,
        label: context.label,
        x,
        lambda: context.lambda,
        y: context.y,
        cycle: context.cycle,
      },
    );
  }
}

/**
 * Webster uniform (first-term) delay, seconds per vehicle:
 *
 *   d = 0.5 * C * (1 - lambda)^2 / (1 - lambda * x)
 *
 * Callers must already have rejected x >= 1 so the denominator stays positive.
 */
export function uniformDelay(cycle: number, lambda: number, x: number): number {
  const denom = 1 - lambda * x;
  return (0.5 * cycle * (1 - lambda) ** 2) / denom;
}
