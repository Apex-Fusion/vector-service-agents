// agents/sourcing-agent/src/propose/ranking.ts
// The ranking of a job, made from what the job holds. The ranking is built here and nowhere else: the entries come in the order that the model gave, and each entry takes its numbers from the scorer of its own
// bidder and its quote from the quote that the agent accepted and holds. The model writes the order and nothing more. A word of the model never reaches the `quote` member of an entry, so a score always
// cites the signed quote that it was computed from, and the ranking holds only bidders whose signed quote the agent holds and accepted.
//
// The organisation of a bidder is a member of its entry only when its file says that the gateway verified it. Every function here is pure: it reads its arguments and nothing else.
import { buildRanking, receiptSha256 } from '@vsa/usecase-kit/bids';
import type { Components, ExcludedEntry, Quote, RankedQuote, Ranking, RfqDocument, Weights } from '@vsa/usecase-kit/bids';
import type { Did, ProtocolResult } from '@vsa/usecase-kit/protocol';
import type { AcceptedQuote, BidderFile, ExcludedQuote } from './ports.ts';

/** A quote that the agent holds and accepted: the parsed quote of its bidder, and the member of the ranking that cites it. */
export interface HeldQuote {
  readonly did: Did;
  readonly quote: Quote;
  readonly ranked: RankedQuote;
}

/** A bidder in the ranking: its verified organisation or null, the numbers of its own scorer, and the quote that the scorer read. */
export interface RankedBidder {
  readonly did: Did;
  readonly organisation: string | null;
  readonly score: number;
  readonly components: Components;
  readonly quote: RankedQuote;
}

/**
 * The organisation of a bidder, for the hire, the scorer and the ranking: its domain when the gateway verified it, and else null. The check is the boolean `true` and nothing else. A domain that a bidder
 * states and no check backs never picks a vendor entry and never reaches the ranking.
 */
export function verifiedOrganisation(file: BidderFile): string | null {
  return file.organisation_verified === true && typeof file.organisation === 'string' ? file.organisation : null;
}

/**
 * The quote that the agent holds for an accepted outcome, or null when the outcome is not one that the ranking may cite. The quote, the record of its job and its sub-job are the job of ONE bidder: the quote
 * and the record name the bidder, the record names the escrow of the sub-job, the vault paid, the Accept was made (`confirmed` or `pending`), and the record holds a receipt and its signature. The member of
 * the ranking is made from the record and the quote: the escrow, the hash of the signed receipt, and the two numbers of the quote.
 */
export function heldQuoteOf(outcome: AcceptedQuote): HeldQuote | null {
  const { did, quote, record, sub_job: subJob } = outcome;
  if (quote.desk_did !== did || record.desk_did !== did || record.escrow_ref !== subJob.escrow_ref || record.paid_from_vault !== true) return null;
  if (record.accepted !== 'confirmed' && record.accepted !== 'pending') return null;
  const hash = receiptSha256(record.receipt, record.receipt_signature);
  if (!hash.ok) return null;
  return { did, quote, ranked: { escrow_ref: record.escrow_ref, receipt_sha256: hash.value, total: quote.total, lead_time_days: quote.lead_time_days } };
}

/** True when `order` is a list that holds each of `dids` once and nothing else. `dids` holds each DID once. */
export function isPermutation(order: unknown, dids: readonly Did[]): order is readonly Did[] {
  if (!Array.isArray(order) || order.length !== dids.length) return false;
  const expected: ReadonlySet<unknown> = new Set(dids);
  const seen = new Set<unknown>();
  for (const did of order as readonly unknown[]) {
    if (!expected.has(did) || seen.has(did)) return false;
    seen.add(did);
  }
  return true;
}

/**
 * The excluded list: every candidate that is not ranked, in the order of the candidates. A candidate that the model did not invite is `not_invited` with no code. An invited candidate has the reason and the
 * code of its outcome. It is `null` when an invited candidate has no outcome: the fan-out owes an outcome to each bidder that it was given.
 */
export function excludedOf(
  candidates: readonly Did[], ranked: ReadonlySet<Did>, invited: ReadonlySet<Did>, outcomes: ReadonlyMap<Did, ExcludedQuote>,
): readonly ExcludedEntry[] | null {
  const excluded: ExcludedEntry[] = [];
  for (const did of candidates) {
    if (ranked.has(did)) continue;
    if (!invited.has(did)) {
      excluded.push({ desk_did: did, reason: 'not_invited', code: null });
      continue;
    }
    const outcome = outcomes.get(did);
    if (outcome === undefined) return null;
    excluded.push({ desk_did: did, reason: outcome.reason, code: outcome.code });
  }
  return excluded;
}

/**
 * The ranking for the bidders in the order given, as `buildRanking` of the kit makes it: it gives the ranks by position, never sorts, never changes a score, and runs the parser on its result. A bidder
 * has the member `organisation` only when it has one that the gateway verified.
 */
export function rankingOf(input: {
  readonly rfq: RfqDocument;
  readonly tenant: string;
  readonly weights: Weights;
  readonly bidders: readonly RankedBidder[];
  readonly excluded: readonly ExcludedEntry[];
}): ProtocolResult<Ranking> {
  const entries = input.bidders.map((bidder) => ({
    desk_did: bidder.did,
    ...(bidder.organisation === null ? {} : { organisation: bidder.organisation }),
    score: bidder.score,
    components: bidder.components,
    quote: bidder.quote,
  }));
  return buildRanking({ rfq: input.rfq, tenant: input.tenant, weights: input.weights, entries, excluded: input.excluded });
}
