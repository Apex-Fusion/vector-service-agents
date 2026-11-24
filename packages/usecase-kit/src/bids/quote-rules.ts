// packages/usecase-kit/src/bids/quote-rules.ts
// The rules that tie a quote of use case 3 (supplier bid evaluation) to the request that it answers and to the price list that it was priced from. The Sourcing Agent runs them in code before its model reads
// any of the quote, so no model decides them. The parser of the quote checks its form and its arithmetic. It cannot know the request or the list, so a quote that passes `parseQuote` can still be a quote
// for another request, a quote with a line for an item that the request lacks, or a quote from another list. These rules see that.
//
//   checkQuoteAnswersRfq  the quote names the identifier and the hash of the request, and each line is the SKU and the quantity of an item of the request   (quote_not_for_rfq)
//   checkQuoteFromList    the quote names the hash of the price list that the agent read                                                                   (quote_not_from_list)
//   lineChecks            for each line, the unit price that the quote gives and the unit price that the list gives, so that an agent can find the line that breaks the list
//
// The checks take a quote that `parseQuote` made. They read nothing: no clock, no network, no file. They never throw for data. A value that is not a quote, a request that is not a request for quotation, and
// a hash that is not a digest are refused with the code of the rule, and no value is a pass because a member is missing. The quote is read from a copy that `parseDocument` makes (each member one time, as
// data), and a member that only a prototype holds is not read. The detail of a refusal names the member and never repeats a value.
//
// A request item that the quote leaves out is no fault: a Bid Desk may quote some of the items and say in its notes which ones it leaves out. The quantity of a line is the quantity of its item, and not a
// quantity that another item has.
import { accepted, isPlainObject, parseDigest, parseDocument, refused } from '../protocol/index.ts';
import type { Digest, ProtocolResult } from '../protocol/index.ts';
import { parseQuantity, parseRfqId, parseSku } from './ids.ts';
import { priceFor } from './pricelist.ts';
import type { PriceList } from './pricelist.ts';
import type { Quote } from './quote.ts';
import { parseRfqDocument, rfqSha256 } from './rfq.ts';
import type { RfqDocument } from './rfq.ts';

/** The member of a record that the record holds itself, or undefined. A member that only a prototype holds is not read, and the parser of the member refuses undefined. */
const own = (record: object, name: string): unknown => (Object.hasOwn(record, name) ? Reflect.get(record, name) : undefined);

/**
 * The quote answers the request. Three conditions, in this order, and the detail names the first that fails:
 *   1. `rfq_id` of the quote is the identifier of the request;
 *   2. `rfq_sha256` of the quote is the hash of the request (`rfqSha256`), so the quote is for this request object and not for another one with the same identifier;
 *   3. each line of the quote is the SKU and the quantity of one item of the request. The first line that is not names `sku` (the request has no such item) or `quantity` (the item has another quantity).
 * The request is read with `parseRfqDocument`, and a value that it refuses is refused here with the code `quote_not_for_rfq`. A quote with no line answers nothing, and it is refused too.
 */
export function checkQuoteAnswersRfq(quote: Quote, rfq: RfqDocument): ProtocolResult<null, 'quote_not_for_rfq'> {
  const request = parseRfqDocument(rfq);
  if (!request.ok) return refused('quote_not_for_rfq', `the request is not a request for quotation: ${request.detail}`);
  const requestSha = rfqSha256(request.value);
  if (!requestSha.ok) return refused('quote_not_for_rfq', `the request has no hash: ${requestSha.detail}`);
  const copy = parseDocument(quote, 'quote');
  if (!copy.ok) return refused('quote_not_for_rfq', copy.detail);
  const id = parseRfqId(own(copy.value, 'rfq_id'), 'quote.rfq_id');
  if (!id.ok) return refused('quote_not_for_rfq', id.detail);
  if (id.value !== request.value.rfq_id) return refused('quote_not_for_rfq', 'quote.rfq_id is not the rfq_id of the request');
  const named = parseDigest(own(copy.value, 'rfq_sha256'), 'quote.rfq_sha256');
  if (!named.ok) return refused('quote_not_for_rfq', named.detail);
  if (named.value !== requestSha.value) return refused('quote_not_for_rfq', 'quote.rfq_sha256 is not the hash of the request');
  const lines: unknown = own(copy.value, 'lines');
  if (!Array.isArray(lines) || lines.length < 1) return refused('quote_not_for_rfq', 'quote.lines must be a list of at least one line');
  // A map and not an object: a SKU such as `constructor` is no item of the request, and an object would answer for it with a member of its prototype.
  const quantities = new Map(request.value.items.map((item) => [item.sku, item.quantity] as const));
  for (const [index, line] of (lines as readonly unknown[]).entries()) {
    const at = `quote.lines[${index}]`;
    if (!isPlainObject(line)) return refused('quote_not_for_rfq', `${at} must be a JSON object`);
    const sku = parseSku(own(line, 'sku'), `${at}.sku`);
    if (!sku.ok) return refused('quote_not_for_rfq', sku.detail);
    const wanted = quantities.get(sku.value);
    if (wanted === undefined) return refused('quote_not_for_rfq', `${at}.sku is not the SKU of an item of the request`);
    const quantity = parseQuantity(own(line, 'quantity'), `${at}.quantity`);
    if (!quantity.ok) return refused('quote_not_for_rfq', quantity.detail);
    if (quantity.value !== wanted) return refused('quote_not_for_rfq', `${at}.quantity is not the quantity of the item of the request`);
  }
  return accepted(null);
}

/**
 * The quote was priced from the price list that the agent read: `price_list_sha256` of the quote is `listSha256`, the hash of the bytes of that list (`priceListSha256` of the text that the Bid Desk served).
 * Both hashes must be digests. A hash that is missing, or is not a digest, is refused, so two values that are missing or are no digests never pass because they are equal.
 */
export function checkQuoteFromList(quote: Quote, listSha256: Digest): ProtocolResult<null, 'quote_not_from_list'> {
  const read = parseDigest(listSha256, 'the hash of the price list');
  if (!read.ok) return refused('quote_not_from_list', read.detail);
  const copy = parseDocument(quote, 'quote');
  if (!copy.ok) return refused('quote_not_from_list', copy.detail);
  const named = parseDigest(own(copy.value, 'price_list_sha256'), 'quote.price_list_sha256');
  if (!named.ok) return refused('quote_not_from_list', named.detail);
  if (named.value !== read.value) return refused('quote_not_from_list', 'quote.price_list_sha256 is not the hash of the price list that was read');
  return accepted(null);
}

/** The check of one line of a quote: its SKU and quantity, the unit price that the quote gives, and the unit price that the price list gives for that SKU and quantity. */
export interface LineCheck {
  readonly sku: string;
  readonly quantity: number;
  readonly quoted_unit_price: number;
  /** The unit price of the list for the SKU and the quantity, or null when the list gives none: a SKU that it does not list. A caller reads null as "no listed price", and never as a price of 0. */
  readonly listed_unit_price: number | null;
}

/**
 * One check for each line of the quote, in the order of the lines. The listed unit price is the unit price that `priceFor` gives for the SKU and the quantity of the line. Only unit prices are
 * compared: the lead time of a line is not part of the claim of a Bid Desk about its price. The checks are new objects, and nothing of the quote or the list is changed.
 */
export function lineChecks(quote: Quote, list: PriceList): readonly LineCheck[] {
  return quote.lines.map((line) => {
    const listed = priceFor(list, line.sku, line.quantity);
    return { sku: line.sku, quantity: line.quantity, quoted_unit_price: line.unit_price, listed_unit_price: listed === null ? null : listed.unit_price };
  });
}
