// packages/usecase-kit/test/decision/answer.test.ts: the answer of a model, read into a choice and its reasoning. The choice is the model's: the value that comes out is the value that the model gave.
// An answer of another shape is model_output_invalid. A parser that returns another value than the one it was given is a defect (choice_changed). Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { accepted, refused } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import type { ChoiceParser } from '@vsa/usecase-kit/decision';
import { readAnswer } from '../../src/decision/answer.ts';
import { MEDIUM_LOT, parseReorder, said } from './support.ts';

const MARKER = 'ZQ9-marker-7f3';
const completed = (text: string): { text: string; status: unknown } => ({ text, status: 'completed' });
const any: ChoiceParser<JsonValue> = (given) => accepted(given);

describe('readAnswer: the text of the answer', () => {
  it('reads one JSON object with the reasoning and the choice, in either order', () => {
    expect(readAnswer(completed(said(MEDIUM_LOT, 'Why.')), parseReorder)).toStrictEqual({ ok: true, value: { reasoning: 'Why.', choice: MEDIUM_LOT } });
    expect(readAnswer(completed(JSON.stringify({ choice: MEDIUM_LOT, reasoning: 'Why.' })), parseReorder)).toStrictEqual({ ok: true, value: { reasoning: 'Why.', choice: MEDIUM_LOT } });
  });

  it.each<[string, unknown]>([
    ['incomplete', 'incomplete'], ['failed', 'failed'], ['a missing status', undefined], ['null', null], ['a number', 1], ['COMPLETED in capitals', 'COMPLETED'],
  ])('refuses an answer that the supplier did not give as completed: %s', (_name, status) => {
    expect(readAnswer({ text: said(MEDIUM_LOT), status }, parseReorder)).toMatchObject({ ok: false, code: 'model_output_invalid' });
  });

  it.each<[string, string]>([
    ['one fence with a language', '```json\n' + said(MEDIUM_LOT) + '\n```'],
    ['one fence with no language', '```\n' + said(MEDIUM_LOT) + '\n```'],
    ['white space around', `\n\n  ${said(MEDIUM_LOT)}  \n`],
    ['a line break inside the object', JSON.stringify({ reasoning: 'Why.', choice: MEDIUM_LOT }, null, 2)],
  ])('reads %s: the twin of the refusals', (_name, text) => {
    expect(readAnswer(completed(text), parseReorder)).toMatchObject({ ok: true, value: { choice: MEDIUM_LOT } });
  });

  it.each<[string, string, string]>([
    ['no object', 'The lot is medium.', 'is not one JSON object alone'],
    ['a list', '[1, 2]', 'is JSON that is not an object'],
    ['a close brace before an open brace', '} {', 'is not one JSON object alone'],
    ['text that is not JSON between the braces', '{not json}', 'is not one JSON object alone'],
    ['two objects', `${said(MEDIUM_LOT)} ${said(MEDIUM_LOT)}`, 'is not one JSON object alone'],
    ['a cut object', `${said(MEDIUM_LOT)}`.slice(0, -2) + '}', 'is not one JSON object alone'],
    ['a number that is not finite', '{"reasoning":"r","choice":1e999}', 'has a number that a double does not hold without loss'],
    ['the key __proto__', '{"reasoning":"r","choice":{"__proto__":1}}', 'holds, at depth 2, a value or a key that JSON data does not allow'],
    ['a value nested too deep', `{"reasoning":"r","choice":${'{"a":'.repeat(40)}1${'}'.repeat(40)}}`, 'is nested deeper than 32 levels'],
    ['no choice', '{"reasoning":"r"}', 'has the wrong members'],
    ['no reasoning', '{"choice":1}', 'has the wrong members'],
    ['a third member', '{"reasoning":"r","choice":1,"extra":2}', 'has the wrong members: it has a member that is not allowed'],
    ['a reasoning that is a number', '{"reasoning":1,"choice":1}', 'has no reasoning'],
    ['a reasoning that is null', '{"reasoning":null,"choice":1}', 'has no reasoning'],
    ['a reasoning of white space', '{"reasoning":" \\n\\t ","choice":1}', 'has no reasoning'],
  ])('refuses %s with model_output_invalid', (_name, text, why) => {
    const result = readAnswer(completed(text), any);
    expect(result).toMatchObject({ ok: false, code: 'model_output_invalid' });
    if (!result.ok) expect(result.detail).toContain(why);
  });

  it('never repeats the text of the answer in a detail, and says how long it is', () => {
    for (const text of [`${MARKER} no object`, `{"reasoning":"${MARKER}","choice":{"lot":"${MARKER}","quantity":1,"needed_by":"2026-12-01"}}`, `{"reasoning":"${MARKER}"`]) {
      const result = readAnswer(completed(text), parseReorder);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.detail).not.toContain(MARKER);
      expect(result.detail).toContain(`an answer of ${text.length} characters`);
    }
  });

  // The answer can quote the input, so a key that the model writes can be a key of the input. No detail repeats it, and each says where by position.
  it.each<[string, string, string]>([
    ['a member of the answer that is not allowed', `{"reasoning":"r","choice":1,"${MARKER}-key":2}`, 'has the wrong members: it has a member that is not allowed'],
    ['the key __proto__ below a key', `{"reasoning":"r","choice":{"${MARKER}-key":{"__proto__":1}}}`, 'holds, at depth 3, a value or a key that JSON data does not allow'],
    ['a key that is a whole number below a key', `{"reasoning":"r","choice":{"${MARKER}-key":{"7":1}}}`, 'holds, at depth 3, a value or a key that JSON data does not allow'],
    ['a key that is not in the NFC form', `{"reasoning":"r","choice":{"${MARKER}-cafe\\u0301":1}}`, 'holds, at depth 2, a value or a key that JSON data does not allow'],
    ['a nest of keys that is too deep', `{"reasoning":"r","choice":${`{"${MARKER}-key":`.repeat(40)}1${'}'.repeat(40)}}`, 'is nested deeper than 32 levels'],
  ])('names no key of the answer, and says where: %s', (_name, text, why) => {
    const result = readAnswer(completed(text), any);
    expect(result).toMatchObject({ ok: false, code: 'model_output_invalid' });
    if (result.ok) return;
    expect(result.detail).toContain(why);
    expect(result.detail).not.toContain(MARKER);
  });

  it('names no key of the choice when the parser refuses it, and does not copy the detail of the parser', () => {
    // checkMembers of the protocol, which a parser of a use case calls, repeats the key that it refuses. That text is not copied.
    const choice = `{"lot":"lot-medium","quantity":50,"needed_by":"2026-12-01","${MARKER}-key":1}`;
    const text = `{"reasoning":"r","choice":${choice}}`;
    expect(parseReorder(JSON.parse(choice))).toMatchObject({ ok: false, detail: expect.stringContaining(MARKER) });
    expect(readAnswer(completed(text), parseReorder)).toStrictEqual({
      ok: false, code: 'model_output_invalid', detail: `the answer of the model has a choice of another shape (an answer of ${text.length} characters)`,
    });
    // The twin: the choice without the key that the shape does not name is read.
    expect(readAnswer(completed(said(MEDIUM_LOT)), parseReorder).ok).toBe(true);
  });

  it('keeps the reasoning as written: no trim, no change of case, no normalisation', () => {
    const reasoning = '  Cafe\u0301 is open.\n\tTwo lines.  ';
    expect(readAnswer(completed(said(MEDIUM_LOT, reasoning)), parseReorder)).toMatchObject({ ok: true, value: { reasoning } });
  });

  it('accepts any JSON value as a choice when the parser accepts it: null, a text, a number, a list', () => {
    for (const choice of [null, 'yes', 0, -0.5, [], [1, [2]], {}, false]) {
      expect(readAnswer(completed(said(choice)), any), JSON.stringify(choice)).toStrictEqual({ ok: true, value: { reasoning: 'The data supports this choice.', choice } });
    }
  });
});

describe('readAnswer: the parser of the decision', () => {
  it('gives the parser a copy of the choice, and returns the choice that the model gave when the parser changes its copy', () => {
    const seen: JsonValue[] = [];
    const parse: ChoiceParser<JsonValue> = (given) => { seen.push(given); (given as Record<string, JsonValue>).quantity = 1; return accepted(given); };
    const result = readAnswer(completed(said({ ...MEDIUM_LOT, quantity: 0 })), parse);
    // The parser changed its copy, so what it returned is not what the model gave.
    expect(result).toMatchObject({ ok: false, code: 'choice_changed' });
    expect(seen).toHaveLength(1);
  });

  it('is choice_changed, and not model_output_invalid, when the parser returns another value: the fault is the parser\'s', () => {
    const result = readAnswer(completed(said(MEDIUM_LOT)), () => accepted({ ...MEDIUM_LOT, quantity: 1 }));
    expect(result).toMatchObject({ ok: false, code: 'choice_changed' });
    if (!result.ok) expect(result.detail).toBe('the parser of the decision returned a value that is not the choice that the model gave');
  });

  it('takes a value that holds the same data in another order of keys: the order of keys is not a change', () => {
    const reorder: ChoiceParser<JsonValue> = (given) => accepted(Object.fromEntries(Object.entries(given as Record<string, JsonValue>).reverse()));
    expect(readAnswer(completed(said(MEDIUM_LOT)), reorder)).toMatchObject({ ok: true, value: { choice: MEDIUM_LOT } });
  });

  it('returns a new copy of the value of the parser: a parser that keeps its object cannot change the choice later', () => {
    const kept: { object: Record<string, JsonValue> | null } = { object: null };
    const keeper: ChoiceParser<JsonValue> = (given) => { kept.object = given as Record<string, JsonValue>; return accepted(given); };
    const result = readAnswer(completed(said(MEDIUM_LOT)), keeper);
    expect(result.ok).toBe(true);
    if (!result.ok || kept.object === null) return;
    expect(result.value.choice).not.toBe(kept.object);
    kept.object.quantity = 999;
    expect(result.value.choice).toStrictEqual(MEDIUM_LOT);
  });

  it('refuses a choice of another shape with a detail that is the same for every parser: the text of the parser is not copied', () => {
    const refusing = (detail: string) => readAnswer(completed(said(MEDIUM_LOT)), () => refused('bad_shape', detail));
    const first = refusing('choice.lot must name one of the three lots');
    const second = refusing(`choice has the member "${MARKER}", which is not allowed\n${'x'.repeat(400)}`);
    expect(first).toMatchObject({ ok: false, code: 'model_output_invalid' });
    expect(second).toStrictEqual(first);
    if (!first.ok) expect(first.detail).toBe(`the answer of the model has a choice of another shape (an answer of ${said(MEDIUM_LOT).length} characters)`);
  });

  it.each<[string, (given: JsonValue) => unknown]>([
    ['throws', () => { throw new Error(`the parser broke ${MARKER}`); }],
    ['returns undefined', () => undefined],
    ['returns null', () => null],
    ['returns a number', () => 1],
    ['returns ok as a text', () => ({ ok: 'true', value: MEDIUM_LOT })],
    ['returns a refusal', () => refused('bad_shape', 'choice is wrong')],
  ])('is model_output_invalid, and never a pass, when the parser %s', (_name, parse) => {
    const result = readAnswer(completed(said(MEDIUM_LOT)), parse as ChoiceParser<JsonValue>);
    expect(result).toMatchObject({ ok: false, code: 'model_output_invalid' });
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it.each<[string, () => unknown]>([
    ['says ok and gives no value', () => ({ ok: true })],
    ['returns NaN', () => accepted(Number.NaN)],
    ['returns an object of a class', () => accepted(new Map() as unknown as JsonValue)],
    ['returns a function', () => accepted((() => 1) as unknown as JsonValue)],
  ])('is choice_changed, and says that the value is not JSON data, when the parser %s', (_name, parse) => {
    expect(readAnswer(completed(said(MEDIUM_LOT)), parse as unknown as ChoiceParser<JsonValue>)).toStrictEqual({
      ok: false, code: 'choice_changed', detail: 'the parser of the decision returned a value that is not JSON data',
    });
  });

  it('reads the verdict of the parser one time: a getter cannot show one value to the check and another to the record', () => {
    let reads = 0;
    const parse = ((given: JsonValue) => ({ ok: true, get value(): JsonValue { reads += 1; return reads === 1 ? given : { other: 1 }; } })) as unknown as ChoiceParser<JsonValue>;
    expect(readAnswer(completed(said(MEDIUM_LOT)), parse)).toMatchObject({ ok: true, value: { choice: MEDIUM_LOT } });
    expect(reads).toBe(1);
  });

  it.each<[string, () => unknown]>([
    ['a promise that resolves', () => Promise.resolve(accepted(MEDIUM_LOT))],
    ['a promise that rejects', () => Promise.reject(new Error(MARKER))],
    ['a thenable', () => ({ then: () => undefined })],
  ])('is bad_decision, and not model_output_invalid, when the parser returns %s: the parser is wrong, and the value of the promise is not read', (_name, parse) => {
    const result = readAnswer(completed(said(MEDIUM_LOT)), parse as unknown as ChoiceParser<JsonValue>);
    expect(result).toStrictEqual({ ok: false, code: 'bad_decision', detail: 'the parser of the decision returned a promise: a parser must return its result, and never a promise' });
  });

  it('is model_output_invalid when a verdict cannot be read, and takes a verdict whose then is not a function: the twin', () => {
    const unreadable = Object.defineProperty({}, 'then', { get(): never { throw new Error(MARKER); } });
    expect(readAnswer(completed(said(MEDIUM_LOT)), (() => unreadable) as unknown as ChoiceParser<JsonValue>)).toMatchObject({ ok: false, code: 'model_output_invalid' });
    const plain = (given: JsonValue): unknown => ({ ok: true, value: given, then: 5 });
    expect(readAnswer(completed(said(MEDIUM_LOT)), plain as ChoiceParser<JsonValue>)).toMatchObject({ ok: true, value: { choice: MEDIUM_LOT } });
  });
});
