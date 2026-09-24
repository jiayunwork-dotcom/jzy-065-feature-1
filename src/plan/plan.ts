import { TimingError } from '../domain/errors';
import type {
  DayPlanResult,
  PeriodPlanResult,
  TimingResult,
  TransitionResult,
} from '../domain/types';
import type { ParsedPhase, ParsedTimingInput } from '../domain/validation';
import { solveParsed } from '../timing/timing';
import { buildTransition } from '../transition/transition';
import type { ParsedDayPlan, ParsedPeriod } from './validation';

/**
 * Solve a whole day plan.
 *
 * Each period is solved independently through the same Webster chain used for
 * single-instant timing, with the plan-level lost time and channelization and
 * the period's own arrival flows. A period whose traffic is infeasible is
 * marked 'error' with the structured reason (which period, which phase) — it
 * does NOT poison the rest of the plan.
 *
 * Afterwards every adjacent pair of periods gets a cycle-length transition
 * path (see src/transition). For n >= 2 periods there are exactly n
 * transitions: periods[i] -> periods[i+1], and the last one crosses midnight
 * from the final period back to the first, because the plan repeats daily.
 */
export function solveDayPlan(plan: ParsedDayPlan, maxCycleStep: number): DayPlanResult {
  const solved = plan.periods.map((period) => ({
    period,
    phases: buildPeriodPhases(plan, period),
    result: solvePeriod(plan, period),
  }));

  const periods: PeriodPlanResult[] = solved.map(({ period, result }) => {
    const base = {
      index: period.index,
      start: period.start,
      end: period.end,
      label: period.label,
    };
    if (result.ok) {
      return { ...base, status: 'ok', timing: result.timing };
    }
    return { ...base, status: 'error', error: result.error };
  });

  const transitions: TransitionResult[] = [];
  if (solved.length > 1) {
    for (let i = 0; i < solved.length; i += 1) {
      const from = solved[i]!;
      const to = solved[(i + 1) % solved.length]!;
      transitions.push(buildPeriodTransition(plan, maxCycleStep, from, to));
    }
  }

  return { lostTime: plan.lostTime, maxCycleStep, periods, transitions };
}

interface SolvedPeriod {
  period: ParsedPeriod;
  /** the period's phases in ParsedTimingInput shape (its own q, shared s/minGreen) */
  phases: ParsedPhase[];
  result:
    | { ok: true; timing: TimingResult }
    | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };
}

function buildPeriodPhases(plan: ParsedDayPlan, period: ParsedPeriod): ParsedPhase[] {
  return plan.phases.map((p, i) => ({
    q: period.q[i]!,
    s: p.s,
    minGreen: p.minGreen,
    label: p.label,
  }));
}

function solvePeriod(plan: ParsedDayPlan, period: ParsedPeriod): SolvedPeriod['result'] {
  const input: ParsedTimingInput = {
    phases: buildPeriodPhases(plan, period),
    lostTime: plan.lostTime,
    cycle: null,
  };
  try {
    return { ok: true, timing: solveParsed(input) };
  } catch (err) {
    if (err instanceof TimingError) {
      return {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      };
    }
    throw err;
  }
}

function buildPeriodTransition(
  plan: ParsedDayPlan,
  maxCycleStep: number,
  from: SolvedPeriod,
  to: SolvedPeriod,
): TransitionResult {
  const base = {
    fromPeriod: from.period.index,
    toPeriod: to.period.index,
    maxStep: maxCycleStep,
    flowBasis: 'target' as const,
  };
  if (!from.result.ok || !to.result.ok) {
    const broken = [
      ...(!from.result.ok ? [describeBroken(from)] : []),
      ...(!to.result.ok ? [describeBroken(to)] : []),
    ];
    return {
      ...base,
      fromCycle: null,
      toCycle: null,
      status: 'unavailable',
      steps: null,
      cycles: [],
      reason: `no transition: ${broken.join('; ')}`,
    };
  }
  return buildTransition({
    fromPeriod: from.period.index,
    toPeriod: to.period.index,
    fromCycle: from.result.timing.cycle,
    toCycle: to.result.timing.cycle,
    startTiming: from.result.timing,
    targetPhases: to.phases,
    lostTime: plan.lostTime,
    maxStep: maxCycleStep,
  });
}

function describeBroken(p: SolvedPeriod): string {
  const err = p.result.ok ? null : p.result.error;
  return `period ${p.period.index} has no solution (${err?.code ?? 'unknown'})`;
}
