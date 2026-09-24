import { describe, expect, it } from 'vitest';
import { ScanManager, evaluateScanPoint, validateScanRequest } from './scan';
import { demoScenario } from '../store/seed';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('single-point scan evaluation (always freshly split for that C)', () => {
  it('recomputes lambdas per cycle: lambdas change as C changes', () => {
    const p40 = evaluateScanPoint(demoScenario.phases, demoScenario.lostTime, 45);
    const p90 = evaluateScanPoint(demoScenario.phases, demoScenario.lostTime, 120);
    expect(p40.status).toBe('ok');
    expect(p90.status).toBe('ok');
    expect(p90.phases![0]!.lambda).not.toBeCloseTo(p40.phases![0]!.lambda, 9);
    // lambda = (y/Y)(1 - L/C): longer cycle => larger green ratio (smaller red fraction)
    expect(p90.phases![0]!.lambda).toBeGreaterThan(p40.phases![0]!.lambda);
    // With proportional split x = Y*C/(C-L); it falls as C grows, while the
    // first-term delay itself stays finite at the frontier and grows with C.
    // The classic falling branch of the full U curve comes from the overflow
    // term diverging near the critical cycle Ccrit = L/(1-Y) = 40 s.
    expect(p90.phases![0]!.uniformDelay).toBeGreaterThan(p40.phases![0]!.uniformDelay);
    expect(p90.phases![0]!.x).toBeLessThan(p40.phases![0]!.x);
    expect(p90.phases![0]!.x).toBeCloseTo((0.7 * 120) / (120 - 12), 12);
    expect(p40.phases![0]!.x).toBeCloseTo((0.7 * 45) / (45 - 12), 12);
  });

  it('points match a direct solve (no stored/replayed curve)', () => {
    const point = evaluateScanPoint(demoScenario.phases, demoScenario.lostTime, 77);
    expect(point.status).toBe('ok');
    expect(point.phases![0]!.lambda).toBeCloseTo(0.4 * (77 - 12) / 0.7 / 77, 9);
  });

  it('marks infeasible short cycles as error points instead of emitting bad delays', () => {
    // Y = .6, L = 10 => Ccrit = 25
    const short = evaluateScanPoint(
      [
        { q: 300, s: 1000 },
        { q: 200, s: 1000 },
        { q: 100, s: 1000 },
      ],
      10,
      25,
    );
    expect(short.status).toBe('error');
    expect(short.errorCode).toBe('PHASE_SATURATED');
    expect(short.totalDelayRate).toBeUndefined();
    expect(short.phases).toBeUndefined();
  });

  it('rejects creating a scan for an oversaturated case', () => {
    expect(() =>
      validateScanRequest({
        phases: [
          { q: 600, s: 1000 },
          { q: 400, s: 1000 },
        ],
        lostTime: 10,
        cycles: [60, 90],
      }),
    ).toThrowError(expect.objectContaining({ code: 'OVERSATURATED_Y' }));
  });

  it('validates the candidate cycle list', () => {
    const base = { phases: demoScenario.phases, lostTime: 12 };
    expect(() => validateScanRequest({ ...base, cycles: [] })).toThrow();
    expect(() => validateScanRequest({ ...base, cycles: [60, -1] })).toThrow();
  });
});

describe('ScanManager lifecycle', () => {
  it('completes a sweep and returns one freshly-computed point per candidate', async () => {
    const mgr = new ScanManager();
    const job = mgr.create({
      phases: demoScenario.phases,
      lostTime: demoScenario.lostTime,
      cycles: [50, 76.6667, 120, 200],
    });
    const done = await waitFor(mgr, job.id, (v) => v.state === 'completed');
    expect(done.points).toHaveLength(4);
    expect(done.points.every((p) => p.status === 'ok')).toBe(true);
    // monotone order preserved
    expect(done.points.map((p) => p.cycle)).toEqual([50, 76.6667, 120, 200]);
    // every ok point closes its own balance and carries phases
    for (const p of done.points) {
      expect(p.phases).toHaveLength(4);
    }
  });

  it('keeps infeasible candidates as error points while the rest complete', async () => {
    const mgr = new ScanManager();
    const job = mgr.create({
      phases: [
        { q: 300, s: 1000 },
        { q: 200, s: 1000 },
        { q: 100, s: 1000 },
      ],
      lostTime: 10,
      cycles: [20, 25, 40, 80],
    });
    const done = await waitFor(mgr, job.id, (v) => v.state === 'completed');
    expect(done.points[0]!.status).toBe('error'); // C <= L
    expect(done.points[1]!.status).toBe('error'); // x >= 1
    expect(done.points[2]!.status).toBe('ok');
    expect(done.points[3]!.status).toBe('ok');
  });

  it('is interruptible: a cancelled job never delivers the half-computed point list', async () => {
    const mgr = new ScanManager({ maxPointDelayMs: 1000 });
    const job = mgr.create({
      phases: demoScenario.phases,
      lostTime: demoScenario.lostTime,
      cycles: Array.from({ length: 20 }, (_, i) => 50 + i * 10),
      pointDelayMs: 50,
    });

    // Let a few points accumulate internally.
    await sleep(120);
    const mid = mgr.get(job.id)!;
    expect(mid.completed).toBeGreaterThan(0);
    expect(mid.points).toHaveLength(0); // never exposed mid-flight

    const cancelled = mgr.cancel(job.id);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.points).toHaveLength(0);

    await sleep(150);
    const after = mgr.get(job.id)!;
    expect(after.state).toBe('cancelled');
    expect(after.points).toHaveLength(0); // half results are not promoted later
  });

  it('cancelling an unknown or finished job errors', async () => {
    const mgr = new ScanManager();
    expect(() => mgr.cancel('nope')).toThrowError(
      expect.objectContaining({ code: 'SCAN_NOT_FOUND' }),
    );
    const job = mgr.create({
      phases: demoScenario.phases,
      lostTime: 12,
      cycles: [60],
    });
    await waitFor(mgr, job.id, (v) => v.state === 'completed');
    expect(() => mgr.cancel(job.id)).toThrowError(
      expect.objectContaining({ code: 'SCAN_NOT_RUNNING' }),
    );
  });

  it('recomputes each point even if the same cycle appears twice (no replay cache)', async () => {
    const mgr = new ScanManager();
    const job = mgr.create({
      phases: demoScenario.phases,
      lostTime: demoScenario.lostTime,
      cycles: [90, 90],
    });
    const done = await waitFor(mgr, job.id, (v) => v.state === 'completed');
    expect(done.points).toHaveLength(2);
    expect(done.points[0]!.totalDelayRate).toBeCloseTo(done.points[1]!.totalDelayRate!, 12);
    // distinct point objects => independently produced, not a shared reference
    expect(done.points[0]).not.toBe(done.points[1]);
  });

  it('concurrent sweeps stay isolated', async () => {
    const mgr = new ScanManager();
    const a = mgr.create({
      phases: demoScenario.phases,
      lostTime: 12,
      cycles: [60, 90, 120],
      pointDelayMs: 5,
    });
    const b = mgr.create({
      phases: [
        { q: 300, s: 1000 },
        { q: 200, s: 1000 },
        { q: 100, s: 1000 },
      ],
      lostTime: 10,
      cycles: [40, 80],
      pointDelayMs: 5,
    });
    const [da, db] = await Promise.all([
      waitFor(mgr, a.id, (v) => v.state === 'completed'),
      waitFor(mgr, b.id, (v) => v.state === 'completed'),
    ]);
    expect(da.points).toHaveLength(3);
    expect(db.points).toHaveLength(2);
    expect(da.points[0]!.phases).toHaveLength(4);
    expect(db.points[0]!.phases).toHaveLength(3);
    expect(da.points[0]!.cycle).toBe(60);
    expect(db.points[0]!.cycle).toBe(40);
  });
});

async function waitFor(
  mgr: ScanManager,
  id: string,
  pred: (v: NonNullable<ReturnType<ScanManager['get']>>) => boolean,
) {
  for (let i = 0; i < 200; i += 1) {
    const v = mgr.get(id);
    if (v && pred(v)) return v;
    await sleep(10);
  }
  throw new Error(`timed out waiting for scan ${id}`);
}
