import type { DailyPlanInput, PlanPhase, PlanSegmentInput } from '../domain/types';
import { validateDailyPlan } from '../plan/planValidation';
import { solveDailyPlan } from '../plan/solvePlan';

export const DEMO_PLAN_NAME = 'demo-day-plan';

/**
 * Five-period day for four phases (all s=1800 veh/h, L=10 s):
 *
 *   00:00-06:00 night           Y=.20  C0=25.00
 *   06:00-10:00 NB/SB peak      Y=.75  C0=80.00
 *   10:00-16:00 midday          Y=.60  C0=50.00
 *   16:00-20:00 EB/WB peak      Y=.75  C0=80.00
 *   20:00-24:00 late evening    Y=.55  C0=44.44
 *
 * With maxCycleAdjustment = 20 s every transition walk is feasible under the
 * departing segment's flows (the tightest point, evening -> late at 44.44 s,
 * stays above the evening Ccrit = 10/0.25 = 40 s).
 */
export const demoPlanPhases: PlanPhase[] = [
  { label: 'NB/SB through', s: 1800 },
  { label: 'NB/SB protected left', s: 1800 },
  { label: 'EB/WB through', s: 1800 },
  { label: 'EB/WB protected left', s: 1800 },
];

export const demoPlanSegments: PlanSegmentInput[] = [
  { start: '00:00', end: '06:00', label: 'night', flows: [180, 45, 90, 45] },
  { start: '06:00', end: '10:00', label: 'morning peak', flows: [792, 198, 306, 54] },
  { start: '10:00', end: '16:00', label: 'midday', flows: [450, 135, 360, 135] },
  { start: '16:00', end: '20:00', label: 'evening peak', flows: [306, 54, 792, 198] },
  { start: '20:00', end: '24:00', label: 'late evening', flows: [270, 90, 450, 180] },
];

export const demoDailyPlanInput: DailyPlanInput = {
  lostTime: 10,
  phases: demoPlanPhases,
  segments: demoPlanSegments,
};

export function demoPlanDefinition(): {
  name: string;
  lostTime: number;
  phases: PlanPhase[];
  segments: PlanSegmentInput[];
} {
  return {
    name: DEMO_PLAN_NAME,
    lostTime: demoDailyPlanInput.lostTime,
    phases: demoDailyPlanInput.phases.map((p) => ({ ...p })),
    segments: demoDailyPlanInput.segments.map((seg) => ({ ...seg, flows: [...seg.flows] })),
  };
}

/** Pre-check so a broken seed plan can never ship. */
export function assertDemoPlanSane(): void {
  const parsed = validateDailyPlan(demoDailyPlanInput);
  const solved = solveDailyPlan(parsed, 20);
  if (solved.segments.some((seg) => seg.status !== 'ok')) {
    throw new Error('demo day plan has a segment that does not solve');
  }
  if (solved.transitions.some((t) => t.status !== 'feasible')) {
    throw new Error('demo day plan has an infeasible transition at 20 s/cycle adjustment');
  }
}
