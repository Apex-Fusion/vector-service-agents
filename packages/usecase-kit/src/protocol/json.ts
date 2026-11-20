// packages/usecase-kit/src/protocol/json.ts
// JSON data that comes from outside, or from a program. A document is a JSON object that a proposal or a request for quotation carries. Its digest must bind it, so the protocol takes only a value
// that JSON can hold, and it refuses a value that the canonical form would write as another value:
//   - undefined, a function, a symbol, a bigint, and a number that is not finite;
//   - an object that is not a plain object, a hole in an array, a key that is a symbol or is not enumerable;
//   - an array that is not a plain array: an array with another prototype, or with a key that is not an index;
//   - an accessor member, because a getter can give another value at each read;
//   - the key `__proto__`, a key that is a whole number, and a key that is not in the NFC form;
//   - a value nested deeper than MAX_DOCUMENT_DEPTH.
// The check is a walk. It reads each member one time, as data, and it builds a new plain value while it checks. It makes each member and each index of the copy with defineProperty, so a prototype that
// was changed cannot change the copy, and no setter of a prototype runs. Everything after the check (the canonical text, the digest, and the value that goes back to the caller) uses that copy and
// never the original. The walk never throws: a Proxy that throws, or that is revoked, gives a refusal.
import { defineMember } from './own.ts';
import { accepted, refused, type ProtocolResult } from './result.ts';
import { shown } from './text.ts';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
/** A JSON object that a proposal or a request for quotation carries. It is checked by parseDocument. */
export type Document = JsonObject;

/** The most levels of objects and arrays in a document. The outer object is level 1. A document of a use case is under 8 levels deep. */
export const MAX_DOCUMENT_DEPTH = 32;

const WHOLE_NUMBER_KEY = /^(?:0|[1-9][0-9]*)$/;

/**
 * True for a plain object: made by an object literal, by JSON.parse, or with no prototype. An array, a date, a map and an object of a class are not. The members stay `unknown`: this checks the
 * object, not its fields. It never throws: a Proxy that throws, or that is revoked, is not a plain object.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

type Step = string | number;
interface Problem {
  readonly path: readonly Step[];
  readonly what: string;
}
type Failure = { readonly ok: false; readonly problem: Problem };
type Walked = { readonly ok: true; readonly value: JsonValue } | Failure;

/**
 * A refusal. The path leads from the value that was walked to the member that is wrong, and it is empty when the value itself is wrong. A refusal from inside a member puts the step to that member in
 * front of its path. So the walk keeps no path while it succeeds, and each level that a refusal passes does this one time.
 */
const stop = (path: readonly Step[], what: string): Failure => ({ ok: false, problem: { path, what } });
const copy = (value: JsonValue): Walked => ({ ok: true, value });

/** The longest path that a detail shows. A deeper path is shown by its end, so the member is named and the detail stays short. */
const MAX_PATH_TEXT = 120;

/** The path of a member as text: the field, then `.key` and `[index]`. A key comes from outside, so it is shown cut and in printable form. */
function pathText(field: string, path: readonly Step[]): string {
  const text = path.reduce<string>((built, step) => (typeof step === 'number' ? `${built}[${step}]` : `${built}.${shown(step)}`), field);
  return text.length <= MAX_PATH_TEXT ? text : `${field}...${text.slice(field.length + 3 - MAX_PATH_TEXT)}`;
}

/**
 * Why the keys of an array are not its indexes and `length`: a hole, or a key that is not an index. It works on the keys alone and reads no member, so it is short for any length. A Proxy can report a
 * length of billions. The keys hold at most `keys.length` indexes, so an index that they lack is found in `keys.length + 1` steps at most.
 */
function keysProblem(keys: readonly (string | symbol)[], length: number): Failure {
  const names = new Set<string | symbol>(keys);
  for (let index = 0; index < length && index <= keys.length; index += 1) {
    if (!names.has(String(index))) return stop([index], 'is a hole in an array');
  }
  return stop([], 'has a key that JSON cannot hold');
}

/**
 * A plain array, read by its indexes into a new array. Each index is read one time, from its descriptor, so a getter never runs. No array method runs, so `Symbol.species` is never asked. Each index of
 * the copy is made with defineProperty, so no setter of a prototype runs. A descriptor is read as its own data (`Object.hasOwn`): `in` would find a `value` that Object.prototype holds, and it would
 * take an accessor for a data member.
 */
function walkArray(value: readonly unknown[], depth: number): Walked {
  if (Object.getPrototypeOf(value) !== Array.prototype) return stop([], 'is an array of a kind that JSON does not have');
  // A Proxy can report any value as its length. Only a number is used, because an object can give another number at each use.
  const length: unknown = value.length;
  if (typeof length !== 'number') return stop([], 'has a length that is not a number');
  const keys = Reflect.ownKeys(value);
  // The indexes and `length` are the only keys of a plain array that JSON can hold. The check comes before the loop, so a length that the keys do not have is refused at once, and no index is read.
  if (keys.length !== length + 1) return keysProblem(keys, length);
  const out: JsonValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined) return stop([index], 'is a hole in an array');
    if (!Object.hasOwn(descriptor, 'value')) return stop([index], 'is an accessor, which is not allowed');
    const member = walk(descriptor.value, depth + 1);
    if (!member.ok) return stop([index, ...member.problem.path], member.problem.what);
    defineMember(out, index, member.value);
  }
  return copy(out);
}

/** A plain object, read by its own keys into a new object. Each member is read one time, from its descriptor, so a getter never runs. Each member of the copy is made with defineProperty. */
function walkObject(value: Record<string, unknown>, depth: number): Walked {
  const out: Record<string, JsonValue> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return stop([], 'has a key that JSON cannot hold');
    if (key === '__proto__') return stop([key], 'is the key __proto__, which is not allowed');
    if (WHOLE_NUMBER_KEY.test(key)) return stop([key], 'is a key that is a whole number, which is not allowed');
    if (key !== key.normalize('NFC')) return stop([key], 'is a key that is not in the NFC form, which is not allowed');
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true) return stop([], 'has a key that JSON cannot hold');
    if (!Object.hasOwn(descriptor, 'value')) return stop([key], 'is an accessor, which is not allowed');
    const member = walk(descriptor.value, depth + 1);
    if (!member.ok) return stop([key, ...member.problem.path], member.problem.what);
    defineMember(out, key, member.value);
  }
  return copy(out);
}

function walk(value: unknown, depth: number): Walked {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return copy(value);
  if (typeof value === 'number') return Number.isFinite(value) ? copy(value) : stop([], 'is not a finite number');
  if (typeof value !== 'object') return stop([], 'is not JSON data');
  if (depth > MAX_DOCUMENT_DEPTH) return stop([], `is nested deeper than ${MAX_DOCUMENT_DEPTH} levels`);
  if (Array.isArray(value)) return walkArray(value, depth);
  if (!isPlainObject(value)) return stop([], 'is not a plain object');
  return walkObject(value, depth);
}

/**
 * A value that JSON can hold and that the canonical form writes without loss. The result holds a NEW value that the walk built while it checked: it is equal to the input at the time of the walk,
 * and it shares no object with the input. A caller uses this value and never the input.
 */
export function parseJsonValue(value: unknown, field = 'value'): ProtocolResult<JsonValue> {
  try {
    const walked = walk(value, 1);
    return walked.ok ? accepted(walked.value) : refused('bad_shape', `${pathText(field, walked.problem.path)} ${walked.problem.what}`);
  } catch {
    return refused('bad_shape', `${field} cannot be read as JSON data`);
  }
}

/** A JSON object under the rules of parseJsonValue. The result holds a new object: the copy that was checked. */
export function parseDocument(value: unknown, field = 'document'): ProtocolResult<Document> {
  if (!isPlainObject(value)) return refused('bad_shape', `${field} must be a JSON object`);
  const walked = parseJsonValue(value, field);
  if (!walked.ok) return walked;
  // A value that was an object at the first look and is not one at the walk is refused: the copy is what counts.
  return isPlainObject(walked.value) ? accepted(walked.value as Document) : refused('bad_shape', `${field} must be a JSON object`);
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
