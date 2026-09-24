import type { PlanRecord, ScenarioRecord } from '../domain/types';

/**
 * Scenario archive. Definitions are named and reusable; computed results are
 * never persisted — every retrieval re-runs the analytical chain, keeping
 * flow ratios, cycle and delay consistent with the stored q/s/L.
 */
export interface ScenarioStore {
  upsert(
    name: string,
    definition: { phases: ScenarioRecord['phases']; lostTime: number },
  ): Promise<ScenarioRecord>;
  get(name: string): Promise<ScenarioRecord | null>;
  list(): Promise<ScenarioRecord[]>;
  delete(name: string): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Day-plan archive. Same contract as the scenario archive: only the plan
 * DEFINITION (period time splits, per-period arrival flows, shared
 * channelization, lost time) is persisted — never a solved cycle, green split
 * or transition sequence. Every fetch re-solves from the stored definition.
 */
export interface PlanStore {
  upsert(
    name: string,
    definition: {
      lostTime: number;
      phases: PlanRecord['phases'];
      periods: PlanRecord['periods'];
    },
  ): Promise<PlanRecord>;
  get(name: string): Promise<PlanRecord | null>;
  list(): Promise<PlanRecord[]>;
  delete(name: string): Promise<boolean>;
  close(): Promise<void>;
}
