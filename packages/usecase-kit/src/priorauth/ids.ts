// packages/usecase-kit/src/priorauth/ids.ts
// The small helpers that every parser of this folder uses: an identifier, a date, an object or a list of a copy, a text, the diagnosis codes of an order, and the rule "no entry twice". The first five
// (`parseId`, `parseDay`, `objectOf`, `isList` and `valuesOf`) are copies of the helpers of the inventory folder. A kit folder imports the protocol folder and no other folder, so each folder keeps its
// own. The files of this folder import them from here, and the index of the folder does not export them.
//
// The rules are the rules of the mock systems, so that a document that this folder takes is a document that the services take, and no more:
//   an identifier  1 to 64 letters, digits, dots, hyphens and underscores, starting with a letter or a digit. It is checked as it is written, so the Kelvin sign is refused.
//   a date         YYYY-MM-DD, a date that exists, with a year of 0100 or later.
//   a text         1 to `max` characters, counted in UTF-16 code units as the services count them, with no control character that the services refuse. The copy holds the text in the NFC form.
// A parser reads its input with `parseDocument` of the protocol, so a copy is a new plain object and each member was read one time as data. The detail of a refusal names the field and never repeats the value.
import { accepted, refused } from '../protocol/index.ts';
import type { Accepted, JsonObject, JsonValue, ProtocolResult, Refused } from '../protocol/index.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** The control characters that the mock systems refuse in a text: U+0000 to U+001F except the tab, the line feed and the carriage return, and U+007F. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** The most diagnosis codes of an order or of a request, and the most characters of one code. */
const MAX_DIAGNOSIS_CODES = 8;
const MAX_DIAGNOSIS_CODE_CHARS = 16;

/** An identifier of a system: 1 to 64 letters, digits, dots, hyphens and underscores, and it starts with a letter or a digit. An order id, a record id and a request number have this form. */
export function parseId(value: unknown, field: string): ProtocolResult<string> {
  return typeof value === 'string' && ID.test(value)
    ? accepted(value)
    : refused('bad_shape', `${field} must be 1 to 64 characters: letters, digits, dot, hyphen and underscore, and it starts with a letter or a digit`);
}

/**
 * A calendar date as `YYYY-MM-DD`. A date that does not exist, such as 2026-02-30, is refused. The year is 0100 or later: `Date.UTC` reads a year from 0 to 99 as a year of the twentieth century,
 * and the mock systems refuse such a date for the same reason. Both take the same dates.
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

/**
 * A text of 1 to `max` characters with no control character that the mock systems refuse. The characters are counted in UTF-16 code units, as the services count them. The limit holds for the text as it
 * is written and for its NFC form, so a text that NFC makes longer than `max` is refused, and the copy that this gives is a text that this takes again. The copy is the text in the NFC form.
 */
export function parseText(value: unknown, field: string, max: number): ProtocolResult<string> {
  if (typeof value !== 'string') return refused('bad_shape', `${field} must be a text`);
  if (value.length < 1 || value.length > max) return refused('bad_shape', `${field} must have 1 to ${max} characters`);
  if (CONTROL.test(value)) return refused('bad_shape', `${field} must not hold a control character`);
  const form = value.normalize('NFC');
  if (form.length > max) return refused('bad_shape', `${field} must have 1 to ${max} characters in the NFC form`);
  return accepted(form);
}

/** A list of `min` to `max` entries of a copy. `read` takes an entry and the name of its place, `<field>[<index>]`. The result holds the values that `read` gives, or the first refusal. */
export function parseList<T>(value: JsonValue, field: string, min: number, max: number, read: (entry: JsonValue, field: string) => ProtocolResult<T>): ProtocolResult<readonly T[]> {
  if (!isList(value)) return refused('bad_shape', `${field} must be a list`);
  if (value.length < min || value.length > max) return refused('bad_shape', `${field} must have ${min === max ? min : `${min} to ${max}`} entries`);
  return valuesOf(Array.from(value, (entry, index) => read(entry, `${field}[${index}]`)));
}

/**
 * A refusal when two entries have the same key, and else null. The detail names the second entry, with `member` after its index, and never repeats the key. A key counts as it is written: two keys that
 * differ in case are two keys, as in the mock systems.
 */
export function checkUnique<T>(entries: readonly T[], field: string, key: (entry: T) => string, member = ''): Refused | null {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const name = key(entry);
    if (seen.has(name)) return refused('bad_shape', `${field}[${index}]${member} is in the list two times`);
    seen.add(name);
  }
  return null;
}

/** A list of `min` to `max` identifiers, none twice. A reference to a record or to a criterion has this form. */
export function parseIds(value: JsonValue, field: string, min: number, max: number): ProtocolResult<readonly string[]> {
  const ids = parseList(value, field, min, max, parseId);
  return ids.ok ? (checkUnique(ids.value, field, (id) => id) ?? ids) : ids;
}

/** The diagnosis codes of an order or of a request: 1 to 8 texts of 1 to 16 characters. The records system takes the same list, and it takes a code two times. */
export function parseDiagnosisCodes(value: JsonValue, field: string): ProtocolResult<readonly string[]> {
  return parseList(value, field, 1, MAX_DIAGNOSIS_CODES, (code, place) => parseText(code, place, MAX_DIAGNOSIS_CODE_CHARS));
}
