import { TimingError } from './errors';
import type { PhaseInput, TimingInput } from './types';
import { isFiniteNumber } from './constants';

export interface ParsedPhase {
  q: number;
  s: number;
  minGreen: number | null;
  label: string | null;
}

export interface ParsedTimingInput {
  phases: ParsedPhase[];
  lostTime: number;
  cycle: number | null;
}

/**
 * Validate and normalise a timing request.
 *
 * Validation happens strictly *before* any formula evaluation:
 * - fewer than two phases,
 * - a negative arrival flow,
 * - a non-positive saturation flow,
 * - a non-positive lost time
 * each return a structured error carrying the reason.
 *
 * `requireCycle` controls whether an explicit cycle field is accepted:
 * the /timing route only reports the optimum, so a cycle there is ignored
 * by the caller rather than rejected here.
 */
export function validateTimingInput(
  input: unknown,
  opts: { allowCycle?: boolean } = {},
): ParsedTimingInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TimingError('INVALID_REQUEST', 'request body must be a JSON object');
  }
  const body = input as Record<string, unknown>;

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

  const phases: ParsedPhase[] = rawPhases.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TimingError('INVALID_REQUEST', `phases[${index}] must be an object`, {
        phaseIndex: index,
      });
    }
    const p = raw as Record<string, unknown>;

    if (!isFiniteNumber(p.q)) {
      throw new TimingError('INVALID_ARRIVAL_FLOW', `phases[${index}].q must be a finite number`, {
        phaseIndex: index,
        received: String(p.q),
      });
    }
    if (p.q < 0) {
      throw new TimingError('INVALID_ARRIVAL_FLOW', `phases[${index}].q must not be negative`, {
        phaseIndex: index,
        q: p.q,
      });
    }
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
    return { q: p.q, s: p.s, minGreen, label };
  });

  if (!isFiniteNumber(body.lostTime)) {
    throw new TimingError('INVALID_LOST_TIME', 'lostTime must be a finite number', {
      received: String(body.lostTime),
    });
  }
  if ((body.lostTime as number) <= 0) {
    throw new TimingError('INVALID_LOST_TIME', 'lostTime must be positive', {
      lostTime: body.lostTime,
    });
  }

  let cycle: number | null = null;
  if (body.cycle !== undefined && body.cycle !== null) {
    if (!opts.allowCycle) {
      throw new TimingError(
        'INVALID_CYCLE',
        'this endpoint does not accept an explicit cycle',
      );
    }
    if (!isFiniteNumber(body.cycle) || (body.cycle as number) <= 0) {
      throw new TimingError('INVALID_CYCLE', 'cycle must be a finite positive number of seconds', {
        received: String(body.cycle),
      });
    }
    cycle = body.cycle as number;
  }

  return { phases, lostTime: body.lostTime as number, cycle };
}

export function toPhaseInput(parsed: ParsedTimingInput): {
  phases: PhaseInput[];
  lostTime: number;
} {
  return {
    lostTime: parsed.lostTime,
    phases: parsed.phases.map<PhaseInput>((p) => ({
      q: p.q,
      s: p.s,
      ...(p.minGreen !== null ? { minGreen: p.minGreen } : {}),
      ...(p.label !== null ? { label: p.label } : {}),
    })),
  };
}

export function normalizeTimingInput(input: TimingInput): ParsedTimingInput {
  return validateTimingInput(input, { allowCycle: true });
}
