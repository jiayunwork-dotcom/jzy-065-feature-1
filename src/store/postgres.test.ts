import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PgScenarioStore, PgPlanStore } from './postgres';
import {
  demoDefinition,
  demoPlanDefinition,
  assertDemoSane,
  DEMO_SCENARIO_NAME,
  DEMO_PLAN_NAME,
} from './seed';
import type { PlanStore, ScenarioStore } from './types';

/**
 * PostgreSQL 16 integration test.
 * Skipped automatically when no database is reachable (e.g. plain `npm test`
 * on a dev box). In docker compose the `tests` service runs against the db.
 */
const enabled = (process.env.RUN_PG_TESTS ?? '').length > 0;

describe.skipIf(!enabled)('PgScenarioStore against PostgreSQL 16', () => {
  let store: ScenarioStore;

  beforeAll(async () => {
    store = await PgScenarioStore.create({ connectRetries: 30 });
  });

  afterAll(async () => {
    await store.close();
  });

  it('the seed case is mathematically sane', () => {
    expect(() => assertDemoSane()).not.toThrow();
  });

  it('persists, updates and deletes named scenarios', async () => {
    const demo = demoDefinition();
    await store.upsert(DEMO_SCENARIO_NAME, { phases: demo.phases, lostTime: demo.lostTime });
    const fetched = await store.get(DEMO_SCENARIO_NAME);
    expect(fetched).not.toBeNull();
    expect(fetched!.lostTime).toBe(12);
    expect(fetched!.phases).toHaveLength(4);

    const listed = await store.list();
    expect(listed.some((s) => s.name === DEMO_SCENARIO_NAME)).toBe(true);

    await store.upsert(DEMO_SCENARIO_NAME, {
      phases: demo.phases,
      lostTime: 14,
    });
    const updated = (await store.get(DEMO_SCENARIO_NAME))!;
    expect(updated.lostTime).toBe(14);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(fetched!.createdAt).getTime(),
    );

    const removed = await store.delete(DEMO_SCENARIO_NAME);
    expect(removed).toBe(true);
    expect(await store.get(DEMO_SCENARIO_NAME)).toBeNull();
  });
});

describe.skipIf(!enabled)('PgPlanStore against PostgreSQL 16', () => {
  let store: PlanStore;

  beforeAll(async () => {
    store = await PgPlanStore.create({ connectRetries: 30 });
  });

  afterAll(async () => {
    await store.close();
  });

  it('persists, updates and deletes named day plans (definitions only)', async () => {
    const demo = demoPlanDefinition();
    await store.upsert(DEMO_PLAN_NAME, {
      lostTime: demo.lostTime,
      phases: demo.phases,
      periods: demo.periods,
    });
    const fetched = await store.get(DEMO_PLAN_NAME);
    expect(fetched).not.toBeNull();
    expect(fetched!.lostTime).toBe(12);
    expect(fetched!.phases).toHaveLength(4);
    expect(fetched!.periods).toHaveLength(6);
    expect(fetched!.periods[1]!.q).toEqual([350, 110, 90, 40]);
    expect(fetched!.periods[1]!.start).toBe(360);
    // nothing computed is persisted: the record is the bare definition
    expect(fetched).not.toHaveProperty('timing');
    expect(fetched).not.toHaveProperty('transitions');

    const listed = await store.list();
    expect(listed.some((p) => p.name === DEMO_PLAN_NAME)).toBe(true);

    const modified = demoPlanDefinition();
    modified.periods = modified.periods.map((p, i) =>
      i === 2 ? { ...p, q: [700, 220, 180, 90] } : p,
    );
    await store.upsert(DEMO_PLAN_NAME, {
      lostTime: modified.lostTime,
      phases: modified.phases,
      periods: modified.periods,
    });
    const updated = (await store.get(DEMO_PLAN_NAME))!;
    expect(updated.periods[2]!.q).toEqual([700, 220, 180, 90]);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(fetched!.createdAt).getTime(),
    );

    const removed = await store.delete(DEMO_PLAN_NAME);
    expect(removed).toBe(true);
    expect(await store.get(DEMO_PLAN_NAME)).toBeNull();
  });
});
