// agents/sourcing-agent/src/model/accept.ts
// The model decision `accept_quote` of the Sourcing Agent (use case 3, supplier bid evaluation). The model reads one quote and the published price list of its bidder, and it says whether the unit price of each
// line is the price that the list gives. The agent accepts the quote when it does, and it does not when a line differs: it publishes the evidence and it challenges the claim of the bidder. The comparison is
// the statement that the Bid Desk makes about its quotes, and the model compares nothing else.
//
// The fixed text is code. It holds no text of another party and no mark of the input block. The input is JSON data in one marked block, and the decision folder writes it so that no text in it can close the block.
// What the model reads is numbers and SKUs. The notes, the credential, the organisation, the sender, the checks and the decisions of a quote never reach the prompt, and neither does any other text that the
// bidder wrote. The agent checks in code, before it asks the model, that the quote answers the request, that it names the price list that was read, and that the bidder is the sender of the quote.
//
// A parser checks the SHAPE of a choice and no business rule. It returns the value that it was given, or a refusal: it never clamps, fills in or changes a value. The parser refuses an answer that contradicts
// itself: `accept` is true exactly when `mismatch` is empty. It does not know the lines of the quote, so the code that uses a choice checks that each SKU of `mismatch` is a line of the quote.
import { MAX_RFQ_ITEMS, parseSku } from '@vsa/usecase-kit/bids';
import type { PriceList, Quote, RfqDocument } from '@vsa/usecase-kit/bids';
import type { ChoiceParser, DecisionSpec } from '@vsa/usecase-kit/decision';
import { accepted, checkMembers, isPlainObject, refused } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { parseList } from './choice.ts';

/**
 * What the model chooses for `accept_quote`: whether to accept the quote, and the SKU of each line whose unit price differs from the published price. A quote has at most MAX_RFQ_ITEMS lines, and a line has one
 * SKU. It is a type alias, so that it is JSON data.
 */
export type AcceptQuoteChoice = { accept: boolean; mismatch: string[] };

const ACCEPT_QUOTE_INSTRUCTION = [
  'You decide whether to accept a quote.',
  'The data has three members.',
  '"request" has "items": the goods that the buyer asked for, each with "sku" and "quantity". It gives the context of the quote. Do not compare the quote with it.',
  '"quote" has "lines": the lines of the quote, each with "sku", "quantity", "unit_price" (a whole number) and "lead_time_days".',
  '"price_list" holds the entries of the published price list of the bidder for the SKUs of the quote lines. Each entry has "sku", "lead_time_days" and "breaks": a list of price breaks, each with "min_quantity" and "unit_price".',
  'The listed price of a line is the "unit_price" of the break of its SKU with the greatest "min_quantity" that is not above the "quantity" of the line.',
  'The only thing to compare is the unit price. For each line, compare its "unit_price" with its listed price. Two prices are equal only when they are the same number.',
  'A line whose SKU has no entry in "price_list" has no listed price, so its unit price differs.',
  'Do not compare the lead time, the quantity, the total or any other value.',
  '"choice" is an object with exactly two members: "accept" (true or false) and "mismatch" (a list of the "sku" of each line whose unit price differs from its listed price, each at most one time; an empty list when no line differs).',
  '"accept" is true exactly when "mismatch" is an empty list.',
].join(' ');

const parseAcceptQuoteChoice: ChoiceParser<AcceptQuoteChoice> = (given) => {
  if (!isPlainObject(given)) return refused('bad_shape', 'choice must be a JSON object');
  const members = checkMembers(given, 'choice', ['accept', 'mismatch']);
  if (members !== null) return members;
  const { accept } = given;
  if (typeof accept !== 'boolean') return refused('bad_shape', 'choice.accept must be true or false');
  const mismatch = parseList(given.mismatch, 'choice.mismatch', 0, MAX_RFQ_ITEMS, (entry, at) => parseSku(entry, at));
  if (!mismatch.ok) return mismatch;
  // One rule of consistency: the answer accepts exactly when it names no line that differs. An answer that says both is not read as either.
  if (accept && mismatch.value.length > 0) return refused('bad_shape', 'choice accepts the quote and also names a line that differs');
  if (!accept && mismatch.value.length === 0) return refused('bad_shape', 'choice does not accept the quote and names no line that differs');
  // The members are checked, and the value that the model gave goes back as it is.
  return accepted(given as AcceptQuoteChoice);
};

/** The decision `accept_quote`. */
export const ACCEPT_QUOTE_DECISION: DecisionSpec<AcceptQuoteChoice> = Object.freeze({ name: 'accept_quote', instruction: ACCEPT_QUOTE_INSTRUCTION, parse: parseAcceptQuoteChoice });

/**
 * The input of `accept_quote`: the items of the request, the SKU, the quantity, the unit price and the lead time of each line of the quote, and the entry of the price list for each SKU of the lines, in the order of
 * the lines. A SKU that the list does not list has no entry, and the instruction says what that means. The members are copied by name, so no other member of the quote reaches the prompt: not the notes, the
 * credential, the organisation, the sender, the checks, the decisions or the line totals. The input is a copy, so a later change of the quote or of the list cannot change it.
 */
export function acceptQuoteInput(rfq: RfqDocument, quote: Quote, list: PriceList): JsonValue {
  const entries: JsonValue[] = [];
  const seen = new Set<string>();
  for (const line of quote.lines) {
    if (seen.has(line.sku)) continue;
    seen.add(line.sku);
    const entry = list.items.find((candidate) => candidate.sku === line.sku);
    if (entry === undefined) continue;
    entries.push({
      sku: entry.sku,
      lead_time_days: entry.lead_time_days,
      breaks: entry.breaks.map((step) => ({ min_quantity: step.min_quantity, unit_price: step.unit_price })),
    });
  }
  return {
    request: { items: rfq.items.map((item) => ({ sku: item.sku, quantity: item.quantity })) },
    quote: { lines: quote.lines.map((line) => ({ sku: line.sku, quantity: line.quantity, unit_price: line.unit_price, lead_time_days: line.lead_time_days })) },
    price_list: entries,
  };
}
