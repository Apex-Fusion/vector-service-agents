// packages/usecase-kit/test/bids/weights.test.ts: the four weights of a ranking in use case 3 (supplier bid evaluation). A weight is a number from 0 to 1 with at most 4 decimal places, and the four sum to
// exactly 1. The parser counts in whole units of 1/10,000, so a sum of floats never decides: some float sums of valid weights are not exactly 1 in JavaScript, and some invalid sums are. The golden file
// is the example of the page. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WEIGHT_NAMES, parseWeights } from '@vsa/usecase-kit/bids';
import { MARKER, change, expectRefused, golden, goldenText, must, objectAt, withPrototype } from './support.ts';
import type { Json } from './support.ts';

/** The SHA-256 of the bytes of the golden file. A change of the file shows here. */
const GOLDEN_FILE_SHA256 = '440a254674054c9d8d0fc04f4bbb4cd51a96b4088882c81840c6822900ea9cb9';

const NAMES = ['price', 'lead_time', 'reliability', 'compliance'] as const;
type Four = readonly [number, number, number, number];

/** The weights as an object: the four numbers, in the order of the names. */
const weightsOf = (numbers: Four): Json => Object.fromEntries(NAMES.map((name, index) => [name, numbers[index]]));
/** The sum of the four numbers as a program adds them, left to right. */
const floatSum = (numbers: Four): number => numbers.reduce((total, next) => total + next, 0);

/** Weights that pass. The rows 6 and 7 have a float sum that is not exactly 1, one below and one above. */
const ACCEPTED: ReadonlyArray<readonly [string, Four]> = [
  ['the weights of the page', [0.4, 0.2, 0.2, 0.2]],
  ['four equal weights', [0.25, 0.25, 0.25, 0.25]],
  ['one weight of 1 on the first name', [1, 0, 0, 0]],
  ['one weight of 1 on the last name', [0, 0, 0, 1]],
  ['weights that rise by a tenth', [0.1, 0.2, 0.3, 0.4]],
  ['weights that fall by a tenth, with a float sum below 1', [0.4, 0.3, 0.2, 0.1]],
  ['weights with a float sum below 1', [0.3, 0.3, 0.3, 0.1]],
  ['weights with a float sum above 1', [0.2, 0.4, 0.3, 0.1]],
  ['weights of 4 decimal places', [0.3333, 0.3333, 0.3333, 0.0001]],
  ['the smallest unit', [0.0001, 0.9999, 0, 0]],
  ['a weight that a float cannot count exactly in units', [0.57, 0.43, 0, 0]],
  ['weights of 2 decimal places', [0.29, 0.58, 0.13, 0]],
];

describe('the golden weights', () => {
  it('is the file that the hash names, and it holds the four names in their order', () => {
    expect(createHash('sha256').update(goldenText('weights')).digest('hex')).toBe(GOLDEN_FILE_SHA256);
    expect(Object.keys(golden('weights'))).toStrictEqual([...NAMES]);
  });

  it('passes the parser, and the copy holds the same members in the same order', () => {
    const result = parseWeights(golden('weights'));
    expect(result).toStrictEqual({ ok: true, value: golden('weights') });
    expect(Object.keys(must(result))).toStrictEqual([...NAMES]);
  });

  it('gives a copy that shares no object with the input, and changes nothing of the input', () => {
    const input = golden('weights');
    const before = JSON.stringify(input);
    const weights = must(parseWeights(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(weights).not.toBe(input);
    expect(Object.getPrototypeOf(weights)).toBe(Object.prototype);
  });
});

describe('the weight names', () => {
  it('are the four weights of a ranking, in this order', () => {
    expect(WEIGHT_NAMES).toStrictEqual([...NAMES]);
  });
});

describe('parseWeights', () => {
  it.each(ACCEPTED)('takes %s', (_what, numbers) => {
    expect(parseWeights(weightsOf(numbers))).toStrictEqual({ ok: true, value: weightsOf(numbers) });
  });

  it('has a table with teeth: the float sum of some accepted weights is not exactly 1, and the sum of 0.4, 0.2, 0.2 and 0.2 is accepted in each order', () => {
    expect(floatSum([0.3, 0.3, 0.3, 0.1])).not.toBe(1);
    expect(floatSum([0.2, 0.4, 0.3, 0.1])).not.toBe(1);
    expect(floatSum([0.2, 0.4, 0.3, 0.1])).toBeGreaterThan(1);
    expect(floatSum([0.3, 0.3, 0.3, 0.1])).toBeLessThan(1);
    expect(ACCEPTED.some(([, numbers]) => floatSum(numbers) !== 1)).toBe(true);
    for (const numbers of [[0.4, 0.2, 0.2, 0.2], [0.2, 0.4, 0.2, 0.2], [0.2, 0.2, 0.4, 0.2], [0.2, 0.2, 0.2, 0.4]] as const) expect(parseWeights(weightsOf(numbers)).ok).toBe(true);
  });

  it('takes every weight of at most 4 decimal places from 0 to 1 with its complement, and the copy holds the number as it came', () => {
    const failed: number[] = [];
    for (let units = 0; units <= 10_000; units += 1) {
      const weight = Number((units / 10_000).toFixed(4));
      const rest = Number(((10_000 - units) / 10_000).toFixed(4));
      const result = parseWeights(weightsOf([weight, rest, 0, 0]));
      if (!result.ok || result.value.price !== weight || result.value.lead_time !== rest) failed.push(units);
    }
    expect(failed).toStrictEqual([]);
  });

  it('refuses a sum that is not 1 in whole units of 1/10,000: 0.9999 and 1.0001, and the twins', () => {
    const sums: ReadonlyArray<readonly [string, Four]> = [
      ['0.9999', [0.4, 0.2, 0.2, 0.1999]], ['0.9999 with four equal weights', [0.25, 0.25, 0.25, 0.2499]], ['0.9999 with thirds', [0.3333, 0.3333, 0.3333, 0]], ['1.0001', [0.4, 0.2, 0.2, 0.2001]],
      ['1.0001 with a weight of 0.5', [0.5, 0.5, 0.0001, 0]], ['1.0002', [0.3334, 0.3334, 0.3334, 0]], ['0', [0, 0, 0, 0]], ['2', [1, 1, 0, 0]], ['0.5', [0.5, 0, 0, 0]],
    ];
    for (const [what, numbers] of sums) {
      expectRefused(parseWeights(weightsOf(numbers)), 'weights');
      const result = parseWeights(weightsOf(numbers));
      expect(!result.ok && result.detail, what).toContain('sum');
    }
    for (const [, numbers] of ACCEPTED) expect(parseWeights(weightsOf(numbers)).ok).toBe(true);
  });

  it('decides the sum in whole units and never by a float compare: the same four weights pass in the order whose float sum is 1 and in the order whose float sum is not', () => {
    // 0.1 + 0.2 + 0.3 + 0.4 is 1 as floats, in this order, and the reverse order is 0.9999999999999999. The weights are the same, and so is the sum in units.
    expect(floatSum([0.1, 0.2, 0.3, 0.4])).toBe(1);
    expect(floatSum([0.4, 0.3, 0.2, 0.1])).not.toBe(1);
    expect(parseWeights(weightsOf([0.4, 0.3, 0.2, 0.1])).ok).toBe(true);
    expect(parseWeights(weightsOf([0.1, 0.2, 0.3, 0.4])).ok).toBe(true);
  });

  it.each([
    ['5 decimal places', 0.40001], ['5 decimal places, below the unit', 0.00001], ['6 decimal places', 0.000001], ['a number that rounds to zero units', 0.00004], ['the float sum 0.1 + 0.2', 0.1 + 0.2],
    ['a float that is next to 0.4', 0.4000000000000001], ['a number 1e-10 from a weight', 0.5000000001], ['a number 1e-11 from a weight', 0.50000000001], ['a number in the form with an exponent', 1e-7],
  ])('refuses the number %s in each member, because it has more than 4 decimal places, and takes the twin', (_what, weight) => {
    for (const name of NAMES) {
      const result = parseWeights(change(golden('weights'), [name], weight));
      expectRefused(result, `weights.${name}`);
      expect(!result.ok && result.detail).toContain('4 decimal places');
    }
    expect(parseWeights(golden('weights')).ok).toBe(true);
  });

  it.each([
    ['a negative number', -0.1], ['minus one unit', -0.0001], ['above 1', 1.0001], ['2', 2], ['a text', '0.4'], ['the empty text', ''], ['null', null], ['true', true], ['a list', [0.4]],
    ['an object', { value: 0.4 }], ['NaN', Number.NaN], ['infinity', Number.POSITIVE_INFINITY], ['negative infinity', Number.NEGATIVE_INFINITY], ['a bigint', 4n], ['a text with a line break', MARKER],
  ])('refuses %s in each member, and takes the twin', (_what, weight) => {
    for (const name of NAMES) expectRefused(parseWeights(change(golden('weights'), [name], weight)), `weights.${name}`);
    expect(parseWeights(golden('weights')).ok).toBe(true);
  });

  it('takes 0 and 1 as weights, and refuses a number just outside', () => {
    expect(parseWeights(weightsOf([0, 0, 0, 1])).ok).toBe(true);
    expect(parseWeights(weightsOf([1, 0, 0, 0])).ok).toBe(true);
    expectRefused(parseWeights(weightsOf([-0.0001, 0, 0, 1.0001])), 'weights.price');
    expectRefused(parseWeights(weightsOf([0, 0, 0, 1.0001])), 'weights.compliance');
  });

  it('reads the number minus zero as 0, so that the copy holds no sign that JSON does not write', () => {
    const weights = must(parseWeights(weightsOf([-0, 0.4, 0.3, 0.3])));
    expect(Object.is(weights.price, 0)).toBe(true);
    expect(JSON.stringify(weights)).toBe('{"price":0,"lead_time":0.4,"reliability":0.3,"compliance":0.3}');
    expect(Object.is(must(parseWeights(JSON.parse('{"price":-0,"lead_time":1,"reliability":0,"compliance":0}'))).price, 0)).toBe(true);
  });

  it.each(NAMES)('refuses weights with no member %s', (name) => {
    expectRefused(parseWeights(change(golden('weights'), [name], undefined)), name);
  });

  it('refuses a fifth member, and a member that is not a weight name, in the place of one of the four', () => {
    expectRefused(parseWeights(change(golden('weights'), ['extra'], 0)), 'extra');
    const named = change(change(golden('weights'), ['compliance'], undefined), ['delivery'], 0.2);
    expectRefused(parseWeights(named), 'compliance');
    expect(parseWeights(golden('weights')).ok).toBe(true);
  });

  it('refuses a name in another case or with another spelling, and a name of the prototype', () => {
    for (const name of ['Price', 'PRICE', 'lead-time', 'leadTime', 'lead_time ', 'constructor', 'toString']) {
      expectRefused(parseWeights(change(change(golden('weights'), ['price'], undefined), [name], 0.4)), 'price');
    }
  });

  it('gives the copy in the order of the names, whatever the order of the input', () => {
    const shuffled = { compliance: 0.2, reliability: 0.2, price: 0.4, lead_time: 0.2 };
    expect(Object.keys(must(parseWeights(shuffled)))).toStrictEqual([...NAMES]);
    expect(parseWeights(shuffled)).toStrictEqual({ ok: true, value: golden('weights') });
  });

  it.each([
    ['a list', []], ['a text', 'x'], ['null', null], ['a number', 1], ['undefined', undefined], ['true', true], ['a list of four numbers', [0.4, 0.2, 0.2, 0.2]],
  ])('refuses weights that are %s', (_what, value) => {
    expectRefused(parseWeights(value), 'weights');
  });

  it('names the field that the caller gives, and never repeats a value in a detail', () => {
    expectRefused(parseWeights(change(golden('weights'), ['price'], 0.5), 'request.weights'), 'request.weights');
    expectRefused(parseWeights(change(golden('weights'), ['lead_time'], 2), 'request.weights'), 'request.weights.lead_time');
    expectRefused(parseWeights(null, 'request.weights'), 'request.weights');
    for (const name of NAMES) expectRefused(parseWeights(change(golden('weights'), [name], MARKER)), 'weights');
    const result = parseWeights(change(golden('weights'), ['price'], 0.12345));
    expect(!result.ok && result.detail).not.toContain('0.12345');
  });
});

describe('a value that is not plain JSON data', () => {
  it.each(['price', 'compliance'])('refuses the member %s that is an accessor, and never runs the getter', (member) => {
    let reads = 0;
    const input = golden('weights');
    const value = input[member];
    Object.defineProperty(input, member, { get() { reads += 1; return value; }, enumerable: true, configurable: true });
    expectRefused(parseWeights(input), member);
    expect(reads).toBe(0);
    expect(parseWeights(golden('weights')).ok).toBe(true);
  });

  it('refuses the key __proto__, with a value that looks right, and the key that JSON.parse makes', () => {
    const input = golden('weights');
    Object.defineProperty(input, '__proto__', { value: { x: 1 }, enumerable: true, configurable: true, writable: true });
    expectRefused(parseWeights(input), '__proto__');
    expectRefused(parseWeights(JSON.parse('{"price":0.4,"lead_time":0.2,"reliability":0.2,"compliance":0.2,"__proto__":{"x":1}}')), '__proto__');
  });

  it('refuses a value that JSON cannot hold, and a key that is not a string or not enumerable', () => {
    expectRefused(parseWeights({ ...golden('weights'), extra: undefined }), 'extra');
    expectRefused(parseWeights({ ...golden('weights'), extra: () => 1 }), 'extra');
    expectRefused(parseWeights({ ...golden('weights'), [Symbol('x')]: 1 }), 'weights');
    const hidden = golden('weights');
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false, configurable: true });
    expectRefused(parseWeights(hidden), 'weights');
  });

  it('refuses a Proxy that throws and a Proxy that was revoked, and never throws', () => {
    const throws = new Proxy(golden('weights'), { ownKeys() { throw new Error('the Proxy refuses'); } });
    expect(() => parseWeights(throws)).not.toThrow();
    expectRefused(parseWeights(throws), 'weights');
    const { proxy, revoke } = Proxy.revocable(golden('weights'), {});
    revoke();
    expect(() => parseWeights(proxy)).not.toThrow();
    expectRefused(parseWeights(proxy), 'weights');
  });

  it('takes an object with no prototype, and refuses an object of a class', () => {
    const bare = Object.assign(Object.create(null) as Json, golden('weights'));
    expect(parseWeights(bare)).toStrictEqual({ ok: true, value: golden('weights') });
    class Weights {
      price = 0.4;
      lead_time = 0.2;
      reliability = 0.2;
      compliance = 0.2;
    }
    expectRefused(parseWeights(new Weights()), 'weights');
  });
});

describe('a prototype that was changed', () => {
  const PLAIN = parseWeights(golden('weights'));

  it.each([
    ['a setter for price on Object.prototype', 'price'], ['a setter for compliance on Object.prototype', 'compliance'], ['a setter for the index 0 on Object.prototype', '0'],
  ] as const)('with %s, the result is the result of the plain twin, and no setter runs', (_what, key) => {
    let calls = 0;
    const input = golden('weights');
    const seen = withPrototype(Object.prototype, { [key]: { set() { calls += 1; } } }, () => parseWeights(input));
    expect(seen).toStrictEqual(PLAIN);
    expect(calls).toBe(0);
  });

  it('reads no member that a prototype holds: weights with no own member are refused, and the copy has its own members', () => {
    const inherited = Object.fromEntries(NAMES.map((name) => [name, { value: 0.25, writable: true, enumerable: true }]));
    expect(withPrototype(Object.prototype, inherited, () => parseWeights({})).ok).toBe(false);
    const weights = must(PLAIN);
    for (const name of NAMES) expect(Object.hasOwn(weights, name)).toBe(true);
    expect(Object.keys(objectAt(golden('weights'), []))).toStrictEqual([...NAMES]);
  });
});
