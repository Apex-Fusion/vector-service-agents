// packages/usecase-kit/src/bids/claims.ts
// The claim statements of the two agents of use case 3 (supplier bid evaluation): the Sourcing Agent and the Bid Desk. The two agents are two packages and they do not import each other, so the kit holds
// what both read. The capabilities of the two agents are in `ids.ts`.
//
// The manifest of an agent, its claim document and the challenge of the other agent all use these constants. A challenge names the text of a statement, and the text must be the text that the claim
// document of the other agent holds, so there is one text for each statement and it stands here. A claim has three statements with the ids S1, S2 and S3 and no reference to a claim: a claim is staked
// for each run. Each text is plain: one line, no control character, and no space at either end, and it fits a document for a juror.
//
// The constants are frozen, so that no code changes a text that two agents compare.
import type { ManifestClaim } from '../protocol/index.ts';

function claimOf(first: string, second: string, third: string): ManifestClaim {
  return Object.freeze({
    statements: Object.freeze([Object.freeze({ id: 'S1', text: first }), Object.freeze({ id: 'S2', text: second }), Object.freeze({ id: 'S3', text: third })] as const),
  });
}

/** The claim of the Sourcing Agent. */
export const SOURCING_CLAIM: ManifestClaim = claimOf(
  'Every score in a ranking cites the signed quote it was computed from.',
  'This agent ranks only bidders whose signed quote it holds and accepted.',
  'A ranking this agent writes to a sourcing record is the document whose digest its hirer approved.',
);

/** The claim of the Bid Desk. */
export const BID_DESK_CLAIM: ManifestClaim = claimOf(
  'The unit price of every line in a quote is the price its published price list gives for that SKU and quantity.',
  'A quote names the hash of the request for quotation it answers.',
  'This agent gives one quote per request for quotation and sender.',
);
