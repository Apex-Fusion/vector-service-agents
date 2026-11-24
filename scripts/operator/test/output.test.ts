// The machine line of a run: `operator-result: ` and the JSON of the result, on one line, so that the program that starts the pack can always read it. No value, in any member, can add a line break to it.
import { describe, expect, it } from 'vitest';
import { operatorResult } from '../lib/output.ts';
import type { OperatorResultFields } from '../lib/output.ts';
import { LOOKALIKE_NAMES, LOOKALIKE_TEXTS, SECRET_NAMES, SECRET_TEXTS } from './support/secrets.ts';

const PREFIX = 'operator-result: ';
const FIELDS: OperatorResultFields = {
  task: 'register', command: 'run', mode: 'dry', outcome: 'dry', exit: 0, step: 'reorder-agent', result: { did: 'did:vector:abc', txtName: '_did.echo.example', checked: true, count: 3, none: null, list: ['a', 'b'] },
};
/** The line as its reader sees it: the seven members. */
interface ParsedLine { task: string | null; command: string | null; mode: string | null; outcome: string; exit: number; step: string | null; result: Record<string, unknown> }
/** The text of the line after its prefix, parsed. */
const parsed = (line: string): ParsedLine => JSON.parse(line.slice(PREFIX.length));
/** Every character that a program can take for the end of a line: the line feed, the carriage return, the vertical tab, the form feed, the separators of the C0 range, the next line, and the two Unicode separators. */
const BREAKS = /[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/;

describe('operatorResult', () => {
  it('gives the prefix and the JSON of the seven members, in order, on one line', () => {
    const line = operatorResult(FIELDS);
    expect(line.startsWith(PREFIX)).toBe(true);
    expect(parsed(line)).toEqual(FIELDS);
    expect(Object.keys(parsed(line))).toEqual(['task', 'command', 'mode', 'outcome', 'exit', 'step', 'result']);
    expect(line.split(/\r?\n/)).toHaveLength(1);
    expect(line).not.toMatch(BREAKS);
  });
  it('gives the same line for the same fields, whatever the order of the members that the caller wrote', () => {
    const shuffled: OperatorResultFields = { result: FIELDS.result, step: FIELDS.step, exit: FIELDS.exit, outcome: FIELDS.outcome, mode: FIELDS.mode, command: FIELDS.command, task: FIELDS.task };
    expect(operatorResult(shuffled)).toBe(operatorResult(FIELDS));
  });
  it('writes a bigint as text, at any depth', () => {
    const line = operatorResult({ ...FIELDS, result: { fee: 450_000n, deep: { list: [1n, { n: 2n }], big: 123_456_789_012_345_678_901_234_567_890n } } });
    expect(parsed(line).result).toEqual({ fee: '450000', deep: { list: ['1', { n: '2' }], big: '123456789012345678901234567890' } });
    expect(line).not.toMatch(BREAKS);
  });
  it('holds no line break that comes from a value: not in a text, not in the name of a member, not at any depth', () => {
    for (const char of ['\n', '\r', '\r\n', '\u000b', '\u000c', '\u001c', '\u001d', '\u001e', '\u0085', '\u2028', '\u2029']) {
      const hostile = `first${char}second`;
      const fields: OperatorResultFields = {
        ...FIELDS, task: hostile, step: hostile, result: { [hostile]: hostile, deep: { list: [hostile, { [hostile]: [hostile] }] } },
      };
      const line = operatorResult(fields);
      expect(line, JSON.stringify(char)).not.toMatch(BREAKS);
      expect(line.split(/\r?\n/)).toHaveLength(1);
      expect(parsed(line)).toEqual(fields);
    }
  });
  it('writes the other control characters and a lone surrogate so that the line is still valid JSON that gives the value back', () => {
    const hostile = 'a\u0000b\u0007c\u001bd\u007fe\ud800f';
    const line = operatorResult({ ...FIELDS, result: { text: hostile } });
    expect(line).not.toMatch(BREAKS);
    expect(parsed(line).result.text).toBe(hostile);
  });
  it('writes a step that is not known, a task that is not known, and an empty result', () => {
    const line = operatorResult({ task: null, command: null, mode: null, outcome: 'stopped', exit: 2, step: null, result: {} });
    expect(parsed(line)).toEqual({ task: null, command: null, mode: null, outcome: 'stopped', exit: 2, step: null, result: {} });
  });
  it('writes a failure and a stop like any other outcome, with the exit code', () => {
    const OUTCOMES: [OperatorResultFields['outcome'], number][] = [['dry', 0], ['done', 0], ['finished', 0], ['wait', 4], ['failed', 1], ['stopped', 2]];
    for (const [outcome, exit] of OUTCOMES) {
      const line = operatorResult({ ...FIELDS, outcome, exit, mode: outcome === 'dry' ? 'dry' : 'submit', command: outcome === 'wait' ? 'cleanup' : 'status' });
      expect(parsed(line), outcome).toMatchObject({ outcome, exit });
      expect(line.startsWith(PREFIX)).toBe(true);
    }
  });
  it('holds no member besides the seven: a member that the caller adds does not reach the line', () => {
    const line = operatorResult({ ...FIELDS, extra: 'distinctive-one', token: 'distinctive-two' } as OperatorResultFields);
    expect(line).not.toMatch(/distinctive|extra|"token"/);
    expect(parsed(line)).toEqual(FIELDS);
  });
  it('leaves the fields and the result as they were', () => {
    const result = { fee: 5n, nested: { n: 6n } };
    const fields: OperatorResultFields = { ...FIELDS, result };
    operatorResult(fields);
    expect(result).toEqual({ fee: 5n, nested: { n: 6n } });
    expect(fields.result).toBe(result);
  });
});

describe('operatorResult and a secret', () => {
  for (const { label, text } of SECRET_TEXTS) {
    it(`writes step null and result {} for ${label}: in the step, in the result at any depth, and as the name of a member, and never the text`, () => {
      const escaped = JSON.stringify(text).slice(1, -1);
      const attempts: [string, Partial<OperatorResultFields>][] = [
        ['in the step', { step: text }],
        ['in a member of the result', { result: { note: text } }],
        ['in the middle of a text of the result', { result: { note: `a ${text} b` } }],
        ['deep in the result', { result: { deep: { list: ['fine', { note: text }] } } }],
        ['as the name of a member of the result', { result: { [text]: 'x' } }],
      ];
      for (const [where, change] of attempts) {
        const line = operatorResult({ ...FIELDS, ...change });
        expect(line, where).not.toContain(escaped);
        expect(parsed(line), where).toEqual({ ...FIELDS, step: null, result: {} });
      }
    });
  }
  it('writes both empty for a member named seed, secret, token, authorization or private, in any case, at any depth', () => {
    for (const name of SECRET_NAMES) {
      for (const result of [{ [name]: 'x' }, { deep: { [name]: 'x' } }, { list: [{ [name]: null }] }]) {
        const line = operatorResult({ ...FIELDS, result });
        expect(parsed(line), name).toEqual({ ...FIELDS, step: null, result: {} });
      }
    }
  });
  it('leaves a step and a result as they are when they hold only texts and names that look like a secret', () => {
    const result = { ...Object.fromEntries(LOOKALIKE_TEXTS.map(({ text }, index) => [`text${index}`, text])), ...Object.fromEntries(LOOKALIKE_NAMES.map((name) => [name, 'x'])) };
    for (const { label, text } of LOOKALIKE_TEXTS) expect(parsed(operatorResult({ ...FIELDS, step: text })), label).toEqual({ ...FIELDS, step: text });
    expect(parsed(operatorResult({ ...FIELDS, result }))).toEqual({ ...FIELDS, result });
  });
});
