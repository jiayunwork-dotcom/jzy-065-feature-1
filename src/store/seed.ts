import type { DayPlanInput, PhaseInput, TimingInput } from '../domain/types';
import { solveTiming } from '../timing/timing';
import { validateDayPlan } from '../plan/validation';
import { solveDayPlan } from '../plan/plan';
import { DEFAULT_MAX_CYCLE_STEP } from '../domain/constants';

/**
 * Seed four-phase example (no minimum greens => textbook proportional split).
 *
 *   y1 = 720/1800 = 0.40
 *   y2 = 225/1500 = 0.15
 *   y3 = 180/1800 = 0.10
 *   y4 =  90/1800 = 0.05
 *   Y  = 0.70,  L = 12 s
 *   C0 = (1.5*12 + 5)/(1 - 0.70) = 23/0.3 = 76.67 s   (literature range 50-80)
 */
export const DEMO_SCENARIO_NAME = 'demo-four-phase';

export const demoScenario: TimingInput = {
  lostTime: 12,
  phases: [
    { label: 'NB/SB through', q: 720, s: 1800 },
    { label: 'NB/SB protected left', q: 225, s: 1500 },
    { label: 'EB/WB through', q: 180, s: 1800 },
    { label: 'EB/WB protected left', q: 90, s: 1800 },
  ],
};

export function demoDefinition(): { name: string; phases: PhaseInput[]; lostTime: number } {
  return {
    name: DEMO_SCENARIO_NAME,
    phases: demoScenario.phases.map((p) => ({ ...p })),
    lostTime: demoScenario.lostTime,
  };
}

/** Pre-check so a broken seed can never ship: it must solve cleanly. */
export function assertDemoSane(): void {
  const r = solveTiming(demoScenario);
  if (Math.abs(r.Y - 0.7) > 1e-12) {
    throw new Error(`demo seed Y=${r.Y}, expected 0.7`);
  }
  if (!(r.cycle >= 50 && r.cycle <= 80)) {
    throw new Error(`demo seed C0=${r.cycle}, expected 50..80 s`);
  }
}

/**
 * Seed time-of-day plan for the same demo four-phase intersection. Six
 * periods tile the day; arrival flow swings between periods while the
 * channelization (s) and lost time stay put:
 *
 *   00:00-06:00  night     Y ~ 0.09  C0 ~  25 s
 *   06:00-07:00  shoulder  Y ~ 0.34  C0 ~  35 s
 *   07:00-09:30  AM peak   Y = 0.70  C0 ~  77 s  (the demo scenario itself)
 *   09:30-16:00  midday    Y ~ 0.55  C0 ~  51 s
 *   16:00-19:00  PM peak   Y ~ 0.79  C0 ~ 112 s  (EB/WB-heavy this time)
 *   19:00-24:00  evening   Y ~ 0.25  C0 ~  31 s
 *
 * Every adjacent transition (including the midnight wrap) is feasible at the
 * default 10 s/cycle step.
 */
export const DEMO_PLAN_NAME = 'demo-day-plan';

export const demoDayPlan: DayPlanInput = {
  lostTime: 12,
  phases: [
    { s: 1800, label: 'NB/SB through' },
    { s: 1500, label: 'NB/SB protected left' },
    { s: 1800, label: 'EB/WB through' },
    { s: 1800, label: 'EB/WB protected left' },
  ],
  periods: [
    { start: 0, end: 360, label: 'night', q: [90, 30, 25, 10] },
    { start: 360, end: 420, label: 'morning shoulder', q: [350, 110, 90, 40] },
    { start: 420, end: 570, label: 'AM peak', q: [720, 225, 180, 90] },
    { start: 570, end: 960, label: 'midday', q: [470, 170, 230, 85] },
    { start: 960, end: 1140, label: 'PM peak', q: [400, 150, 650, 200] },
    { start: 1140, end: 1440, label: 'evening', q: [200, 80, 120, 40] },
  ],
};

export function demoPlanDefinition(): {
  name: string;
  lostTime: number;
  phases: DayPlanInput['phases'];
  periods: DayPlanInput['periods'];
} {
  return {
    name: DEMO_PLAN_NAME,
    lostTime: demoDayPlan.lostTime,
    phases: demoDayPlan.phases.map((p) => ({ ...p })),
    periods: demoDayPlan.periods.map((p) => ({ ...p, q: [...p.q] })),
  };
}

/** Pre-check so a broken seed plan can never ship: every period and every
 *  transition (midnight wrap included) must come out clean at the default step. */
export function assertDemoPlanSane(): void {
  const result = solveDayPlan(validateDayPlan(demoDayPlan), DEFAULT_MAX_CYCLE_STEP);
  if (result.periods.length !== 6) {
    throw new Error(`demo plan has ${result.periods.length} periods, expected 6`);
  }
  for (const p of result.periods) {
    if (p.status !== 'ok') {
      throw new Error(`demo plan period ${p.index} failed: ${p.error?.code ?? 'unknown'}`);
    }
  }
  if (result.transitions.length !== 6) {
    throw new Error(`demo plan has ${result.transitions.length} transitions, expected 6`);
  }
  for (const t of result.transitions) {
    if (t.status !== 'feasible') {
      throw new Error(
        `demo plan transition ${t.fromPeriod}->${t.toPeriod} not feasible: ${t.failure?.code ?? t.reason ?? 'unknown'}`,
      );
    }
  }
}
