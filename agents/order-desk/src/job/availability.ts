// agents/order-desk/src/job/availability.ts
// The model decision of the Order Desk, `availability` (use case 1, inventory reorder). The model reads the purchase order and the entry of the catalogue of the supplier. It says whether the supplier can
// supply the order, by which date it ships, and why. The Order Desk places the order only when the model says yes, and nothing in this agent overrides the model.
//
// The decision has three parts: the fixed text of its prompt, the function that makes its input, and the parser of its choice. The fixed text is code. It holds no text of another party and no mark of the
// input block. The prompt rules of the decision folder of the kit already ask for one JSON object and nothing else, so the fixed text only says what the data holds and what shape `choice` has. The input is
// JSON data in one marked block, and the kit writes it so that no text in it can close the block. The entry of the catalogue holds one free text (the description of the item), and it stays data.
//
// A parser checks the SHAPE of a choice and no business rule. It returns the value that it was given, or a refusal: it never clamps, fills in or changes a value. A refusal of the parser is
// `model_output_invalid` in the decision folder of the kit. The date `ship_by` is a date that exists in every answer, also when the model does not confirm, so that a model that says no still gives an
// answer of the one shape.
import type { ChoiceParser, DecisionSpec } from '@vsa/usecase-kit/decision';
import type { PurchaseOrder } from '@vsa/usecase-kit/inventory';
import { accepted, checkMembers, isPlainObject, refused } from '@vsa/usecase-kit/protocol';
import type { JsonObject, JsonValue } from '@vsa/usecase-kit/protocol';

/**
 * What the model chooses for `availability`: whether the supplier confirms the order, the date by which it ships, and a short note with the reason. It is a type alias, so that it is JSON data. On
 * `confirm: false` the Order Desk refuses the job and places no order.
 */
export type AvailabilityChoice = { confirm: boolean; ship_by: string; note: string };

const INSTRUCTION = [
  'You decide whether a supplier can supply one order.',
  'The data has two members.',
  '"purchase_order" is the order of the buyer.',
  'It has "sku" (the item), "lot" (the name of the lot), "quantity" (a whole number of units) and "needed_by" (the date by which the stock must arrive, as YYYY-MM-DD).',
  '"catalogue_entry" is the entry of the same item in the catalogue of the supplier.',
  'It has "available" (the units in stock), "discontinued" (true when the supplier no longer sells the item) and "ship_lead_days" (the days from an order to its shipment).',
  'Confirm only when the supplier holds at least the quantity of the order and the item is not discontinued.',
  '"choice" is an object with exactly three members: "confirm" (true or false), "ship_by" (the date by which the supplier ships the order, as YYYY-MM-DD, and not after "needed_by"; give a date also when you do not confirm) and "note" (one short sentence with your reason).',
].join(' ');

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True for a calendar date as `YYYY-MM-DD` that exists. The year is 0100 or later: `Date.UTC` reads a year from 0 to 99 as a year of the twentieth century, and the supplier portal refuses such a date for
 * the same reason.
 */
function isDay(value: unknown): value is string {
  const parts = typeof value === 'string' ? DATE.exec(value) : null;
  if (parts === null) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return year >= 100 && parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

const parseAvailabilityChoice: ChoiceParser<AvailabilityChoice> = (given) => {
  if (!isPlainObject(given)) return refused('bad_shape', 'choice must be a JSON object');
  const members = checkMembers(given, 'choice', ['confirm', 'ship_by', 'note']);
  if (members !== null) return members;
  const { confirm, ship_by: shipBy, note } = given;
  if (typeof confirm !== 'boolean') return refused('bad_shape', 'choice.confirm must be true or false');
  if (!isDay(shipBy)) return refused('bad_shape', 'choice.ship_by must be a date that exists, as YYYY-MM-DD');
  if (typeof note !== 'string') return refused('bad_shape', 'choice.note must be a text');
  // The members are checked, and the value that the model gave goes back as it is.
  return accepted(given as AvailabilityChoice);
};

/** The decision `availability`. */
export const AVAILABILITY_DECISION: DecisionSpec<AvailabilityChoice> = Object.freeze({ name: 'availability', instruction: INSTRUCTION, parse: parseAvailabilityChoice });

/**
 * The input of `availability`: the purchase order as the job parsed it, and the entry of the catalogue as the portal gave it. The order is a copy with its ten members, so a change of the input cannot
 * change the order of the job. The two are data: the prompt of the kit writes them in one marked block.
 */
export function availabilityInput(order: PurchaseOrder, entry: JsonObject): JsonValue {
  return { purchase_order: { ...order }, catalogue_entry: entry };
}
