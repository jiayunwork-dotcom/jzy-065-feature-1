import { TimingError } from '../domain/errors';
import { DAY_MINUTES, DEFAULT_MAX_CYCLE_STEP, isFiniteNumber } from '../domain/constants';

export interface ParsedSharedPhase {
  s: number;
  minGreen: number | null;
  label: string | null;
}

export interface ParsedPeriod {
  index: number;
  /** minutes after midnight */
  start: number;
  /** minutes after midnight */
  end: number;
  label: string | null;
  /** arrival flow per phase (veh/h), aligned with the shared phases array */
  q: number[];
}

export interface ParsedDayPlan {
  lostTime: number;
  phases: ParsedSharedPhase[];
  periods: ParsedPeriod[];
}

/**
 * Validate and normalise a time-of-day day-plan definition.
 *
 * Validation happens strictly *before* any period is solved. Two layers:
 *
 * 1. Shape: lostTime > 0; at least two shared phases with s > 0 (and optional
 *    minGreen >= 0); at least one period; every period carries one arrival
 *    flow per shared phase.
 * 2. Tiling: times are minutes after midnight with 0 <= start < end <= 1440;
 *    in array order the periods must start at 0, butt jointlessly (no gap, no
 *    overlap) and end exactly at 1440. A broken seam is reported with the two
 *    period indices involved (or the day boundary) so the caller can see
 *    exactly where the plan tears.
 */
export function validateDayPlan(input: unknown): ParsedDayPlan {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TimingError('INVALID_REQUEST', 'request body must be a JSON object');
  }
  const body = input as Record<string, unknown>;

  if (!isFiniteNumber(body.lostTime)) {
    throw new TimingError('INVALID_LOST_TIME', 'lostTime must be a finite number', {
      received: String(body.lostTime),
    });
  }
  if (body.lostTime <= 0) {
    throw new TimingError('INVALID_LOST_TIME', 'lostTime must be positive', {
      lostTime: body.lostTime,
    });
  }
  const lostTime = body.lostTime;

  const rawPhases = body.phases;
  if (!Array.isArray(rawPhases)) {
    throw new TimingError('INVALID_REQUEST', 'phases must be an array');
  }
  if (rawPhases.length < 2) {
    throw new TimingError(
      'TOO_FEW_PHASES',
      `an intersection needs at least two phases, got ${rawPhases.length}`,
      { phaseCount: rawPhases.length },
    );
  }
  const phases: ParsedSharedPhase[] = rawPhases.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TimingError('INVALID_REQUEST', `phases[${index}] must be an object`, {
        phaseIndex: index,
      });
    }
    const p = raw as Record<string, unknown>;
    if (!isFiniteNumber(p.s)) {
      throw new TimingError(
        'INVALID_SATURATION_FLOW',
        `phases[${index}].s must be a finite number`,
        { phaseIndex: index, received: String(p.s) },
      );
    }
    if (p.s <= 0) {
      throw new TimingError(
        'INVALID_SATURATION_FLOW',
        `phases[${index}].s must be positive`,
        { phaseIndex: index, s: p.s },
      );
    }
    let minGreen: number | null = null;
    if (p.minGreen !== undefined && p.minGreen !== null) {
      if (!isFiniteNumber(p.minGreen) || p.minGreen < 0) {
        throw new TimingError(
          'INVALID_MIN_GREEN',
          `phases[${index}].minGreen must be a finite non-negative number`,
          { phaseIndex: index, received: String(p.minGreen) },
        );
      }
      minGreen = p.minGreen;
    }
    const label = typeof p.label === 'string' ? p.label : null;
    return { s: p.s, minGreen, label };
  });

  const rawPeriods = body.periods;
  if (!Array.isArray(rawPeriods) || rawPeriods.length === 0) {
    throw new TimingError(
      'INVALID_REQUEST',
      'periods must be a non-empty array covering the whole day',
    );
  }
  const periods: ParsedPeriod[] = rawPeriods.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TimingError('INVALID_REQUEST', `periods[${index}] must be an object`, {
        periodIndex: index,
      });
    }
    const p = raw as Record<string, unknown>;

    if (!isFiniteNumber(p.start) || !isFiniteNumber(p.end)) {
      throw new TimingError(
        'INVALID_PERIOD_TIME',
        `periods[${index}] start and end must be finite numbers (minutes after midnight)`,
        { periodIndex: index, receivedStart: String(p.start), receivedEnd: String(p.end) },
      );
    }
    const { start, end } = p;
    if (start < 0 || start >= DAY_MINUTES || end <= 0 || end > DAY_MINUTES) {
      throw new TimingError(
        'INVALID_PERIOD_TIME',
        `periods[${index}] times must lie within [0, ${DAY_MINUTES}] minutes after midnight`,
        { periodIndex: index, start, end, dayMinutes: DAY_MINUTES },
      );
    }
    if (start >= end) {
      throw new TimingError(
        'INVALID_PERIOD_TIME',
        `periods[${index}] start ${start} must be strictly before end ${end}`,
        { periodIndex: index, start, end },
      );
    }

    if (!Array.isArray(p.q)) {
      throw new TimingError(
        'PERIOD_FLOW_MISMATCH',
        `periods[${index}].q must be an array with one arrival flow per phase (${phases.length})`,
        { periodIndex: index, expected: phases.length },
      );
    }
    if (p.q.length !== phases.length) {
      throw new TimingError(
        'PERIOD_FLOW_MISMATCH',
        `periods[${index}].q has ${p.q.length} entries but the plan defines ${phases.length} phases`,
        { periodIndex: index, received: p.q.length, expected: phases.length },
      );
    }
    const q = p.q.map((v, phaseIndex) => {
      if (!isFiniteNumber(v)) {
        throw new TimingError(
          'INVALID_ARRIVAL_FLOW',
          `periods[${index}].q[${phaseIndex}] must be a finite number`,
          { periodIndex: index, phaseIndex, received: String(v) },
        );
      }
      if (v < 0) {
        throw new TimingError(
          'INVALID_ARRIVAL_FLOW',
          `periods[${index}].q[${phaseIndex}] must not be negative`,
          { periodIndex: index, phaseIndex, q: v },
        );
      }
      return v;
    });

    const label = typeof p.label === 'string' ? p.label : null;
    return { index, start, end, label, q };
  });

  assertSeamlessDay(periods);

  return { lostTime, phases, periods };
}

/**
 * The periods, taken in array order, must tile [0, DAY_MINUTES] exactly:
 * first starts at 0, every seam is jointless, the last ends at DAY_MINUTES.
 * Any tear is reported with the two periods (or day boundary) involved.
 */
function assertSeamlessDay(periods: ParsedPeriod[]): void {
  const first = periods[0]!;
  if (first.start !== 0) {
    throw new TimingError(
      'PLAN_GAP',
      `plan does not start at 00:00: gap of ${first.start} min before period 0 begins`,
      { between: 'dayStart', periodIndex: 0, gapStart: 0, gapEnd: first.start },
    );
  }
  for (let i = 1; i < periods.length; i += 1) {
    const prev = periods[i - 1]!;
    const cur = periods[i]!;
    if (cur.start > prev.end) {
      throw new TimingError(
        'PLAN_GAP',
        `gap of ${cur.start - prev.end} min between period ${prev.index} (ends ${prev.end}) and period ${cur.index} (starts ${cur.start})`,
        {
          periodIndex: prev.index,
          nextPeriodIndex: cur.index,
          gapStart: prev.end,
          gapEnd: cur.start,
        },
      );
    }
    if (cur.start < prev.end) {
      throw new TimingError(
        'PLAN_OVERLAP',
        `overlap of ${prev.end - cur.start} min between period ${prev.index} (ends ${prev.end}) and period ${cur.index} (starts ${cur.start})`,
        {
          periodIndex: prev.index,
          nextPeriodIndex: cur.index,
          overlapStart: cur.start,
          overlapEnd: prev.end,
        },
      );
    }
  }
  const last = periods[periods.length - 1]!;
  if (last.end !== DAY_MINUTES) {
    throw new TimingError(
      'PLAN_GAP',
      `plan does not reach 24:00: gap of ${DAY_MINUTES - last.end} min after period ${last.index} ends`,
      { between: 'dayEnd', periodIndex: last.index, gapStart: last.end, gapEnd: DAY_MINUTES },
    );
  }
}

/**
 * The per-cycle maximum step (seconds) the controller may move the cycle
 * length by during a transition. Optional; defaults to DEFAULT_MAX_CYCLE_STEP.
 */
export function validateMaxCycleStep(input: unknown): number {
  if (input === undefined || input === null) {
    return DEFAULT_MAX_CYCLE_STEP;
  }
  if (!isFiniteNumber(input) || input <= 0) {
    throw new TimingError(
      'INVALID_MAX_STEP',
      'maxCycleStep must be a finite positive number of seconds',
      { received: String(input) },
    );
  }
  return input;
}
