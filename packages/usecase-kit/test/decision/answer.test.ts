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
    ['words before and after', `Here is the answer: ${said(MEDIUM_LOT)} Thank you.`],
    ['a line break inside the object', JSON.stringify({ reasoning: 'Why.', choice: MEDIUM_LOT }, null, 2)],
  ])('reads %s: the twin of the refusals', (_name, text) => {
    expect(readAnswer(completed(text), parseReorder)).toMatchObject({ ok: true, value: { choice: MEDIUM_LOT } });
  });

  it.each<[string, string, string]>([
    ['no object', 'The lot is medium.', 'holds no JSON object'],
    ['a list', '[1, 2]', 'holds no JSON object'],
    ['a close brace before an open brace', '} {', 'holds no JSON object'],
    ['text that is not JSON between the braces', '{not json}', 'is not JSON'],
    ['two objects', `${said(MEDIUM_LOT)} ${said(MEDIUM_LOT)}`, 'is not JSON'],
    ['a cut object', `${said(MEDIUM_LOT)}`.slice(0, -2) + '}', 'is not JSON'],
    ['a number that is not finite', '{"reasoning":"r","choice":1e999}', 'is not plain JSON data'],
    ['the key __proto__', '{"reasoning":"r","choice":{"__proto__":1}}', 'is not plain JSON data'],
    ['a value nested too deep', `{"reasoning":"r","choice":${'{"a":'.repeat(40)}1${'}'.repeat(40)}}`, 'is not plain JSON data'],
    ['no choice', '{"reasoning":"r"}', 'has the wrong members'],
    ['no reasoning', '{"choice":1}', 'has the wrong members'],
    ['a third member', '{"reasoning":"r","choice":1,"extra":2}', 'has the wrong members'],
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

  it('refuses a choice of another shape with the detail of the parser, cut to 200 printable characters', () => {
    const long = `choice.lot is wrong \u00e9\n${'x'.repeat(400)}`;
    const result = readAnswer(completed(said(MEDIUM_LOT)), () => refused('bad_shape', long));
    expect(result).toMatchObject({ ok: false, code: 'model_output_invalid' });
    if (result.ok) return;
    const detail = result.detail.split(': ').slice(1).join(': ').replace(/ \(an answer of \d+ characters\)$/, '');
    expect(detail).toHaveLength(200);
    expect(detail).toMatch(/^[\x20-\x7e]+$/);
    expect(detail.startsWith('choice.lot is wrong ?')).toBe(true);
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

  it('is choice_changed when the parser says ok and gives no value', () => {
    expect(readAnswer(completed(said(MEDIUM_LOT)), (() => ({ ok: true })) as unknown as ChoiceParser<JsonValue>)).toMatchObject({ ok: false, code: 'choice_changed' });
  });

  it('reads the verdict of the parser one time: a getter cannot show one value to the check and another to the record', () => {
    let reads = 0;
    const parse = ((given: JsonValue) => ({ ok: true, get value(): JsonValue { reads += 1; return reads === 1 ? given : { other: 1 }; } })) as unknown as ChoiceParser<JsonValue>;
    expect(readAnswer(completed(said(MEDIUM_LOT)), parse)).toMatchObject({ ok: true, value: { choice: MEDIUM_LOT } });
    expect(reads).toBe(1);
  });
});
