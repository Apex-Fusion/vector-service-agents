// agents/bid-desk/src/job/index.ts
// The job of the Bid Desk: what it does after the Claim of an escrow. `runQuote` takes the record of the checks, asks the model to price the request from the price list, checks the answer in code, makes the
// arithmetic, applies the fault `quote_off_price_list` when the switch says so, reads the book again, gets the credential of the desk, builds the quote, records the request and gives the quote. This folder
// imports the kit, the workspace packages and itself, and no other folder of the package: the service imports the folder, so an import the other way would make a cycle.
export { QUOTE_DECISION, quoteInput } from './decision.ts';
export type { QuoteChoice } from './decision.ts';
export { faultyPriceOf } from './fault.ts';
export type { BookPort, QuoteDeps, TakenChecks } from './ports.ts';
export { runQuote } from './quote.ts';
export { QUOTE_REFUSAL_STATUS, QuoteRefusal } from './refusal.ts';
export type { QuoteRefusalCode } from './refusal.ts';
