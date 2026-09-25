/**
 * Structured errors. Validation runs *before* any formula evaluation;
 * physics-level failures (oversaturation, per-phase saturation) are
 * distinct from malformed requests so the HTTP layer can map them.
 */
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'TOO_FEW_PHASES'
  | 'INVALID_ARRIVAL_FLOW'
  | 'INVALID_SATURATION_FLOW'
  | 'INVALID_LOST_TIME'
  | 'INVALID_CYCLE'
  | 'INVALID_MIN_GREEN'
  | 'ZERO_FLOW'
  | 'OVERSATURATED_Y'
  | 'PHASE_SATURATED'
  | 'CYCLE_TOO_SHORT'
  | 'MIN_GREEN_INFEASIBLE'
  | 'GREEN_BALANCE_RESIDUAL'
  | 'NOT_FOUND'
  | 'SCAN_NOT_FOUND'
  | 'SCAN_NOT_RUNNING'
  // Daily-plan time-of-day schedule (structural problems, rejected before solving)
  | 'INVALID_PLAN'
  | 'INVALID_CLOCK'
  | 'INVALID_TIME_RANGE'
  | 'SEGMENT_GAP'
  | 'SEGMENT_OVERLAP'
  | 'DAY_NOT_COVERED'
  | 'INVALID_SEGMENT_FLOW'
  | 'INVALID_CYCLE_ADJUSTMENT'
  | 'TRANSITION_TOO_MANY_STEPS';

const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  TOO_FEW_PHASES: 400,
  INVALID_ARRIVAL_FLOW: 400,
  INVALID_SATURATION_FLOW: 400,
  INVALID_LOST_TIME: 400,
  INVALID_CYCLE: 400,
  INVALID_MIN_GREEN: 400,
  ZERO_FLOW: 422,
  OVERSATURATED_Y: 422,
  PHASE_SATURATED: 422,
  CYCLE_TOO_SHORT: 422,
  MIN_GREEN_INFEASIBLE: 422,
  GREEN_BALANCE_RESIDUAL: 500,
  NOT_FOUND: 404,
  SCAN_NOT_FOUND: 404,
  SCAN_NOT_RUNNING: 409,
  INVALID_PLAN: 400,
  INVALID_CLOCK: 400,
  INVALID_TIME_RANGE: 400,
  SEGMENT_GAP: 400,
  SEGMENT_OVERLAP: 400,
  DAY_NOT_COVERED: 400,
  INVALID_SEGMENT_FLOW: 400,
  INVALID_CYCLE_ADJUSTMENT: 400,
  TRANSITION_TOO_MANY_STEPS: 400,
};

export interface ErrorDetail {
  code: string;
  message: string;
  /** extra structured context, e.g. the computed Y or offending phase index */
  details?: Record<string, unknown>;
}

export class TimingError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TimingError';
    this.code = code;
    this.details = details;
  }

  statusCode(): number {
    return HTTP_STATUS[this.code];
  }

  toBody(): { error: ErrorDetail } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}
