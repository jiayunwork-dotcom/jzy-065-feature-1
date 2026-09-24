import { describe, expect, it } from 'vitest';
import { validateTimingInput } from './validation';
import { TimingError } from './errors';

describe('request validation (must run before any formula)', () => {
  it('rejects fewer than two phases with TOO_FEW_PHASES', () => {
    expect(() =>
      validateTimingInput({ phases: [{ q: 100, s: 1000 }], lostTime: 10 }),
    ).toThrowError(expect.objectContaining({ code: 'TOO_FEW_PHASES' }));
    expect(() => validateTimingInput({ phases: [], lostTime: 10 })).toThrow(TimingError);
  });

  it('rejects negative arrival flow with INVALID_ARRIVAL_FLOW', () => {
    expect(() =>
      validateTimingInput({
        phases: [
          { q: -1, s: 1000 },
          { q: 100, s: 1000 },
        ],
        lostTime: 10,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ARRIVAL_FLOW' }));
  });

  it('accepts zero arrival flow (phase exists but no demand)', () => {
    const p = validateTimingInput({
      phases: [
        { q: 0, s: 1000 },
        { q: 100, s: 1000 },
      ],
      lostTime: 10,
    });
    expect(p.phases[0]!.q).toBe(0);
  });

  it('rejects non-positive saturation flow', () => {
    for (const s of [0, -100, NaN]) {
      expect(() =>
        validateTimingInput({
          phases: [
            { q: 100, s: 1000 },
            { q: 100, s },
          ],
          lostTime: 10,
        }),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_SATURATION_FLOW' }));
    }
  });

  it('rejects non-positive lost time with INVALID_LOST_TIME', () => {
    for (const lostTime of [0, -5, NaN]) {
      expect(() =>
        validateTimingInput({
          phases: [
            { q: 100, s: 1000 },
            { q: 100, s: 1000 },
          ],
          lostTime,
        }),
      ).toThrowError(expect.objectContaining({ code: 'INVALID_LOST_TIME' }));
    }
  });

  it('rejects malformed bodies and non-numeric fields', () => {
    expect(() => validateTimingInput(null)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
    expect(() =>
      validateTimingInput({ phases: 'nope', lostTime: 10 }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('rejects an explicit cycle on the optimum-only path and a non-positive cycle anywhere', () => {
    const body = {
      phases: [
        { q: 100, s: 1000 },
        { q: 100, s: 1000 },
      ],
      lostTime: 10,
    };
    expect(() => validateTimingInput({ ...body, cycle: 60 }, { allowCycle: false })).toThrowError(
      expect.objectContaining({ code: 'INVALID_CYCLE' }),
    );
    expect(() =>
      validateTimingInput({ ...body, cycle: 0 }, { allowCycle: true }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CYCLE' }));
  });

  it('rejects negative minimum green', () => {
    expect(() =>
      validateTimingInput({
        phases: [
          { q: 100, s: 1000, minGreen: -1 },
          { q: 100, s: 1000 },
        ],
        lostTime: 10,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_MIN_GREEN' }));
  });
});
