import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { TimingError } from './domain/errors';
import { timingRoutes } from './http/timingRoutes';
import { scanRoutes } from './http/scanRoutes';
import { scenarioRoutes } from './http/scenarioRoutes';
import { healthRoutes } from './http/healthRoutes';
import type { ScenarioStore } from './store/types';
import { ScanManager } from './scan/scan';

export interface BuildAppOptions {
  store: ScenarioStore;
  scanManager?: ScanManager;
  logger?: FastifyServerOptions['logger'];
}

export interface AppContext {
  store: ScenarioStore;
  scans: ScanManager;
}

/**
 * Build the Fastify application. The web layer is only an adapter: all
 * formulas live in src/timing and the scan loop in src/scan, so route code
 * never contains timing math.
 */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });  const context: AppContext = {
    store: opts.store,
    scans: opts.scanManager ?? new ScanManager(),
  };
  app.decorate('ctx', context);

  app.setErrorHandler((error: Error & { validation?: unknown; statusCode?: number }, request, reply) => {
    if (error instanceof TimingError) {
      void reply.status(error.statusCode()).send(error.toBody());
      return;
    }
    if (error.validation) {
      void reply.status(400).send({
        error: { code: 'INVALID_REQUEST', message: error.message },
      });
      return;
    }
    if (error.statusCode === 400) {
      void reply.status(400).send({
        error: { code: 'INVALID_REQUEST', message: error.message },
      });
      return;
    }
    request.log.error(error);
    void reply.status(500).send({
      error: { code: 'INTERNAL', message: 'internal server error' },
    });
  });

  await app.register(healthRoutes);
  await app.register(timingRoutes);
  await app.register(scanRoutes);
  await app.register(scenarioRoutes);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
