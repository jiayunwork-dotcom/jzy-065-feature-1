import { TimingError } from '../domain/errors';
import { BALANCE_TOLERANCE } from '../domain/constants';
import type { FlowRatioPhase } from '../domain/types';

export interface GreenAllocation {
  /** effective green per phase, seconds */
  greens: number[];
  /** |cycle - (sum(g) + L)| */
  residual: number;
}

/**
 * Allocate effective green time for a given cycle.
 *
 * Without minimum greens the usable time C-L is split by flow ratio:
 *   g_i = (C - L) * y_i / Y
 * so that sum(g_i) + L === C (verified against BALANCE_TOLERANCE — a split
 * that does not close is an error, never silently carried downstream).
 *
 * With minimum greens a water-filling rule applies: time is split by flow
 * ratio, but any phase whose proportional share would fall below its minimum
 * is pinned to that minimum and the leftover is re-split among the other
 * phases. If the minima cannot fit the cycle (their sum exceeds C-L, or a
 * single minimum exceeds it), MIN_GREEN_INFEASIBLE is raised rather than
 * quietly zeroing a phase.
 */
export function allocateGreens(
  flow: FlowRatioPhase[],
  lostTime: number,
  cycle: number,
): GreenAllocation {
  const usable = cycle - lostTime;
  if (usable < -BALANCE_TOLERANCE) {
    throw new TimingError(
      'CYCLE_TOO_SHORT',
      `cycle ${cycle}s must exceed total lost time ${lostTime}s`,
      { cycle, lostTime },
    );
  }

  const n = flow.length;
  const greens = new Array<number>(n).fill(0);

  let reserved = 0;
  for (const p of flow) {
    const m = p.minGreen ?? 0;
    if (m > usable + BALANCE_TOLERANCE) {
      throw new TimingError(
        'MIN_GREEN_INFEASIBLE',
        `phase ${p.index} minGreen ${m}s exceeds the ${usable.toFixed(3)}s usable green at cycle ${cycle}s`,
        { phaseIndex: p.index, minGreen: m, usable, cycle },
      );
    }
    reserved += m;
  }
  if (reserved > usable + BALANCE_TOLERANCE) {
    throw new TimingError(
      'MIN_GREEN_INFEASIBLE',
      `sum of minimum greens ${reserved}s exceeds usable green ${usable}s at cycle ${cycle}s`,
      { totalMinGreen: reserved, usable, cycle },
    );
  }

  // Water-filling: distribute the whole usable time in proportion to y; pin a
  // phase to its minimum green only when its proportional share would fall
  // below that minimum, remove it, and re-split the leftover among the rest.
  const active = new Set(flow.map((p) => p.index));
  let remaining = usable;

  for (;;) {
    const activePhases = flow.filter((p) => active.has(p.index));
    const yActive = activePhases.reduce((sum, p) => sum + p.y, 0);
    if (yActive > 0) {
      const binding = activePhases.filter(
        (p) => (p.y / yActive) * remaining < (p.minGreen ?? 0),
      );
      if (binding.length === 0) {
        for (const p of activePhases) greens[p.index] = (p.y / yActive) * remaining;
        break;
      }
      for (const p of binding) {
        const m = p.minGreen ?? 0;
        greens[p.index] = m;
        remaining -= m;
        active.delete(p.index);
      }
    } else {
      // No flow among the active phases: split the leftover equally.
      const share = activePhases.length > 0 ? remaining / activePhases.length : 0;
      for (const p of activePhases) greens[p.index] = (p.minGreen ?? 0) + share;
      break;
    }
  }

  const sumGreen = greens.reduce((a, b) => a + b, 0);
  const residual = Math.abs(cycle - (sumGreen + lostTime));
  if (residual > BALANCE_TOLERANCE) {
    throw new TimingError(
      'GREEN_BALANCE_RESIDUAL',
      `green balance does not close: sum(g)+L=${sumGreen + lostTime} vs C=${cycle} (residual ${residual})`,
      { residual, tolerance: BALANCE_TOLERANCE, sumGreen, lostTime, cycle },
    );
  }

  return { greens, residual };
}
