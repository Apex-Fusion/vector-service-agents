// The readers of JSON that comes from outside. Each refusal has an accepted twin. A value of the wrong type is an error that names its path: it is never a default and never a cut number.
import { describe, expect, it } from 'vitest';
import { Invalid, amount, date, did, domain, fields, flag, hex64, id, isJsonObject, list, oneOf, outRef, ratio, text, unique, whole } from '../src/validate.ts';

const problem = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Invalid);
    return (error as Invalid).message;
  }
  throw new Error('the reader accepted the value');
};

describe('fields', () => {
  it('takes an object with the named fields, and gives it back', () => {
    expect(fields('body', { a: 1, b: 2 }, ['a'], ['b'])).toEqual({ a: 1, b: 2 });
    expect(fields('body', { a: 1 }, ['a'], ['b'])).toEqual({ a: 1 });
  });
  it('refuses a field that is not named, a missing field and a value that is no object', () => {
    expect(problem(() => fields('body', { a: 1, c: 3 }, ['a']))).toBe('body.c is not a field of this object');
    expect(problem(() => fields('body', {}, ['a']))).toBe('body.a is required');
    for (const bad of [null, [], 'text', 7, true, undefined]) expect(problem(() => fields('body', bad, []))).toBe('body must be a JSON object');
  });
  it('refuses a key that would reach the prototype: it is an own field of a parsed object, and it is not named', () => {
    const parsed: unknown = JSON.parse('{"a":1,"__proto__":{"admin":true}}');
    expect(problem(() => fields('body', parsed, ['a']))).toBe('body.__proto__ is not a field of this object');
  });
  it('knows a JSON object', () => {
    expect(isJsonObject({})).toBe(true);
    for (const bad of [null, [], 'x', 1]) expect(isJsonObject(bad)).toBe(false);
  });
});

describe('text', () => {
  it('takes a text of the length, with a line break and a tab', () => {
    expect(text('t', 'a b\nc\td', { max: 10 })).toBe('a b\nc\td');
    expect(text('t', 'a b\nc\td\r\ne', { max: 10 })).toBe('a b\nc\td\r\ne');
    expect(text('t', '', { min: 0, max: 3 })).toBe('');
  });
  it('refuses another type, a text that is too short or too long, and a control character', () => {
    for (const bad of [1, null, undefined, {}, ['a'], true]) expect(problem(() => text('t', bad, { max: 5 }))).toBe('t must be a text');
    expect(problem(() => text('t', '', { max: 5 }))).toBe('t must have 1 to 5 characters');
    expect(problem(() => text('t', 'abcdef', { max: 5 }))).toBe('t must have 1 to 5 characters');
    expect(problem(() => text('t', 'ab', { min: 3, max: 3 }))).toBe('t must have 3 characters');
    for (const bad of ['a\u0000b', 'a\u001bb', 'a\u007fb', 'a\u000bb']) expect(problem(() => text('t', bad, { max: 9 }))).toBe('t must not hold a control character');
  });
  it('matches a pattern on the whole text', () => {
    expect(problem(() => text('t', 'ab1', { max: 9, pattern: /^[a-z]+$/, words: 'must be letters' }))).toBe('t must be letters');
    expect(text('t', 'ab', { max: 9, pattern: /^[a-z]+$/ })).toBe('ab');
  });
});

describe('the identifiers', () => {
  it('id: 1 to 64 letters, digits, dots, hyphens and underscores, and it starts with a letter or a digit', () => {
    for (const ok of ['a', 'GLV-NIT-M', 'a.b_c-d', '9', 'a'.repeat(64)]) expect(id('x', ok)).toBe(ok);
    for (const bad of ['', '-a', '.a', '_a', 'a b', 'a/b', 'a'.repeat(65), 'é', 'a\u0000']) expect(() => id('x', bad)).toThrow(Invalid);
  });
  it('hex64, did and outRef have the forms of the protocol, in lower case', () => {
    expect(hex64('x', 'ab'.repeat(32))).toBe('ab'.repeat(32));
    expect(() => hex64('x', 'AB'.repeat(32))).toThrow(Invalid);
    expect(() => hex64('x', 'ab'.repeat(31))).toThrow(Invalid);
    expect(did('x', `did:vector:${'cd'.repeat(32)}`)).toBe(`did:vector:${'cd'.repeat(32)}`);
    for (const bad of [`did:vector:${'CD'.repeat(32)}`, `did:vector:${'cd'.repeat(31)}`, `DID:vector:${'cd'.repeat(32)}`, `did:vector:agent:${'cd'.repeat(32)}`]) expect(() => did('x', bad)).toThrow(Invalid);
    expect(outRef('x', `${'ef'.repeat(32)}#0`)).toBe(`${'ef'.repeat(32)}#0`);
    expect(outRef('x', `${'ef'.repeat(32)}#12`)).toBe(`${'ef'.repeat(32)}#12`);
    for (const bad of [`${'ef'.repeat(32)}#`, `${'ef'.repeat(32)}#01`, `${'ef'.repeat(32)}#-1`, `${'ef'.repeat(32)}`, `${'EF'.repeat(32)}#0`]) expect(() => outRef('x', bad)).toThrow(Invalid);
  });
  it('domain: a domain name in lower case, at most 64 characters, at least two labels', () => {
    for (const ok of ['alfa.example.org', 'a.b', 'x-1.y-2.example.test']) expect(domain('x', ok)).toBe(ok);
    for (const bad of ['localhost', 'Alfa.example.org', 'alfa..example.org', '-a.example.org', 'a-.example.org', 'a.example.org.', `${'a'.repeat(30)}.${'b'.repeat(30)}.org`, 'a b.example.org', '', 7]) {
      expect(() => domain('x', bad), JSON.stringify(bad)).toThrow(Invalid);
    }
  });
});

describe('numbers, flags and dates', () => {
  it('whole: a whole number inside its bounds, and nothing else', () => {
    expect(whole('n', 5, 0, 10)).toBe(5);
    expect(whole('n', 0, 0, 10)).toBe(0);
    for (const bad of ['5', 5.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -1, 11, null, undefined, true, [5]]) expect(() => whole('n', bad, 0, 10), String(bad)).toThrow(Invalid);
  });
  it('ratio: a number from 0 to 1; amount: a number of at least 0 and at most its maximum', () => {
    expect(ratio('r', 0.97)).toBe(0.97);
    expect(ratio('r', 0)).toBe(0);
    expect(ratio('r', 1)).toBe(1);
    for (const bad of [1.01, -0.1, Number.NaN, '0.5', null]) expect(() => ratio('r', bad)).toThrow(Invalid);
    expect(amount('a', 12.5, 100)).toBe(12.5);
    for (const bad of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY, '12']) expect(() => amount('a', bad, 100)).toThrow(Invalid);
  });
  it('flag: true or false, never a text', () => {
    expect(flag('f', true)).toBe(true);
    expect(flag('f', false)).toBe(false);
    for (const bad of ['true', 'false', 0, 1, null, undefined, {}]) expect(problem(() => flag('f', bad))).toBe('f must be true or false');
  });
  it('date: a calendar date that exists, as YYYY-MM-DD', () => {
    expect(date('d', '2026-02-28')).toBe('2026-02-28');
    expect(date('d', '2028-02-29')).toBe('2028-02-29');
    for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-2-3', '2026-02-28T00:00:00Z', '28-02-2026', 20260228, null]) expect(() => date('d', bad), String(bad)).toThrow(Invalid);
  });
});

describe('lists', () => {
  it('list: a list of the size, each item read and named by its place', () => {
    expect(list('l', [1, 2], 1, 3, (path, v) => whole(path, v, 0, 9))).toEqual([1, 2]);
    expect(problem(() => list('l', [1, 'x'], 1, 3, (path, v) => whole(path, v, 0, 9)))).toBe('l[1] must be a whole number from 0 to 9');
    expect(problem(() => list('l', [], 1, 3, (path, v) => whole(path, v, 0, 9)))).toBe('l must have 1 to 3 items');
    expect(problem(() => list('l', [1, 2, 3, 4], 1, 3, (path, v) => whole(path, v, 0, 9)))).toBe('l must have 1 to 3 items');
    for (const bad of [null, {}, 'ab', 4]) expect(problem(() => list('l', bad, 0, 3, (path, v) => v))).toBe('l must be a list');
  });
  it('oneOf: a member of the list', () => {
    expect(oneOf('o', 'b', ['a', 'b'] as const)).toBe('b');
    expect(problem(() => oneOf('o', 'c', ['a', 'b'] as const))).toBe('o must be one of a, b');
    expect(() => oneOf('o', undefined, ['a', 'b'] as const)).toThrow(Invalid);
  });
  it('unique: refuses a key that two entries have', () => {
    expect(() => unique('l', [{ k: 'a' }, { k: 'b' }], (e) => e.k, 'key')).not.toThrow();
    expect(problem(() => unique('l', [{ k: 'a' }, { k: 'a' }], (e) => e.k, 'key'))).toBe('l has the key a two times');
  });
});
