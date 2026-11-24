// agents/sourcing-agent/test/propose/support.ts: what the tests of the propose folder share. Every port of `runPropose` is scripted here: the ledger reads, the discovery, the two decisions, the quote fan-out and
// the scoring. The golden world is three bidders that the model invites, three quotes that it accepts, three scores and an order. A test changes one thing in a copy of it, so each refusal has the golden world
// as its accepted twin. The clock is a number that the test moves, and the tests that need the deadline give a job that arrived almost one deadline ago, so a hang ends after a few milliseconds of real time.
// No test uses the network.
import { expect } from 'vitest';
import { QUOTE_SCHEMA, parsePriceList, priceListSha256, quoteTotals, rfqSha256 } from '@vsa/usecase-kit/bids';
import type { PriceList, Quote, RfqDocument, Weights } from '@vsa/usecase-kit/bids';
import type { DelegationReading } from '@vsa/usecase-kit/buyer';
import type { Decision, DelegationId, Did, JsonValue, SubJob } from '@vsa/usecase-kit/protocol';
import { PROPOSE_DEADLINE_MS, runFront } from '../../src/propose/index.ts';
import type {
  AcceptedQuote, BidderFile, BidderView, DecisionAnswer, DiscoverResult, ExcludedQuote, Fronted, ProposeDeps, ProposeRequest, QuoteRecord, QuotesInput, QuotesResult, RankInput, RankingChoice, ScoredQuote,
  ScoringInput, ScoringResult, ShortlistChoice, SourcingFailed,
} from '../../src/propose/index.ts';

/** A byte, 32 times: a transaction hash, an agent id or a delegation id. */
export const hex32 = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
/** A byte, 28 times: a key hash. */
export const hex28 = (n: number): string => n.toString(16).padStart(2, '0').repeat(28);
export const didOf = (n: number): Did => `did:vector:${hex32(n)}`;

/** The agent, the hirer, the delegation of the hirer, and the tenant. */
export const AGENT_ID = hex32(0xa0);
export const AGENT_DID = didOf(0xa0);
export const PRINCIPAL_DID = didOf(0x1f);
export const DELEGATION: DelegationId = hex32(0xd1);
export const TENANT = 'run1';
/** The key hash that the delegation names as its delegate key, and the entry of the delegation keys that has it. */
export const KEY_HASH = hex28(0xe5);
export interface TestKey {
  readonly name: string;
}
export const KEY: TestKey = { name: 'delegation-1' };

/** The bidders. `DELTA` is a fourth candidate, for the tests that leave a candidate out. */
export const ALFA = didOf(0xb1);
export const BRAVO = didOf(0xb2);
export const CHARLIE = didOf(0xb3);
export const DELTA = didOf(0xb4);
export const ECHO = didOf(0xb5);

export const RFQ: RfqDocument = {
  rfq_id: 'rfq-2026-11',
  items: [
    { sku: 'GLV-NIT-M', quantity: 500 },
    { sku: 'SYR-10ML', quantity: 200 },
  ],
  needed_by: '2026-12-15',
};
export const WEIGHTS: Weights = { price: 0.4, lead_time: 0.2, reliability: 0.2, compliance: 0.2 };

/** The time of the golden run: 2026-11-24T12:00:00Z. */
export const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);

// --- The documents -----------------------------------------------------------------------------------------------------------------------------------

const VERIFICATION = {
  escrow_ref_matches: true, response_hash_matches: true, supplier_key_matches: true, signature_valid: true, on_chain_hash_matches: true, prompt_hash_matches: true, model_matches: true, fields_match: true,
} as const;

/** A sub-job: the job of a supplier that the agent paid. `n` makes its escrow and its advert. */
export function subJobOf(capability: string, n: number): SubJob {
  return {
    capability_id: capability,
    advert_ref: `${hex32(0x40 + n)}#0`,
    escrow_ref: `${hex32(0x50 + n)}#0`,
    supplier_pkh: hex28(0x60 + n),
    receipt: { escrow_ref: `${hex32(0x50 + n)}#0`, model: capability.startsWith('llm') ? 'deepseek/deepseek-v4-flash' : 'bid-desk-v1' },
    receipt_signature: hex32(0x70 + n) + hex32(0x70 + n),
    verification: VERIFICATION,
  };
}

/** A decision of the model, as a model hire gives it: the recorded choice, the reasoning, and the job that was paid. */
export function decisionOf(name: string, choice: JsonValue, n: number): Decision {
  return { name, choice, reasoning: `The reasoning of decision ${n}.`, inference: { path: 'marketplace', sub_job: subJobOf('llm.text.generate.v1', n), accepted: 'confirmed' } };
}

const PRICE_LIST: PriceList = {
  schema: 'vector.usecase.price-list.v1',
  items: [
    { sku: 'GLV-NIT-M', lead_time_days: 7, breaks: [{ min_quantity: 1, unit_price: 100 }] },
    { sku: 'SYR-10ML', lead_time_days: 5, breaks: [{ min_quantity: 1, unit_price: 40 }] },
  ],
};
export const LIST_SHA = priceListSha256(JSON.stringify(PRICE_LIST));

/** The file of a bidder: active, with a verified organisation, a valid price list, a valid compliance attestation and no case against it. `n` makes its advert. */
export function fileOf(did: Did, n: number, name: string, over: Partial<BidderFile> = {}): BidderFile {
  return {
    did,
    advert_ref: `${hex32(0x30 + n)}#0`,
    status: 'active',
    status_reason: null,
    lineage: { hold_until: null, ended_at: null, invalid_from: null, successor: null, recovery_pending: false },
    accountable: hex28(0xac),
    organisation: `${name}.example`,
    organisation_verified: true,
    in_catalog: true,
    stake_lovelace: '10000000',
    cases_against: 0,
    price_list: 'valid',
    compliance: {
      state: 'valid', attestation: hex32(0xc0 + n), attestation_state: 'active', issued_at: '2026-11-14T12:00:00Z', valid_until: '2027-02-12T12:00:00Z', revoked_at: null, revoke_reason: null, contested: null,
    },
    credential: 'valid',
    ...over,
  };
}

/** The view of a bidder: its file, its supplier key, and its price list unless the file says that the list is not valid. */
export function viewOf(file: BidderFile, n: number): BidderView {
  const parsed = parsePriceList(PRICE_LIST);
  if (!parsed.ok) throw new Error('the price list of the fixtures is not a price list');
  return { file, supplier_pkh: hex28(0x60 + n), price_list: file.price_list === 'valid' ? { list: parsed.value, sha256: LIST_SHA } : null };
}

/** The golden candidates: three bidders in the order of their adverts. */
export function candidates(): BidderView[] {
  return [viewOf(fileOf(ALFA, 1, 'alfa'), 1), viewOf(fileOf(BRAVO, 2, 'bravo'), 2), viewOf(fileOf(CHARLIE, 3, 'charlie'), 3)];
}

/** The unit prices of the three golden quotes, the first for each SKU of the request. */
const PRICES: Readonly<Record<string, readonly [number, number]>> = { [ALFA]: [100, 40], [BRAVO]: [95, 42], [CHARLIE]: [105, 38] };
const LEAD_DAYS: Readonly<Record<string, readonly [number, number]>> = { [ALFA]: [7, 5], [BRAVO]: [10, 9], [CHARLIE]: [6, 4] };

/** The quote of a bidder for the golden request, with totals that the kit computes. */
export function quoteOf(desk: Did, organisation: string): Quote {
  const prices = PRICES[desk] ?? [100, 40];
  const days = LEAD_DAYS[desk] ?? [7, 5];
  const totals = quoteTotals(RFQ.items.map((item, index) => ({ sku: item.sku, quantity: item.quantity, unit_price: prices[index]!, lead_time_days: days[index]! })));
  const hash = rfqSha256(RFQ);
  if (totals === null || !hash.ok) throw new Error('the lines of the fixture make no totals');
  return {
    schema: QUOTE_SCHEMA,
    outcome: 'done',
    rfq_id: RFQ.rfq_id,
    rfq_sha256: hash.value,
    desk_did: desk,
    organisation,
    lines: totals.lines,
    total: totals.total,
    lead_time_days: totals.lead_time_days,
    valid_until: '2026-12-31',
    notes: 'Valid for the quantities of the request.',
    price_list_sha256: LIST_SHA,
    credential: 'aaaaaaaa.bbbbbbbb.cccccccc',
    sender: { did: AGENT_DID, organisation: 'operator.example', organisation_verified: true },
    checks: { sender_active: true, sender_accountable: true, sender_key: true, delegation: true, delegation_usable: true, vault_paid: true, not_duplicate: true },
    decisions: [decisionOf('quote', { lines: [], valid_until: '2026-12-31', notes: '' }, 90)],
    fault_mode: '',
  };
}

/** The record of the quote job of a bidder: its escrow, its signed receipt, its checks and the quote as the result. */
export function recordOf(desk: Did, n: number, quote: Quote | null, over: Partial<QuoteRecord> = {}): QuoteRecord {
  const job = subJobOf('supplychain.rfq.quote.v1', n);
  return {
    desk_did: desk,
    advert_ref: job.advert_ref,
    escrow_ref: job.escrow_ref,
    paid_from_vault: true,
    receipt: job.receipt,
    receipt_signature: job.receipt_signature,
    verification: job.verification,
    result: quote === null ? null : JSON.parse(JSON.stringify(quote)),
    accepted: 'confirmed',
    challenge: null,
    ...over,
  };
}

/** The golden outcome of an accepted quote: the quote, its record, its sub-job and the decision `accept_quote`. */
export function acceptedOf(desk: Did, n: number, name: string, over: Partial<AcceptedQuote> = {}): AcceptedQuote {
  const quote = quoteOf(desk, `${name}.example`);
  return {
    kind: 'accepted', did: desk, quote, record: recordOf(desk, n, quote), sub_job: subJobOf('supplychain.rfq.quote.v1', n), decision: decisionOf('accept_quote', { accept: true, mismatch: [] }, 10 + n), ...over,
  };
}

/** An excluded bidder with nothing paid for. */
export function excludedOf(desk: Did, reason: ExcludedQuote['reason'], code: string | null, over: Partial<ExcludedQuote> = {}): ExcludedQuote {
  return { kind: 'excluded', did: desk, reason, code, record: null, decision: null, challenge: null, ...over };
}

const SCORES: Readonly<Record<string, number>> = { [ALFA]: 90, [BRAVO]: 70, [CHARLIE]: 80 };

/** The golden score of a bidder: the four components are the score, and the decision records the same. */
export function scoredOf(desk: Did, n: number): ScoredQuote {
  const score = SCORES[desk] ?? 50;
  const components = { price: score, lead_time: score, reliability: score, compliance: score };
  return { did: desk, decision: decisionOf('score', { components, score }, 20 + n), choice: { components, score } };
}

// --- The scripted answers ----------------------------------------------------------------------------------------------------------------------------

/** The answer of a decision that succeeded. */
export type Answered<C> = Extract<DecisionAnswer<C>, { ok: true }>;

/** The answer of the decision `shortlist` for a choice: the decision records that same choice, as the decision of the model does. */
export function shortlistAnswer(invite: readonly Did[], notInvited: readonly { did: Did; reason: string }[] = []): Answered<ShortlistChoice> {
  const choice = { invite: [...invite], not_invited: notInvited.map((entry) => ({ ...entry })) };
  return { ok: true, decision: decisionOf('shortlist', JSON.parse(JSON.stringify(choice)) as JsonValue, 1), choice };
}

/** The answer of the decision `ranking` for an order. */
export function rankAnswer(order: readonly Did[], tieBreak = ''): Answered<RankingChoice> {
  const choice = { order: [...order], tie_break: tieBreak };
  return { ok: true, decision: decisionOf('ranking', JSON.parse(JSON.stringify(choice)) as JsonValue, 2), choice };
}

/** The golden fan-out: an accepted quote for each invited bidder, in the order of the invitation. */
export function goldenQuotes(input: QuotesInput): QuotesResult {
  const names = new Map<string, [number, string]>([[ALFA, [1, 'alfa']], [BRAVO, [2, 'bravo']], [CHARLIE, [3, 'charlie']], [DELTA, [4, 'delta']], [ECHO, [5, 'echo']]]);
  return { outcomes: input.invited.map((bidder) => acceptedOf(bidder.did, names.get(bidder.did)![0], names.get(bidder.did)![1])), stopped: null };
}

/** The golden scoring: a score for each subject, in the order of the subjects. */
export function goldenScoring(input: ScoringInput): ScoringResult {
  const numbers = new Map<string, number>([[ALFA, 1], [BRAVO, 2], [CHARLIE, 3], [DELTA, 4], [ECHO, 5]]);
  return { ok: true, scores: input.subjects.map((subject) => scoredOf(subject.did, numbers.get(subject.did)!)) };
}

// --- The world ---------------------------------------------------------------------------------------------------------------------------------------

/** The behaviour of each port. A test changes a member before the run. */
export interface Script {
  delegation: () => Promise<DelegationReading | null>;
  delegateKeyOf: (id: DelegationId) => Promise<string | null>;
  findKey: (keyHash: string) => TestKey | null;
  discover: () => Promise<DiscoverResult>;
  shortlist: (rfq: RfqDocument, files: readonly BidderFile[]) => Promise<DecisionAnswer<ShortlistChoice>>;
  quotes: (input: QuotesInput, key: TestKey, signal?: AbortSignal) => Promise<QuotesResult>;
  scoring: (input: ScoringInput, key: TestKey, signal?: AbortSignal) => Promise<ScoringResult>;
  rank: (input: RankInput) => Promise<DecisionAnswer<RankingChoice>>;
}

export interface RunOptions {
  readonly request?: Partial<ProposeRequest>;
  /** Parts of the deps that differ from the scripted ones. */
  readonly deps?: Partial<ProposeDeps<TestKey>>;
  readonly arrivedAt?: number;
  readonly signal?: AbortSignal;
}

export interface World {
  /** The time of the clock, in milliseconds. A test sets it. */
  readonly clock: { ms: number };
  /** The name of each port that the job called, in order. */
  readonly trace: string[];
  readonly calls: {
    readonly shortlist: { readonly rfq: RfqDocument; readonly files: readonly BidderFile[]; readonly argc: number }[];
    readonly quotes: { readonly input: QuotesInput; readonly key: TestKey; readonly signal: AbortSignal | undefined; readonly argc: number }[];
    readonly scoring: { readonly input: ScoringInput; readonly key: TestKey; readonly signal: AbortSignal | undefined; readonly argc: number }[];
    readonly rank: { readonly input: RankInput; readonly argc: number }[];
  };
  /** The lines that the job wrote to its log. */
  readonly logs: string[];
  readonly script: Script;
  readonly deps: ProposeDeps<TestKey>;
  /** Runs the steps 1 to 4. */
  front(over?: RunOptions): Promise<Fronted<TestKey>>;
}

/** The request of the golden run: the delegation of the hirer to this agent, the tenant, the request for quotation and the weights. */
export const REQUEST: ProposeRequest = { op: 'propose', authority: { principal_did: PRINCIPAL_DID, delegation: DELEGATION }, tenant: TENANT, rfq: RFQ, weights: WEIGHTS };

/** A world for `runPropose`: a ledger with the delegation of the hirer to this agent, three candidates, and a script that makes the golden run. */
export function world(): World {
  const clock = { ms: NOW };
  const trace: string[] = [];
  const calls: World['calls'] = { shortlist: [], quotes: [], scoring: [], rank: [] };
  const logs: string[] = [];
  const script: Script = {
    delegation: async () => ({ delegate: AGENT_ID, chain_whole: true }),
    delegateKeyOf: async () => KEY_HASH,
    findKey: (keyHash) => (keyHash === KEY_HASH ? KEY : null),
    discover: async () => ({ ok: true, value: { bidders: candidates() } }),
    shortlist: async () => shortlistAnswer([ALFA, BRAVO, CHARLIE]),
    quotes: async (input) => goldenQuotes(input),
    scoring: async (input) => goldenScoring(input),
    rank: async () => rankAnswer([ALFA, CHARLIE, BRAVO]),
  };
  const deps: ProposeDeps<TestKey> = {
    agent: { did: AGENT_DID },
    reads: {
      delegation: async () => {
        trace.push('delegation');
        return script.delegation();
      },
      liveVaults: async () => ({ refs: [], complete: true }),
    },
    delegateKeyOf: async (id) => {
      trace.push('delegateKeyOf');
      return script.delegateKeyOf(id);
    },
    delegationKeys: { find: (keyHash) => script.findKey(keyHash) },
    discover: async () => {
      trace.push('discover');
      return script.discover();
    },
    shortlist: async (...args) => {
      trace.push('shortlist');
      calls.shortlist.push({ rfq: args[0], files: args[1], argc: args.length });
      return script.shortlist(...args);
    },
    quotes: async (...args) => {
      trace.push('quotes');
      calls.quotes.push({ input: args[0], key: args[1], signal: args[2], argc: args.length });
      return script.quotes(...args);
    },
    scoring: async (...args) => {
      trace.push('scoring');
      calls.scoring.push({ input: args[0], key: args[1], signal: args[2], argc: args.length });
      return script.scoring(...args);
    },
    rank: async (...args) => {
      trace.push('rank');
      calls.rank.push({ input: args[0], argc: args.length });
      return script.rank(...args);
    },
    clock: () => clock.ms,
    log: (line) => void logs.push(line),
  };
  return {
    clock, trace, calls, logs, script, deps,
    front: (over = {}) => runFront({ ...deps, ...over.deps }, { ...REQUEST, ...over.request }, over.arrivedAt ?? NOW, over.signal),
  };
}

/** The time at which a job must have arrived so that `ms` milliseconds of its deadline are left at `NOW`. A hang then ends after that many milliseconds of real time. */
export const arrivedWith = (ms: number): number => NOW - PROPOSE_DEADLINE_MS + ms;

// --- What a test reads -------------------------------------------------------------------------------------------------------------------------------

/** What a call throws, or null when it returns. */
export const thrownBy = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => null,
    (error: unknown) => error,
  );

/** A failed result with this reason, and no document, no salt and no digest. */
export function expectFailed(result: unknown, reason: string): asserts result is SourcingFailed {
  expect(result).toMatchObject({ outcome: 'failed', exit_state: 'Failed', reason, document: null, salt: null, proposal_digest: null, fault_mode: '' });
}

/** The failed result of a front run that must have failed. */
export function failure(fronted: Fronted<TestKey>, reason: string): SourcingFailed {
  if (fronted.ok) throw new Error(`the front steps went on, and the test expected the failure ${reason}`);
  expectFailed(fronted.result, reason);
  return fronted.result;
}
