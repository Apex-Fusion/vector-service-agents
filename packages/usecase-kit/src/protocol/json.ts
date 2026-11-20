// packages/usecase-kit/src/protocol/json.ts
// JSON data that comes from outside. A document is a JSON object that a proposal or a request for quotation carries. Its digest must bind it, so the protocol takes only a value that JSON can
// hold, and refuses a value that the canonical form would write as another value:
//   - undefined, a function, a symbol, a bigint, and a number that is not finite: the canonical form drops them or writes them as null;
//   - an object that is not a plain object, a hole in an array, and a key that is a symbol or is not enumerable;
//   - the key `__proto__`, which the canonical form of the buyer code drops;
//   - a key that is a whole number, which JavaScript writes before the other keys, out of the order of the text;
//   - a key that is not in the NFC form: the canonical form of the buyer code sorts the keys as they are and then writes them in the NFC form, so the order of the text would depend on the form of the key;
//   - a value nested deeper than MAX_DOCUMENT_DEPTH, so that a hostile document cannot overflow the stack of a service.
// The checks are made on a value of any origin and never throw.
import { accepted, refused, type ProtocolResult } from './result.ts';
import { shown } from './text.ts';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
/** A JSON object that a proposal or a request for quotation carries. It is checked by parseDocument. */
export type Document = JsonObject;

/** The most levels of objects and arrays in a document. The outer object is level 1. A document of a use case is under 8 levels deep. */
export const MAX_DOCUMENT_DEPTH = 32;

const WHOLE_NUMBER_KEY = /^(?:0|[1-9][0-9]*)$/;

/** True for a plain object: made by an object literal, by JSON.parse, or with no prototype. An array, a date, a map and an object of a class are not. The members stay `unknown`: this checks the object, not its fields. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

type Step = string | number;
interface Problem {
  readonly path: readonly Step[];
  readonly what: string;
}

/** The longest path that a detail shows. A deeper path is shown by its end, so the member is named and the detail stays short. */
const MAX_PATH_TEXT = 120;

/** The path of a member as text: the field, then `.key` and `[index]`. A key comes from outside, so it is shown cut and in printable form. */
function pathText(field: string, path: readonly Step[]): string {
  const text = path.reduce<string>((built, step) => (typeof step === 'number' ? `${built}[${step}]` : `${built}.${shown(step)}`), field);
  return text.length <= MAX_PATH_TEXT ? text : `${field}...${text.slice(field.length + 3 - MAX_PATH_TEXT)}`;
}

function problemOf(value: unknown, depth: number, path: Step[]): Problem | null {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : { path: [...path], what: 'is not a finite number' };
  if (typeof value !== 'object') return { path: [...path], what: 'is not JSON data' };
  if (depth > MAX_DOCUMENT_DEPTH) return { path: [...path], what: `is nested deeper than ${MAX_DOCUMENT_DEPTH} levels` };
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) return { path: [...path, index], what: 'is a hole in an array' };
      path.push(index);
      const found = problemOf(value[index], depth + 1, path);
      path.pop();
      if (found !== null) return found;
    }
    return null;
  }
  if (!isPlainObject(value)) return { path: [...path], what: 'is not a plain object' };
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length) return { path: [...path], what: 'has a key that JSON cannot hold' };
  for (const key of keys) {
    if (key === '__proto__') return { path: [...path, key], what: 'is the key __proto__, which is not allowed' };
    if (WHOLE_NUMBER_KEY.test(key)) return { path: [...path, key], what: 'is a key that is a whole number, which is not allowed' };
    if (key !== key.normalize('NFC')) return { path: [...path, key], what: 'is a key that is not in the NFC form, which is not allowed' };
    path.push(key);
    const found = problemOf(value[key], depth + 1, path);
    path.pop();
    if (found !== null) return found;
  }
  return null;
}

/** A value that JSON can hold and that the canonical form writes without loss. The result holds the same value, not a copy. */
export function parseJsonValue(value: unknown, field = 'value'): ProtocolResult<JsonValue> {
  const found = problemOf(value, 1, []);
  // problemOf has walked every member, so the value is JSON data.
  return found === null ? accepted(value as JsonValue) : refused('bad_shape', `${pathText(field, found.path)} ${found.what}`);
}

/** A JSON object under the rules of parseJsonValue. The result holds the same object, not a copy. */
export function parseDocument(value: unknown, field = 'document'): ProtocolResult<Document> {
  if (!isPlainObject(value)) return refused('bad_shape', `${field} must be a JSON object`);
  const checked = parseJsonValue(value, field);
  return checked.ok ? accepted(value as Document) : checked;
}

/** The value in JSON text. Text that is not JSON gives a refusal and never an exception. The value that comes out is not yet checked: pass it to parseJsonValue or parseDocument, or to a parser of the protocol. */
export function parseJsonText(text: unknown, field = 'text'): ProtocolResult<unknown> {
  if (typeof text !== 'string') return refused('bad_shape', `${field} must be text`);
  try {
    return accepted<unknown>(JSON.parse(text));
  } catch {
    return refused('bad_shape', `${field} is not JSON`);
  }
}
