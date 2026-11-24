// packages/usecase-kit/src/bids/index.ts
// The documents of use case 3 (supplier bid evaluation) that the Sourcing Agent and the Bid Desk share. Import it as `@vsa/usecase-kit/bids`. The two agents are two packages and they do not import each
// other, so the kit holds what both read. Each document has a strict parser that returns a copy.
//
//   ids      the capabilities and the model names of the two agents, and the rule of a SKU and of a request identifier
//   rfq      the request for quotation, and its hash
//   weights  the four weights of a ranking
export { BID_CAPABILITIES, BID_DESK_MODEL, MAX_ITEM_QUANTITY, SOURCING_MODEL, parseRfqId, parseSku } from './ids.ts';
export { MAX_RFQ_ITEMS, parseRfqDocument, rfqSha256 } from './rfq.ts';
export type { RfqDocument, RfqItem } from './rfq.ts';
export { WEIGHT_NAMES, parseWeights } from './weights.ts';
export type { Weights } from './weights.ts';
