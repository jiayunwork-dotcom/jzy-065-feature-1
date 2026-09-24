import { describe, expect, it, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import { MemoryScenarioStore } from '../store/memory';
import { demoScenario, DEMO_SCENARIO_NAME } from '../store/seed';

let app: FastifyInstance;

beforeAll(async () => {
  const store = new MemoryScenarioStore();
  // Mirror server startup: anyone bringing the service up can log-check the seed.
  await store.upsert(DEMO_SCENARIO_NAME, {
    phases: demoScenario.phases,
    lostTime: demoScenario.lostTime,
  });
  app = await buildApp({ store });
});

const validBody = {
  lostTime: 12,
  phases: demoScenario.phases,
};

describe('POST /api/timing', () => {
  it('returns Y, optimal cycle and green ratios for the demo', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/timing', payload: validBody });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.Y).toBeCloseTo(0.7, 10);
    expect(body.optimalCycle).toBeCloseTo(76.6666666667, 6);
    expect(body.phases).toHaveLength(4);
    const lambdaSum = body.phases.reduce((a: number, p: { lambda: number }) => a + p.lambda, 0);
    expect(lambdaSum).toBeCloseTo(1 - 12 / body.cycle, 9);
  });

  it('maps validation failures to structured 400 errors with reasons', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/timing',
      payload: { lostTime: 12, phases: [{ q: 10, s: 1000 }] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('TOO_FEW_PHASES');
    expect(typeof body.error.message).toBe('string');
  });

  it('refuses oversaturation with 422 and attaches Y before any cycle is produced', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/timing',
      payload: {
        lostTime: 10,
        phases: [
          { q: 500, s: 1000 },
          { q: 495, s: 1000 },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe('OVERSATURATED_Y');
    expect(body.error.details.Y).toBeCloseTo(0.995, 10);
  });

  it('rejects an explicit cycle field on the optimum path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/timing',
      payload: { ...validBody, cycle: 90 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_CYCLE');
  });
});

describe('POST /api/evaluate', () => {
  it('returns per-phase uniform delay, saturation and the intersection total', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/evaluate',
      payload: validBody,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalDelayRate).toBeGreaterThan(0);
    for (const p of body.phases) {
      expect(p.uniformDelay).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(1);
      expect(p.delayRate).toBeCloseTo(p.q * p.uniformDelay, 8);
    }
  });

  it('explicit C0 matches the automatic path within tolerance', async () => {
    const auto = (
      await app.inject({ method: 'POST', url: '/api/evaluate', payload: validBody })
    ).json();
    const explicit = (
      await app.inject({
        method: 'POST',
        url: '/api/evaluate',
        payload: { ...validBody, cycle: auto.optimalCycle },
      })
    ).json();
    expect(explicit.optimalCycle).toBeCloseTo(auto.optimalCycle, 9);
    for (let i = 0; i < 4; i += 1) {
      expect(explicit.phases[i].lambda).toBeCloseTo(auto.phases[i].lambda, 11);
      expect(explicit.phases[i].uniformDelay).toBeCloseTo(auto.phases[i].uniformDelay, 8);
    }
    expect(explicit.totalDelayRate).toBeCloseTo(auto.totalDelayRate, 8);
  });

  it('reports 422 PHASE_SATURATED for a cycle shorter than critical', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/evaluate',
      payload: {
        lostTime: 10,
        cycle: 25,
        phases: [
          { q: 300, s: 1000 },
          { q: 200, s: 1000 },
          { q: 100, s: 1000 },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PHASE_SATURATED');
  });
});

describe('POST /api/scans (interruptible long job)', () => {
  it('creates, runs and exposes the full curve only after completion', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/scans',
      payload: { ...validBody, cycles: [45, 60, 77, 120, 200] },
    });
    expect(created.statusCode).toBe(202);
    const { id } = created.json();
    expect(typeof id).toBe('string');

    let points: unknown[] = [];
    for (let i = 0; i < 50; i += 1) {
      const res = await app.inject({ method: 'GET', url: `/api/scans/${id}` });
      const body = res.json();
      if (body.state === 'completed') {
        points = body.points;
        break;
      }
      expect(body.points).toEqual([]);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(points).toHaveLength(5);
  });

  it('cancelled scan never returns a half point list', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/scans',
      payload: {
        ...validBody,
        cycles: Array.from({ length: 40 }, (_, i) => 50 + i * 5),
        pointDelayMs: 30,
      },
    });
    const { id } = created.json();
    await new Promise((r) => setTimeout(r, 80));
    const cancel = await app.inject({ method: 'DELETE', url: `/api/scans/${id}` });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().state).toBe('cancelled');
    expect(cancel.json().points).toEqual([]);

    const after = await app.inject({ method: 'GET', url: `/api/scans/${id}` });
    expect(after.json().points).toEqual([]);
    expect(after.json().state).toBe('cancelled');
  });

  it('marks infeasible candidate cycles as error points on the curve', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/scans',
      payload: {
        lostTime: 10,
        phases: [
          { q: 300, s: 1000 },
          { q: 200, s: 1000 },
          { q: 100, s: 1000 },
        ],
        cycles: [20, 25, 40, 80], // Ccrit = L/(1-Y) = 25
      },
    });
    const { id } = created.json();
    let body: { state: string; points: Array<{ status: string; errorCode?: string }> } | null = null;
    for (let i = 0; i < 50; i += 1) {
      const res = await app.inject({ method: 'GET', url: `/api/scans/${id}` });
      body = res.json();
      if (body!.state === 'completed') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(body!.state).toBe('completed');
    expect(body!.points.map((p) => p.status)).toEqual(['error', 'error', 'ok', 'ok']);
    expect(body!.points[1]!.errorCode).toBe('PHASE_SATURATED');
  });

  it('404s unknown jobs', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scans/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SCAN_NOT_FOUND');
  });
});

describe('named scenarios', () => {
  it('seeds the demo, fetches it, recomputes, updates and deletes', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/scenarios' });
    expect(list.statusCode).toBe(200);
    expect(list.json().scenarios.some((s: { name: string }) => s.name === DEMO_SCENARIO_NAME)).toBe(
      true,
    );

    const put = await app.inject({
      method: 'PUT',
      url: '/api/scenarios/test-case',
      payload: {
        lostTime: 10,
        phases: [
          { q: 300, s: 1000 },
          { q: 200, s: 1000 },
          { q: 100, s: 1000 },
        ],
      },
    });
    expect(put.statusCode).toBe(200);

    const timing = await app.inject({
      method: 'POST',
      url: `/api/scenarios/test-case/timing`,
    });
    expect(timing.statusCode).toBe(200);
    expect(timing.json().Y).toBeCloseTo(0.6, 10);
    expect(timing.json().optimalCycle).toBeCloseTo(50, 9);

    const evaluate = await app.inject({
      method: 'POST',
      url: `/api/scenarios/test-case/evaluate`,
      payload: { cycle: 80 },
    });
    expect(evaluate.statusCode).toBe(200);
    expect(evaluate.json().cycle).toBe(80);

    const scan = await app.inject({
      method: 'POST',
      url: `/api/scenarios/test-case/scan`,
      payload: { cycles: [40, 60, 80] },
    });
    expect(scan.statusCode).toBe(202);
    const { id } = scan.json();
    let state = 'pending';
    for (let i = 0; i < 50; i += 1) {
      const res = await app.inject({ method: 'GET', url: `/api/scans/${id}` });
      state = res.json().state;
      if (state === 'completed') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(state).toBe('completed');

    const missing = await app.inject({
      method: 'POST',
      url: '/api/scenarios/nope/timing',
    });
    expect(missing.statusCode).toBe(404);

    const del = await app.inject({ method: 'DELETE', url: '/api/scenarios/test-case' });
    expect(del.statusCode).toBe(204);
  });

  it('rejects an invalid scenario definition on PUT (400)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/scenarios/bad',
      payload: { lostTime: -1, phases: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('concurrent requests are isolated', () => {
  it('parallel evaluates keep their own q, Y and cycle', async () => {
    const bodies = Array.from({ length: 12 }, (_, k) => ({
      lostTime: 8 + (k % 4) * 2,
      cycle: 40 + k * 5,
      phases: [
        { q: 100 + k * 20, s: 1000 },
        { q: 200 + k * 13, s: 1500 },
        { q: 50 + k * 7, s: 900 },
      ],
    }));
    const responses = await Promise.all(
      bodies.map((b) => app.inject({ method: 'POST', url: '/api/evaluate', payload: b })),
    );
    responses.forEach((res, k) => {
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.cycle).toBe(40 + k * 5);
      expect(body.lostTime).toBe(bodies[k]!.lostTime);
      expect(body.phases[0]!.q).toBe(bodies[k]!.phases[0]!.q);
      const sumG = body.phases.reduce(
        (a: number, p: { g: number }) => a + p.g,
        0,
      );
      expect(Math.abs(sumG + body.lostTime - body.cycle)).toBeLessThan(1e-8);
    });
  });
});
