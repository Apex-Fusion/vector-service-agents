// agents/sourcing-agent/test/quotes/world.ts
// The world of the tests of the quote fan-out. The three Bid Desks are template suppliers behind one fetch and one FakeChain that holds a vault, each with its own advert, key and endpoint. The paying key is
// the delegation key of the agent: every escrow that the vault pays names it as its buyer. The challenge is a scripted dispute, the model is a scripted function (support.ts), and the status of a bidder is a
// table that a test sets. Every step writes one word to `events`, so a test can see the order in which the fan-out acted. Nothing uses the network, and the clock is the one of the test.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeChain } from '@vsa/buyer-core';
import type { VaultChain } from '@vsa/buyer-core';
import { PayingKeys } from '@vsa/hire-kit';
import type { HireLedger } from '@vsa/hire-kit';
import { T0, stubKey } from '@vsa/hire-kit/testing';
import type { StubKey } from '@vsa/hire-kit/testing';
import { BID_CAPABILITIES, BID_DESK_MODEL } from '@vsa/usecase-kit/bids';
import type { DelegationReading, HireLimits, LedgerReads, LiveVaults } from '@vsa/usecase-kit/buyer';
import type { DelegationId } from '@vsa/usecase-kit/protocol';
import { canonicalize, sha256Utf8Hex } from '@vsa/vector-read';
import type { IdentityAdvertDatum } from '@vsa/vector-read';
import { runQuotes } from '../../src/quotes/index.ts';
import type { BidderStatus, QuotesDeps, QuotesInput, QuotesResult } from '../../src/quotes/index.ts';
import { DELEGATION, DESKS, RFQ, SENDER_DID, SENDER_ID, ScriptedAccept, ScriptedDispute, bidderOf, quoteText } from './support.ts';
import type { DeskSpec } from './support.ts';

export { T0 };

/** The delegation key of the agent: the buyer of every escrow that the vault pays. */
export const BUYER_PKH = 'c9'.repeat(28);
/** The limit of the vault: each Pay locks 2,261,030 lovelace, so the vault pays six times in a period. */
export const LIMIT = { perTx: 7_000_000n, total: 14_000_000n, periodMs: 86_400_000 };
/** The three limits of a hire of a Bid Desk: its price and the bonds of its advert. */
export const LIMITS: HireLimits = { maxPriceLovelace: 1_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n };
/** The window of the adverts: the `deliver_by` window of a Bid Desk is 480,000 ms of work and 180,000 ms for the Accept. */
const WINDOW_MS = 480_000;

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The reads of the ledger that follow the FakeChain: the Live vaults of a delegation are the unspent Live vault outputs of the chain. A test sets the delegation, or makes a read fail. */
export class FakeReads implements LedgerReads {
  readonly delegations = new Map<string, DelegationReading | null>();
  readonly calls = { delegation: 0, liveVaults: 0 };

  constructor(private readonly chain: FakeChain) {}

  async delegation(id: DelegationId): Promise<DelegationReading | null> {
    this.calls.delegation += 1;
    return this.delegations.get(id) ?? null;
  }

  async liveVaults(id: DelegationId, _atMs: number): Promise<LiveVaults> {
    this.calls.liveVaults += 1;
    const refs = this.chain.vaults().filter((vault) => vault.kind === 'Live' && !vault.consumed && vault.delegation === id).map((vault) => vault.ref);
    return { refs, complete: true };
  }
}

interface DeskJob {
  readonly escrowRef: string;
  readonly payload: string;
  finished?: Record<string, unknown>;
}

/** A Bid Desk as the runtime of the agent template serves it: `GET /capability`, `GET /status`, `POST /v1/job` and `GET /v1/job/:id`. It plays the Claim and the Submit on the FakeChain. */
export class DeskSupplier {
  /** Every send, with the escrow that it names and the payload of its body. */
  readonly sends: Array<{ escrowRef: string; payload: string }> = [];
  readonly jobs = new Map<string, DeskJob>();
  /** Answer every send with this refusal, before the Claim, as the pre-check of the runtime does: the escrow stays Open. */
  refuse: { status: number; code: string } | null = null;
  /** The job fails after its Claim: the poll says that it failed, and nothing is submitted. */
  failJob = false;
  /** The text that the job answers. The quote that prices the request from the list, unless a test says otherwise. */
  answer: () => string;

  constructor(readonly spec: DeskSpec, readonly key: StubKey, private readonly chain: FakeChain, private readonly events: string[]) {
    this.answer = () => quoteText(spec);
  }

  async handle(method: string, path: string, body: string): Promise<Response> {
    if (method === 'GET' && path === '/capability') {
      return json(200, {
        capability_id: BID_CAPABILITIES.quote, model: BID_DESK_MODEL, max_output_tokens: 8192, max_processing_ms: WINDOW_MS, price_lovelace: '200000', advert_ref: this.spec.advertRef, supplier_pkh: this.key.pkh,
        pub_key_hex: this.key.pubKeyHex, agent_id: this.spec.id, agent_did: this.spec.did,
      });
    }
    if (method === 'GET' && path === '/status') return json(200, { status: 'free', last_seen: '2026-11-24T09:00:00.000Z', active_sessions: 0, max_sessions: 1 });
    if (method === 'POST' && path === '/v1/job') return this.post(body);
    if (method === 'GET' && path.startsWith('/v1/job/')) return this.poll(decodeURIComponent(path.slice('/v1/job/'.length)));
    return json(404, { reason: 'no_route', message: `nothing at ${method} ${path}` });
  }

  private post(body: string): Response {
    const request = JSON.parse(body) as { escrow_ref?: unknown; payload?: unknown };
    const escrowRef = typeof request.escrow_ref === 'string' ? request.escrow_ref : '';
    const payload = typeof request.payload === 'string' ? request.payload : '';
    this.sends.push({ escrowRef, payload });
    this.events.push(`send ${this.spec.name}`);
    if (this.refuse !== null) return json(this.refuse.status, { error: this.refuse.code, message: `the service refused the job (${this.refuse.code})`, reason: this.refuse.code });
    const datum = this.chain.escrowDatum(escrowRef);
    if (datum === undefined) return json(404, { reason: 'escrow_not_found', message: 'no such escrow' });
    if (sha256Utf8Hex(payload) !== datum.prompt_hash) return json(409, { reason: 'prompt_mismatch', message: 'the payload does not hash to the prompt_hash of the escrow' });
    this.chain.markClaimed(escrowRef);
    const id = `00000000-0000-4000-8000-${String(this.jobs.size + 1).padStart(12, '0')}`;
    this.jobs.set(id, { escrowRef, payload });
    return json(202, { job_id: id, status: 'accepted', escrow_ref: escrowRef });
  }

  private poll(id: string): Response {
    const job = this.jobs.get(id);
    if (job === undefined) return json(404, { reason: 'job_not_found', message: `no job found with id ${id}` });
    if (this.failJob) return json(502, { status: 'failed', reason: 'service_failure', message: 'the service did not answer', escrow_ref: job.escrowRef });
    if (job.finished === undefined) {
      const text = this.answer();
      const receipt = {
        escrow_ref: job.escrowRef, supplier_pkh: this.key.pkh, prompt_hash: sha256Utf8Hex(job.payload), response_hash: sha256Utf8Hex(text), model: BID_DESK_MODEL, prompt_tokens: 0, completion_tokens: 0,
        wallclock_ms: 1204, agent_did: this.spec.did,
      };
      const signature = this.key.sign(receipt);
      this.chain.markSubmitted(job.escrowRef, sha256Utf8Hex(canonicalize({ receipt, signature })));
      job.finished = {
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        receipt, receipt_signature: signature, escrow_ref: job.escrowRef, submitted_ref: `${'ef'.repeat(32)}#0`,
      };
    }
    return json(200, job.finished);
  }
}

export interface WorldOptions {
  /** The value limit of the delegation. */
  readonly limit?: typeof LIMIT;
}

export interface World {
  readonly clock: { now: number };
  readonly chain: FakeChain;
  readonly desks: Readonly<Record<DeskSpec['name'], DeskSupplier>>;
  readonly reads: FakeReads;
  readonly dispute: ScriptedDispute;
  readonly accept: ScriptedAccept;
  /** One word for each step of the fan-out, in order: `recheck`, `pay`, `send`, `ask`, `accept` and `challenge`, each with the name of the bidder. */
  readonly events: string[];
  readonly log: string[];
  readonly booked: { posted: number; accepted: number };
  /** What `recheck` answers for a bidder, by DID: a status, or an error to throw. A bidder that is not in the table is `active`. */
  readonly status: Map<string, BidderStatus | Error>;
  readonly deps: QuotesDeps;
  readonly vault: string;
  /** The input of the job for the three bidders, in the order alfa, bravo, charlie. `over` replaces members. */
  input(over?: Partial<QuotesInput>): QuotesInput;
  run(input?: QuotesInput, deps?: QuotesDeps, signal?: AbortSignal): Promise<QuotesResult>;
}

const dirs: string[] = [];
/** Removes the state folders of the paying keys that `world` made. Each test file calls it in `afterEach`. */
export function cleanWorlds(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export async function world(options: WorldOptions = {}): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'sourcing-quotes-'));
  dirs.push(dir);
  const clock = { now: T0 };
  const events: string[] = [];
  const keys = new Map(DESKS.map((spec) => [spec.name, stubKey(`sourcing quotes test: bid desk ${spec.name}`)] as const));
  const advert = (spec: DeskSpec): IdentityAdvertDatum => ({
    supplier_pkh: keys.get(spec.name)!.pkh, capability_id: BID_CAPABILITIES.quote, model: BID_DESK_MODEL, max_output_tokens: 8192, max_processing_ms: WINDOW_MS, price_lovelace: 200_000n,
    supplier_bond_lovelace: 1_000_000n, buyer_bond_lovelace: 1_000_000n, endpoint_url: spec.endpoint, detail_uri: '', detail_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    advertised_at: 1_786_529_315_923, status: 'Active', agent_id: spec.id,
  });
  const chain = new FakeChain({
    adverts: Object.fromEntries(DESKS.map((spec) => [spec.advertRef, advert(spec)])), clock: () => clock.now, prefix: 'sourcing-quotes-test/', buyerPkh: BUYER_PKH,
  });
  const deskOfAdvert = (ref: string): string => DESKS.find((spec) => spec.advertRef === ref)?.name ?? 'unknown';
  const deskOfEscrow = (ref: string): string => {
    const agent: unknown = Reflect.get(chain.escrowDatum(ref) ?? {}, 'agent_id');
    return DESKS.find((spec) => spec.id === agent)?.name ?? 'unknown';
  };
  const desks = Object.fromEntries(DESKS.map((spec) => [spec.name, new DeskSupplier(spec, keys.get(spec.name)!, chain, events)])) as unknown as Record<DeskSpec['name'], DeskSupplier>;
  const fetchImpl = (async (target: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(target));
    const supplier = Object.values(desks).find((candidate) => candidate.spec.endpoint === url.origin);
    if (supplier === undefined) return json(404, { reason: 'no_route', message: `nothing at ${url.href}` });
    return supplier.handle(init.method ?? 'GET', url.pathname, typeof init.body === 'string' ? init.body : '');
  }) as typeof fetch;

  // The chain of the paying key: the FakeChain, with a word for each Pay and each Accept.
  const paying: VaultChain = {
    wallet: () => chain.wallet(), postEscrow: (args) => chain.postEscrow(args), reclaim: (ref) => chain.reclaim(ref), escrowState: (ref) => chain.escrowState(ref),
    onChainReceiptHash: (ref) => chain.onChainReceiptHash(ref), readAdvert: (ref) => chain.readAdvert(ref),
    accept: async (ref) => {
      events.push(`accept ${deskOfEscrow(ref)}`);
      return chain.accept(ref);
    },
    payFromVault: async (args) => {
      events.push(`pay ${deskOfAdvert(args.advertRef)}`);
      return chain.payFromVault(args);
    },
  };
  const key = await new PayingKeys(dir).add(paying);
  const reads = new FakeReads(chain);
  reads.delegations.set(DELEGATION, { delegate: SENDER_ID, chain_whole: true });
  const booked = { posted: 0, accepted: 0 };
  const ledger: HireLedger = { posted: () => { booked.posted += 1; }, accepted: () => { booked.accepted += 1; } };
  const dispute = new ScriptedDispute(SENDER_DID);
  const accept = new ScriptedAccept();
  const status = new Map<string, BidderStatus | Error>();
  const log: string[] = [];
  const nameOfDid = (did: string): string => DESKS.find((spec) => spec.did === did)?.name ?? 'unknown';
  const deps: QuotesDeps = {
    key,
    hire: { clock: () => clock.now, sleep: async (ms) => { clock.now += ms; }, fetchImpl, ledger },
    reads,
    limits: LIMITS,
    recheck: async (did) => {
      events.push(`recheck ${nameOfDid(did)}`);
      const word = status.get(did) ?? 'active';
      if (word instanceof Error) throw word;
      return word;
    },
    acceptQuote: async (given) => {
      events.push(`ask ${nameOfDid(given.quote.desk_did)}`);
      return accept.acceptQuote(given);
    },
    dispute: {
      challengeDelivery: async (given) => {
        events.push(`challenge ${nameOfDid(given.counterparty)}`);
        return dispute.challengeDelivery(given);
      },
    },
    buyerPkhs: [BUYER_PKH],
    clock: () => clock.now,
    log: (line) => { log.push(line); },
  };
  const made: World = {
    clock, chain, desks, reads, dispute, accept, events, log, booked, status, deps,
    vault: chain.openVault({ delegation: DELEGATION, lovelace: 40_000_000n, limit: options.limit ?? LIMIT }),
    input: (over = {}) => ({ rfq: RFQ, sender: SENDER_DID, delegation: DELEGATION, invited: DESKS.map((spec) => bidderOf(spec)), deadline_ms: T0 + 3_420_000, keep_ms: 840_000, ...over }),
    run: (given = made.input(), used = made.deps, signal) => runQuotes(used, given, signal),
  };
  return made;
}

/** What a run left behind, as numbers that a test compares: the Pays that were made, the sends to the bidders, the questions to the model, the challenges, and the reads of the status. */
export interface Footprint {
  readonly paid: number;
  readonly sends: number;
  readonly asked: number;
  readonly challenges: number;
  readonly rechecked: number;
}

/** A Pay spends the vault that it pays from, so the Pays that were made are the vault outputs that were spent. */
export function footprint(w: World): Footprint {
  const count = (word: string): number => w.events.filter((event) => event.startsWith(`${word} `)).length;
  return { paid: w.chain.vaults().filter((vault) => vault.consumed).length, sends: count('send'), asked: count('ask'), challenges: count('challenge'), rechecked: count('recheck') };
}

/** The footprint of a run that did nothing but read the status of each bidder. */
export const NOTHING: Footprint = { paid: 0, sends: 0, asked: 0, challenges: 0, rechecked: 0 };

/** One word for an outcome: its kind and, for an excluded bidder, its reason and its code. */
export function words(outcome: QuotesResult['outcomes'][number]): string {
  return outcome.kind === 'accepted' ? 'accepted' : `excluded ${outcome.reason} ${outcome.code ?? 'none'}`;
}
