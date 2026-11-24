// agents/sourcing-agent/src/propose/result.ts
// The two forms of a result of `propose`. Each is the result of the kit (`proposedResult` and `failedProposalResult` write every member of it) and then the two members that the page of the agent adds after
// them: `bidders`, the file of every candidate that the job read, and `quotes`, the record of every quote job that has one. The service writes `fault_mode` last. A failed result keeps what the job holds: the
// decisions that it paid for, the quote jobs as sub-jobs, the files and the records. So a failure after the first hire never hides a payment.
import { failedProposalResult, proposedResult } from '@vsa/usecase-kit/buyer';
import type { ProposalPieces } from '@vsa/usecase-kit/buyer';
import type { Decision, FailedProposalResult, ProposedResult, SubJob } from '@vsa/usecase-kit/protocol';
import type { BidderFile, QuoteRecord } from './ports.ts';

/** The two members that this agent adds to a result of the kit. */
export interface SourcingMembers {
  /** The file of EVERY candidate, as the job read it. */
  readonly bidders: readonly BidderFile[];
  /** The record of every quote job that has one: the accepted quotes, and the excluded bidders that were paid. */
  readonly quotes: readonly QuoteRecord[];
}

/** A proposal that was made: the ranking as the document, and the two members after the members of the kit. */
export type SourcingProposal = ProposedResult & SourcingMembers;
/** A job that could not make a proposal, with what it held when it stopped. */
export type SourcingFailed = FailedProposalResult & SourcingMembers;
export type SourcingResult = SourcingProposal | SourcingFailed;

/** What one job holds. The lists only grow, and a failed result is made from them as they stand. */
export interface Held {
  /** Every decision that the job paid for, in the order of the page: `shortlist`, each `accept_quote`, each `score`, `ranking`. */
  readonly decisions: readonly Decision[];
  /** The quote job of each accepted quote. */
  readonly sub_jobs: readonly SubJob[];
  readonly bidders: readonly BidderFile[];
  readonly quotes: readonly QuoteRecord[];
}

/** A code with the form of a code: lower-case letters, digits and `_`, 64 characters at most. */
const CODE_FORM = /^[a-z0-9_]{1,64}$/;

/** The reason of a result: the code, or `internal` for any text that is not a code, such as the words of a port. */
export function reasonOf(code: unknown): string {
  return typeof code === 'string' && CODE_FORM.test(code) ? code : 'internal';
}

/** The pieces of the kit for what the job holds. The service stamps `fault_mode` on every result, so the job writes the empty text. */
function piecesOf(held: Held): ProposalPieces {
  return { use_case: 'bid-evaluation', decisions: held.decisions, sub_jobs: held.sub_jobs, fault_mode: '' };
}

function membersOf(held: Held): SourcingMembers {
  return { bidders: [...held.bidders], quotes: [...held.quotes] };
}

/** The failed result for a reason. A reason that is not a code is `internal`. */
export function failedSourcing(held: Held, reason: unknown): SourcingFailed {
  return { ...failedProposalResult(piecesOf(held), reasonOf(reason)), ...membersOf(held) };
}

/** The proposal for a ranking. A document that the kit refuses is the failed result `bad_document`, and it keeps what the job holds. */
export function proposedSourcing(document: unknown, held: Held): SourcingResult {
  return { ...proposedResult(document, piecesOf(held)), ...membersOf(held) };
}
