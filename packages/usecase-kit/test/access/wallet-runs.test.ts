// packages/usecase-kit/test/access/wallet-runs.test.ts: runs of one agent wallet at one time. Two builds that read the same outputs of the wallet take the same seed and make the same delegation
// identifier, and the node accepts only one of the two transactions. So the build and the send of each Delegate and Undelegate go through the queue of the wallet, a transaction keeps its turn until
// the ledger shows it, and the end step ends only the delegation that its own run made. The ledger of support.ts is faithful to that rule: a transaction takes effect when it lands.
import { describe, expect, it } from 'vitest';
import { createSerialQueue, withSubDelegation } from '../../src/access/index.ts';
import type { LeftSubDelegation, LiveDelegation, SerialQueue, SubDelegationRequest, SubDelegationRun } from '../../src/access/index.ts';
import { takeTurn } from '../../src/access/queue.ts';
import { FakeClock, NOW, PARENT_ID, markSigner, settle, subWorld, type SubWorld } from './support.ts';

/** The three scorers of use case 3: three subagents of one agent, with a key each. */
const scorers = [0, 1, 2].map((n) => ({ did: `did:vector:${(0x50 + n).toString(16).repeat(32)}`, keyHash: (0x40 + n).toString(16).repeat(28) }));
const requestOf = (w: SubWorld, n: number): SubDelegationRequest => ({ ...w.request, subagent: { did: scorers[n]!.did as never, signer: markSigner(scorers[n]!.keyHash) } });

interface Times {
  starts: number[];
  ends: number[];
}
/** Starts the three runs at one time. Each job takes 30 seconds, and notes when it starts and ends. */
function threeRuns(w: SubWorld): { runs: Promise<SubDelegationRun<string>[]>; times: Times } {
  const times: Times = { starts: [], ends: [] };
  const job = (n: number) => async (): Promise<string> => {
    times.starts[n] = w.clock.now();
    await w.clock.sleep(30_000);
    times.ends[n] = w.clock.now();
    return `scorer ${n}`;
  };
  return { runs: Promise.all([0, 1, 2].map((n) => withSubDelegation(w.deps, requestOf(w, n), w.limits, job(n)))), times };
}
const kindsAt = (w: SubWorld, kind: 'delegate' | 'undelegate'): number[] => w.chain.submitted.filter((s) => s.kind === kind).map((s) => s.at);

describe('three runs of one wallet at one time', () => {
  it('each get their own sub-delegation, each job runs, and each end step ends its own', async () => {
    const w = subWorld();
    const { runs, times } = threeRuns(w);
    const results = await w.clock.run(runs);
    expect(results.map((r) => r.kind)).toStrictEqual(['returned', 'returned', 'returned']);
    expect(results.map((r) => r.ok && r.value)).toStrictEqual(['scorer 0', 'scorer 1', 'scorer 2']);
    expect(results.every((r) => r.end.state === 'ended')).toBe(true);
    const ids = w.chain.builtDelegates.map((b) => b.id);
    expect(new Set(ids).size).toBe(3);
    const endHashes = results.map((r) => (r.end.state === 'ended' ? r.end.txHash : ''));
    expect(new Set(endHashes).size).toBe(3);
    expect(endHashes.sort()).toStrictEqual(w.chain.builtUndelegates.map((b) => b.txHash).sort());
    expect(w.chain.builtUndelegates.map((b) => b.id).sort()).toStrictEqual([...ids].sort());
    expect(w.chain.submitted.map((s) => s.kind).filter((k) => k === 'delegate')).toHaveLength(3);
    expect(w.chain.submitted.map((s) => s.kind).filter((k) => k === 'undelegate')).toHaveLength(3);
    for (const id of ids) expect(await w.chain.readDelegation(id), id).toBeNull();
    expect(times.starts).toHaveLength(3);
  });

  it('serves the builds and the sends of the wallet one at a time, each after the ledger showed the one before, while the jobs run at the same time', async () => {
    const w = subWorld();
    const { runs, times } = threeRuns(w);
    await w.clock.run(runs);
    for (const kind of ['delegate', 'undelegate'] as const) {
      const at = kindsAt(w, kind);
      expect(at[1]! - at[0]!, kind).toBeGreaterThanOrEqual(8_000);
      expect(at[2]! - at[1]!, kind).toBeGreaterThanOrEqual(8_000);
    }
    const [first, second] = [times.starts[0]!, times.starts[1]!];
    expect(second).toBeLessThan(times.ends[0]!);
    expect(first).toBeLessThan(second);
    expect(times.starts[2]!).toBeLessThan(times.ends[1]!);
  });

  it('collide when the wallet has no queue, and then the run whose send fails ends nothing of the other runs: the probe of the review', async () => {
    const noQueue: SerialQueue = { run: (task) => task() };
    const w = subWorld({ queue: noQueue });
    const { runs } = threeRuns(w);
    const [first, second, third] = await w.clock.run(runs);
    expect(w.chain.builtDelegates.map((b) => b.id)).toStrictEqual([w.chain.builtDelegates[0]!.id, w.chain.builtDelegates[0]!.id, w.chain.builtDelegates[0]!.id]);
    expect(first).toMatchObject({ ok: true, kind: 'returned', value: 'scorer 0', end: { state: 'ended' } });
    for (const loser of [second, third]) {
      expect(loser).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'submit_failed', detail: expect.stringContaining('BadInputsUTxO') }, end: { state: 'not_made' } });
    }
    expect(w.chain.submitted.filter((s) => s.kind === 'undelegate')).toHaveLength(1);
    expect(w.chain.builtUndelegates).toHaveLength(1);
    expect(await w.chain.readDelegation(w.chain.builtDelegates[0]!.id)).toBeNull();
  });
});

describe('the end step ends only the delegation that its own run made', () => {
  /** A ledger that shows the sub-delegation as made by the transaction that `txHash()` names. */
  function showing(w: SubWorld, txHash: () => string): void {
    const read = w.chain.readDelegation.bind(w.chain);
    w.chain.readDelegation = async (id) => {
      const live = await read(id);
      return live === null || id === PARENT_ID ? live : { ...live, txHash: txHash() };
    };
  }
  const idle = async (): Promise<string> => 'done';

  it('leaves alone a delegation with its identifier that another transaction made: not_made, and no Undelegate is built', async () => {
    const w = subWorld();
    let other = false;
    showing(w, () => (other ? 'ee'.repeat(32) : w.chain.builtDelegates[0]!.txHash));
    const run = await w.clock.run(withSubDelegation(w.deps, w.request, w.limits, async () => ((other = true), 'job')));
    expect(run).toMatchObject({ ok: true, kind: 'returned', value: 'job', end: { state: 'not_made' } });
    expect(w.chain.log).not.toContain('buildUndelegate');
    expect(w.chain.submitted.map((s) => s.kind)).toStrictEqual(['delegate']);
  });

  it('ends the delegation that the Delegate of its own run made: the twin', async () => {
    const w = subWorld();
    showing(w, () => w.chain.builtDelegates[0]!.txHash);
    const run = await w.clock.run(withSubDelegation(w.deps, w.request, w.limits, idle));
    expect(run).toMatchObject({ ok: true, end: { state: 'ended' } });
    expect(w.chain.submitted.map((s) => s.kind)).toStrictEqual(['delegate', 'undelegate']);
  });

  it('stops a run whose Delegate cannot land because the ledger shows another transaction under its identifier, and ends nothing', async () => {
    const w = subWorld();
    showing(w, () => 'ee'.repeat(32));
    const run = await w.clock.run(withSubDelegation(w.deps, w.request, w.limits, idle));
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'submit_failed', detail: expect.stringContaining('another transaction made') }, end: { state: 'not_made' } });
    expect(w.chain.log).not.toContain('buildUndelegate');
    expect(w.chain.log).not.toContain('readiness');
  });
});

describe('a ledger that shows the delegation of this run with a transaction hash that is not a hash', () => {
  /** Plays a ledger whose answer for the sub-delegation is `change` of the true answer. The parent is read as it is. It gives back the read of the ledger as it was. */
  function reading(w: SubWorld, change: (live: LiveDelegation) => unknown): SubWorld['chain']['readDelegation'] {
    const read = w.chain.readDelegation.bind(w.chain);
    w.chain.readDelegation = async (id) => {
      const live = await read(id);
      return (live === null || id === PARENT_ID ? live : change(live)) as never;
    };
    return read;
  }
  const wrong: [string, (live: LiveDelegation) => unknown][] = [
    ['no transaction hash', (live) => ({ id: live.id, delegation: live.delegation })],
    ['the right hash in capital letters', (live) => ({ ...live, txHash: live.txHash.toUpperCase() })],
    ['the right hash with a prefix', (live) => ({ ...live, txHash: `0x${live.txHash}` })],
    ['the right hash with a line end', (live) => ({ ...live, txHash: `${live.txHash}\n` })],
    ['a hash of 63 characters', (live) => ({ ...live, txHash: live.txHash.slice(1) })],
    ['a hash of 65 characters', (live) => ({ ...live, txHash: `${live.txHash}0` })],
    ['an empty hash', (live) => ({ ...live, txHash: '' })],
    ['a hash that is a number', (live) => ({ ...live, txHash: 5 })],
    ['a hash that is null', (live) => ({ ...live, txHash: null })],
    ['an answer that is a text', () => 'live'],
    ['an answer that is undefined', () => undefined],
  ];

  it.each(wrong)('is not read as a delegation of another transaction: %s gives not_ended with the reference, and never not_made', async (_name, change) => {
    const w = subWorld();
    const read = reading(w, change);
    const journal: LeftSubDelegation[] = [];
    const run = await w.clock.run(withSubDelegation({ ...w.deps, beforeSend: (reference) => void journal.push(reference) }, w.request, w.limits, async () => 'job'));
    expect(run).toMatchObject({ ok: true, kind: 'returned', value: 'job' });
    expect(run.end).toMatchObject({ state: 'not_ended', code: 'end_unconfirmed', left: { id: w.chain.subId, delegateTxHash: w.chain.builtDelegates[0]!.txHash, endTxHash: null } });
    expect(run.end.state === 'not_ended' && run.end.left).toStrictEqual(journal[0]);
    expect(w.chain.log).not.toContain('buildUndelegate');
    expect(w.chain.submitted.map((s) => s.kind)).toStrictEqual(['delegate']);
    expect(await read(w.chain.subId!)).not.toBeNull();
  });

  it.each(wrong)('is not read as a delegation of another transaction at the end step either: %s after a run that read the right hash', async (_name, change) => {
    const w = subWorld();
    let jobDone = false;
    const read = reading(w, (live) => (jobDone ? change(live) : live));
    const run = await w.clock.run(withSubDelegation(w.deps, w.request, w.limits, async () => ((jobDone = true), 'job')));
    expect(run).toMatchObject({ ok: true, kind: 'returned', value: 'job', end: { state: 'not_ended', code: 'end_unconfirmed', left: { id: w.chain.subId, endTxHash: null } } });
    expect(w.chain.log).not.toContain('buildUndelegate');
    expect(await read(w.chain.subId!)).not.toBeNull();
  });

  it.each([
    ['the right hash in its form', (live: LiveDelegation) => ({ ...live, txHash: live.txHash }), 'ended'],
    ['the hash of another transaction in the form of a hash', (live: LiveDelegation) => ({ ...live, txHash: 'ee'.repeat(32) }), 'not_made'],
  ] as const)('is read for what it says when the answer has %s: the end is %s, the twin of every answer above', async (_name, change, end) => {
    const w = subWorld();
    let jobDone = false;
    reading(w, (live) => (jobDone ? change(live) : live));
    const run = await w.clock.run(withSubDelegation(w.deps, w.request, w.limits, async () => ((jobDone = true), 'job')));
    expect(run).toMatchObject({ ok: true, kind: 'returned', value: 'job', end: { state: end } });
    expect(w.chain.submitted.map((s) => s.kind)).toStrictEqual(end === 'ended' ? ['delegate', 'undelegate'] : ['delegate']);
  });
});

describe('the queue of the wallet', () => {
  it('gives up the wait for a turn at the bound, builds nothing, and never builds later for the run that gave up', async () => {
    const w = subWorld({ limits: { confirmationWaitMs: 30_000 } });
    let free: () => void = () => undefined;
    void w.deps.walletQueue.run(() => new Promise<void>((resolve) => (free = resolve)));
    const started = w.clock.now();
    const run = await w.clock.run(withSubDelegation(w.deps, w.request, w.limits, async () => 'job'));
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'step_timeout', detail: expect.stringContaining('the turn in the queue of the wallet did not come within 30000 ms') }, end: { state: 'not_made' } });
    expect(w.clock.now() - started).toBe(30_000);
    free();
    await settle();
    expect(w.chain.log).toStrictEqual([]);
    let ran = false;
    void w.deps.walletQueue.run(async () => void (ran = true));
    await settle();
    expect(ran).toBe(true);
  });

  it('is free again after a run whose send failed: the turn is given back', async () => {
    const w = subWorld();
    w.chain.faults.submitDelegateThrows = true;
    await w.clock.run(withSubDelegation(w.deps, w.request, { ...w.limits, endTimeoutMs: 20_000 }, async () => 'job'));
    let ran = false;
    void w.deps.walletQueue.run(async () => void (ran = true));
    await settle();
    expect(ran).toBe(true);
  });

  it('keeps the turn of a Delegate that never lands for the landing wait and not longer: the next build comes then', async () => {
    const w = subWorld({ limits: { landingWaitMs: 20_000, confirmationWaitMs: 60_000, endTimeoutMs: 15_000 } });
    w.chain.faults.delegateNeverLands = true;
    const builds: number[] = [];
    const build = w.chain.buildDelegate.bind(w.chain);
    w.chain.buildDelegate = (params) => (builds.push(w.clock.now()), build(params));
    const results = await w.clock.run(Promise.all([0, 1].map((n) => withSubDelegation(w.deps, requestOf(w, n), w.limits, async () => 'job'))));
    expect(builds).toHaveLength(2);
    expect(builds[1]! - builds[0]!).toBe(20_000);
    expect(results.every((r) => r.kind === 'not_ready')).toBe(true);
  });

  it('makes no run wait for a turn that is free: the first Delegate is built at the start of the run', async () => {
    const w = subWorld();
    const run = w.clock.run(withSubDelegation(w.deps, w.request, w.limits, async () => 'job'));
    await settle();
    expect(w.chain.log.slice(0, 2)).toStrictEqual(['read:parent', 'buildDelegate']);
    expect((await run).kind).toBe('returned');
    expect(w.clock.now()).toBeGreaterThanOrEqual(NOW);
  });
});

describe('createSerialQueue and takeTurn', () => {
  it('runs one task at a time in the order of the calls, gives each result, and goes on after a task that fails', async () => {
    const queue = createSerialQueue();
    const log: string[] = [];
    const task = (name: string, work: () => Promise<string>) => queue.run(async () => (log.push(`start ${name}`), work().finally(() => log.push(`end ${name}`))));
    const a = task('a', async () => (await settle(), 'A'));
    const b = task('b', async () => {
      throw new Error('b broke');
    });
    const c = task('c', async () => 'C');
    expect(await a).toBe('A');
    await expect(b).rejects.toThrow('b broke');
    expect(await c).toBe('C');
    expect(log).toStrictEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('gives a turn at once on an idle queue and the next turn only after the release', async () => {
    const queue = createSerialQueue();
    const clock = new FakeClock(NOW);
    const first = await takeTurn(queue, clock, 1_000);
    expect(first.state).toBe('granted');
    let second = 'waiting';
    const waiting = takeTurn(queue, clock, 5_000).then((turn) => (second = turn.state));
    await settle();
    expect(second).toBe('waiting');
    if (first.state === 'granted') first.release();
    await waiting;
    expect(second).toBe('granted');
    expect(clock.waiting).toBe(0);
  });

  it('gives timed_out at the bound, and the entry that is left does not hold the queue and does not run its work', async () => {
    const queue = createSerialQueue();
    const clock = new FakeClock(NOW);
    const first = await takeTurn(queue, clock, 1_000);
    const second = takeTurn(queue, clock, 500);
    await clock.advance(500);
    expect(await second).toStrictEqual({ state: 'timed_out' });
    if (first.state === 'granted') first.release();
    const third = await takeTurn(queue, clock, 1_000);
    expect(third.state).toBe('granted');
    if (third.state === 'granted') third.release();
  });

  it('gives failed when the queue rejects or throws, and never throws itself', async () => {
    const clock = new FakeClock(NOW);
    const rejecting: SerialQueue = { run: () => Promise.reject(new Error('the queue broke')) };
    const throwing: SerialQueue = {
      run: () => {
        throw new Error('the queue threw');
      },
    };
    expect(await takeTurn(rejecting, clock, 1_000)).toMatchObject({ state: 'failed', error: expect.any(Error) });
    expect(await takeTurn(throwing, clock, 1_000)).toMatchObject({ state: 'failed', error: expect.any(Error) });
  });

  it('is a failure of the run, and not a throw, when the queue of the caller breaks', async () => {
    const w = subWorld({ queue: { run: () => Promise.reject(new Error('the queue broke')) } });
    expect(await w.clock.run(withSubDelegation(w.deps, w.request, w.limits, async () => 'job'))).toMatchObject({ ok: false, failure: { code: 'internal', detail: expect.stringContaining('the queue of the wallet failed') }, end: { state: 'not_made' } });
  });
});
