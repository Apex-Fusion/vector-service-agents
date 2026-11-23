// packages/usecase-kit/src/inventory/lots.ts
// The lot names of use case 1 (inventory reorder), the field rules that the three documents of this folder share, and the lots file of the Order Desk.
//
// A lot is one of three sizes of an order: `lot-small`, `lot-medium` and `lot-large`. The lots file gives the size of each lot for each SKU. The Order Desk serves the file as bytes, and the manifest of
// the agent holds the SHA-256 of those bytes. So `lotsFileSha256` hashes the text as it is served and writes no canonical form.
//
// The field rules are the rules of the purchase order store of the mock service: an identifier, a quantity and a date. A document that this folder takes is a document that the store takes, and no more.
// A parser reads its input with `parseDocument` of the protocol: each member is read one time as data, the copy is a new plain object, and an accessor, the key `__proto__` and a member that is not
// listed are refused. Each text is checked as it is written. A text that only the NFC form turns into a valid text, such as the Kelvin sign that NFC turns into the letter K, is refused. A text that
// passes is ASCII, so it is in the NFC form already. The detail of a refusal names the field and never repeats the value.
import { createHash } from 'node:crypto';
import { accepted, checkMembers, parseDocument, refused } from '../protocol/index.ts';
import type { Accepted, Digest, JsonObject, JsonValue, ProtocolResult, Refused } from '../protocol/index.ts';

/** The three lots of an order, from the smallest to the largest. The `model` of each advert of the Order Desk is one of them. */
export const LOT_NAMES = ['lot-small', 'lot-medium', 'lot-large'] as const;
export type LotName = (typeof LOT_NAMES)[number];

/** True for one of the three lot names. A name of the prototype, a name in capital letters and a value that is not a text are not lot names. */
export const isLotName = (value: unknown): value is LotName => typeof value === 'string' && (LOT_NAMES as readonly string[]).includes(value);

/** The most that an order holds, and the most that a lot holds. */
export const MAX_QUANTITY = 1_000_000;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** An identifier of a system: 1 to 64 letters, digits, dots, hyphens and underscores, and it starts with a letter or a digit. A SKU, a purchase order number and an order id have this form. */
export function parseId(value: unknown, field: string): ProtocolResult<string> {
  return typeof value === 'string' && ID.test(value)
    ? accepted(value)
    : refused('bad_shape', `${field} must be 1 to 64 characters: letters, digits, dot, hyphen and underscore, and it starts with a letter or a digit`);
}

/** A whole number from 1 to MAX_QUANTITY. A text, a fraction, zero, a negative number and a number that a number cannot hold exactly are refused. */
export function parseQuantity(value: unknown, field: string): ProtocolResult<number> {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_QUANTITY
    ? accepted(value)
    : refused('bad_shape', `${field} must be a whole number from 1 to ${MAX_QUANTITY}`);
}

/**
 * A calendar date as `YYYY-MM-DD`. A date that does not exist, such as 2026-02-30, is refused. The year is 0100 or later: `Date.UTC` reads a year from 0 to 99 as a year of the twentieth century,
 * and the purchase order store refuses such a date for the same reason. Both take the same dates.
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

// --- The lots file ----------------------------------------------------------------------------------------------------------------------------------------------------

export const LOTS_SCHEMA = 'vector.usecase.lots.v1';

/** The most SKUs that a lots file lists. */
const MAX_ITEMS = 200;

/** The lots file of an Order Desk: for each SKU, the size of each lot. One entry for each SKU. */
export interface LotsFile {
  readonly schema: typeof LOTS_SCHEMA;
  readonly items: readonly { readonly sku: string; readonly lots: Readonly<Record<LotName, number>> }[];
}

type LotsItem = LotsFile['items'][number];

function parseItem(value: JsonValue, field: string): ProtocolResult<LotsItem> {
  const item = objectOf(value, field);
  if (!item.ok) return item;
  const members = checkMembers(item.value, field, ['sku', 'lots']);
  if (members !== null) return members;
  const sku = parseId(item.value.sku, `${field}.sku`);
  if (!sku.ok) return sku;
  const sizes = objectOf(item.value.lots, `${field}.lots`);
  if (!sizes.ok) return sizes;
  const names = checkMembers(sizes.value, `${field}.lots`, LOT_NAMES);
  if (names !== null) return names;
  const small = parseQuantity(sizes.value['lot-small'], `${field}.lots.lot-small`);
  if (!small.ok) return small;
  const medium = parseQuantity(sizes.value['lot-medium'], `${field}.lots.lot-medium`);
  if (!medium.ok) return medium;
  const large = parseQuantity(sizes.value['lot-large'], `${field}.lots.lot-large`);
  if (!large.ok) return large;
  return accepted({ sku: sku.value, lots: { 'lot-small': small.value, 'lot-medium': medium.value, 'lot-large': large.value } });
}

/**
 * A lots file with its members as a new object: the schema, and 1 to 200 items with a SKU and three lot sizes each. A SKU is listed once, and a size is a whole number from 1 to 1,000,000, the most that
 * an order holds. The parser takes the value that `JSON.parse` made from the text of the file. It does not hash anything: the hash of the file is the hash of its text (`lotsFileSha256`).
 */
export function parseLotsFile(value: unknown): ProtocolResult<LotsFile> {
  const field = 'lots file';
  const copy = parseDocument(value, field);
  if (!copy.ok) return copy;
  const members = checkMembers(copy.value, field, ['schema', 'items']);
  if (members !== null) return members;
  if (copy.value.schema !== LOTS_SCHEMA) return refused('bad_shape', `${field}.schema must be "${LOTS_SCHEMA}"`);
  const list = copy.value.items;
  if (!isList(list)) return refused('bad_shape', `${field}.items must be a list`);
  if (list.length < 1 || list.length > MAX_ITEMS) return refused('bad_shape', `${field}.items must have 1 to ${MAX_ITEMS} items`);
  const read = valuesOf(Array.from(list, (entry, index) => parseItem(entry, `${field}.items[${index}]`)));
  if (!read.ok) return read;
  const seen = new Set<string>();
  for (const [index, item] of read.value.entries()) {
    if (seen.has(item.sku)) return refused('bad_shape', `${field}.items[${index}].sku is in the file two times`);
    seen.add(item.sku);
  }
  const file: LotsFile = { schema: LOTS_SCHEMA, items: read.value };
  return accepted(file);
}

/**
 * The size of a lot of a SKU, or null when the file does not list the SKU. A lot that is not a lot name has no size. The size is an own member of the lots of the item and a number: a member that a
 * prototype holds, and a value of another type, are no size. The file is read as it is: a SKU is compared as it is written.
 */
export function lotSizeOf(file: LotsFile, sku: string, lot: LotName): number | null {
  if (!isLotName(lot)) return null;
  const item = file.items.find((entry) => entry.sku === sku);
  if (item === undefined || !Object.hasOwn(item.lots, lot)) return null;
  const size: unknown = item.lots[lot];
  return typeof size === 'number' ? size : null;
}

/** The SHA-256 of the bytes of the lots file as the Order Desk serves them: the UTF-8 bytes of the text, as 64 lower-case hex characters. The manifest holds this hash. */
export function lotsFileSha256(text: string): Digest {
  if (typeof text !== 'string') throw new TypeError('the text of a lots file must be a string');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
