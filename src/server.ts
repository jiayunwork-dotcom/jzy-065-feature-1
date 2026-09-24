import { buildApp } from './app';
import { PgScenarioStore, PgPlanStore } from './store/postgres';
import { MemoryScenarioStore, MemoryPlanStore } from './store/memory';
import type { PlanStore, ScenarioStore } from './store/types';
import { demoDefinition, demoPlanDefinition } from './store/seed';

/**
 * Service entry.
 *
 * Storage:
 *   STORE=memory     in-memory archive (default, also used by unit tests)
 *   STORE=postgres   PostgreSQL 16 archive (docker compose default)
 */
async function main(): Promise<void> {
  const storeType = (process.env.STORE ?? 'memory').toLowerCase();
  let store: ScenarioStore;
  let planStore: PlanStore;

  if (storeType === 'postgres') {
    store = await PgScenarioStore.create();
    planStore = await PgPlanStore.create();
  } else {
    store = new MemoryScenarioStore();
    planStore = new MemoryPlanStore();
  }

  const app = await buildApp({
    store,
    planStore,
    logger: process.env.LOG_LEVEL ? { level: process.env.LOG_LEVEL } : false,
  });

  // Everyone who starts the service can sanity-check against the seed cases.
  const demo = demoDefinition();
  await store.upsert(demo.name, { phases: demo.phases, lostTime: demo.lostTime });
  const demoPlan = demoPlanDefinition();
  await planStore.upsert(demoPlan.name, {
    lostTime: demoPlan.lostTime,
    phases: demoPlan.phases,
    periods: demoPlan.periods,
  });

  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });
  app.log.info(`Webster timing service listening on ${host}:${port} (store=${storeType})`);

  const shutdown = async () => {
    app.log.info('shutting down');
    await app.close();
    await store.close();
    await planStore.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal startup error', err);
  process.exit(1);
});
