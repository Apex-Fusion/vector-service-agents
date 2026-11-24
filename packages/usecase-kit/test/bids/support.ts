// packages/usecase-kit/test/bids/support.ts
// What the tests of the bids folder share: the golden files, a way to change a copy of a golden value at a path, a text that no form of the folder takes, a check for a refusal, and a change of a
// prototype for the length of one call.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { ProtocolResult } from '@vsa/usecase-kit/protocol';

export type GoldenName = 'rfq' | 'weights' | 'price-list';
export type Json = Record<string, unknown>;
type Step = string | number;

/** The exact text of a golden file. */
export const goldenText = (name: GoldenName): string => readFileSync(new URL(`./golden/${name}.json`, import.meta.url), 'utf8');

/** A fresh value of a golden file, so that a test can change a member without changing the sample. */
export const golden = (name: GoldenName): Json => JSON.parse(goldenText(name)) as Json;

/** The value at `path` of `record`. A path that does not exist is an error of the test. */
export function valueAt(record: Json, path: readonly Step[]): unknown {
  let at: unknown = record;
  for (const step of path) {
    if (typeof at !== 'object' || at === null) throw new Error(`the sample has no value at ${path.join('.')}`);
    at = Reflect.get(at, step);
  }
  return at;
}

/** The object at `path` of `record`, for a test that changes it in place. */
export function objectAt(record: Json, path: readonly Step[]): Json {
  const found = valueAt(record, path);
  if (typeof found !== 'object' || found === null || Array.isArray(found)) throw new Error(`the sample has no object at ${path.join('.')}`);
  // The test names an object of a golden file, and the guard above says that it is an object.
  return found as Json;
}

/** The list at `path` of `record`, for a test that changes it in place. */
export function listAt(record: Json, path: readonly Step[]): unknown[] {
  const found = valueAt(record, path);
  if (!Array.isArray(found)) throw new Error(`the sample has no list at ${path.join('.')}`);
  return found;
}

/**
 * A deep copy of `record` with the value at `path` set to `value`. The value `undefined` removes the member instead. The path must exist, up to its last step: the copy of a path that does not
 * exist is an error of the test.
 */
export function change(record: Json, path: readonly Step[], value: unknown): Json {
  const copy = JSON.parse(JSON.stringify(record)) as Json;
  const holder = valueAt(copy, path.slice(0, -1));
  if (typeof holder !== 'object' || holder === null) throw new Error(`the sample has no member at ${path.join('.')}`);
  const last = path[path.length - 1]!;
  if (value === undefined) Reflect.deleteProperty(holder, last);
  else Reflect.set(holder, last, value);
  return copy;
}

/**
 * A text that no identifier, date, digest or plain text takes: it has a space, a slash, a hash sign and a line break. A refusal must never repeat the value that failed, so a test that gives this
 * text in a member checks that no part of it is in the detail.
 */
export const MARKER = 'zq9 marker/value#7f3\n';

/** The value of a result that must have passed. */
export function must<T, C extends string>(result: ProtocolResult<T, C>): T {
  if (!result.ok) throw new Error(`the sample must pass, and it was refused: ${result.detail}`);
  return result.value;
}

/** A refusal with the code `bad_shape`. The detail names `where`, and it never repeats the marker. */
export function expectRefused(result: ProtocolResult<unknown, string>, where: string): void {
  expect(result.ok, `a refusal that names ${where}`).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe('bad_shape');
  expect(result.detail).toContain(where);
  expect(result.detail).not.toContain('zq9');
  expect(result.detail).not.toContain('marker');
}

/** Defines the members on `target`, runs `body`, and removes the members in a `finally`. */
export function withPrototype<T>(target: object, members: Readonly<Record<string, PropertyDescriptor>>, body: () => T): T {
  const names = Object.keys(members);
  try {
    for (const name of names) Object.defineProperty(target, name, { ...members[name], configurable: true });
    return body();
  } finally {
    for (const name of names) Reflect.deleteProperty(target, name);
  }
}
