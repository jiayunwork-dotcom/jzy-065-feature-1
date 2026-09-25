import { describe, expect, it } from 'vitest';
import {
  validateDailyPlan,
  validateMaxAdjustment,
  parseClock,
  formatClock,
} from './planValidation';
import { TimingError } from '../domain/errors';

const twoPhases = [
  { s: 1000, label: 'P0' },
  { s: 1000, label: 'P1' },
];

function day(segments: unknown, overrides: Record<string, unknown> = {}) {
  return { lostTime: 10, phases: twoPhases, segments, ...overrides };
}

const validTwo = [
  { start: '00:00', end: '12:00', label: 'night', flows: [100, 200] },
  { start: '12:00', end: '24:00', label: 'day', flows: [400, 300] },
];

describe('clock parsing', () => {
  it('parses HH:MM to minutes from midnight', () => {
    expect(parseClock('00:00', false)).toBe(0);
    expect(parseClock('06:30', false)).toBe(390);
    expect(parseClock('23:59', false)).toBe(23 * 60 + 59);
    expect(parseClock('24:00', true)).toBe(24 * 60);
  });

  it('rejects malformed clocks, 24:00 as a start, 24:01, and out-of-range minutes', () => {
    expect(() => parseClock('24:00', false)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CLOCK' }),
    );
    expect(() => parseClock('24:01', true)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CLOCK' }),
    );
    for (const bad of ['7:00', '000:00', 'noon', '12:60', '25:00']) {
      // 7:00 is malformed: hours must be zero-padded ("07:00").
      expect(() => parseClock(bad, true)).toThrowError(
        expect.objectContaining({ code: 'INVALID_CLOCK' }),
      );
    }
  });

  it('round-trips through formatClock including 24:00', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(390)).toBe('06:30');
    expect(formatClock(1440)).toBe('24:00');
  });
});

describe('daily plan tiling validation (before solving)', () => {
  it('accepts a gap-free, overlap-free plan covering exactly one day', () => {
    const parsed = validateDailyPlan(day(validTwo));
    expect(parsed.segments.map((s) => s.startMinute)).toEqual([0, 720]);
    expect(parsed.segments.map((s) => s.endMinute)).toEqual([720, 1440]);
    expect(parsed.phases[1]!.label).toBe('P1');
  });

  it('accepts more than two segments and out-of-order-looking values that still tile', () => {
    const parsed = validateDailyPlan(
      day([
        { start: '00:00', end: '06:00', flows: [1, 1] },
        { start: '06:00', end: '06:01', flows: [2, 2] },
        { start: '06:01', end: '24:00', flows: [3, 3] },
      ]),
    );
    expect(parsed.segments).toHaveLength(3);
  });

  it('reports a GAP with the exact pair of segments and its size', () => {
    const gapped = [
      { start: '00:00', end: '11:30', flows: [1, 1] },
      { start: '12:00', end: '24:00', flows: [2, 2] },
    ];
    let err: TimingError | undefined;
    try {
      validateDailyPlan(day(gapped));
    } catch (e) {
      err = e as TimingError;
    }
    expect(err!.code).toBe('SEGMENT_GAP');
    expect(err!.details!.between).toEqual([0, 1]);
    expect(err!.details!.gapMinutes).toBe(30);
  });

  it('reports an OVERLAP naming the two segments and its size', () => {
    const overlapping = [
      { start: '00:00', end: '12:30', flows: [1, 1] },
      { start: '12:00', end: '24:00', flows: [2, 2] },
    ];
    let err: TimingError | undefined;
    try {
      validateDailyPlan(day(overlapping));
    } catch (e) {
      err = e as TimingError;
    }
    expect(err!.code).toBe('SEGMENT_OVERLAP');
    expect(err!.details!.between).toEqual([0, 1]);
    expect(err!.details!.overlapMinutes).toBe(30);
  });

  it('rejects a plan that does not start at midnight or does not end at 24:00', () => {
    expect(() =>
      validateDailyPlan(
        day([
          { start: '00:01', end: '12:00', flows: [1, 1] },
          { start: '12:00', end: '24:00', flows: [2, 2] },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'DAY_NOT_COVERED' }));

    expect(() =>
      validateDailyPlan(
        day([
          { start: '00:00', end: '12:00', flows: [1, 1] },
          { start: '12:00', end: '23:00', flows: [2, 2] },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'DAY_NOT_COVERED' }));
  });

  it('rejects an empty segment list, a reversed interval and missing/extra flows', () => {
    expect(() => validateDailyPlan(day([]))).toThrowError(
      expect.objectContaining({ code: 'INVALID_PLAN' }),
    );
    expect(() =>
      validateDailyPlan(
        day([
          { start: '12:00', end: '00:00', flows: [1, 1] },
          { start: '00:00', end: '12:00', flows: [2, 2] },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TIME_RANGE' }));
    expect(() =>
      validateDailyPlan(
        day([
          { start: '00:00', end: '12:00', flows: [1] },
          { start: '12:00', end: '24:00', flows: [2, 3] },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SEGMENT_FLOW' }));
  });

  it('rejects negative/non-finite segment flows, bad saturation/lost time, and a stray q on a phase', () => {
    expect(() =>
      validateDailyPlan(
        day([
          { start: '00:00', end: '12:00', flows: [-1, 1] },
          { start: '12:00', end: '24:00', flows: [2, 3] },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SEGMENT_FLOW' }));
    expect(() => validateDailyPlan(day(validTwo, { lostTime: 0 }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_LOST_TIME' }),
    );
    expect(() =>
      validateDailyPlan(day(validTwo, { phases: [{ s: 1000, q: 1 }, { s: 1000 }] })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PLAN' }));
  });

  it('validates the operating parameter maxCycleAdjustment', () => {
    expect(validateMaxAdjustment(12)).toBe(12);
    for (const bad of [0, -3, NaN, '10', null, undefined]) {
      expect(() => validateMaxAdjustment(bad)).toThrowError(
        expect.objectContaining({ code: 'INVALID_CYCLE_ADJUSTMENT' }),
      );
    }
  });
});
