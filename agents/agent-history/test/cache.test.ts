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

describe('TtlCache sharing and bounds', () => {
  const deferred = <T,>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; };
  test('callers that arrive while a load is pending share that one load', async () => {
    const c = new TtlCache<string>(60_000);
    const d = deferred<string>();
    let loads = 0;
    const load = () => { loads++; return d.promise; };
    const a = c.getOr('k', load), b = c.getOr('k', load);
    expect(loads).toBe(1);
    d.resolve('report');
    expect(await Promise.all([a, b])).toEqual(['report', 'report']);
    expect(await c.getOr('k', load)).toBe('report'); // and the finished value is served from memory
    expect(loads).toBe(1);
  });
  test('a pending load never expires, and its TTL starts when it finishes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
    const c = new TtlCache<string>(60_000);
    const d = deferred<string>();
    let loads = 0;
    const load = () => { loads++; return d.promise; };
    const a = c.getOr('k', load);
    vi.setSystemTime(120_000); // twice the TTL, still loading
    const b = c.getOr('k', load);
    expect(loads).toBe(1);
    d.resolve('late');
    await Promise.all([a, b]);
    vi.setSystemTime(120_000 + 59_999);
    expect(await c.getOr('k', load)).toBe('late');
    expect(loads).toBe(1);
    vi.setSystemTime(120_000 + 60_000);
    const d2 = deferred<string>(); d2.resolve('again');
    expect(await c.getOr('k', () => { loads++; return d2.promise; })).toBe('again');
    expect(loads).toBe(2);
  });
  test('a load that fails rejects everyone waiting on it and leaves nothing behind', async () => {
    const c = new TtlCache<string>(60_000);
    const d = deferred<string>();
    const a = c.getOr('k', () => d.promise), b = c.getOr('k', () => { throw new Error('must not start a second load'); });
    d.reject(new Error('upstream down'));
    await expect(a).rejects.toThrow('upstream down');
    await expect(b).rejects.toThrow('upstream down');
    expect(c.size).toBe(0);
    expect(await c.getOr('k', async () => 'up again')).toBe('up again');
  });
  test('a loader that throws before returning a promise is a rejection too', async () => {
    const c = new TtlCache<string>(60_000);
    await expect(c.getOr('k', () => { throw new Error('sync failure'); })).rejects.toThrow('sync failure');
    expect(c.size).toBe(0);
  });
  test('expired entries are purged when another entry is added', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
    const c = new TtlCache<string>(60_000);
    await c.getOr('a', async () => 'A'); await c.getOr('b', async () => 'B');
    expect(c.size).toBe(2);
    vi.setSystemTime(30_000);
    await c.getOr('c', async () => 'C'); // a and b are still fresh
    expect(c.size).toBe(3);
    vi.setSystemTime(60_000); // a and b are stale, c has 30 s left
    await c.getOr('d', async () => 'D');
    expect(c.size).toBe(2);
  });
  test('the map is bounded: past the limit the oldest entry is dropped', async () => {
    const c = new TtlCache<number>(60_000, 3);
    for (const k of ['a', 'b', 'c', 'd']) await c.getOr(k, async () => 1);
    expect(c.size).toBe(3);
    let loads = 0;
    await c.getOr('a', async () => ++loads); // a was the oldest and is gone
    expect(loads).toBe(1);
    await c.getOr('d', async () => ++loads); // d is still held
    expect(loads).toBe(1);
  });
  test('the default bound is 1,000 entries', async () => {
    const c = new TtlCache<number>(60_000);
    for (let i = 0; i < 1_050; i++) await c.getOr(`k${i}`, async () => i);
    expect(c.size).toBe(1_000);
  });
});

describe('TtlCache keep predicate', () => {
  test('a value the predicate refuses is returned but not kept: the next caller loads again', async () => {
    const c = new TtlCache<number>(60_000);
    let loads = 0;
    const load = async () => ++loads;
    const keep = (v: number) => v > 1;
    expect(await c.getOr('k', load, keep)).toBe(1);
    expect(c.size).toBe(0);
    expect(await c.getOr('k', load, keep)).toBe(2);
    expect(c.size).toBe(1);
    expect(await c.getOr('k', load, keep)).toBe(2); // kept this time, so served from memory
    expect(loads).toBe(2);
  });
  test('callers that share a pending load all get a refused value, and none of it is kept', async () => {
    const c = new TtlCache<string>(60_000);
    let resolve!: (v: string) => void;
    const pending = new Promise<string>((r) => { resolve = r; });
    const a = c.getOr('k', () => pending, () => false);
    const b = c.getOr('k', () => { throw new Error('must not start a second load'); }, () => false);
    resolve('partial');
    expect(await Promise.all([a, b])).toEqual(['partial', 'partial']);
    expect(c.size).toBe(0);
  });
  test('a predicate that throws counts as a refusal and does not fail the caller', async () => {
    const c = new TtlCache<string>(60_000);
    expect(await c.getOr('k', async () => 'v', () => { throw new Error('predicate bug'); })).toBe('v');
    expect(c.size).toBe(0);
  });
});
