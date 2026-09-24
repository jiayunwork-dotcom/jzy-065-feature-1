import type { PhaseInput, TimingInput } from '../domain/types';
import { solveTiming } from '../timing/timing';

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
