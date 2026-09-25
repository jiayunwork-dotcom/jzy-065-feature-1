import { Pool, type PoolConfig } from 'pg';
import type { DailyPlanRecord, PlanPhase, PlanSegmentInput } from '../domain/types';
import type { DailyPlanStore } from './planTypes';
import { waitForConnection } from './pgConnect';

export interface PgPlanConfig extends PoolConfig {
  /** connection attempts before giving up (waits 1s between attempts) */
  connectRetries?: number;
}

interface PlanRow {
  name: string;
  phases: PlanPhase[] | string;
  segments: PlanSegmentInput[] | string;
  lost_time: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS daily_plans (
  name        TEXT PRIMARY KEY,
  phases      JSONB NOT NULL,
  segments    JSONB NOT NULL,
  lost_time   DOUBLE PRECISION NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/**
 * PostgreSQL-backed daily-plan archive (PostgreSQL 16).
 *
 * Deliberately a separate table and a separate store from the single-case
 * scenario archive: only plan DEFINITIONS live here; cycle lengths, green
 * splits and transition walks are always recomputed on read.
 */
export class PgDailyPlanStore implements DailyPlanStore {
  private readonly pool: Pool;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  static async create(config: PgPlanConfig = {}): Promise<PgDailyPlanStore> {
    const pool = new Pool({
      host: config.host ?? process.env.PGHOST ?? 'localhost',
      port: config.port ?? Number(process.env.PGPORT ?? 5432),
      user: config.user ?? process.env.PGUSER ?? 'webster',
      password: config.password ?? process.env.PGPASSWORD ?? 'webster',
      database: config.database ?? process.env.PGDATABASE ?? 'webster_timing',
      max: config.max ?? 10,
    });
    const retries = config.connectRetries ?? 30;
    await waitForConnection(pool, retries);
    const store = new PgDailyPlanStore(pool);
    await store.migrate();
    return store;
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  async upsert(
    name: string,
    definition: { lostTime: number; phases: PlanPhase[]; segments: PlanSegmentInput[] },
  ): Promise<DailyPlanRecord> {
    const result = await this.pool.query<PlanRow>(
      `INSERT INTO daily_plans (name, phases, segments, lost_time, created_at, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, now(), now())
       ON CONFLICT (name) DO UPDATE
         SET phases = EXCLUDED.phases,
             segments = EXCLUDED.segments,
             lost_time = EXCLUDED.lost_time,
             updated_at = now()
       RETURNING name, phases, segments, lost_time, created_at, updated_at`,
      [
        name,
        JSON.stringify(definition.phases),
        JSON.stringify(definition.segments),
        definition.lostTime,
      ],
    );
    return mapRow(result.rows[0]!);
  }

  async get(name: string): Promise<DailyPlanRecord | null> {
    const result = await this.pool.query<PlanRow>(
      'SELECT name, phases, segments, lost_time, created_at, updated_at FROM daily_plans WHERE name = $1',
      [name],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async list(): Promise<DailyPlanRecord[]> {
    const result = await this.pool.query<PlanRow>(
      'SELECT name, phases, segments, lost_time, created_at, updated_at FROM daily_plans ORDER BY name',
    );
    return result.rows.map(mapRow);
  }

  async delete(name: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM daily_plans WHERE name = $1', [name]);
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function parseJsonb<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

function mapRow(row: PlanRow): DailyPlanRecord {
  return {
    name: row.name,
    phases: parseJsonb<PlanPhase[]>(row.phases),
    segments: parseJsonb<PlanSegmentInput[]>(row.segments),
    lostTime: row.lost_time,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
