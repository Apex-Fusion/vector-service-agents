// packages/usecase-kit/src/bids/scores.ts
// The scores of use case 3 (supplier bid evaluation). The Sourcing Agent hires one scorer for each accepted quote. A scorer gives four component scores, one for each weight name (`price`,
// `lead_time`, `reliability` and `compliance`), and one score for the quote. Each is a finite number from 0 to 100. The ranking document holds them, so the approver sees every number.
//
// The parsers check the form and nothing else. The model decides the numbers: no code checks that the score follows from the components and the weights, and no code clamps a number that is out of range.
// A number outside 0 to 100 is refused, so a scorer that answers 101 fails and its answer never reaches a ranking. A parser reads its input with `parseDocument` of the protocol: each member is read one time
// as data, the copy is a new plain object, and an accessor, the key `__proto__` and a member that is not listed are refused. The detail of a refusal names the field and never repeats the value.
import { accepted, checkMembers, parseDocument, refused } from '../protocol/index.ts';
import type { ProtocolResult } from '../protocol/index.ts';
import { noNegativeZero } from './ids.ts';

/** The four component scores, in the order of the members. They are the four names of the weights. */
export const SCORE_COMPONENTS = ['price', 'lead_time', 'reliability', 'compliance'] as const;

/** The component scores of one quote, each from 0 to 100. */
export type Components = {
  readonly price: number;
  readonly lead_time: number;
  readonly reliability: number;
  readonly compliance: number;
};

/** The four component scores and the total for one quote. The type alias can also be used as JSON data. */
export type ScoreChoice = { readonly components: Components; readonly score: number };

/**
 * A score or a component score: a finite number from 0 to 100, or a refusal with the code `bad_shape`. A text, NaN, infinity, a bigint and a number outside the range are refused. The number minus zero
 * is read as 0: JSON writes both as `0`, so a copy never holds a sign that the text of the document does not show. `field` is the name that the detail of a refusal gives to the number.
 */
export function parseScoreValue(value: unknown, field = 'score'): ProtocolResult<number> {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? accepted(noNegativeZero(value)) : refused('bad_shape', `${field} must be a number from 0 to 100`);
}

/**
 * Component scores with exactly the four members of `SCORE_COMPONENTS`, as a new plain object with the members in that order, or a refusal with the code `bad_shape`. `field` is the name that the detail of a
 * refusal gives to the components: a caller that reads the member of an answer passes `answer.components`.
 */
export function parseComponents(value: unknown, field = 'components'): ProtocolResult<Components> {
  const copy = parseDocument(value, field);
  if (!copy.ok) return copy;
  const members = checkMembers(copy.value, field, SCORE_COMPONENTS);
  if (members !== null) return members;
  const price = parseScoreValue(copy.value.price, `${field}.price`);
  if (!price.ok) return price;
  const leadTime = parseScoreValue(copy.value.lead_time, `${field}.lead_time`);
  if (!leadTime.ok) return leadTime;
  const reliability = parseScoreValue(copy.value.reliability, `${field}.reliability`);
  if (!reliability.ok) return reliability;
  const compliance = parseScoreValue(copy.value.compliance, `${field}.compliance`);
  if (!compliance.ok) return compliance;
  return accepted({ price: price.value, lead_time: leadTime.value, reliability: reliability.value, compliance: compliance.value });
}

/** The shortest decimal text of a number from 0 to 100 reads as: digits, a fraction, and for a number below 0.000001 a negative exponent. */
const DECIMAL = /^(\d+)(?:\.(\d+))?(?:e-(\d+))?$/;

/**
 * 100 minus a score, exact in decimals. The score is read as its shortest decimal text (the text that `JSON.stringify` writes), the subtraction is made on the whole units of that text, and the result is the
 * number that its decimal text names: 80.2 gives 19.8, 0.1 gives 99.9, 0 gives 100 and 100 gives 0. A value that is not a number from 0 to 100 is a RangeError: a caller reverses a score that it checked.
 */
export function reversedOf(value: number): number {
  if (typeof value !== 'number' || !(value >= 0 && value <= 100)) throw new RangeError('a score is a number from 0 to 100');
  const parts = DECIMAL.exec(String(value));
  if (parts === null) throw new RangeError('a score has the decimal form of a number from 0 to 100');
  const [, whole = '', fraction = '', exponent = '0'] = parts;
  const places = fraction.length + Number(exponent);
  const rest = 100n * 10n ** BigInt(places) - BigInt(whole + fraction);
  const digits = rest.toString().padStart(places + 1, '0');
  return Number(places === 0 ? digits : `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`);
}

/** The choice with each of its four component scores and its score reversed. The members of the result are new, and the choice that it was given is not changed. */
export function reversedChoice(choice: ScoreChoice): ScoreChoice {
  const { price, lead_time: leadTime, reliability, compliance } = choice.components;
  return { components: { price: reversedOf(price), lead_time: reversedOf(leadTime), reliability: reversedOf(reliability), compliance: reversedOf(compliance) }, score: reversedOf(choice.score) };
}
