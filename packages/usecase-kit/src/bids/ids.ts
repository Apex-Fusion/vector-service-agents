// packages/usecase-kit/src/bids/ids.ts
// The names of use case 3 (supplier bid evaluation), and the field rules that the documents of this folder share.
//
// The Sourcing Agent ranks the quotes of the bidders, and each bidder is a Bid Desk. The capability of the Sourcing Agent is `supplychain.rfq.evaluate.v1`, and the capability of a Bid Desk is
// `supplychain.rfq.quote.v1`. The `model` of the advert of each agent, and of every receipt that it signs, is the model name below.
//
// The field rules are the rules of the stores of the mock service: an identifier, a quantity and a date. A document that this folder takes is a document that the stores take, and no more. The inventory
// folder holds the same three rules for use case 1. The kit folders do not import each other, so the rules are written again here, and a test holds each of them to its twin.
// A parser of this folder reads its input with `parseDocument` of the protocol: each member is read one time as data, the copy is a new plain object, and an accessor, the key `__proto__` and a member
// that is not listed are refused. Each text is checked as it is written. A text that only the NFC form turns into a valid text, such as the Kelvin sign that NFC turns into the letter K, is refused. A
// text that passes is ASCII, so it is in the NFC form already. The detail of a refusal names the field and never repeats the value.
import { accepted, refused } from '../protocol/index.ts';
import type { Accepted, JsonObject, JsonValue, ProtocolResult, Refused } from '../protocol/index.ts';

/** The capability of the Sourcing Agent, and the capability of the Bid Desk. A job of the Sourcing Agent hires each Bid Desk, and a challenge names both. */
export const BID_CAPABILITIES = Object.freeze({ evaluate: 'supplychain.rfq.evaluate.v1', quote: 'supplychain.rfq.quote.v1' } as const);

/** The `model` of the advert of the Sourcing Agent and of every receipt that it signs. */
export const SOURCING_MODEL = 'sourcing-agent-v1';
/** The `model` of the advert of a Bid Desk and of every receipt that it signs. */
export const BID_DESK_MODEL = 'bid-desk-v1';

/** The most that an item of a request holds, and the most that a break of a price list holds. */
export const MAX_ITEM_QUANTITY = 1_000_000;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseId(value: unknown, field: string): ProtocolResult<string> {
  return typeof value === 'string' && ID.test(value)
    ? accepted(value)
    : refused('bad_shape', `${field} must be 1 to 64 characters: letters, digits, dot, hyphen and underscore, and it starts with a letter or a digit`);
}

/** A SKU: 1 to 64 letters, digits, dots, hyphens and underscores, and it starts with a letter or a digit. The check is on the text as it is written, so the Kelvin sign is refused. */
export function parseSku(value: unknown, field: string): ProtocolResult<string> {
  return parseId(value, field);
}

/** The identifier of a request for quotation, with the form of the request identifier of the sourcing record of the mock service: the form of a SKU. */
export function parseRfqId(value: unknown, field: string): ProtocolResult<string> {
  return parseId(value, field);
}

/** The number without the sign of zero: `-0` is `0`. JSON writes both as `0`, so a copy never holds a sign that the text of the document does not show. */
export const noNegativeZero = (value: number): number => (value === 0 ? 0 : value);

/** A whole number from `min` to `max`. A text, a fraction, NaN, infinity, a bigint and a number that a number cannot hold exactly are refused. The number minus zero is read as 0. */
export function parseWhole(value: unknown, field: string, min: number, max: number): ProtocolResult<number> {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? accepted(noNegativeZero(value))
    : refused('bad_shape', `${field} must be a whole number from ${min} to ${max}`);
}

/** A quantity: a whole number from 1 to MAX_ITEM_QUANTITY. */
export function parseQuantity(value: unknown, field: string): ProtocolResult<number> {
  return parseWhole(value, field, 1, MAX_ITEM_QUANTITY);
}

/**
 * A calendar date as `YYYY-MM-DD`. A date that does not exist, such as 2026-02-30, is refused. The year is 0100 or later: `Date.UTC` reads a year from 0 to 99 as a year of the twentieth century,
 * and the stores of the mock service refuse such a date for the same reason. Both take the same dates.
 */
export function parseDay(value: unknown, field: string): ProtocolResult<string> {
  const parts = typeof value === 'string' ? DATE.exec(value) : null;
  if (typeof value !== 'string' || parts === null) return refused('bad_shape', `${field} must be a date as YYYY-MM-DD`);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return refused('bad_shape', `${field} must be a date that exists`);
  return accepted(value);
}

const isObject = (value: JsonValue): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
/** True for a list. `Array.isArray` narrows a read-only list to `any[]`, so the guard names the type. */
export const isList = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

/** An object of a copy that a walk of the protocol made. The copy holds plain objects with their own members only. */
export function objectOf(value: JsonValue, field: string): ProtocolResult<JsonObject> {
  return isObject(value) ? accepted(value) : refused('bad_shape', `${field} must be a JSON object`);
}

/** The values of a list of results, or the first refusal of the list. The list is built with `Array.from`, which defines each index and runs no setter of a prototype. */
export function valuesOf<T>(results: readonly ProtocolResult<T>[]): ProtocolResult<readonly T[]> {
  const failed = results.find((result): result is Refused => !result.ok);
  if (failed !== undefined) return failed;
  return accepted(Array.from(results.filter((result): result is Accepted<T> => result.ok), (result) => result.value));
}
