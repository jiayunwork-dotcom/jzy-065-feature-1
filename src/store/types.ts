import type { ScenarioRecord } from '../domain/types';

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
