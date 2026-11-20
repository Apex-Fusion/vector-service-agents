// packages/usecase-kit/test/decision/where.test.ts: where a value is not JSON data, said with no key and no value. The input of a decision, the answer of a model and the receipt of a supplier can hold
// a key that repeats secret text. A detail names the depth at which the protocol refuses a value or a key. The root is depth 1, and a member of the root is at depth 2.
import { describe, expect, it } from 'vitest';
import { parseJsonValue } from '@vsa/usecase-kit/protocol';
import { whereNotJson } from '../../src/decision/where.ts';

const MARKER = 'ZQ9-marker-7f3';
const at = (depth: number): string => `holds, at depth ${depth}, a value or a key that JSON data does not allow`;
const TOO_DEEP = 'is nested deeper than 32 levels';

/** `levels` lists, one in the other, around `leaf`. The outer list is level 1. */
function nest(levels: number, leaf: unknown): unknown {
  let value = leaf;
  for (let level = 0; level < levels; level += 1) value = [value];
  return value;
}

describe('whereNotJson: the depth of the value that the protocol refuses', () => {
  it.each<[string, unknown, string]>([
    ['undefined', undefined, at(1)],
    ['a function', () => 1, at(1)],
    ['a bigint', 1n, at(1)],
    ['a number that is not finite', Number.NaN, at(1)],
    ['an object of a class', new Map(), at(1)],
    ['a date', new Date(0), at(1)],
    ['a member of the root that is a bigint', { a: 1, b: 12n }, at(2)],
    ['an element of a list in a list in a member', { a: [1, [2, undefined]] }, at(4)],
    ['a number that is not finite in the third level', { a: { b: Number.POSITIVE_INFINITY } }, at(3)],
    ['an object of a class in the third level', { a: { b: new Date(0) } }, at(3)],
    ['a hole in a list', { a: [1, , 3] }, at(2)],
    ['an accessor member', { get a(): number { return 1; } }, at(1)],
    ['a key that is a symbol', { [Symbol('key')]: 1 }, at(1)],
    ['a member that is not enumerable', Object.defineProperty({}, 'x', { value: 1, enumerable: false }), at(1)],
  ])('says the depth of %s', (_name, value, sentence) => {
    expect(parseJsonValue(value).ok).toBe(false);
    expect(whereNotJson(value)).toBe(sentence);
  });

  it.each<[string, unknown, string]>([
    ['the key __proto__ in the root', JSON.parse('{"__proto__":1}'), at(1)],
    ['the key __proto__ in the object of a member', { a: JSON.parse('{"__proto__":1}') }, at(2)],
    ['a key that is a whole number in the third level', { a: { b: { 7: 1 } } }, at(3)],
    ['a key that is not in the NFC form in the second level', { [MARKER]: { 'cafe\u0301': 1 } }, at(2)],
    ['a key that is not in the NFC form in the root', { 'cafe\u0301': 1 }, at(1)],
  ])('says the depth of the object that has %s, and not the key', (_name, value, sentence) => {
    expect(parseJsonValue(value).ok).toBe(false);
    expect(whereNotJson(value)).toBe(sentence);
  });

  it('reports the member before the keys of the object that holds it: the walk goes deep before it goes wide', () => {
    // The key 7 is refused at depth 1, and the bigint at depth 2. The bigint is the first place.
    expect(whereNotJson({ bad: 1n, 7: 1 })).toBe(at(2));
  });

  it('never runs a getter, and never throws, also for a Proxy that throws', () => {
    let ran = false;
    expect(whereNotJson({ get a(): number { ran = true; return 1; } })).toBe(at(1));
    expect(ran).toBe(false);
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error(MARKER); }, getPrototypeOf: () => { throw new Error(MARKER); } });
    expect(whereNotJson(hostile)).toBe(at(1));
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(whereNotJson(revoked.proxy)).toBe(at(1));
  });
});

describe('whereNotJson: a value that is nested too deep', () => {
  it('says that the value is nested too deep when a list stands at level 33: 33 levels are refused', () => {
    expect(parseJsonValue(nest(33, 1)).ok).toBe(false);
    expect(whereNotJson(nest(33, 1))).toBe(TOO_DEEP);
    expect(whereNotJson(nest(40, 1))).toBe(TOO_DEEP);
  });

  it('says the depth, and not "too deep", for a value that stands at depth 33 inside 32 levels: 32 levels are taken', () => {
    expect(parseJsonValue(nest(32, 1)).ok).toBe(true);
    expect(whereNotJson(nest(32, undefined))).toBe(at(33));
  });

  it('ends for a value that holds itself', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(whereNotJson(loop)).toBe(TOO_DEEP);
    const list: unknown[] = [];
    list.push(list);
    expect(whereNotJson(list)).toBe(TOO_DEEP);
  });
});

describe('whereNotJson: no key and no value in the sentence', () => {
  it.each<[string, unknown]>([
    ['a key above a bigint', { [MARKER]: { [MARKER]: 1n } }],
    ['a key above a key that is a whole number', { [MARKER]: { [MARKER]: { 7: 1 } } }],
    ['a key above the key __proto__', { [MARKER]: JSON.parse(`{"${MARKER}":{"__proto__":1}}`) }],
    ['a value that is a text', { [MARKER]: [MARKER, undefined] }],
    ['keys and values that are deep', nest(40, { [MARKER]: MARKER })],
  ])('has none of the marker for %s', (_name, value) => {
    const sentence = whereNotJson(value);
    expect(sentence).not.toContain(MARKER);
    expect(sentence).toMatch(/^(holds, at depth \d+, a value or a key that JSON data does not allow|is nested deeper than 32 levels)$/);
  });

  it('gives the plain sentence for a value that the protocol takes: the twin of the cases above', () => {
    const value = { a: [1, 'x', null, true, { b: 2 }], [MARKER]: 'text' };
    expect(parseJsonValue(value).ok).toBe(true);
    expect(whereNotJson(value)).toBe('is not JSON data');
  });
});
