// packages/usecase-kit/src/bids/rfq.ts
// The request for quotation of use case 3 (supplier bid evaluation). The Sourcing Agent sends it to each bidder as the `rfq` object of a message of the protocol, and a Bid Desk reads it, prices it from its
// price list and returns a quote. The quote and the ranking both name the hash of the request, `rfq_sha256`, so the two agents and the approver talk about the same request.
//
// The parser takes what the sourcing record of the mock service takes for the identifier, and what the page of the Bid Desk says for the rest, and no more:
//   rfq_id      an identifier of 1 to 64 letters, digits, dots, hyphens and underscores, starting with a letter or a digit
//   items       1 to 20 items, and each SKU is listed once
//   sku         the same form as the identifier
//   quantity    a whole number from 1 to 1,000,000
//   needed_by   a date as YYYY-MM-DD that exists, and the year is 0100 or later
// A member is read one time as data. The result is a new plain object with its members in the order above. Each text is checked as it is written, and every form above is ASCII, so a text that passes is
// in the NFC form that the hash binds already. A text that only NFC turns into a valid text, such as the Kelvin sign that becomes the letter K, is refused. An accessor, the key `__proto__` and a
// member that is not listed are refused. The detail of a refusal names the field and never repeats the value.
import { accepted, canonicalSha256, checkMembers, parseDocument, refused } from '../protocol/index.ts';
import type { Digest, JsonValue, ProtocolResult } from '../protocol/index.ts';
import { isList, objectOf, parseDay, parseQuantity, parseRfqId, parseSku, valuesOf } from './ids.ts';

/** The most items that a request holds. */
export const MAX_RFQ_ITEMS = 20;

/** One line of a request: a SKU and the quantity that the buyer wants. */
export interface RfqItem {
  readonly sku: string;
  readonly quantity: number;
}

/** The request for quotation: its identifier, its items and the date by which the goods are needed. */
export interface RfqDocument {
  readonly rfq_id: string;
  readonly items: readonly RfqItem[];
  readonly needed_by: string;
}

function parseItem(value: JsonValue, field: string): ProtocolResult<RfqItem> {
  const item = objectOf(value, field);
  if (!item.ok) return item;
  const members = checkMembers(item.value, field, ['sku', 'quantity']);
  if (members !== null) return members;
  const sku = parseSku(item.value.sku, `${field}.sku`);
  if (!sku.ok) return sku;
  const quantity = parseQuantity(item.value.quantity, `${field}.quantity`);
  if (!quantity.ok) return quantity;
  return accepted({ sku: sku.value, quantity: quantity.value });
}

/**
 * A request for quotation with exactly the members above, as a new plain object, or a refusal with the code `bad_shape`. `field` is the name that the detail of a refusal gives to the request: a caller
 * that reads the object of a message passes `request.rfq`.
 */
export function parseRfqDocument(value: unknown, field = 'rfq'): ProtocolResult<RfqDocument> {
  const copy = parseDocument(value, field);
  if (!copy.ok) return copy;
  const members = checkMembers(copy.value, field, ['rfq_id', 'items', 'needed_by']);
  if (members !== null) return members;
  const id = parseRfqId(copy.value.rfq_id, `${field}.rfq_id`);
  if (!id.ok) return id;
  const list = copy.value.items;
  if (!isList(list)) return refused('bad_shape', `${field}.items must be a list`);
  if (list.length < 1 || list.length > MAX_RFQ_ITEMS) return refused('bad_shape', `${field}.items must have 1 to ${MAX_RFQ_ITEMS} items`);
  const items = valuesOf(Array.from(list, (entry, index) => parseItem(entry, `${field}.items[${index}]`)));
  if (!items.ok) return items;
  const seen = new Set<string>();
  for (const [index, item] of items.value.entries()) {
    if (seen.has(item.sku)) return refused('bad_shape', `${field}.items[${index}].sku is in the request two times`);
    seen.add(item.sku);
  }
  const neededBy = parseDay(copy.value.needed_by, `${field}.needed_by`);
  if (!neededBy.ok) return neededBy;
  return accepted({ rfq_id: id.value, items: items.value, needed_by: neededBy.value });
}

/**
 * The hash of a request: the SHA-256 of the canonical text of its copy, with no salt, as 64 lower-case hex characters. It is the `rfq_sha256` of a quote and of a ranking. A document that
 * `parseRfqDocument` refuses has no hash: the refusal names `rfq`. A caller that holds a copy of the parser gets the same hash as a caller that holds the input.
 */
export function rfqSha256(rfq: RfqDocument): ProtocolResult<Digest> {
  const checked = parseRfqDocument(rfq);
  return checked.ok ? canonicalSha256(checked.value, 'rfq') : checked;
}
