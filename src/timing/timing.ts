import type { TimingInput, TimingResult, TimingPhaseResult } from '../domain/types';
import { TimingError } from '../domain/errors';
import { normalizeTimingInput, type ParsedTimingInput } from '../domain/validation';
import { computeFlowRatios } from './flowRatios';
import { websterOptimalCycle } from './cycle';
import { allocateGreens } from './greenSplit';
import {
  degreeOfSaturation,
  assertPhaseWithinCapacity,
  uniformDelay,
} from './delay';
import { assertIntersectionCapacity } from './saturation';

/**
 * Run the full Webster chain for one timing case:
 *
 *   y = q/s -> Y -> C0 (or given C) -> g split -> lambda, x -> d
 *
 * The single `phases` array is the only source of arrival rates: the same q
 * feeds flow ratios, saturation and delay. Feeding the timing split one set
 * of q and the delay formula another set is the most subtle bug here, so the
 * structure deliberately makes that impossible.
 */
export function solveTiming(input: TimingInput): TimingResult {
  return solveParsed(normalizeTimingInput(input));
}

export function solveParsed(parsed: ParsedTimingInput): TimingResult {
  const { phases, lostTime, cycle: specifiedCycle } = parsed;

  const flow = computeFlowRatios(phases);
  const Y = flow.Y;

  // Intersection-level guard runs before the cycle formula.
  assertIntersectionCapacity(Y);

  const optimalCycle = websterOptimalCycle(Y, lostTime);
  const cycle = specifiedCycle ?? optimalCycle;
  const cycleSpecified = specifiedCycle !== null;

  if (cycle <= lostTime) {
    const usable = cycle - lostTime;
    throw new TimingError(
      'CYCLE_TOO_SHORT',
      `cycle ${cycle}s must strictly exceed total lost time ${lostTime}s (usable green ${usable}s)`,
      { cycle, lostTime },
    );
  }

  const { greens, residual } = allocateGreens(flow.phases, lostTime, cycle);

  const results: TimingPhaseResult[] = flow.phases.map((p) => {
    const g = greens[p.index]!;
    const lambda = g / cycle;
    const x = degreeOfSaturation(p.y, lambda);

    // Phase-level guard runs before the delay formula.
    assertPhaseWithinCapacity(p.index, x, {
      y: p.y,
      lambda,
      cycle,
      label: p.label,
    });

    // Same q (p.q) that built y is the multiplier for the phase delay rate.
    const d = uniformDelay(cycle, lambda, x);
    return {
      index: p.index,
      label: p.label,
      q: p.q,
      s: p.s,
      y: p.y,
      g,
      minGreen: p.minGreen,
      lambda,
      x,
      uniformDelay: d,
      delayRate: p.q * d,
    };
  });

  const totalDelayRate = results.reduce((sum, p) => sum + p.delayRate, 0);

  return {
    Y,
    lostTime,
    optimalCycle,
    cycle,
    cycleSpecified,
    phases: results,
    greenBalanceResidual: residual,
    totalDelayRate,
  };
}
