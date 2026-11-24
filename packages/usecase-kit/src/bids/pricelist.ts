// packages/usecase-kit/src/bids/pricelist.ts
// The price list of a Bid Desk in use case 3 (supplier bid evaluation), the rule of the price, and the hash of the list. A Bid Desk prices a request from its list. It serves the list as bytes, and its
// manifest holds the SHA-256 of those bytes. The Sourcing Agent reads the list and checks each unit price of a quote against it, so the list is public. So `priceListSha256` hashes the text as it is served
// and writes no canonical form.
//
// A list holds 1 to 200 entries, one for each SKU. An entry holds the lead time of the SKU in days, from 0 to 365, and 1 to 8 breaks. A break gives the unit price from a minimum quantity: the first
// minimum is 1, the next ones rise, and the unit price is a whole number from 1 to 1,000,000. The numbers are numbers of the list and carry no unit of account.
// The rule of the price: the unit price of a quantity is the price of the break with the greatest minimum that is not above the quantity (`priceFor`). A quantity that is on a minimum takes that break.
//
// A parser of this folder reads its input with `parseDocument` of the protocol: each member is read one time as data, the copy is a new plain object, and an accessor, the key `__proto__` and a member
// that is not listed are refused. Each text is checked as it is written, and a text that passes is ASCII, so it is in the NFC form already. The detail of a refusal names the field and never repeats
// the value.
import { createHash } from 'node:crypto';
import { accepted, checkMembers, parseDocument, refused } from '../protocol/index.ts';
import type { Digest, JsonValue, ProtocolResult } from '../protocol/index.ts';
import { isList, objectOf, parseQuantity, parseSku, parseWhole, valuesOf } from './ids.ts';

export const PRICE_LIST_SCHEMA = 'vector.usecase.price-list.v1';

/** The most entries that a list holds, the most breaks of an entry, the longest lead time and the highest unit price. */
const MAX_ENTRIES = 200;
const MAX_BREAKS = 8;
const MAX_LEAD_TIME_DAYS = 365;
const MAX_UNIT_PRICE = 1_000_000;

/** The unit price from a minimum quantity. */
export interface PriceBreak {
  readonly min_quantity: number;
  readonly unit_price: number;
}

/** The prices of one SKU: its lead time in days, and its breaks from the smallest minimum quantity to the largest. */
export interface PriceEntry {
  readonly sku: string;
  readonly lead_time_days: number;
  readonly breaks: readonly PriceBreak[];
}

/** The price list of a Bid Desk: one entry for each SKU. */
export interface PriceList {
  readonly schema: typeof PRICE_LIST_SCHEMA;
  readonly items: readonly PriceEntry[];
}

function parseBreak(value: JsonValue, field: string): ProtocolResult<PriceBreak> {
  const step = objectOf(value, field);
  if (!step.ok) return step;
  const members = checkMembers(step.value, field, ['min_quantity', 'unit_price']);
  if (members !== null) return members;
  const minimum = parseQuantity(step.value.min_quantity, `${field}.min_quantity`);
  if (!minimum.ok) return minimum;
  const price = parseWhole(step.value.unit_price, `${field}.unit_price`, 1, MAX_UNIT_PRICE);
  if (!price.ok) return price;
  return accepted({ min_quantity: minimum.value, unit_price: price.value });
}

function parseEntry(value: JsonValue, field: string): ProtocolResult<PriceEntry> {
  const entry = objectOf(value, field);
  if (!entry.ok) return entry;
  const members = checkMembers(entry.value, field, ['sku', 'lead_time_days', 'breaks']);
  if (members !== null) return members;
  const sku = parseSku(entry.value.sku, `${field}.sku`);
  if (!sku.ok) return sku;
  const lead = parseWhole(entry.value.lead_time_days, `${field}.lead_time_days`, 0, MAX_LEAD_TIME_DAYS);
  if (!lead.ok) return lead;
  const list = entry.value.breaks;
  if (!isList(list)) return refused('bad_shape', `${field}.breaks must be a list`);
  if (list.length < 1 || list.length > MAX_BREAKS) return refused('bad_shape', `${field}.breaks must have 1 to ${MAX_BREAKS} breaks`);
  const breaks = valuesOf(Array.from(list, (step, index) => parseBreak(step, `${field}.breaks[${index}]`)));
  if (!breaks.ok) return breaks;
  if (breaks.value[0]!.min_quantity !== 1) return refused('bad_shape', `${field}.breaks[0].min_quantity must be 1`);
  for (let index = 1; index < breaks.value.length; index += 1) {
    if (breaks.value[index]!.min_quantity <= breaks.value[index - 1]!.min_quantity) return refused('bad_shape', `${field}.breaks[${index}].min_quantity must be above the one before`);
  }
  return accepted({ sku: sku.value, lead_time_days: lead.value, breaks: breaks.value });
}

/**
 * A price list with exactly the members above, as a new plain object, or a refusal with the code `bad_shape`. A SKU is listed once, and the minimum quantities of the breaks of an entry start at 1
 * and rise from one break to the next. The parser takes the value that `JSON.parse` made from the text of the file. It does not hash anything: the hash of the list is the hash of its text
 * (`priceListSha256`).
 */
export function parsePriceList(value: unknown): ProtocolResult<PriceList> {
  const field = 'price list';
  const copy = parseDocument(value, field);
  if (!copy.ok) return copy;
  const members = checkMembers(copy.value, field, ['schema', 'items']);
  if (members !== null) return members;
  if (copy.value.schema !== PRICE_LIST_SCHEMA) return refused('bad_shape', `${field}.schema must be "${PRICE_LIST_SCHEMA}"`);
  const list = copy.value.items;
  if (!isList(list)) return refused('bad_shape', `${field}.items must be a list`);
  if (list.length < 1 || list.length > MAX_ENTRIES) return refused('bad_shape', `${field}.items must have 1 to ${MAX_ENTRIES} entries`);
  const entries = valuesOf(Array.from(list, (entry, index) => parseEntry(entry, `${field}.items[${index}]`)));
  if (!entries.ok) return entries;
  const seen = new Set<string>();
  for (const [index, entry] of entries.value.entries()) {
    if (seen.has(entry.sku)) return refused('bad_shape', `${field}.items[${index}].sku is in the list two times`);
    seen.add(entry.sku);
  }
  const parsed: PriceList = { schema: PRICE_LIST_SCHEMA, items: entries.value };
  return accepted(parsed);
}

/**
 * The unit price and the lead time of a quantity of a SKU, or null. The unit price is the price of the break with the greatest minimum quantity that is not above the quantity, whatever the order of the
 * breaks is: a quantity that is on a minimum takes that break, and a quantity above the last minimum takes the last break. The result is null for a SKU that the list does not list, for a quantity that is
 * below 1 or is not a whole number, and for a list that has no break at or below the quantity. The SKU is compared as it is written. A caller reads null as "no listed price", and never as a price of 0.
 */
export function priceFor(list: PriceList, sku: string, quantity: number): { unit_price: number; lead_time_days: number } | null {
  if (!Number.isInteger(quantity) || quantity < 1) return null;
  const entry = list.items.find((candidate) => candidate.sku === sku);
  if (entry === undefined) return null;
  let found: PriceBreak | null = null;
  for (const step of entry.breaks) {
    if (step.min_quantity <= quantity && (found === null || step.min_quantity > found.min_quantity)) found = step;
  }
  return found === null ? null : { unit_price: found.unit_price, lead_time_days: entry.lead_time_days };
}

/** The SHA-256 of the bytes of the price list as the Bid Desk serves them: the UTF-8 bytes of the text, as 64 lower-case hex characters. The manifest holds this hash. */
export function priceListSha256(text: string): Digest {
  if (typeof text !== 'string') throw new TypeError('the text of a price list must be a string');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
