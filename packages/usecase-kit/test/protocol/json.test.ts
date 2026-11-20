// packages/usecase-kit/test/protocol/json.test.ts: what the protocol takes as a JSON value and as a document. The digest of a document binds the document, so a value that the canonical form
// cannot tell from another value is refused. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { MAX_DOCUMENT_DEPTH, isPlainObject, parseDocument, parseJsonText, parseJsonValue } from '@vsa/usecase-kit/protocol';
import { MARKER } from './support.ts';

/** n nested containers: the outer one is level 1. */
const nestObjects = (n: number): unknown => (n === 0 ? 'leaf' : { k: nestObjects(n - 1) });
const nestArrays = (n: number): unknown => (n === 0 ? 'leaf' : [nestArrays(n - 1)]);

class Thing {
  readonly a = 1;
}

describe('MAX_DOCUMENT_DEPTH', () => {
  it('is 32 levels of objects and arrays', () => {
    expect(MAX_DOCUMENT_DEPTH).toBe(32);
  });
});

describe('isPlainObject', () => {
  it('takes a plain object and an object with no prototype', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(JSON.parse('{"a":[1]}'))).toBe(true);
  });

  it('refuses everything else', () => {
    for (const value of [null, undefined, 0, 'a', true, [], [1], new Date(0), new Map(), new Thing(), () => 1, Symbol('s'), 1n]) expect(isPlainObject(value)).toBe(false);
  });
});

describe('parseJsonValue takes JSON data and returns the same value', () => {
  const takes: ReadonlyArray<readonly [string, unknown]> = [
    ['null', null],
    ['true', true],
    ['false', false],
    ['zero', 0],
    ['negative zero', -0],
    ['an integer', 42],
    ['a negative integer', -7],
    ['a decimal', 87.5],
    ['the largest double', Number.MAX_VALUE],
    ['the smallest double', Number.MIN_VALUE],
    ['an empty string', ''],
    ['a string with quotes, a backslash and a line break', 'a"b\\c\nd'],
    ['a string with a lone surrogate', '\ud800'],
    ['an empty array', []],
    ['an array of mixed values', [1, 'a', null, true, [2], { b: 3 }]],
    ['an empty object', {}],
    ['an object with no prototype', Object.assign(Object.create(null) as object, { a: 1 })],
    ['a nested object', { a: { b: [{ c: 'd' }] } }],
    ['keys that are not whole numbers', { '01': 1, '-1': 2, '1.5': 3, a1: 4, '1a': 5, '': 6 }],
    ['a key in the NFC form, and a plain letter', { '\u00e9': 1, e: 2 }],
    ['a key with a combining mark that has no composed form, which is in the NFC form', { 'q\u0301': 1 }],
    ['a value in the NFD form, which the canonical form changes and the check takes', { a: 'e\u0301' }],
    ['a key named like an inherited member', { constructor: 1, toString: 2, hasOwnProperty: 3 }],
    ['an object that JSON.parse made', JSON.parse('{"a":[1,2,{"b":null}],"c":"d"}')],
  ];

  it.each(takes)('takes %s', (_name, value) => {
    const result = parseJsonValue(value);
    expect(result).toStrictEqual({ ok: true, value });
    expect(result.ok && result.value).toBe(value);
  });

  it('takes a document as deep as the limit', () => {
    expect(parseJsonValue(nestObjects(MAX_DOCUMENT_DEPTH)).ok).toBe(true);
    expect(parseJsonValue(nestArrays(MAX_DOCUMENT_DEPTH)).ok).toBe(true);
  });

  it('takes a wide array quickly', () => {
    const wide = Array.from({ length: 200_000 }, (_, i) => i);
    const started = Date.now();
    expect(parseJsonValue(wide).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('parseJsonValue refuses what JSON cannot hold, or what the canonical form cannot tell from another value', () => {
  const sparse: unknown[] = [1, 2, 3];
  delete sparse[1];
  const hidden = Object.defineProperty({ a: 1 }, 'b', { value: 2, enumerable: false });
  const symbolKey = { a: 1, [Symbol('k')]: 2 };
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  const circularArray: unknown[] = [];
  circularArray.push(circularArray);

  const refuses: ReadonlyArray<readonly [string, unknown]> = [
    ['undefined', undefined],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['a bigint', 1n],
    ['not a number', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['minus infinity', Number.NEGATIVE_INFINITY],
    ['a number that JSON.parse made infinite', JSON.parse('1e999')],
    ['a date', new Date(0)],
    ['a map', new Map()],
    ['a set', new Set()],
    ['a regular expression', /a/],
    ['a typed array', new Uint8Array(2)],
    ['an object of a class', new Thing()],
    ['an object with an undefined member', { a: undefined }],
    ['an object with a function member', { a: () => 1 }],
    ['an array with an undefined entry', [1, undefined]],
    ['an array with a hole', sparse],
    ['an object with a key that is a symbol', symbolKey],
    ['an object with a member that is not enumerable', hidden],
    ['an object that holds itself', circular],
    ['an array that holds itself', circularArray],
    ['a document one level deeper than the limit (objects)', nestObjects(MAX_DOCUMENT_DEPTH + 1)],
    ['a document one level deeper than the limit (arrays)', nestArrays(MAX_DOCUMENT_DEPTH + 1)],
    ['a document of 100000 levels', JSON.parse(`${'['.repeat(100_000)}${']'.repeat(100_000)}`)],
    ['the key __proto__', JSON.parse('{"__proto__":{"a":1}}')],
    ['the key __proto__ with a plain value', JSON.parse('{"a":1,"__proto__":2}')],
    ['the key __proto__ in a nested object', JSON.parse('{"a":[{"b":{"__proto__":null}}]}')],
    ['the key 0', JSON.parse('{"0":"a"}')],
    ['the key 12', JSON.parse('{"a":1,"12":2}')],
    ['a key that is a large whole number', JSON.parse('{"4294967295":1}')],
    ['a key that is a very large whole number', JSON.parse('{"123456789012345678901234567890":1}')],
    ['a whole number key in a nested object', JSON.parse('{"a":{"b":[{"7":1}]}}')],
    ['a key in the NFD form', JSON.parse('{"e\u0301":1}')],
    ['a key in the NFD form, deep', JSON.parse('{"a":[{"\u00e9":1,"a\u030a":2}]}')],
    ['a key in the NFD form with a letter that has a composed form', JSON.parse('{"A\u0308":1}')],
  ];

  it.each(refuses)('refuses %s with bad_shape', (_name, value) => {
    const result = parseJsonValue(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('bad_shape');
      expect(result.detail).toContain('value');
    }
  });

  it('does not throw on any of them', () => {
    for (const [, value] of refuses) expect(() => parseJsonValue(value)).not.toThrow();
  });

  it('names the path of the member that failed', () => {
    const result = parseJsonValue({ a: [{ b: 1 }, { c: Number.NaN }] }, 'document');
    expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(!result.ok && result.detail).toContain('document.a[1].c');
    const key = parseJsonValue({ a: { '5': 1 } }, 'document');
    expect(!key.ok && key.detail).toContain('document.a');
  });

  it('keeps the detail short and never repeats a long key or a value', () => {
    const longKey = 'k'.repeat(5_000);
    const result = parseJsonValue({ [longKey]: [MARKER, Number.NaN] }, 'document');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail.length).toBeLessThan(400);
      expect(result.detail).not.toContain(MARKER);
    }
  });
});

describe('parseDocument takes a JSON object and nothing else', () => {
  it('takes an object and returns the same object', () => {
    const document = { schema: 'vector.usecase.po.v1', quantity: 50, lines: [{ sku: 'a' }] };
    const result = parseDocument(document);
    expect(result).toStrictEqual({ ok: true, value: document });
    expect(result.ok && result.value).toBe(document);
  });

  it('takes an empty object', () => {
    expect(parseDocument({}).ok).toBe(true);
  });

  it.each([
    ['an array', [1]],
    ['an empty array', []],
    ['null', null],
    ['a string', '{"a":1}'],
    ['a number', 1],
    ['true', true],
    ['undefined', undefined],
    ['a date', new Date(0)],
  ])('refuses %s', (_name, value) => {
    const result = parseDocument(value);
    expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(!result.ok && result.detail).toContain('document must be a JSON object');
  });

  it('refuses an object that holds a value that JSON cannot hold, and names the path', () => {
    const result = parseDocument({ a: { b: undefined } });
    expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(!result.ok && result.detail).toContain('document.a.b');
  });

  it('names the field that it was given', () => {
    const result = parseDocument([], 'proposal.document');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain('proposal.document');
  });
});

describe('parseJsonText', () => {
  it('reads JSON text and returns the value', () => {
    expect(parseJsonText('{"a":[1,null]}')).toStrictEqual({ ok: true, value: { a: [1, null] } });
    expect(parseJsonText('[]')).toStrictEqual({ ok: true, value: [] });
    expect(parseJsonText('"text"')).toStrictEqual({ ok: true, value: 'text' });
    expect(parseJsonText('null')).toStrictEqual({ ok: true, value: null });
  });

  it.each(['', ' ', 'not json', '{', '{"a":1', "{'a':1}", '{"a":1,}', '[1,]', 'undefined', 'NaN', '{"a":1} x'])('refuses the text %j', (text) => {
    expect(parseJsonText(text)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it.each([undefined, null, 1, {}, [], Buffer.from('{}')])('refuses a value that is not text', (value) => {
    expect(parseJsonText(value)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('reads very deep JSON without throwing, and the deep value is then refused as a document', () => {
    const text = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    const parsed = parseJsonText(text);
    expect(() => parseJsonText(text)).not.toThrow();
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parseJsonValue(parsed.value).ok).toBe(false);
  });

  it('names the field and never repeats the text', () => {
    const result = parseJsonText(`not ${MARKER}`, 'request');
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.detail).toContain('request');
    expect(!result.ok && result.detail).not.toContain(MARKER);
  });
});
