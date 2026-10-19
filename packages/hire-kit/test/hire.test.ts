// packages/hire-kit/test/hire.test.ts
// hireOne against the in-memory marketplace of test/stub-suppliers.ts: a FakeChain, and a chat supplier speaking the fleet protocol through the injected
// fetch (every call through safeFetch), with a clock the test owns. Every wait and every message of a hire is held, for the Document Pipeline, through its
// factory by agents/document-pipeline/test/orchestrate.test.ts; these tests hold what the kit adds to it: the error factory is the whole seam (two factories,
// the same words), the facts each throw site gives, what an Accept came to, and the two options the Pipeline does not set.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeChain, TxNotConfirmedError } from '@vsa/buyer-core';
import type { Chain } from '@vsa/buyer-core';
import { chatJob, hireOne, verificationOf } from '../src/hire.ts';
import type { HireDeps, HireErrors, HireFacts, HireLedger, HireOptions, HireSupplier } from '../src/hire.ts';
import { StrandedStore } from '../src/janitor.ts';
import { ALL_PASS, ANSWER, LLM_ADVERT, LLM_ADVERT_REF, LLM_CAPABILITY, LLM_ENDPOINT, LLM_KEY, T0, WINDOW_MS, chainWith, chatFinished, escrowNo, marketplace } from './stub-suppliers.ts';
import type { Marketplace } from './stub-suppliers.ts';

const INPUT = 'Answer in one sentence: what does a bonded escrow hold?';
const LABEL = 'the brief';
/** The chat supplier as chooseChatSupplier gives it for the advert of the stub. */
const SUPPLIER: HireSupplier = {
  hop: 'llm', advertRef: LLM_ADVERT_REF, advert: LLM_ADVERT, capabilityId: LLM_ADVERT.capability_id, model: LLM_ADVERT.model, endpoint: LLM_ENDPOINT,
  pubKeyHex: LLM_KEY.pubKeyHex, windowMs: LLM_ADVERT.max_processing_ms,
};
const DELIVER_BY = T0 + WINDOW_MS + 180_000;
const iso = (ms: number): string => new Date(ms).toISOString();

// --- Two factories ---------------------------------------------------------------------------------------------------------------------
/** As the Document Pipeline's: one class, the code <hop>_<what>, deadline and store_write_failed, the facts left out. */
class CodedError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'CodedError';
    this.code = code;
    this.status = status;
  }
}
const CODED: HireErrors<CodedError> = {
  failure: (kind, what, message) => new CodedError(`${kind}_${what}`, message, 422),
  deadline: (doing) => new CodedError('deadline', `The deadline of the job came while ${doing}.`, 422),
  storeWrite: (message) => new CodedError('store_write_failed', message, 500),
};
/** As a service that falls back would make one: another class, the hop's own codes, the kit's words kept apart from its message, and the facts kept. */
class HopError extends Error {
  readonly hopCode: string;
  readonly words: string;
  readonly facts: HireFacts;
  constructor(hopCode: string, words: string, facts: HireFacts) {
    super(`the hop failed: ${hopCode}`);
    this.name = 'HopError';
    this.hopCode = hopCode;
    this.words = words;
    this.facts = facts;
  }
}
const HOP: HireErrors<HopError> = {
  failure: (kind, what, message, facts) => new HopError(`${kind}_${what}`, message, facts),
  deadline: (doing, facts) => new HopError('llm_out_of_time', doing, facts),
  storeWrite: (message, facts) => new HopError('store_write_failed', message, facts),
};

// --- The harness -------------------------------------------------------------------------------------------------------------------
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Run {
  m: Marketplace; deps: HireDeps; stranded: StrandedStore; sleeps: number[]; ledger: HireLedger;
  booked: { posted: Array<{ lockLovelace: bigint; feeLovelace: bigint }>; accepted: Array<{ feeLovelace: bigint }> };
}
/** A marketplace, an empty stranded store, a ledger that books what it is told, and the deps of a hire whose deadline is `deadlineMs` after T0. */
function setup(deadlineMs = 1_000_000): Run {
  const m = marketplace();
  const dir = mkdtempSync(join(tmpdir(), 'hire-kit-'));
  dirs.push(dir);
  const stranded = new StrandedStore(dir);
  const sleeps: number[] = [];
  const deps: HireDeps = { chain: m.chain, stranded, clock: () => m.clock.now, sleep: async (ms) => { sleeps.push(ms); m.clock.now += ms; }, deadlineMs: T0 + deadlineMs };
  const booked: Run['booked'] = { posted: [], accepted: [] };
  const ledger: HireLedger = {
    posted: (post) => { booked.posted.push({ lockLovelace: post.lockLovelace, feeLovelace: post.feeLovelace }); },
    accepted: (accept) => { booked.accepted.push({ feeLovelace: accept.feeLovelace }); },
  };
  return { m, deps, stranded, sleeps, ledger, booked };
}
const job = (m: Marketplace) => chatJob(LLM_ENDPOINT, INPUT, LABEL, m.fetchImpl);
/** The error a hire rejects with. */
async function failure<E>(hire: Promise<unknown>): Promise<E> {
  return hire.then(() => { throw new Error('the hire succeeded'); }, (e: unknown) => e as E);
}
const hop = (run: Run, chain: Chain = run.m.chain, options?: HireOptions) => failure<HopError>(hireOne({ ...run.deps, chain }, SUPPLIER, job(run.m), run.ledger, HOP, options));
const entry = (ref: string, postedAt = T0) => ({ escrow_ref: ref, deliver_by: postedAt + WINDOW_MS + 180_000, posted_at: postedAt, kind: 'llm' });

describe('hireOne: a hire that ends well', () => {
  it('posts, sends, polls, verifies and accepts: the record in the key order of a sub-job, the answer, VERIFIED, the Accept confirmed, the ledger booked, the store empty', async () => {
    const run = setup();
    const hired = await hireOne(run.deps, SUPPLIER, job(run.m), run.ledger, CODED);
    const finished = chatFinished(LLM_KEY, escrowNo(1), 'responses-job-1', INPUT, ANSWER, 'completed');
    expect(Object.keys(hired.record)).toStrictEqual(['capability_id', 'advert_ref', 'escrow_ref', 'supplier_pkh', 'receipt', 'receipt_signature', 'verification']);
    expect(hired.record).toStrictEqual({
      capability_id: LLM_CAPABILITY, advert_ref: LLM_ADVERT_REF, escrow_ref: escrowNo(1), supplier_pkh: LLM_KEY.pkh,
      receipt: finished.receipt, receipt_signature: finished.receipt_signature, verification: ALL_PASS,
    });
    expect(hired.value).toStrictEqual({ text: ANSWER, status: 'completed' });
    expect([hired.verdict.verdict, hired.accepted]).toStrictEqual(['VERIFIED', 'confirmed']);
    expect(verificationOf(hired.verdict.checks)).toStrictEqual(ALL_PASS);
    expect(run.booked).toStrictEqual({ posted: [{ lockLovelace: FakeChain.LOCK_LOVELACE, feeLovelace: FakeChain.FEE_LOVELACE }], accepted: [{ feeLovelace: FakeChain.FEE_LOVELACE }] });
    expect(await run.m.chain.escrowState(escrowNo(1))).toBe('spent');
    expect(run.stranded.list()).toStrictEqual([]);
    expect(run.sleeps).toStrictEqual([3_000, 3_000]);
    expect(run.m.llm.sends.map((s) => [s.escrowRef, JSON.parse(s.body)])).toStrictEqual([[escrowNo(1), { input: INPUT }]]);
  });

  it('an Accept sent and not seen confirmed stands (ruling R33): accepted is pending, its fee is not booked, and the escrow stays marked for the janitor', async () => {
    const run = setup();
    const unseen = (ref: string) => new TxNotConfirmedError('The Accept was submitted, but Koios did not report it confirmed.', { txHash: 'ac'.repeat(32), escrowRef: ref, deliverBy: null, validTo: T0 + 606_000, mayLand: true });
    const chain = chainWith(run.m, { accept: async (r) => { throw unseen(r); } });
    const hired = await hireOne({ ...run.deps, chain }, SUPPLIER, job(run.m), run.ledger, CODED);
    expect([hired.verdict.verdict, hired.accepted, hired.record.escrow_ref]).toStrictEqual(['VERIFIED', 'pending', escrowNo(1)]);
    expect(run.booked.accepted).toStrictEqual([]);
    expect(run.stranded.list()).toStrictEqual([{ ...entry(escrowNo(1)), accept_pending: { tx_hash: 'ac'.repeat(32), valid_to: T0 + 606_000, by: 'run' } }]);
  });
});

describe('hireOne: the error factory is the whole seam', () => {
  it('the same refusal through two factories: the same words and the same facts, in the class, the code and the status each factory chooses', async () => {
    const coded = setup();
    coded.m.llm.refuse = { status: 409, reason: 'prompt_mismatch' };
    const a = await failure<CodedError>(hireOne(coded.deps, SUPPLIER, job(coded.m), coded.ledger, CODED));
    const other = setup();
    other.m.llm.refuse = { status: 409, reason: 'prompt_mismatch' };
    const b = await hop(other);
    const words = `The chat supplier refused the brief (409 prompt_mismatch: the supplier refused the job (prompt_mismatch)); its escrow ${escrowNo(1)} is Open and goes to the janitor.`;
    expect(a).toBeInstanceOf(CodedError);
    expect([a.code, a.status, a.message]).toStrictEqual(['llm_refused', 422, words]);
    expect(b).toBeInstanceOf(HopError);
    expect([b.hopCode, b.words, b.facts]).toStrictEqual(['llm_refused', words, { stage: 'send', escrowRef: escrowNo(1), escrowState: 'Open', handedOver: false }]);
    for (const run of [coded, other]) expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1))]);
  });

  it('the deadline through two factories: the kit says what the hire was doing, and each factory makes of it what it makes', async () => {
    const coded = setup(4_000);
    coded.m.llm.steps = ['running'];
    const a = await failure<CodedError>(hireOne(coded.deps, SUPPLIER, job(coded.m), coded.ledger, CODED));
    expect([a.code, a.status, a.message]).toStrictEqual(['deadline', 422, 'The deadline of the job came while the brief was being polled.']);
    const other = setup(4_000);
    other.m.llm.steps = ['running'];
    const b = await hop(other);
    expect([b.hopCode, b.words, b.facts]).toStrictEqual(['llm_out_of_time', 'the brief was being polled', { stage: 'poll', escrowRef: escrowNo(1), handedOver: true }]);
  });

  it('a store that cannot be written after the Post through two factories: the message names the escrow and its lock; nothing is sent', async () => {
    const words = `Escrow ${escrowNo(1)} could not be recorded in the stranded store (ENOSPC: no space left on device): it locks ${FakeChain.LOCK_LOVELACE} lovelace for the brief and the janitor does not know of it. Reclaim it by hand after its deliver_by (${iso(DELIVER_BY)}).`;
    const coded = setup();
    coded.stranded.add = () => { throw new Error('ENOSPC: no space left on device'); };
    const a = await failure<CodedError>(hireOne(coded.deps, SUPPLIER, job(coded.m), coded.ledger, CODED));
    expect([a.code, a.status, a.message]).toStrictEqual(['store_write_failed', 500, words]);
    const other = setup();
    other.stranded.add = () => { throw new Error('ENOSPC: no space left on device'); };
    const b = await hop(other);
    expect([b.hopCode, b.words, b.facts]).toStrictEqual(['store_write_failed', words, { stage: 'post', escrowRef: escrowNo(1), handedOver: false }]);
    expect([coded.m.llm.sends, other.m.llm.sends]).toStrictEqual([[], []]);
  });
});

describe('hireOne: the facts of each throw site', () => {
  const lost = 'ee'.repeat(32);
  it.each<[string, (run: Run) => Chain, string, (ref: string) => HireFacts]>([
    ['a Post that fails before its signature: nothing was signed', (run) => chainWith(run.m, { postEscrow: async () => { throw new Error('no node'); } }), 'llm_post_failed',
      () => ({ stage: 'post', escrowRef: null, handedOver: false })],
    ['a Post signed and not seen confirmed: its escrow, recorded with its validity', (run) => {
      run.m.chain.failNextPost(new TxNotConfirmedError('The Post was submitted, but Koios did not report it confirmed.', { txHash: lost, escrowRef: `${lost}#0`, deliverBy: DELIVER_BY, validTo: T0 + 180_000, mayLand: true }));
      return run.m.chain;
    }, 'llm_post_failed', () => ({ stage: 'post', escrowRef: `${lost}#0`, handedOver: false })],
    ['a send whose escrow cannot be read until the send cutoff: the state null', (run) => {
      run.m.llm.notFound = 1;
      return chainWith(run.m, { escrowState: async () => { throw new Error('Could not read escrow: Koios answered 503'); } });
    }, 'llm_send_lost', (ref) => ({ stage: 'send', escrowRef: ref, escrowState: null, handedOver: false })],
    ['a supplier that fails the job while its escrow reads Claimed: the state read, and the job handed over', (run) => { run.m.llm.steps = ['failed']; return run.m.chain; }, 'llm_failed',
      (ref) => ({ stage: 'poll', escrowRef: ref, escrowState: 'Claimed', handedOver: true })],
    ['an answer whose output is not a list', (run) => { run.m.llm.answerText = (body) => JSON.stringify({ ...body, output: 'text' }); return run.m.chain; }, 'llm_bad_result',
      (ref) => ({ stage: 'answer', escrowRef: ref, handedOver: true })],
    ['a receipt signed with another key', (run) => { run.m.llm.forge = true; return run.m.chain; }, 'llm_receipt_failed', (ref) => ({ stage: 'receipt', escrowRef: ref, handedOver: true })],
    ['an Accept that keeps failing for 600 s after the answer', (run) => chainWith(run.m, { accept: async () => { throw new Error('no node'); } }), 'llm_accept_failed',
      (ref) => ({ stage: 'accept', escrowRef: ref, handedOver: true })],
  ])('%s', async (_name, arrange, code, facts) => {
    const run = setup();
    const error = await hop(run, arrange(run));
    expect([error.hopCode, error.facts]).toStrictEqual([code, facts(escrowNo(1))]);
  });

  it('the words of each failure are the Pipeline\'s, with the label and the supplier of the hire', async () => {
    const said = async (arrange: (run: Run) => Chain): Promise<string> => { const run = setup(); return (await hop(run, arrange(run))).words; };
    expect(await said((run) => chainWith(run.m, { postEscrow: async () => { throw new Error('no node'); } }))).toBe('The Post for the brief failed (no node). Nothing was locked for it.');
    expect(await said((run) => { run.m.llm.steps = ['failed']; return run.m.chain; }))
      .toBe(`The chat supplier failed the brief (upstream_failure: the upstream model did not answer); its escrow ${escrowNo(1)} is Claimed and goes to the janitor.`);
    expect(await said((run) => { run.m.llm.answerText = (body) => JSON.stringify({ ...body, output: 'text' }); return run.m.chain; }))
      .toBe(`The chat supplier's answer for the brief cannot be used (its output is not a list); its escrow ${escrowNo(1)} is not accepted and stays with the janitor.`);
    expect(await said((run) => { run.m.llm.forge = true; return run.m.chain; })).toBe(`The receipt for the brief failed signature_valid; its escrow ${escrowNo(1)} is not accepted and stays with the janitor.`);
    expect(await said((run) => chainWith(run.m, { accept: async () => { throw new Error('no node'); } })))
      .toBe(`The Accept of the brief was made 41 times, 15 s apart, and the last attempt failed (no node); the next one would start more than 600 s after the supplier's answer, when the accept window may be over. Its escrow ${escrowNo(1)} stays recorded for the janitor.`);
  });
});

describe('hireOne: firstSendBy (absent for the Pipeline)', () => {
  /** A chain whose Post is confirmed at `at`. */
  const confirmedAt = (run: Run, at: number): Chain => chainWith(run.m, { postEscrow: async (a) => { const post = await run.m.chain.postEscrow(a); run.m.clock.now = at; return post; } });

  it('a Post confirmed past it is never sent: the factory\'s deadline, the escrow Open and recorded for the janitor', async () => {
    const run = setup();
    const error = await hop(run, confirmedAt(run, T0 + 10_001), { firstSendBy: T0 + 10_000 });
    expect([error.hopCode, error.words, error.facts]).toStrictEqual(['llm_out_of_time', 'the Post for the brief was being confirmed', { stage: 'send', escrowRef: escrowNo(1), handedOver: false }]);
    expect(run.m.llm.sends).toStrictEqual([]);
    expect(await run.m.chain.escrowState(escrowNo(1))).toBe('Open');
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1))]);
  });

  it('a Post confirmed at it exactly is sent, and the hire ends well', async () => {
    const run = setup();
    const hired = await hireOne({ ...run.deps, chain: confirmedAt(run, T0 + 10_000) }, SUPPLIER, job(run.m), run.ledger, HOP, { firstSendBy: T0 + 10_000 });
    expect(hired.accepted).toBe('confirmed');
  });

  it('without it, a Post confirmed after the deadline is sent once, and the hire stops at its first poll, as the Pipeline\'s does', async () => {
    const run = setup(5_000);
    const error = await hop(run, confirmedAt(run, T0 + 10_000));
    expect([error.hopCode, error.words]).toStrictEqual(['llm_out_of_time', 'the brief was being polled']);
    expect(run.m.llm.sends).toHaveLength(1);
    expect(run.m.llm.polls).toBe(0);
  });
});

describe('hireOne: receiptBy (absent for the Pipeline)', () => {
  /** A chain on which the hash of the receipt is not listed for the first `misses` reads, counting every read. */
  const lagging = (run: Run, misses: number, reads: { n: number }): Chain => chainWith(run.m, {
    onChainReceiptHash: async (r) => { reads.n += 1; return reads.n <= misses ? null : run.m.chain.onChainReceiptHash(r); },
  });

  it('the reads of the receipt hash stop at receiptBy instead of the deadline: the factory\'s deadline, the escrow Submitted and kept for the janitor', async () => {
    const run = setup(20_000);
    const reads = { n: 0 };
    const error = await hop(run, lagging(run, Number.POSITIVE_INFINITY, reads), { receiptBy: T0 + 60_000 });
    expect([error.hopCode, error.words, error.facts]).toStrictEqual(['llm_out_of_time', 'the receipt for the brief was being checked', { stage: 'receipt', escrowRef: escrowNo(1), handedOver: true }]);
    // The answer came 6 s after the Post; a read every 3 s from then on, the last at receiptBy.
    expect([reads.n, run.m.clock.now]).toStrictEqual([19, T0 + 60_000]);
    expect(await run.m.chain.escrowState(escrowNo(1))).toBe('Submitted');
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1))]);
  });

  it('without it they stop at the deadline', async () => {
    const run = setup(20_000);
    const reads = { n: 0 };
    const error = await hop(run, lagging(run, Number.POSITIVE_INFINITY, reads));
    expect([error.hopCode, error.words]).toStrictEqual(['llm_out_of_time', 'the receipt for the brief was being checked']);
    expect([reads.n, run.m.clock.now]).toStrictEqual([5, T0 + 18_000]);
  });

  it('a hash that shows after the deadline and before receiptBy is verified, and the escrow accepted', async () => {
    const run = setup(20_000);
    const reads = { n: 0 };
    const hired = await hireOne({ ...run.deps, chain: lagging(run, 9, reads) }, SUPPLIER, job(run.m), run.ledger, HOP, { receiptBy: T0 + 60_000 });
    expect([hired.verdict.verdict, hired.accepted, reads.n, run.m.clock.now]).toStrictEqual(['VERIFIED', 'confirmed', 10, T0 + 33_000]);
    expect(await run.m.chain.escrowState(escrowNo(1))).toBe('spent');
  });
});
