// packages/usecase-kit/test/decision/time.test.ts: no hire starts when the time of the run is over. A decision reads the clock of its deps before it hires. With the deadline of the run past, or less than
// HIRE_MIN_MS away, the result is inference_failed with the reason llm_out_of_time, and nothing is posted. The clock is the port of the deps: the tests move it, and they never wait. Each refusal has
// an accepted twin.
import { afterEach, describe, expect, it } from 'vitest';
import { T0, escrowNo } from '@vsa/hire-kit/testing';
import { HIRE_MIN_MS, decide } from '@vsa/usecase-kit/decision';
import type { DecisionDeps } from '@vsa/usecase-kit/decision';
import { MEDIUM_LOT, REORDER, STOCK_INPUT, cleanup, deferred, lost, said, setup, won } from './support.ts';
import type { Run } from './support.ts';

afterEach(cleanup);

const MARKER = 'ZQ9-marker-7f3';
const NOT_STARTED = 'the model hire for the decision reorder was not started, because the deadline of the run is past or less than 60 seconds away; nothing was locked for it';

describe('decide: the time of the run', () => {
  it('needs 60 seconds before the deadline of the run, the time that the other agents of the marketplace use', () => {
    expect(HIRE_MIN_MS).toBe(60_000);
  });

  it.each<[string, number]>([
    ['the clock at the deadline', 0],
    ['the clock one millisecond past the deadline', -1],
    ['the clock a day past the deadline', -86_400_000],
    ['one millisecond left', 1],
    ['59 seconds and 999 milliseconds left', HIRE_MIN_MS - 1],
  ])('does not hire with %s: llm_out_of_time, and nothing is posted', async (_name, left) => {
    const run = await setup();
    run.deps.deadlineMs = T0 + left;
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.stage, failure.escrow_ref, failure.delivery]).toStrictEqual(['inference_failed', 'llm_out_of_time', null, null, null]);
    expect(failure.detail).toBe(NOT_STARTED);
    // Nothing happened: no call to the indexer or to a supplier, no Post, no escrow for the janitor, and the lane is free.
    expect([run.m.calls, run.booked, run.key.stranded.list()]).toStrictEqual([[], [], []]);
    expect(await run.m.chain.escrowState(escrowNo(1))).toBe('unknown');
    expect(run.key.lane.busy).toBe(false);
  });

  it.each<[string, number]>([
    ['exactly 60 seconds left', HIRE_MIN_MS],
    ['60 seconds and one millisecond left', HIRE_MIN_MS + 1],
    ['a long time left', 1_000_000],
  ])('hires with %s: the twin', async (_name, left) => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    run.deps.deadlineMs = T0 + left;
    expect(won(await decide(run.deps, REORDER, STOCK_INPUT)).choice).toStrictEqual(MEDIUM_LOT);
    expect(run.booked).toHaveLength(1);
  });

  it('reads the clock port when the decision starts: the same deadline refuses when the clock is late and hires when it is early', async () => {
    const late = await setup();
    late.m.clock.now = late.deps.deadlineMs - (HIRE_MIN_MS - 1);
    expect(lost(await decide(late.deps, REORDER, STOCK_INPUT)).reason).toBe('llm_out_of_time');
    expect(late.m.calls).toStrictEqual([]);
    const early = await setup();
    early.m.llm.answer = said(MEDIUM_LOT);
    early.m.clock.now = early.deps.deadlineMs - HIRE_MIN_MS;
    expect(won(await decide(early.deps, REORDER, STOCK_INPUT)).choice).toStrictEqual(MEDIUM_LOT);
  });

  it('refuses a second decision that starts after the clock passed the deadline, and posts nothing for it', async () => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    run.deps.deadlineMs = T0 + HIRE_MIN_MS + 1_000;
    expect(won(await decide(run.deps, REORDER, STOCK_INPUT)).inference.sub_job.escrow_ref).toBe(escrowNo(1));
    run.m.clock.now = run.deps.deadlineMs;
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.reason, failure.escrow_ref, failure.detail]).toStrictEqual(['llm_out_of_time', null, NOT_STARTED]);
    expect(run.booked).toHaveLength(1);
  });

  it('is a hire that runs out of time inside its own waits when it starts with enough time: the failure has its escrow', async () => {
    const run = await setup();
    run.m.llm.steps = ['running'];
    run.deps.deadlineMs = T0 + HIRE_MIN_MS + 4_000;
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.stage, failure.escrow_ref]).toStrictEqual(['inference_failed', 'llm_out_of_time', 'poll', escrowNo(1)]);
    expect(run.booked).toHaveLength(1);
  });
});

describe('decide: a clock that cannot be read is never enough time', () => {
  const with_ = (run: Run, over: Record<string, unknown>): DecisionDeps => ({ ...run.deps, ...over }) as DecisionDeps;
  const NOT_A_FUNCTION = 'the clock of the decision is not a function, or its deadline is not a number: nothing was hired';
  const NOT_READ = 'the clock of the decision cannot be read: nothing was hired';
  const NOT_FINITE = 'the clock of the decision does not give a finite number: nothing was hired';

  it.each<[string, (run: Run) => Record<string, unknown>, string]>([
    ['a clock that throws', () => ({ clock: () => { throw new Error(`no clock ${MARKER}`); } }), NOT_READ],
    ['a clock that gives NaN', () => ({ clock: () => Number.NaN }), NOT_FINITE],
    ['a clock that gives infinity', () => ({ clock: () => Number.POSITIVE_INFINITY }), NOT_FINITE],
    ['a clock that gives a text', () => ({ clock: () => String(T0) }), NOT_FINITE],
    ['a clock that gives nothing', () => ({ clock: () => undefined }), NOT_FINITE],
    ['a clock that is not a function', () => ({ clock: T0 }), NOT_A_FUNCTION],
    ['a deadline that is NaN', () => ({ deadlineMs: Number.NaN }), NOT_A_FUNCTION],
    ['a deadline that is a text', () => ({ deadlineMs: String(T0 + 1_000_000) }), NOT_A_FUNCTION],
    ['a deadline that is missing', () => ({ deadlineMs: undefined }), NOT_A_FUNCTION],
  ])('is internal with the reason bad_deps for %s, and nothing is hired', async (_name, over, detail) => {
    const run = await setup();
    const failure = lost(await decide(with_(run, over(run)), REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.delivery, failure.escrow_ref, failure.stage]).toStrictEqual(['internal', 'bad_deps', null, null, null]);
    expect(failure.detail).toBe(detail);
    expect([run.m.calls, run.booked, run.key.stranded.list()]).toStrictEqual([[], [], []]);
  });

  it('hires for a clock and a deadline that are numbers: the twin', async () => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    expect(won(await decide(with_(run, { clock: () => T0 }), REORDER, STOCK_INPUT)).name).toBe('reorder');
  });
});

describe('decide: a decision that waits in the lane until after the deadline', () => {
  // The check of `decide` is made when the decision starts. A decision that starts with time left, waits for the lane of its key, and gets its turn after the deadline is checked by the hire kit, at
  // the moment when the lane gives the turn. This test turns on when the hire kit has that check.
  it.skip('does not post for it: needs the turn check of the hire kit', async () => {
    const gate = deferred();
    const reached = deferred();
    let held = true;
    const run = await setup({}, (m) => ({ accept: async (ref) => { if (held) { held = false; reached.resolve(); await gate.promise; } return m.chain.accept(ref); } }));
    run.m.llm.answer = said(MEDIUM_LOT);
    const deadline = T0 + 600_000;
    run.deps.deadlineMs = deadline;
    const first = decide(run.deps, REORDER, STOCK_INPUT);
    const second = decide(run.deps, REORDER, STOCK_INPUT);
    await reached.promise;
    // The first decision is in its Accept, and the second waits. The clock passes the deadline, and the first decision ends.
    run.m.clock.now = deadline + 1;
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(won(a).inference.sub_job.escrow_ref).toBe(escrowNo(1));
    const failure = lost(b);
    expect([failure.code, failure.reason, failure.stage, failure.escrow_ref, failure.delivery]).toStrictEqual(['inference_failed', 'llm_out_of_time', 'lane', null, null]);
    // One Post and one send: the second decision posted nothing and locked nothing.
    expect([run.booked.length, run.m.llm.sends.length]).toStrictEqual([1, 1]);
    expect(await run.m.chain.escrowState(escrowNo(2))).toBe('unknown');
    expect(run.key.stranded.list()).toStrictEqual([]);
  });
});
