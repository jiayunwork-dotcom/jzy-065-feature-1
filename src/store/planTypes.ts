import type { DailyPlanRecord, PlanSegmentInput, PlanPhase } from '../domain/types';

/**
 * Daily-plan archive. Mirrors {@link ScenarioStore} in spirit: only the plan
 * DEFINITION (time-of-day segmentation and per-segment flows) is stored.
 * Cycles, green splits and transition walks are recomputed on every fetch,
 * never pickled results.
 */
export interface DailyPlanStore {
  upsert(
    name: string,
    definition: { lostTime: number; phases: PlanPhase[]; segments: PlanSegmentInput[] },
  ): Promise<DailyPlanRecord>;
  get(name: string): Promise<DailyPlanRecord | null>;
  list(): Promise<DailyPlanRecord[]>;
  delete(name: string): Promise<boolean>;
  close(): Promise<void>;
}
