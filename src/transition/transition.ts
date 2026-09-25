import type {
  ParsedDailyPlan,
  SolvedSegment,
  TransitionCycleEntry,
  TransitionResult,
} from '../domain/types';
import { TimingError } from '../domain/errors';
import { normalizeTimingInput } from '../domain/validation';
import { solveParsed } from '../timing/timing';
import { segmentTimingInput } from '../plan/solvePlan';
import { cycleSequence } from './sequence';

/**
 * A cycle at an intermediate length is itself rejected for the same physics
 * reasons that mark a scan point infeasible: it fails to carry the flows it
 * must serve. Such a failure makes the whole transition infeasible.
 */
const PER_CYCLE_ERRORS = new Set([
  'CYCLE_TOO_SHORT',
  'PHASE_SATURATED',
  'MIN_GREEN_INFEASIBLE',
]);

export interface BuildTransitionsInput {
  plan: ParsedDailyPlan;
  segments: SolvedSegment[];
  maxAdjustment: number;
}

/**
 * Build the transition walk for every pair of adjacent segments.
 *
 * WHICH DEMAND ARE THE TRANSITION CYCLES TIMED AGAINST — THE DEPARTING SEGMENT
 *
 * The walk is executed in the tail of the departing ("from") period, one
 * shortened/lengthened cycle at a time, arriving at the new cycle length
 * exactly on the time-of-day boundary. During those cycles the vehicles on
 * the approaches are still the departing period's arrivals — the new pattern
 * has not begun. Every intermediate cycle is therefore solved fresh with the
 * DEPARTING segment's arrival rates: its green split is re-allocated for its
 * own length and every phase must stay below saturation under that demand.
 * This is the conservative direction at the dangerous boundary: leaving a
 * heavy period, shortening cycles while its queue may still be arriving is
 * exactly where a naive walk produces an unserviceable cycle. The final
 * walked cycle equals the target period's cycle length; at the boundary the
 * pattern then switches to the arriving segment's flows on the first full
 * cycle of its own length.
 */
export function buildTransitions(input: BuildTransitionsInput): TransitionResult[] {
  const { plan, segments, maxAdjustment } = input;
  const transitions: TransitionResult[] = [];

  for (let i = 0; i < segments.length - 1; i += 1) {
    transitions.push(buildOneTransition(plan, segments, i, i + 1, maxAdjustment));
  }
  return transitions;
}

function buildOneTransition(
  plan: ParsedDailyPlan,
  segments: SolvedSegment[],
  fromIndex: number,
  toIndex: number,
  maxAdjustment: number,
): TransitionResult {
  const from = segments[fromIndex]!;
  const to = segments[toIndex]!;
  const fromCycle = from.status === 'ok' ? from.result!.cycle : NaN;
  const toCycle = to.status === 'ok' ? to.result!.cycle : NaN;

  const base: TransitionResult = {
    fromSegment: fromIndex,
    toSegment: toIndex,
    fromCycle,
    toCycle,
    maxAdjustment,
    status: 'skipped',
    cycles: [],
  };

  if (from.status !== 'ok' || to.status !== 'ok') {
    const bad = from.status !== 'ok' ? fromIndex : toIndex;
    return { ...base, reason: `segment ${bad} does not solve; no transition walk is generated` };
  }

  const { cycles } = cycleSequence(fromCycle, toCycle, maxAdjustment);
  const entries: TransitionCycleEntry[] = [];

  for (let step = 0; step < cycles.length; step += 1) {
    const cycle = cycles[step]!;
    // FRESH solve: this cycle's own green allocation under the departing
    // segment's flows — never the optimal split reused at a new length.
    const parsed = normalizeTimingInput(
      segmentTimingInput(plan, plan.segments[fromIndex]!, cycle),
    );
    try {
      const result = solveParsed(parsed);
      entries.push({ step, cycle, status: 'ok', result });
    } catch (err) {
      if (err instanceof TimingError && PER_CYCLE_ERRORS.has(err.code)) {
        entries.push({
          step,
          cycle,
          status: 'error',
          error: {
            code: err.code,
            message: err.message,
            details: { ...(err.details ?? {}), segmentIndex: fromIndex, step, cycle },
          },
        });
        // The walk ends at the first cycle that cannot carry the demand;
        // later steps are not pretended through.
        return { ...base, status: 'infeasible', cycles: entries };
      }
      throw err;
    }
  }

  return { ...base, status: 'feasible', cycles: entries };
}
