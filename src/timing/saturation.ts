import { TimingError } from '../domain/errors';
import { OVERSATURATION_Y_LIMIT, OVERSATURATION_MARGIN } from '../domain/constants';

/**
 * Intersection-level saturation guard.
 *
 * When Y >= 1 - margin (0.99 by default) the Webster optimal cycle tends to
 * infinity. This must be decided *before* solving, on both timing paths
 * (optimal and caller-specified cycle): no negative or giant fake cycle and
 * no downstream delays may be produced. The computed Y is attached so the
 * caller can see how close to the edge they are.
 */
export function assertIntersectionCapacity(Y: number): void {
  if (Y >= OVERSATURATION_Y_LIMIT) {
    throw new TimingError(
      'OVERSATURATED_Y',
      `oversaturated intersection: Y=${Y} is at/within ${OVERSATURATION_MARGIN} of 1; no finite optimal cycle exists`,
      { Y, limit: OVERSATURATION_Y_LIMIT, margin: OVERSATURATION_MARGIN },
    );
  }
  if (Y <= 0) {
    throw new TimingError(
      'ZERO_FLOW',
      'total flow ratio Y is zero: no arrival flow on any phase; nothing to time',
      { Y },
    );
  }
}
