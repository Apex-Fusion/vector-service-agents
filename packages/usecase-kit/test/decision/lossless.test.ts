// packages/usecase-kit/test/decision/lossless.test.ts: a JSON text that says one thing. A key that stands two times in one object and a number that does not read back as itself are refused, because
// JSON.parse would keep the last member and round the number, and the decision would record a value that the model did not write. Every refusal has an accepted twin, and the check never
// refuses a text that JSON.stringify wrote.
import { describe, expect, it } from 'vitest';
import { accepted } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import type { ChoiceParser } from '@vsa/usecase-kit/decision';
import { losses } from '../../src/decision/lossless.ts';
import { readAnswer } from '../../src/decision/answer.ts';
import { MEDIUM_LOT, said } from './support.ts';

const DUPLICATE = 'has a key that stands two times in one object';
const NUMBER = 'has a number that a double does not hold without loss';

describe('losses: keys', () => {
  it.each<[string, string]>([
    ['a key two times at the top', '{"a":1,"a":2}'],
    ['a key two times with the same value', '{"a":1,"a":1}'],
    ['a key two times in a nested object', '{"x":{"a":1,"a":2}}'],
    ['a key two times in an object in a list', '[{"a":1},{"b":1,"b":2}]'],
    ['a key and the same key written with an escape', '{"a":1,"\\u0061":2}'],
    ['a key that holds a quote, two times', '{"a\\"b":1,"a\\"b":2}'],
    ['the key reasoning two times', '{"reasoning":"a","choice":1,"reasoning":"b"}'],
    ['the key choice two times after a nested object', '{"choice":{"accept":false},"reasoning":"r","choice":{"accept":true}}'],
    ['a key two times after a long value', '{"a":"x,}{\\"b\\":1","b":2,"a":3}'],
  ])('refuses %s', (_name, json) => {
    expect(losses(json)).toBe(DUPLICATE);
    // The twin: JSON.parse reads it without a word, and keeps the last member.
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it.each<[string, string]>([
    ['one key', '{"a":1}'],
    ['the same key in two objects of a list', '[{"a":1},{"a":2}]'],
    ['the same key at two depths', '{"a":{"a":{"a":1}}}'],
    ['the same text as a key and as a value', '{"a":"a","b":"a","c":["a","a"]}'],
    ['keys that differ in case', '{"a":1,"A":2}'],
    ['a key that holds the marks of JSON', '{"a,b":1,"{":2,"}":3,"[":4,"]":5,":":6,"\\"":7,"\\\\":8}'],
    ['a string value that looks like members', '{"a":"x,\\"a\\":1}{","b":2}'],
    ['empty objects and lists', '{"a":{},"b":[],"c":[{},[]],"d":{"e":{}}}'],
    ['a list of lists of objects', '[[{"a":1}],[{"a":1}]]'],
    ['the same key after the object closed and another opened', '{"a":{"b":1},"c":{"b":2}}'],
    ['white space between the marks', ' {\n  "a" : 1 ,\n  "b" : [ { "a" : 2 } ]\n} '],
    ['a list of three equal texts', '["a","a","a"]'],
    ['equal texts in two lists of one object', '{"k":["a","a","a"],"j":["a","a","a"]}'],
    ['equal texts in a list of lists', '[["x","x","x"],["x","x","x"]]'],
  ])('takes %s', (_name, json) => {
    expect(losses(json)).toBeNull();
  });
});

describe('losses: numbers', () => {
  it.each<[string, string]>([
    ['an integer past the safe integers', '9007199254740993'],
    ['an integer of twenty digits', '12345678901234567890'],
    ['a negative integer past the safe integers', '-9007199254740993'],
    ['a fraction with more digits than a double holds', '0.10000000000000001'],
    ['a number that is one with a long fraction', '1.00000000000000000001'],
    ['a number that is too small for a double', '1e-400'],
    ['a number that is too large for a double', '1e999'],
    ['a long number with an exponent', '1.2345678901234567890e5'],
  ])('refuses %s', (_name, literal) => {
    expect(losses(`{"n":${literal}}`)).toBe(NUMBER);
    expect(losses(`[1,${literal}]`)).toBe(NUMBER);
  });

  it.each<string>([
    '0', '-0', '1', '-1', '42', '0.1', '-0.5', '0.30000000000000004', '1.0', '100', '1e21', '1E+21', '1e-7', '1.5e-7', '5e-324', '1.7976931348623157e308', '9007199254740991', '-9007199254740991',
    '0.000001', '0.0000001', '123456.789', '1e23', '2.5E2', '0.0', '10.50',
  ])('takes the number %s: it reads back as itself', (literal) => {
    expect(losses(`{"n":${literal}}`)).toBeNull();
    expect(losses(`[${literal},${literal}]`)).toBeNull();
  });

  it('does not take a digit inside a string for a number, and a number inside a key', () => {
    expect(losses('{"12345678901234567890":"9007199254740993","b":"1e999"}')).toBeNull();
  });

  it('refuses the key that stands two times before it looks at the numbers, and the other way round: each reason is named', () => {
    expect(losses('{"a":1,"a":2,"n":9007199254740993}')).toBe(DUPLICATE);
    expect(losses('{"n":9007199254740993,"a":1,"a":2}')).toBe(NUMBER);
  });
});

describe('losses: the texts that JSON.stringify writes', () => {
  /** A small generator with a fixed seed, so that every run reads the same values. */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const WORDS = ['a', 'b', 'lot', 'quantity', 'x,y', '{', '}', '"', '\\', '\u00e9', '\u2028', 'a"b', ''];

  function value(next: () => number, depth: number): JsonValue {
    const kind = Math.floor(next() * (depth > 3 ? 5 : 7));
    switch (kind) {
      case 0: return null;
      case 1: return next() < 0.5;
      case 2: return next() * 10 ** Math.floor(next() * 40 - 20) * (next() < 0.5 ? -1 : 1);
      case 3: return Math.floor(next() * 2 ** 53) * (next() < 0.5 ? -1 : 1);
      case 4: return WORDS[Math.floor(next() * WORDS.length)]! + WORDS[Math.floor(next() * WORDS.length)]!;
      case 5: return Array.from({ length: Math.floor(next() * 4) }, () => value(next, depth + 1));
      default: {
        const object: Record<string, JsonValue> = {};
        for (let index = 0; index < Math.floor(next() * 5); index += 1) object[WORDS[Math.floor(next() * WORDS.length)]! + String(index)] = value(next, depth + 1);
        return object;
      }
    }
  }

  it('takes every text that JSON.stringify writes for a value with its own keys: no text is refused that says one thing', () => {
    const next = random(20261120);
    for (let index = 0; index < 400; index += 1) {
      const json = JSON.stringify(value(next, 0));
      expect(losses(json), json).toBeNull();
    }
  });

  it('refuses the same texts when one number in them is written with a digit more than a double holds', () => {
    const next = random(7);
    for (let index = 0; index < 100; index += 1) {
      const before = JSON.stringify(value(next, 2));
      const after = JSON.stringify(value(next, 2));
      const lossy = `{"list":[${before},0.10000000000000001,${after}]}`;
      expect(losses(lossy), lossy).toBe(NUMBER);
      // The twin: the same text with the number that a double holds.
      const clean = `{"list":[${before},0.1,${after}]}`;
      expect(losses(clean), clean).toBeNull();
    }
  });
});

describe('readAnswer: an answer that says more than the value that it gives', () => {
  const any: ChoiceParser<JsonValue> = (given) => accepted(given);
  const completed = (text: string): { text: string; status: unknown } => ({ text, status: 'completed' });

  it.each<[string, string, string]>([
    ['a choice two times', '{"reasoning":"r","choice":{"accept":false},"choice":{"accept":true}}', DUPLICATE],
    ['a reasoning two times', '{"reasoning":"a","reasoning":"b","choice":1}', DUPLICATE],
    ['a member of the choice two times', '{"reasoning":"r","choice":{"lot":"lot-small","lot":"lot-large"}}', DUPLICATE],
    ['a quantity past the safe integers', '{"reasoning":"r","choice":{"quantity":9007199254740993}}', NUMBER],
    ['a score of more digits than a double holds', '{"reasoning":"r","choice":{"score":0.10000000000000001}}', NUMBER],
    ['a number that is too large', '{"reasoning":"r","choice":1e999}', NUMBER],
  ])('is model_output_invalid, and no decision is recorded: %s', (_name, text, why) => {
    const result = readAnswer(completed(text), any);
    expect(result).toMatchObject({ ok: false, code: 'model_output_invalid' });
    if (!result.ok) expect(result.detail).toBe(`the answer of the model ${why} (an answer of ${text.length} characters)`);
  });

  it('keeps the choice of an answer that says one thing, with a number that a double prints in full: the twin', () => {
    const choice = { ...MEDIUM_LOT, ratio: 0.30000000000000004, big: 9007199254740991, small: 5e-324 };
    expect(readAnswer(completed(said(choice)), any)).toMatchObject({ ok: true, value: { choice } });
  });
});
