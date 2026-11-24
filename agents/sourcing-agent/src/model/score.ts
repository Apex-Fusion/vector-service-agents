// agents/sourcing-agent/src/model/score.ts
// The model decision `score` of the Sourcing Agent (use case 3, supplier bid evaluation). A scorer reads one accepted quote and gives four component scores, one for each weight of the ranking, and one score for
// the quote. The agent hires one scorer for each accepted quote.
//
// The fixed text is code. It holds no text of another party and no mark of the input block. The input is JSON data in one marked block, and the decision folder writes it so that no text in it can close the
// block. What the model reads: the date of today, the weights, the request, the lines and the totals of the quote, the facts of the file of the bidder (see bidder.ts), and the entry of the vendor master for the
// bidder. The entry of the vendor master holds two free texts, its name and its certifications. They are data, and they stay in the data block: they are never part of the fixed text. The notes and the
// credential of the quote never reach the prompt, and neither does any other text that the bidder wrote. The caller chooses the entry in code: it is the entry whose organisation is the verified organisation of
// the bidder, and it is null when there is none.
//
// The caller makes `today` from its clock, and this folder reads no clock. The prompt gives the date to the model, and the parser of the choice does not hold the choice to any date.
//
// A parser checks the SHAPE of a choice and no business rule. It returns the value that it was given, or a refusal: it never clamps, fills in or changes a value. A number outside 0 to 100 is refused. No code
// checks that the score follows from the four parts and the weights: the model decides the numbers. A refusal of a parser is `model_output_invalid` in the decision folder.
import { parseComponents, parseScoreValue } from '@vsa/usecase-kit/bids';
import type { Components, Quote, RfqDocument, Weights } from '@vsa/usecase-kit/bids';
import type { ChoiceParser, DecisionSpec } from '@vsa/usecase-kit/decision';
import { accepted, checkMembers, isPlainObject, refused } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { BIDDER_FILE_TEXT, bidderFacts } from './bidder.ts';
import type { BidderFile } from './bidder.ts';

/** The four component scores with the members of `Components`, as a type of plain members, so that the choice is JSON data. */
type ScoreComponents = { -readonly [Name in keyof Components]: Components[Name] };

/** What the model chooses for `score`: the four component scores and the score of the quote, each from 0 to 100. It is a type alias, so that it is JSON data. */
export type ScoreChoice = { components: ScoreComponents; score: number };

/**
 * An entry of the vendor master: what the buyer knows of a vendor. `name` and `certifications` are free texts of the vendor master. The reader of the vendor master writes the same shape in its own folder, and
 * the wiring is where the two meet.
 */
export interface VendorEntry {
  readonly vendor_id: string;
  readonly organisation: string;
  readonly name: string;
  readonly on_time_delivery_rate: number;
  readonly defect_rate: number;
  readonly years_as_vendor: number;
  readonly payment_terms_days: number;
  readonly certifications: readonly string[];
  readonly last_audit: string;
}

/** The parts of the input of `score`. */
export interface ScoreParts {
  /** The date of today, as `YYYY-MM-DD`. The caller makes it from its clock. */
  readonly today: string;
  readonly weights: Weights;
  readonly rfq: RfqDocument;
  readonly quote: Quote;
  /** The file of the bidder that sent the quote. */
  readonly file: BidderFile;
  /** The entry of the vendor master for the bidder, or null when there is none. */
  readonly vendor: VendorEntry | null;
}

const SCORE_INSTRUCTION = [
  'You score one quote of one bidder.',
  'The data has eight members.',
  '"today" is the date of today, as YYYY-MM-DD.',
  '"weights" has four numbers that sum to 1: "price", "lead_time", "reliability" and "compliance". They say how much each part counts for the buyer.',
  '"request" has "items" (the goods that the buyer wants, each with "sku" and "quantity") and "needed_by" (the date by which the goods are needed, as YYYY-MM-DD).',
  '"quote" has "lines" (each with "sku", "quantity", "unit_price", "line_total" and "lead_time_days"), "total" (the sum of the line totals), "lead_time_days" (the longest lead time of the lines) and "valid_until" (the last day on which the quote holds, as YYYY-MM-DD).',
  '"lines_quoted" is the number of lines of the quote. "items_requested" is the number of items of the request.',
  '"bidder" is the file of the bidder.',
  BIDDER_FILE_TEXT,
  '"vendor" is the entry of the vendor master for the bidder, or null when the master has none.',
  'An entry has "vendor_id", "organisation", "name" and "certifications" (a list of texts), "on_time_delivery_rate" and "defect_rate" (numbers from 0 to 1), "years_as_vendor" and "payment_terms_days" (whole numbers) and "last_audit" (a date).',
  'Give a score from 0 to 100 for each of the four parts, and a score for the quote. A higher number is better.',
  '"price" is how good the total price is for what the quote covers.',
  '"lead_time" is how well the lead time of the quote meets "needed_by", counted from "today".',
  '"reliability" is how reliable the bidder is: read the vendor entry, the stake and the open cases.',
  '"compliance" is how well the bidder meets the compliance facts: read the attestation, the credential and the state of the record.',
  'When "vendor" is null, the master has no record of the bidder: judge "reliability" on the other facts, and do not invent a record.',
  '"choice" is an object with exactly two members: "components" (an object with exactly four members, "price", "lead_time", "reliability" and "compliance", each a number from 0 to 100) and "score" (one number from 0 to 100 for the whole quote, which weighs the four components by "weights").',
].join(' ');

const parseScoreChoice: ChoiceParser<ScoreChoice> = (given) => {
  if (!isPlainObject(given)) return refused('bad_shape', 'choice must be a JSON object');
  const members = checkMembers(given, 'choice', ['components', 'score']);
  if (members !== null) return members;
  const components = parseComponents(given.components, 'choice.components');
  if (!components.ok) return components;
  const score = parseScoreValue(given.score, 'choice.score');
  if (!score.ok) return score;
  // The members are checked, and the value that the model gave goes back as it is.
  return accepted(given as ScoreChoice);
};

/** The decision `score`. */
export const SCORE_DECISION: DecisionSpec<ScoreChoice> = Object.freeze({ name: 'score', instruction: SCORE_INSTRUCTION, parse: parseScoreChoice });

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True for a calendar date as `YYYY-MM-DD` that exists. The year is 0100 or later: `Date.UTC` reads a year from 0 to 99 as a year of the twentieth century, so the date that it builds has another year, and the
 * comparison below refuses it. The stores of the mock service refuse such a date for the same reason.
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

/**
 * The input of `score`: `today`, the four weights, the items and the date of the request, the lines and the totals of the quote, the two counts, the facts of the file of the bidder and the entry of the vendor
 * master, or null. The members are copied by name, so no other member of the quote reaches the prompt: not the notes, the credential, the organisation, the sender, the checks or the decisions. `today` is a date as
 * `YYYY-MM-DD` that exists, and the caller makes it from its clock. A `today` that is not such a date is a mistake of the caller, and it is a `TypeError` that never repeats the value. The input is a copy, so a
 * later change of a part cannot change it.
 */
export function scoreInput(parts: ScoreParts): JsonValue {
  const { today, weights, rfq, quote, file, vendor } = parts;
  if (!isDay(today)) throw new TypeError('scoreInput: today must be a date that exists, as YYYY-MM-DD');
  return {
    today,
    weights: { price: weights.price, lead_time: weights.lead_time, reliability: weights.reliability, compliance: weights.compliance },
    request: { items: rfq.items.map((item) => ({ sku: item.sku, quantity: item.quantity })), needed_by: rfq.needed_by },
    quote: {
      lines: quote.lines.map((line) => ({ sku: line.sku, quantity: line.quantity, unit_price: line.unit_price, line_total: line.line_total, lead_time_days: line.lead_time_days })),
      total: quote.total,
      lead_time_days: quote.lead_time_days,
      valid_until: quote.valid_until,
    },
    lines_quoted: quote.lines.length,
    items_requested: rfq.items.length,
    bidder: bidderFacts(file),
    vendor: vendor === null
      ? null
      : {
          vendor_id: vendor.vendor_id,
          organisation: vendor.organisation,
          name: vendor.name,
          on_time_delivery_rate: vendor.on_time_delivery_rate,
          defect_rate: vendor.defect_rate,
          years_as_vendor: vendor.years_as_vendor,
          payment_terms_days: vendor.payment_terms_days,
          certifications: vendor.certifications.map((text) => text),
          last_audit: vendor.last_audit,
        },
  };
}
