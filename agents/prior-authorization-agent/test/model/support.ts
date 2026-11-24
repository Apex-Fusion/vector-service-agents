// agents/prior-authorization-agent/test/model/support.ts
// What the tests of the model folder share: the golden files, a text that no form of the folder takes, the reading of a typed result, and the helpers that read a prompt.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { buildPrompt } from '@vsa/usecase-kit/decision';
import type { DecisionSpec } from '@vsa/usecase-kit/decision';
import type { ProtocolResult } from '@vsa/usecase-kit/protocol';

/** The exact text of a golden file. */
export const goldenText = (name: string): string => readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8');

/** A fresh value of a golden JSON file that holds an object, so that a test can change a member without changing the sample. */
export const golden = (name: string): Record<string, unknown> => JSON.parse(goldenText(name)) as Record<string, unknown>;

/**
 * A text that no identifier, date, digest or address takes: it has a space, a slash, a hash sign and a line break. A refusal must never repeat the value that failed, so a test that gives this text
 * checks that no part of it is in the detail.
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

/** The prompt of a decision as a golden file holds it: the file ends with a line break and the prompt does not. */
export function goldenPrompt(name: string): string {
  const text = goldenText(name);
  expect(text.endsWith('\n')).toBe(true);
  return text.slice(0, -1);
}

/** The prompt that the decision folder builds for a spec and an input. The test fails when the folder refuses the input. */
export const promptOf = (spec: Pick<DecisionSpec, 'instruction'>, input: unknown): string => must(buildPrompt(spec, input));

/** The number of lines of a prompt that hold nothing but a mark of the input block. */
export const marksOf = (prompt: string, mark: string): number => prompt.split('\n').filter((line) => line === mark).length;
