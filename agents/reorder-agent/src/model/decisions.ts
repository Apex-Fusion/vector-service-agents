// agents/reorder-agent/src/model/decisions.ts
// The two model decisions of the Reorder Agent (use case 1, inventory reorder). `reorder` chooses a lot for a SKU. `accept_delivery` says whether the confirmation of the supplier names the SKU, the lot
// and the quantity of the purchase order. Each decision has three parts: the fixed text of its prompt, the function that makes its input, and the parser of its choice.
//
// The fixed text is code. It holds no text of another party and no mark of the input block. The prompt rules of the decision folder already ask for one JSON object and nothing else, so the fixed text
// only says what the data holds and what shape `choice` has. The input is JSON data in one marked block, and the decision folder writes it so that no text in it can close the block.
//
// What the model reads of another party is a number, a lot name or an identifier, and never free text:
//   - `reorder` reads the stock reading of the ERP and the three lot sizes of the SKU. The sizes come from the lots file of the supplier, after its hash and its shape were checked.
//   - `accept_delivery` reads the SKU, the lot and the quantity of the order and of the confirmation, and nothing else of either. The `decisions`, the `sender` and the `checks` of a confirmation never
//     reach the prompt. The agent checks the number and the hash of the order in code before it asks the model.
//
// A parser checks the SHAPE of a choice and no business rule. It returns the value that it was given, or a refusal: it never clamps, fills in or changes a value. The Order Desk refuses a quantity that is
// not the size of the lot, and the hirer reads the order before the approval. The parser of `accept_delivery` refuses an answer that contradicts itself: `accept` is true exactly when `mismatch` is empty.
// A refusal of a parser is `model_output_invalid` in the decision folder.
import { accepted, checkMembers, isPlainObject, refused } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { LOT_NAMES, isLotName } from '@vsa/usecase-kit/inventory';
import type { LotName, OrderConfirmation, PurchaseOrder } from '@vsa/usecase-kit/inventory';
import type { ChoiceParser, DecisionSpec } from '@vsa/usecase-kit/decision';
import type { StockReading } from './stock.ts';

// --- reorder ---------------------------------------------------------------------------------------------------------------------------------------

/** What the model chooses for `reorder`: a lot, the quantity of that lot, and the date by which the stock must arrive. It is a type alias, so that it is JSON data. */
export type ReorderChoice = { lot: LotName; quantity: number; needed_by: string };

const REORDER_INSTRUCTION = [
  'You decide how much of one SKU to order.',
  'The data has two members.',
  '"stock_reading" is the stock reading of the SKU: "on_hand" (the stock now), "threshold" (the stock level at which the SKU is reordered), "daily_usage" (the use each day), "lead_time_days" (the days from an order to its arrival) and "open_orders" (the orders that are still open).',
  '"lots" lists the three lots that the supplier sells for this SKU.',
  'Each entry has the name of the lot ("lot") and its size ("size").',
  'Choose exactly one lot.',
  '"choice" is an object with exactly three members: "lot" (the name of the lot that you choose, as the data writes it), "quantity" (a whole number: the size of that lot) and "needed_by" (the date by which the stock must arrive, as YYYY-MM-DD).',
].join(' ');

/** The most that an order holds, as in the purchase order store of the mock service. */
const MAX_QUANTITY = 1_000_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True for a calendar date as `YYYY-MM-DD` that exists. The year is 0100 or later: `Date.UTC` reads a year from 0 to 99 as a year of the twentieth century, and the purchase order store refuses such a
 * date for the same reason.
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

const parseReorderChoice: ChoiceParser<ReorderChoice> = (given) => {
  if (!isPlainObject(given)) return refused('bad_shape', 'choice must be a JSON object');
  const members = checkMembers(given, 'choice', ['lot', 'quantity', 'needed_by']);
  if (members !== null) return members;
  const { lot, quantity, needed_by: neededBy } = given;
  if (!isLotName(lot)) return refused('bad_shape', `choice.lot must be the name of a lot: ${LOT_NAMES.join(', ')}`);
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    return refused('bad_shape', `choice.quantity must be a whole number from 1 to ${MAX_QUANTITY}`);
  }
  if (!isDay(neededBy)) return refused('bad_shape', 'choice.needed_by must be a date that exists, as YYYY-MM-DD');
  // The members are checked, and the value that the model gave goes back as it is.
  return accepted(given as ReorderChoice);
};

/** The decision `reorder`. */
export const REORDER_DECISION: DecisionSpec<ReorderChoice> = Object.freeze({ name: 'reorder', instruction: REORDER_INSTRUCTION, parse: parseReorderChoice });

/**
 * The input of `reorder`: the six members of the stock reading, and the three lots of the SKU from the smallest to the largest, each with its name and its size. The members are copied by name, so no
 * other member of the reading reaches the prompt.
 */
export function reorderInput(reading: StockReading, lots: Record<LotName, number>): JsonValue {
  return {
    stock_reading: {
      sku: reading.sku,
      on_hand: reading.on_hand,
      threshold: reading.threshold,
      daily_usage: reading.daily_usage,
      lead_time_days: reading.lead_time_days,
      open_orders: reading.open_orders,
    },
    lots: LOT_NAMES.map((lot) => ({ lot, size: lots[lot] })),
  };
}

// --- accept_delivery -------------------------------------------------------------------------------------------------------------------------------

/** The values that the decision compares, and the only names that `mismatch` can hold. */
const MISMATCH_NAMES = ['sku', 'lot', 'quantity'] as const;
type MismatchName = (typeof MISMATCH_NAMES)[number];

/**
 * What the model chooses for `accept_delivery`: whether to accept the delivery, and the names of the values that differ. The list is closed to the three values that the claim of the Order Desk names. It
 * is a type alias, so that it is JSON data.
 */
export type AcceptChoice = { accept: boolean; mismatch: MismatchName[] };

const ACCEPT_INSTRUCTION = [
  'You decide whether to accept a delivery.',
  'The data has two members.',
  '"purchase_order" is the order that this agent placed.',
  '"confirmation" is what the supplier confirmed for it.',
  'Each member has the same three values: "sku" (the item), "lot" (the name of the lot) and "quantity" (a whole number).',
  'Compare the SKU, the lot and the quantity of the confirmation with those of the purchase order, one by one.',
  'Two values are equal only when they are exactly the same, letter for letter and digit for digit.',
  'Accept only when all three are equal.',
  '"choice" is an object with exactly two members: "accept" (true or false) and "mismatch" (a list of the values that differ: each of "sku", "lot" and "quantity" at most one time).',
  'When you accept, "mismatch" is an empty list.',
  'When you do not accept, "mismatch" names each value that differs, and it names at least one.',
].join(' ');

const isMismatchName = (value: unknown): value is MismatchName => typeof value === 'string' && (MISMATCH_NAMES as readonly string[]).includes(value);

const parseAcceptChoice: ChoiceParser<AcceptChoice> = (given) => {
  if (!isPlainObject(given)) return refused('bad_shape', 'choice must be a JSON object');
  const members = checkMembers(given, 'choice', ['accept', 'mismatch']);
  if (members !== null) return members;
  const { accept, mismatch } = given;
  if (typeof accept !== 'boolean') return refused('bad_shape', 'choice.accept must be true or false');
  if (!Array.isArray(mismatch) || mismatch.length > MISMATCH_NAMES.length) return refused('bad_shape', `choice.mismatch must be a list of at most ${MISMATCH_NAMES.length} names`);
  const seen = new Set<unknown>();
  for (const [index, name] of mismatch.entries()) {
    if (!isMismatchName(name)) return refused('bad_shape', `choice.mismatch[${index}] must be one of ${MISMATCH_NAMES.join(', ')}`);
    if (seen.has(name)) return refused('bad_shape', `choice.mismatch[${index}] is a name that the list has already`);
    seen.add(name);
  }
  // One rule of consistency: the answer accepts exactly when it names no value that differs. An answer that says both is not read as either.
  if (accept && mismatch.length > 0) return refused('bad_shape', 'choice accepts the delivery and also names a value that differs');
  if (!accept && mismatch.length === 0) return refused('bad_shape', 'choice does not accept the delivery and names no value that differs');
  return accepted(given as AcceptChoice);
};

/** The decision `accept_delivery`. */
export const ACCEPT_DECISION: DecisionSpec<AcceptChoice> = Object.freeze({ name: 'accept_delivery', instruction: ACCEPT_INSTRUCTION, parse: parseAcceptChoice });

/**
 * The input of `accept_delivery`: the SKU, the lot and the quantity of the purchase order, and the same three values of the confirmation. The six values are copied by name. No other member of either
 * document reaches the prompt: not the `decisions`, the `sender`, the `checks`, the number or the hash of the order, or any text of the counterparty.
 */
export function acceptInput(po: PurchaseOrder, confirmation: OrderConfirmation): JsonValue {
  return {
    purchase_order: { sku: po.sku, lot: po.lot, quantity: po.quantity },
    confirmation: { sku: confirmation.sku, lot: confirmation.lot, quantity: confirmation.quantity },
  };
}
