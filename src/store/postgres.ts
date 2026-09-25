import { Pool, type PoolConfig } from 'pg';
import type { PhaseInput, ScenarioRecord } from '../domain/types';
import type { ScenarioStore } from './types';
import { waitForConnection } from './pgConnect';

export interface PgConfig extends PoolConfig {
  /** connection attempts before giving up (waits 1s between attempts) */
  connectRetries?: number;
  /** use an existing pool instead of creating one (shared archives) */
  pool?: Pool;
}

interface ScenarioRow {
  name: string;
  phases: PhaseInput[] | string;
  lost_time: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scenarios (
  name        TEXT PRIMARY KEY,
  phases      JSONB NOT NULL,
  lost_time   DOUBLE PRECISION NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/**
 * PostgreSQL-backed scenario archive (target: PostgreSQL 16).
 * Migrations are idempotent and applied at startup.
 */
export class PgScenarioStore implements ScenarioStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  private constructor(pool: Pool, ownsPool: boolean) {
    this.pool = pool;
    this.ownsPool = ownsPool;
  }

  static async create(config: PgConfig = {}): Promise<PgScenarioStore> {
    const pool = config.pool ?? new Pool({
      host: config.host ?? process.env.PGHOST ?? 'localhost',
      port: config.port ?? Number(process.env.PGPORT ?? 5432),
      user: config.user ?? process.env.PGUSER ?? 'webster',
      password: config.password ?? process.env.PGPASSWORD ?? 'webster',
      database: config.database ?? process.env.PGDATABASE ?? 'webster_timing',
      max: config.max ?? 10,
    });
    if (!config.pool) {
      const retries = config.connectRetries ?? 30;
      await waitForConnection(pool, retries);
    }
    const store = new PgScenarioStore(pool, !config.pool);
    await store.migrate();
    return store;
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
  }

  async upsert(
    name: string,
    definition: { phases: PhaseInput[]; lostTime: number },
  ): Promise<ScenarioRecord> {
    const result = await this.pool.query<ScenarioRow>(
      `INSERT INTO scenarios (name, phases, lost_time, created_at, updated_at)
       VALUES ($1, $2::jsonb, $3, now(), now())
       ON CONFLICT (name) DO UPDATE
         SET phases = EXCLUDED.phases,
             lost_time = EXCLUDED.lost_time,
             updated_at = now()
       RETURNING name, phases, lost_time, created_at, updated_at`,
      [name, JSON.stringify(definition.phases), definition.lostTime],
    );
    return mapRow(result.rows[0]!);
  }

  async get(name: string): Promise<ScenarioRecord | null> {
    const result = await this.pool.query<ScenarioRow>(
      'SELECT name, phases, lost_time, created_at, updated_at FROM scenarios WHERE name = $1',
      [name],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async list(): Promise<ScenarioRecord[]> {
    const result = await this.pool.query<ScenarioRow>(
      'SELECT name, phases, lost_time, created_at, updated_at FROM scenarios ORDER BY name',
    );
    return result.rows.map(mapRow);
  }

  async delete(name: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM scenarios WHERE name = $1', [name]);
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

function mapRow(row: ScenarioRow): ScenarioRecord {
  const phases =
    typeof row.phases === 'string'
      ? (JSON.parse(row.phases) as PhaseInput[])
      : row.phases;
  return {
    name: row.name,
    phases,
    lostTime: row.lost_time,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
