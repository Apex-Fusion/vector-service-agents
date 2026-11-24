// agents/sourcing-agent/test/execute/time.test.ts: the time of the job `execute`, and the hang-up of its caller. Every wait of the job (the two reads of the ledger, the token and the call) is bounded by the deadline,
// 120,000 ms after the arrival of the job, and a wait that would start after it is not started. The clock is the clock port of the call: a test moves the time by hand, and no test waits. The job reads the signal of
// the caller before the token and before the call, and it never passes the signal into a call. Each form has its twin.
import { describe, expect, it } from 'vitest';
import type { DelegationReading } from '@vsa/usecase-kit/buyer';
import { EXECUTE_DEADLINE_MS } from '../../src/execute/index.ts';
import type { ExecuteDeps } from '../../src/execute/index.ts';
import { ONE_CALL, READ_ONLY, UNTOUCHED, footprint, words, world } from './world.ts';

const COMPLETED = 'completed none Completed';

describe('the deadline', () => {
  it('is 120,000 ms: one token and one call, each bounded by 60,000 ms', () => {
    expect(EXECUTE_DEADLINE_MS).toBe(120_000);
  });

  it('bounds each wait by the time that is left: the two reads and the token wait for the window, and the call waits for its own 60,000 ms', async () => {
    const w = world();
    expect(words(await w.run())).toBe(COMPLETED);
    expect(w.clock.sleeps).toStrictEqual([EXECUTE_DEADLINE_MS, EXECUTE_DEADLINE_MS, EXECUTE_DEADLINE_MS, 60_000]);
  });

  it('lowers every bound to the time that is left when the job arrived earlier: 30,000 ms left give 30,000 ms to each wait and to the call', async () => {
    const w = world();
    expect(words(await w.run(w.request(), w.arrived - 90_000))).toBe(COMPLETED);
    expect(w.clock.sleeps).toStrictEqual([30_000, 30_000, 30_000, 30_000]);
  });

  it('never gives a wait more than the window: a clock that is behind the arrival of the job gives no longer wait', async () => {
    const w = world();
    expect(words(await w.run(w.request(), w.arrived + 50_000))).toBe(COMPLETED);
    expect(w.clock.sleeps).toStrictEqual([EXECUTE_DEADLINE_MS, EXECUTE_DEADLINE_MS, EXECUTE_DEADLINE_MS, 60_000]);
  });

  it('gives the call the shorter of its own limit and the time that is left', async () => {
    const own = world();
    expect(words(await own.run(own.request(), own.arrived, { ...own.deps, calls: { ...own.deps.calls, timeoutMs: 5_000 } }))).toBe(COMPLETED);
    expect(own.clock.sleeps.at(-1)).toBe(5_000);
    const left = world();
    expect(words(await left.run(left.request(), left.arrived - 110_000, { ...left.deps, calls: { ...left.deps.calls, timeoutMs: 50_000 } }))).toBe(COMPLETED);
    expect(left.clock.sleeps.at(-1)).toBe(10_000);
  });

  it('starts no wait when no time is left: a job that arrives at the end of its window reads nothing, asks for nothing and sends nothing', async () => {
    const w = world();
    expect(words(await w.run(w.request(), w.arrived - EXECUTE_DEADLINE_MS))).toBe('failed deadline Failed');
    expect(footprint(w)).toStrictEqual(UNTOUCHED);
    expect(w.clock.sleeps).toStrictEqual([]);
  });

  it('twin: a job with one millisecond left is not stopped', async () => {
    const w = world();
    expect(words(await w.run(w.request(), w.arrived - EXECUTE_DEADLINE_MS + 1))).toBe(COMPLETED);
    expect(w.clock.sleeps).toStrictEqual([1, 1, 1, 1]);
  });

  it('counts a clock that gives no time as no time left: the job ends with deadline and starts no wait', async () => {
    const w = world();
    const deps: ExecuteDeps = { ...w.deps, clock: () => Number.NaN };
    expect(words(await w.run(w.request(), w.arrived, deps))).toBe('failed deadline Failed');
    expect(footprint(w)).toStrictEqual(UNTOUCHED);
  });

  it('takes the time that the token needs from the call: 100,000 ms taken leave 20,000 ms, and the call is bounded by them', async () => {
    const w = world();
    w.hooks.afterAnswer = () => { w.clock.advance(100_000); };
    expect(words(await w.run())).toBe(COMPLETED);
    expect(w.clock.sleeps.at(-1)).toBe(20_000);
  });

  it('twin: a token that takes one second leaves the call its own 60,000 ms', async () => {
    const w = world();
    w.hooks.afterAnswer = () => { w.clock.advance(1_000); };
    expect(words(await w.run())).toBe(COMPLETED);
    expect(w.clock.sleeps.at(-1)).toBe(60_000);
  });
});

describe('a wait that never ends', () => {
  it('ends the read of the delegation at the deadline: failed deadline, and nothing else is asked', async () => {
    const w = world();
    const began = new Promise<void>((resolve) => {
      w.reads.delegation = () => {
        resolve();
        return new Promise<DelegationReading | null>(() => undefined);
      };
    });
    const pending = w.run();
    await began;
    w.clock.advance(EXECUTE_DEADLINE_MS);
    expect(words(await pending)).toBe('failed deadline Failed');
    expect(footprint(w)).toStrictEqual(UNTOUCHED);
  });

  it('ends the read of the delegate key at the deadline: failed deadline, and no token is asked for', async () => {
    const w = world();
    let began: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const deps: ExecuteDeps = {
      ...w.deps,
      delegateKeyOf: () => {
        began();
        return new Promise<string | null>(() => undefined);
      },
    };
    const pending = w.run(w.request(), w.arrived, deps);
    await started;
    w.clock.advance(EXECUTE_DEADLINE_MS);
    expect(words(await pending)).toBe('failed deadline Failed');
    expect(footprint(w)).toStrictEqual(READ_ONLY);
  });

  it('ends the call at its bound: failed mock_system_failed, because the ranking may be written, one call, and the call is not made again', async () => {
    const w = world();
    const began = new Promise<void>((resolve) => { w.record.onCall = resolve; });
    w.record.answer = () => new Promise<Response>(() => undefined);
    const pending = w.run();
    await began;
    w.clock.advance(60_000);
    expect(words(await pending)).toBe('failed mock_system_failed Failed');
    expect(footprint(w)).toStrictEqual(ONE_CALL);
    expect(w.record.written).toHaveLength(0);
    expect(w.log.join('\n')).toContain('the ranking may be written');
  });

  it('ends the call at the end of the window when less time is left than the limit of the call: 30,000 ms left, a call that bounds itself at 30,000 ms', async () => {
    const w = world();
    const began = new Promise<void>((resolve) => { w.record.onCall = resolve; });
    w.record.answer = () => new Promise<Response>(() => undefined);
    const pending = w.run(w.request(), w.arrived - 90_000);
    await began;
    w.clock.advance(29_999);
    expect(w.record.calls).toHaveLength(1);
    w.clock.advance(1);
    expect(words(await pending)).toBe('failed mock_system_failed Failed');
    expect(w.clock.sleeps.at(-1)).toBe(30_000);
  });
});

describe('a caller that hangs up', () => {
  it('before the token: the job asks for no token and sends no call, and it says aborted', async () => {
    const w = world();
    const hangUp = new AbortController();
    hangUp.abort();
    expect(words(await w.run(w.request(), w.arrived, w.deps, hangUp.signal))).toBe('failed aborted Failed');
    expect(footprint(w)).toStrictEqual(READ_ONLY);
  });

  it('after the token and before the call: the job sends no call, and it says aborted', async () => {
    const w = world();
    const hangUp = new AbortController();
    w.hooks.afterAnswer = () => { hangUp.abort(); };
    expect(words(await w.run(w.request(), w.arrived, w.deps, hangUp.signal))).toBe('failed aborted Failed');
    expect(footprint(w)).toStrictEqual({ reads: 1, vaults: 0, tokens: 1, calls: 0 });
    expect(w.record.written).toHaveLength(0);
  });

  it('after the call was sent: the call runs to its end, and the result is the answer of the record', async () => {
    const w = world();
    const hangUp = new AbortController();
    w.record.onCall = () => { hangUp.abort(); };
    expect(words(await w.run(w.request(), w.arrived, w.deps, hangUp.signal))).toBe(COMPLETED);
    expect(footprint(w)).toStrictEqual(ONE_CALL);
  });

  it('twin: a signal that is not aborted changes nothing', async () => {
    const w = world();
    const live = new AbortController();
    expect(words(await w.run(w.request(), w.arrived, w.deps, live.signal))).toBe(COMPLETED);
    expect(footprint(w)).toStrictEqual(ONE_CALL);
  });
});
