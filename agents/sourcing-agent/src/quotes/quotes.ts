// agents/sourcing-agent/src/quotes/quotes.ts
// The quote fan-out of the Sourcing Agent (use case 3, supplier bid evaluation). It hires the invited bidders ONE AFTER THE OTHER from the vault of the delegation: one key has one vault output and one lane, so
// a hire is one turn from the read of the vault to the Accept, and the next bidder starts after that. For each bidder, in the order of the invitation, these steps run in this order, and the first that fails
// ends the work for that bidder:
//   1. The abort signal is read. A hang-up ends the loop: each bidder that is not paid is `aborted`. The signal is read before each Pay and is never passed into a hire.
//   2. The deadline leaves the time of a hire and the time that the caller keeps for the scoring. Else `deadline`.
//   3. The bidder has a price list that the job read. Else `no_price_list`: a quote that nobody can check is not bought.
//   4. The status of the bidder is read again with the gateway (`recheck`). Only `active` goes on. Else `not_active` with the status, or `status_unreadable`. Nothing is paid for a bidder that cannot claim its job.
//   5. One hire (`hireCounterparty`): one Pay, no retry, no second hire. The decision on the delivery is `judgeQuote`: three checks in code, and then the model.
//   6. The end of the hire becomes an outcome:
//        completed                          an accepted quote: the quote, the record and the sub-job of the hire, and the decision of the model that accepted it
//        refused_by_counterparty            excluded `refused`, with the refusal code and the record of the hire
//        vault_refused                      excluded `failed` with `vault_refused`: the vault refused the Pay, and nothing was paid
//        failed, interrupted, pay_unconfirmed, refused   excluded `failed` with the code of the step
//        not_accepted, a check in code      excluded `failed` with the code of the check, and NO challenge: no form of evidence states it
//        not_accepted, declined_by_model    a challenge against the open claim of THAT bidder when a line that the model named is the evidence, and excluded `disputed`
//        not_accepted, decision_failed      excluded `failed`, and the loop STOPS: no bidder after it is paid
//        not_accepted, any other end        excluded `failed` with `decision_timeout` or `delivery_not_recordable`
// A refused or failed Pay is never a quote. A quote is accepted only when the model accepted it and the hire kit made the Accept: a hire that says completed with no acceptance of the model on record is
// `inconsistent_outcome`, and the record keeps what the hire kit said of the Accept. Every outcome that has a decision keeps it. A throw ends the loop for the bidder it came in, and no bidder after it is paid.
import { BID_CAPABILITIES, BID_DESK_MODEL, parseQuote, parseRfqDocument } from '@vsa/usecase-kit/bids';
import { INTERRUPTION_REASONS, checkLimits, hireCounterparty } from '@vsa/usecase-kit/buyer';
import type { CompletedStep, HireStep, NotAcceptedStep, VerifiedDelivery } from '@vsa/usecase-kit/buyer';
import { RFQ_SCHEMA, isKeyHash, parseDigest, parseRfq } from '@vsa/usecase-kit/protocol';
import type { ChallengeRecord, Decision, Did, HandoffRecord, RfqMessage, SubJob } from '@vsa/usecase-kit/protocol';
import { flatText } from '@vsa/service-kit/text';
import { sha256Utf8Hex } from '@vsa/vector-read';
import { NOT_ACCEPTED, judgeQuote } from './decide.ts';
import type { Learned } from './decide.ts';
import { challengeQuote } from './evidence.ts';
import { BID_DESK_REFUSALS, CODE, FAILED_STEP_REASONS, INTERRUPTION_CODES, NOT_ACTIVE_STATUSES, QUOTE_HIRE_RESERVE_MS } from './ports.ts';
import type { BidderStatus, BidderToHire, ExcludedWord, QuoteOutcome, QuoteRecord, QuotesDeps, QuotesInput, QuotesResult } from './ports.ts';

type Excluded = Extract<QuoteOutcome, { kind: 'excluded' }>;

/** One outcome, and the code that ends the loop when the bidder ended it. */
interface Settled {
  readonly outcome: QuoteOutcome;
  readonly stop: { readonly code: string } | null;
}

/** What one bidder's turn needs besides the bidder: the deps, the checked input and the message that every bidder gets. */
interface Job {
  readonly deps: QuotesDeps;
  readonly input: QuotesInput;
  readonly message: RfqMessage;
  readonly limits: QuotesDeps['limits'];
  readonly note: (line: string) => void;
  /** Reads the abort signal now: true when the caller hung up. Each call reads the signal again. */
  readonly hungUp: () => boolean;
}

/** A log that never throws: a function that fails to log changes no result. */
function noteOf(log: QuotesDeps['log']): (line: string) => void {
  return (line) => {
    try {
      log(line);
    } catch {
      // The line is lost, and the job goes on.
    }
  };
}

function excluded(did: Did, reason: ExcludedWord, code: string | null, more: Partial<Pick<Excluded, 'record' | 'decision' | 'challenge'>> = {}): Excluded {
  return { kind: 'excluded', did, reason, code, record: more.record ?? null, decision: more.decision ?? null, challenge: more.challenge ?? null };
}

/** The hire as the result records it: the record of the kit with `desk_did` for `counterparty_did`, and the challenge that was filed against the bidder. A hire with no escrow has no record. */
function recordOf(handoff: HandoffRecord | null, challenge: ChallengeRecord | null): QuoteRecord | null {
  if (handoff === null) return null;
  return {
    desk_did: handoff.counterparty_did, advert_ref: handoff.advert_ref, escrow_ref: handoff.escrow_ref, paid_from_vault: handoff.paid_from_vault, receipt: handoff.receipt,
    receipt_signature: handoff.receipt_signature, verification: handoff.verification, result: handoff.result, accepted: handoff.accepted, challenge,
  };
}

/** The decision of the model that the hook made, when the model made one: its acceptance and its no. */
function decisionOf(learned: Learned | null): Decision | null {
  return learned !== null && (learned.said === 'accepted' || learned.said === NOT_ACCEPTED.declined) ? learned.decision : null;
}

/** The message that every bidder gets, and the request in the form that the checks of the quote read. A request that no check could read would be refused after the Pay, so it stops here, before any read. */
function jobOf(deps: QuotesDeps, input: QuotesInput, signal: AbortSignal | undefined): Job {
  const rfq = parseRfqDocument(input.rfq);
  if (!rfq.ok) throw new TypeError(`the request for quotation is not one: ${rfq.detail}`);
  const message = parseRfq({ schema: RFQ_SCHEMA, sender_did: input.sender, delegation: input.delegation, rfq: rfq.value });
  if (!message.ok) throw new TypeError(`the request for quotation cannot be sent: ${message.detail}`);
  const limits = checkLimits(deps.limits);
  if (!limits.ok) throw new TypeError(`the limits of the hire are wrong, so nothing is paid: ${limits.detail}`);
  if (!Number.isFinite(input.deadline_ms) || !Number.isFinite(input.keep_ms) || input.keep_ms < 0) throw new TypeError('the deadline and the time kept for the scoring must be numbers of milliseconds');
  return { deps, input: { ...input, rfq: rfq.value }, message: message.value, limits: limits.value, note: noteOf(deps.log), hungUp: () => signal?.aborted === true };
}

/** The sub-job of an accepted hire: the capability of the quote, the references of the hire, the supplier key hash that the receipt names, and the receipt as the supplier signed it. `null` when the receipt names none. */
function subJobOf(step: CompletedStep): SubJob | null {
  const supplier = step.delivery.receipt.supplier_pkh;
  if (!isKeyHash(supplier)) return null;
  return {
    capability_id: BID_CAPABILITIES.quote, advert_ref: step.handoff.advert_ref, escrow_ref: step.handoff.escrow_ref, supplier_pkh: supplier, receipt: step.delivery.receipt,
    receipt_signature: step.delivery.receipt_signature, verification: step.delivery.verification,
  };
}

/** One line for the log about the end of the hire: codes and references of the chain, and for a refused Pay the evaluation error of the node, which the hire flow flattens and cuts. No word of a bidder is here. */
function stepLine(at: string, step: HireStep): string {
  switch (step.kind) {
    case 'completed': return `quotes: ${at}, the hire is completed, escrow ${step.handoff.escrow_ref}`;
    case 'refused_by_counterparty': return `quotes: ${at}, the bidder refused (${step.reason}, ${step.source}), escrow ${step.handoff.escrow_ref}`;
    case 'vault_refused': return `quotes: ${at}, the vault refused the Pay (${step.refusal}), the delegation is ${step.delegation}: ${flatText(step.reason, 300)}`;
    case 'failed': return `quotes: ${at}, the hire failed (${step.reason})${step.handoff === null ? '' : `, escrow ${step.handoff.escrow_ref}`}`;
    case 'not_accepted': return `quotes: ${at}, the quote was not accepted (${step.why}), escrow ${step.handoff.escrow_ref}`;
    case 'interrupted': return `quotes: ${at}, the hire was interrupted (${step.cause_kind}), escrow ${step.escrow_ref}`;
    case 'pay_unconfirmed': return `quotes: ${at}, the Pay was sent and not seen confirmed, escrow ${step.escrow_ref}, transaction ${step.tx_hash}, it may land ${step.may_land} until ${step.valid_to}`;
    default: return `quotes: ${at}, the request was refused before the Pay (${step.code})`;
  }
}

/** A hire that the kit calls completed, and that the model accepted: the quote that was accepted, with what the hire holds. Anything that does not hold together is `inconsistent_outcome`, and the record stays. */
function accepted(job: Job, bidder: BidderToHire, step: CompletedStep, learned: Learned | null): Settled {
  const { note } = job;
  if (step.booking_failed !== null) {
    note(`quotes: the ledger did not book the fee of the Accept: accept transaction ${flatText(step.booking_failed.accept_tx_hash ?? 'unknown', 80)}, fee ${step.booking_failed.fee_lovelace} lovelace`);
  }
  const record = recordOf(step.handoff, null);
  const inconsistent = (): Settled => ({ outcome: excluded(bidder.did, 'failed', CODE.inconsistent, { record, decision: decisionOf(learned) }), stop: null });
  // The Accept is made only after the acceptance of the model, so a completed hire has that decision on record, and it is the decision for the text of this delivery.
  if (learned === null || learned.said !== 'accepted' || learned.quote_sha256 !== sha256Utf8Hex(step.delivery.text)) return inconsistent();
  const quote = parseQuote(step.delivery.result);
  const subJob = subJobOf(step);
  if (!quote.ok || record === null || subJob === null) return inconsistent();
  return { outcome: { kind: 'accepted', did: bidder.did, quote: quote.value, record, sub_job: subJob, decision: learned.decision }, stop: null };
}

/** The model did not accept the quote. The challenge is filed against the open claim of the bidder, with a line that the model named as the evidence. */
async function disputed(job: Job, bidder: BidderToHire, step: { readonly handoff: HandoffRecord; readonly delivery: VerifiedDelivery }, learned: Extract<Learned, { said: typeof NOT_ACCEPTED.declined }>): Promise<Settled> {
  const price = bidder.price_list;
  // The decision was made for the text of the delivery that the hook saw, and the evidence is that text. A step that holds another text is not the delivery that the model judged.
  if (price === null || learned.quote_sha256 !== sha256Utf8Hex(step.delivery.text)) return { outcome: excluded(bidder.did, 'failed', CODE.inconsistent, { record: recordOf(step.handoff, null), decision: learned.decision }), stop: null };
  const end = await challengeQuote({ dispute: job.deps.dispute, buyerPkhs: job.deps.buyerPkhs, note: job.note }, {
    bidder: bidder.did, escrow_ref: step.handoff.escrow_ref, quote: learned.quote, mismatch: learned.mismatch, list: price.list, list_sha256: price.sha256, quote_sha256: learned.quote_sha256,
  });
  return { outcome: excluded(bidder.did, 'disputed', end.code, { record: recordOf(step.handoff, end.challenge), decision: learned.decision, challenge: end.challenge }), stop: null };
}

/** The outcome for a delivery that the hire kit did not accept. Only a no of the model starts a challenge: every other end is a failure, and the model had no say in it. */
async function notAccepted(job: Job, bidder: BidderToHire, step: NotAcceptedStep, learned: Learned | null): Promise<Settled> {
  const failed = (code: string): Settled => ({ outcome: excluded(bidder.did, 'failed', code, { record: recordOf(step.handoff, null), decision: decisionOf(learned) }), stop: null });
  switch (step.why) {
    case 'not_recordable': return failed(CODE.notRecordable);
    case 'decision_timeout': return failed(CODE.decisionTimeout);
    case 'declined': {
      // The reason that the hook gave is the word of what the hook learned. A step with another reason was not ended by this decision.
      if (learned === null || learned.said !== step.declined) return failed(CODE.inconsistent);
      switch (learned.said) {
        case NOT_ACCEPTED.invalid:
        case NOT_ACCEPTED.notFromBidder:
        case NOT_ACCEPTED.notForRfq:
        case NOT_ACCEPTED.notFromList:
        case NOT_ACCEPTED.notRecordable:
          return failed(learned.said);
        case NOT_ACCEPTED.failed: return { ...failed(CODE.decisionFailed), stop: { code: learned.code } };
        case NOT_ACCEPTED.declined: return disputed(job, bidder, step, learned);
        default: return failed(CODE.inconsistent);
      }
    }
    default: return failed(CODE.inconsistent);
  }
}

/** The outcome for the end of the hire. */
async function settle(job: Job, bidder: BidderToHire, step: HireStep, learned: Learned | null): Promise<Settled> {
  const failed = (code: string, handoff: HandoffRecord | null = null): Settled => ({ outcome: excluded(bidder.did, 'failed', code, { record: recordOf(handoff, null), decision: decisionOf(learned) }), stop: null });
  switch (step.kind) {
    case 'completed': return accepted(job, bidder, step, learned);
    case 'refused_by_counterparty': {
      if (!BID_DESK_REFUSALS.has(step.reason)) return failed(CODE.inconsistent, step.handoff);
      return { outcome: excluded(bidder.did, 'refused', step.reason, { record: recordOf(step.handoff, null), decision: decisionOf(learned) }), stop: null };
    }
    case 'vault_refused': return failed(CODE.vaultRefused);
    case 'failed': return failed(FAILED_STEP_REASONS.has(step.reason) ? step.reason : CODE.inconsistent, step.handoff);
    case 'interrupted': {
      const reason = INTERRUPTION_REASONS[step.cause_kind];
      return failed(INTERRUPTION_CODES.has(reason) ? reason : CODE.inconsistent, step.handoff);
    }
    case 'pay_unconfirmed': return failed(CODE.payUnconfirmed, step.handoff);
    case 'refused': return failed(step.code);
    case 'not_accepted': return notAccepted(job, bidder, step, learned);
    default: return failed(CODE.inconsistent);
  }
}

/** A bidder that is not paid, with the reason and the code, and a line for the log. */
function skipped(job: Job, bidder: BidderToHire, at: string, reason: ExcludedWord, code: string): Settled {
  job.note(`quotes: ${at}, the bidder is not paid (${code})`);
  return { outcome: excluded(bidder.did, reason, code), stop: null };
}

/** The turn of one bidder: the checks before the Pay, the hire, and the outcome. */
async function turn(job: Job, bidder: BidderToHire, at: string): Promise<Settled> {
  const { deps, input, note } = job;
  // The comparison fails closed: a clock that gives no number is a deadline that has passed.
  const hasTime = (): boolean => input.deadline_ms - deps.clock() >= QUOTE_HIRE_RESERVE_MS + input.keep_ms;
  if (job.hungUp()) return skipped(job, bidder, at, 'failed', CODE.aborted);
  if (!hasTime()) return skipped(job, bidder, at, 'failed', CODE.deadline);
  const price = bidder.price_list;
  // A list whose hash is no digest cannot be checked against a quote, as a missing list cannot: the quote would fail a check after the Pay, so nothing is paid.
  if (price === null || !parseDigest(price.sha256).ok) return skipped(job, bidder, at, 'failed', CODE.noPriceList);
  let status: BidderStatus;
  try {
    status = await deps.recheck(bidder.did);
  } catch {
    status = 'unreadable';
  }
  if (status !== 'active') {
    const word = NOT_ACTIVE_STATUSES.find((candidate) => candidate === status);
    return word === undefined ? skipped(job, bidder, at, 'failed', CODE.statusUnreadable) : skipped(job, bidder, at, 'not_active', word);
  }
  // The read of the status takes time. A hang-up while it was read ends the loop, and a deadline that came while it was read stops the Pay: the signal and the deadline are read once more, right before the Pay.
  if (job.hungUp()) return skipped(job, bidder, at, 'failed', CODE.aborted);
  if (!hasTime()) return skipped(job, bidder, at, 'failed', CODE.deadline);
  const judge = judgeQuote({ acceptQuote: (given) => deps.acceptQuote(given), note }, input.rfq, bidder, price);
  const step = await hireCounterparty({ key: deps.key, hire: { ...deps.hire, deadlineMs: input.deadline_ms }, reads: deps.reads }, {
    message: job.message, counterparty_did: bidder.did, capability_id: BID_CAPABILITIES.quote, model: BID_DESK_MODEL, advert_ref: bidder.advert_ref, limits: job.limits, decide: judge.decide,
  });
  note(stepLine(at, step));
  return settle(job, bidder, step, judge.learned());
}

/**
 * Hires the invited bidders for their quotes, one after the other, and gives one outcome for each, in the order of the invitation. It throws a TypeError, before any read and before any Pay, for an input that no
 * hire could carry: a request that is no request for quotation, limits that are wrong, a deadline that is no number. It never throws after that: an error ends the loop and the result keeps what was paid.
 * A decision that fails stops the loop (`stopped`), and each bidder after it is `not_attempted`. A caller that hung up (`signal`) ends the loop: each bidder that is not paid is `aborted`.
 */
export async function runQuotes(deps: QuotesDeps, input: QuotesInput, signal?: AbortSignal): Promise<QuotesResult> {
  const job = jobOf(deps, input, signal);
  const outcomes: QuoteOutcome[] = [];
  let stopped: { readonly code: string } | null = null;
  for (const [index, bidder] of job.input.invited.entries()) {
    if (stopped !== null) {
      outcomes.push(excluded(bidder.did, 'failed', CODE.notAttempted));
      continue;
    }
    const at = `bidder ${index + 1} of ${job.input.invited.length}`;
    let settled: Settled;
    try {
      settled = await turn(job, bidder, at);
    } catch {
      // Nothing that a turn reads throws for data, and a hire never throws for what it can end with. A throw is a fault, and the state of the Pay is not known: no bidder after it is paid.
      job.note(`quotes: ${at}, the turn stopped with an error, so no bidder after it is paid`);
      settled = { outcome: excluded(bidder.did, 'failed', CODE.internal), stop: { code: CODE.internal } };
    }
    outcomes.push(settled.outcome);
    if (settled.stop !== null) {
      stopped = settled.stop;
      job.note(`quotes: the loop stops (${stopped.code}), so no bidder after ${at} is paid`);
    }
  }
  return { outcomes, stopped };
}
