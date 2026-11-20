// packages/usecase-kit/test/buyer/support.ts
// The world that the tests of the buyer flow share: the in-memory marketplace of the hire kit (a FakeChain with a vault, and a template supplier behind one fetch), the paying key of its chain, a
// clock that the test owns, and a port for the reads of the ledger that follows the vaults of the FakeChain. The counterparty is the template supplier of the marketplace. No value is a key.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PayingKeys } from '@vsa/hire-kit';
import type { AgentDeps, HireLedger, PayingKey } from '@vsa/hire-kit';
import { AGENT_ADVERT_REF, AGENT_CAPABILITY, AGENT_ENDPOINT, AGENT_ID, T0, chainWith, marketplace } from '@vsa/hire-kit/testing';
import type { Marketplace } from '@vsa/hire-kit/testing';
import { makeProposal, parseRequest } from '@vsa/usecase-kit/protocol';
import type { DelegationId, ExecuteRequest, Handoff } from '@vsa/usecase-kit/protocol';
import { handoffOf, hireCounterparty } from '@vsa/usecase-kit/buyer';
import type { DelegationReading, DeliveryDecision, HireDeps, HireInput, HireLimits, HireStep, LedgerReads, LiveVaults, ResultPieces } from '@vsa/usecase-kit/buyer';

export const BUYER_ID = 'a1'.repeat(32);
/** The DID of the buyer-side agent: the delegate of the delegation. */
export const BUYER_DID = `did:vector:${BUYER_ID}`;
export const OTHER_ID = 'c3'.repeat(32);
export const COUNTERPARTY_DID = `did:vector:${AGENT_ID}`;
export const PRINCIPAL_DID = `did:vector:${'b2'.repeat(32)}`;
export const DELEGATION: DelegationId = 'dd'.repeat(32);
export const SALT = '33'.repeat(32);
export const TENANT = 'run1';
export const APPROVAL = { attestation: '22'.repeat(32), issuer_did: PRINCIPAL_DID } as const;
export const LIMIT = { perTx: 5_000_000n, total: 12_000_000n, periodMs: 86_400_000 };
export const NO_LIMITS: HireLimits = { maxPriceLovelace: null, maxSupplierBondLovelace: null, maxBuyerBondLovelace: null };
export const ACCEPT: DeliveryDecision = () => ({ accept: true });
export const CAPABILITY = AGENT_CAPABILITY;
export { AGENT_ADVERT_REF, AGENT_ENDPOINT, T0 };

/** A purchase order, as use case 1 (inventory reorder) writes it. It names the advert of the template supplier of the marketplace. */
export function purchaseOrder(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'vector.usecase.po.v1', po_number: 'run1-0001', tenant: TENANT, sku: 'SKU-100', lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01', supplier_did: COUNTERPARTY_DID,
    advert_ref: AGENT_ADVERT_REF, stock_reading_sha256: '55'.repeat(32), ...over,
  };
}

/** The `execute` request for a document, as the protocol parser gives it. */
export function executeRequest(document: unknown, approval: unknown = APPROVAL): ExecuteRequest {
  const proposal = makeProposal(document, SALT);
  if (!proposal.ok) throw new Error(`the proposal of the test is refused: ${proposal.detail}`);
  const parsed = parseRequest({ op: 'execute', authority: { principal_did: PRINCIPAL_DID, delegation: DELEGATION }, tenant: TENANT, proposal: proposal.value, approval });
  if (!parsed.ok) throw new Error(`the request of the test is refused: ${parsed.detail}`);
  if (parsed.value.op !== 'execute') throw new Error('the request of the test is not an execute request');
  return parsed.value;
}

/** The handoff for a document. */
export function handoffFor(document: unknown = purchaseOrder(), approval: unknown = APPROVAL): Handoff {
  const made = handoffOf({ use_case: 'inventory-reorder', agent_did: BUYER_DID, request: executeRequest(document, approval) });
  if (!made.ok) throw new Error(`the handoff of the test is refused: ${made.detail}`);
  return made.value;
}

/** The pieces of a result for the document of the tests. */
export function pieces(over: Partial<ResultPieces> = {}): ResultPieces {
  return { use_case: 'inventory-reorder', proposal_digest: '88'.repeat(32), handoff: null, writes: [], decisions: [], fault_mode: '', ...over };
}

/**
 * The reads of the ledger that follow the FakeChain: the Live vaults of a delegation are the unspent Live vault outputs of the chain, so the vault that a Pay leaves is the vault of the next
 * read. A test sets what the delegation says, makes a read fail, or adds a reference.
 */
export class FakeReads implements LedgerReads {
  readonly delegations = new Map<string, DelegationReading | null>();
  readonly calls = { delegation: 0, liveVaults: 0 };
  readonly chain: Marketplace['chain'];
  failDelegation: Error | null = null;
  failVaults: Error | null = null;
  complete = true;
  /** References that every read of the vaults lists in addition to those of the chain. */
  extra: string[] = [];

  constructor(chain: Marketplace['chain']) {
    this.chain = chain;
  }

  async delegation(id: DelegationId): Promise<DelegationReading | null> {
    this.calls.delegation += 1;
    if (this.failDelegation !== null) throw this.failDelegation;
    return this.delegations.get(id) ?? null;
  }

  async liveVaults(id: DelegationId, _atMs: number): Promise<LiveVaults> {
    this.calls.liveVaults += 1;
    if (this.failVaults !== null) throw this.failVaults;
    const refs = this.chain.vaults().filter((vault) => vault.kind === 'Live' && !vault.consumed && vault.delegation === id).map((vault) => vault.ref);
    return { refs: [...refs, ...this.extra], complete: this.complete };
  }
}

export interface World {
  readonly m: Marketplace;
  readonly key: PayingKey;
  readonly deps: HireDeps;
  readonly reads: FakeReads;
  readonly sleeps: number[];
  readonly booked: { posted: Array<{ lockLovelace: bigint; feeLovelace: bigint }>; accepted: Array<{ feeLovelace: bigint }> };
  /** The vault that the world opened: a Live vault under the delegation. */
  vault: string;
  /** Opens one more vault under the delegation. */
  openVault(lovelace?: bigint, limit?: typeof LIMIT): string;
  /** The hirer ends the delegation: the chain refuses a Pay under it, and the ledger no longer has it. */
  endDelegation(): void;
}

const dirs: string[] = [];
/** Removes the folders of the stranded stores that `world` made. Call it in `afterEach`. */
export function cleanWorlds(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * A world: the marketplace, the paying key of its chain, one Live vault under the delegation (unless `vault` is false), and the deps of the flow. The delegation names the buyer-side agent.
 * The deadline of the hire is `deadlineMs` after T0.
 */
export async function world(options: { market?: Parameters<typeof marketplace>[0]; vault?: boolean; deadlineMs?: number; limit?: typeof LIMIT; plainChain?: boolean } = {}): Promise<World> {
  const m = marketplace(options.market ?? {});
  const dir = mkdtempSync(join(tmpdir(), 'usecase-kit-buyer-'));
  dirs.push(dir);
  const key = await new PayingKeys(dir).add(options.plainChain === true ? chainWith(m, {}) : m.chain);
  const sleeps: number[] = [];
  const booked: World['booked'] = { posted: [], accepted: [] };
  const ledger: HireLedger = {
    posted: (post) => { booked.posted.push({ lockLovelace: post.lockLovelace, feeLovelace: post.feeLovelace }); },
    accepted: (accept) => { booked.accepted.push({ feeLovelace: accept.feeLovelace }); },
  };
  const hire: AgentDeps = {
    clock: () => m.clock.now, sleep: async (ms) => { sleeps.push(ms); m.clock.now += ms; }, deadlineMs: T0 + (options.deadlineMs ?? 1_000_000), fetchImpl: m.fetchImpl, ledger,
  };
  const reads = new FakeReads(m.chain);
  reads.delegations.set(DELEGATION, { delegate: BUYER_ID, chain_whole: true });
  const openVault = (lovelace = 40_000_000n, limit = options.limit ?? LIMIT): string => m.chain.openVault({ delegation: DELEGATION, lovelace, limit });
  const made: World = {
    m, key, deps: { key, hire, reads }, reads, sleeps, booked, vault: options.vault === false ? '' : openVault(),
    openVault,
    endDelegation: () => { m.chain.endDelegation(DELEGATION); reads.delegations.set(DELEGATION, null); },
  };
  return made;
}

/** The input of a hire of the template supplier for a document, with no limit and a decision that accepts. `over` replaces members. */
export function input(over: Partial<HireInput> = {}): HireInput {
  return { message: handoffFor(), counterparty_did: COUNTERPARTY_DID, capability_id: CAPABILITY, limits: NO_LIMITS, decide: ACCEPT, ...over } as HireInput;
}

/** The hire of the input `over` makes, from the deps of the world. */
export const go = (w: World, over: Partial<HireInput> = {}): Promise<HireStep> => hireCounterparty(w.deps, input(over));

/** One word for a step, with the code that tells the cases apart. The compiler checks that it names every kind. */
export function words(step: HireStep): string {
  switch (step.kind) {
    case 'completed': return 'completed';
    case 'refused_by_counterparty': return `refused_by_counterparty ${step.source} ${step.reason}`;
    case 'vault_refused': return `vault_refused ${step.refusal}`;
    case 'failed': return `failed ${step.reason}`;
    case 'not_accepted': return `not_accepted ${step.why}`;
    case 'interrupted': return `interrupted ${step.cause_kind}`;
    case 'pay_unconfirmed': return 'pay_unconfirmed';
    case 'refused': return `refused ${step.code}`;
    default: return step satisfies never;
  }
}

/** What a hire that never reached the Pay leaves behind: nothing booked, nothing sent, nothing recorded, and every vault output unspent. */
export function untouched(w: World): { posted: number; sends: number; stranded: number; spent: number } {
  return { posted: w.booked.posted.length, sends: w.m.agent.sends.length, stranded: w.key.stranded.list().length, spent: w.m.chain.vaults().filter((vault) => vault.consumed).length };
}

/** A step of one kind, or a failure of the test that says what the step was. */
export function expectKind<K extends HireStep['kind']>(step: HireStep, kind: K): Extract<HireStep, { kind: K }> {
  if (step.kind !== kind) throw new Error(`the step is ${words(step)}, and the test expected ${kind}`);
  return step as Extract<HireStep, { kind: K }>;
}

/** A promise that the test settles by hand. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * A fetch in front of the marketplace that lets the test answer the poll of a job (GET /v1/job/<id> of the template supplier). `answer` gets the response of the supplier, and it gives the
 * response to hand back, or `undefined` to hand back the response of the supplier.
 */
export function inFrontOfPolls(m: Marketplace, answer: (reached: Response) => Response | undefined): typeof fetch {
  return (async (target: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    const reached = await m.fetchImpl(target, init);
    if ((init?.method ?? 'GET') === 'GET' && url.origin === AGENT_ENDPOINT && url.pathname.startsWith('/v1/job/')) return answer(reached.clone()) ?? reached;
    return reached;
  }) as typeof fetch;
}

/** A fetch in front of the marketplace that answers the send of the job (POST /v1/job of the template supplier) itself. */
export function inFrontOfSends(m: Marketplace, answer: () => Response | Promise<Response>): typeof fetch {
  return (async (target: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(target));
    if (init?.method === 'POST' && url.origin === AGENT_ENDPOINT && url.pathname === '/v1/job') return answer();
    return m.fetchImpl(target, init);
  }) as typeof fetch;
}

export const page = (status: number, text: string): Response => new Response(text, { status, headers: { 'content-type': 'text/html' } });
export const jsonResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
