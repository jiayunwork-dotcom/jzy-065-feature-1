import type {
  ParsedDailyPlan,
  ParsedPlanSegment,
  SolvedDailyPlan,
  SolvedSegment,
  TimingResult,
} from '../domain/types';
import { TimingError } from '../domain/errors';
import { normalizeTimingInput } from '../domain/validation';
import { solveParsed } from '../timing/timing';
import { formatClock } from './planValidation';
import { buildTransitions } from '../transition/transition';

/**
 * Physics-level failures that belong to ONE segment's demand rather than to
 * the plan structure. Such a segment is reported with `status: "error"` and
 * the rest of the day still solves — one bad period never scraps the plan.
 */
const PER_SEGMENT_ERRORS = new Set([
  'OVERSATURATED_Y',
  'ZERO_FLOW',
  'PHASE_SATURATED',
  'CYCLE_TOO_SHORT',
  'MIN_GREEN_INFEASIBLE',
]);

/** Build the single-case timing input for one segment: day geometry + its q. */
export function segmentTimingInput(
  plan: ParsedDailyPlan,
  segment: ParsedPlanSegment,
  cycle?: number,
): Parameters<typeof normalizeTimingInput>[0] {
  return {
    lostTime: plan.lostTime,
    ...(cycle !== undefined ? { cycle } : {}),
    phases: plan.phases.map((p, i) => ({
      q: segment.flows[i]!,
      s: p.s,
      ...(p.minGreen !== null ? { minGreen: p.minGreen } : {}),
      ...(p.label !== null ? { label: p.label } : {}),
    })),
  };
}

/**
 * Solve one segment independently through the existing Webster chain.
 * Errors local to this segment's physics are caught and reported; structural
 * or internal errors propagate (they indicate a bad request or a code bug).
 */
export function solveSegment(
  plan: ParsedDailyPlan,
  index: number,
  segment: ParsedPlanSegment,
): { status: 'ok'; result: TimingResult } | { status: 'error'; error: SolvedSegment['error'] } {
  try {
    const parsed = normalizeTimingInput(segmentTimingInput(plan, segment));
    return { status: 'ok', result: solveParsed(parsed) };
  } catch (err) {
    if (err instanceof TimingError && PER_SEGMENT_ERRORS.has(err.code)) {
      return {
        status: 'error',
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: { ...err.details, segmentIndex: index } } : { details: { segmentIndex: index } }),
        },
      };
    }
    throw err;
  }
}

/**
 * Solve a full day: each segment independently, then the transition walk for
 * every adjacent pair. Segment problems stay local; a neighbour of a broken
 * segment simply skips its transition.
 */
export function solveDailyPlan(
  plan: ParsedDailyPlan,
  maxAdjustment: number,
): SolvedDailyPlan {
  const segments: SolvedSegment[] = plan.segments.map((segment, index) => {
    const solved = solveSegment(plan, index, segment);
    const base: SolvedSegment = {
      index,
      start: formatClock(segment.startMinute),
      end: formatClock(segment.endMinute),
      label: segment.label,
      status: solved.status,
    };
    if (solved.status === 'ok') {
      base.result = solved.result;
    } else {
      base.error = solved.error;
    }
    return base;
  });

  const transitions = buildTransitions({ plan, segments, maxAdjustment });

  return {
    lostTime: plan.lostTime,
    maxAdjustment,
    segments,
    transitions,
  };
}
