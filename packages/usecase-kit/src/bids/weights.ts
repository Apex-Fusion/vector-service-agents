// packages/usecase-kit/src/bids/weights.ts
// The four weights of a ranking in use case 3 (supplier bid evaluation): `price`, `lead_time`, `reliability` and `compliance`. The hirer gives them in the `propose` request. A scorer reads them, and the
// ranking document holds them, so the approver sees them. A weight is a number from 0 to 1 with at most 4 decimal places, and the four sum to exactly 1.
//
// The parser counts in whole units of 1/10,000. A weight is read as `Math.round(weight * 10_000)` units, and it must be the number that those units stand for: `weight === units / 10_000`. A number
// that passes the first step, and is not that number, has a decimal place that a unit cannot hold (0.5000000001 is 0.5 plus a part of a unit), and it is refused. The check is exact: `units / 10_000` is
// the correctly rounded number of the decimal, as `JSON.parse` is, so every weight of at most 4 decimal places passes, whatever the binary form is (`0.57 * 10_000` is 5699.999999999999). The sum of
// the four weights is the sum of their units, and it must be 10,000. A sum of floats never decides: 0.3, 0.3, 0.3 and 0.1 add up to 0.9999999999999999 in a program, and they are weights that pass.
// The parser reads each member one time as data and gives a new plain object, with the four members in the order of `WEIGHT_NAMES`. The detail of a refusal names the field and never repeats the value.
import { accepted, checkMembers, parseDocument, refused } from '../protocol/index.ts';
import type { ProtocolResult } from '../protocol/index.ts';
import { noNegativeZero } from './ids.ts';

/** The four weights of a ranking, in the order of the members of the document. */
export const WEIGHT_NAMES = ['price', 'lead_time', 'reliability', 'compliance'] as const;

/** The weights of a ranking: each from 0 to 1 with at most 4 decimal places, and the four sum to 1. */
export interface Weights {
  readonly price: number;
  readonly lead_time: number;
  readonly reliability: number;
  readonly compliance: number;
}

/** The units of a weight: a weight is a number of these. */
const UNITS = 10_000;

/** A weight and the whole units of 1/10,000 that it stands for, or a refusal. */
function parseWeight(value: unknown, field: string): ProtocolResult<{ readonly weight: number; readonly units: number }> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return refused('bad_shape', `${field} must be a number from 0 to 1`);
  const units = Math.round(value * UNITS);
  if (value !== units / UNITS) return refused('bad_shape', `${field} must have at most 4 decimal places`);
  return accepted({ weight: noNegativeZero(value), units });
}

/**
 * Weights with exactly the four members of `WEIGHT_NAMES`, as a new plain object, or a refusal with the code `bad_shape`. `field` is the name that the detail of a refusal gives to the weights: a
 * caller that reads the member of a request passes `request.weights`.
 */
export function parseWeights(value: unknown, field = 'weights'): ProtocolResult<Weights> {
  const copy = parseDocument(value, field);
  if (!copy.ok) return copy;
  const members = checkMembers(copy.value, field, WEIGHT_NAMES);
  if (members !== null) return members;
  const price = parseWeight(copy.value.price, `${field}.price`);
  if (!price.ok) return price;
  const leadTime = parseWeight(copy.value.lead_time, `${field}.lead_time`);
  if (!leadTime.ok) return leadTime;
  const reliability = parseWeight(copy.value.reliability, `${field}.reliability`);
  if (!reliability.ok) return reliability;
  const compliance = parseWeight(copy.value.compliance, `${field}.compliance`);
  if (!compliance.ok) return compliance;
  if (price.value.units + leadTime.value.units + reliability.value.units + compliance.value.units !== UNITS) return refused('bad_shape', `${field} must sum to 1`);
  return accepted({ price: price.value.weight, lead_time: leadTime.value.weight, reliability: reliability.value.weight, compliance: compliance.value.weight });
}
