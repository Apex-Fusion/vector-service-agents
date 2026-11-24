// agents/sourcing-agent/src/quotes/ports.ts
// What the quote fan-out of the Sourcing Agent (use case 3, supplier bid evaluation) needs from outside, what it gives back, and the closed list of the codes that it writes. A ledger, a gateway, a model and a
// challenge are ports: this folder reads no file, no environment variable and no key, and it does not import the other folders of the agent (`model`, `bidders`, `scoring`, `propose`, `execute` and `serve`).
// The service makes the real ports from its settings.
//
// The codes. Every `reason` and every `code` of an excluded bidder, and the code of `stopped`, is in `QUOTE_CODES`, and no other code is written. A code that comes from the kit passes on only when its list holds
// it: a reason of a failed hire that is no code of the hire kit, of the hire flow or of the protocol is `inconsistent_outcome`, and a code of a challenge that the challenge of a quote cannot give is
// `port_error`. The code of a decision that failed is the one exception: the decision port gives it, and the kit lists the codes of a decision. It passes on when it has the form of a code, and it is
// `invalid_code` when it has not.
import type { AgentDeps, HireFailure, PayingKey } from '@vsa/hire-kit';
import type { PriceList, Quote, RfqDocument } from '@vsa/usecase-kit/bids';
import { EARLIER_PAY_MAY_LAND, COUNTERPARTY_REFUSED, INCONSISTENT_OUTCOME, INTERRUPTION_REASONS, PAY_UNCONFIRMED } from '@vsa/usecase-kit/buyer';
import type { HireLimits, LedgerReads, RefusedCode } from '@vsa/usecase-kit/buyer';
import type { ChallengeCode, Dispute } from '@vsa/usecase-kit/dispute';
import { COUNTERPARTY_REFUSALS, ERROR_STATUS } from '@vsa/usecase-kit/protocol';
import type { ChallengeRecord, DelegationId, Decision, Did, Digest, JsonObject, OutputRef, ReceiptVerification, SubJob } from '@vsa/usecase-kit/protocol';

/**
 * The time that a hire of a quote can take, from the Pay to the end: the `deliver_by` window of the advert of a Bid Desk, which is 480,000 ms of work and 180,000 ms for the Accept. A hire starts only when
 * the deadline of the job leaves this time and the time that the caller keeps for the scoring.
 */
export const QUOTE_HIRE_RESERVE_MS = 660_000;

/** A bidder that the model invited, with what the job needs to hire it. The list is in the order of the invitation. */
export interface BidderToHire {
  readonly did: Did;
  /** The advert of the quote capability that the bidder file names. The hire reads it again on the chain before it pays. */
  readonly advert_ref: OutputRef;
  /** The organisation of the bidder when its record states one and the gateway verified it, else `null`. A quote that names another organisation is not from this bidder. */
  readonly organisation: string | null;
  /** The price list that the job read from the bidder and the SHA-256 of its text, or `null` when no valid list was read: the bidder is not paid. */
  readonly price_list: { readonly list: PriceList; readonly sha256: Digest } | null;
}

export interface QuotesInput {
  /** The request for quotation, as the intake of the job checked it. */
  readonly rfq: RfqDocument;
  /** This agent: the sender of the request. */
  readonly sender: Did;
  /** The delegation of the hirer. Its vault pays each quote. */
  readonly delegation: DelegationId;
  readonly invited: readonly BidderToHire[];
  /** The deadline of the whole job, in POSIX milliseconds. */
  readonly deadline_ms: number;
  /** The time that the caller keeps for the scoring, in milliseconds. A hire starts only when the deadline leaves this time and `QUOTE_HIRE_RESERVE_MS`. */
  readonly keep_ms: number;
}

/** What the gateway says of a record that is read again before a Pay: the effective status, or that no word could be read. */
export type BidderStatus = 'active' | 'suspended' | 'revoked' | 'retired' | 'not_found' | 'unreadable';

/** The choice of the decision `accept_quote`: whether to accept, and the SKU of each line whose unit price is not the price of the list. */
export interface AcceptQuoteChoice {
  readonly accept: boolean;
  readonly mismatch: readonly string[];
}

/**
 * What the decision `accept_quote` gives back. A decision that was made is the decision of the protocol (the choice as the model gave it, its reasoning and the model hire that bought it) and its choice as
 * a typed value. The caller of the port builds the typed choice from `decision.choice`, the recorded copy. A decision that failed holds no decision: it has the code of the failure.
 */
export type AcceptQuoteAnswer =
  | { readonly ok: true; readonly decision: Decision; readonly choice: AcceptQuoteChoice }
  | { readonly ok: false; readonly code: string };

export interface QuotesDeps {
  /** The paying key of the delegation key that the delegation names. It signs each Pay and each Accept. */
  readonly key: PayingKey;
  /** The deps of the hire kit: the clock, the sleep, the fetch, the ledger that books the lock and the fees, and the log. The deadline of a hire is not here: `runQuotes` sets it. */
  readonly hire: Omit<AgentDeps, 'deadlineMs'>;
  /** The reads of the delegation and of its Live vaults. */
  readonly reads: LedgerReads;
  /** The three limits of a hire of a Bid Desk. The service reads them from its settings. This folder never fills in a limit that is missing: a missing one is an error, and nothing is paid. */
  readonly limits: HireLimits;
  /** The status of a bidder, read again with the gateway just before its Pay. It rejects, or gives `unreadable`, when the gateway cannot answer. Only `active` goes on to the Pay. */
  recheck(did: Did): Promise<BidderStatus>;
  /** The decision `accept_quote`: the model compares the unit price of each line with the price of the published list of the bidder. */
  acceptQuote(input: { readonly rfq: RfqDocument; readonly quote: Quote; readonly list: PriceList }): Promise<AcceptQuoteAnswer>;
  /** The challenge of a quote that the model did not accept. */
  readonly dispute: Pick<Dispute, 'challengeDelivery'>;
  /** The key hashes of the delegation keys of this agent. The escrow of a hire that was paid from a vault names one of them as its buyer. */
  readonly buyerPkhs: readonly string[];
  readonly clock: () => number;
  /** One line for each step. A line has counts, codes and references: no quote, no price list, no key and no token. A function that throws changes no result. */
  readonly log: (line: string) => void;
}

/** The hire of a bidder as the result of the agent records it: the record of the kit with `desk_did` in place of `counterparty_did`, and the challenge that the agent filed against the bidder, or `null`. */
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

/** The words of the reason of an excluded bidder. */
export type ExcludedWord = 'not_active' | 'refused' | 'failed' | 'disputed';

/**
 * How the job ended for one invited bidder. An accepted quote has the quote that the model accepted, the record of the hire, the sub-job of the hire and the decision. An excluded bidder has a word and a
 * code, and what is known of the hire: its record (`null` when nothing was paid), the decision of the model when it made one, and the challenge when one was filed. The code of a challenge that was filed is `null`.
 */
export type QuoteOutcome =
  | {
    readonly kind: 'accepted';
    readonly did: Did;
    readonly quote: Quote;
    readonly record: QuoteRecord;
    readonly sub_job: SubJob;
    readonly decision: Decision;
  }
  | {
    readonly kind: 'excluded';
    readonly did: Did;
    readonly reason: ExcludedWord;
    readonly code: string | null;
    readonly record: QuoteRecord | null;
    readonly decision: Decision | null;
    readonly challenge: ChallengeRecord | null;
  };

/** One outcome for each invited bidder, in the order of the invitation. `stopped` holds the code of the failure that ended the loop, and no bidder after it was paid. */
export interface QuotesResult {
  readonly outcomes: readonly QuoteOutcome[];
  readonly stopped: { readonly code: string } | null;
}

// --- The codes ------------------------------------------------------------------------------------------------------------------------------------------------------

/** The codes that this folder gives itself. */
export const CODE = {
  // A bidder that is not paid.
  aborted: 'aborted',
  deadline: 'deadline',
  noPriceList: 'no_price_list',
  statusUnreadable: 'status_unreadable',
  notAttempted: 'not_attempted',
  // The end of a hire.
  vaultRefused: 'vault_refused',
  payUnconfirmed: PAY_UNCONFIRMED,
  notRecordable: 'delivery_not_recordable',
  decisionTimeout: 'decision_timeout',
  inconsistent: INCONSISTENT_OUTCOME,
  internal: 'internal',
  // The checks in code, before the model is asked.
  quoteInvalid: 'quote_invalid',
  quoteNotFromBidder: 'quote_not_from_bidder',
  quoteNotForRfq: 'quote_not_for_rfq',
  quoteNotFromList: 'quote_not_from_list',
  // The decision.
  decisionFailed: 'decision_failed',
  // The challenge.
  noEvidence: 'no_evidence',
  portError: 'port_error',
} as const;

/** The words of `excluded.reason`. */
const EXCLUDED_WORDS = ['not_active', 'refused', 'failed', 'disputed'] as const satisfies readonly ExcludedWord[];

/** The effective statuses that make a bidder not active. The word is the code. */
export const NOT_ACTIVE_STATUSES = ['suspended', 'revoked', 'retired', 'not_found'] as const;

/** What the reader of the answer of the decision port says when the answer is not a decision, and the code of a code that is no code. */
const ANSWER_CODES = ['answer_missing', 'answer_invalid', 'choice_invalid', 'choice_not_recorded', 'decision_threw', 'invalid_code'] as const;

/** The codes of a request that the flow refuses before the Pay. */
const REFUSED_CODES = ['delegation_not_mine', 'request_too_large', 'bad_shape', 'internal'] as const satisfies readonly RefusedCode[];
const REFUSED_CODES_ARE_LISTED: [Exclude<RefusedCode, (typeof REFUSED_CODES)[number]>] extends [never] ? true : never = true;

/**
 * The codes of the challenge that a quote can give. The two codes of the evidence of the other use cases (`confirmation_not_for_order`, `record_not_for_request`) cannot come from the evidence of a quote, so a
 * challenge that gives one is a fault of the port: `port_error`.
 */
export const CHALLENGE_CODES = [
  'bad_shape', 'no_open_claim', 'chain_unavailable', 'document_too_large', 'no_contradiction', 'same_agent', 'job_already_disputed', 'journal_unavailable', 'claim_window_closing', 'evidence_not_built',
  'evidence_not_confirmed', 'claim_changed', 'challenge_not_built', 'challenge_not_confirmed', 'challenge_wrong_claim', 'port_error',
] as const satisfies readonly ChallengeCode[];
const CHALLENGE_CODES_ARE_LISTED: [Exclude<ChallengeCode, (typeof CHALLENGE_CODES)[number] | 'confirmation_not_for_order' | 'record_not_for_request'>] extends [never] ? true : never = true;

/** The codes of the hire kit for a hire that failed after its Pay. */
const HIRE_KIT_FAILURES = ['post_failed', 'busy', 'refused', 'send_lost', 'failed', 'timeout', 'bad_result', 'receipt_failed', 'receipt_unavailable', 'accept_failed'] as const satisfies readonly HireFailure[];
const HIRE_KIT_FAILURES_ARE_LISTED: [Exclude<HireFailure, (typeof HIRE_KIT_FAILURES)[number]>] extends [never] ? true : never = true;

/** The codes that the hire flow of the kit gives for a hire that ended with no Pay, or with a fault of its own. */
const HIRE_FLOW_FAILURES = [
  'ledger_unavailable', 'advert_not_counterparty', 'advert_unavailable', 'no_live_vault', 'several_live_vaults', EARLIER_PAY_MAY_LAND, 'deadline', 'store_write_failed', 'hire_error', COUNTERPARTY_REFUSED,
  INCONSISTENT_OUTCOME,
] as const;

/** The reason of a `failed` step of the hire flow: a code of the hire kit, of the flow, or of the protocol (a Bid Desk answers an error with the code of the protocol before its Claim). */
export const FAILED_STEP_REASONS: ReadonlySet<string> = new Set<string>([...HIRE_KIT_FAILURES, ...HIRE_FLOW_FAILURES, ...Object.keys(ERROR_STATUS)]);

/** The refusal codes of a Bid Desk. */
export const BID_DESK_REFUSALS: ReadonlySet<string> = new Set<string>(COUNTERPARTY_REFUSALS['bid-desk']);

/** The reasons of a hire that an error ended after its Pay was confirmed. */
export const INTERRUPTION_CODES: ReadonlySet<string> = new Set<string>(Object.values(INTERRUPTION_REASONS));

/** The challenge codes as a set. */
export const CHALLENGE_CODE_SET: ReadonlySet<string> = new Set<string>(CHALLENGE_CODES);

/** The codes that `stopped` and an excluded bidder carry that this folder writes, with each `reason`. The decision port gives the code of a decision that failed, so that code is not here. */
export const QUOTE_CODES: readonly string[] = Object.freeze([
  ...new Set<string>([
    ...EXCLUDED_WORDS, ...Object.values(CODE), ...NOT_ACTIVE_STATUSES, ...ANSWER_CODES, ...REFUSED_CODES, ...CHALLENGE_CODES, ...BID_DESK_REFUSALS, ...INTERRUPTION_CODES, ...FAILED_STEP_REASONS,
  ]),
]);

void [REFUSED_CODES_ARE_LISTED, CHALLENGE_CODES_ARE_LISTED, HIRE_KIT_FAILURES_ARE_LISTED];
