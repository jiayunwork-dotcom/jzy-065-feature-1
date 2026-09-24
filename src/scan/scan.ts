import { randomUUID } from 'node:crypto';
import { TimingError } from '../domain/errors';
import type { ScanJobView, ScanPoint, ScanRequest } from '../domain/types';
import { isFiniteNumber } from '../domain/constants';
import { validateTimingInput } from '../domain/validation';
import { computeFlowRatios } from '../timing/flowRatios';
import { assertIntersectionCapacity } from '../timing/saturation';
import { solveParsed } from '../timing/timing';

/**
 * Error codes that describe a physically infeasible *candidate cycle* (the
 * case itself is valid, but this particular C cannot serve it). Such failures
 * become `error` points on the curve; the scan continues.
 */
const PER_POINT_ERRORS = new Set([
  'CYCLE_TOO_SHORT',
  'PHASE_SATURATED',
  'MIN_GREEN_INFEASIBLE',
]);

/**
 * Evaluate one candidate cycle from scratch.
 *
 * The green ratios are ALWAYS recomputed for this C (g = (C-L)*y/Y, or the
 * minimum-green adjustment); no curve is stored and no point is replayed.
 */
export function evaluateScanPoint(
  phases: ScanRequest['phases'],
  lostTime: number,
  cycle: number,
): ScanPoint {
  const parsed = validateTimingInput({ phases, lostTime, cycle }, { allowCycle: true });
  try {
    const r = solveParsed(parsed);
    return {
      cycle,
      status: 'ok',
      totalDelayRate: r.totalDelayRate,
      phases: r.phases.map((p) => ({
        index: p.index,
        label: p.label,
        lambda: p.lambda,
        x: p.x,
        uniformDelay: p.uniformDelay,
        delayRate: p.delayRate,
      })),
    };
  } catch (err) {
    if (err instanceof TimingError && PER_POINT_ERRORS.has(err.code)) {
      return {
        cycle,
        status: 'error',
        errorCode: err.code,
        error: err.message,
      };
    }
    throw err;
  }
}

/** Validate the scan request once; re-run per point so point errors stay local. */
export function validateScanRequest(input: unknown): {
  phases: ScanRequest['phases'];
  lostTime: number;
  cycles: number[];
  pointDelayMs: number;
} {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TimingError('INVALID_REQUEST', 'request body must be a JSON object');
  }
  const body = input as Record<string, unknown>;
  const parsed = validateTimingInput(
    { phases: body.phases, lostTime: body.lostTime },
    { allowCycle: false },
  );

  if (!Array.isArray(body.cycles) || body.cycles.length === 0) {
    throw new TimingError('INVALID_CYCLE', 'cycles must be a non-empty array of candidate cycle lengths');
  }
  const cycles: number[] = [];
  body.cycles.forEach((c, i) => {
    if (!isFiniteNumber(c) || c <= 0) {
      throw new TimingError(
        'INVALID_CYCLE',
        `cycles[${i}] must be a finite positive number of seconds`,
        { index: i, received: String(c) },
      );
    }
    cycles.push(c);
  });

  let pointDelayMs = 0;
  if (body.pointDelayMs !== undefined && body.pointDelayMs !== null) {
    if (!isFiniteNumber(body.pointDelayMs) || body.pointDelayMs < 0) {
      throw new TimingError('INVALID_REQUEST', 'pointDelayMs must be a finite non-negative number');
    }
    pointDelayMs = body.pointDelayMs as number;
  }

  // Intersection-level oversaturation would make every point meaningless;
  // reject before the job is even created.
  const { Y } = computeFlowRatios(parsed.phases);
  assertIntersectionCapacity(Y);

  return {
    phases: parsed.phases.map((p) => ({
      q: p.q,
      s: p.s,
      ...(p.minGreen !== null ? { minGreen: p.minGreen } : {}),
      ...(p.label !== null ? { label: p.label } : {}),
    })),
    lostTime: parsed.lostTime,
    cycles,
    pointDelayMs,
  };
}

interface JobRecord {
  view: ScanJobView;
  controller: AbortController;
}

export interface ScanManagerOptions {
  /** hard ceiling on inter-point delays accepted from callers */
  maxPointDelayMs?: number;
}

/**
 * In-process registry of interruptible scan jobs.
 *
 * Cancellation semantics: a cancelled job never publishes its half-computed
 * point list — points live in a local array during the run and are attached
 * to the visible job only when the whole sweep completes.
 */
export class ScanManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly maxPointDelayMs: number;

  constructor(opts: ScanManagerOptions = {}) {
    this.maxPointDelayMs = opts.maxPointDelayMs ?? 1000;
  }

  create(rawRequest: unknown): ScanJobView {
    const req = validateScanRequest(rawRequest);
    const delay = Math.min(req.pointDelayMs, this.maxPointDelayMs);
    const id = randomUUID();
    const view: ScanJobView = {
      id,
      state: 'pending',
      total: req.cycles.length,
      completed: 0,
      points: [],
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    const controller = new AbortController();
    this.jobs.set(id, { view, controller });
    // Detach the sweep; completion is observed through GET.
    setImmediate(() => {
      void this.run(view, controller.signal, req.phases, req.lostTime, req.cycles, delay);
    });
    return view;
  }

  get(id: string): ScanJobView | undefined {
    return this.jobs.get(id)?.view;
  }

  cancel(id: string): ScanJobView {
    const job = this.jobs.get(id);
    if (!job) {
      throw new TimingError('SCAN_NOT_FOUND', `scan job ${id} not found`, { id });
    }
    const { view, controller } = job;
    if (view.state === 'completed' || view.state === 'cancelled') {
      throw new TimingError(
        'SCAN_NOT_RUNNING',
        `scan job ${id} is already ${view.state}`,
        { id, state: view.state },
      );
    }
    view.state = 'cancelled';
    view.finishedAt = new Date().toISOString();
    controller.abort();
    return view;
  }

  private async run(
    view: ScanJobView,
    signal: AbortSignal,
    phases: ScanRequest['phases'],
    lostTime: number,
    cycles: number[],
    pointDelayMs: number,
  ): Promise<void> {
    view.state = 'running';
    const computed: ScanPoint[] = [];
    try {
      for (const cycle of cycles) {
        if (signal.aborted) return;
        // Each point: fresh solve with the green split belonging to THIS cycle.
        let point: ScanPoint;
        try {
          point = evaluateScanPoint(phases, lostTime, cycle);
        } catch (err) {
          point = {
            cycle,
            status: 'error',
            errorCode: err instanceof TimingError ? err.code : 'INTERNAL',
            error: err instanceof Error ? err.message : String(err),
          };
        }
        computed.push(point);
        view.completed = computed.length;
        if (signal.aborted) return;
        if (pointDelayMs > 0) {
          await sleep(pointDelayMs, signal);
        }
      }
      if (signal.aborted) return;
      // Publish only the complete curve.
      view.points = computed;
      view.state = 'completed';
      view.finishedAt = new Date().toISOString();
    } catch (err) {
      // Abort or an unexpected failure mid-sweep: never publish a partial
      // curve and never surface an unhandled rejection on the detached job.
      if (!signal.aborted) {
        // A truly unexpected error (per-point errors are already handled above):
        // mark the job finished-but-incomplete without points.
        view.error = err instanceof Error ? err.message : String(err);
      }
      view.points = [];
      view.state = 'cancelled';
      view.finishedAt = new Date().toISOString();
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
