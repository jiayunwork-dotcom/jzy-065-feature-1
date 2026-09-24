import { Pool, type PoolConfig } from 'pg';
import type { PhaseInput, PlanRecord, ScenarioRecord, SharedPhaseInput, PlanPeriodInput } from '../domain/types';
import type { PlanStore, ScenarioStore } from './types';

export interface PgConfig extends PoolConfig {
  /** connection attempts before giving up (waits 1s between attempts) */
  connectRetries?: number;
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

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  static async create(config: PgConfig = {}): Promise<PgScenarioStore> {
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
    const store = new PgScenarioStore(pool);
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
    await this.pool.end();
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

interface PlanRow {
  name: string;
  definition: PlanDefinition | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PlanDefinition {
  lostTime: number;
  phases: SharedPhaseInput[];
  periods: PlanPeriodInput[];
}

const PLAN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS day_plans (
  name        TEXT PRIMARY KEY,
  definition  JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/**
 * PostgreSQL-backed day-plan archive. The whole definition (lost time, shared
 * phases, period splits with per-period arrival flows) lives in one JSONB
 * column; solved cycles and transition sequences are never persisted.
 */
export class PgPlanStore implements PlanStore {
  private readonly pool: Pool;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  static async create(config: PgConfig = {}): Promise<PgPlanStore> {
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
    const store = new PgPlanStore(pool);
    await store.migrate();
    return store;
  }

  async migrate(): Promise<void> {
    await this.pool.query(PLAN_SCHEMA_SQL);
  }

  async upsert(
    name: string,
    definition: PlanDefinition,
  ): Promise<PlanRecord> {
    const result = await this.pool.query<PlanRow>(
      `INSERT INTO day_plans (name, definition, created_at, updated_at)
       VALUES ($1, $2::jsonb, now(), now())
       ON CONFLICT (name) DO UPDATE
         SET definition = EXCLUDED.definition,
             updated_at = now()
       RETURNING name, definition, created_at, updated_at`,
      [name, JSON.stringify(definition)],
    );
    return mapPlanRow(result.rows[0]!);
  }

  async get(name: string): Promise<PlanRecord | null> {
    const result = await this.pool.query<PlanRow>(
      'SELECT name, definition, created_at, updated_at FROM day_plans WHERE name = $1',
      [name],
    );
    const row = result.rows[0];
    return row ? mapPlanRow(row) : null;
  }

  async list(): Promise<PlanRecord[]> {
    const result = await this.pool.query<PlanRow>(
      'SELECT name, definition, created_at, updated_at FROM day_plans ORDER BY name',
    );
    return result.rows.map(mapPlanRow);
  }

  async delete(name: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM day_plans WHERE name = $1', [name]);
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function mapPlanRow(row: PlanRow): PlanRecord {
  const definition: PlanDefinition =
    typeof row.definition === 'string'
      ? (JSON.parse(row.definition) as PlanDefinition)
      : row.definition;
  return {
    name: row.name,
    lostTime: definition.lostTime,
    phases: definition.phases,
    periods: definition.periods,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function waitForConnection(pool: Pool, retries: number): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await pool.end();
  throw new Error(
    `database not reachable after ${retries} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}
