import type { DailyPlanRecord, PlanSegmentInput, PlanPhase } from '../domain/types';
import type { DailyPlanStore } from './planTypes';

/**
 * In-memory daily-plan archive (unit/HTTP tests). Kept separate from the
 * single-case {@link MemoryScenarioStore}: the two archives never share rows.
 */
export class MemoryDailyPlanStore implements DailyPlanStore {
  private readonly rows = new Map<string, DailyPlanRecord>();

  async upsert(
    name: string,
    definition: { lostTime: number; phases: PlanPhase[]; segments: PlanSegmentInput[] },
  ): Promise<DailyPlanRecord> {
    const now = new Date().toISOString();
    const existing = this.rows.get(name);
    const record: DailyPlanRecord = {
      name,
      lostTime: definition.lostTime,
      phases: definition.phases.map((p) => ({ ...p })),
      segments: definition.segments.map((s) => ({ ...s, flows: [...s.flows] })),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(name, record);
    return record;
  }

  async get(name: string): Promise<DailyPlanRecord | null> {
    return this.rows.get(name) ?? null;
  }

  async list(): Promise<DailyPlanRecord[]> {
    return [...this.rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async delete(name: string): Promise<boolean> {
    return this.rows.delete(name);
  }

  async close(): Promise<void> {
    this.rows.clear();
  }
}
