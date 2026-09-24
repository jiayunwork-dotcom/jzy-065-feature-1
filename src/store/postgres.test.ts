import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PgScenarioStore } from './postgres';
import { demoDefinition, assertDemoSane, DEMO_SCENARIO_NAME } from './seed';
import type { ScenarioStore } from './types';

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
