import { describe, expect, it } from 'vitest';
import { buildTransition, type TransitionRequest } from './transition';
import { solveTiming } from '../timing/timing';
import type { ParsedPhase } from '../domain/validation';
import type { TimingResult } from '../domain/types';
import { BALANCE_TOLERANCE } from '../domain/constants';

const L = 10;

/** Parsed phases with s = 1000 veh/h each; y_i = q_i / 1000. */
function targetPhases(q: number[]): ParsedPhase[] {
  return q.map((v) => ({ q: v, s: 1000, minGreen: null, label: null }));
}

/**
 * Departing period: light demand (Y = 0.4), solved at whatever cycle it
 * currently runs. Only embedded as path element 0 — the transition cycles
 * themselves are always solved against the TARGET demand.
 */
function startTiming(cycle: number): TimingResult {
  return solveTiming({
    lostTime: L,
    cycle,
    phases: [
      { q: 200, s: 1000 },
      { q: 150, s: 1000 },
      { q: 50, s: 1000 },
    ],
  });
}

/** Heavy arriving period: y = .4/.3/.1 => Y = 0.8, so Ccrit = L/(1-Y) = 50 s. */
const HEAVY = [400, 300, 100];

function makeReq(overrides: Partial<TransitionRequest> = {}): TransitionRequest {
  const fromCycle = overrides.fromCycle ?? 60;
  return {
    fromPeriod: 0,
    toPeriod: 1,
    fromCycle,
    toCycle: 100,
    maxStep: 10,
    lostTime: L,
    ...overrides,
    startTiming: overrides.startTiming ?? startTiming(fromCycle),
    targetPhases: overrides.targetPhases ?? targetPhases(HEAVY),
  };
}

describe('transition path: monotone bounded steps landing exactly on the target', () => {
  it('ramps up in maxStep increments and lands exactly on the target cycle', () => {
    const t = buildTransition(makeReq({ fromCycle: 60, toCycle: 100, maxStep: 10 }));
    expect(t.status).toBe('feasible');
    expect(t.steps).toBe(4);
    expect(t.cycles.map((c) => c.cycle)).toEqual([60, 70, 80, 90, 100]);
    expect(t.cycles[0]!.role).toBe('start');
    expect(t.cycles.slice(1).every((c) => c.role === 'transition')).toBe(true);
  });

  it('takes a smaller final step when the gap is not a multiple of maxStep (no overshoot)', () => {
    const t = buildTransition(makeReq({ fromCycle: 60, toCycle: 97, maxStep: 10 }));
    expect(t.status).toBe('feasible');
    expect(t.steps).toBe(4);
    const cycles = t.cycles.map((c) => c.cycle);
    expect(cycles).toEqual([60, 70, 80, 90, 97]);
    // last step is 7 s, not 10, and the sequence never passes 97
    expect(cycles[cycles.length - 1]).toBe(97);
    expect(Math.max(...cycles)).toBe(97);
  });

  it('ramps down monotonically when the target cycle is shorter', () => {
    const t = buildTransition(makeReq({ fromCycle: 100, toCycle: 65, maxStep: 10 }));
    expect(t.status).toBe('feasible');
    expect(t.steps).toBe(4);
    expect(t.cycles.map((c) => c.cycle)).toEqual([100, 90, 80, 70, 65]);
  });

  it('needs zero steps when both periods already run the same cycle', () => {
    const t = buildTransition(makeReq({ fromCycle: 70, toCycle: 70, maxStep: 10 }));
    expect(t.status).toBe('feasible');
    expect(t.steps).toBe(0);
    expect(t.cycles).toHaveLength(1);
    expect(t.cycles[0]!.cycle).toBe(70);
  });

  it('uses the minimum number of steps: ceil(gap / maxStep), growing with the gap', () => {
    const at = (toCycle: number) =>
      buildTransition(makeReq({ fromCycle: 60, toCycle, maxStep: 10 }));
    expect(at(100).steps).toBe(4); // gap 40
    expect(at(140).steps).toBe(8); // gap 80
    expect(at(200).steps).toBe(14); // gap 140
    // and with a fixed gap, a smaller allowed step means more steps
    const fine = buildTransition(makeReq({ fromCycle: 60, toCycle: 100, maxStep: 4 }));
    expect(fine.steps).toBe(10);
    // every path starts exactly on the start cycle and ends exactly on the target
    for (const t of [at(100), at(140), at(200), fine]) {
      expect(t.cycles[0]!.cycle).toBe(60);
      expect(t.cycles[t.cycles.length - 1]!.cycle).toBe(t.toCycle);
      for (let i = 1; i < t.cycles.length; i += 1) {
        const step = t.cycles[i]!.cycle - t.cycles[i - 1]!.cycle;
        expect(step).toBeGreaterThan(0);
        expect(step).toBeLessThanOrEqual(t.maxStep + 1e-9);
      }
    }
  });
});

describe('every transition cycle is a real, freshly solved timing', () => {
  it('re-solves the green split at each intermediate cycle and closes sum(g)+L === C', () => {
    const t = buildTransition(makeReq({ fromCycle: 60, toCycle: 100, maxStep: 10 }));
    expect(t.status).toBe('feasible');
    for (const c of t.cycles) {
      // the embedded timing belongs to THIS cycle, not a replayed one
      expect(c.timing.cycle).toBe(c.cycle);
      expect(c.timing.greenBalanceResidual).toBeLessThanOrEqual(BALANCE_TOLERANCE);
      const sumG = c.timing.phases.reduce((a, p) => a + p.g, 0);
      expect(Math.abs(sumG + c.timing.lostTime - c.cycle)).toBeLessThanOrEqual(
        BALANCE_TOLERANCE,
      );
      for (const p of c.timing.phases) {
        expect(p.lambda).toBeCloseTo(p.g / c.cycle, 12);
        expect(p.x).toBeLessThan(1);
      }
    }
  });

  it('solves transition cycles against the ARRIVING period demand (flowBasis target)', () => {
    const t = buildTransition(makeReq({ fromCycle: 60, toCycle: 100, maxStep: 10 }));
    expect(t.flowBasis).toBe('target');
    // step 0 is the departing period's own cycle (its own light demand)...
    expect(t.cycles[0]!.timing.phases.map((p) => p.q)).toEqual([200, 150, 50]);
    // ...every transition cycle carries the arriving period's arrival rates
    for (const c of t.cycles.slice(1)) {
      expect(c.timing.phases.map((p) => p.q)).toEqual(HEAVY);
      expect(c.timing.Y).toBeCloseTo(0.8, 12);
    }
  });
});

describe('infeasible transitions are called out, not silently emitted', () => {
  // fromCycle 45 < Ccrit 50 of the arriving (heavy) period: intermediate
  // cycles below 50 s cannot serve the arriving demand.
  it('reports the exact step, cycle and phase that saturates', () => {
    const t = buildTransition(makeReq({ fromCycle: 45, toCycle: 100, maxStep: 3 }));
    expect(t.status).toBe('infeasible');
    expect(t.failure).toBeDefined();
    expect(t.failure!.step).toBe(1);
    expect(t.failure!.cycle).toBeCloseTo(48, 9);
    expect(t.failure!.code).toBe('PHASE_SATURATED');
    expect(typeof t.failure!.phaseIndex).toBe('number');
    // only the validated prefix (the start cycle) is exposed — never the
    // physically impossible remainder
    expect(t.cycles).toHaveLength(1);
    expect(t.cycles[0]!.cycle).toBe(45);
  });

  it('a cycle exactly at the critical cycle is saturated (x = 1)', () => {
    const t = buildTransition(makeReq({ fromCycle: 45, toCycle: 100, maxStep: 5 }));
    expect(t.status).toBe('infeasible');
    expect(t.failure!.step).toBe(1);
    expect(t.failure!.cycle).toBeCloseTo(50, 9);
  });

  it('the step size decides feasibility: small steps stall inside the saturated band', () => {
    // Same endpoints, same demand — only the allowed step changes.
    expect(buildTransition(makeReq({ fromCycle: 45, toCycle: 100, maxStep: 3 })).status).toBe(
      'infeasible',
    );
    expect(buildTransition(makeReq({ fromCycle: 45, toCycle: 100, maxStep: 4 })).status).toBe(
      'infeasible',
    );
    const cleared = buildTransition(makeReq({ fromCycle: 45, toCycle: 100, maxStep: 10 }));
    expect(cleared.status).toBe('feasible');
    expect(cleared.cycles.map((c) => c.cycle)).toEqual([45, 55, 65, 75, 85, 95, 100]);
    // and the feasible path is genuinely unsaturated everywhere
    for (const c of cleared.cycles.slice(1)) {
      for (const p of c.timing.phases) {
        expect(p.x).toBeLessThan(1);
      }
    }
  });

  it('ramping DOWN away from a heavy period is feasible at any step (demand fades)', () => {
    // Mirror image: leaving the heavy period for a light 33.3 s cycle. The
    // arriving demand is light, so every intermediate cycle serves it.
    const light = solveTiming({
      lostTime: L,
      phases: [
        { q: 400, s: 1000 },
        { q: 300, s: 1000 },
        { q: 100, s: 1000 },
      ],
    });
    const t = buildTransition(
      makeReq({
        fromCycle: light.cycle, // 100 s, the heavy period's own optimum
        toCycle: 33.333333333333336,
        maxStep: 10,
        startTiming: light,
        targetPhases: targetPhases([200, 150, 50]), // Y = 0.4
      }),
    );
    expect(t.status).toBe('feasible');
    expect(t.cycles[0]!.cycle).toBeCloseTo(100, 9);
    expect(t.cycles[t.cycles.length - 1]!.cycle).toBeCloseTo(100 / 3, 9);
  });
});
