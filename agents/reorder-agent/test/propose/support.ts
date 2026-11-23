// agents/reorder-agent/test/propose/support.ts: what the tests of the propose folder share. `runPropose` runs the REAL `withSubDelegation` of the kit over the ledger, the clock and the keys of the tests of
// the access folder of the kit, so the Delegate and the Undelegate are real transaction bytes, and the clock is moved by the test. The gateway, the ERP, the supplier, the model, the list of left
// sub-delegations and the set of the sub-delegations in use are scripted here. No test uses the network, and no test waits for real time.
import { expect } from 'vitest';
import type { GatewayRefused, GatewayResult, IssuedToken, TokenRequest } from '@vsa/id-kit/client';
import { ed25519Key } from '@vsa/id-kit/testing';
import type { TestKey } from '@vsa/id-kit/testing';
import { createSerialQueue } from '@vsa/usecase-kit/access';
import type { SerialQueue } from '@vsa/usecase-kit/access';
import type { DelegationReading } from '@vsa/usecase-kit/buyer';
import type { LotName } from '@vsa/usecase-kit/inventory';
import { runJanitorOnce } from '@vsa/usecase-kit/janitor';
import type { JanitorReport } from '@vsa/usecase-kit/janitor';
import { accepted, refused } from '@vsa/usecase-kit/protocol';
import type { Decision, DelegationId, Document, ProposalResult, ProposedResult, ProtocolResult, SubJob } from '@vsa/usecase-kit/protocol';
import {
  AGENT_ID, AGENT_KEY, BASES, DAY, FakeClock, FakeDelegations, NOW, OTHER_KEY, PARENT_ID, SCRIPT, SUBAGENT_ID, SUBAGENT_KEY, WALLET, markSigner, parentDatum, slotOf,
} from '../../../../packages/usecase-kit/test/access/support.ts';
import { MemoryPoCounter, runPropose } from '../../src/propose/index.ts';
import type { DelegationKey, LeftEntry, LeftSink, PoCounter, ProposeDeps, ProposeRequest, ReorderAnswer, ReorderChoice, SupplierRead } from '../../src/propose/index.ts';

export { AGENT_KEY, BASES, DAY, FakeClock, NOW, OTHER_KEY, PARENT_ID, SCRIPT, SUBAGENT_KEY, WALLET, markSigner, parentDatum, slotOf };

export const AGENT_DID = `did:vector:${AGENT_ID}`;
export const SUBAGENT_DID = `did:vector:${SUBAGENT_ID}`;
export const SUPPLIER_DID = `did:vector:${'d5'.repeat(32)}`;
export const PRINCIPAL_DID = `did:vector:${'1f'.repeat(32)}`;
export const TENANT = 'run1';
export const SKU = 'GLV-NIT-M';
/** The resource of the ERP of the tenant: the one resource of the sub-delegation. */
export const ERP_RESOURCE = `${BASES.publicBase}/t/${TENANT}/erp`;

/** The stock reading that the ERP gives for the SKU. */
export const STOCK: Document = { sku: SKU, on_hand: 60, threshold: 100, daily_usage: 12, lead_time_days: 7, open_orders: 0 };
export const LOTS: Record<LotName, number> = { 'lot-small': 10, 'lot-medium': 50, 'lot-large': 200 };
export const SUPPLIER: SupplierRead = {
  adverts: {
    'lot-small': { advert_ref: `${'11'.repeat(32)}#0` },
    'lot-medium': { advert_ref: `${'22'.repeat(32)}#1` },
    'lot-large': { advert_ref: `${'33'.repeat(32)}#2` },
  },
  lots: LOTS,
};
export const CHOICE: ReorderChoice = { lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01' };

const VERIFICATION = {
  escrow_ref_matches: true, response_hash_matches: true, supplier_key_matches: true, signature_valid: true, on_chain_hash_matches: true, prompt_hash_matches: true, model_matches: true, fields_match: true,
} as const;
export const SUB_JOB: SubJob = {
  capability_id: 'llm.text.generate.v1',
  advert_ref: `${'4a'.repeat(32)}#0`,
  escrow_ref: `${'5b'.repeat(32)}#0`,
  supplier_pkh: 'ab'.repeat(28),
  receipt: { escrow_ref: `${'5b'.repeat(32)}#0`, model: 'deepseek/deepseek-v4-flash' },
  receipt_signature: 'cd'.repeat(64),
  verification: VERIFICATION,
};
/** The decision `reorder` as the model hire gives it. */
export const DECISION: Decision = {
  name: 'reorder',
  choice: { lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01' },
  reasoning: 'the stock is below the threshold',
  inference: { path: 'marketplace', sub_job: SUB_JOB, accepted: 'confirmed' },
};

/** The answer of the decision `reorder` for a choice: the decision records that same choice, as the decision of the model does. */
export function answerFor(choice: ReorderChoice): ReorderAnswer {
  return { ok: true, decision: { ...DECISION, choice: { lot: choice.lot, quantity: choice.quantity, needed_by: choice.needed_by } }, choice };
}

/** The request of the golden run: the delegation of the hirer to this agent, the tenant, the SKU and the supplier. */
export const REQUEST: ProposeRequest = {
  op: 'propose',
  authority: { principal_did: PRINCIPAL_DID, delegation: PARENT_ID },
  tenant: TENANT,
  sku: SKU,
  supplier_did: SUPPLIER_DID,
};

const NUMBERS = ['on_hand', 'threshold', 'daily_usage', 'lead_time_days', 'open_orders'];
/** A stand-in for the parser of the stock reading that the service wires in: the six members of the ERP reading, with numbers as numbers. */
export function parseStock(body: unknown): ProtocolResult<Document> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return refused('bad_shape', 'the stock reading is not an object');
  const given = body as Record<string, unknown>; // each member is checked below
  if (Object.keys(given).length !== 6 || typeof given.sku !== 'string' || NUMBERS.some((name) => typeof given[name] !== 'number')) return refused('bad_shape', 'the stock reading has other members');
  const reading: Record<string, string | number> = { sku: given.sku };
  for (const name of NUMBERS) reading[name] = given[name] as number; // a number: checked above
  return accepted(reading);
}

// --- the gateway ---------------------------------------------------------------------------------------------------------------------------------

/** The grant that the gateway writes into a token: the delegation, the one action and the one resource that were asked for. */
export function issued(request: TokenRequest, now: number): GatewayResult<IssuedToken> {
  const grant = request.delegation;
  return {
    ok: true,
    value: {
      accessToken: 'aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc',
      tokenType: 'DPoP',
      issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      expiresIn: 300,
      expiresAt: now + 300_000,
      authorizationDetails: grant === undefined ? null : [{ identifier: grant.identifier, actions: grant.actions, locations: grant.locations }],
    },
  };
}

export const gatewayRefused = (status: number, error: string, detail: string): GatewayRefused => ({ ok: false, rule: 'gateway.refused', detail, status, error, retryAfterSeconds: null });
/** The answer of the gateway for a delegation that has fewer than 30 confirmations: the one text that the access folder reads as `delegation_too_young`. */
export const tooYoung = (): GatewayRefused => gatewayRefused(400, 'invalid_authorization_details', `delegation ${'ab'.repeat(32)} has fewer than 30 confirmations`);
export const gatewayDown = (rule: 'gateway.unavailable' | 'gateway.unreachable' | 'gateway.bad_response', status: number): GatewayRefused => ({ ok: false, rule, detail: 'no usable answer', status, error: null, retryAfterSeconds: null });

/** The answer of the ERP: a JSON body and a status. */
export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// --- the list of left sub-delegations, the set in use, and the janitor -------------------------------------------------------------------------

/** One record: an id added to the set in use, an entry put in the list or removed from it, or an id deleted from the set. */
export interface Step {
  readonly op: 'add' | 'put' | 'remove' | 'delete';
  readonly id: string;
}

/** The list of left sub-delegations in memory. It notes each call, and a test can make a call fail. */
export class SinkSpy implements LeftSink {
  readonly entries = new Map<string, LeftEntry>();
  /** The entry of each `put`, in order, also for a put that failed. */
  readonly stored: LeftEntry[] = [];
  /** The numbers of the calls of `put` that fail, counted from 1. */
  readonly failPutAt = new Set<number>();
  failRemove = false;
  /** `list` fails: the list cannot be read. */
  failList = false;

  constructor(private readonly steps: Step[]) {}

  async put(entry: LeftEntry): Promise<void> {
    this.steps.push({ op: 'put', id: entry.left.id });
    this.stored.push(entry);
    if (this.failPutAt.has(this.stored.length)) throw new Error('the disk is full');
    this.entries.set(entry.left.id, entry);
  }

  async remove(id: DelegationId): Promise<void> {
    this.steps.push({ op: 'remove', id });
    if (this.failRemove) throw new Error('the disk is full');
    this.entries.delete(id);
  }

  async list(): Promise<readonly LeftEntry[]> {
    if (this.failList) throw new Error('the list cannot be read');
    return [...this.entries.values()];
  }
}

/** What a pass of the janitor did with the entries of the list: it skipped each id that a run still uses, and it took the others. */
export interface JanitorPass {
  readonly skipped: string[];
  readonly taken: string[];
}

/** One pass of the janitor, as far as the rule about a run in flight goes: an entry whose id is in the set of the runs in use is left alone, and every other entry is its work. */
export function janitorPass(entries: ReadonlyMap<string, unknown>, inUse: ReadonlySet<string>): JanitorPass {
  const pass: JanitorPass = { skipped: [], taken: [] };
  for (const id of entries.keys()) (inUse.has(id) ? pass.skipped : pass.taken).push(id);
  return pass;
}

// --- the world -------------------------------------------------------------------------------------------------------------------------------------

export interface Fetched {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly dpop: string | undefined;
}

/** The behaviour of each port. A test changes a member before the run. */
export interface Script {
  delegation: () => Promise<DelegationReading | null>;
  delegateKeyOf: (id: DelegationId) => Promise<string | null>;
  findKey: (keyHash: string) => DelegationKey | null;
  readSupplier: (supplier: string, sku: string) => Promise<ProtocolResult<SupplierRead, string>>;
  /** `attempt` counts the requests, from 1. */
  requestToken: (request: TokenRequest, attempt: number) => Promise<GatewayResult<IssuedToken>>;
  fetch: (url: string, attempt: number) => Promise<Response>;
  parseStock: (body: unknown) => ProtocolResult<Document>;
  reorder: (reading: Document, lots: Record<LotName, number>) => Promise<ReorderAnswer>;
}

export interface RunOptions {
  readonly deps?: Partial<ProposeDeps>;
  readonly request?: Partial<ProposeRequest>;
  readonly arrivedAt?: number;
  readonly signal?: AbortSignal;
}

export interface World {
  readonly clock: FakeClock;
  readonly chain: FakeDelegations;
  readonly queue: SerialQueue;
  readonly counter: PoCounter;
  readonly sink: SinkSpy;
  /** The ids that a run still uses. */
  readonly live: Set<string>;
  readonly steps: Step[];
  readonly keys: { readonly authentication: TestKey; readonly delegation: TestKey };
  readonly tokenRequests: TokenRequest[];
  /** The time of each token request. */
  readonly tokenTimes: number[];
  readonly fetched: Fetched[];
  readonly supplierCalls: { readonly supplier: string; readonly sku: string; readonly chainCalls: number }[];
  readonly reorderCalls: { readonly reading: Document; readonly lots: Record<LotName, number> }[];
  /** A pass of the janitor at the moment of each token request: the run waits for its 30 confirmations before that. */
  readonly janitorSeen: JanitorPass[];
  readonly script: Script;
  readonly deps: ProposeDeps;
  run(over?: RunOptions): Promise<ProposalResult>;
}

/** A world for `runPropose`: a ledger with the delegation of the hirer to this agent, a clock, and a script that makes the golden run. */
export function world(options: { readonly counter?: PoCounter } = {}): World {
  const clock = new FakeClock(NOW);
  const chain = new FakeDelegations(clock, parentDatum(), SCRIPT);
  const steps: Step[] = [];
  const sink = new SinkSpy(steps);
  const live = new Set<string>();
  const queue = createSerialQueue();
  const counter = options.counter ?? new MemoryPoCounter();
  const keys = { authentication: ed25519Key('stock-reader authentication'), delegation: ed25519Key('stock-reader delegation') };
  const tokenRequests: TokenRequest[] = [];
  const tokenTimes: number[] = [];
  const fetched: Fetched[] = [];
  const supplierCalls: World['supplierCalls'] = [];
  const reorderCalls: World['reorderCalls'] = [];
  const janitorSeen: JanitorPass[] = [];
  const script: Script = {
    delegation: async () => ({ delegate: AGENT_ID, chain_whole: true }),
    delegateKeyOf: async () => AGENT_KEY,
    findKey: (keyHash) => (keyHash === AGENT_KEY ? { signer: markSigner(AGENT_KEY), walletAddress: WALLET, queue } : null),
    readSupplier: async () => accepted(SUPPLIER),
    requestToken: async (request) => issued(request, clock.now()),
    fetch: async () => json(STOCK),
    parseStock,
    reorder: async () => ({ ok: true, decision: DECISION, choice: CHOICE }),
  };
  const deps: ProposeDeps = {
    agent: { did: AGENT_DID },
    subagent: { did: SUBAGENT_DID, authenticationKey: keys.authentication.privateKey, delegationKey: keys.delegation.privateKey, signer: markSigner(SUBAGENT_KEY) },
    reads: { delegation: () => script.delegation(), liveVaults: async () => ({ refs: [], complete: true }) },
    delegateKeyOf: (id) => script.delegateKeyOf(id),
    delegationKeys: { find: (keyHash) => script.findKey(keyHash) },
    subDelegation: { chain, clock, delegationScript: SCRIPT, bases: BASES },
    tokens: {
      client: {
        requestToken: async (request) => {
          tokenRequests.push(request);
          tokenTimes.push(clock.now());
          janitorSeen.push(janitorPass(sink.entries, live));
          return script.requestToken(request, tokenRequests.length);
        },
      },
    },
    calls: {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        fetched.push({ url: String(input), method: init?.method ?? 'GET', authorization: headers.get('authorization') ?? undefined, dpop: headers.get('dpop') ?? undefined });
        return script.fetch(String(input), fetched.length);
      },
      clock,
      bases: BASES,
    },
    clock,
    leftSink: sink,
    inFlight: {
      add: (id) => {
        steps.push({ op: 'add', id });
        live.add(id);
      },
      delete: (id) => {
        steps.push({ op: 'delete', id });
        live.delete(id);
      },
    },
    readSupplier: async (supplier, sku) => {
      supplierCalls.push({ supplier, sku, chainCalls: chain.log.length });
      return script.readSupplier(supplier, sku);
    },
    parseStock: (body) => script.parseStock(body),
    reorder: async (reading, lots) => {
      reorderCalls.push({ reading, lots });
      return script.reorder(reading, lots);
    },
    counter,
  };
  return {
    clock, chain, queue, counter, sink, live, steps, keys, tokenRequests, tokenTimes, fetched, supplierCalls, reorderCalls, janitorSeen, script, deps,
    run: (over = {}) => clock.run(runPropose({ ...deps, ...over.deps }, { ...REQUEST, ...over.request }, over.arrivedAt ?? NOW, over.signal)),
  };
}

// --- what a test reads -----------------------------------------------------------------------------------------------------------------------------

/** The proposal of a result that must be a proposal. */
export function proposed(result: ProposalResult): ProposedResult {
  if (result.outcome !== 'proposed') throw new Error(`the job failed with the reason ${result.reason}, and the test expected a proposal`);
  return result;
}

/** A result that is a failed proposal with this reason, and holds no document, no salt and no digest. */
export function expectFailed(result: ProposalResult, reason: string): void {
  expect(result).toMatchObject({ outcome: 'failed', exit_state: 'Failed', reason, document: null, salt: null, proposal_digest: null, fault_mode: '' });
}

/** The operations of the records, in order. */
export const opsOf = (w: World): string[] => w.steps.map((step) => step.op);

/** Nothing was read from the chain, asked of the gateway, called, recorded or decided. */
export function expectUntouched(w: World): void {
  expect(w.chain.log).toStrictEqual([]);
  expect(w.chain.submitted).toStrictEqual([]);
  expect(w.tokenRequests).toStrictEqual([]);
  expect(w.fetched).toStrictEqual([]);
  expect(w.steps).toStrictEqual([]);
  expect(w.reorderCalls).toStrictEqual([]);
}

/** The Delegate and then the Undelegate were sent, and the ledger no longer shows the sub-delegation. */
export async function expectEnded(w: World): Promise<void> {
  expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(['delegate', 'undelegate']);
  expect(w.chain.subId).not.toBeNull();
  expect(await w.chain.readDelegation(w.chain.subId!)).toBeNull();
}

/**
 * The records of a run that sent its Delegate and ended the sub-delegation: the id is added, the entry is stored, the entry is removed, and the id is deleted, all for the one id of the sub-delegation. The
 * list and the set are empty at the end.
 */
export async function expectRecordedAndEnded(w: World): Promise<void> {
  await expectEnded(w);
  expect(opsOf(w)).toStrictEqual(['add', 'put', 'remove', 'delete']);
  expect(new Set(w.steps.map((step) => step.id))).toStrictEqual(new Set([w.chain.subId]));
  expect(w.sink.entries.size).toBe(0);
  expect(w.live.size).toBe(0);
}

/** A ledger that shows the sub-delegation as made by the transaction that `txHash()` names. */
export function showing(chain: FakeDelegations, txHash: () => string): void {
  const read = chain.readDelegation.bind(chain);
  chain.readDelegation = async (id) => {
    const live = await read(id);
    return live === null || id === PARENT_ID ? live : { ...live, txHash: txHash() };
  };
}

/**
 * One pass of the REAL janitor of the kit over the list and the ledger of the world. A run that this process still uses is left alone, a sub-delegation that is live and that the Delegate of an entry made is
 * ended with the Undelegate, and the entry is then removed.
 */
export function janitorOnce(w: World): Promise<JanitorReport> {
  return w.clock.run(
    runJanitorOnce({
      store: w.sink,
      chain: w.chain,
      delegationScript: SCRIPT,
      signerOf: (keyHash) => (keyHash === AGENT_KEY ? { ...markSigner(AGENT_KEY), address: WALLET } : null),
      queueOf: () => ({ run: (job) => w.queue.run(job), busy: false }),
      tipSlot: async () => slotOf(w.clock.now()),
      clock: w.clock,
      log: () => undefined,
      inFlight: (id) => w.live.has(id),
    }),
  );
}
