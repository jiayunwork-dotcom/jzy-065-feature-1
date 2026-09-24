import type { ParsedPhase } from '../domain/validation';
import type { FlowRatioPhase } from '../domain/types';

export interface FlowRatioResult {
  phases: FlowRatioPhase[];
  /** Y = sum of q/s */
  Y: number;
}

/**
 * Phase flow ratios y = q/s and total flow ratio Y = sum y.
 * Uses exactly the arrival rates supplied by the caller — the same q values
 * are later reused for saturation and delay (never a second set).
 */
export function computeFlowRatios(phases: ParsedPhase[]): FlowRatioResult {
  const out: FlowRatioPhase[] = phases.map((p, index) => ({
    index,
    q: p.q,
    s: p.s,
    minGreen: p.minGreen,
    label: p.label,
    y: p.q / p.s,
  }));
  const Y = out.reduce((sum, p) => sum + p.y, 0);
  return { phases: out, Y };
}
