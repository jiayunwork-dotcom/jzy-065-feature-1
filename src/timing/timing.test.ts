import { describe, expect, it } from 'vitest';
import { solveTiming } from './timing';
import { TimingError } from '../domain/errors';
import { BALANCE_TOLERANCE, OVERSATURATION_Y_LIMIT } from '../domain/constants';
import { computeFlowRatios } from './flowRatios';
import { websterOptimalCycle, criticalCycle } from './cycle';
import { allocateGreens } from './greenSplit';
import { uniformDelay, degreeOfSaturation } from './delay';
import { demoScenario } from '../store/seed';
import { normalizeTimingInput } from '../domain/validation';
import type { TimingInput } from '../domain/types';

/** Compact 3-phase case: y = .30, .20, .10 => Y = .60, L = 10. */
function case3(overrides: Partial<TimingInput> & { q0?: number; q1?: number } = {}): TimingInput {
  return {
    lostTime: overrides.lostTime ?? 10,
    phases: [
      { label: 'A', q: overrides.q0 ?? 300, s: 1000 },
      { label: 'B', q: overrides.q1 ?? 200, s: 1000 },
      { label: 'C', q: 100, s: 1000 },
    ],
    ...(overrides.cycle !== undefined ? { cycle: overrides.cycle } : {}),
    ...(overrides.phases ? { phases: overrides.phases } : {}),
  };
}

describe('flow ratios and Webster optimum', () => {
  it('computes y = q/s per phase and Y = sum y', () => {
    const parsed = normalizeTimingInput(case3());
    const { phases, Y } = computeFlowRatios(parsed.phases);
    expect(phases.map((p) => p.y)).toEqual([0.3, 0.2, 0.1]);
    expect(Y).toBeCloseTo(0.6, 12);
  });

  it('computes C0 = (1.5L + 5)/(1 - Y) for the demo and lands in 50..80 s', () => {
    const r = solveTiming(demoScenario);
    expect(r.Y).toBeCloseTo(0.7, 12);
    expect(r.optimalCycle).toBeCloseTo((1.5 * 12 + 5) / 0.3, 9);
    expect(r.optimalCycle).toBeGreaterThan(50);
    expect(r.optimalCycle).toBeLessThan(80);
    expect(r.cycleSpecified).toBe(false);
  });

  it('demo order of magnitude: Y ~ 0.7, L ~ 10s, C0 ~ 77s', () => {
    const r = solveTiming(demoScenario);
    expect(r.Y).toBeGreaterThan(0.6);
    expect(r.Y).toBeLessThan(0.8);
    expect(r.lostTime).toBeGreaterThanOrEqual(10);
    expect(r.lostTime).toBeLessThan(20);
    expect(r.optimalCycle).toBeGreaterThan(50);
    expect(r.optimalCycle).toBeLessThan(100);
  });
});

describe('green split and the strict green-balance identity', () => {
  it('splits usable green by y/Y and closes sum(g)+L === C within tolerance', () => {
    const r = solveTiming(case3());
    const total = r.phases.reduce((a, p) => a + p.g, 0) + r.lostTime;
    expect(total).toBeCloseTo(r.cycle, 9);
    expect(r.greenBalanceResidual).toBeLessThanOrEqual(BALANCE_TOLERANCE);
    // proportional split: g_i/(C-L) = y_i/Y
    const usable = r.cycle - r.lostTime;
    expect(r.phases[0]!.g / usable).toBeCloseTo(0.3 / 0.6, 12);
    expect(r.phases[1]!.g / usable).toBeCloseTo(0.2 / 0.6, 12);
    expect(r.phases[2]!.g / usable).toBeCloseTo(0.1 / 0.6, 12);
  });

  it('balances exactly when an explicit cycle is used as well', () => {
    const r = solveTiming({ ...case3(), cycle: 90 });
    const total = r.phases.reduce((a, p) => a + p.g, 0) + r.lostTime;
    expect(Math.abs(total - r.cycle)).toBeLessThanOrEqual(BALANCE_TOLERANCE);
  });

  it('pins a phase to its minimum green only when the proportional share would be lower', () => {
    // Binding minimum: at C=80 (usable 70) proportional shares would be
    // 35/23.33/11.67; phase 0 demands 40, so it is pinned and the other
    // phases split the leftover 30 as .2/.1 => 20/10.
    const binding = solveTiming({
      lostTime: 10,
      cycle: 80,
      phases: [
        { q: 300, s: 1000, minGreen: 40 },
        { q: 200, s: 1000 },
        { q: 100, s: 1000 },
      ],
    });
    expect(binding.phases[0]!.g).toBeCloseTo(40, 12);
    expect(binding.phases[1]!.g).toBeCloseTo(20, 12);
    expect(binding.phases[2]!.g).toBeCloseTo(10, 12);
    const total = binding.phases.reduce((a, p) => a + p.g, 0) + binding.lostTime;
    expect(total).toBeCloseTo(binding.cycle, 9);

    // Non-binding minimum must NOT pin the phase: a min below its proportional
    // share leaves the proportional split untouched.
    const loose = solveTiming({
      lostTime: 10,
      cycle: 80,
      phases: [
        { q: 300, s: 1000, minGreen: 10 },
        { q: 200, s: 1000 },
        { q: 100, s: 1000 },
      ],
    });
    expect(loose.phases[0]!.g).toBeCloseTo(35, 12);
    expect(loose.phases[1]!.g).toBeCloseTo(70 / 3, 9);
    expect(loose.phases[2]!.g).toBeCloseTo(70 / 6, 9);
  });

  it('refuses to quietly zero a phase when minimum greens cannot fit', () => {
    const input: TimingInput = {
      lostTime: 10,
      cycle: 40,
      phases: [
        { q: 300, s: 1000, minGreen: 25 },
        { q: 200, s: 1000, minGreen: 20 },
        { q: 100, s: 1000 },
      ],
    };
    expect(() => solveTiming(input)).toThrowError(
      expect.objectContaining({ code: 'MIN_GREEN_INFEASIBLE' }),
    );
  });
});

describe('uniform delay and saturation', () => {
  it('computes d = 0.5 C (1-lambda)^2 / (1-lambda x) and delayRate = q*d', () => {
    const r = solveTiming(case3());
    for (const p of r.phases) {
      const expected = uniformDelay(r.cycle, p.lambda, p.x);
      expect(p.uniformDelay).toBeCloseTo(expected, 12);
      expect(p.delayRate).toBeCloseTo(p.q * expected, 9);
      expect(p.x).toBeCloseTo(degreeOfSaturation(p.y, p.lambda), 12);
    }
    expect(r.totalDelayRate).toBeCloseTo(
      r.phases.reduce((a, p) => a + p.delayRate, 0),
      9,
    );
  });

  it('identity lambda*x = y under proportional allocation', () => {
    const r = solveTiming(demoScenario);
    for (const p of r.phases) {
      expect(p.lambda * p.x).toBeCloseTo(p.y, 12);
    }
  });

  it('treats a zero-flow phase as unsaturated (x=0) even with no green', () => {
    const parsed = normalizeTimingInput({
      lostTime: 10,
      phases: [
        { q: 400, s: 1000 },
        { q: 0, s: 1000 },
      ],
    });
    const flow = computeFlowRatios(parsed.phases);
    const { greens } = allocateGreens(flow.phases, 10, 60);
    expect(greens[1]).toBe(0);
    const x = degreeOfSaturation(flow.phases[1]!.y, 0);
    expect(x).toBe(0);
    expect(uniformDelay(60, 0, 0)).toBeCloseTo(0.5 * 60, 12);
  });

  it('reports a per-phase saturation error for a too-short cycle instead of a fake delay', () => {
    // Y = .6 => Ccrit = L/(1-Y) = 25. Cycle 25 forces x=1 everywhere.
    expect(criticalCycle(0.6, 10)).toBeCloseTo(25, 12);
    // just above critical still serves; AT critical it refuses (x = 1)
    expect(() => solveTiming({ ...case3(), cycle: 30 })).not.toThrow();
    expect(() => solveTiming({ ...case3(), cycle: 25 })).toThrowError(
      expect.objectContaining({ code: 'PHASE_SATURATED' }),
    );
  });

  it('reports per-phase saturation when minimum greens starve another phase (Y still < 1)', () => {
    // y = .3/.2/.1 => Y = .6, usable green at C=60 is 50 s. Phase 0 demands a
    // 45 s minimum; phases 1+2 must then share 5 s, so phase 1 (y=.2) needs
    // g >= .2*60 = 12 s to stay under x=1 and saturates instead.
    const input: TimingInput = {
      lostTime: 10,
      cycle: 60,
      phases: [
        { q: 300, s: 1000, minGreen: 45 },
        { q: 200, s: 1000 },
        { q: 100, s: 1000 },
      ],
    };
    expect(() => solveTiming(input)).toThrowError(
      expect.objectContaining({ code: 'PHASE_SATURATED' }),
    );
    // Same case with enough remaining green serves all phases.
    expect(() =>
      solveTiming({
        lostTime: 10,
        cycle: 120,
        phases: [
          { q: 300, s: 1000, minGreen: 45 },
          { q: 200, s: 1000 },
          { q: 100, s: 1000 },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects cycle <= lost time with CYCLE_TOO_SHORT', () => {
    expect(() => solveTiming({ ...case3(), cycle: 10 })).toThrowError(
      expect.objectContaining({ code: 'CYCLE_TOO_SHORT' }),
    );
    expect(() => solveTiming({ ...case3(), cycle: 3 })).toThrowError(
      expect.objectContaining({ code: 'CYCLE_TOO_SHORT' }),
    );
  });
});

describe('intersection-level oversaturation guard (both timing paths)', () => {
  it('refuses before solving when Y is within the 0.01 margin of 1, attaching Y', () => {
    const input: TimingInput = {
      lostTime: 10,
      phases: [
        { q: 500, s: 1000 },
        { q: 490, s: 1000 },
      ], // Y = 0.99
    };
    let err: TimingError | undefined;
    try {
      solveTiming(input);
    } catch (e) {
      err = e as TimingError;
    }
    expect(err).toBeInstanceOf(TimingError);
    expect(err!.code).toBe('OVERSATURATED_Y');
    expect(err!.details!.Y).toBeCloseTo(0.99, 12);
  });

  it('never returns a negative or giant fake cycle at/above the limit', () => {
    for (const Y of [0.99, 1, 1.2]) {
      expect(() => websterOptimalCycle(Y, 10)).toThrowError(
        expect.objectContaining({ code: 'OVERSATURATED_Y' }),
      );
    }
    expect(OVERSATURATION_Y_LIMIT).toBe(0.99);
  });

  it('the explicit-cycle path also refuses: no positive finite timing output', () => {
    const input: TimingInput = {
      lostTime: 10,
      cycle: 60,
      phases: [
        { q: 600, s: 1000 },
        { q: 400, s: 1000 },
      ], // Y = 1
    };
    expect(() => solveTiming(input)).toThrowError(
      expect.objectContaining({ code: 'OVERSATURATED_Y' }),
    );
  });

  it('C0 grows sharply as Y approaches the limit', () => {
    const at = (Y: number) => websterOptimalCycle(Y, 10);
    expect(at(0.9)).toBeGreaterThan(4 * at(0.6)); // (0.1 vs 0.4 denominator => 4x)
    const c1 = at(0.985);
    const c2 = at(0.989);
    expect(c2).toBeGreaterThan(c1);
    expect(c2 / c1).toBeGreaterThan(1.3);
  });
});

describe('monotonicity and allocation locks required by the engineers', () => {
  it('increasing ONLY lost time raises C0 and never lowers any phase uniform delay', () => {
    const r1 = solveTiming(case3({ lostTime: 10 }));
    const r2 = solveTiming(case3({ lostTime: 14 }));
    const r3 = solveTiming(case3({ lostTime: 20 }));
    expect(r2.optimalCycle).toBeGreaterThan(r1.optimalCycle);
    expect(r3.optimalCycle).toBeGreaterThan(r2.optimalCycle);
    for (let i = 0; i < 3; i += 1) {
      expect(r2.phases[i]!.uniformDelay).toBeGreaterThanOrEqual(r1.phases[i]!.uniformDelay);
      expect(r3.phases[i]!.uniformDelay).toBeGreaterThanOrEqual(r2.phases[i]!.uniformDelay);
    }
  });

  it('doubling one phase arrival rate (Y<1) raises its y and lambda and squeezes the others', () => {
    const before = solveTiming(case3());
    const after = solveTiming(case3({ q0: 600 })); // y0: .3 -> .6, Y: .6 -> .9
    expect(after.Y).toBeCloseTo(0.9, 12);
    expect(after.phases[0]!.y).toBeGreaterThan(before.phases[0]!.y);
    expect(after.phases[0]!.lambda).toBeGreaterThan(before.phases[0]!.lambda);
    for (let i = 1; i < 3; i += 1) {
      expect(after.phases[i]!.lambda).toBeLessThan(before.phases[i]!.lambda);
      // share of usable green g/(C-L) drops even though C itself grows
      const shareBefore = before.phases[i]!.g / (before.cycle - before.lostTime);
      const shareAfter = after.phases[i]!.g / (after.cycle - after.lostTime);
      expect(shareAfter).toBeLessThan(shareBefore);
    }
  });

  it('explicit cycle equal to the automatic C0 reproduces lambdas and delays within tolerance', () => {
    const auto = solveTiming(case3());
    const explicit = solveTiming({ ...case3(), cycle: auto.optimalCycle });
    expect(explicit.cycle).toBeCloseTo(auto.cycle, 9);
    for (let i = 0; i < 3; i += 1) {
      expect(explicit.phases[i]!.lambda).toBeCloseTo(auto.phases[i]!.lambda, 12);
      expect(explicit.phases[i]!.uniformDelay).toBeCloseTo(auto.phases[i]!.uniformDelay, 9);
      expect(explicit.phases[i]!.x).toBeCloseTo(auto.phases[i]!.x, 12);
      expect(explicit.phases[i]!.g).toBeCloseTo(auto.phases[i]!.g, 9);
    }
    expect(explicit.totalDelayRate).toBeCloseTo(auto.totalDelayRate, 9);
  });

  it('flow ratios and delays share the SAME arrival rates (no second q set)', () => {
    // Mutating q after construction cannot affect a completed result, and every
    // output field echoes the q that produced it.
    const mutable = [
      { q: 300, s: 1000 },
      { q: 200, s: 1000 },
      { q: 100, s: 1000 },
    ];
    const r = solveTiming({ lostTime: 10, phases: mutable });
    mutable[0]!.q = 9999;
    expect(r.phases[0]!.q).toBe(300);
    expect(r.phases[0]!.y).toBeCloseTo(0.3, 12);
    // delayRate must correspond to q=300, not the mutated value
    expect(r.phases[0]!.delayRate).toBeCloseTo(300 * r.phases[0]!.uniformDelay, 9);
    expect(r.phases[0]!.delayRate).not.toBeCloseTo(9999 * r.phases[0]!.uniformDelay, 6);
  });
});

describe('concurrent independent computations', () => {
  it('parallel solves on different cases never cross-contaminate q, Y, cycle or delay', () => {
    const inputs: TimingInput[] = Array.from({ length: 20 }, (_, k) => ({
      lostTime: 8 + (k % 5) * 2,
      phases: [
        { q: 100 + k * 17, s: 1000 },
        { q: 200 + k * 11, s: 1500 },
        { q: 50 + k * 7, s: 900 },
      ],
    }));
    const results = inputs.map((i) => solveTiming(i));
    results.forEach((r, k) => {
      const expectedY =
        inputs[k]!.phases[0]!.q / 1000 +
        inputs[k]!.phases[1]!.q / 1500 +
        inputs[k]!.phases[2]!.q / 900;
      expect(r.Y).toBeCloseTo(expectedY, 12);
      expect(r.lostTime).toBe(inputs[k]!.lostTime);
      const total = r.phases.reduce((a, p) => a + p.g, 0) + r.lostTime;
      expect(total).toBeCloseTo(r.cycle, 9);
      expect(r.phases[0]!.q).toBe(inputs[k]!.phases[0]!.q);
    });
  });
});
