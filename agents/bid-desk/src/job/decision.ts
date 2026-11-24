// agents/bid-desk/src/job/decision.ts
// The model decision of the Bid Desk, `quote` (use case 3, supplier bid evaluation). The model reads the request for quotation and the entries of the price list for its SKUs, and it prices the request: one
// line for each item that the list carries, with the SKU, the quantity of the item, the unit price of the break that holds for that quantity, and the lead time of the SKU. It also gives the date until which
// the quote holds, and one short note. The Bid Desk gives the model's unit prices as they are: no code clamps, adds, removes or computes a price again. The line totals, the total and the longest lead time are
// arithmetic, and `quoteTotals` of the kit makes them.
//
// The decision has three parts: the fixed text of its prompt, the function that makes its input, and the parser of its choice. The fixed text is code. It holds no text of another party and no mark of the
// input block. The prompt rules of the decision folder of the kit already ask for one JSON object and nothing else, so the fixed text only says what the data holds and what shape `choice` has.
//
// What the model reads of another party is structured: the date of today, the items of the request (SKUs, whole numbers and a date) and the entries of the price list for those SKUs. The whole price list
// never goes to the model. A SKU that the list does not carry is not in `price_list`, and the instruction says that the model leaves such an item out of `lines` and names it in `notes`. The identifier of the
// request, the sender and every other member of the message stay out.
//
// A parser checks the SHAPE of a choice and the limits that a quote holds, and no rule that needs the request. It returns the value that it was given, or a refusal: it never clamps, fills in or changes a
// value. The limits are the limits of `parseQuote` of the kit: a unit price from 1 to 1,000,000, a lead time from 0 to 365 days, a quantity from 1 to the largest quantity of an item, 20 lines at most, a date
// that exists, and notes of at most 500 characters with no hidden character. So a choice that this parser takes can be the line of a quote, and the job never ends `internal` for a choice. The job checks the
// rules that need the request: at least one line, each line an item of the request, each SKU once. A refusal of a parser is `model_output_invalid` in the decision folder of the kit.
import { MAX_ITEM_QUANTITY, MAX_RFQ_ITEMS, parseSku } from '@vsa/usecase-kit/bids';
import type { PriceList, RfqDocument } from '@vsa/usecase-kit/bids';
import type { ChoiceParser, DecisionSpec } from '@vsa/usecase-kit/decision';
import { accepted, checkMembers, isPlainObject, refused } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';

/**
 * What the model chooses for `quote`: the lines of the quote, the date until which it holds, and a note. A line has the four members that the model chooses: the line total is arithmetic and is not one of
 * them. It is a type alias, so that it is JSON data.
 */
export type QuoteChoice = { lines: { sku: string; quantity: number; unit_price: number; lead_time_days: number }[]; valid_until: string; notes: string };

const INSTRUCTION = [
  'You price one request for quotation from the price list of a supplier.',
  'The data has three members.',
  '"today" is the date of today, as YYYY-MM-DD.',
  '"request" is the request of the buyer.',
  'It has "items" (each item has "sku" and "quantity", a whole number of units) and "needed_by" (the date by which the buyer needs the goods, as YYYY-MM-DD).',
  '"price_list" holds the entries of the price list for the SKUs of the items.',
  'Each entry has "sku", "lead_time_days" (the days from an order to its delivery) and "breaks".',
  'Each break has "min_quantity" and "unit_price".',
  'The unit price of a quantity is the "unit_price" of the break with the greatest "min_quantity" that is not above the quantity.',
  'Give one line for each item that the price list carries.',
  'A line has the "sku" and the "quantity" of the item, the "unit_price" of the break that holds for that quantity, and the "lead_time_days" of the entry of that SKU.',
  'The "quantity", the "unit_price" and the "lead_time_days" of a line are whole numbers.',
  'Leave an item that the price list does not carry out of "lines", and name it in "notes".',
  '"choice" is an object with exactly three members: "lines" (the list of lines), "valid_until" (the last day on which the quote holds, as YYYY-MM-DD, and a date after "today") and "notes" (one short sentence).',
].join(' ');

// The limits of a line and of the notes. They are the limits of `parseQuote` of the kit, and a test holds each of them to that parser.
const MAX_UNIT_PRICE = 1_000_000;
const MAX_LEAD_TIME_DAYS = 365;
const MAX_NOTES_CHARS = 500;
/** The characters that the notes of a quote never hold: control, format, separator and lone surrogate characters, and the default ignorable characters. A reader cannot see them. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LINE_MEMBERS = ['sku', 'quantity', 'unit_price', 'lead_time_days'] as const;

/**
 * True for a calendar date as `YYYY-MM-DD` that exists. The year is 0100 or later: `Date.UTC` reads a year from 0 to 99 as a year of the twentieth century, and the kit refuses such a date for the same
 * reason.
 */
function isDay(value: unknown): value is string {
  const parts = typeof value === 'string' ? DATE.exec(value) : null;
  if (parts === null) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

/** True for a whole number from `min` to `max`. A text, a fraction, NaN, infinity and a number that a number cannot hold exactly are not. */
const isWhole = (value: unknown, min: number, max: number): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** True for the notes that a quote can hold: at most 500 characters in the text and in its NFC form, and no hidden character in the NFC form. NFC can make a text longer, and the quote keeps the NFC form. */
function isNotes(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_NOTES_CHARS) return false;
  const copy = value.normalize('NFC');
  return copy.length <= MAX_NOTES_CHARS && !HIDDEN.test(copy);
}

const parseQuoteChoice: ChoiceParser<QuoteChoice> = (given) => {
  if (!isPlainObject(given)) return refused('bad_shape', 'choice must be a JSON object');
  const members = checkMembers(given, 'choice', ['lines', 'valid_until', 'notes']);
  if (members !== null) return members;
  const { lines, valid_until: validUntil, notes } = given;
  if (!Array.isArray(lines) || lines.length > MAX_RFQ_ITEMS) return refused('bad_shape', `choice.lines must be a list of at most ${MAX_RFQ_ITEMS} lines`);
  for (const [index, line] of lines.entries()) {
    const field = `choice.lines[${index}]`;
    if (!isPlainObject(line)) return refused('bad_shape', `${field} must be a JSON object`);
    const lineMembers = checkMembers(line, field, LINE_MEMBERS);
    if (lineMembers !== null) return lineMembers;
    const sku = parseSku(line.sku, `${field}.sku`);
    if (!sku.ok) return sku;
    if (!isWhole(line.quantity, 1, MAX_ITEM_QUANTITY)) return refused('bad_shape', `${field}.quantity must be a whole number from 1 to ${MAX_ITEM_QUANTITY}`);
    if (!isWhole(line.unit_price, 1, MAX_UNIT_PRICE)) return refused('bad_shape', `${field}.unit_price must be a whole number from 1 to ${MAX_UNIT_PRICE}`);
    if (!isWhole(line.lead_time_days, 0, MAX_LEAD_TIME_DAYS)) return refused('bad_shape', `${field}.lead_time_days must be a whole number from 0 to ${MAX_LEAD_TIME_DAYS}`);
  }
  // The date must exist. The parser does not hold it to a date after today: the prompt asks for that, and the model decides.
  if (!isDay(validUntil)) return refused('bad_shape', 'choice.valid_until must be a date that exists, as YYYY-MM-DD');
  if (!isNotes(notes)) {
    return refused('bad_shape', `choice.notes must be a text of at most ${MAX_NOTES_CHARS} characters with no control, format, separator, surrogate or default ignorable character`);
  }
  // The members are checked, and the value that the model gave goes back as it is.
  return accepted(given as QuoteChoice);
};

/** The decision `quote`. */
export const QUOTE_DECISION: DecisionSpec<QuoteChoice> = Object.freeze({ name: 'quote', instruction: INSTRUCTION, parse: parseQuoteChoice });

/**
 * The input of `quote`: the date of today, the items and the date of the request, and the entries of the price list for the SKUs of the items, in the order of the items. An entry has its SKU, its lead time
 * and its breaks. A SKU that the list does not carry is not in `price_list`, and the item stays in the request. The result is a copy, so a change of the input cannot change the request or the list.
 * `today` is a date as `YYYY-MM-DD` that exists, and the caller makes it from its clock. A `today` that is not such a date is a mistake of the caller, and it is a `TypeError` that never repeats the value.
 */
export function quoteInput(rfq: RfqDocument, list: PriceList, today: string): JsonValue {
  if (!isDay(today)) throw new TypeError('quoteInput: today must be a date that exists, as YYYY-MM-DD');
  const entries = rfq.items.flatMap(({ sku }) => {
    const entry = list.items.find((candidate) => candidate.sku === sku);
    return entry === undefined
      ? []
      : [{ sku: entry.sku, lead_time_days: entry.lead_time_days, breaks: entry.breaks.map((step) => ({ min_quantity: step.min_quantity, unit_price: step.unit_price })) }];
  });
  return {
    today,
    request: { items: rfq.items.map(({ sku, quantity }) => ({ sku, quantity })), needed_by: rfq.needed_by },
    price_list: entries,
  };
}
