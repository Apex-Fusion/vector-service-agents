// agents/sourcing-agent/src/propose/ports.ts
// What `runPropose` needs from the outside, as ports: functions and plain values. The service joins them to the real ledger reads, the bidder reader, the model decisions, the quote fan-out and the scorers,
// and a test gives its own. This folder does not import the model, bidders, quotes, scoring, execute or serve folders of the agent. A shape that two folders share is written here as a plain shape: the file of
// a bidder, the choices of the two decisions, the quote fan-out and the scoring. The wiring of the service is where the types meet, and a mismatch is a compile error there.
import type { Components, PriceList, Quote, RfqDocument, Weights } from '@vsa/usecase-kit/bids';
import type { LedgerReads } from '@vsa/usecase-kit/buyer';
import type {
  ChallengeRecord, Decision, DelegationId, Did, Digest, JsonObject, OutputRef, ProposeRequest as ProtocolProposeRequest, ProtocolResult, ReceiptVerification, SubJob, TenantId,
} from '@vsa/usecase-kit/protocol';

/** A `propose` request of the Sourcing Agent: the members of the protocol, the request for quotation, and the four weights of the ranking. */
export type ProposeRequest = ProtocolProposeRequest<{ readonly rfq: RfqDocument; readonly weights: Weights }>;

// --- The bidder file ---------------------------------------------------------------------------------------------------------------------------------

/** The state of a fact that a source can fail to give. `unreadable` is a source that gave no answer. It is never `absent` and never `valid`. */
export type FactState = 'valid' | 'invalid' | 'absent' | 'unreadable';

/** The compliance attestation about a bidder. The reply of the bidder is a hash only. */
export interface ComplianceFact {
  /** `valid`: the newest attestation of the issuer is active. `invalid`: it is not. `absent`: none exists. */
  readonly state: FactState;
  readonly attestation: string | null;
  readonly attestation_state: 'active' | 'revoked' | 'expired' | 'not_yet_valid' | null;
  readonly issued_at: string | null;
  readonly valid_until: string | null;
  readonly revoked_at: string | null;
  readonly revoke_reason: string | null;
  readonly contested: { readonly sha256: string } | null;
}

/** What the record of a bidder says about the end of its life and the change of its controller. */
export interface BidderLineage {
  readonly hold_until: string | null;
  readonly ended_at: string | null;
  readonly invalid_from: string | null;
  readonly successor: Did | null;
  readonly recovery_pending: boolean;
}

/** The status of a bidder. `unreadable`: the gateway gave no answer. */
export type BidderStatus = 'active' | 'suspended' | 'revoked' | 'retired' | 'not_found' | 'unreadable';

/** The file of one bidder: the facts that the model reads. A fact is data and never a filter. */
export interface BidderFile {
  readonly did: Did;
  readonly advert_ref: OutputRef;
  readonly status: BidderStatus;
  readonly status_reason: string | null;
  readonly lineage: BidderLineage;
  readonly accountable: string | null;
  /** A lower-case domain, or null. */
  readonly organisation: string | null;
  /** True only when the gateway says that it verified the organisation. This folder passes `organisation` on only when it is true. */
  readonly organisation_verified: boolean;
  readonly in_catalog: boolean | null;
  readonly stake_lovelace: string | null;
  readonly cases_against: number | null;
  readonly price_list: 'valid' | 'invalid' | 'unreadable';
  readonly compliance: ComplianceFact;
  readonly credential: FactState;
}

/** What the code keeps of one bidder: the file, the key hash of its supplier key, and its price list, which is null unless `file.price_list` is `valid`. */
export interface BidderView {
  readonly file: BidderFile;
  readonly supplier_pkh: string;
  readonly price_list: { readonly list: PriceList; readonly sha256: Digest } | null;
}

/** The answer of the discovery: the bidders, or one of its two codes. */
export type DiscoverResult = ProtocolResult<{ readonly bidders: readonly BidderView[] }, 'bidders_unavailable' | 'no_bidders'>;

// --- The two decisions of this job -------------------------------------------------------------------------------------------------------------------

/** The decision `shortlist`: the bidders to invite, and the bidders that the model leaves out with a reason. */
export interface ShortlistChoice {
  readonly invite: readonly Did[];
  readonly not_invited: readonly { readonly did: Did; readonly reason: string }[];
}

/** The decision `ranking`: the order of the scored bidders, and the text of the tie-break (empty when there is none). */
export interface RankingChoice {
  readonly order: readonly Did[];
  readonly tie_break: string;
}

/**
 * The answer of a decision: the decision with its receipt and the typed choice, or the code of the failure. A failure holds no decision. `choice` must be the choice that `decision.choice` records, with the
 * same members and the same values: `runPropose` builds its result from the recorded copy only when the two are equal, and it fails with `decision_mismatch` when they differ.
 */
export type DecisionAnswer<C> = { readonly ok: true; readonly decision: Decision; readonly choice: C } | { readonly ok: false; readonly code: string };

/** What the decision `ranking` reads: the weights and, for each scored bidder, its score, its components and the two numbers of its quote. */
export interface RankInput {
  readonly weights: Weights;
  readonly scored: readonly RankScored[];
}

export interface RankScored {
  readonly desk_did: Did;
  readonly score: number;
  readonly components: Components;
  readonly total: number;
  readonly lead_time_days: number;
}

// --- The quote fan-out -------------------------------------------------------------------------------------------------------------------------------

/** An invited bidder, in the order of the invitation. `organisation` is the verified organisation of its file, or null. */
export interface BidderToHire {
  readonly did: Did;
  readonly advert_ref: OutputRef;
  readonly organisation: string | null;
  readonly price_list: { readonly list: PriceList; readonly sha256: Digest } | null;
}

/**
 * What the fan-out hires for: the request, this agent as the sender, the delegation of the hirer, the invited bidders, the time by which every hire must end, and the time that the caller keeps for the
 * scoring and the ranking after the last hire.
 */
export interface QuotesInput {
  readonly rfq: RfqDocument;
  readonly sender: Did;
  readonly delegation: DelegationId;
  readonly invited: readonly BidderToHire[];
  readonly deadline_ms: number;
  readonly keep_ms: number;
}

/** The hire of a bidder as the record of a quote job: the `HandoffRecord` of the kit with `desk_did` in place of `counterparty_did`, and the challenge that the agent filed, or null. */
export interface QuoteRecord {
  readonly desk_did: Did;
  readonly advert_ref: OutputRef;
  readonly escrow_ref: OutputRef;
  readonly paid_from_vault: boolean;
  readonly receipt: JsonObject | null;
  readonly receipt_signature: string | null;
  readonly verification: ReceiptVerification | null;
  /** The quote that the bidder returned. */
  readonly result: JsonObject | null;
  readonly accepted: 'confirmed' | 'pending' | 'no' | null;
  readonly challenge: ChallengeRecord | null;
}

/** A quote that the agent holds and accepted: the parsed quote, the record of its job, the sub-job, and the decision `accept_quote` that the model made for it. */
export interface AcceptedQuote {
  readonly kind: 'accepted';
  readonly did: Did;
  readonly quote: Quote;
  readonly record: QuoteRecord;
  readonly sub_job: SubJob;
  readonly decision: Decision;
}

/** An invited bidder that has no accepted quote: why, the code of the reason, what was paid for (the record and the decision), and the challenge that was filed. */
export interface ExcludedQuote {
  readonly kind: 'excluded';
  readonly did: Did;
  readonly reason: 'not_active' | 'refused' | 'failed' | 'disputed';
  readonly code: string | null;
  readonly record: QuoteRecord | null;
  readonly decision: Decision | null;
  readonly challenge: ChallengeRecord | null;
}

export type QuoteOutcome = AcceptedQuote | ExcludedQuote;

/** The result of the fan-out: one outcome for each invited bidder, in the order of the invitation, and the code of the decision that stopped the loop, or null. */
export interface QuotesResult {
  readonly outcomes: readonly QuoteOutcome[];
  readonly stopped: { readonly code: string } | null;
}

// --- The scoring -------------------------------------------------------------------------------------------------------------------------------------

/** A quote to score. `organisation` is the verified organisation of the file, or null. Subject `k` goes to the scorer `k + 1`. */
export interface ScoreSubject {
  readonly did: Did;
  readonly organisation: string | null;
  readonly quote: Quote;
  readonly file: BidderFile;
}

export interface ScoringInput {
  readonly tenant: TenantId;
  readonly delegation: DelegationId;
  /** The date on which the scoring starts, as `YYYY-MM-DD` in UTC, by the clock of the job. */
  readonly today: string;
  readonly weights: Weights;
  readonly rfq: RfqDocument;
  readonly subjects: readonly ScoreSubject[];
}

/** The score of one quote: the answer of its scorer (after the fault of the service), and the decision that records what the model said. */
export interface ScoredQuote {
  readonly did: Did;
  readonly decision: Decision;
  readonly choice: { readonly components: Components; readonly score: number };
}

export type ScoringResult = { readonly ok: true; readonly scores: readonly ScoredQuote[] } | { readonly ok: false; readonly code: string; readonly decisions: readonly Decision[] };

// --- The deps ----------------------------------------------------------------------------------------------------------------------------------------

/**
 * Everything that `runPropose` reads or does outside its own code. `K` is the shape of an entry of the delegation keys of the service: this folder gets it from `delegationKeys` and gives it to `quotes` and
 * `scoring`, and it never opens it. Each failure of a port is a typed result of the job, and no port gets a retry.
 * - `agent.did` is the DID that the delegation of the hirer names as its delegate. It is also the sender of each request for quotation.
 * - `reads` is the ledger reads of the kit. Its reading of a delegation holds the delegate and whether the chain is whole, and not the delegate key.
 * - `delegateKeyOf` gives the hash of the delegate key of the delegation, `null` when the ledger shows no such delegation, and rejects when the ledger cannot be read. `delegationKeys.find` gives the entry of
 *   this agent with that hash, or `null`.
 * - `discover` reads the bidders: a file for each candidate, and the price list of those that have a valid one. It sends nothing.
 * - `shortlist` is the decision `shortlist`, and `rank` is the decision `ranking`. Each is one model hire. The job never gives the signal of the caller to a decision.
 * - `quotes` hires the invited bidders for their quotes, one after the other, and `scoring` scores the accepted quotes. Both get the signal of the caller as the third argument, because each of them reads it
 *   before each commitment of its own (a Pay, a Delegate, a decision) and never gives it to a hire.
 * - `clock` gives the time in milliseconds. Every wait of the job ends at `arrivedAt + PROPOSE_DEADLINE_MS` by this clock.
 * - `log` gets one line for each job that stops, with the step and the code. A line has codes and counts, and no key, token or part of a quote. A function that throws changes no result.
 */
export interface ProposeDeps<K> {
  readonly agent: { readonly did: Did };
  readonly reads: LedgerReads;
  readonly delegateKeyOf: (id: DelegationId) => Promise<string | null>;
  readonly delegationKeys: { find(keyHash: string): K | null };
  readonly discover: () => Promise<DiscoverResult>;
  readonly shortlist: (rfq: RfqDocument, files: readonly BidderFile[]) => Promise<DecisionAnswer<ShortlistChoice>>;
  readonly quotes: (input: QuotesInput, key: K, signal?: AbortSignal) => Promise<QuotesResult>;
  readonly scoring: (input: ScoringInput, key: K, signal?: AbortSignal) => Promise<ScoringResult>;
  readonly rank: (input: RankInput) => Promise<DecisionAnswer<RankingChoice>>;
  readonly clock: () => number;
  readonly log: (line: string) => void;
}
