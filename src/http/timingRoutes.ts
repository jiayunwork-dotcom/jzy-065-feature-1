import type { FastifyInstance } from 'fastify';
import { validateTimingInput } from '../domain/validation';
import { solveParsed } from '../timing/timing';
import type { TimingResult } from '../domain/types';

export function serializeResult(r: TimingResult) {
  return {
    Y: r.Y,
    lostTime: r.lostTime,
    optimalCycle: r.optimalCycle,
    cycle: r.cycle,
    cycleSpecified: r.cycleSpecified,
    greenBalanceResidual: r.greenBalanceResidual,
    totalDelayRate: r.totalDelayRate,
    phases: r.phases.map((p) => ({
      index: p.index,
      label: p.label,
      q: p.q,
      s: p.s,
      y: p.y,
      g: p.g,
      minGreen: p.minGreen,
      lambda: p.lambda,
      x: p.x,
      uniformDelay: p.uniformDelay,
      delayRate: p.delayRate,
    })),
  };
}

export async function timingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * (1) POST /api/timing
   *     Submit phases + lost time; get Y, the Webster optimum C0 and each
   *     phase's green ratio (allocation evaluated at C0). An explicit cycle
   *     field is rejected here — that belongs on /api/evaluate.
   */
  app.post('/api/timing', async (request) => {
    const parsed = validateTimingInput(request.body, { allowCycle: false });
    const result = solveParsed(parsed); // oversaturation is refused inside, before solving
    return {
      Y: result.Y,
      lostTime: result.lostTime,
      optimalCycle: result.optimalCycle,
      cycle: result.cycle,
      greenBalanceResidual: result.greenBalanceResidual,
      phases: result.phases.map((p) => ({
        index: p.index,
        label: p.label,
        q: p.q,
        s: p.s,
        y: p.y,
        g: p.g,
        minGreen: p.minGreen,
        lambda: p.lambda,
        x: p.x,
      })),
    };
  });

  /**
   * (2) POST /api/evaluate
   *     Same input, optionally with an explicit cycle; returns per-phase
   *     uniform delay, degree of saturation and the intersection total.
   */
  app.post('/api/evaluate', async (request) => {
    const parsed = validateTimingInput(request.body, { allowCycle: true });
    return serializeResult(solveParsed(parsed));
  });
}
