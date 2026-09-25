import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PgDailyPlanStore } from './planPostgres';
import { demoPlanDefinition, assertDemoPlanSane, DEMO_PLAN_NAME } from './planSeed';
import type { DailyPlanStore } from './planTypes';

/**
 * PostgreSQL 16 integration test for the daily-plan archive.
 * Skipped without RUN_PG_TESTS (plain `npm test` on a dev box); the compose
 * `tests` service runs it against the same database as the scenario suite.
 */
const enabled = (process.env.RUN_PG_TESTS ?? '').length > 0;

describe.skipIf(!enabled)('PgDailyPlanStore against PostgreSQL 16', () => {
  let store: DailyPlanStore;

  beforeAll(async () => {
    store = await PgDailyPlanStore.create({ connectRetries: 30 });
  });

  afterAll(async () => {
    await store.close();
  });

  it('the seed day plan is sane', () => {
    expect(() => assertDemoPlanSane()).not.toThrow();
  });

  it('persists, lists, updates and deletes named day plans (definition only)', async () => {
    const demo = demoPlanDefinition();
    await store.upsert(DEMO_PLAN_NAME, {
      lostTime: demo.lostTime,
      phases: demo.phases,
      segments: demo.segments,
    });
    const fetched = await store.get(DEMO_PLAN_NAME);
    expect(fetched).not.toBeNull();
    expect(fetched!.lostTime).toBe(10);
    expect(fetched!.segments).toHaveLength(5);

    const listed = await store.list();
    expect(listed.some((p) => p.name === DEMO_PLAN_NAME)).toBe(true);

    await store.upsert(DEMO_PLAN_NAME, {
      lostTime: 14,
      phases: demo.phases,
      segments: demo.segments,
    });
    const updated = (await store.get(DEMO_PLAN_NAME))!;
    expect(updated.lostTime).toBe(14);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(fetched!.createdAt).getTime(),
    );

    const removed = await store.delete(DEMO_PLAN_NAME);
    expect(removed).toBe(true);
    expect(await store.get(DEMO_PLAN_NAME)).toBeNull();
  });

  it('stored JSON survives a round trip: segments keep exact clocks and flows', async () => {
    const demo = demoPlanDefinition();
    await store.upsert('roundtrip-plan', demo);
    const got = (await store.get('roundtrip-plan'))!;
    expect(got.segments.map((s) => [s.start, s.end])).toEqual(
      demo.segments.map((s) => [s.start, s.end]),
    );
    expect(got.segments.map((s) => s.flows)).toEqual(demo.segments.map((s) => s.flows));
    expect(got.phases.map((p) => p.s)).toEqual(demo.phases.map((p) => p.s));
    await store.delete('roundtrip-plan');
  });
});
