// agents/sourcing-agent/src/quotes/evidence.ts
// The challenge of a quote that the model did not accept. The first statement of the claim of a Bid Desk says that the unit price of every line of a quote is the price that its published list gives for that
// SKU and quantity, so the evidence is one line whose unit price is not the listed price. The model names the SKUs that it holds to differ (`mismatch`), and the code reads that answer and no more:
//   1. Each SKU that the model names must be a line of the quote. A name that is no line gives no evidence.
//   2. The evidence is the FIRST line of the quote, in the order of the quote, that the model named and whose listed unit price exists and differs from the quoted unit price (`quotePriceFacts`). A line that the
//      model did not name is never the evidence, whatever its prices are. A line with no listed price, and a line at the listed price, give none.
//   3. With no evidence no challenge is made, and the code says `no_evidence`. The decision of the model stays on record.
//   4. With the evidence, the challenge goes to the dispute folder: the open claim of THAT bidder, its first statement, the capability of the quote, and the delegation keys of this agent as the buyer of the escrow.
// A throw of the dispute folder is `port_error`: a transaction may have landed, and the log line says so. A code of the dispute folder that a challenge of a quote cannot give is `port_error` too.
import { BID_CAPABILITIES, BID_DESK_CLAIM, lineChecks, quotePriceFacts } from '@vsa/usecase-kit/bids';
import type { PriceFacts, PriceList, Quote } from '@vsa/usecase-kit/bids';
import { disputedFields } from '@vsa/usecase-kit/dispute';
import type { ChallengeResult, DisputeOutcome } from '@vsa/usecase-kit/dispute';
import { parseDigest, parseOutputRef } from '@vsa/usecase-kit/protocol';
import type { ChallengeRecord, Did, Digest, OutputRef } from '@vsa/usecase-kit/protocol';
import { CHALLENGE_CODE_SET, CODE } from './ports.ts';
import type { QuotesDeps } from './ports.ts';

export interface ChallengeInput {
  /** The bidder that gave the quote. Its open claim is challenged. */
  readonly bidder: Did;
  /** The escrow of the hire: the output that the Pay made. */
  readonly escrow_ref: OutputRef;
  readonly quote: Quote;
  /** The SKUs that the model named. */
  readonly mismatch: readonly string[];
  readonly list: PriceList;
  /** The SHA-256 of the text of the price list that the job read. */
  readonly list_sha256: Digest;
  /** The SHA-256 of the text of the delivery: the hash that the receipt commits to for the quote. */
  readonly quote_sha256: Digest;
}

/** How the challenge ended: the record of a challenge that was filed (and then `code` is `null`), or the code of why none was. */
export interface ChallengeEnd {
  readonly challenge: ChallengeRecord | null;
  readonly code: string | null;
}

export interface ChallengeDeps {
  readonly dispute: QuotesDeps['dispute'];
  readonly buyerPkhs: QuotesDeps['buyerPkhs'];
  /** One line for the log. It never throws. */
  readonly note: (line: string) => void;
}

/** One line for the log about a challenge: what was filed, or why not, and each transaction that landed before the step stopped. */
function challengeLine(result: ChallengeResult): string {
  if (result.ok) return `quotes: challenge filed against claim ${result.value.record.claim}, evidence ${result.value.record.evidence}, challenge ${result.value.record.challenge}`;
  const landed = [
    result.evidence === null ? null : `evidence ${result.evidence.tx_hash}`,
    result.sent === null ? null : `sent ${result.sent.tx_hash} (may land ${result.sent.may_land}, valid to ${result.sent.valid_to})`,
    result.challenge === null ? null : `challenge ${result.challenge.challenge} against claim ${result.challenge.claim}`,
    result.wrong_document === null ? null : `document ${result.wrong_document.tx_hash}`,
  ].filter((piece) => piece !== null);
  return `quotes: challenge not filed (${result.code})${landed.length === 0 ? ', nothing landed' : `, landed: ${landed.join('; ')}`}`;
}

/** True when the value is the record of a challenge that was filed: two output references and the hash of the evidence transaction. */
function isChallengeRecord(value: unknown): value is ChallengeRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return parseOutputRef(Reflect.get(value, 'claim')).ok && parseDigest(Reflect.get(value, 'evidence')).ok && parseOutputRef(Reflect.get(value, 'challenge')).ok;
}

/** Files the challenge for a quote that the model did not accept, when a line that the model named is the evidence. */
export async function challengeQuote(deps: ChallengeDeps, input: ChallengeInput): Promise<ChallengeEnd> {
  const { note } = deps;
  const none = (code: string): ChallengeEnd => ({ challenge: null, code });
  const named = new Set(input.mismatch);
  if (![...named].every((sku) => input.quote.lines.some((line) => line.sku === sku))) {
    note('quotes: the model names a SKU that is no line of the quote, so no challenge is made');
    return none(CODE.noEvidence);
  }
  let evidence: PriceFacts | null = null;
  for (const line of lineChecks(input.quote, input.list)) {
    if (!named.has(line.sku)) continue;
    const facts = quotePriceFacts({ line, price_list_sha256: input.list_sha256, quote_sha256: input.quote_sha256 });
    if (facts.ok) {
      evidence = facts.value;
      break;
    }
  }
  if (evidence === null) {
    note('quotes: no line that the model names has a listed unit price that differs from its quoted unit price, so no challenge is made');
    return none(CODE.noEvidence);
  }
  let result: ChallengeResult;
  let fields: DisputeOutcome;
  try {
    result = await deps.dispute.challengeDelivery({
      counterparty: input.bidder,
      escrow_ref: input.escrow_ref,
      capability_id: BID_CAPABILITIES.quote,
      statement_text: BID_DESK_CLAIM.statements[0].text,
      buyer_pkhs: deps.buyerPkhs,
      evidence,
    });
    fields = disputedFields(result);
  } catch {
    note('quotes: the challenge stopped with an error, and a transaction may have landed');
    return none(CODE.portError);
  }
  note(challengeLine(result));
  if (fields.challenge !== null) {
    if (isChallengeRecord(fields.challenge)) return { challenge: fields.challenge, code: null };
    note('quotes: the challenge was filed, and its record is not in the form of a record, so the result holds none');
    return none(CODE.portError);
  }
  return none(CHALLENGE_CODE_SET.has(fields.reason) ? fields.reason : CODE.portError);
}
