import { TimingError } from '../domain/errors';
import { OVERSATURATION_Y_LIMIT } from '../domain/constants';

/**
 * Webster optimal cycle length (seconds):
 *
 *   C0 = (1.5 L + 5) / (1 - Y)
 *
 * Oversaturation is rejected *before* this is ever called: when Y is at or
 * within 0.01 of 1 the optimum tends to infinity, and returning a negative or
 * multi-thousand-second "cycle" would be physically meaningless.
 */
export function websterOptimalCycle(Y: number, lostTime: number): number {
  if (Y >= OVERSATURATION_Y_LIMIT) {
    throw new TimingError(
      'OVERSATURATED_Y',
      `total flow ratio Y=${Y} is at/within ${0.01} of 1; Webster optimum diverges`,
      { Y, limit: OVERSATURATION_Y_LIMIT },
    );
  }
  const c0 = (1.5 * lostTime + 5) / (1 - Y);
  if (!Number.isFinite(c0) || c0 <= 0) {
    // Defence in depth — the guard above should make this unreachable.
    throw new TimingError(
      'OVERSATURATED_Y',
      'optimal cycle is not a positive finite number',
      { Y, optimalCycle: c0 },
    );
  }
  return c0;
}

/**
 * Smallest cycle at which every phase can carry its flow: Ccrit = L / (1 - Y).
 * Below it at least one phase's degree of saturation reaches 1.
 */
export function criticalCycle(Y: number, lostTime: number): number {
  return lostTime / (1 - Y);
}
