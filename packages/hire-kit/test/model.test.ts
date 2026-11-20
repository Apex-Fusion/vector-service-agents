// packages/hire-kit/test/model.test.ts
// hireModel against the in-memory marketplace of testing/stub-suppliers.ts, from a paying key: model hires run one after the other from the one service key, one hire for each
// decision, no retry and no fallback, a failed hire is a failure that is thrown once and recorded in the store of the key, and the price ceiling and the two limits of the bonds hold
// what a hire pays, and a hire whose turn in the lane comes after its deadline does not begin. Each refusal has its accepted twin.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeChain } from '@vsa/buyer-core';
import type { Chain } from '@vsa/buyer-core';
import { hireModel } from '../src/model.ts';
import type { ModelAnswer, ModelDeps, ModelErrors, ModelRequest } from '../src/model.ts';
import type { HireFacts, HireLedger, Hired } from '../src/hire.ts';
import { PayingKeys } from '../src/keys.ts';
import type { PayingKey } from '../src/keys.ts';
import { ALLOWLIST, ANSWER, INDEXER, LLM_ADVERT, LLM_ADVERT_REF, T0, chainWith, escrowNo, indexerRow, marketplace } from '../testing/index.ts';
import type { Marketplace } from '../testing/index.ts';

const INPUT = 'Answer in one sentence: what does a bonded escrow hold?';
const CEILING = LLM_ADVERT.price_lovelace;
const SECOND_ENDPOINT = 'https://203.0.113.32';

class CodedError extends Error {
  readonly code: string;
  readonly facts: HireFacts | undefined;
  constructor(code: string, message: string, facts?: HireFacts) {
    super(message);
    this.name = 'CodedError';
    this.code = code;
    this.facts = facts;
  }
}
const ERRORS: ModelErrors<CodedError> = {
  failure: (kind, what, message) => new CodedError(`${kind}_${what}`, message),
  deadline: (doing, facts) => new CodedError('deadline', `The deadline of the job came while ${doing}.`, facts),
  storeWrite: (message) => new CodedError('store_write_failed', message),
  unavailable: (why) => new CodedError('no_model', `No model to hire: ${why}.`),
};

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A promise that the test settles by hand. (Promise.withResolvers is not in the types of this package's target.) */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface Run {
  m: Marketplace; key: PayingKey; deps: ModelDeps; booked: Array<{ lockLovelace: bigint; feeLovelace: bigint }>;
}
/** A marketplace and the paying key of its chain (the chain `over` wraps, when a test needs to see or to hold its calls), with the deps of a hire. */
async function setup(opts: Parameters<typeof marketplace>[0] = {}, wrap?: (m: Marketplace) => Parameters<typeof chainWith>[1]): Promise<Run> {
  const m = marketplace(opts);
  const dir = mkdtempSync(join(tmpdir(), 'hire-kit-model-'));
  dirs.push(dir);
  const key = await new PayingKeys(dir).add(wrap === undefined ? m.chain : chainWith(m, wrap(m)));
  const booked: Run['booked'] = [];
  const ledger: HireLedger = { posted: (post) => { booked.push({ lockLovelace: post.lockLovelace, feeLovelace: post.feeLovelace }); }, accepted: () => undefined };
  const deps: ModelDeps = { clock: () => m.clock.now, sleep: async (ms) => { m.clock.now += ms; }, deadlineMs: T0 + 1_000_000, fetchImpl: m.fetchImpl, indexerUrl: INDEXER, ledger };
  return { m, key, deps, booked };
}
const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  input: INPUT, label: 'the brief', allowlist: ALLOWLIST, maxPriceLovelace: CEILING, ceilingSetting: 'LLM_MAX_PRICE_LOVELACE', maxSupplierBondLovelace: null, maxBuyerBondLovelace: null, ...over,
});
/** What a hire rejects with; the test fails when the hire completes. */
async function thrown(hire: Promise<unknown>): Promise<CodedError> {
  const error = await hire.then(() => { throw new Error('the hire completed'); }, (err: unknown) => err);
  if (!(error instanceof CodedError)) throw error;
  return error;
}

/** The chain of `m`, with each call written to `events` by its name. */
const noting = (m: Marketplace, events: string[]): Partial<Chain> => ({
  wallet: () => { events.push('wallet'); return m.chain.wallet(); },
  postEscrow: (args) => { events.push('postEscrow'); return m.chain.postEscrow(args); },
  accept: (ref) => { events.push('accept'); return m.chain.accept(ref); },
  reclaim: (ref) => { events.push('reclaim'); return m.chain.reclaim(ref); },
  escrowState: (ref) => { events.push('escrowState'); return m.chain.escrowState(ref); },
  onChainReceiptHash: (ref) => { events.push('onChainReceiptHash'); return m.chain.onChainReceiptHash(ref); },
  readAdvert: (ref) => { events.push('readAdvert'); return m.chain.readAdvert(ref); },
});
/** The moment, in milliseconds after T0, at which the first hire of a pair lets go of the lane: its Accept is slow. */
const RELEASE_MS = 90_000;
/**
 * Two hires from one key at one time. The first holds the lane: its Accept waits until the test lets it go, and the clock stands RELEASE_MS after T0 when it does. The second has the deadline
 * `deadlineMs` after T0, and its turn comes when the first has ended. `events` are the calls that the chain got, by name. `held` is what the chain and the fetch had seen while the first hire held
 * the lane and the second waited: whatever comes after it is the second hire's.
 */
async function twoAtOnce(deadlineMs: number): Promise<{ run: Run; events: string[]; held: { events: string[]; calls: number }; first: Hired<ModelAnswer>; second: PromiseSettledResult<Hired<ModelAnswer>> }> {
  const events: string[] = [];
  const gate = deferred();
  const reached = deferred();
  let held = { events: [] as string[], calls: 0 };
  let gated = true;
  const run = await setup({}, (m) => ({
    ...noting(m, events),
    accept: async (ref) => {
      events.push('accept');
      if (gated) { gated = false; held = { events: [...events], calls: m.calls.length }; reached.resolve(); await gate.promise; }
      return m.chain.accept(ref);
    },
  }));
  const first = hireModel(run.key, run.deps, request(), ERRORS);
  const second = hireModel(run.key, { ...run.deps, deadlineMs: T0 + deadlineMs }, request({ input: 'a second question', label: 'the second brief' }), ERRORS);
  const ended = Promise.allSettled([first, second]);
  await reached.promise;
  run.m.clock.now = T0 + RELEASE_MS;
  gate.resolve();
  const [one, two] = await ended;
  if (one.status !== 'fulfilled') throw one.reason;
  return { run, events, held, first: one.value, second: two };
}

describe('hireModel', () => {
  it('hires the chat supplier that the indexer lists, from the key: one Post, the answer, VERIFIED, the Accept confirmed, the lock booked, the store empty', async () => {
    const run = await setup();
    const hired = await hireModel(run.key, run.deps, request(), ERRORS);
    expect(hired.value).toStrictEqual({ text: ANSWER, status: 'completed' });
    expect([hired.verdict.verdict, hired.accepted, hired.record.escrow_ref, hired.record.advert_ref]).toStrictEqual(['VERIFIED', 'confirmed', escrowNo(1), LLM_ADVERT_REF]);
    expect(run.booked).toStrictEqual([{ lockLovelace: FakeChain.LOCK_LOVELACE, feeLovelace: FakeChain.FEE_LOVELACE }]);
    expect(run.key.stranded.list()).toStrictEqual([]);
    expect(run.m.llm.sends).toHaveLength(1);
  });

  it('runs two hires from one key one after the other: the second Post waits for the Accept of the first; the hires of two keys do not wait for each other', async () => {
    const events: string[] = [];
    const gate = deferred();
    const reached = deferred();
    let gated = true;
    const run = await setup({}, (m) => ({
      postEscrow: async (args) => { events.push('post'); return m.chain.postEscrow(args); },
      accept: async (ref) => {
        events.push('accept');
        if (gated) { gated = false; reached.resolve(); await gate.promise; }
        return m.chain.accept(ref);
      },
    }));
    const first = hireModel(run.key, run.deps, request(), ERRORS);
    const second = hireModel(run.key, run.deps, request({ input: 'a second question' }), ERRORS);
    await reached.promise;
    // The first hire is in its Accept, held. The second has not posted: it waits for the lane of the key.
    expect(events).toStrictEqual(['post', 'accept']);
    expect(run.key.lane.busy).toBe(true);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toStrictEqual(['post', 'accept', 'post', 'accept']);
    // The twin: another key has a lane of its own, and its hire completes while the first key's Accept is held.
    const heldGate = deferred();
    const heldReached = deferred();
    const keyA = await setup({ buyerPkh: 'aa'.repeat(28) }, (m) => ({ accept: async (ref) => { heldReached.resolve(); await heldGate.promise; return m.chain.accept(ref); } }));
    const keyB = await setup({ buyerPkh: 'dd'.repeat(28) });
    const holding = hireModel(keyA.key, keyA.deps, request(), ERRORS);
    await heldReached.promise;
    const other = await hireModel(keyB.key, keyB.deps, request(), ERRORS);
    expect(other.accepted).toBe('confirmed');
    expect(keyA.key.lane.busy).toBe(true);
    heldGate.resolve();
    expect((await holding).accepted).toBe('confirmed');
  });

  it('makes one hire for one decision: a supplier that refuses ends the call with the error of the factory, once, with one Post and one send, and no other supplier is asked', async () => {
    const run = await setup();
    // A second supplier that the indexer lists: a fallback would find it. Nothing may call it.
    run.m.rows.push(indexerRow(`${'d4'.repeat(32)}#0`, { ...LLM_ADVERT, endpoint_url: SECOND_ENDPOINT }));
    run.m.llm.refuse = { status: 422, reason: 'bad_input' };
    const error = await thrown(hireModel(run.key, run.deps, request(), ERRORS));
    expect(error.code).toBe('llm_refused');
    expect(run.m.llm.sends).toHaveLength(1);
    expect(run.booked).toHaveLength(1);
    // No second Post: the chain knows no second escrow.
    expect(await run.m.chain.escrowState(escrowNo(2))).toBe('unknown');
    expect(run.m.calls.filter((call) => new URL(call.url).origin === SECOND_ENDPOINT)).toStrictEqual([]);
    // The failure is recorded: the escrow is in the store of the key, for its janitor.
    expect(run.key.stranded.list().map((entry) => [entry.escrow_ref, entry.kind])).toStrictEqual([[escrowNo(1), 'llm']]);
    // The twin: the same call to a supplier that works completes with one Post.
    const twin = await setup();
    const hired = await hireModel(twin.key, twin.deps, request(), ERRORS);
    expect(hired.accepted).toBe('confirmed');
    expect(twin.booked).toHaveLength(1);
  });

  it('frees the lane of the key when a hire fails: the next decision is a new hire, and it completes', async () => {
    const run = await setup();
    run.m.llm.refuse = { status: 422, reason: 'bad_input' };
    expect((await thrown(hireModel(run.key, run.deps, request(), ERRORS))).code).toBe('llm_refused');
    run.m.llm.refuse = null;
    const next = await hireModel(run.key, run.deps, request({ input: 'the next question' }), ERRORS);
    expect([next.accepted, next.record.escrow_ref]).toStrictEqual(['confirmed', escrowNo(2)]);
    expect(run.m.llm.sends).toHaveLength(2);
  });

  it('ends a hire whose turn in the lane comes after its deadline with the deadline error, before it reads, chooses or posts anything: the chain, the suppliers and the store show nothing of it, and the lane is free for the next hire', async () => {
    const { run, events, held, first, second } = await twoAtOnce(60_000);
    expect(first.accepted).toBe('confirmed');
    if (second.status !== 'rejected') throw new Error('the second hire did not end in an error');
    const error: unknown = second.reason;
    if (!(error instanceof CodedError)) throw error;
    // The first hire held the lane until the clock stood 90 s after T0, so the second had its turn 30 s after its deadline.
    expect([error.code, error.message]).toStrictEqual(['deadline', 'The deadline of the job came while the second brief had not begun.']);
    // No stage of a hire and no escrow: the facts say that nothing was signed.
    expect(error.facts).toStrictEqual({ stage: 'lane', escrowRef: null, handedOver: false });
    // Nothing was read: the chain got no call, and the fetch got none (no indexer, no probe of a supplier, no send) after the first hire held the lane.
    expect(events).toStrictEqual(held.events);
    expect(run.m.calls).toHaveLength(held.calls);
    // Nothing was posted or recorded: the chain knows no second escrow, the one send is the first hire's, and the store is empty.
    expect(await run.m.chain.escrowState(escrowNo(2))).toBe('unknown');
    expect(run.m.llm.sends).toHaveLength(1);
    expect(run.booked).toHaveLength(1);
    expect(run.key.stranded.list()).toStrictEqual([]);
    // The lane is free: the next hire has its turn, and its Post is the second of the chain.
    const third = await hireModel(run.key, run.deps, request({ input: 'a third question' }), ERRORS);
    expect([third.accepted, third.record.escrow_ref]).toStrictEqual(['confirmed', escrowNo(2)]);
  });

  it('hires both when the turn of the second still meets its deadline: the same pair, with a deadline after the moment that the first lets go of the lane', async () => {
    const { run, events, held, first, second } = await twoAtOnce(150_000);
    if (second.status !== 'fulfilled') throw second.reason;
    expect([first.accepted, second.value.accepted]).toStrictEqual(['confirmed', 'confirmed']);
    expect([first.record.escrow_ref, second.value.record.escrow_ref]).toStrictEqual([escrowNo(1), escrowNo(2)]);
    // What the refusal above shows to be absent is here: the second hire read, posted and sent after the first let go.
    expect(events.length).toBeGreaterThan(held.events.length);
    expect(run.m.calls.length).toBeGreaterThan(held.calls);
    expect([run.m.llm.sends.length, run.booked.length]).toStrictEqual([2, 2]);
    expect(run.key.stranded.list()).toStrictEqual([]);
  });

  it('keeps no margin at the turn: a turn at the deadline or after it is too late, and a turn a millisecond before it is in time, so the hire goes on, posts, and ends at its first poll as it did before', async () => {
    for (const deadlineMs of [T0 - 1, T0]) {
      const late = await setup();
      const error = await thrown(hireModel(late.key, { ...late.deps, deadlineMs }, request(), ERRORS));
      expect([error.code, error.facts], String(deadlineMs - T0)).toStrictEqual(['deadline', { stage: 'lane', escrowRef: null, handedOver: false }]);
      expect([late.m.calls, late.booked, late.key.stranded.list()], String(deadlineMs - T0)).toStrictEqual([[], [], []]);
    }
    const early = await setup();
    const error = await thrown(hireModel(early.key, { ...early.deps, deadlineMs: T0 + 1 }, request(), ERRORS));
    // The turn is in time, so the hire reads and posts. The waits that the deadline cuts end it, and its escrow is in the store for the janitor.
    expect([error.code, error.facts?.stage, error.facts?.escrowRef]).toStrictEqual(['deadline', 'poll', escrowNo(1)]);
    expect(early.key.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([escrowNo(1)]);
  });

  it('does not let the price ceiling bound what a hire pays: an advert at the ceiling whose supplier bond is above the limit is not hired, with the advert, the bond and the limit in the message, and nothing is posted; at the limit, and with no limit, it is hired', async () => {
    const advert = { ...LLM_ADVERT, supplier_bond_lovelace: 25_000_000n };
    const over = await setup({ lockLovelace: 60_000_000n, floatLovelace: 200_000_000n, llmAdvert: advert });
    const error = await thrown(hireModel(over.key, over.deps, request({ maxSupplierBondLovelace: 24_999_999n }), ERRORS));
    expect(error.code).toBe('no_model');
    for (const part of [LLM_ADVERT_REF, 'supplier bond', '25000000', '24999999']) expect(error.message).toContain(part);
    expect([over.booked, over.m.llm.sends, over.key.stranded.list()]).toStrictEqual([[], [], []]);
    for (const limit of [25_000_000n, null]) {
      const run = await setup({ lockLovelace: 60_000_000n, floatLovelace: 200_000_000n, llmAdvert: advert });
      const before = (await run.m.chain.wallet()).floatLovelace;
      const hired = await hireModel(run.key, run.deps, request({ maxSupplierBondLovelace: limit }), ERRORS);
      expect(hired.accepted, String(limit)).toBe('confirmed');
      // What the record says an Accept pays is what the wallet lost, with the fees of the Post and of the Accept.
      expect(hired.record.terms).toStrictEqual({
        price_lovelace: '200000', supplier_bond_lovelace: '25000000', buyer_bond_lovelace: '1000000', locked_lovelace: '60000000', paid_to_supplier_at_accept_lovelace: '25200000',
      });
      expect(before - (await run.m.chain.wallet()).floatLovelace).toBe(25_200_000n + 2n * FakeChain.FEE_LOVELACE);
    }
  });

  it('refuses an advert whose buyer bond is above its own limit, and hires it at the limit and with none', async () => {
    const advert = { ...LLM_ADVERT, buyer_bond_lovelace: 25_000_000n };
    const over = await setup({ lockLovelace: 60_000_000n, floatLovelace: 200_000_000n, llmAdvert: advert });
    const error = await thrown(hireModel(over.key, over.deps, request({ maxBuyerBondLovelace: 24_999_999n }), ERRORS));
    for (const part of [LLM_ADVERT_REF, 'buyer bond', '25000000', '24999999']) expect(error.message).toContain(part);
    expect(over.booked).toStrictEqual([]);
    for (const limit of [25_000_000n, null]) {
      const run = await setup({ lockLovelace: 60_000_000n, floatLovelace: 200_000_000n, llmAdvert: advert });
      expect((await hireModel(run.key, run.deps, request({ maxBuyerBondLovelace: limit }), ERRORS)).accepted).toBe('confirmed');
    }
  });

  it('keeps the price ceiling as a gate of its own: one lovelace over it is not hired, and nothing is posted', async () => {
    const run = await setup();
    const error = await thrown(hireModel(run.key, run.deps, request({ maxPriceLovelace: CEILING - 1n }), ERRORS));
    expect(error.code).toBe('no_model');
    expect(error.message).toContain('LLM_MAX_PRICE_LOVELACE');
    expect(run.booked).toStrictEqual([]);
  });

  it('writes what the hire locks and what an Accept pays into its log: the terms line follows the line of the choice', async () => {
    const run = await setup();
    const lines: string[] = [];
    await hireModel(run.key, { ...run.deps, log: (line) => { lines.push(line); } }, request(), ERRORS);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^chosen chat supplier: advert /);
    expect(lines[1]).toBe(`hire terms: advert ${LLM_ADVERT_REF}: price 200000 lovelace, supplier bond 1000000 lovelace, buyer bond 1000000 lovelace; locked at the Post ${FakeChain.LOCK_LOVELACE} lovelace; `
      + 'paid to the supplier at an Accept 1200000 lovelace (the price and the supplier bond; the buyer bond returns)');
  });

  it('makes a caller write the two limits: a request without them does not type-check, and null is the way to say no limit', () => {
    // @ts-expect-error: maxSupplierBondLovelace and maxBuyerBondLovelace are required, with no default
    const incomplete: ModelRequest = { input: INPUT, allowlist: ALLOWLIST, maxPriceLovelace: CEILING, ceilingSetting: 'LLM_MAX_PRICE_LOVELACE' };
    expect(incomplete.input).toBe(INPUT);
    expect(request().maxSupplierBondLovelace).toBeNull();
  });

  it('refuses a limit that is not a bigint with a TypeError that names the field (the two limits of the bonds also take null): nothing is read or posted, and the lane stays free', async () => {
    /** A request that a JavaScript caller can write: the limit `field` holds `value`, or is left out. */
    const forged = (field: string, value: unknown, present: boolean): ModelRequest => {
      const written: Record<string, unknown> = { ...request() };
      if (present) written[field] = value; else delete written[field];
      return written as unknown as ModelRequest;
    };
    const bad: Array<[string, boolean, unknown]> = [
      ['a number', true, 1_000_000], ['zero', true, 0], ['a text', true, '1000000'], ['a boolean', true, true], ['an object', true, {}], ['undefined', true, undefined], ['a missing field', false, undefined],
    ];
    for (const field of ['maxPriceLovelace', 'maxSupplierBondLovelace', 'maxBuyerBondLovelace']) {
      // The price ceiling is a bigint here, with no null; the two limits of the bonds take null as well.
      const cases: Array<[string, boolean, unknown]> = field === 'maxPriceLovelace' ? [...bad, ['null', true, null]] : bad;
      for (const [what, present, value] of cases) {
        const run = await setup();
        const error = await hireModel(run.key, run.deps, forged(field, value, present), ERRORS).then(() => { throw new Error('the hire completed'); }, (err: unknown) => err);
        if (!(error instanceof TypeError)) throw new Error(`${field} as ${what}: ${String(error)}`);
        expect(error.message, `${field} as ${what}`).toContain(field);
        expect([run.m.calls, run.booked, run.key.stranded.list(), run.key.lane.busy], `${field} as ${what}`).toStrictEqual([[], [], [], false]);
      }
    }
  });

  it('hires with a bigint and with null in each limit of the bonds, and holds zero as a limit and not as no limit: the type of a limit is checked, and not its value', async () => {
    for (const field of ['maxSupplierBondLovelace', 'maxBuyerBondLovelace'] as const) {
      for (const limit of [null, 5_000_000n]) {
        const run = await setup();
        expect((await hireModel(run.key, run.deps, request({ [field]: limit }), ERRORS)).accepted, `${field} ${String(limit)}`).toBe('confirmed');
      }
      const zero = await setup();
      expect((await thrown(hireModel(zero.key, zero.deps, request({ [field]: 0n }), ERRORS))).code, field).toBe('no_model');
      expect(zero.booked, field).toStrictEqual([]);
    }
  });

  it('throws unavailable, and posts nothing, when no model on the allowlist is listed; a model that is listed is hired', async () => {
    const run = await setup();
    const error = await thrown(hireModel(run.key, run.deps, request({ allowlist: ['nobody/nothing'] }), ERRORS));
    expect(error.code).toBe('no_model');
    expect(run.booked).toStrictEqual([]);
    expect(run.key.stranded.list()).toStrictEqual([]);
    expect((await hireModel(run.key, run.deps, request(), ERRORS)).accepted).toBe('confirmed');
  });
});
