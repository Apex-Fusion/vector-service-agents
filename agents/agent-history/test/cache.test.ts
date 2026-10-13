import { describe, test, expect, vi, afterEach } from 'vitest';
import { TtlCache } from '../src/cache.ts';
afterEach(() => { vi.useRealTimers(); });
describe('TtlCache', () => {
  test('serves from memory until the TTL has passed, then loads again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
    const c = new TtlCache<number>(60_000);
    let loads = 0;
    const load = async () => ++loads;
    expect(await c.getOr('k', load)).toBe(1);
    vi.setSystemTime(59_999);
    expect(await c.getOr('k', load)).toBe(1);
    expect(loads).toBe(1);
    vi.setSystemTime(60_000); // the TTL is exclusive: at exactly ttl the entry is stale
    expect(await c.getOr('k', load)).toBe(2);
    expect(loads).toBe(2);
  });
  test('keys are independent', async () => {
    const c = new TtlCache<string>(60_000);
    expect(await c.getOr('a', async () => 'A')).toBe('A');
    expect(await c.getOr('b', async () => 'B')).toBe('B');
    expect(await c.getOr('a', async () => 'other')).toBe('A');
  });
  test('a failed load is not cached', async () => {
    const c = new TtlCache<string>(60_000);
    await expect(c.getOr('k', async () => { throw new Error('upstream down'); })).rejects.toThrow('upstream down');
    expect(await c.getOr('k', async () => 'up again')).toBe('up again');
  });
});
