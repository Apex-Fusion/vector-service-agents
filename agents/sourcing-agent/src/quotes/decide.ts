// agents/sourcing-agent/src/quotes/decide.ts
// The decision on the delivery of a bidder. The hire flow asks it after the eight checks of the receipt and before the Accept. It has these parts, in this order, and the first five need no model:
//   1. The answer of the bidder must be a quote (`parseQuote`). Else the reason is `quote_invalid`.
//   2. The quote must be from this bidder: its `desk_did` is the DID of the bidder, and its `organisation` is the organisation of the bidder when the file has one. Else `quote_not_from_bidder`.
//   3. The quote must answer this request (`checkQuoteAnswersRfq`). Else `quote_not_for_rfq`.
//   4. The quote must be priced from the list that the job read (`checkQuoteFromList` with the hash of that list). Else `quote_not_from_list`.
//   5. The delivery must be recordable as a sub-job: its receipt names the key hash of the supplier. Else `delivery_not_recordable`.
//   6. The model decides (`accept_quote`): it compares the unit price of each line with the price of the list. `declined_by_model` is its no. `decision_failed` is a decision that could not be made or read.
// A delivery that fails a part before the sixth is never given to the model, and the model is not paid for it. No part is a reason for a challenge except the no of the model: a challenge needs the decision
// of the model as its ground.
//
// The decision accepts only for the boolean `true` of a choice that names no SKU and that is the choice that the recorded decision holds. Any other answer of the model port, a failure, a throw and a value of
// another type included, is `decision_failed`, and nothing is accepted. The judge keeps what it learned (which of the ends, and the decision when the model made one), so that the job reads it after the hire.
import type { AcceptDecision } from '@vsa/hire-kit';
import { checkQuoteAnswersRfq, checkQuoteFromList, parseQuote } from '@vsa/usecase-kit/bids';
import type { PriceList, Quote, RfqDocument } from '@vsa/usecase-kit/bids';
import type { DeliveryDecision, VerifiedDelivery } from '@vsa/usecase-kit/buyer';
import { canonicalJson, isKeyHash, isPlainObject } from '@vsa/usecase-kit/protocol';
import type { Decision, Digest } from '@vsa/usecase-kit/protocol';
import { sha256Utf8Hex } from '@vsa/vector-read';
import { CODE } from './ports.ts';
import type { BidderToHire, QuotesDeps } from './ports.ts';

/** What the decision tells the hire kit when it does not accept. The job reads the same words back from the step `not_accepted` of the hire. */
export const NOT_ACCEPTED = {
  invalid: CODE.quoteInvalid,
  notFromBidder: CODE.quoteNotFromBidder,
  notForRfq: CODE.quoteNotForRfq,
  notFromList: CODE.quoteNotFromList,
  notRecordable: CODE.notRecordable,
  declined: 'declined_by_model',
  failed: CODE.decisionFailed,
} as const;

/** The reasons that come from a check in code. The model was not asked. */
export type Checked = typeof NOT_ACCEPTED.invalid | typeof NOT_ACCEPTED.notFromBidder | typeof NOT_ACCEPTED.notForRfq | typeof NOT_ACCEPTED.notFromList | typeof NOT_ACCEPTED.notRecordable;

/**
 * What the decision learned of a delivery. A model that made a decision gives it with `accepted` and with `declined_by_model`. The checks in code and a failed decision hold no decision. `quote_sha256` is the
 * SHA-256 of the text of the delivery that the decision was made for: the job compares it with the delivery of the step.
 */
export type Learned =
  | { readonly said: 'accepted'; readonly decision: Decision; readonly quote_sha256: Digest }
  | { readonly said: typeof NOT_ACCEPTED.declined; readonly decision: Decision; readonly quote: Quote; readonly mismatch: readonly string[]; readonly quote_sha256: Digest }
  | { readonly said: Checked }
  | { readonly said: typeof NOT_ACCEPTED.failed; readonly code: string };

export interface QuoteJudge {
  /** The decision of the hire: it accepts, or it says no with one of the reasons of `NOT_ACCEPTED`. */
  readonly decide: DeliveryDecision;
  /** What the decision learned, or `null` when it has not run. */
  readonly learned: () => Learned | null;
}

export interface JudgeDeps {
  readonly acceptQuote: QuotesDeps['acceptQuote'];
  /** One line for the log. It never throws. */
  readonly note: (line: string) => void;
}

/** A code that may stand in a result and in a log line: lower-case letters, digits and "_", 64 characters at most. The text of a decision port could be anything, so no other text goes into a result or a log line. */
const FORM = /^[a-z0-9_]{1,64}$/;

type Read =
  | { readonly ok: true; readonly decision: Decision; readonly accept: boolean; readonly mismatch: readonly string[] }
  | { readonly ok: false; readonly code: string };

const unreadable = (code: string): Read => ({ ok: false, code });

/**
 * The answer of the model port as a decision that was made, or the code of why it is not one. The answer is read as a value of an unknown type: `ok` must be `true`, the decision must be an object, `accept`
 * must be a boolean, `mismatch` must be a list of texts, the choice must not contradict itself (it accepts exactly when `mismatch` is empty), and it must be the choice that the recorded decision holds, so
 * that the Accept never rests on a value that the record does not show.
 */
function readAnswer(answer: unknown): Read {
  if (typeof answer !== 'object' || answer === null) return unreadable('answer_missing');
  const ok: unknown = Reflect.get(answer, 'ok');
  if (ok === false) {
    const code: unknown = Reflect.get(answer, 'code');
    return unreadable(typeof code === 'string' && FORM.test(code) ? code : 'invalid_code');
  }
  if (ok !== true) return unreadable('answer_invalid');
  const decision: unknown = Reflect.get(answer, 'decision');
  const choice: unknown = Reflect.get(answer, 'choice');
  if (typeof decision !== 'object' || decision === null || !isPlainObject(choice)) return unreadable('answer_invalid');
  const accept: unknown = choice.accept;
  const mismatch: unknown = choice.mismatch;
  if (typeof accept !== 'boolean') return unreadable('choice_invalid');
  if (!Array.isArray(mismatch) || !mismatch.every((sku): sku is string => typeof sku === 'string')) return unreadable('choice_invalid');
  // A choice that contradicts itself is no decision: it accepts exactly when it names no SKU. The Accept cannot be undone, so the job acts on neither side of a contradiction.
  if (accept === (mismatch.length > 0)) return unreadable('choice_invalid');
  const recorded = canonicalJson(Reflect.get(decision, 'choice'));
  const typed = canonicalJson(choice);
  if (!recorded.ok || !typed.ok || recorded.value !== typed.value) return unreadable('choice_not_recorded');
  // The checks above leave an object that has the members of a decision of the protocol: the port gives the record that the model hire made.
  return { ok: true, decision: decision as Decision, accept, mismatch: [...mismatch] };
}

/** The decision of the hire for one bidder. `list` is the price list that the job read from the bidder, with the hash of its text. */
export function judgeQuote(deps: JudgeDeps, rfq: RfqDocument, bidder: Pick<BidderToHire, 'did' | 'organisation'>, list: { readonly list: PriceList; readonly sha256: Digest }): QuoteJudge {
  let learned: Learned | null = null;
  const refuse = (said: Checked, line: string): AcceptDecision => {
    learned = { said };
    deps.note(line);
    return { accept: false, reason: said };
  };
  const judge = async (delivery: VerifiedDelivery): Promise<AcceptDecision> => {
    const parsed = parseQuote(delivery.result);
    if (!parsed.ok) return refuse(NOT_ACCEPTED.invalid, 'quotes: the answer of the bidder is not a quote, so the model was not asked');
    const quote = parsed.value;
    if (quote.desk_did !== bidder.did || (bidder.organisation !== null && quote.organisation !== bidder.organisation)) {
      return refuse(NOT_ACCEPTED.notFromBidder, 'quotes: the quote is not from the bidder that was hired, so the model was not asked');
    }
    if (!checkQuoteAnswersRfq(quote, rfq).ok) return refuse(NOT_ACCEPTED.notForRfq, 'quotes: the quote does not answer this request, so the model was not asked');
    if (!checkQuoteFromList(quote, list.sha256).ok) return refuse(NOT_ACCEPTED.notFromList, 'quotes: the quote is not priced from the price list that was read, so the model was not asked');
    // The accepted quote is recorded as a sub-job, and a sub-job names the key hash of its supplier. The receipt holds it: the check of the supplier key passed. A receipt without it cannot be recorded.
    if (!isKeyHash(delivery.receipt.supplier_pkh)) return refuse(NOT_ACCEPTED.notRecordable, 'quotes: the receipt names no supplier key hash, so the delivery cannot be recorded and the model was not asked');
    let read: Read;
    try {
      read = readAnswer(await deps.acceptQuote({ rfq, quote, list: list.list }));
    } catch {
      read = unreadable('decision_threw');
    }
    if (!read.ok) {
      learned = { said: NOT_ACCEPTED.failed, code: read.code };
      deps.note(`quotes: the decision accept_quote failed (${read.code})`);
      return { accept: false, reason: NOT_ACCEPTED.failed };
    }
    const quoteSha256 = sha256Utf8Hex(delivery.text);
    if (read.accept) {
      learned = { said: 'accepted', decision: read.decision, quote_sha256: quoteSha256 };
      deps.note('quotes: the model accepts the quote');
      return { accept: true };
    }
    learned = { said: NOT_ACCEPTED.declined, decision: read.decision, quote, mismatch: read.mismatch, quote_sha256: quoteSha256 };
    deps.note(`quotes: the model does not accept the quote, it names ${read.mismatch.length} line${read.mismatch.length === 1 ? '' : 's'}`);
    return { accept: false, reason: NOT_ACCEPTED.declined };
  };
  const decide = async (delivery: VerifiedDelivery): Promise<AcceptDecision> => {
    try {
      return await judge(delivery);
    } catch {
      // Nothing that this code reads throws for data. A throw is a fault, and it must not become an Accept: the decision failed, and the job stops.
      learned = { said: NOT_ACCEPTED.failed, code: 'decision_threw' };
      deps.note('quotes: the decision on the quote stopped with an error');
      return { accept: false, reason: NOT_ACCEPTED.failed };
    }
  };
  return { decide, learned: () => learned };
}
