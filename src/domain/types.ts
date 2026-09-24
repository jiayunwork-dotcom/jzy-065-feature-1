/**
 * Domain types for isolated-intersection Webster timing calculations.
 *
 * Conventions
 * - Flow rates q (arrival) and s (saturation) are vehicles/hour.
 * - Times (lostTime, cycle, green) are seconds.
 * - y = q/s is a phase flow ratio; Y = sum of y.
 * - lambda = g/C is the green ratio; x = q/(lambda*s) is the degree of saturation.
 * - Uniform delay d is seconds/vehicle; delayRate = q*d is vehicle-seconds/hour.
 */

export interface PhaseInput {
  /** arrival flow rate, vehicles/hour (>= 0) */
  q: number;
  /** saturation flow rate, vehicles/hour (> 0) */
  s: number;
  /** optional minimum effective green for this phase, seconds (>= 0) */
  minGreen?: number;
  /** optional caller-supplied label, carried through the response */
  label?: string;
}

export interface TimingInput {
  phases: PhaseInput[];
  /** total lost time per cycle, seconds (> 0) */
  lostTime: number;
  /** optional explicit cycle length; absent => Webster optimum */
  cycle?: number;
}

export interface FlowRatioPhase {
  index: number;
  q: number;
  s: number;
  minGreen: number | null;
  label: string | null;
  y: number;
}

export interface TimingPhaseResult {
  index: number;
  label: string | null;
  /** arrival rate actually used for BOTH flow ratio and delay (they must never diverge) */
  q: number;
  s: number;
  y: number;
  /** effective green, seconds */
  g: number;
  minGreen: number | null;
  /** green ratio lambda = g/C */
  lambda: number;
  /** degree of saturation x = q/(lambda*s) (0 for a q=0 phase) */
  x: number;
  /** Webster uniform (first-term) delay, seconds/vehicle */
  uniformDelay: number;
  /** phase delay rate q*d, vehicle-seconds/hour */
  delayRate: number;
}

export interface TimingResult {
  /** sum of phase flow ratios */
  Y: number;
  lostTime: number;
  /** Webster optimum C0 = (1.5L+5)/(1-Y) */
  optimalCycle: number;
  /** cycle actually used (the optimum, or the caller-specified cycle) */
  cycle: number;
  cycleSpecified: boolean;
  phases: TimingPhaseResult[];
  /** sum(g) + L; must equal the used cycle within BALANCE_TOLERANCE */
  greenBalanceResidual: number;
  /** sum of phase delay rates, vehicle-seconds/hour */
  totalDelayRate: number;
}

/** Single evaluated point of the total-delay-vs-cycle curve. */
export interface ScanPhasePoint {
  index: number;
  label: string | null;
  lambda: number;
  x: number;
  uniformDelay: number;
  delayRate: number;
}

export type ScanPointStatus = 'ok' | 'error';

export interface ScanPoint {
  cycle: number;
  status: ScanPointStatus;
  /** present only when status === 'ok' */
  totalDelayRate?: number;
  phases?: ScanPhasePoint[];
  /** present only when status === 'error'; no physically meaningless delay emitted */
  errorCode?: string;
  error?: string;
}

export type ScanJobState = 'pending' | 'running' | 'completed' | 'cancelled';

export interface ScanRequest {
  phases: PhaseInput[];
  lostTime: number;
  cycles: number[];
  /** delay inserted between points; only used to make cancellation observable */
  pointDelayMs?: number;
}

export interface ScanJobView {
  id: string;
  state: ScanJobState;
  total: number;
  /** number of points successfully evaluated so far (never exposed as a full curve) */
  completed: number;
  points: ScanPoint[];
  createdAt: string;
  finishedAt: string | null;
  /** set when a sweep died mid-way for a reason other than explicit cancellation */
  error?: string;
}

/** Persisted timing scenario definition (no results are stored). */
export interface ScenarioRecord {
  name: string;
  phases: PhaseInput[];
  lostTime: number;
  createdAt: string;
  updatedAt: string;
}
