// services/mock-systems/src/validate.ts
// Reading JSON that comes from outside: the seed of a tenant and the body of a write. Every value is `unknown` until a function here says what it is. A value of the wrong type is an
// error that names its path, never a default and never a number that was cut. An object has the fields that its reader names and no other: a field that is not named is a mistake.
// Each reader builds a new object from the fields that it knows, so no other field of the input is ever kept.

/** A value that is not as the reader needs. `path` names the value in the input, for example `body.ranked[0].rank`. */
export class Invalid extends Error {
  readonly path: string;
  constructor(path: string, problem: string) {
    super(`${path} ${problem}`);
    this.name = 'Invalid';
    this.path = path;
  }
}

export type Json = Record<string, unknown>;

export const isJsonObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The identifier of a thing in a system: a SKU, an order, a code. Letters, digits, dot, hyphen and underscore, 1 to 64 characters, and it starts with a letter or a digit. */
export const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const HEX64 = /^[0-9a-f]{64}$/;
export const DID = /^did:vector:[0-9a-f]{64}$/;
export const OUT_REF = /^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,5})$/;
/** The name of a tenant: 1 to 48 lower case letters, digits and hyphens, starting with a letter or a digit. It is a segment of the URL and a part of each resource. */
export const TENANT = /^[a-z0-9][a-z0-9-]{0,47}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Control characters other than the line break and the tab.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const at = (path: string, key: string): string => `${path}.${key}`;
export const atIndex = (path: string, index: number): string => `${path}[${index}]`;

/** An object whose fields are the `required` and the `optional` names, and no other. */
export function fields(path: string, value: unknown, required: readonly string[], optional: readonly string[] = []): Json {
  if (!isJsonObject(value)) throw new Invalid(path, 'must be a JSON object');
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Invalid(at(path, key), 'is not a field of this object');
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Invalid(at(path, key), 'is required');
  return value;
}

export interface TextRules {
  readonly min?: number;
  readonly max: number;
  readonly pattern?: RegExp;
  readonly words?: string;
}

/** A text of `min` to `max` characters with no control character (the line break and the tab are allowed). A `pattern` is matched on the whole text. */
export function text(path: string, value: unknown, rules: TextRules): string {
  if (typeof value !== 'string') throw new Invalid(path, 'must be a text');
  const min = rules.min ?? 1;
  if (value.length < min || value.length > rules.max) throw new Invalid(path, `must have ${min === rules.max ? min : `${min} to ${rules.max}`} characters`);
  if (CONTROL.test(value)) throw new Invalid(path, 'must not hold a control character');
  if (rules.pattern !== undefined && !rules.pattern.test(value)) throw new Invalid(path, rules.words ?? 'is not in the form that this field has');
  return value;
}

export const id = (path: string, value: unknown): string => text(path, value, { max: 64, pattern: ID, words: 'must be 1 to 64 letters, digits, dots, hyphens or underscores, and start with a letter or a digit' });
export const hex64 = (path: string, value: unknown): string => text(path, value, { max: 64, min: 64, pattern: HEX64, words: 'must be 64 lower case hex characters' });
export const did = (path: string, value: unknown): string => text(path, value, { max: 75, pattern: DID, words: 'must be a DID of the form did:vector: and 64 lower case hex characters' });
export const outRef = (path: string, value: unknown): string => text(path, value, { max: 71, pattern: OUT_REF, words: 'must be a reference of the form <64 hex characters>#<index>' });

/** A whole number from `min` to `max`. A text, a fraction and a number that a number cannot hold exactly are refused. */
export function whole(path: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Invalid(path, `must be a whole number from ${min} to ${max}`);
  return value;
}

/** A number from 0 to 1. */
export function ratio(path: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Invalid(path, 'must be a number from 0 to 1');
  return value;
}

/** A number of at least 0 and at most `max`. */
export function amount(path: string, value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Invalid(path, `must be a number from 0 to ${max}`);
  return value;
}

export function flag(path: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Invalid(path, 'must be true or false');
  return value;
}

/** A calendar date as `YYYY-MM-DD`. A date that does not exist, such as 2026-02-30, is refused. */
export function date(path: string, value: unknown): string {
  const checked = text(path, value, { max: 10, min: 10, pattern: DATE, words: 'must be a date as YYYY-MM-DD' });
  const [, y, m, d] = DATE.exec(checked)!;
  const parsed = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (parsed.getUTCFullYear() !== Number(y) || parsed.getUTCMonth() !== Number(m) - 1 || parsed.getUTCDate() !== Number(d)) throw new Invalid(path, 'must be a date that exists');
  return checked;
}

/** A list of `min` to `max` items, each read by `item`. */
export function list<T>(path: string, value: unknown, min: number, max: number, item: (itemPath: string, entry: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Invalid(path, 'must be a list');
  if (value.length < min || value.length > max) throw new Invalid(path, `must have ${min === max ? min : `${min} to ${max}`} items`);
  return value.map((entry, index) => item(atIndex(path, index), entry));
}

/** The member of `allowed` that the value is. */
export function oneOf<T extends string>(path: string, value: unknown, allowed: readonly T[]): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new Invalid(path, `must be one of ${allowed.join(', ')}`);
  return found;
}

/** A domain name of at most 64 bytes, in lower case, with at least two labels: the form of the organisation of an agent record. */
export function domain(path: string, value: unknown): string {
  const name = text(path, value, { max: 64, words: 'must be a domain name of at most 64 characters' });
  const labels = name.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) throw new Invalid(path, 'must be a domain name in lower case with at least two labels, for example alfa.example.org');
  return name;
}

/** Throws when two entries of a list have the same key. */
export function unique<T>(path: string, entries: readonly T[], key: (entry: T) => string, what: string): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = key(entry);
    if (seen.has(name)) throw new Invalid(path, `has the ${what} ${name} two times`);
    seen.add(name);
  }
}
