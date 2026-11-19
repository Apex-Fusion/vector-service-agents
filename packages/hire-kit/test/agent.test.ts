// packages/hire-kit/test/agent.test.ts
// hireAgent against the in-memory marketplace of testing/stub-suppliers.ts: a FakeChain with a vault that a delegate key pays from, and a template supplier behind the injected fetch,
// with a clock the test owns, run from the paying key of the chain. The five outcomes (completed, refused_before_claim, failed_after_claim, vault_refused, not_accepted), the choice
// of the agent by capability and model and by name, the limits of the bonds, the payment from the wallet and from a vault, the decision of the caller, the lane of the key, and what
// is thrown instead of an outcome. Each refusal has its accepted twin.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeChain } from '@vsa/buyer-core';
import type { Chain } from '@vsa/buyer-core';
import { HireInterrupted, hireAgent } from '../src/agent.ts';
import type { AgentDeps, AgentErrors, AgentOutcome, AgentRequest } from '../src/agent.ts';
import type { HireLedger } from '../src/hire.ts';
import { JANITOR_GRACE_MS, StrandedStore, runJanitorOnce } from '../src/janitor.ts';
import { PayingKeys } from '../src/keys.ts';
import type { PayingKey } from '../src/keys.ts';
import {
  AGENT_ADVERT, AGENT_ADVERT_REF, AGENT_ANSWER, AGENT_CAPABILITY, AGENT_ENDPOINT, AGENT_KEY, AGENT_MODEL, FORGER_KEY, INDEXER, T0, chainWith, indexerRow, marketplace, vaultChainWith,
} from '../testing/index.ts';
import type { Marketplace } from '../testing/index.ts';

const PAYLOAD = '{"purchase_order":"PO-7","lines":[{"sku":"A-1","quantity":12}]}';
const DELEGATION = 'dd'.repeat(32);
const LIMIT = { perTx: 5_000_000n, total: 12_000_000n, periodMs: 86_400_000 };
const SECOND_ADVERT_REF = `${'d4'.repeat(32)}#0`;
const PAGE_502 = '<html><body><h1>502 Bad Gateway</h1></body></html>';
const PAGE_504 = '<html><body><h1>504 Gateway Timeout</h1></body></html>';

class CodedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CodedError';
    this.code = code;
  }
}
/** As a service writes its errors: the code <hop>_<what> for a failure, and its own codes for the rest. */
const ERRORS: AgentErrors<CodedError> = {
  failure: (kind, what, message) => new CodedError(`${kind}_${what}`, message),
  deadline: (doing) => new CodedError('deadline', `The deadline of the job came while ${doing}.`),
  storeWrite: (message) => new CodedError('store_write_failed', message),
  unavailable: (why) => new CodedError('no_agent', `No agent to hire: ${why}.`),
};

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

/** A promise that the test settles by hand. (Promise.withResolvers is not in the types of this package's target.) */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface Run {
  m: Marketplace; key: PayingKey; deps: AgentDeps; stranded: StrandedStore; sleeps: number[]; logs: string[];
  booked: { posted: Array<{ lockLovelace: bigint; feeLovelace: bigint }>; accepted: Array<{ feeLovelace: bigint }> };
}
/**
 * A marketplace, the paying key of its chain (the chain `chain` makes of it, when a test needs to see, hold or change what the chain says), an empty stranded store, a ledger that
 * books what it is told, and the deps of a hire whose deadline is `deadlineMs` after T0.
 */
async function setup(opts: Parameters<typeof marketplace>[0] = {}, over: { deadlineMs?: number; chain?: (m: Marketplace) => Chain } = {}): Promise<Run> {
  const m = marketplace(opts);
  const dir = mkdtempSync(join(tmpdir(), 'hire-kit-agent-'));
  dirs.push(dir);
  const key = await new PayingKeys(dir).add(over.chain === undefined ? m.chain : over.chain(m));
  const sleeps: number[] = [];
  const logs: string[] = [];
  const booked: Run['booked'] = { posted: [], accepted: [] };
  const ledger: HireLedger = {
    posted: (post) => { booked.posted.push({ lockLovelace: post.lockLovelace, feeLovelace: post.feeLovelace }); },
    accepted: (accept) => { booked.accepted.push({ feeLovelace: accept.feeLovelace }); },
  };
  const deps: AgentDeps = {
    clock: () => m.clock.now, sleep: async (ms) => { sleeps.push(ms); m.clock.now += ms; }, deadlineMs: T0 + (over.deadlineMs ?? 1_000_000),
    fetchImpl: m.fetchImpl, indexerUrl: INDEXER, ledger, log: (line) => { logs.push(line); },
  };
  return { m, key, deps, stranded: key.stranded, sleeps, logs, booked };
}
const request = (over: Partial<AgentRequest> = {}): AgentRequest => ({
  selection: { capabilityId: AGENT_CAPABILITY, model: AGENT_MODEL }, payload: PAYLOAD, label: 'the order', maxSupplierBondLovelace: null, maxBuyerBondLovelace: null, ...over,
});
/** The hire of the request `over` makes, from the key of the run. */
const go = (run: Run, over: Partial<AgentRequest> = {}): Promise<AgentOutcome> => hireAgent(run.key, run.deps, request(over), ERRORS);
/** The vault of the test: the delegate key of the chain pays from it. */
const openVault = (run: Run, limit = LIMIT): string => run.m.chain.openVault({ delegation: DELEGATION, lovelace: 40_000_000n, limit });
/** What a hire throws; the test fails when the hire ends in an outcome. */
async function thrown(hire: Promise<AgentOutcome>): Promise<CodedError> {
  const error = await hire.then((outcome) => { throw new Error(`the hire ended in ${outcome.outcome}`); }, (err: unknown) => err);
  if (!(error instanceof CodedError)) throw error;
  return error;
}
/** What a hire throws after a confirmed Pay from a vault; the test fails when it throws anything else. */
async function interrupted(hire: Promise<AgentOutcome>): Promise<HireInterrupted> {
  const error = await hire.then((outcome) => { throw new Error(`the hire ended in ${outcome.outcome}`); }, (err: unknown) => err);
  if (!(error instanceof HireInterrupted)) throw error;
  return error;
}
/** One word per outcome, checked for completeness by the compiler. */
function words(outcome: AgentOutcome): string {
  switch (outcome.outcome) {
    case 'completed': return `completed ${outcome.paidFrom}`;
    case 'refused_before_claim': return `refused_before_claim ${outcome.code}`;
    case 'failed_after_claim': return `failed_after_claim ${outcome.reason}`;
    case 'vault_refused': return `vault_refused ${outcome.refusal.kind}`;
    case 'not_accepted': return `not_accepted ${outcome.reason}`;
    default: return outcome satisfies never;
  }
}
const SECOND_ROW = (over: Record<string, unknown>): Record<string, unknown> => indexerRow(SECOND_ADVERT_REF, AGENT_ADVERT, { agent_id: AGENT_ADVERT.agent_id, ...over });
/**
 * A fetch in front of the agent that lets the test decide, for each send of the job (the POST of /v1/job), what the caller gets. `behave` is given the number of the send (from 1) and a
 * function that makes the send reach the agent, and gives the response to hand back, or undefined to hand back the agent's own.
 */
function inFrontOf(m: Marketplace, behave: (send: number, reach: () => Promise<Response>) => Promise<Response | undefined>): typeof fetch {
  let sends = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === 'POST' && url.origin === AGENT_ENDPOINT && url.pathname === '/v1/job') {
      sends += 1;
      return (await behave(sends, () => m.fetchImpl(input, init))) ?? m.fetchImpl(input, init);
    }
    return m.fetchImpl(input, init);
  }) as typeof fetch;
}
const page = (status: number, text: string): Response => new Response(text, { status, headers: { 'content-type': 'text/html' } });

describe('hireAgent: completed', () => {
  it('chooses the only Active advert of the capability and the model, pays from the wallet, sends, polls, checks, accepts, and says completed with the text, the record and the ledger booked', async () => {
    const run = await setup();
    const outcome = await go(run);
    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome !== 'completed') return;
    expect([outcome.paidFrom, outcome.accepted, outcome.vaultRef, outcome.text, outcome.verdict.verdict]).toStrictEqual(['wallet', 'confirmed', null, AGENT_ANSWER, 'VERIFIED']);
    expect(outcome.record).toMatchObject({ capability_id: AGENT_CAPABILITY, advert_ref: AGENT_ADVERT_REF, escrow_ref: outcome.escrowRef, supplier_pkh: AGENT_KEY.pkh });
    expect(outcome.advertRef).toBe(AGENT_ADVERT_REF);
    expect(await run.m.chain.escrowState(outcome.escrowRef)).toBe('spent');
    expect(run.stranded.list()).toStrictEqual([]);
    expect(run.booked).toStrictEqual({ posted: [{ lockLovelace: FakeChain.LOCK_LOVELACE, feeLovelace: FakeChain.FEE_LOVELACE }], accepted: [{ feeLovelace: FakeChain.FEE_LOVELACE }] });
    expect(run.m.agent.sends.map((send) => send.escrowRef)).toStrictEqual([outcome.escrowRef]);
    expect(run.logs.filter((line) => line.startsWith('chosen agent supplier: advert '))).toHaveLength(1);
    expect(run.m.calls.some((call) => new URL(call.url).origin === INDEXER && new URL(call.url).pathname === '/suppliers')).toBe(true);
  });

  it('writes what the hire locks and what an Accept pays into its record, its result and its log: the price and both bonds, the lock, and the price with the supplier bond, which is what the supplier gets', async () => {
    const run = await setup();
    const before = (await run.m.chain.wallet()).floatLovelace;
    const outcome = await go(run);
    if (outcome.outcome !== 'completed') throw new Error(`the hire ended in ${outcome.outcome}`);
    const terms = {
      price_lovelace: '200000', supplier_bond_lovelace: '1000000', buyer_bond_lovelace: '1000000', locked_lovelace: String(FakeChain.LOCK_LOVELACE), paid_to_supplier_at_accept_lovelace: '1200000',
    };
    expect(outcome.record.terms).toStrictEqual(terms);
    expect(outcome.terms).toStrictEqual(terms);
    expect(Object.keys(outcome.record)).toStrictEqual(['capability_id', 'advert_ref', 'escrow_ref', 'supplier_pkh', 'receipt', 'receipt_signature', 'verification', 'terms']);
    const line = run.logs.find((entry) => entry.startsWith('hire terms: '));
    expect(line).toBe(`hire terms: advert ${AGENT_ADVERT_REF}: price 200000 lovelace, supplier bond 1000000 lovelace, buyer bond 1000000 lovelace; locked at the Post ${FakeChain.LOCK_LOVELACE} lovelace; `
      + 'paid to the supplier at an Accept 1200000 lovelace (the price and the supplier bond; the buyer bond returns)');
    // What the record says is what the wallet lost: the price and the supplier bond, and the fee of the Post and of the Accept.
    const after = (await run.m.chain.wallet()).floatLovelace;
    expect(before - after).toBe(BigInt(terms.paid_to_supplier_at_accept_lovelace) + 2n * FakeChain.FEE_LOVELACE);
  });

  it('takes a named advert and pays it when its output exists, with no look at the listing of the indexer: a listing that is empty, or that is down, does not matter', async () => {
    const run = await setup();
    run.m.rows.length = 0;
    const outcome = await go(run, { selection: { advertRef: AGENT_ADVERT_REF.toUpperCase() } });
    expect(outcome.outcome).toBe('completed');
    expect(run.m.calls.filter((call) => new URL(call.url).origin === INDEXER)).toStrictEqual([]);
    // The twin: the same hire by capability needs the listing, and with the listing empty there is no agent to hire.
    const twin = await setup();
    twin.m.rows.length = 0;
    expect((await thrown(go(twin))).code).toBe('no_agent');
  });

  it('refuses to pay a named advert that is not on chain, and any advert whose agent does not serve that advert or the key of it: nothing is posted', async () => {
    const missing = await setup();
    expect((await thrown(go(missing, { selection: { advertRef: SECOND_ADVERT_REF } }))).code).toBe('no_agent');
    const wrongAdvert = await setup();
    wrongAdvert.m.agent.capabilityOverride = { advert_ref: SECOND_ADVERT_REF };
    expect((await thrown(go(wrongAdvert))).message).toMatch(/another advert or another capability/);
    const wrongKey = await setup();
    wrongKey.m.agent.capabilityOverride = { pub_key_hex: FORGER_KEY.pubKeyHex };
    expect((await thrown(go(wrongKey))).message).toMatch(/not the key of its advert/);
    const wrongCapability = await setup();
    wrongCapability.m.agent.capabilityOverride = { capability_id: 'supplychain.other.v1' };
    expect((await thrown(go(wrongCapability))).message).toMatch(/another advert or another capability/);
    for (const run of [missing, wrongAdvert, wrongKey, wrongCapability]) {
      expect(run.booked.posted).toStrictEqual([]);
      expect(run.m.agent.sends).toStrictEqual([]);
      expect(run.stranded.list()).toStrictEqual([]);
    }
    // The twin: the agent that serves its own advert and key is hired.
    expect((await go(await setup(), { selection: { advertRef: AGENT_ADVERT_REF } })).outcome).toBe('completed');
  });
});

describe('hireAgent: the choice by capability and model', () => {
  it('refuses two Active adverts that fit, and names both, instead of choosing one; a model that tells them apart, or a price ceiling, chooses', async () => {
    const run = await setup();
    run.m.rows.push(SECOND_ROW({ model: 'order-desk-large' }));
    const error = await thrown(go(run, { selection: { capabilityId: AGENT_CAPABILITY } }));
    expect(error.code).toBe('no_agent');
    expect(error.message).toContain(AGENT_ADVERT_REF);
    expect(error.message).toContain(SECOND_ADVERT_REF);
    expect(run.booked.posted).toStrictEqual([]);
    expect(run.stranded.list()).toStrictEqual([]);
    // The twin: the model of the first, which the second does not have.
    expect((await go(run, { selection: { capabilityId: AGENT_CAPABILITY, model: AGENT_MODEL } })).outcome).toBe('completed');
  });

  it('refuses an advert priced above the ceiling of the request, and no advert of the capability or of the model; at the ceiling it is hired', async () => {
    const above = await setup();
    expect((await thrown(go(above, { selection: { capabilityId: AGENT_CAPABILITY, maxPriceLovelace: AGENT_ADVERT.price_lovelace - 1n } }))).code).toBe('no_agent');
    const noModel = await setup();
    expect((await thrown(go(noModel, { selection: { capabilityId: AGENT_CAPABILITY, model: 'order-desk-xl' } }))).code).toBe('no_agent');
    const noCapability = await setup();
    expect((await thrown(go(noCapability, { selection: { capabilityId: 'supplychain.other.v1' } }))).code).toBe('no_agent');
    for (const run of [above, noModel, noCapability]) expect(run.booked.posted).toStrictEqual([]);
    expect((await go(await setup(), { selection: { capabilityId: AGENT_CAPABILITY, maxPriceLovelace: AGENT_ADVERT.price_lovelace } })).outcome).toBe('completed');
  });

  it('does not take an advert that the indexer lists as Active and the chain does not show as the capability that was asked', async () => {
    const run = await setup();
    // The indexer's row says one capability; the advert on chain at that ref is another one.
    run.m.rows[1] = indexerRow(AGENT_ADVERT_REF, { ...AGENT_ADVERT, capability_id: 'supplychain.other.v1' }, { agent_id: AGENT_ADVERT.agent_id });
    const error = await thrown(go(run, { selection: { capabilityId: 'supplychain.other.v1' } }));
    expect(error.message).toMatch(/is not, on chain, an Active/);
    expect(run.booked.posted).toStrictEqual([]);
  });
});

describe('hireAgent: a named advert is checked as a selection is', () => {
  it('refuses a named advert priced above the ceiling that the caller gives, with the advert, its price and the ceiling in the message, and pays one priced at it', async () => {
    const above = await setup();
    const error = await thrown(go(above, { selection: { advertRef: AGENT_ADVERT_REF, maxPriceLovelace: AGENT_ADVERT.price_lovelace - 1n } }));
    expect(error.code).toBe('no_agent');
    expect(error.message).toContain(AGENT_ADVERT_REF);
    expect(error.message).toContain(String(AGENT_ADVERT.price_lovelace));
    expect(error.message).toContain(String(AGENT_ADVERT.price_lovelace - 1n));
    expect([above.booked.posted, above.m.agent.sends, above.stranded.list()]).toStrictEqual([[], [], []]);
    expect((await go(await setup(), { selection: { advertRef: AGENT_ADVERT_REF, maxPriceLovelace: AGENT_ADVERT.price_lovelace } })).outcome).toBe('completed');
  });

  it('refuses a named advert of another capability or another model than the caller names, and pays one that is what the caller names', async () => {
    const capability = await setup();
    expect((await thrown(go(capability, { selection: { advertRef: AGENT_ADVERT_REF, capabilityId: 'supplychain.other.v1' } }))).message).toMatch(/is not, on chain, an Active/);
    const model = await setup();
    expect((await thrown(go(model, { selection: { advertRef: AGENT_ADVERT_REF, model: 'order-desk-xl' } }))).message).toMatch(/is not, on chain, an Active/);
    for (const run of [capability, model]) expect([run.booked.posted, run.m.agent.sends, run.stranded.list()]).toStrictEqual([[], [], []]);
    const twin = await setup();
    expect((await go(twin, { selection: { advertRef: AGENT_ADVERT_REF, capabilityId: AGENT_CAPABILITY, model: AGENT_MODEL, maxPriceLovelace: AGENT_ADVERT.price_lovelace } })).outcome).toBe('completed');
  });

  it('refuses a named advert that is not Active on chain, and pays the same advert when it is', async () => {
    const retired = await setup({ agentAdvert: { ...AGENT_ADVERT, status: 'Retired' } });
    const error = await thrown(go(retired, { selection: { advertRef: AGENT_ADVERT_REF } }));
    expect(error.message).toContain('Retired');
    expect([retired.booked.posted, retired.m.agent.sends, retired.stranded.list()]).toStrictEqual([[], [], []]);
    expect((await go(await setup(), { selection: { advertRef: AGENT_ADVERT_REF } })).outcome).toBe('completed');
  });
});

describe('hireAgent: the limits of the bonds', () => {
  const heavy = (over: Partial<typeof AGENT_ADVERT>) => ({ ...AGENT_ADVERT, ...over });

  it('refuses an advert at the price ceiling whose supplier bond is above the limit, with the advert, the bond and the limit in the message, and posts nothing; at the limit, and with no limit, it is hired', async () => {
    const advert = heavy({ supplier_bond_lovelace: 1_000_000n });
    const over = await setup({ agentAdvert: advert });
    const error = await thrown(go(over, { selection: { advertRef: AGENT_ADVERT_REF, maxPriceLovelace: advert.price_lovelace }, maxSupplierBondLovelace: 999_999n }));
    expect(error.code).toBe('no_agent');
    for (const part of [AGENT_ADVERT_REF, 'supplier bond', '1000000', '999999']) expect(error.message).toContain(part);
    expect([over.booked.posted, over.m.agent.sends, over.stranded.list()]).toStrictEqual([[], [], []]);
    // The same advert chosen by capability is refused the same way.
    const listed = await setup({ agentAdvert: advert });
    expect((await thrown(go(listed, { maxSupplierBondLovelace: 999_999n }))).message).toContain('supplier bond');
    expect(listed.booked.posted).toStrictEqual([]);
    for (const limit of [1_000_000n, 2_000_000n, null]) {
      const run = await setup({ agentAdvert: advert });
      expect((await go(run, { maxSupplierBondLovelace: limit })).outcome, String(limit)).toBe('completed');
    }
  });

  it('refuses an advert whose buyer bond is above its own limit, and hires it at the limit and with none; the two limits are separate', async () => {
    const advert = heavy({ buyer_bond_lovelace: 1_000_000n });
    const over = await setup({ agentAdvert: advert });
    const error = await thrown(go(over, { maxBuyerBondLovelace: 999_999n }));
    for (const part of [AGENT_ADVERT_REF, 'buyer bond', '1000000', '999999']) expect(error.message).toContain(part);
    expect(over.booked.posted).toStrictEqual([]);
    for (const limit of [1_000_000n, null]) expect((await go(await setup({ agentAdvert: advert }), { maxBuyerBondLovelace: limit })).outcome).toBe('completed');
    // A limit of the supplier bond does not bound the buyer bond, and the other way round.
    const lowSupplier = heavy({ supplier_bond_lovelace: 1n, buyer_bond_lovelace: 1_000_000n });
    expect((await go(await setup({ agentAdvert: lowSupplier }), { maxSupplierBondLovelace: 1n, maxBuyerBondLovelace: null })).outcome).toBe('completed');
    expect((await thrown(go(await setup({ agentAdvert: lowSupplier }), { maxSupplierBondLovelace: null, maxBuyerBondLovelace: 999_999n }))).message).toContain('buyer bond');
  });

  it('does not let the price ceiling bound what a hire pays: an advert at the ceiling with a supplier bond of 25 units takes 25 units more at an Accept, which the limit of the bond, and nothing else, refuses', async () => {
    const advert = heavy({ supplier_bond_lovelace: 25_000_000n });
    const unbounded = await setup({ agentAdvert: advert, lockLovelace: 60_000_000n, floatLovelace: 200_000_000n });
    const before = (await unbounded.m.chain.wallet()).floatLovelace;
    const outcome = await go(unbounded, { selection: { advertRef: AGENT_ADVERT_REF, maxPriceLovelace: advert.price_lovelace } });
    if (outcome.outcome !== 'completed') throw new Error(`the hire ended in ${outcome.outcome}`);
    expect(outcome.terms.paid_to_supplier_at_accept_lovelace).toBe('25200000');
    expect(before - (await unbounded.m.chain.wallet()).floatLovelace).toBe(25_200_000n + 2n * FakeChain.FEE_LOVELACE);
    const bounded = await setup({ agentAdvert: advert, lockLovelace: 60_000_000n, floatLovelace: 200_000_000n });
    expect((await thrown(go(bounded, { selection: { advertRef: AGENT_ADVERT_REF, maxPriceLovelace: advert.price_lovelace }, maxSupplierBondLovelace: 1_000_000n }))).message).toContain('25000000');
    expect(bounded.booked.posted).toStrictEqual([]);
  });

  it('makes a caller write the two limits: a request without them does not type-check, and null is the way to say no limit', () => {
    // @ts-expect-error: maxSupplierBondLovelace and maxBuyerBondLovelace are required, with no default
    const incomplete: AgentRequest = { selection: { capabilityId: AGENT_CAPABILITY }, payload: PAYLOAD };
    expect(incomplete.payload).toBe(PAYLOAD);
    const explicit: AgentRequest = { selection: { capabilityId: AGENT_CAPABILITY }, payload: PAYLOAD, maxSupplierBondLovelace: null, maxBuyerBondLovelace: 5n };
    expect([explicit.maxSupplierBondLovelace, explicit.maxBuyerBondLovelace]).toStrictEqual([null, 5n]);
  });
});

describe('hireAgent: refused_before_claim', () => {
  it('says refused_before_claim with the status, the code and the words of the agent when it turns the job down; the escrow stays Open and recorded as an agent entry for the janitor, and nothing is accepted', async () => {
    const run = await setup();
    run.m.agent.refuse = { status: 403, code: 'approval_revoked', message: 'The approval was revoked.' };
    const outcome = await go(run);
    expect(outcome.outcome).toBe('refused_before_claim');
    if (outcome.outcome !== 'refused_before_claim') return;
    expect([outcome.code, outcome.status, outcome.supplierMessage, outcome.vaultRef, outcome.advertRef]).toStrictEqual(['approval_revoked', 403, 'The approval was revoked.', null, AGENT_ADVERT_REF]);
    expect(outcome.message).toContain('approval_revoked');
    expect(outcome.terms.locked_lovelace).toBe(String(FakeChain.LOCK_LOVELACE));
    expect(await run.m.chain.escrowState(outcome.escrowRef)).toBe('Open');
    expect(run.stranded.list().map((entry) => [entry.escrow_ref, entry.kind])).toStrictEqual([[outcome.escrowRef, 'agent']]);
    expect(run.booked.accepted).toStrictEqual([]);
    // The twin: the same hire of an agent that does not refuse is completed.
    expect((await go(await setup())).outcome).toBe('completed');
  });

  it('says refused_before_claim with the code busy when the agent stays busy until the send runs out of time, and completes when it is free after two tries', async () => {
    const run = await setup();
    run.m.agent.busy = 1000;
    const outcome = await go(run);
    expect(words(outcome)).toBe('refused_before_claim busy');
    expect(outcome).toMatchObject({ status: 409 });
    // Every send was answered busy: the agent never claimed the escrow, which is recorded for the janitor.
    const [entry] = run.stranded.list();
    expect(await run.m.chain.escrowState(entry.escrow_ref)).toBe('Open');
    const twin = await setup();
    twin.m.agent.busy = 2;
    expect((await go(twin)).outcome).toBe('completed');
    expect(twin.sleeps.filter((ms) => ms === 15_000)).toHaveLength(2);
  });

  it('says refused_before_claim with the code and the status of every refusal that the runtime makes before its Claim: the terms of the escrow (409) and its service (403 and others); one send, no retry', async () => {
    for (const [status, code] of [[409, 'wrong_advert'], [409, 'underpaid'], [409, 'bond_mismatch'], [403, 'approval_revoked'], [422, 'order_rejected']] as const) {
      const run = await setup();
      run.m.agent.refuse = { status, code };
      const outcome = await go(run);
      expect(words(outcome)).toBe(`refused_before_claim ${code}`);
      expect(outcome).toMatchObject({ status, supplierMessage: `the service refused the job (${code})` });
      expect(run.m.agent.sends).toHaveLength(1);
    }
  });

  it('says refused_before_claim with the status 503 and the code, after one send, when the runtime could not ask its service: it claimed nothing, so the refusal is final', async () => {
    for (const code of ['precheck_unreachable', 'precheck_timeout', 'precheck_failed']) {
      const run = await setup();
      run.m.agent.refuse = { status: 503, code };
      const outcome = await go(run);
      expect(words(outcome)).toBe(`refused_before_claim ${code}`);
      expect(outcome).toMatchObject({ status: 503 });
      expect(run.m.agent.sends).toHaveLength(1);
      expect(await run.m.chain.escrowState(run.stranded.list()[0].escrow_ref)).toBe('Open');
    }
  });

  it('the janitor reclaims the escrow of a refused vault Pay after its deliver_by, to the vault as a Returned output, and the store is empty afterwards', async () => {
    const run = await setup();
    const vault = openVault(run);
    run.m.agent.refuse = { status: 403, code: 'approval_revoked' };
    const outcome = await go(run, { vaultRef: vault });
    expect(outcome.outcome).toBe('refused_before_claim');
    if (outcome.outcome !== 'refused_before_claim') return;
    expect(outcome.vaultRef).not.toBeNull();
    expect(run.m.chain.vault(vault)).toMatchObject({ consumed: true });
    const [entry] = run.stranded.list();
    // Not yet: the janitor waits for the deliver_by of the escrow.
    expect((await runJanitorOnce(run.stranded, run.m.chain, entry.deliver_by - 1)).map((action) => action.action)).toStrictEqual(['waiting']);
    run.m.clock.now = entry.deliver_by + JANITOR_GRACE_MS + 1;
    const actions = await runJanitorOnce(run.stranded, run.m.chain, run.m.clock.now);
    expect(actions.map((action) => action.action)).toStrictEqual(['reclaimed']);
    expect(run.stranded.list()).toStrictEqual([]);
    const returned = run.m.chain.vaults().filter((view) => view.kind === 'Returned');
    expect(returned).toHaveLength(1);
    expect(returned[0].lovelace).toBe(run.booked.posted[0].lockLovelace);
    expect(returned[0].delegation).toBe(DELEGATION);
  });
});

describe('hireAgent: a stop of the send that is not a refusal made before the Claim', () => {
  it('says failed_after_claim with send_lost, not refused_before_claim, when the first send gets a proxy page and the second reaches the agent, which claims, and the answer is a gateway page with the escrow read Open once more', async () => {
    let stale = false;
    const run = await setup({}, { chain: (m) => vaultChainWith(m, { escrowState: async (ref) => { if (stale) { stale = false; return 'Open'; } return m.chain.escrowState(ref); } }) });
    const behind = inFrontOf(run.m, async (send, reach) => {
      if (send === 1) return page(502, PAGE_502);
      await reach();
      stale = true;
      return page(504, PAGE_504);
    });
    const outcome = await hireAgent(run.key, { ...run.deps, fetchImpl: behind }, request(), ERRORS);
    expect(words(outcome)).toBe('failed_after_claim send_lost');
    if (outcome.outcome !== 'failed_after_claim') return;
    // The agent did claim the escrow behind the proxy, and it is recorded for the janitor.
    expect(await run.m.chain.escrowState(outcome.escrowRef)).toBe('Claimed');
    expect(run.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([outcome.escrowRef]);
    expect(run.m.agent.sends).toHaveLength(1);
    // The twin: the same first send, and a second whose answer comes through, completes.
    const twin = await setup();
    const clear = inFrontOf(twin.m, async (send) => (send === 1 ? page(502, PAGE_502) : undefined));
    expect((await hireAgent(twin.key, { ...twin.deps, fetchImpl: clear }, request(), ERRORS)).outcome).toBe('completed');
  });

  it('says failed_after_claim with send_lost when the agent answers escrow_not_found until the send runs out of time: its view of the chain lags, and the kit does not call that a refusal', async () => {
    const run = await setup();
    run.m.agent.notFound = 1000;
    const outcome = await go(run);
    expect(words(outcome)).toBe('failed_after_claim send_lost');
    if (outcome.outcome !== 'failed_after_claim') return;
    expect(outcome.message).toContain('escrow_not_found');
    expect(run.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([outcome.escrowRef]);
    // The twin: an agent whose view catches up after two answers is hired.
    const twin = await setup();
    twin.m.agent.notFound = 2;
    expect((await go(twin)).outcome).toBe('completed');
  });

  it('says failed_after_claim with send_lost, not a refusal, for a 503 of the runtime that is not one of the three: its Claim may have been sent; two such answers end the hire', async () => {
    const run = await setup();
    run.m.agent.refuse = { status: 503, code: 'chain_submit_failed' };
    expect(words(await go(run))).toBe('failed_after_claim send_lost');
    expect(run.m.agent.sends).toHaveLength(2);
  });

  it('says failed_after_claim with send_lost for a real refusal that comes after a send that ended without a clear answer: the first send may have claimed; with no such send it is refused_before_claim', async () => {
    const run = await setup();
    run.m.agent.refuse = { status: 403, code: 'approval_revoked' };
    const behind = inFrontOf(run.m, async (send) => (send === 1 ? page(502, PAGE_502) : undefined));
    expect(words(await hireAgent(run.key, { ...run.deps, fetchImpl: behind }, request(), ERRORS))).toBe('failed_after_claim send_lost');
    expect(run.m.agent.sends).toHaveLength(1);
    const twin = await setup();
    twin.m.agent.refuse = { status: 403, code: 'approval_revoked' };
    expect(words(await go(twin))).toBe('refused_before_claim approval_revoked');
  });

  it('says failed_after_claim with send_lost for a real refusal when the escrow is not read Open after it; read Open it is refused_before_claim', async () => {
    const run = await setup({}, { chain: (m) => vaultChainWith(m, { escrowState: async () => 'Claimed' }) });
    run.m.agent.refuse = { status: 403, code: 'approval_revoked' };
    expect(words(await go(run))).toBe('failed_after_claim send_lost');
    const unread = await setup({}, { chain: (m) => vaultChainWith(m, { escrowState: async () => { throw new Error('the indexer is down'); } }) });
    unread.m.agent.refuse = { status: 403, code: 'approval_revoked' };
    expect(words(await go(unread))).toBe('failed_after_claim send_lost');
    const open = await setup();
    open.m.agent.refuse = { status: 403, code: 'approval_revoked' };
    expect(words(await go(open))).toBe('refused_before_claim approval_revoked');
  });
});

describe('hireAgent: failed_after_claim', () => {
  it('says failed_after_claim with the reason failed when the agent fails the job it claimed, and with send_lost when the answer to the send was lost after the claim; the escrow goes to the janitor', async () => {
    const failed = await setup();
    failed.m.agent.steps = ['running', { fail: 'service_failure', submitted: false }];
    const first = await go(failed);
    expect(words(first)).toBe('failed_after_claim failed');
    const lost = await setup();
    lost.m.agent.lose = ['after-claim'];
    const second = await go(lost);
    expect(words(second)).toBe('failed_after_claim send_lost');
    for (const [run, outcome] of [[failed, first], [lost, second]] as const) {
      if (outcome.outcome !== 'failed_after_claim') throw new Error('not failed_after_claim');
      expect(outcome.message).toContain(outcome.escrowRef);
      expect(run.stranded.list().map((entry) => [entry.escrow_ref, entry.kind])).toStrictEqual([[outcome.escrowRef, 'agent']]);
      expect(run.booked.accepted).toStrictEqual([]);
    }
    // The twin of send_lost: the answer lost before the claim leaves the escrow Open, and the hire sends again and completes.
    const before = await setup();
    before.m.agent.lose = ['before-claim'];
    expect((await go(before)).outcome).toBe('completed');
    // The first send was lost before the claim and the second was accepted.
    expect(before.m.agent.sends).toHaveLength(2);
  });

  it('says failed_after_claim with the reason bad_result when the finished body has no choices to read, and the escrow is not accepted; a body with choices completes', async () => {
    const run = await setup();
    // A fetch that strips the choices out of the answers of the agent, as an agent that does not follow the contract would answer.
    const stripping = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await run.m.fetchImpl(input, init);
      const body: unknown = await res.clone().json().catch(() => null);
      if (body === null || typeof body !== 'object' || !('choices' in body)) return res;
      return new Response(JSON.stringify(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'choices'))), { status: res.status, headers: res.headers });
    }) as typeof fetch;
    const outcome = await hireAgent(run.key, { ...run.deps, fetchImpl: stripping }, request(), ERRORS);
    expect(words(outcome)).toBe('failed_after_claim bad_result');
    expect(run.booked.accepted).toStrictEqual([]);
    expect(run.stranded.list()).toHaveLength(1);
    expect((await go(await setup())).outcome).toBe('completed');
  });

  it('says failed_after_claim with the reason receipt_unavailable when the hash of the receipt cannot be read in time: the buyer did not judge the delivery, so it is not not_accepted; the decision is not asked', async () => {
    const run = await setup({}, { chain: (m) => vaultChainWith(m, { onChainReceiptHash: async () => null }) });
    const asked: unknown[] = [];
    const outcome = await go(run, { decide: (delivery) => { asked.push(delivery); return { accept: true }; } });
    expect(words(outcome)).toBe('failed_after_claim receipt_unavailable');
    if (outcome.outcome !== 'failed_after_claim') return;
    expect(outcome.message).toContain('could not be read on chain');
    expect(asked).toStrictEqual([]);
    expect(await run.m.chain.escrowState(outcome.escrowRef)).toBe('Submitted');
    expect(run.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([outcome.escrowRef]);
    // The twin: a hash that can be read lets the same hire complete.
    expect((await go(await setup())).outcome).toBe('completed');
  });
});

describe('hireAgent: not_accepted', () => {
  it('says not_accepted with receipt_failed and the verdict when a check fails, and does not ask the decision of the caller; the escrow stays Submitted and recorded', async () => {
    const run = await setup();
    run.m.agent.forge = true;
    const calls: unknown[] = [];
    const outcome = await go(run, { decide: (delivery) => { calls.push(delivery); return { accept: true }; } });
    expect(words(outcome)).toBe('not_accepted receipt_failed');
    if (outcome.outcome !== 'not_accepted' || outcome.reason !== 'receipt_failed') return;
    expect(outcome.verdict.verdict).toBe('FAILED');
    expect(Object.values(outcome.verdict.checks)).toContain('fail');
    expect(calls).toStrictEqual([]);
    expect(await run.m.chain.escrowState(outcome.escrowRef)).toBe('Submitted');
    expect(run.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([outcome.escrowRef]);
    expect(run.booked.accepted).toStrictEqual([]);
    // The twin: a receipt that passes is shown to the decision, once.
    const twin = await setup();
    const seen: string[] = [];
    expect((await go(twin, { decide: (delivery) => { seen.push(delivery.text); return { accept: true }; } })).outcome).toBe('completed');
    expect(seen).toStrictEqual([AGENT_ANSWER]);
  });

  it('says not_accepted with declined and the reason of the caller when the decision says no: no Accept is made, and the escrow stays Submitted and recorded; accepting completes', async () => {
    const run = await setup();
    const outcome = await go(run, { decide: () => ({ accept: false, reason: 'the quantity differs from the order' }) });
    expect(words(outcome)).toBe('not_accepted declined');
    if (outcome.outcome !== 'not_accepted' || outcome.reason !== 'declined') return;
    expect([outcome.declined, outcome.delivery.text, outcome.delivery.verdict.verdict, outcome.delivery.escrowRef]).toStrictEqual(['the quantity differs from the order', AGENT_ANSWER, 'VERIFIED', outcome.escrowRef]);
    expect(await run.m.chain.escrowState(outcome.escrowRef)).toBe('Submitted');
    expect(run.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([outcome.escrowRef]);
    expect(run.booked.accepted).toStrictEqual([]);
    const accepted = await go(await setup(), { decide: () => ({ accept: true }) });
    expect(accepted.outcome).toBe('completed');
  });

  it('a decision that throws stops the hire with its own error and nothing is accepted; the decision may be asynchronous', async () => {
    const run = await setup();
    const error = await go(run, { decide: async () => { throw new Error('the order desk is closed'); } }).then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('the order desk is closed');
    // Paid from the wallet, there is no vault to continue: the error is the hook's own.
    expect(error).not.toBeInstanceOf(HireInterrupted);
    const [entry] = run.stranded.list();
    expect(await run.m.chain.escrowState(entry.escrow_ref)).toBe('Submitted');
    expect(run.booked.accepted).toStrictEqual([]);
    expect((await go(await setup(), { decide: async () => ({ accept: true }) })).outcome).toBe('completed');
  });
});

describe('hireAgent: what is thrown and not an outcome', () => {
  it('throws the factory\'s failure, with the kind agent, for a Post that failed before its signature, and posts nothing; the twin posts', async () => {
    const run = await setup({}, { chain: (m) => chainWith(m, { postEscrow: async () => { throw new Error('the wallet has no collateral'); } }) });
    const error = await thrown(go(run));
    expect([error.code, error.message]).toStrictEqual(['agent_post_failed', 'The Post for the order failed (the wallet has no collateral). Nothing was locked for it.']);
    expect(run.stranded.list()).toStrictEqual([]);
    expect((await go(await setup())).outcome).toBe('completed');
  });

  it('throws the factory\'s deadline when the run is out of time while it polls', async () => {
    const run = await setup({}, { deadlineMs: 20_000 });
    run.m.agent.steps = ['running', 'running', 'running', 'running', 'running', 'running', 'running', 'running', 'done'];
    expect((await thrown(go(run))).code).toBe('deadline');
    expect(run.stranded.list().map((entry) => entry.kind)).toStrictEqual(['agent']);
  });

  it('refuses an empty payload before anything is chosen or paid', async () => {
    const run = await setup();
    await expect(go(run, { payload: '' })).rejects.toThrow(/non-empty/);
    expect(run.m.calls).toStrictEqual([]);
    expect(run.booked.posted).toStrictEqual([]);
  });
});

describe('hireAgent: paid from a vault', () => {
  it('pays the escrow from the vault with the delegate key: the lock leaves the vault, the Accept returns it as a Returned output, and the result carries the vault that continues', async () => {
    const run = await setup();
    const vault = openVault(run);
    const wallet = await run.m.chain.wallet();
    const outcome = await go(run, { vaultRef: vault });
    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome !== 'completed') return;
    expect([outcome.paidFrom, outcome.accepted]).toStrictEqual(['vault', 'confirmed']);
    expect(outcome.vaultRef).not.toBeNull();
    expect(run.m.chain.vault(vault)).toMatchObject({ consumed: true });
    expect(run.m.chain.vault(outcome.vaultRef ?? '')).toMatchObject({ kind: 'Live', consumed: false, delegation: DELEGATION });
    expect(run.m.chain.vaults().filter((view) => view.kind === 'Returned')).toHaveLength(1);
    // The wallet paid the two fees and locked nothing of its own.
    expect((await run.m.chain.wallet()).floatLovelace).toBe(wallet.floatLovelace - 2n * FakeChain.FEE_LOVELACE);
    expect(run.stranded.list()).toStrictEqual([]);
    expect(run.booked.accepted).toHaveLength(1);
    expect(outcome.terms.locked_lovelace).toBe(String(run.booked.posted[0].lockLovelace));
  });

  it('says vault_refused, with the evaluation error and the body of the transaction, for a Pay above the per_tx limit; nothing is posted, sent or recorded, and the vault is as it was; at the limit the Pay completes', async () => {
    const run = await setup();
    const vault = openVault(run, { ...LIMIT, perTx: 1_000_000n });
    const outcome = await go(run, { vaultRef: vault });
    expect(outcome.outcome).toBe('vault_refused');
    if (outcome.outcome !== 'vault_refused' || outcome.refusal.kind === 'impossible') throw new Error('not a refusal of the ledger');
    expect(outcome.refusal.kind).toBe('ledger');
    expect(outcome.refusal.evaluationError).toMatch(/^3010 /);
    expect(JSON.stringify(outcome.refusal.validators)).toContain('above_per_tx');
    expect(outcome.refusal.body).not.toBe('');
    expect(outcome.refusal.validators.length).toBeGreaterThan(0);
    expect(outcome.advertRef).toBe(AGENT_ADVERT_REF);
    expect([run.booked.posted, run.m.agent.sends, run.stranded.list()]).toStrictEqual([[], [], []]);
    expect(run.m.chain.vault(vault)).toMatchObject({ kind: 'Live', consumed: false });
    expect(run.m.chain.vaults()).toHaveLength(1);
    // The twin: a limit above the lock lets the same Pay through.
    const twin = await setup();
    expect((await go(twin, { vaultRef: openVault(twin, { ...LIMIT, perTx: 3_000_000n }) })).outcome).toBe('completed');
  });

  it('says vault_refused for a Pay past the total limit of the period, from the vault that the first Pay left; the first Pay completed', async () => {
    const measure = await setup();
    await go(measure, { vaultRef: openVault(measure) });
    const lock = measure.booked.posted[0].lockLovelace;
    const run = await setup();
    const first = await go(run, { vaultRef: openVault(run, { ...LIMIT, total: lock + lock / 2n }) });
    expect(first.outcome).toBe('completed');
    if (first.outcome !== 'completed' || first.vaultRef === null) throw new Error('the first Pay did not complete');
    const second = await go(run, { vaultRef: first.vaultRef });
    expect(words(second)).toBe('vault_refused ledger');
    if (second.outcome !== 'vault_refused' || second.refusal.kind === 'impossible') return;
    expect(JSON.stringify(second.refusal.validators)).toContain('above_total');
    expect(run.booked.posted).toHaveLength(1);
    expect(run.m.agent.sends).toHaveLength(1);
    expect(run.m.chain.vault(first.vaultRef)).toMatchObject({ kind: 'Live', consumed: false });
  });

  it('says vault_refused with the reason when the Pay cannot be built: a vault that does not exist, and a delegation that ended; a live vault pays', async () => {
    const missing = await setup();
    const noVault = await go(missing, { vaultRef: `${'ab'.repeat(32)}#0` });
    expect(noVault).toMatchObject({ outcome: 'vault_refused', refusal: { kind: 'impossible', reason: 'no_vault' } });
    const ended = await setup();
    const vault = openVault(ended);
    ended.m.chain.endDelegation(DELEGATION);
    const noDelegation = await go(ended, { vaultRef: vault });
    expect(noDelegation).toMatchObject({ outcome: 'vault_refused', refusal: { kind: 'impossible' } });
    for (const run of [missing, ended]) expect([run.booked.posted, run.m.agent.sends, run.stranded.list()]).toStrictEqual([[], [], []]);
    const live = await setup();
    expect((await go(live, { vaultRef: openVault(live) })).outcome).toBe('completed');
  });

  it('throws unavailable when the chain cannot pay from a vault, before it posts anything; a chain that can is used', async () => {
    const run = await setup({}, { chain: (m) => chainWith(m, {}) });
    const vault = openVault(run);
    expect((await thrown(go(run, { vaultRef: vault }))).message).toMatch(/cannot pay from a vault/);
    expect(run.booked.posted).toStrictEqual([]);
    const capable = await setup();
    expect((await go(capable, { vaultRef: openVault(capable) })).outcome).toBe('completed');
  });
});

describe('hireAgent: an error after a confirmed vault Pay carries the vault that continues', () => {
  /** The vault of the run after one Pay: the reference the error carries must be the live one, and the one the caller held is spent. */
  async function checkContinues(run: Run, held: string, error: HireInterrupted): Promise<void> {
    expect(error.vaultRef).not.toBe(held);
    expect(run.m.chain.vault(error.vaultRef)).toMatchObject({ kind: 'Live', consumed: false, delegation: DELEGATION });
    // The old reference ends as vault_refused; the one that the error carries pays the next hire.
    expect(words(await go(run, { vaultRef: held }))).toBe('vault_refused impossible');
    expect((await go(run, { vaultRef: error.vaultRef })).outcome).toBe('completed');
  }

  it('the deadline of the run: HireInterrupted with the continuing vault, and the error that ended the hire as its cause', async () => {
    const run = await setup({}, { deadlineMs: 20_000 });
    const vault = openVault(run);
    run.m.agent.steps = ['running', 'running', 'running', 'running', 'running', 'running', 'running', 'running', 'done'];
    const error = await interrupted(go(run, { vaultRef: vault }));
    expect(error.cause).toBeInstanceOf(CodedError);
    expect(error.cause).toMatchObject({ code: 'deadline' });
    expect(error.message).toContain('deadline');
    run.m.agent.steps = ['running', 'done'];
    run.deps.deadlineMs = T0 + 10_000_000;
    await checkContinues(run, vault, error);
  });

  it('a failed write of the stranded store: HireInterrupted with the continuing vault, and the factory\'s store_write_failed as its cause', async () => {
    const run = await setup();
    const vault = openVault(run);
    const add = vi.spyOn(run.key.stranded, 'add').mockImplementationOnce(() => { throw new Error('the disk is full'); });
    const error = await interrupted(go(run, { vaultRef: vault }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(error.cause).toMatchObject({ code: 'store_write_failed' });
    expect(error.message).toContain('the disk is full');
    await checkContinues(run, vault, error);
  });

  it('a decision that throws: HireInterrupted with the continuing vault, and the error of the decision as its cause; the escrow stays Submitted', async () => {
    const run = await setup();
    const vault = openVault(run);
    const hook = new Error('the order desk is closed');
    const error = await interrupted(go(run, { vaultRef: vault, decide: async () => { throw hook; } }));
    expect(error.cause).toBe(hook);
    expect(error.message).toBe('the order desk is closed');
    expect(run.stranded.list().map((entry) => entry.kind)).toStrictEqual(['agent']);
    await checkContinues(run, vault, error);
  });

  it('does not wrap what is thrown before a Pay is confirmed: a selection that fails, and a Pay that throws, reach the caller as they are', async () => {
    const noAgent = await setup();
    noAgent.m.rows.length = 0;
    const first = await thrown(go(noAgent, { vaultRef: openVault(noAgent) }));
    expect(first).toBeInstanceOf(CodedError);
    const run = await setup();
    const vault = openVault(run);
    vi.spyOn(run.m.chain, 'payFromVault').mockRejectedValueOnce(new Error('the node did not answer'));
    const second = await thrown(go(run, { vaultRef: vault }));
    expect([second.code, second.message]).toStrictEqual(['agent_post_failed', 'The Vault Pay for the order failed (the node did not answer). Nothing was locked for it.']);
  });
});

describe('hireAgent: in the lane of its paying key', () => {
  it('takes no deps with a chain or a store: they come from the key, so no hire can run with the chain of one key and the store of another', () => {
    const noChain: 'chain' extends keyof AgentDeps ? never : true = true;
    const noStore: 'stranded' extends keyof AgentDeps ? never : true = true;
    expect([noChain, noStore]).toStrictEqual([true, true]);
  });

  it('runs inside the lane of the key: the lane is busy in the decision of the caller, and is free once the hire has ended', async () => {
    const run = await setup();
    const during: boolean[] = [];
    expect(run.key.lane.busy).toBe(false);
    const outcome = await go(run, { decide: () => { during.push(run.key.lane.busy); return { accept: true }; } });
    expect(outcome.outcome).toBe('completed');
    expect(during).toStrictEqual([true]);
    await Promise.resolve();
    await Promise.resolve();
    expect(run.key.lane.busy).toBe(false);
  });

  it('starts no transaction of the janitor of the key during a hire: a Reclaim that is due waits until the hire has ended, and is made then', async () => {
    const run = await setup();
    run.m.agent.refuse = { status: 403, code: 'approval_revoked' };
    const stale = await go(run);
    if (stale.outcome !== 'refused_before_claim') throw new Error(`the first hire ended in ${stale.outcome}`);
    run.m.agent.refuse = null;
    const [entry] = run.stranded.list();
    run.m.clock.now = entry.deliver_by + JANITOR_GRACE_MS + 1;
    const logs: string[] = [];
    const outcome = await go(run, {
      decide: async () => {
        // The Reclaim of the first escrow is due, and a hire of the same key is in its decision: the janitor must not start it.
        const janitor = run.key.startJanitor(1_000, { clock: () => run.m.clock.now, log: (line) => { logs.push(line); } });
        await janitor.stop();
        return { accept: true };
      },
    });
    expect(outcome.outcome).toBe('completed');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('1 transaction deferred');
    expect(await run.m.chain.escrowState(entry.escrow_ref)).toBe('Open');
    const after = run.key.startJanitor(1_000, { clock: () => run.m.clock.now, log: (line) => { logs.push(line); } });
    await after.stop();
    expect(logs[1]).toContain(`janitor: reclaimed ${entry.escrow_ref}`);
  });

  it('runs two hires of one key one after the other: the second Post waits for the Accept of the first', async () => {
    const events: string[] = [];
    const gate = deferred();
    const reached = deferred();
    let gated = true;
    const run = await setup({}, {
      chain: (m) => vaultChainWith(m, {
        postEscrow: async (args) => { events.push('post'); return m.chain.postEscrow(args); },
        accept: async (ref) => {
          events.push('accept');
          if (gated) { gated = false; reached.resolve(); await gate.promise; }
          return m.chain.accept(ref);
        },
      }),
    });
    const first = go(run);
    const second = go(run, { payload: '{"purchase_order":"PO-8"}' });
    await reached.promise;
    expect(events).toStrictEqual(['post', 'accept']);
    gate.resolve();
    expect([(await first).outcome, (await second).outcome]).toStrictEqual(['completed', 'completed']);
    expect(events).toStrictEqual(['post', 'accept', 'post', 'accept']);
  });
});

describe('hireAgent: the five outcomes in one type', () => {
  it('names each outcome by its own word, which a switch over the type covers without a default', async () => {
    const seen: string[] = [];
    const runs: Array<[Run, Partial<AgentRequest>]> = [];
    const completed = await setup();
    runs.push([completed, {}]);
    const refused = await setup();
    refused.m.agent.refuse = { status: 422, code: 'bad_order' };
    runs.push([refused, {}]);
    const failed = await setup();
    failed.m.agent.steps = [{ fail: 'service_failure', submitted: false }];
    runs.push([failed, {}]);
    const vaultRun = await setup();
    runs.push([vaultRun, { vaultRef: openVault(vaultRun, { ...LIMIT, perTx: 1n }) }]);
    const declined = await setup();
    runs.push([declined, { decide: () => ({ accept: false, reason: 'no' }) }]);
    for (const [run, over] of runs) seen.push(words(await go(run, over)));
    expect(seen).toStrictEqual(['completed wallet', 'refused_before_claim bad_order', 'failed_after_claim failed', 'vault_refused ledger', 'not_accepted declined']);
  });
});
