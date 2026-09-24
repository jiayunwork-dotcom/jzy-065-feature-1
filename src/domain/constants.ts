/**
 * Numerical thresholds used across the timing chain.
 */

/** sum(g)+L must equal the used cycle within this absolute residual (seconds) */
export const BALANCE_TOLERANCE = 1e-9;

/**
 * Overall oversaturation margin: when Y >= 1 - OVERSATURATION_MARGIN the Webster
 * optimum tends to infinity, so the service refuses *before* solving.
 */
export const OVERSATURATION_MARGIN = 0.01;
export const OVERSATURATION_Y_LIMIT = 1 - OVERSATURATION_MARGIN; // 0.99

/**
 * Per-phase saturation guard: x = q/(lambda*s) at/above 1 - X_EPSILON is treated
 * as saturated (the epsilon absorbs floating-point noise at the exact boundary).
 */
export const X_EPSILON = 1e-9;

/** Minutes in a day; time-of-day plan periods are expressed in minutes after midnight. */
export const DAY_MINUTES = 24 * 60;

/**
 * Default per-cycle step (seconds) a controller may move the cycle length by
 * when transitioning between two adjacent time-of-day periods.
 */
export const DEFAULT_MAX_CYCLE_STEP = 10;

/**
 * Epsilon for the transition step-count computation: absorbs floating-point
 * noise when |toCycle - fromCycle| is an exact multiple of the max step.
 */
export const TRANSITION_STEP_EPSILON = 1e-9;

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
