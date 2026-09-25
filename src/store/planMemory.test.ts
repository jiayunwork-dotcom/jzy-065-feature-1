import { describe, expect, it } from 'vitest';
import { MemoryDailyPlanStore } from './planMemory';

describe('MemoryDailyPlanStore', () => {
  it('stores definitions, keeps createdAt across updates, and isolates names', async () => {
    const store = new MemoryDailyPlanStore();
    const definition = {
      lostTime: 10,
      phases: [
        { s: 1000 },
        { s: 1000 },
      ],
      segments: [
        { start: '00:00', end: '12:00', flows: [100, 200] },
        { start: '12:00', end: '24:00', flows: [300, 400] },
      ],
    };

    const created = await store.upsert('p1', definition);
    expect(created.name).toBe('p1');
    const updated = await store.upsert('p1', { ...definition, lostTime: 12 });
    expect(updated.lostTime).toBe(12);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(created.updatedAt).getTime(),
    );

    // Mutating the caller's arrays after upsert cannot corrupt the archive.
    definition.segments[0]!.flows[0] = 9999;
    const fetched = (await store.get('p1'))!;
    expect(fetched.segments[0]!.flows[0]).toBe(100);

    expect(await store.get('missing')).toBeNull();
    expect(await store.delete('p1')).toBe(true);
    expect(await store.delete('p1')).toBe(false);
    await store.close();
  });
});
