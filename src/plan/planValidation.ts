import { TimingError } from '../domain/errors';
import { isFiniteNumber } from '../domain/constants';
import type {
  DailyPlanInput,
  ParsedDailyPlan,
  ParsedPlanPhase,
  ParsedPlanSegment,
  PlanSegmentInput,
} from '../domain/types';

/** Minutes in one day; "24:00" is legal only as the final end clock. */
export const DAY_MINUTES = 24 * 60;

/**
 * Parse a "HH:MM" wall clock into minutes from midnight.
 * Hours 00..23 with minutes 00..59, plus the single end-of-day value 24:00.
 */
export function parseClock(value: unknown, allowEndOfDay: boolean): number {
  if (typeof value !== 'string') {
    throw new TimingError('INVALID_CLOCK', `clock time must be an "HH:MM" string`, {
      received: String(value),
    });
  }
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new TimingError('INVALID_CLOCK', `clock time "${value}" must look like HH:MM`, {
      received: value,
    });
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const maxHour = allowEndOfDay ? 24 : 23;
  if (hour > maxHour || (hour === 24 && minute !== 0)) {
    throw new TimingError('INVALID_CLOCK', `clock time "${value}" is outside the day`, {
      received: value,
    });
  }
  if (minute > 59) {
    throw new TimingError('INVALID_CLOCK', `clock time "${value}" has minutes above 59`, {
      received: value,
    });
  }
  return hour * 60 + minute;
}

/** Format minutes-from-midnight back to "HH:MM" (1440 => "24:00"). */
export function formatClock(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Validate and normalise a daily-plan definition.
 *
 * Structural checks all run BEFORE any timing formula:
 * - canalisation: >= 2 phases, positive s / L, non-negative minGreen,
 * - every segment carries exactly one finite non-negative q per phase,
 * - segments are back-to-back with no gap, no overlap, and cover 00:00..24:00.
 */
export function validateDailyPlan(input: unknown): ParsedDailyPlan {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TimingError('INVALID_PLAN', 'request body must be a JSON object');
  }
  const body = input as Record<string, unknown>;

  if (!Array.isArray(body.phases)) {
    throw new TimingError('INVALID_PLAN', 'phases must be an array');
  }
  if (body.phases.length < 2) {
    throw new TimingError('TOO_FEW_PHASES', `a plan needs at least two phases, got ${body.phases.length}`, {
      phaseCount: body.phases.length,
    });
  }

  const phases: ParsedPlanPhase[] = body.phases.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TimingError('INVALID_PLAN', `phases[${index}] must be an object`, { phaseIndex: index });
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
      throw new TimingError('INVALID_SATURATION_FLOW', `phases[${index}].s must be positive`, {
        phaseIndex: index,
        s: p.s,
      });
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
      minGreen = p.minGreen as number;
    }
    // Defensive: q lives on segments, not the day-level phase template.
    if (p.q !== undefined) {
      throw new TimingError(
        'INVALID_PLAN',
        `phases[${index}].q is not allowed on a plan phase: arrival rates are per segment`,
        { phaseIndex: index },
      );
    }
    return { s: p.s as number, minGreen, label: typeof p.label === 'string' ? p.label : null };
  });

  if (!isFiniteNumber(body.lostTime) || (body.lostTime as number) <= 0) {
    throw new TimingError('INVALID_LOST_TIME', 'lostTime must be a finite positive number of seconds', {
      received: String(body.lostTime),
    });
  }

  if (!Array.isArray(body.segments) || body.segments.length === 0) {
    throw new TimingError('INVALID_PLAN', 'segments must be a non-empty array');
  }

  const segments: ParsedPlanSegment[] = body.segments.map((raw, index) =>
    validateSegment(raw, index, phases.length),
  );

  assertTiling(segments);

  return { lostTime: body.lostTime as number, phases, segments };
}

function validateSegment(raw: unknown, index: number, phaseCount: number): ParsedPlanSegment {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TimingError('INVALID_PLAN', `segments[${index}] must be an object`, { segmentIndex: index });
  }
  const seg = raw as Record<string, unknown>;

  // The last segment may end exactly at 24:00; no segment may start there.
  const startMinute = parseClock(seg.start, false);
  const endMinute = parseClock(seg.end, true);
  if (endMinute <= startMinute) {
    throw new TimingError(
      'INVALID_TIME_RANGE',
      `segment ${index} (${seg.start as string}..${seg.end as string}) must have end strictly after start`,
      { segmentIndex: index, start: String(seg.start), end: String(seg.end) },
    );
  }

  if (!Array.isArray(seg.flows)) {
    throw new TimingError('INVALID_SEGMENT_FLOW', `segments[${index}].flows must be an array`, {
      segmentIndex: index,
    });
  }
  if (seg.flows.length !== phaseCount) {
    throw new TimingError(
      'INVALID_SEGMENT_FLOW',
      `segments[${index}] has ${seg.flows.length} flows but the plan defines ${phaseCount} phases`,
      { segmentIndex: index, flowCount: seg.flows.length, phaseCount },
    );
  }
  const flows = seg.flows.map((q, phaseIndex) => {
    if (!isFiniteNumber(q)) {
      throw new TimingError(
        'INVALID_SEGMENT_FLOW',
        `segments[${index}].flows[${phaseIndex}] must be a finite number`,
        { segmentIndex: index, phaseIndex, received: String(q) },
      );
    }
    if ((q as number) < 0) {
      throw new TimingError(
        'INVALID_SEGMENT_FLOW',
        `segments[${index}].flows[${phaseIndex}] must not be negative`,
        { segmentIndex: index, phaseIndex, q },
      );
    }
    return q as number;
  });

  return {
    startMinute,
    endMinute,
    label: typeof seg.label === 'string' ? seg.label : null,
    flows,
  };
}

/**
 * The segments, in the order given, must tile the day: segment k ends exactly
 * where segment k+1 starts; the chain starts at 00:00 and ends at 24:00.
 * (Overlaps and gaps are both visible as a boundary mismatch; the direction
 * of the mismatch says which one it is.)
 */
function assertTiling(segments: ParsedPlanSegment[]): void {
  const describe = (i: number) =>
    `segments[${i}]${segments[i]!.label ? ` "${segments[i]!.label}"` : ''}`;

  if (segments[0]!.startMinute !== 0) {
    throw new TimingError(
      'DAY_NOT_COVERED',
      `${describe(0)} starts at ${formatClock(segments[0]!.startMinute)}, not at 00:00; the plan must start at midnight`,
      { segmentIndex: 0, start: formatClock(segments[0]!.startMinute) },
    );
  }

  for (let i = 0; i < segments.length - 1; i += 1) {
    const boundary = segments[i]!.endMinute;
    const nextStart = segments[i + 1]!.startMinute;
    if (boundary < nextStart) {
      throw new TimingError(
        'SEGMENT_GAP',
        `gap between ${describe(i)} (ends ${formatClock(boundary)}) and ${describe(i + 1)} (starts ${formatClock(nextStart)}): ${nextStart - boundary} min uncovered`,
        {
          between: [i, i + 1],
          gapMinutes: nextStart - boundary,
          end: formatClock(boundary),
          nextStart: formatClock(nextStart),
        },
      );
    }
    if (boundary > nextStart) {
      throw new TimingError(
        'SEGMENT_OVERLAP',
        `overlap between ${describe(i)} (ends ${formatClock(boundary)}) and ${describe(i + 1)} (starts ${formatClock(nextStart)}): ${boundary - nextStart} min doubled`,
        {
          between: [i, i + 1],
          overlapMinutes: boundary - nextStart,
          end: formatClock(boundary),
          nextStart: formatClock(nextStart),
        },
      );
    }
  }

  const lastEnd = segments[segments.length - 1]!.endMinute;
  if (lastEnd !== DAY_MINUTES) {
    throw new TimingError(
      'DAY_NOT_COVERED',
      `${describe(segments.length - 1)} ends at ${formatClock(lastEnd)}, not at 24:00; the plan must cover the whole day`,
      { segmentIndex: segments.length - 1, end: formatClock(lastEnd) },
    );
  }
}

/**
 * Validate the per-cycle transition budget carried by solve requests
 * (not part of the stored definition — it is an operating parameter).
 */
export function validateMaxAdjustment(value: unknown): number {
  if (!isFiniteNumber(value) || (value as number) <= 0) {
    throw new TimingError(
      'INVALID_CYCLE_ADJUSTMENT',
      'maxCycleAdjustment must be a finite positive number of seconds',
      { received: String(value) },
    );
  }
  return value as number;
}

/** Re-serialise a parsed plan back into the stored/wire definition shape. */
export function toDailyPlanInput(parsed: ParsedDailyPlan): DailyPlanInput {
  return {
    lostTime: parsed.lostTime,
    phases: parsed.phases.map((p) => ({
      s: p.s,
      ...(p.minGreen !== null ? { minGreen: p.minGreen } : {}),
      ...(p.label !== null ? { label: p.label } : {}),
    })),
    segments: parsed.segments.map<PlanSegmentInput>((s) => ({
      start: formatClock(s.startMinute),
      end: formatClock(s.endMinute),
      ...(s.label !== null ? { label: s.label } : {}),
      flows: s.flows.map((q) => q),
    })),
  };
}
