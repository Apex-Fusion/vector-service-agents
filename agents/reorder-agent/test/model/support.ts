// agents/reorder-agent/test/model/support.ts
// What the tests of the model folder share: the golden files, a text that no form of the folder takes, and the reading of a typed result.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { ProtocolResult } from '@vsa/usecase-kit/protocol';

/** The exact text of a golden file. */
export const goldenText = (name: string): string => readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8');

/** A fresh value of a golden JSON file that holds an object, so that a test can change a member without changing the sample. */
export const golden = (name: string): Record<string, unknown> => JSON.parse(goldenText(name)) as Record<string, unknown>;

/** A fresh value of a golden JSON file that holds a list of objects. */
export const goldenList = (name: string): Record<string, unknown>[] => JSON.parse(goldenText(name)) as Record<string, unknown>[];

/**
 * A text that no identifier, date, digest, lot name or address takes: it has a space, a slash, a hash sign and a line break. A refusal must never repeat the value that failed, so a test that
 * gives this text checks that no part of it is in the detail.
 */
export const MARKER = 'zq9 marker/value#7f3\n';

/** The value of a result that must have passed. */
export function must<T, C extends string>(result: ProtocolResult<T, C>): T {
  if (!result.ok) throw new Error(`the sample must pass, and it was refused with ${result.code}: ${result.detail}`);
  return result.value;
}

/** The code and the detail of a result that must have failed. */
export function refusal<C extends string>(result: ProtocolResult<unknown, C>): { code: C; detail: string } {
  if (result.ok) throw new Error('the result passed, and the test expected a refusal');
  return { code: result.code, detail: result.detail };
}

/** A detail that names `where` and holds no part of the marker. */
export function expectNames(detail: string, where: string): void {
  expect(detail).toContain(where);
  expect(detail).not.toContain('zq9');
  expect(detail).not.toContain('marker');
}
