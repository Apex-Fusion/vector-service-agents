// agents/reorder-agent/test/execute/world.ts
// The world of the tests of the job `execute`. The Order Desk is the template supplier of the stub marketplace of the hire kit, behind one fetch and one FakeChain that holds a vault. The identity
// gateway is the stub of id-kit. The PO store is a fake fetch, the challenge is a scripted dispute that builds the evidence document with the real function of the kit, and the model is a scripted
// function (fixtures.ts). The agent has two delegation keys on the gateway, each with its own paying key, so that a test can see which key paid. Nothing uses the network, and the clocks are the ones
// of the tests.
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
import type { DelegationId, ExecuteRequest, ExecuteResult, HandoffRecord, ProtocolResult } from '@vsa/usecase-kit/protocol';
import { canonicalize, sha256Utf8Hex } from '@vsa/vector-read';
import { runExecute } from '../../src/execute/index.ts';
import type { DelegationKeyDeps, ExecuteDeps } from '../../src/execute/index.ts';
import { APPROVAL, SUPPLIER_DID, ScriptedAccept, challengeFiled, confirmationOf, executeRequest, purchaseOrder } from './fixtures.ts';

export { T0 };

export const BASES: MockBases = { publicBase: 'https://mock.example', mtlsBase: 'https://mock-mtls.example' };
export const DELEGATION: DelegationId = 'dd'.repeat(32);
/** The limit of the delegation: the lot of 7 units passes (the price 5 and the bonds 1 and 1), and the lot of 12 does not. */
export const LIMIT = { perTx: 7_000_000n, total: 7_000_000n, periodMs: 86_400_000 };
/** The three limits of the hire of the Order Desk: the price of the large lot, and the bonds of every advert. */
export const LIMITS: HireLimits = { maxPriceLovelace: 10_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n };
const PRICES = { 'lot-small': 2_000_000n, 'lot-medium': 5_000_000n, 'lot-large': 10_000_000n } as const;
export type Lot = keyof typeof PRICES;

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

/** A call that the PO store got. The header names are in lower case. */
export interface StoreCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** The PO store as a fake fetch. It records each call, and it answers what the test says: a 201 with a record by default. */
export class PoStore {
  readonly calls: StoreCall[] = [];
  answer: (call: StoreCall) => Response | Promise<Response> = () => jsonResponse(201, { record_id: 'PO-run1-0001', po_number: 'run1-1', status: 'recorded', recorded_at: '2026-11-23T10:00:00.000Z' });

  readonly fetch: typeof fetch = async (input, init) => {
    const call: StoreCall = { method: init?.method ?? 'GET', url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: typeof init?.body === 'string' ? init.body : '' };
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
  /** The lot of the advert of the Order Desk. Its price is 2, 5 or 10 units. Default `lot-medium`. */
  readonly lot?: Lot;
  /** Open no vault. */
  readonly vault?: boolean;
  readonly limit?: typeof LIMIT;
  /** The delegation key that the delegation names as its delegate key: the first key of the agent by default. */
  readonly delegate?: 'a' | 'b';
}

export interface World {
  readonly m: Marketplace;
  readonly gateway: StubGateway;
  readonly agent: StubAgent;
  readonly delegation: StubDelegation;
  readonly po: TokenTarget;
  readonly lot: Lot;
  readonly a: KeyWorld;
  readonly b: KeyWorld;
  readonly reads: FakeReads;
  readonly store: PoStore;
  readonly dispute: ScriptedDispute;
  readonly accept: ScriptedAccept;
  /** The token requests that the job made, with the answer of the gateway. */
  readonly tokens: Array<{ request: TokenRequest; answer: GatewayResult<IssuedToken> }>;
  readonly log: string[];
  readonly booked: { posted: number; accepted: number };
  /** The delegate key that the ledger shows: the key hash that `delegateKeyOf` gives, or `null` for a delegation that is not shown. A test may also make the read fail. */
  readonly delegateKey: { hash: string | null; failure: Error | null };
  /** How the Order Desk signs its receipts: the nesting depth of `prompt_tokens`. 0 is a plain receipt. */
  readonly receipt: { depth: number };
  readonly deps: ExecuteDeps;
  /** The vault that the world opened. */
  vault: string;
  /** The order document of the world: the lot of its advert, and `over` replaces members. */
  document(over?: Record<string, unknown>): Record<string, unknown>;
  /** The `execute` request for a document, with the approval of the tests unless another is given (`null` is a request with no approval). */
  request(document?: Record<string, unknown>, approval?: unknown): ExecuteRequest;
  /** The Order Desk answers with the confirmation of the order document of the world, with `over` replacing members. A text is the answer as it is. */
  answer(over?: Record<string, unknown> | string): void;
  run(request?: ExecuteRequest, arrivedAt?: number, deps?: ExecuteDeps, signal?: AbortSignal): Promise<ExecuteResult>;
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
  const lot = options.lot ?? 'lot-medium';
  const m = marketplace({ agentAdvert: { ...AGENT_ADVERT, model: lot, price_lovelace: PRICES[lot] } });
  const dir = mkdtempSync(join(tmpdir(), 'reorder-execute-'));
  dirs.push(dir);
  const registry = new PayingKeys(dir);
  const gateway = createStubGateway();
  const hirer = ed25519Key('hirer');
  const agent = gateway.createAgent({ label: 'reorder agent' });
  const second = ed25519Key('reorder agent: second delegation key');
  agent.keys.push({ key: second, purposes: 16 });
  const po = tokenTarget(BASES, 'run1', 'po.write');
  if (!po.ok) throw new Error('the PO target of the test is refused');
  const named = options.delegate === 'b' ? second : agent.delegation;
  const delegation = gateway.delegate({
    delegator: { principalKey: hirer }, delegate: agent, delegateKey: named, actions: ['marketplace.hire.v1', 'erp.stock.read', 'po.write'], resources: [po.value.resource], remaining: 1, id: DELEGATION,
  });

  const keyWorld = async (testKey: TestKey): Promise<KeyWorld> => {
    const pays: string[] = [];
    const chain = vaultChainWith(m, {
      wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: testKey.keyHash }),
      payFromVault: async (args) => {
        pays.push(args.vaultRef);
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
  const store = new PoStore();
  const dispute = new ScriptedDispute(agent.did);
  const accept = new ScriptedAccept();
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
    log: (line) => { log.push(line); },
  };

  /** A paying key whose chain posts from its wallet and cannot pay from a vault: the service key, and a delegation key with a fault of the settings. */
  const walletKey = async (label: string): Promise<{ key: PayingKey; testKey: TestKey }> => {
    const testKey = ed25519Key(label);
    const key = await registry.add(chainWith(m, { wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: testKey.keyHash }) }));
    return { key, testKey };
  };
  const receipt = { depth: 0 };
  const document = (over: Record<string, unknown> = {}): Record<string, unknown> => purchaseOrder({ lot, ...over });
  const made: World = {
    m, gateway, agent, delegation, po: po.value, lot, a, b, reads, store, dispute, accept, tokens, log, booked, delegateKey, receipt, deps,
    vault: options.vault === false ? '' : m.chain.openVault({ delegation: DELEGATION, lovelace: 40_000_000n, limit: options.limit ?? LIMIT }),
    document,
    request: (given = document(), approval: unknown = APPROVAL) => executeRequest(given, DELEGATION, approval),
    answer: (over = {}) => { m.agent.answer = typeof over === 'string' ? over : JSON.stringify(confirmationOf(document(), over)); },
    run: (request = made.request(), arrivedAt = T0, given = made.deps, signal) => runExecute(given, request, arrivedAt, signal),
    endDelegation: () => {
      m.chain.endDelegation(DELEGATION);
      reads.delegations.set(DELEGATION, null);
    },
    plainKey: async () => {
      const { key, testKey } = await walletKey('reorder agent: a key whose chain pays from the wallet only');
      return { key, dpopKey: testKey.privateKey };
    },
    serviceKey: async () => (await walletKey('reorder agent: service key')).key,
  };
  signReceipts(m, lot, receipt);
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

/** What a job left behind, as numbers that a test compares: the Pays that were made, the sends to the Order Desk, the calls to the PO store, the challenges, and the questions to the model. */
export interface Footprint {
  readonly paid: number;
  readonly sends: number;
  readonly poWrites: number;
  readonly challenges: number;
  readonly asked: number;
}

/** A Pay spends the vault that it pays from, so the Pays that were made are the vault outputs that were spent. */
export function footprint(w: World): Footprint {
  return { paid: w.m.chain.vaults().filter((vault) => vault.consumed).length, sends: w.m.agent.sends.length, poWrites: w.store.calls.length, challenges: w.dispute.calls.length, asked: w.accept.calls.length };
}

/** The footprint of a job that did nothing: no Pay, no send, no write, no challenge and no question. */
export const NOTHING: Footprint = { paid: 0, sends: 0, poWrites: 0, challenges: 0, asked: 0 };

/**
 * A fetch in front of the marketplace that lets a test answer the poll of the job of the Order Desk (GET /v1/job/<id> of the template supplier). `answer` gets the response of the supplier, and it gives
 * the response to hand back, or `undefined` to hand back the response of the supplier.
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
 * Makes the Order Desk of the world sign its receipts as the Order Desk does: the model of the receipt is the lot of its advert (the check `model_matches` compares it with the advert), and the text is the
 * answer that the test gave at the time of the poll. The receipt is signed and its hash is on the chain, so the eight checks of the hire kit pass. With `receipt.depth` of 1 or more, `prompt_tokens` is an
 * array nested that many levels deep: the reader of the protocol takes no member that is nested so deep, so no result can hold the delivery.
 */
function signReceipts(m: Marketplace, lot: Lot, receipt: { depth: number }): void {
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
          escrow_ref: job.escrowRef, supplier_pkh: AGENT_KEY.pkh, prompt_hash: sha256Utf8Hex(job.payload), response_hash: sha256Utf8Hex(text), model: lot, prompt_tokens: tokens,
          completion_tokens: 0, wallclock_ms: 1204, agent_did: SUPPLIER_DID,
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
