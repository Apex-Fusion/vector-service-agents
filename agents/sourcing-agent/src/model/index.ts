// agents/sourcing-agent/src/model/index.ts
// What the Sourcing Agent knows of its request and of its four model decisions (use case 3, supplier bid evaluation). Every source of data comes in through a parameter: this folder reads no file, no
// environment variable and no key, it calls no model, and it does not import the other folders of the agent (the reader of the bidders, the quotes, the scoring and the flows). The wiring of the service
// gives each decision to the decision folder of the kit, with the input that this folder makes.
//
//   intake     the two fields of a `propose` request: the request for quotation and the weights
//   bidder     the file of a bidder as a plain shape, and the part of it that a model reads
//   choice     the checks that the parsers of the choices share: a text of the model, and a list of values that stand each once
//   shortlist  the decision `shortlist`: the fixed text, the input and the parser of the choice
//   accept     the decision `accept_quote`
//   score      the decision `score`, and the entry of the vendor master that it reads
export { parseProposeFields } from './intake.ts';
export type { ProposeFields } from './intake.ts';
export type { BidderFile, BidderLineage, BidderStatus, ComplianceFact, FactState } from './bidder.ts';
export { MAX_INVITED, SHORTLIST_DECISION, shortlistInput } from './shortlist.ts';
export type { ShortlistChoice } from './shortlist.ts';
export { ACCEPT_QUOTE_DECISION, acceptQuoteInput } from './accept.ts';
export type { AcceptQuoteChoice } from './accept.ts';
export { SCORE_DECISION, scoreInput } from './score.ts';
export type { ScoreChoice, ScoreParts, VendorEntry } from './score.ts';
