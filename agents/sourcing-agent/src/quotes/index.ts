// agents/sourcing-agent/src/quotes/index.ts
// The quote fan-out of the Sourcing Agent (use case 3, supplier bid evaluation): it hires the invited bidders one after the other from the vault of the delegation, checks each quote in code, asks the model through a
// port whether to accept it, accepts or does not accept, and, when the model does not accept a quote because of a unit price, publishes the evidence and challenges the open claim of that bidder. Every source of
// data comes in through a port: this folder reads no file, no environment variable and no key, and it does not import the other folders of the agent.
//
//   ports     what the fan-out needs from outside (`QuotesDeps`), what it gets (`QuotesInput`), what it gives (`QuotesResult`), and the closed list of its codes
//   decide    the decision on the delivery of one bidder: the checks in code, and then the model
//   evidence  the challenge of a quote that the model did not accept
//   quotes    the loop over the bidders, and the outcome of each hire
export { QUOTE_CODES, QUOTE_HIRE_RESERVE_MS } from './ports.ts';
export type {
  AcceptQuoteAnswer, AcceptQuoteChoice, BidderStatus, BidderToHire, ExcludedWord, QuoteOutcome, QuoteRecord, QuotesDeps, QuotesInput, QuotesResult,
} from './ports.ts';
export { runQuotes } from './quotes.ts';
