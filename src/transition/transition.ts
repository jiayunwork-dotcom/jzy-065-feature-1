import { TimingError } from '../domain/errors';
import { TRANSITION_STEP_EPSILON } from '../domain/constants';
import type {
  TimingResult,
  TransitionCycleView,
  TransitionFailure,
  TransitionResult,
} from '../domain/types';
import type { ParsedPhase, ParsedTimingInput } from '../domain/validation';
import { solveParsed } from '../timing/timing';

export interface TransitionRequest {
  fromPeriod: number;
  toPeriod: number;
  /** cycle the departing period is running, seconds */
  fromCycle: number;
  /** cycle the arriving period wants to run, seconds */
  toCycle: number;
  /** departing period's own solved timing (reused as path element 0) */
  startTiming: TimingResult;
  /** arriving period's phases — the demand the transition cycles must serve */
  targetPhases: ParsedPhase[];
  lostTime: number;
  /** maximum cycle-length change allowed per cycle, seconds (> 0) */
  maxStep: number;
}

/**
 * Walk the cycle length from one period's optimum to the next period's.
 *
 * A field controller cannot snap a running 110 s cycle down to 70 s between
 * one cycle and the next — that would amputate a phase's green mid-service.
 * Instead the cycle is moved in bounded steps: from `fromCycle`, each new
 * cycle may differ by at most `maxStep` seconds, marching monotonically until
 * it lands EXACTLY on `toCycle` (the last step takes whatever remainder is
 * left; it never overshoots and comes back). The number of steps is the
 * minimum possible: ceil(|toCycle - fromCycle| / maxStep).
 *
 * Every transition cycle is a real timing, not just a number: it is solved
 * fresh at its own cycle length, so the green balance sum(g)+L === C holds by
 * construction and per-phase saturation is checked. The demand used for these
 * solves is the ARRIVING period's (`flowBasis: 'target'`): the controller runs
 * the transition at the start of the new period, so each intermediate cycle
 * must stand up under the demand it is transitioning into. If some
 * intermediate cycle cannot serve that demand, the walk stops there and the
 * transition is reported infeasible with the exact step, cycle and phase that
 * broke — never a silently non-physical sequence.
 */
export function buildTransition(req: TransitionRequest): TransitionResult {
  const { fromPeriod, toPeriod, fromCycle, toCycle, startTiming, maxStep } = req;
  const base = {
    fromPeriod,
    toPeriod,
    fromCycle,
    toCycle,
    maxStep,
    flowBasis: 'target' as const,
  };

  const distance = Math.abs(toCycle - fromCycle);
  const steps =
    distance <= TRANSITION_STEP_EPSILON
      ? 0
      : Math.max(1, Math.ceil(distance / maxStep - TRANSITION_STEP_EPSILON));

  const startView: TransitionCycleView = {
    step: 0,
    role: 'start',
    cycle: fromCycle,
    timing: startTiming,
  };
  if (steps === 0) {
    return { ...base, status: 'feasible', steps, cycles: [startView] };
  }

  const direction = Math.sign(toCycle - fromCycle);
  const cycles: TransitionCycleView[] = [startView];

  for (let k = 1; k <= steps; k += 1) {
    // Intermediate steps move exactly maxStep; the final step lands exactly on
    // the target cycle (never overshoots: (steps-1)*maxStep < distance).
    const cycle = k === steps ? toCycle : fromCycle + direction * k * maxStep;
    const input: ParsedTimingInput = {
      phases: req.targetPhases,
      lostTime: req.lostTime,
      cycle,
    };
    let timing: TimingResult;
    try {
      timing = solveParsed(input);
    } catch (err) {
      if (err instanceof TimingError) {
        return {
          ...base,
          status: 'infeasible',
          steps,
          cycles,
          failure: toFailure(k, cycle, err),
        };
      }
      throw err;
    }
    cycles.push({ step: k, role: 'transition', cycle, timing });
  }

  return { ...base, status: 'feasible', steps, cycles };
}

function toFailure(step: number, cycle: number, err: TimingError): TransitionFailure {
  const details = err.details ?? {};
  const phaseIndex = details.phaseIndex;
  const label = details.label;
  return {
    step,
    cycle,
    code: err.code,
    message: err.message,
    ...(typeof phaseIndex === 'number' ? { phaseIndex } : {}),
    ...(typeof label === 'string' || label === null ? { label: label as string | null } : {}),
  };
}
