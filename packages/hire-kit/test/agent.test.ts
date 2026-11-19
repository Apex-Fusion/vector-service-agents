// packages/hire-kit/test/agent.test.ts
// hireAgent against the in-memory marketplace of testing/stub-suppliers.ts: a FakeChain with a vault that a delegate key pays from, and a template supplier behind the injected fetch,
// with a clock the test owns. The five outcomes (completed, refused_before_claim, failed_after_claim, vault_refused, not_accepted), the choice of the agent by capability and model and by
// name, the payment from the wallet and from a vault, the decision of the caller, and what is thrown instead of an outcome. Each refusal has its accepted twin.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeChain } from '@vsa/buyer-core';
import type { Chain } from '@vsa/buyer-core';
import { hireAgent } from '../src/agent.ts';
import type { AgentDeps, AgentErrors, AgentOutcome, AgentRequest } from '../src/agent.ts';
import type { HireLedger } from '../src/hire.ts';
import { JANITOR_GRACE_MS, StrandedStore, runJanitorOnce } from '../src/janitor.ts';
import { AGENT_ADVERT, AGENT_ADVERT_REF, AGENT_ANSWER, AGENT_CAPABILITY, AGENT_KEY, AGENT_MODEL, FORGER_KEY, INDEXER, T0, chainWith, indexerRow, marketplace } from '../testing/index.ts';
import type { Marketplace } from '../testing/index.ts';

const PAYLOAD = '{"purchase_order":"PO-7","lines":[{"sku":"A-1","quantity":12}]}';
const DELEGATION = 'dd'.repeat(32);
const LIMIT = { perTx: 5_000_000n, total: 12_000_000n, periodMs: 86_400_000 };
const SECOND_ADVERT_REF = `${'d4'.repeat(32)}#0`;

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
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Run {
  m: Marketplace; deps: AgentDeps; stranded: StrandedStore; sleeps: number[]; logs: string[];
  booked: { posted: Array<{ lockLovelace: bigint; feeLovelace: bigint }>; accepted: Array<{ feeLovelace: bigint }> };
}
/** A marketplace, an empty stranded store, a ledger that books what it is told, and the deps of a hire whose deadline is `deadlineMs` after T0. */
function setup(opts: Parameters<typeof marketplace>[0] = {}, deadlineMs = 1_000_000): Run {
  const m = marketplace(opts);
  const dir = mkdtempSync(join(tmpdir(), 'hire-kit-agent-'));
  dirs.push(dir);
  const stranded = new StrandedStore(dir);
  const sleeps: number[] = [];
  const logs: string[] = [];
  const booked: Run['booked'] = { posted: [], accepted: [] };
  const ledger: HireLedger = {
    posted: (post) => { booked.posted.push({ lockLovelace: post.lockLovelace, feeLovelace: post.feeLovelace }); },
    accepted: (accept) => { booked.accepted.push({ feeLovelace: accept.feeLovelace }); },
  };
  const deps: AgentDeps = {
    chain: m.chain, stranded, clock: () => m.clock.now, sleep: async (ms) => { sleeps.push(ms); m.clock.now += ms; }, deadlineMs: T0 + deadlineMs,
    fetchImpl: m.fetchImpl, indexerUrl: INDEXER, ledger, log: (line) => { logs.push(line); },
  };
  return { m, deps, stranded, sleeps, logs, booked };
}
const request = (over: Partial<AgentRequest> = {}): AgentRequest => ({ selection: { capabilityId: AGENT_CAPABILITY, model: AGENT_MODEL }, payload: PAYLOAD, label: 'the order', ...over });
/** The vault of the test: the delegate key of the chain pays from it. */
const openVault = (run: Run, limit = LIMIT): string => run.m.chain.openVault({ delegation: DELEGATION, lovelace: 40_000_000n, limit });
/** What a hire throws; the test fails when the hire ends in an outcome. */
async function thrown(hire: Promise<AgentOutcome>): Promise<CodedError> {
  const error = await hire.then((outcome) => { throw new Error(`the hire ended in ${outcome.outcome}`); }, (err: unknown) => err);
  if (!(error instanceof CodedError)) throw error;
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

describe('hireAgent: completed', () => {
  it('chooses the only Active advert of the capability and the model, pays from the wallet, sends, polls, checks, accepts, and says completed with the text, the record and the ledger booked', async () => {
    const run = setup();
    const outcome = await hireAgent(run.deps, request(), ERRORS);
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

  it('takes a named advert and pays it when its output exists, with no look at the listing of the indexer: a listing that is empty, or that is down, does not matter', async () => {
    const run = setup();
    run.m.rows.length = 0;
    const outcome = await hireAgent(run.deps, request({ selection: { advertRef: AGENT_ADVERT_REF.toUpperCase() } }), ERRORS);
    expect(outcome.outcome).toBe('completed');
    expect(run.m.calls.filter((call) => new URL(call.url).origin === INDEXER)).toStrictEqual([]);
    // The twin: the same hire by capability needs the listing, and with the listing empty there is no agent to hire.
    const twin = setup();
    twin.m.rows.length = 0;
    expect((await thrown(hireAgent(twin.deps, request(), ERRORS))).code).toBe('no_agent');
  });

  it('refuses to pay a named advert that is not on chain, and any advert whose agent does not serve that advert or the key of it: nothing is posted', async () => {
    const missing = setup();
    expect((await thrown(hireAgent(missing.deps, request({ selection: { advertRef: SECOND_ADVERT_REF } }), ERRORS))).code).toBe('no_agent');
    const wrongAdvert = setup();
    wrongAdvert.m.agent.capabilityOverride = { advert_ref: SECOND_ADVERT_REF };
    expect((await thrown(hireAgent(wrongAdvert.deps, request(), ERRORS))).message).toMatch(/another advert or another capability/);
    const wrongKey = setup();
    wrongKey.m.agent.capabilityOverride = { pub_key_hex: FORGER_KEY.pubKeyHex };
    expect((await thrown(hireAgent(wrongKey.deps, request(), ERRORS))).message).toMatch(/not the key of its advert/);
    const wrongCapability = setup();
    wrongCapability.m.agent.capabilityOverride = { capability_id: 'supplychain.other.v1' };
    expect((await thrown(hireAgent(wrongCapability.deps, request(), ERRORS))).message).toMatch(/another advert or another capability/);
    for (const run of [missing, wrongAdvert, wrongKey, wrongCapability]) {
      expect(run.booked.posted).toStrictEqual([]);
      expect(run.m.agent.sends).toStrictEqual([]);
      expect(run.stranded.list()).toStrictEqual([]);
    }
    // The twin: the agent that serves its own advert and key is hired.
    expect((await hireAgent(setup().deps, request({ selection: { advertRef: AGENT_ADVERT_REF } }), ERRORS)).outcome).toBe('completed');
  });
});

describe('hireAgent: the choice by capability and model', () => {
  it('refuses two Active adverts that fit, and names both, instead of choosing one; a model that tells them apart, or a price ceiling, chooses', async () => {
    const run = setup();
    run.m.rows.push(SECOND_ROW({ model: 'order-desk-large' }));
    const error = await thrown(hireAgent(run.deps, request({ selection: { capabilityId: AGENT_CAPABILITY } }), ERRORS));
    expect(error.code).toBe('no_agent');
    expect(error.message).toContain(AGENT_ADVERT_REF);
    expect(error.message).toContain(SECOND_ADVERT_REF);
    expect(run.booked.posted).toStrictEqual([]);
    expect(run.stranded.list()).toStrictEqual([]);
    // The twin: the model of the first, which the second does not have.
    expect((await hireAgent(run.deps, request({ selection: { capabilityId: AGENT_CAPABILITY, model: AGENT_MODEL } }), ERRORS)).outcome).toBe('completed');
  });

  it('refuses an advert priced above the ceiling of the request, and no advert of the capability or of the model; at the ceiling it is hired', async () => {
    const above = setup();
    expect((await thrown(hireAgent(above.deps, request({ selection: { capabilityId: AGENT_CAPABILITY, maxPriceLovelace: AGENT_ADVERT.price_lovelace - 1n } }), ERRORS))).code).toBe('no_agent');
    const noModel = setup();
    expect((await thrown(hireAgent(noModel.deps, request({ selection: { capabilityId: AGENT_CAPABILITY, model: 'order-desk-xl' } }), ERRORS))).code).toBe('no_agent');
    const noCapability = setup();
    expect((await thrown(hireAgent(noCapability.deps, request({ selection: { capabilityId: 'supplychain.other.v1' } }), ERRORS))).code).toBe('no_agent');
    for (const run of [above, noModel, noCapability]) expect(run.booked.posted).toStrictEqual([]);
    expect((await hireAgent(setup().deps, request({ selection: { capabilityId: AGENT_CAPABILITY, maxPriceLovelace: AGENT_ADVERT.price_lovelace } }), ERRORS)).outcome).toBe('completed');
  });

  it('does not take an advert that the indexer lists as Active and the chain does not show as the capability that was asked', async () => {
    const run = setup();
    // The indexer's row says one capability; the advert on chain at that ref is another one.
    run.m.rows[1] = indexerRow(AGENT_ADVERT_REF, { ...AGENT_ADVERT, capability_id: 'supplychain.other.v1' }, { agent_id: AGENT_ADVERT.agent_id });
    const error = await thrown(hireAgent(run.deps, request({ selection: { capabilityId: 'supplychain.other.v1' } }), ERRORS));
    expect(error.message).toMatch(/is not, on chain, an Active/);
    expect(run.booked.posted).toStrictEqual([]);
  });
});

describe('hireAgent: refused_before_claim', () => {
  it('says refused_before_claim with the status, the code and the words of the agent when it turns the job down; the escrow stays Open and recorded as an agent entry for the janitor, and nothing is accepted', async () => {
    const run = setup();
    run.m.agent.refuse = { status: 403, code: 'approval_revoked', message: 'The approval was revoked.' };
    const outcome = await hireAgent(run.deps, request(), ERRORS);
    expect(outcome.outcome).toBe('refused_before_claim');
    if (outcome.outcome !== 'refused_before_claim') return;
    expect([outcome.code, outcome.status, outcome.supplierMessage, outcome.vaultRef, outcome.advertRef]).toStrictEqual(['approval_revoked', 403, 'The approval was revoked.', null, AGENT_ADVERT_REF]);
    expect(outcome.message).toContain('approval_revoked');
    expect(await run.m.chain.escrowState(outcome.escrowRef)).toBe('Open');
    expect(run.stranded.list().map((entry) => [entry.escrow_ref, entry.kind])).toStrictEqual([[outcome.escrowRef, 'agent']]);
    expect(run.booked.accepted).toStrictEqual([]);
    // The twin: the same hire of an agent that does not refuse is completed.
    const twin = setup();
    expect((await hireAgent(twin.deps, request(), ERRORS)).outcome).toBe('completed');
  });

  it('says refused_before_claim with the code busy when the agent stays busy until the send runs out of time, and completes when it is free after two tries', async () => {
    const run = setup();
    run.m.agent.busy = 1000;
    const outcome = await hireAgent(run.deps, request(), ERRORS);
    expect(words(outcome)).toBe('refused_before_claim busy');
    expect(outcome).toMatchObject({ status: 409 });
    // Every send was answered busy: the agent never claimed the escrow, which is recorded for the janitor.
    const [entry] = run.stranded.list();
    expect(await run.m.chain.escrowState(entry.escrow_ref)).toBe('Open');
    const twin = setup();
    twin.m.agent.busy = 2;
    expect((await hireAgent(twin.deps, request(), ERRORS)).outcome).toBe('completed');
    expect(twin.sleeps.filter((ms) => ms === 15_000)).toHaveLength(2);
  });

  it('says refused_before_claim with the code and the status of every refusal that the runtime makes before its Claim: the terms of the escrow (409) and its service (403 and others); one send, no retry', async () => {
    for (const [status, code] of [[409, 'wrong_advert'], [409, 'underpaid'], [409, 'bond_mismatch'], [403, 'approval_revoked'], [422, 'order_rejected']] as const) {
      const run = setup();
      run.m.agent.refuse = { status, code };
      const outcome = await hireAgent(run.deps, request(), ERRORS);
      expect(words(outcome)).toBe(`refused_before_claim ${code}`);
      expect(outcome).toMatchObject({ status, supplierMessage: `the service refused the job (${code})` });
      expect(run.m.agent.sends).toHaveLength(1);
    }
  });

  it('says refused_before_claim with the status 503 and the code, after one send, when the runtime could not ask its service: it claimed nothing, so the refusal is final; any other 503 may have claimed, and is sent once more after the escrow is seen Open', async () => {
    for (const code of ['precheck_unreachable', 'precheck_timeout', 'precheck_failed']) {
      const run = setup();
      run.m.agent.refuse = { status: 503, code };
      const outcome = await hireAgent(run.deps, request(), ERRORS);
      expect(words(outcome)).toBe(`refused_before_claim ${code}`);
      expect(outcome).toMatchObject({ status: 503 });
      expect(run.m.agent.sends).toHaveLength(1);
      expect(await run.m.chain.escrowState(run.stranded.list()[0].escrow_ref)).toBe('Open');
    }
    // The twin: a 503 of the runtime that is not one of the three (its Claim could not be sent) may have left the job claimed, so the kit reads the escrow and sends once more.
    const other = setup();
    other.m.agent.refuse = { status: 503, code: 'chain_submit_failed' };
    expect(words(await hireAgent(other.deps, request(), ERRORS))).toBe('refused_before_claim chain_submit_failed');
    expect(other.m.agent.sends).toHaveLength(2);
  });

  it('the janitor reclaims the escrow of a refused vault Pay after its deliver_by, to the vault as a Returned output, and the store is empty afterwards', async () => {
    const run = setup();
    const vault = openVault(run);
    run.m.agent.refuse = { status: 403, code: 'approval_revoked' };
    const outcome = await hireAgent(run.deps, request({ vaultRef: vault }), ERRORS);
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

describe('hireAgent: failed_after_claim', () => {
  it('says failed_after_claim with the reason failed when the agent fails the job it claimed, and with send_lost when the answer to the send was lost after the claim; the escrow goes to the janitor', async () => {
    const failed = setup();
    failed.m.agent.steps = ['running', { fail: 'service_failure', submitted: false }];
    const first = await hireAgent(failed.deps, request(), ERRORS);
    expect(words(first)).toBe('failed_after_claim failed');
    const lost = setup();
    lost.m.agent.lose = ['after-claim'];
    const second = await hireAgent(lost.deps, request(), ERRORS);
    expect(words(second)).toBe('failed_after_claim send_lost');
    for (const [run, outcome] of [[failed, first], [lost, second]] as const) {
      if (outcome.outcome !== 'failed_after_claim') throw new Error('not failed_after_claim');
      expect(outcome.message).toContain(outcome.escrowRef);
      expect(run.stranded.list().map((entry) => [entry.escrow_ref, entry.kind])).toStrictEqual([[outcome.escrowRef, 'agent']]);
      expect(run.booked.accepted).toStrictEqual([]);
    }
    // The twin of send_lost: the answer lost before the claim leaves the escrow Open, and the hire sends again and completes.
    const before = setup();
    before.m.agent.lose = ['before-claim'];
    expect((await hireAgent(before.deps, request(), ERRORS)).outcome).toBe('completed');
    // The first send was lost before the claim and the second was accepted.
    expect(before.m.agent.sends).toHaveLength(2);
  });

  it('says failed_after_claim with the reason bad_result when the finished body has no choices to read, and the escrow is not accepted; a body with choices completes', async () => {
    const run = setup();
    // A fetch that strips the choices out of the answers of the agent, as an agent that does not follow the contract would answer.
    const stripping = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await run.m.fetchImpl(input, init);
      const body: unknown = await res.clone().json().catch(() => null);
      if (body === null || typeof body !== 'object' || !('choices' in body)) return res;
      return new Response(JSON.stringify(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'choices'))), { status: res.status, headers: res.headers });
    }) as typeof fetch;
    const outcome = await hireAgent({ ...run.deps, fetchImpl: stripping }, request(), ERRORS);
    expect(words(outcome)).toBe('failed_after_claim bad_result');
    expect(run.booked.accepted).toStrictEqual([]);
    expect(run.stranded.list()).toHaveLength(1);
    expect((await hireAgent(setup().deps, request(), ERRORS)).outcome).toBe('completed');
  });
});

describe('hireAgent: not_accepted', () => {
  it('says not_accepted with receipt_failed and the verdict when a check fails, and does not ask the decision of the caller; the escrow stays Submitted and recorded', async () => {
    const run = setup();
    run.m.agent.forge = true;
    const calls: unknown[] = [];
    const outcome = await hireAgent(run.deps, request({ decide: (delivery) => { calls.push(delivery); return { accept: true }; } }), ERRORS);
    expect(words(outcome)).toBe('not_accepted receipt_failed');
    if (outcome.outcome !== 'not_accepted' || outcome.reason !== 'receipt_failed') return;
    expect(outcome.verdict?.verdict).toBe('FAILED');
    expect(Object.values(outcome.verdict?.checks ?? {})).toContain('fail');
    expect(calls).toStrictEqual([]);
    expect(await run.m.chain.escrowState(outcome.escrowRef)).toBe('Submitted');
    expect(run.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([outcome.escrowRef]);
    expect(run.booked.accepted).toStrictEqual([]);
    // The twin: a receipt that passes is shown to the decision, once.
    const twin = setup();
    const seen: string[] = [];
    expect((await hireAgent(twin.deps, request({ decide: (delivery) => { seen.push(delivery.text); return { accept: true }; } }), ERRORS)).outcome).toBe('completed');
    expect(seen).toStrictEqual([AGENT_ANSWER]);
  });

  it('says not_accepted with declined and the reason of the caller when the decision says no: no Accept is made, and the escrow stays Submitted and recorded; accepting completes', async () => {
    const run = setup();
    const outcome = await hireAgent(run.deps, request({ decide: () => ({ accept: false, reason: 'the quantity differs from the order' }) }), ERRORS);
    expect(words(outcome)).toBe('not_accepted declined');
    if (outcome.outcome !== 'not_accepted' || outcome.reason !== 'declined') return;
    expect([outcome.declined, outcome.delivery.text, outcome.delivery.verdict.verdict, outcome.delivery.escrowRef]).toStrictEqual(['the quantity differs from the order', AGENT_ANSWER, 'VERIFIED', outcome.escrowRef]);
    expect(await run.m.chain.escrowState(outcome.escrowRef)).toBe('Submitted');
    expect(run.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([outcome.escrowRef]);
    expect(run.booked.accepted).toStrictEqual([]);
    const twin = setup();
    const accepted = await hireAgent(twin.deps, request({ decide: () => ({ accept: true }) }), ERRORS);
    expect(accepted.outcome).toBe('completed');
  });

  it('a decision that throws stops the hire with its own error and nothing is accepted; the decision may be asynchronous', async () => {
    const run = setup();
    const error = await hireAgent(run.deps, request({ decide: async () => { throw new Error('the order desk is closed'); } }), ERRORS).then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('the order desk is closed');
    const [entry] = run.stranded.list();
    expect(await run.m.chain.escrowState(entry.escrow_ref)).toBe('Submitted');
    expect(run.booked.accepted).toStrictEqual([]);
    const twin = setup();
    expect((await hireAgent(twin.deps, request({ decide: async () => ({ accept: true }) }), ERRORS)).outcome).toBe('completed');
  });
});

describe('hireAgent: what is thrown and not an outcome', () => {
  it('throws the factory\'s failure, with the kind agent, for a Post that failed before its signature, and posts nothing; the twin posts', async () => {
    const run = setup();
    const chain: Chain = chainWith(run.m, { postEscrow: async () => { throw new Error('the wallet has no collateral'); } });
    const error = await thrown(hireAgent({ ...run.deps, chain }, request(), ERRORS));
    expect([error.code, error.message]).toStrictEqual(['agent_post_failed', 'The Post for the order failed (the wallet has no collateral). Nothing was locked for it.']);
    expect(run.stranded.list()).toStrictEqual([]);
    expect((await hireAgent(setup().deps, request(), ERRORS)).outcome).toBe('completed');
  });

  it('throws the factory\'s deadline when the run is out of time while it polls', async () => {
    const run = setup({}, 20_000);
    run.m.agent.steps = ['running', 'running', 'running', 'running', 'running', 'running', 'running', 'running', 'done'];
    expect((await thrown(hireAgent(run.deps, request(), ERRORS))).code).toBe('deadline');
    expect(run.stranded.list().map((entry) => entry.kind)).toStrictEqual(['agent']);
  });

  it('refuses an empty payload before anything is chosen or paid', async () => {
    const run = setup();
    await expect(hireAgent(run.deps, request({ payload: '' }), ERRORS)).rejects.toThrow(/non-empty/);
    expect(run.m.calls).toStrictEqual([]);
    expect(run.booked.posted).toStrictEqual([]);
  });
});

describe('hireAgent: paid from a vault', () => {
  it('pays the escrow from the vault with the delegate key: the lock leaves the vault, the Accept returns it as a Returned output, and the result carries the vault that continues', async () => {
    const run = setup();
    const vault = openVault(run);
    const wallet = await run.m.chain.wallet();
    const outcome = await hireAgent(run.deps, request({ vaultRef: vault }), ERRORS);
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
  });

  it('says vault_refused, with the evaluation error and the body of the transaction, for a Pay above the per_tx limit; nothing is posted, sent or recorded, and the vault is as it was; at the limit the Pay completes', async () => {
    const run = setup();
    const vault = openVault(run, { ...LIMIT, perTx: 1_000_000n });
    const outcome = await hireAgent(run.deps, request({ vaultRef: vault }), ERRORS);
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
    const twin = setup();
    expect((await hireAgent(twin.deps, request({ vaultRef: openVault(twin, { ...LIMIT, perTx: 3_000_000n }) }), ERRORS)).outcome).toBe('completed');
  });

  it('says vault_refused for a Pay past the total limit of the period, from the vault that the first Pay left; the first Pay completed', async () => {
    const measure = setup();
    await hireAgent(measure.deps, request({ vaultRef: openVault(measure) }), ERRORS);
    const lock = measure.booked.posted[0].lockLovelace;
    const run = setup();
    const first = await hireAgent(run.deps, request({ vaultRef: openVault(run, { ...LIMIT, total: lock + lock / 2n }) }), ERRORS);
    expect(first.outcome).toBe('completed');
    if (first.outcome !== 'completed' || first.vaultRef === null) throw new Error('the first Pay did not complete');
    const second = await hireAgent(run.deps, request({ vaultRef: first.vaultRef }), ERRORS);
    expect(words(second)).toBe('vault_refused ledger');
    if (second.outcome !== 'vault_refused' || second.refusal.kind === 'impossible') return;
    expect(JSON.stringify(second.refusal.validators)).toContain('above_total');
    expect(run.booked.posted).toHaveLength(1);
    expect(run.m.agent.sends).toHaveLength(1);
    expect(run.m.chain.vault(first.vaultRef)).toMatchObject({ kind: 'Live', consumed: false });
  });

  it('says vault_refused with the reason when the Pay cannot be built: a vault that does not exist, and a delegation that ended; a live vault pays', async () => {
    const missing = setup();
    const noVault = await hireAgent(missing.deps, request({ vaultRef: `${'ab'.repeat(32)}#0` }), ERRORS);
    expect(noVault).toMatchObject({ outcome: 'vault_refused', refusal: { kind: 'impossible', reason: 'no_vault' } });
    const ended = setup();
    const vault = openVault(ended);
    ended.m.chain.endDelegation(DELEGATION);
    const noDelegation = await hireAgent(ended.deps, request({ vaultRef: vault }), ERRORS);
    expect(noDelegation).toMatchObject({ outcome: 'vault_refused', refusal: { kind: 'impossible' } });
    for (const run of [missing, ended]) expect([run.booked.posted, run.m.agent.sends, run.stranded.list()]).toStrictEqual([[], [], []]);
    const live = setup();
    expect((await hireAgent(live.deps, request({ vaultRef: openVault(live) }), ERRORS)).outcome).toBe('completed');
  });

  it('throws unavailable when the chain cannot pay from a vault, before it posts anything; a chain that can is used', async () => {
    const run = setup();
    const vault = openVault(run);
    const plain: Chain = chainWith(run.m, {});
    expect((await thrown(hireAgent({ ...run.deps, chain: plain }, request({ vaultRef: vault }), ERRORS))).message).toMatch(/cannot pay from a vault/);
    expect(run.booked.posted).toStrictEqual([]);
    expect((await hireAgent(run.deps, request({ vaultRef: vault }), ERRORS)).outcome).toBe('completed');
  });
});

describe('hireAgent: the five outcomes in one type', () => {
  it('names each outcome by its own word, which a switch over the type covers without a default', async () => {
    const seen: string[] = [];
    const runs: Array<[Run, Partial<AgentRequest>]> = [];
    const completed = setup();
    runs.push([completed, {}]);
    const refused = setup();
    refused.m.agent.refuse = { status: 422, code: 'bad_order' };
    runs.push([refused, {}]);
    const failed = setup();
    failed.m.agent.steps = [{ fail: 'service_failure', submitted: false }];
    runs.push([failed, {}]);
    const vaultRun = setup();
    runs.push([vaultRun, { vaultRef: openVault(vaultRun, { ...LIMIT, perTx: 1n }) }]);
    const declined = setup();
    runs.push([declined, { decide: () => ({ accept: false, reason: 'no' }) }]);
    for (const [run, over] of runs) seen.push(words(await hireAgent(run.deps, request(over), ERRORS)));
    expect(seen).toStrictEqual(['completed wallet', 'refused_before_claim bad_order', 'failed_after_claim failed', 'vault_refused ledger', 'not_accepted declined']);
  });
});
