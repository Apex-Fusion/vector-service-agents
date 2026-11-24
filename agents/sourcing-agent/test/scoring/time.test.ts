// agents/sourcing-agent/test/scoring/time.test.ts: the time rule of a scorer, and the signal of the caller. The review question: does a Delegate go out with less than `SCORER_NEED_MS` left, and is the signal read
// before each Delegate, each token request and each score call, and never passed into a score call? A scorer needs the least wait for 30 confirmations, the job and the end step: it is checked before its run and
// again in the hook, after its turn in the queue of the wallet. With less left it ends `deadline`, and nothing is sent. Every wait of a scorer is trimmed to `deadline_ms`.
import { describe, expect, it } from 'vitest';
import { END_TIMEOUT_MS, MIN_CONFIRMATION_WAIT_MS, SCORER_JOB_TIMEOUT_MS, SCORER_NEED_MS } from '../../src/scoring/index.ts';
import { BIDDERS, GOLDEN_SCORES, NOW, VENDORS_BODY, expectFailed, json, never, scoreAnswerFor, tooYoung } from './support.ts';
import { expectRecordedAndEnded, expectSettled, expectUntouched, idsOf, opsOf, sentKinds, world } from './world.ts';
import type { World } from './world.ts';

const FIRST = GOLDEN_SCORES[0]!.decision;
const SECOND = GOLDEN_SCORES[1]!.decision;

/** One subject only: the first Delegate of the world is the only one. */
const one = (w: World): { input: { subjects: World['input']['subjects'] } } => ({ input: { subjects: w.input.subjects.slice(0, 1) } });

/** The times of the readiness reads, from the start of the world. */
const pollTimes = (w: World): number[] => w.events.filter((event) => event.op === 'readiness').map((event) => event.at - NOW);

describe('the numbers of the rule', () => {
  it('are the least wait for 30 confirmations, the end step and the job, and their sum', () => {
    expect(MIN_CONFIRMATION_WAIT_MS).toBe(180_000);
    expect(END_TIMEOUT_MS).toBe(120_000);
    expect(SCORER_JOB_TIMEOUT_MS).toBe(420_000);
    expect(SCORER_NEED_MS).toBe(MIN_CONFIRMATION_WAIT_MS + SCORER_JOB_TIMEOUT_MS + END_TIMEOUT_MS);
    expect(SCORER_NEED_MS).toBe(720_000);
  });
});

describe('the check before the run of a scorer', () => {
  it('sends the Delegate with exactly SCORER_NEED_MS left, gives the score, and ends the sub-delegation inside the deadline', async () => {
    const w = world();
    const result = await w.run({ ...one(w), deps: { deadline_ms: NOW + SCORER_NEED_MS } });
    expect(result).toStrictEqual({ ok: true, scores: GOLDEN_SCORES.slice(0, 1) });
    expect(sentKinds(w)).toStrictEqual(['delegate', 'undelegate']);
    expect(w.clock.now()).toBeLessThanOrEqual(NOW + SCORER_NEED_MS);
    await expectRecordedAndEnded(w, 1);
  });

  it('sends nothing with one millisecond less, and the code is deadline, for one scorer and for three', async () => {
    const w = world();
    expectFailed(await w.run({ ...one(w), deps: { deadline_ms: NOW + SCORER_NEED_MS - 1 } }), 'deadline');
    expectUntouched(w);
    const three = world();
    expectFailed(await three.run({ deps: { deadline_ms: NOW + SCORER_NEED_MS - 1 } }), 'deadline');
    expectUntouched(three);
    expect(three.logs).toHaveLength(3);
    expect(three.logs.join('\n')).toContain('deadline');
  });

  it.each([
    ['NaN', Number.NaN],
    ['a text', 'later' as unknown as number],
    ['no value', undefined as unknown as number],
    ['minus infinity', Number.NEGATIVE_INFINITY],
    ['a time that has passed', NOW - 1],
  ])('sends nothing when the deadline is %s: a time that is not known is never enough time', async (_what, deadline) => {
    const w = world();
    expectFailed(await w.run({ deps: { deadline_ms: deadline } }), 'deadline');
    expectUntouched(w);
  });

  it('reads the signal before the time: a caller that hung up gives aborted, also when no time is left', async () => {
    const w = world();
    expectFailed(await w.run({ deps: { deadline_ms: NOW }, signal: AbortSignal.abort() }), 'aborted');
    expectUntouched(w);
  });
});

describe('the check in the hook, after the turn in the queue of the wallet', () => {
  /** The clock of the scoring jumps by `jump` milliseconds when the slot of the Delegate is read: the moment right before the hook. */
  function jumpingBeforeTheHook(w: World, jump: number): { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void> } {
    let skew = 0;
    const slotAt = w.chain.slotAt.bind(w.chain);
    w.chain.slotAt = async (ms) => {
      skew = jump;
      return slotAt(ms);
    };
    return { now: () => w.clock.now() + skew, sleep: (ms, signal) => w.clock.sleep(ms, signal) };
  }

  it('sends the Delegate when exactly SCORER_NEED_MS is left at the moment of the send', async () => {
    const w = world();
    const clock = jumpingBeforeTheHook(w, 7);
    const result = await w.run({ ...one(w), deps: { clock, deadline_ms: NOW + SCORER_NEED_MS + 7 } });
    expect(result).toStrictEqual({ ok: true, scores: GOLDEN_SCORES.slice(0, 1) });
    expect(sentKinds(w)).toContain('delegate');
  });

  it('sends nothing when one millisecond less is left at the moment of the send, though the check before the run passed, and the code is deadline', async () => {
    const w = world();
    const clock = jumpingBeforeTheHook(w, 8);
    const result = await w.run({ ...one(w), deps: { clock, deadline_ms: NOW + SCORER_NEED_MS + 7 } });
    expectFailed(result, 'deadline');
    expect(w.chain.builtDelegates).toHaveLength(1);
    expect(w.chain.submitted).toStrictEqual([]);
    expect(w.steps).toStrictEqual([]);
    expect(w.tokenRequests).toStrictEqual([]);
    expect(w.scoreCalls).toStrictEqual([]);
    expect(w.sink.entries.size).toBe(0);
    expect(w.logs).toHaveLength(1);
    expect(w.logs[0]).toMatch(/no Delegate was sent.*deadline/);
  });

  it('refuses a scorer that waited so long in the queue that the time is short: the first and the second send, the third sends nothing, and the code is deadline', async () => {
    const calibrated = world();
    await calibrated.run();
    const waited = calibrated.events.filter((event) => event.op === 'build')[2]!.at - NOW;
    expect(waited).toBeGreaterThan(0);
    const exact = world();
    expect((await exact.run({ deps: { deadline_ms: NOW + SCORER_NEED_MS + waited } })).ok).toBe(true);
    await expectRecordedAndEnded(exact, 3);
    const short = world();
    const result = await short.run({ deps: { deadline_ms: NOW + SCORER_NEED_MS + waited - 1 } });
    expectFailed(result, 'deadline', [FIRST, SECOND]);
    expect(sentKinds(short)).toStrictEqual(['delegate', 'delegate', 'undelegate', 'undelegate']);
    expect(short.chain.builtDelegates).toHaveLength(3);
    expect(short.tokenRequests).toHaveLength(2);
    const third = short.chain.builtDelegates[2]!.id;
    expect(opsOf(short, third)).toStrictEqual([]);
    expect(short.sink.entries.size).toBe(0);
    expect(short.live.size).toBe(0);
    expect(short.logs).toHaveLength(1);
    expect(short.logs[0]).toContain(third);
    expect(JSON.stringify(result)).not.toContain('journal');
    await expectSettled(short);
  });
});

describe('the waits of a scorer are trimmed to the deadline', () => {
  it('waits at most 180 seconds for the 30 confirmations when exactly SCORER_NEED_MS is left, and at most 360 seconds when much more is left', async () => {
    const tight = world();
    tight.chain.faults.neverConfirm = true;
    expectFailed(await tight.run({ ...one(tight), deps: { deadline_ms: NOW + SCORER_NEED_MS } }), 'sub_delegation_confirmation_timeout');
    const tightLast = pollTimes(tight).at(-1)!;
    expect(tightLast).toBeGreaterThan(MIN_CONFIRMATION_WAIT_MS - 10_000);
    expect(tightLast).toBeLessThanOrEqual(MIN_CONFIRMATION_WAIT_MS);
    expect(tight.clock.now()).toBeLessThanOrEqual(NOW + SCORER_NEED_MS);
    const wide = world();
    wide.chain.faults.neverConfirm = true;
    expectFailed(await wide.run({ ...one(wide), deps: { deadline_ms: NOW + 3_000_000 } }), 'sub_delegation_confirmation_timeout');
    const wideLast = pollTimes(wide).at(-1)!;
    expect(wideLast).toBeGreaterThan(350_000);
    expect(wideLast).toBeLessThanOrEqual(360_000);
  });

  it('asks for a token at most for the time that is left to the deadline when that is shorter than two minutes', async () => {
    const w = world();
    let skew = 0;
    const clock = { now: () => w.clock.now() + skew, sleep: (ms: number, signal?: AbortSignal) => w.clock.sleep(ms, signal) };
    const readiness = w.chain.readiness.bind(w.chain);
    w.chain.readiness = async (id) => {
      const state = await readiness(id);
      // From the moment that the job can start, the clock of the scoring says that 50 seconds are left.
      if (state.state === 'ready') skew = SCORER_NEED_MS - 50_000 - (w.clock.now() - NOW);
      return state;
    };
    w.script.requestToken = () => Promise.resolve(tooYoung());
    expectFailed(await w.run({ ...one(w), deps: { clock, deadline_ms: NOW + SCORER_NEED_MS } }), 'scorer_token_failed');
    expect(w.tokenTimes.at(-1)! - w.tokenTimes[0]!).toBe(50_000);
  });

  const HANGS: [string, (w: World) => void, string][] = [
    ['the 30 confirmations do not come', (w) => void (w.chain.faults.neverConfirm = true), 'sub_delegation_confirmation_timeout'],
    ['the gateway never answers', (w) => void (w.script.requestToken = () => never()), 'scorer_timed_out'],
    ['the gateway keeps saying that the delegation is too young', (w) => void (w.script.requestToken = () => Promise.resolve(tooYoung())), 'scorer_token_failed'],
    ['the vendor master never answers', (w) => void (w.script.fetch = () => never<Response>()), 'vendors_failed'],
    ['the decision never answers', (w) => void (w.script.score = () => never()), 'scorer_timed_out'],
    ['the Undelegate never lands', (w) => void (w.chain.faults.undelegateNeverLands = true), ''],
  ];
  it.each(HANGS)('ends no wait after the deadline plus the end step when %s, with exactly SCORER_NEED_MS left', async (_what, setup, code) => {
    const w = world();
    setup(w);
    const result = await w.run({ ...one(w), deps: { deadline_ms: NOW + SCORER_NEED_MS } });
    if (code === '') expect(result.ok).toBe(true);
    else expectFailed(result, code);
    expect(w.clock.now()).toBeLessThanOrEqual(NOW + SCORER_NEED_MS + END_TIMEOUT_MS);
    await expectSettled(w);
  });

  it('ends inside the deadline in the worst case: the token comes at the end of the wait, the decision never answers, and the Undelegate never lands', async () => {
    const w = world();
    const readiness = w.chain.readiness.bind(w.chain);
    w.chain.readiness = async (id) => (w.clock.now() < NOW + 174_000 ? { state: 'waiting' as const, confirmations: 10 } : readiness(id));
    w.script.score = () => never();
    w.chain.faults.undelegateNeverLands = true;
    const result = await w.run({ ...one(w), deps: { deadline_ms: NOW + SCORER_NEED_MS } });
    expectFailed(result, 'scorer_timed_out');
    const spent = w.clock.now() - NOW;
    expect(spent).toBeGreaterThan(SCORER_NEED_MS - 20_000);
    expect(spent).toBeLessThanOrEqual(SCORER_NEED_MS);
    expect(w.sink.entries.size).toBe(1);
    await expectSettled(w);
  });
});

describe('the signal of the caller', () => {
  it('sends nothing for a caller that hung up before the scoring: no Delegate, no token, no read and no decision', async () => {
    const w = world();
    expectFailed(await w.run({ signal: AbortSignal.abort() }), 'aborted');
    expectUntouched(w);
    expect(w.logs).toHaveLength(3);
  });

  it('stops the scorers that wait for their turn when the caller hangs up after the first Delegate, and ends the sub-delegation that was made', async () => {
    const w = world();
    const controller = new AbortController();
    const submit = w.chain.submit.bind(w.chain);
    w.chain.submit = async (cbor) => {
      const hash = await submit(cbor);
      controller.abort();
      return hash;
    };
    expectFailed(await w.run({ signal: controller.signal }), 'aborted');
    expect(sentKinds(w)).toStrictEqual(['delegate', 'undelegate']);
    expect(w.tokenRequests).toStrictEqual([]);
    expect(w.fetched).toStrictEqual([]);
    expect(w.scoreCalls).toStrictEqual([]);
    expect(w.chain.builtDelegates).toHaveLength(3);
    const [sent, second, third] = w.chain.builtDelegates;
    expect(opsOf(w, sent!.id)).toStrictEqual(['add', 'put', 'remove', 'delete']);
    expect(opsOf(w, second!.id)).toStrictEqual([]);
    expect(opsOf(w, third!.id)).toStrictEqual([]);
    expect(w.sink.entries.size).toBe(0);
    expect(w.live.size).toBe(0);
    await expectSettled(w);
  });

  it('asks for no token after the caller hung up: a hang-up during the first token request stops every scorer there, and the sub-delegations are ended', async () => {
    const w = world();
    const controller = new AbortController();
    w.script.requestToken = () => {
      controller.abort();
      return null;
    };
    expectFailed(await w.run({ signal: controller.signal }), 'aborted');
    expect(w.tokenRequests).toHaveLength(1);
    expect(w.fetched).toStrictEqual([]);
    expect(w.scoreCalls).toStrictEqual([]);
    await expectRecordedAndEnded(w, 3);
  });

  it('asks for no decision after the caller hung up: a hang-up during the read of the vendor master gives aborted, and no score call', async () => {
    const w = world();
    const controller = new AbortController();
    w.script.fetch = async () => {
      controller.abort();
      return json(VENDORS_BODY);
    };
    expectFailed(await w.run({ signal: controller.signal }), 'aborted');
    expect(w.fetched).toHaveLength(1);
    expect(w.scoreCalls).toStrictEqual([]);
    await expectRecordedAndEnded(w, 3);
  });

  it('keeps the decision that was already paid for when the caller hangs up during it, never passes the signal into the call, and stops the scorers that have not asked', async () => {
    const w = world();
    const controller = new AbortController();
    w.script.score = async (request) => {
      controller.abort();
      return scoreAnswerFor(request.file.did);
    };
    expectFailed(await w.run({ signal: controller.signal }), 'aborted', [FIRST]);
    expect(w.scoreCalls).toHaveLength(1);
    for (const call of w.scoreCalls) expect('signal' in call.request).toBe(false);
    expect(Object.keys(w.scoreCalls[0]!.request).sort()).toStrictEqual(['file', 'quote', 'rfq', 'today', 'vendor', 'weights']);
    await expectRecordedAndEnded(w, 3);
  });

  it('gives the score of a scorer whose decision ends after the hang-up, when it is the only scorer: the hang-up changes no decision that was paid for', async () => {
    const w = world();
    const controller = new AbortController();
    w.script.score = async (request) => {
      controller.abort();
      return scoreAnswerFor(request.file.did);
    };
    expect(await w.run({ ...one(w), signal: controller.signal })).toStrictEqual({ ok: true, scores: GOLDEN_SCORES.slice(0, 1) });
    await expectRecordedAndEnded(w, 1);
  });

  it('goes through for a caller that stays: the twin', async () => {
    const w = world();
    expect(await w.run({ signal: new AbortController().signal })).toStrictEqual({ ok: true, scores: GOLDEN_SCORES });
    expect(w.scoreCalls.map((call) => call.request.file.did)).toStrictEqual(BIDDERS.map((bidder) => bidder.did));
    expect(idsOf(w)).toHaveLength(3);
  });
});
