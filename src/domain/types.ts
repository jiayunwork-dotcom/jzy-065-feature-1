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

/* ------------------------------------------------------------------ */
/* Time-of-day day plans                                               */
/* ------------------------------------------------------------------ */

/**
 * Channelization-bound phase data, constant across the whole day: saturation
 * flow, optional minimum green, optional label. Arrival flow is NOT here — it
 * belongs to each period.
 */
export interface SharedPhaseInput {
  /** saturation flow, vehicles/hour (> 0) */
  s: number;
  /** optional minimum effective green, seconds (>= 0) */
  minGreen?: number;
  label?: string;
}

/**
 * One time-of-day period. Times are minutes after midnight; periods must tile
 * [0, 1440] seamlessly in array order (validated before any solving).
 */
export interface PlanPeriodInput {
  /** period start, minutes after midnight, 0 <= start < 1440 */
  start: number;
  /** period end, minutes after midnight, 0 < end <= 1440, end > start */
  end: number;
  /** arrival flow per phase (veh/h), one entry per shared phase, same order */
  q: number[];
  label?: string;
}

/** Day plan definition: what gets archived. Never any computed results. */
export interface DayPlanInput {
  /** total lost time per cycle, seconds (> 0), constant all day */
  lostTime: number;
  /** shared per-phase channelization data (s, minGreen, label) */
  phases: SharedPhaseInput[];
  /** contiguous periods covering exactly one day */
  periods: PlanPeriodInput[];
}

/** Persisted day-plan definition (no results are stored). */
export interface PlanRecord {
  name: string;
  lostTime: number;
  phases: SharedPhaseInput[];
  periods: PlanPeriodInput[];
  createdAt: string;
  updatedAt: string;
}

export type PeriodPlanStatus = 'ok' | 'error';

/**
 * One period's slice of the day plan. A period whose own traffic is
 * infeasible (oversaturated Y, a saturated phase, infeasible minimum greens)
 * is marked 'error' with the structured reason — the rest of the plan still
 * solves.
 */
export interface PeriodPlanResult {
  index: number;
  start: number;
  end: number;
  label: string | null;
  status: PeriodPlanStatus;
  /** present only when status === 'ok' */
  timing?: TimingResult;
  /** present only when status === 'error' */
  error?: ErrorDetailView;
}

export interface ErrorDetailView {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type TransitionStatus = 'feasible' | 'infeasible' | 'unavailable';

/**
 * Which demand regime the transition cycles are solved against. Always the
 * arriving ('target') period: the controller runs the transition at the start
 * of the new period, so every intermediate cycle must stand up under the
 * demand it is transitioning INTO.
 */
export type TransitionFlowBasis = 'target';

/** One cycle of a transition path, solved fresh at its own cycle length. */
export interface TransitionCycleView {
  /** 0 = the departing period's own cycle; 1..steps are the transition cycles */
  step: number;
  role: 'start' | 'transition';
  cycle: number;
  timing: TimingResult;
}

/** Why a transition cannot be walked: the first cycle that breaks, and where. */
export interface TransitionFailure {
  /** step index whose cycle could not serve the arriving period's demand */
  step: number;
  /** the offending intermediate cycle length, seconds */
  cycle: number;
  code: string;
  message: string;
  /** present for per-phase failures (e.g. PHASE_SATURATED) */
  phaseIndex?: number;
  label?: string | null;
}

/**
 * Cycle-length transition path between two adjacent periods.
 *
 * 'feasible'    — cycles[0] is the start cycle, cycles[steps] lands exactly on
 *                 the target cycle; every step moves at most maxStep seconds
 *                 and every transition cycle is a solved, balanced, unsaturated
 *                 timing under the arriving period's demand.
 * 'infeasible'  — some transition cycle would saturate a phase; cycles holds
 *                 the validated prefix and failure pinpoints the breaking step.
 * 'unavailable' — an endpoint period has no solution, so there is nothing to
 *                 walk from/to.
 */
export interface TransitionResult {
  fromPeriod: number;
  toPeriod: number;
  fromCycle: number | null;
  toCycle: number | null;
  maxStep: number;
  flowBasis: TransitionFlowBasis;
  status: TransitionStatus;
  /** planned number of cycle changes (0 when the cycles already match) */
  steps: number | null;
  cycles: TransitionCycleView[];
  failure?: TransitionFailure;
  /** present when status === 'unavailable' */
  reason?: string;
}

/** Full solved day plan: per-period timings plus every adjacent transition. */
export interface DayPlanResult {
  lostTime: number;
  maxCycleStep: number;
  periods: PeriodPlanResult[];
  /**
   * One transition per adjacent pair, in time order. For n >= 2 periods there
   * are exactly n transitions: the last one crosses midnight from the final
   * period back to the first (the plan repeats daily).
   */
  transitions: TransitionResult[];
}
