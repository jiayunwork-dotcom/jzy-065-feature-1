import type { ScenarioRecord } from '../domain/types';
import type { ScenarioStore } from './types';

/**
 * In-memory archive, used by unit/HTTP tests so the web layer needs no
 * PostgreSQL. Isolation is structural: each service instance gets its own
 * map, and concurrent computations share no mutable state.
 */
export class MemoryScenarioStore implements ScenarioStore {
  private readonly rows = new Map<string, ScenarioRecord>();

  async upsert(
    name: string,
    definition: { phases: ScenarioRecord['phases']; lostTime: number },
  ): Promise<ScenarioRecord> {
    const now = new Date().toISOString();
    const existing = this.rows.get(name);
    const record: ScenarioRecord = {
      name,
      phases: definition.phases,
      lostTime: definition.lostTime,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(name, record);
    return record;
  }

  async get(name: string): Promise<ScenarioRecord | null> {
    return this.rows.get(name) ?? null;
  }

  async list(): Promise<ScenarioRecord[]> {
    return [...this.rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async delete(name: string): Promise<boolean> {
    return this.rows.delete(name);
  }

  async close(): Promise<void> {
    this.rows.clear();
  }
}
