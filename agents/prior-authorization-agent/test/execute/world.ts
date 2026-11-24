// agents/prior-authorization-agent/test/execute/world.ts
// The world of the tests of the job `execute`. The Insurer Intake Agent is the template supplier of the stub marketplace of the hire kit, behind one fetch and one FakeChain that holds a vault. The identity
// gateway is the stub of id-kit. The records system is a fake fetch, the challenge is a scripted dispute that builds the evidence document with the real function of the kit, and the model is a scripted function
// (fixtures.ts). The agent has two delegation keys on the gateway, each with its own paying key, so that a test can see which key paid. Nothing uses the network, and the clocks are the ones of the tests.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PayingKeys } from '@vsa/hire-kit';
import type { HireLedger, PayingKey } from '@vsa/hire-kit';
import { AGENT_ADVERT, AGENT_ENDPOINT, AGENT_KEY, T0, chainWith, marketplace, vaultChainWith } from '@vsa/hire-kit/testing';
import type { Marketplace } from '@vsa/hire-kit/testing';
import { createGatewayClient } from '@vsa/id-kit/client';
import type { GatewayClient, GatewayResult, IssuedToken, TokenRequest } from '@vsa/id-kit/client';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import type { StubAgent, StubDelegation, StubGateway, TestKey } from '@vsa/id-kit/testing';
import { tokenTarget } from '@vsa/usecase-kit/access';
import type { MockBases, TokenTarget } from '@vsa/usecase-kit/access';
import type { DelegationReading, HireLimits, LedgerReads, LiveVaults } from '@vsa/usecase-kit/buyer';
import { evidenceDocument } from '@vsa/usecase-kit/dispute';
import type { ChallengeResult, DeliveryChallengeInput, DocumentCode, JurorDocument } from '@vsa/usecase-kit/dispute';
import { readFaultSwitch, withFaultModeJob } from '@vsa/usecase-kit/fault';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { PRIORAUTH_CAPABILITIES, PRIORAUTH_MODELS } from '@vsa/usecase-kit/priorauth';
import type { DelegationId, ExecuteRequest, ExecuteResult, HandoffRecord, ProtocolResult } from '@vsa/usecase-kit/protocol';
import { canonicalize, sha256Utf8Hex } from '@vsa/vector-read';
import { runExecute } from '../../src/execute/index.ts';
import type { DelegationKeyDeps, ExecuteDeps } from '../../src/execute/index.ts';
import { APPROVAL, INSURER_DID, ScriptedAccept, challengeFiled, executeRequest, intakeRecordOf, requestDocument } from './fixtures.ts';

export { T0 };

export const BASES: MockBases = { publicBase: 'https://mock.example', mtlsBase: 'https://mock-mtls.example' };
export const DELEGATION: DelegationId = 'dd'.repeat(32);
/** The limit of the delegation: the Pay of 4 units passes (the price 2 and the bonds 1 and 1), and a `perTx` of 3 refuses it. */
export const LIMIT = { perTx: 4_000_000n, total: 4_000_000n, periodMs: 86_400_000 };
/** The three limits of the hire of the Insurer Intake Agent: the price of its advert, and the bond limit of every advert. */
export const LIMITS: HireLimits = { maxPriceLovelace: 2_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n };
/** The price of the advert of the Insurer Intake Agent in the world. */
export const PRICE = 2_000_000n;

export const jsonResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const pageResponse = (status: number, body: string): Response => new Response(body, { status, headers: { 'content-type': 'text/html' } });

/** The reads of the ledger that follow the FakeChain: the Live vaults of a delegation are the unspent Live vault outputs of the chain. A test sets the delegation, or makes a read fail. */
export class FakeReads implements LedgerReads {
  readonly delegations = new Map<string, DelegationReading | null>();
  readonly calls = { delegation: 0, liveVaults: 0 };
  failDelegation: Error | null = null;

  constructor(private readonly chain: Marketplace['chain']) {}

  async delegation(id: DelegationId): Promise<DelegationReading | null> {
    this.calls.delegation += 1;
    if (this.failDelegation !== null) throw this.failDelegation;
    return this.delegations.get(id) ?? null;
  }

  async liveVaults(id: DelegationId, _atMs: number): Promise<LiveVaults> {
    this.calls.liveVaults += 1;
    const refs = this.chain.vaults().filter((vault) => vault.kind === 'Live' && !vault.consumed && vault.delegation === id).map((vault) => vault.ref);
    return { refs, complete: true };
  }
}

/** A call that the records system got. The header names are in lower case. */
export interface RecordsCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** The records system as a fake fetch. It records each call, and it answers what the test says: a 201 with a submission by default. */
export class RecordsSystem {
  readonly calls: RecordsCall[] = [];
  answer: (call: RecordsCall) => Response | Promise<Response> = () => jsonResponse(201, {
    submission_id: 'SUB-run1-0001', order_id: 'ORD-1001', request_number: 'run1-1', intake_id: 'INT-run1-0001', recorded_at: '2026-11-24T10:00:00.000Z',
  });

  readonly fetch: typeof fetch = async (input, init) => {
    const call: RecordsCall = { method: init?.method ?? 'GET', url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === 'string' ? init.body : '' };
    this.calls.push(call);
    return this.answer(call);
  };
}

/** The dispute folder as a function. It builds the evidence document with the real function of the kit, so a challenge that no document can state is not filed, as the real code does not file it. */
export class ScriptedDispute {
  readonly calls: DeliveryChallengeInput[] = [];
  readonly documents: Array<ProtocolResult<JurorDocument, DocumentCode>> = [];
  /** What the dispute folder answers when the evidence document is built. */
  answer: () => ChallengeResult | Promise<ChallengeResult> = () => challengeFiled();
  /** Make the call throw. */
  failWith: Error | null = null;

  constructor(private readonly challenger: string) {}

  readonly challengeDelivery = async (input: DeliveryChallengeInput): Promise<ChallengeResult> => {
    this.calls.push(input);
    if (this.failWith !== null) throw this.failWith;
    const document = evidenceDocument({
      claim: `${'c1'.repeat(32)}#0`, claim_token: `636c6d5f${'11'.repeat(28)}`, against_did: input.counterparty, by_did: this.challenger, escrow_ref: input.escrow_ref,
      statement_text: input.statement_text, ...input.evidence,
    });
    this.documents.push(document);
    if (!document.ok) return { ok: false, code: document.code, detail: document.detail, evidence: null, sent: null, challenge: null, wrong_document: null };
    return this.answer();
  };
}

/** One delegation key of the agent: its paying key on the FakeChain, and the vault references that it tried to pay from. */
export interface KeyWorld {
  readonly testKey: TestKey;
  readonly key: PayingKey;
  readonly entry: DelegationKeyDeps;
  readonly pays: string[];
}

export interface WorldOptions {
  /** The price of the advert of the Insurer Intake Agent, in lovelace. Default 2 units. */
  readonly price?: bigint;
  /** Open no vault. */
  readonly vault?: boolean;
  readonly limit?: typeof LIMIT;
  /** The delegation key that the delegation names as its delegate key: the first key of the agent by default. */
  readonly delegate?: 'a' | 'b';
  /** The setting `FAULT_MODE`: the empty text by default. */
  readonly fault?: '' | 'alter_after_approval';
  /** Members of the advert of the Insurer Intake Agent that replace the members of the right advert: its capability or its model. */
  readonly advert?: Partial<{ capability_id: string; model: string }>;
}

export interface World {
  readonly m: Marketplace;
  readonly gateway: StubGateway;
  readonly agent: StubAgent;
  readonly delegation: StubDelegation;
  /** The target of the write to the records system for the order of the request document of the world. */
  readonly records: TokenTarget;
  readonly a: KeyWorld;
  readonly b: KeyWorld;
  readonly reads: FakeReads;
  readonly store: RecordsSystem;
  readonly dispute: ScriptedDispute;
  readonly accept: ScriptedAccept;
  readonly fault: FaultSwitch<'prior-authorization-agent'>;
  /** The token requests that the job made, with the answer of the gateway. */
  readonly tokens: Array<{ request: TokenRequest; answer: GatewayResult<IssuedToken> }>;
  readonly log: string[];
  readonly booked: { posted: number; accepted: number };
  /** The delegate key that the ledger shows: the key hash that `delegateKeyOf` gives, or `null` for a delegation that is not shown. A test may also make the read fail. */
  readonly delegateKey: { hash: string | null; failure: Error | null };
  /** How the Insurer Intake Agent signs its receipts: the nesting depth of `prompt_tokens`. 0 is a plain receipt. */
  readonly receipt: { depth: number };
  /** An error that every delegation key throws when it is asked to pay from the vault, as a Pay that was sent and not seen confirmed does. `null` leaves the Pay to the chain. */
  readonly payFailure: { error: Error | null };
  readonly deps: ExecuteDeps;
  /** The vault that the world opened. */
  vault: string;
  /** The request document of the world, and `over` replaces members. */
  document(over?: Record<string, unknown>): Record<string, unknown>;
  /** The `execute` request for a document, with the approval of the tests unless another is given (`null` is a request with no approval), and the tenant of the tests unless another is given. */
  request(document?: Record<string, unknown>, approval?: unknown, tenant?: string): ExecuteRequest;
  /** The text of the intake record that the Insurer Intake Agent of the world signs for a request document, with `over` replacing members. Its sender is the agent of the world. */
  recordFor(document: Record<string, unknown>, over?: Record<string, unknown>): string;
  /** The Insurer Intake Agent answers with the intake record of the request document of the world, with `over` replacing members. A text is the answer as it is. */
  answer(over?: Record<string, unknown> | string): void;
  run(request?: ExecuteRequest, arrivedAt?: number, deps?: ExecuteDeps, signal?: AbortSignal): Promise<ExecuteResult>;
  /** The job as the service wraps it: the fault switch stamps `fault_mode` on the result. */
  runStamped(request?: ExecuteRequest, arrivedAt?: number, deps?: ExecuteDeps, signal?: AbortSignal): Promise<ExecuteResult>;
  /** The hirer ends the delegation: the chain refuses a Pay under it, and the ledger no longer shows it. */
  endDelegation(): void;
  /** A delegation key whose chain cannot pay from a vault: a fault of the settings of the service. */
  plainKey(): Promise<DelegationKeyDeps>;
  /** The service key of the agent: the paying key that the model hires run from. */
  serviceKey(): Promise<PayingKey>;
}

/**
 * The sleep of the clock of a call. A call bounds its wait with this sleep and races it with the work, so a sleep that ends at once ends every call as a time out. This sleep ends when its signal aborts, as
 * the timer of a real clock ends when the call is over: no test moves time for a call to a mock system.
 */
function waitForSignal(_ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    signal?.addEventListener('abort', () => { resolve(); }, { once: true });
  });
}

const dirs: string[] = [];
/** Removes the state folders of the paying keys that `world` made. Each test file calls it in `afterEach`. */
export function cleanWorlds(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export async function world(options: WorldOptions = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'prior-execute-'));
  dirs.push(dir);
  const registry = new PayingKeys(dir);
  const gateway = createStubGateway();
  const hirer = ed25519Key('hirer');
  const agent = gateway.createAgent({ label: 'prior authorization agent' });
  const second = ed25519Key('prior authorization agent: second delegation key');
  agent.keys.push({ key: second, purposes: 16 });
  const sample = requestDocument();
  const records = tokenTarget(BASES, 'run1', 'records.submission', { order_id: String(sample.order_id) });
  if (!records.ok) throw new Error('the records target of the test is refused');
  const named = options.delegate === 'b' ? second : agent.delegation;
  // A vault Pay names the delegate key that signs it as the buyer of its escrow. The chain of the world posts with that key, so the datum of each escrow holds a key that is in `buyerPkhs`.
  const m = marketplace({
    agentAdvert: { ...AGENT_ADVERT, capability_id: PRIORAUTH_CAPABILITIES.intake, model: PRIORAUTH_MODELS.intake, price_lovelace: options.price ?? PRICE, ...options.advert }, buyerPkh: named.keyHash,
  });
  m.agent.capabilityOverride = { capability_id: PRIORAUTH_CAPABILITIES.intake, model: PRIORAUTH_MODELS.intake };
  const delegation = gateway.delegate({
    delegator: { principalKey: hirer }, delegate: agent, delegateKey: named, actions: ['marketplace.hire.v1', 'priorauth.submit'], resources: [records.value.resource], remaining: 1, id: DELEGATION,
  });

  const payFailure: World['payFailure'] = { error: null };
  const keyWorld = async (testKey: TestKey): Promise<KeyWorld> => {
    const pays: string[] = [];
    const chain = vaultChainWith(m, {
      wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: testKey.keyHash }),
      payFromVault: async (args) => {
        pays.push(args.vaultRef);
        if (payFailure.error !== null) throw payFailure.error;
        return m.chain.payFromVault(args);
      },
    });
    const key = await registry.add(chain);
    return { testKey, key, entry: { key, dpopKey: testKey.privateKey }, pays };
  };
  const a = await keyWorld(agent.delegation);
  const b = await keyWorld(second);

  const reads = new FakeReads(m.chain);
  reads.delegations.set(DELEGATION, { delegate: agent.id, chain_whole: true });
  const real = createGatewayClient({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: gateway.now });
  const tokens: World['tokens'] = [];
  const client: Pick<GatewayClient, 'requestToken'> = {
    requestToken: async (request) => {
      const answer = await real.requestToken(request);
      tokens.push({ request, answer });
      return answer;
    },
  };
  const booked = { posted: 0, accepted: 0 };
  const ledger: HireLedger = { posted: () => { booked.posted += 1; }, accepted: () => { booked.accepted += 1; } };
  const store = new RecordsSystem();
  const dispute = new ScriptedDispute(agent.did);
  const accept = new ScriptedAccept();
  const fault = readFaultSwitch('prior-authorization-agent', options.fault ?? '');
  const log: string[] = [];
  const delegateKey: World['delegateKey'] = { hash: named.keyHash, failure: null };
  const deps: ExecuteDeps = {
    reads,
    delegateKeyOf: async () => {
      if (delegateKey.failure !== null) throw delegateKey.failure;
      return delegateKey.hash;
    },
    delegationKeys: { find: (hash) => (hash === a.testKey.keyHash ? a.entry : hash === b.testKey.keyHash ? b.entry : null), first: a.entry },
    hire: { clock: () => m.clock.now, sleep: async (ms) => { m.clock.now += ms; }, fetchImpl: m.fetchImpl, ledger },
    limits: LIMITS,
    acceptDelivery: accept.acceptDelivery,
    dispute,
    buyerPkhs: [a.testKey.keyHash, b.testKey.keyHash],
    agent: { did: agent.did, authenticationKey: agent.authentication.privateKey },
    tokens: { client },
    calls: { fetch: store.fetch, clock: { now: () => gateway.now(), sleep: waitForSignal }, bases: BASES },
    fault,
    log: (line) => { log.push(line); },
  };

  /** A paying key whose chain posts from its wallet and cannot pay from a vault: the service key, and a delegation key with a fault of the settings. */
  const walletKey = async (label: string): Promise<{ key: PayingKey; testKey: TestKey }> => {
    const testKey = ed25519Key(label);
    const key = await registry.add(chainWith(m, { wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: testKey.keyHash }) }));
    return { key, testKey };
  };
  const receipt = { depth: 0 };
  const document = (over: Record<string, unknown> = {}): Record<string, unknown> => requestDocument(over);
  const recordFor = (given: Record<string, unknown>, over: Record<string, unknown> = {}): string => JSON.stringify(
    intakeRecordOf(given, { sender: { did: agent.did, organisation: 'org.example', organisation_verified: true }, ...over }),
  );
  const made: World = {
    m, gateway, agent, delegation, records: records.value, a, b, reads, store, dispute, accept, fault, tokens, log, booked, delegateKey, receipt, payFailure, deps,
    vault: options.vault === false ? '' : m.chain.openVault({ delegation: DELEGATION, lovelace: 40_000_000n, limit: options.limit ?? LIMIT }),
    document,
    request: (given = document(), approval: unknown = APPROVAL, tenant?: string) => executeRequest(given, DELEGATION, approval, tenant),
    recordFor,
    answer: (over = {}) => { m.agent.answer = typeof over === 'string' ? over : recordFor(document(), over); },
    run: (request = made.request(), arrivedAt = T0, given = made.deps, signal) => runExecute(given, request, arrivedAt, signal),
    runStamped: (request = made.request(), arrivedAt = T0, given = made.deps, signal) => withFaultModeJob(fault, runExecute)(given, request, arrivedAt, signal),
    endDelegation: () => {
      m.chain.endDelegation(DELEGATION);
      reads.delegations.set(DELEGATION, null);
    },
    plainKey: async () => {
      const { key, testKey } = await walletKey('prior authorization agent: a key whose chain pays from the wallet only');
      return { key, dpopKey: testKey.privateKey };
    },
    serviceKey: async () => (await walletKey('prior authorization agent: service key')).key,
  };
  signReceipts(m, receipt);
  made.answer();
  return made;
}

/** One word for a result: its outcome, its reason and its exit state. */
export const words = (result: ExecuteResult): string => `${result.outcome} ${result.reason ?? 'none'} ${result.exit_state}`;

/** The record of the hire of a result. The test fails when the result holds none. */
export function hireOf(result: ExecuteResult): HandoffRecord {
  if (result.handoff === null) throw new Error(`the result ${words(result)} holds no record of a hire`);
  return result.handoff;
}

/** What a job left behind, as numbers that a test compares: the Pays that were made, the sends to the Insurer Intake Agent, the calls to the records system, the challenges, and the questions to the model. */
export interface Footprint {
  readonly paid: number;
  readonly sends: number;
  readonly writes: number;
  readonly challenges: number;
  readonly asked: number;
}

/** A Pay spends the vault that it pays from, so the Pays that were made are the vault outputs that were spent. */
export function footprint(w: World): Footprint {
  return { paid: w.m.chain.vaults().filter((vault) => vault.consumed).length, sends: w.m.agent.sends.length, writes: w.store.calls.length, challenges: w.dispute.calls.length, asked: w.accept.calls.length };
}

/** The footprint of a job that did nothing: no Pay, no send, no write, no challenge and no question. */
export const NOTHING: Footprint = { paid: 0, sends: 0, writes: 0, challenges: 0, asked: 0 };

/** The handoff that the Insurer Intake Agent received, as it read it from the wire payload of the first send. */
export function handoffSent(w: World): Record<string, unknown> {
  const payload: unknown = JSON.parse(w.m.agent.sends[0]!.payload);
  // The wire payload is a list of one message: `[{"content":"<request JSON>","role":"user"}]`.
  const messages = payload as Array<{ content: string }>;
  const handoff: unknown = JSON.parse(messages[0]!.content);
  return handoff as Record<string, unknown>;
}

/**
 * A fetch in front of the marketplace that lets a test answer the poll of the job of the Insurer Intake Agent (GET /v1/job/<id> of the template supplier). `answer` gets the response of the supplier, and it
 * gives the response to hand back, or `undefined` to hand back the response of the supplier.
 */
export function inFrontOfPolls(m: Marketplace, answer: (reached: Response) => Response | undefined): typeof fetch {
  return (async (target: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    const reached = await m.fetchImpl(target, init);
    if ((init?.method ?? 'GET') === 'GET' && url.origin === AGENT_ENDPOINT && url.pathname.startsWith('/v1/job/')) return answer(reached.clone()) ?? reached;
    return reached;
  }) as typeof fetch;
}

interface SupplierJob {
  readonly escrowRef: string;
  readonly payload: string;
  readonly steps: readonly unknown[];
  finished?: Record<string, unknown>;
}

/**
 * Makes the Insurer Intake Agent of the world sign its receipts as the agent does: the model of the receipt is the model of its advert (the check `model_matches` compares it with the advert), and the text is
 * the answer that the test gave at the time of the poll. The receipt is signed and its hash is on the chain, so the eight checks of the hire kit pass. With `receipt.depth` of 1 or more, `prompt_tokens` is an
 * array nested that many levels deep: the reader of the protocol takes no member that is nested so deep, so no result can hold the delivery.
 */
function signReceipts(m: Marketplace, receipt: { depth: number }): void {
  const original = m.agent.handle.bind(m.agent);
  m.agent.handle = async (method: string, path: string, body: string): Promise<Response> => {
    if (method === 'GET' && path.startsWith('/v1/job/')) {
      const job = (m.agent.jobs as Map<string, SupplierJob>).get(decodeURIComponent(path.slice('/v1/job/'.length)));
      // The poll that comes next finishes the job (a Submit and a receipt) or it does not: a job that fails after its Claim submits nothing.
      const next: unknown = job?.steps[0];
      const finishing = next === 'done' || next === 'gateway-after-submit' || (typeof next === 'object' && next !== null && Reflect.get(next, 'submitted') === true);
      if (job !== undefined && job.finished === undefined && finishing) {
        const text = m.agent.answer;
        let tokens: unknown = 0;
        for (let level = 0; level < receipt.depth; level += 1) tokens = [tokens];
        const signed = {
          escrow_ref: job.escrowRef, supplier_pkh: AGENT_KEY.pkh, prompt_hash: sha256Utf8Hex(job.payload), response_hash: sha256Utf8Hex(text), model: PRIORAUTH_MODELS.intake, prompt_tokens: tokens,
          completion_tokens: 0, wallclock_ms: 1204, agent_did: INSURER_DID,
        };
        const signature = AGENT_KEY.sign(signed);
        m.chain.markSubmitted(job.escrowRef, sha256Utf8Hex(canonicalize({ receipt: signed, signature })));
        job.finished = {
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          receipt: signed, receipt_signature: signature, escrow_ref: job.escrowRef, submitted_ref: `${'ef'.repeat(32)}#0`,
        };
      }
    }
    return original(method, path, body);
  };
}
