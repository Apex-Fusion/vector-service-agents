// packages/usecase-kit/test/access/ports.test.ts: the bounded wait, and the clock of the process. The bounded wait is tested with the clock that the test moves. The clock of the process is tested
// with the fake timers of vitest, because it is the one place of the folder that calls `setTimeout`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { systemClock, within } from '../../src/access/index.ts';
import { FakeClock, NOW, settle } from './support.ts';

describe('within', () => {
  it('gives the value of the work when it ends in time, and leaves no timer', async () => {
    const clock = new FakeClock(NOW);
    const result = await within(clock, 1_000, async () => 'value');
    expect(result).toStrictEqual({ timedOut: false, value: 'value' });
    expect(clock.waiting).toBe(0);
  });

  it('gives timedOut at the bound of the clock, and aborts the signal of the work', async () => {
    const clock = new FakeClock(NOW);
    let signal: AbortSignal | null = null;
    const bounded = within(clock, 1_000, (s) => {
      signal = s;
      return new Promise<never>(() => undefined);
    });
    await clock.advance(999);
    expect(signal!.aborted).toBe(false);
    await clock.advance(1);
    expect(await bounded).toStrictEqual({ timedOut: true });
    expect(signal!.aborted).toBe(true);
    expect(clock.waiting).toBe(0);
  });

  it('is not held by a work that ignores the signal and never ends', async () => {
    const clock = new FakeClock(NOW);
    const bounded = within(clock, 50, () => new Promise<never>(() => undefined));
    await clock.advance(50);
    expect(await bounded).toStrictEqual({ timedOut: true });
  });

  it('drops a failure of the work that comes after the bound, and throws one that comes before', async () => {
    const clock = new FakeClock(NOW);
    let fail: (error: Error) => void = () => undefined;
    const late = within(clock, 100, () => new Promise<never>((_resolve, reject) => (fail = reject)));
    await clock.advance(100);
    expect(await late).toStrictEqual({ timedOut: true });
    fail(new Error('late'));
    await settle();
    await expect(within(clock, 100, async () => Promise.reject(new Error('early')))).rejects.toThrow('early');
    await expect(within(clock, 100, () => { throw new RangeError('sync'); })).rejects.toThrow('sync');
  });
});

describe('the clock of the process', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the time of the system', () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    expect(systemClock.now()).toBe(1_700_000_000_000);
  });

  it('sleeps for the time that it is asked for, and leaves no timer', async () => {
    vi.useFakeTimers();
    let done = false;
    const waiting = systemClock.sleep(40).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(39);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends at once for a signal that has aborted, and ends early and clears its timer when the signal aborts', async () => {
    vi.useFakeTimers();
    const aborted = new AbortController();
    aborted.abort();
    await systemClock.sleep(5_000, aborted.signal);
    expect(vi.getTimerCount()).toBe(0);
    const later = new AbortController();
    const waiting = systemClock.sleep(5_000, later.signal);
    expect(vi.getTimerCount()).toBe(1);
    later.abort();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });
});
