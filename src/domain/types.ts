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

// ---------------------------------------------------------------------------
// Daily time-of-day plans
//
// A plan is a set of contiguous segments that together cover the whole day.
// Canalisation-level quantities (saturation flows, minimum greens, lost time)
// are shared across the day; only the arrival rates q change per segment.
// ---------------------------------------------------------------------------

/** One phase of the intersection geometry; s and minGreen apply all day. */
export interface PlanPhase {
  s: number;
  minGreen?: number;
  label?: string;
}

/** One time-of-day interval with its own arrival flow vector. */
export interface PlanSegmentInput {
  /** "HH:MM", first segment must start at 00:00; "24:00" is legal only as the final end */
  start: string;
  end: string;
  label?: string;
  /** arrival flow rates, vehicles/hour; exactly one entry per plan phase */
  flows: number[];
}

export interface DailyPlanInput {
  lostTime: number;
  phases: PlanPhase[];
  segments: PlanSegmentInput[];
}

/** Segment flows in solve requests / stored definitions use plain arrays. */
export type ParsedPlanPhase = {
  s: number;
  minGreen: number | null;
  label: string | null;
};

export interface ParsedPlanSegment {
  startMinute: number;
  endMinute: number;
  label: string | null;
  flows: number[];
}

export interface ParsedDailyPlan {
  lostTime: number;
  phases: ParsedPlanPhase[];
  segments: ParsedPlanSegment[];
}

/** Persisted daily-plan definition (only the definition, never results). */
export interface DailyPlanRecord {
  name: string;
  lostTime: number;
  phases: PlanPhase[];
  segments: PlanSegmentInput[];
  createdAt: string;
  updatedAt: string;
}

/** Status of solving a single segment independently of its neighbours. */
export type SegmentStatus = 'ok' | 'error';

export interface SegmentError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface SolvedSegment {
  index: number;
  start: string;
  end: string;
  label: string | null;
  status: SegmentStatus;
  /** present only when status === 'ok' */
  result?: TimingResult;
  /** present only when status === 'error'; other segments still solve */
  error?: SegmentError;
}

/** One transition cycle, freshly allocated for its OWN cycle length. */
export interface TransitionCycleEntry {
  /** 0-based position in the walk; 0 is the cycle departing `from` */
  step: number;
  cycle: number;
  status: SegmentStatus;
  /** present only when status === 'ok': fresh timing under the departing segment's flows */
  result?: TimingResult;
  /** present only when status === 'error' — the walk ends at this step */
  error?: SegmentError;
}

export type TransitionStatus = 'feasible' | 'infeasible' | 'skipped';

export interface TransitionResult {
  /** index of the departing segment */
  fromSegment: number;
  /** index of the arriving segment */
  toSegment: number;
  fromCycle: number;
  toCycle: number;
  maxAdjustment: number;
  status: TransitionStatus;
  /**
   * feasible: every cycle walked (first === fromCycle, last === toCycle).
   * infeasible: entries up to and including the first cycle that cannot serve
   *             the departing segment's flows (it is the one marked `error`).
   * skipped:   empty (one of the two segments itself does not solve).
   */
  cycles: TransitionCycleEntry[];
  /** present only when status === 'skipped' */
  reason?: string;
}

export interface SolvedDailyPlan {
  lostTime: number;
  maxAdjustment: number;
  segments: SolvedSegment[];
  transitions: TransitionResult[];
}
