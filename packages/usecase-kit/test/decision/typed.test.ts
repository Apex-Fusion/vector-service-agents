// packages/usecase-kit/test/decision/typed.test.ts: `decide` always gives a typed result. A `deps` that is null, and a member of it that throws when it is read, are the typed failure bad_limit. A parser
// that is an async function is the typed failure bad_decision before the hire. A parser that returns a promise is bad_decision after the hire, with the delivery of the paid hire, and the rejection of
// the promise is handled, so none stays unhandled. Each refusal has an accepted twin.
import { afterEach, describe, expect, it } from 'vitest';
import { LLM_ADVERT_REF, LLM_KEY, escrowNo } from '@vsa/hire-kit/testing';
import { accepted } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { decide } from '@vsa/usecase-kit/decision';
import type { ChoiceParser, DecisionDeps, DecisionSpec } from '@vsa/usecase-kit/decision';
import { MEDIUM_LOT, REORDER, STOCK_INPUT, cleanup, deferred, lost, said, setup, won } from './support.ts';
import type { Run } from './support.ts';

afterEach(cleanup);

const MARKER = 'ZQ9-marker-7f3';
const E1 = escrowNo(1);
const nothingHappened = (run: Run): unknown[] => [run.m.calls, run.booked, run.key.stranded.list()];

/** What `act` gives, and the rejections that nobody handled while it ran and during one more turn of the event loop. */
async function unhandledDuring<T>(act: () => Promise<T>): Promise<{ result: T; seen: unknown[] }> {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => { seen.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    const result = await act();
    const turn = deferred();
    setImmediate(turn.resolve);
    await turn.promise;
    return { result, seen };
  } finally {
    process.off('unhandledRejection', listener);
  }
}

const withParser = (parse: unknown): DecisionSpec => ({ name: 'reorder', instruction: REORDER.instruction, parse: parse as ChoiceParser<JsonValue> });

describe('decide: deps that cannot be read', () => {
  const NOT_READ = 'the deps of the decision cannot be read, so its limits cannot be read: nothing was hired';

  it.each<[string, (run: Run) => unknown]>([
    ['null', () => null],
    ['undefined', () => undefined],
    ['a limits member that throws when it is read', (run) => ({ ...run.deps, get limits(): never { throw new Error(`no limits ${MARKER}`); } })],
    ['a key member that throws when it is read', (run) => ({ ...run.deps, get key(): never { throw new Error(`no key ${MARKER}`); } })],
    ['a port that throws when it is read', (run) => ({ ...run.deps, get fetchImpl(): never { throw new Error(`no fetch ${MARKER}`); } })],
  ])('is internal with the reason bad_limit for %s, and nothing is hired', async (_name, make) => {
    const run = await setup();
    const failure = lost(await decide(make(run) as DecisionDeps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.detail, failure.delivery, failure.escrow_ref, failure.stage]).toStrictEqual(['internal', 'bad_limit', NOT_READ, null, null, null]);
    expect(JSON.stringify(failure)).not.toContain(MARKER);
    expect(nothingHappened(run)).toStrictEqual([[], [], []]);
  });

  it('is internal with the reason bad_limit for deps that are a number: the limits are missing', async () => {
    const run = await setup();
    const failure = lost(await decide(5 as unknown as DecisionDeps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason]).toStrictEqual(['internal', 'bad_limit']);
    expect(nothingHappened(run)).toStrictEqual([[], [], []]);
  });

  it('hires for deps that can be read: the twin', async () => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    expect(won(await decide(run.deps, REORDER, STOCK_INPUT)).choice).toStrictEqual(MEDIUM_LOT);
  });
});

describe('decide: a parser that is an async function', () => {
  it.each<[string, (probe: { ran: boolean }) => unknown]>([
    ['an async arrow function that returns a value', (probe) => async (given: JsonValue) => { probe.ran = true; return accepted(given); }],
    ['an async function that rejects', (probe) => async () => { probe.ran = true; throw new Error(MARKER); }],
    ['an async function declaration', (probe) => async function parseChoice(given: JsonValue) { probe.ran = true; return accepted(given); }],
  ])('is refused before the hire, and it never runs: %s', async (_name, make) => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    const probe = { ran: false };
    const { result: failure, seen } = await unhandledDuring(async () => lost(await decide(run.deps, withParser(make(probe)), STOCK_INPUT)));
    expect([failure.code, failure.reason, failure.delivery, failure.escrow_ref, failure.stage]).toStrictEqual(['internal', 'bad_decision', null, null, null]);
    expect(failure.detail).toBe('decision.parse must return its result, and an async function never does: it returns a promise');
    expect(JSON.stringify(failure)).not.toContain(MARKER);
    expect([probe.ran, seen, nothingHappened(run)]).toStrictEqual([false, [], [[], [], []]]);
  });

  it('hires for a parser that is a plain function: the twin', async () => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    expect(won(await decide(run.deps, withParser((given: JsonValue) => accepted(given)), STOCK_INPUT)).choice).toStrictEqual(MEDIUM_LOT);
  });
});

describe('decide: a parser that returns a promise, after the hire', () => {
  it.each<[string, (given: JsonValue) => unknown]>([
    ['a promise that resolves', (given) => Promise.resolve(accepted(given))],
    ['a promise that rejects', () => Promise.reject(new Error(`rejected ${MARKER}`))],
    ['a thenable that rejects', () => ({ then: (_resolve: unknown, reject: (reason: unknown) => void) => { reject(new Error(`rejected ${MARKER}`)); } })],
    ['a thenable whose then throws', () => ({ then: () => { throw new Error(`threw ${MARKER}`); } })],
  ])('is the failure bad_decision with the delivery of the paid hire, and no rejection stays unhandled: %s', async (_name, parse) => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    const { result: failure, seen } = await unhandledDuring(async () => lost(await decide(run.deps, withParser(parse), STOCK_INPUT)));
    expect(seen).toStrictEqual([]);
    expect([failure.code, failure.reason, failure.stage, failure.escrow_ref]).toStrictEqual(['internal', 'bad_decision', 'accept', E1]);
    expect(failure.detail).toBe(`the parser of the decision returned a promise: a parser must return its result, and never a promise; its escrow ${E1} was accepted, so the supplier is paid`);
    expect(failure.delivery).toMatchObject({ accepted: 'confirmed', sub_job: { escrow_ref: E1, advert_ref: LLM_ADVERT_REF, supplier_pkh: LLM_KEY.pkh } });
    expect(JSON.stringify(failure)).not.toContain(MARKER);
    expect('value' in failure).toBe(false);
    // The hire was made and paid, once, and nothing hires again.
    expect(await run.m.chain.escrowState(E1)).toBe('spent');
    expect([run.booked.length, run.m.llm.sends.length]).toStrictEqual([1, 1]);
  });

  it.each<[string, (given: JsonValue) => unknown]>([
    ['an object with a then that is not a function', (given) => ({ ok: true, value: given, then: 5 })],
    ['a function that returns the result', (given) => accepted(given)],
  ])('records the decision for %s: the twin', async (_name, parse) => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    expect(won(await decide(run.deps, withParser(parse), STOCK_INPUT)).choice).toStrictEqual(MEDIUM_LOT);
  });

  it.each<[string, (given: JsonValue) => unknown]>([
    ['a verdict with a then that throws when it is read', () => Object.defineProperty({}, 'then', { get(): never { throw new Error(MARKER); } })],
    ['a verdict that is a Proxy that throws', () => new Proxy({}, { has: () => { throw new Error(MARKER); } })],
  ])('is model_output_invalid, and typed, for %s: the verdict cannot be read', async (_name, parse) => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    const failure = lost(await decide(run.deps, withParser(parse), STOCK_INPUT));
    expect([failure.code, failure.reason, failure.stage, failure.escrow_ref]).toStrictEqual(['model_output_invalid', 'model_output_invalid', 'accept', E1]);
    expect(failure.detail).toContain('has a choice that the parser of the decision could not read');
    expect(JSON.stringify(failure)).not.toContain(MARKER);
  });
});
