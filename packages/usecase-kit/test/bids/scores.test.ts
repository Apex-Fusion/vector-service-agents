// packages/usecase-kit/test/bids/scores.test.ts: the scores of use case 3 (supplier bid evaluation). A scorer gives four component scores, one for each weight name, and one score for the quote. Each is a
// finite number from 0 to 100. The parsers check the form and never compute a score: the model decides the numbers, and no code checks that the score follows from the components and the weights. Each
// refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { SCORE_COMPONENTS, WEIGHT_NAMES, parseComponents, parseScoreValue } from '@vsa/usecase-kit/bids';
import { FAULT_EFFECTS, faultGap } from '@vsa/usecase-kit/manifest';
import { MARKER, change, expectRefused, must, objectAt, withPrototype } from './support.ts';
import type { Json } from './support.ts';

const NAMES = ['price', 'lead_time', 'reliability', 'compliance'] as const;
type Four = readonly [number, number, number, number];

/** The components as an object: the four numbers, in the order of the names. */
const componentsOf = (numbers: Four): Json => Object.fromEntries(NAMES.map((name, index) => [name, numbers[index]]));
/** The components of the page: a fresh object for each test. */
const sample = (): Json => componentsOf([90, 80, 85, 100]);

/** Components that pass. The numbers are numbers of a score: no unit and no decimal rule. */
const ACCEPTED: ReadonlyArray<readonly [string, Four]> = [
  ['the components of the page', [90, 80, 85, 100]],
  ['four zeros', [0, 0, 0, 0]],
  ['four hundreds', [100, 100, 100, 100]],
  ['one 100 and three zeros', [0, 0, 100, 0]],
  ['fractions', [87.5, 0.25, 99.99, 12.345]],
  ['a number next to each bound', [0.0001, 99.9999, 1e-7, 100]],
  ['a number that has no short decimal form', [1 / 3, 2 / 3, 0.1 + 0.2, 99.99999999999999]],
];

describe('the score components', () => {
  it('are the four names of the weights, in this order', () => {
    expect(SCORE_COMPONENTS).toStrictEqual([...NAMES]);
    expect(SCORE_COMPONENTS).toStrictEqual([...WEIGHT_NAMES]);
  });
});

describe('parseScoreValue', () => {
  it.each([0, 100, 87.5, 50, 0.0001, 99.9999, 1e-7, Number.MIN_VALUE, 1 / 3, 99.99999999999999])('takes the number %s as it is', (score) => {
    expect(parseScoreValue(score)).toStrictEqual({ ok: true, value: score });
  });

  it.each([
    ['a little above 100', 100.0001], ['the next number above 100', 100.00000000000001], ['101', 101], ['a thousand', 1000], ['a little below 0', -0.0001], ['minus one', -1], ['a number below 0 that is tiny', -Number.MIN_VALUE],
    ['NaN', Number.NaN], ['infinity', Number.POSITIVE_INFINITY], ['negative infinity', Number.NEGATIVE_INFINITY], ['the largest number', Number.MAX_VALUE],
    ['a text of a number', '50'], ['the empty text', ''], ['null', null], ['undefined', undefined], ['true', true], ['false', false], ['a list', [50]], ['an object', { value: 50 }], ['a bigint', 50n],
    ['a text with a line break', MARKER],
  ])('refuses %s, and takes the twin', (_what, score) => {
    expectRefused(parseScoreValue(score), 'score');
    expect(parseScoreValue(50).ok).toBe(true);
  });

  it('takes the bounds 0 and 100, and refuses a number just outside them', () => {
    expect(parseScoreValue(0).ok).toBe(true);
    expect(parseScoreValue(100).ok).toBe(true);
    expect(parseScoreValue(100.0001).ok).toBe(false);
    expect(parseScoreValue(-0.0001).ok).toBe(false);
  });

  it('reads the number minus zero as 0, so that the copy holds no sign that JSON does not write', () => {
    const score = must(parseScoreValue(-0));
    expect(Object.is(score, 0)).toBe(true);
    expect(JSON.stringify(score)).toBe('0');
  });

  it('names the field that the caller gives, names `score` when it gives none, and never repeats the value', () => {
    expectRefused(parseScoreValue(101, 'scorer.score'), 'scorer.score');
    expectRefused(parseScoreValue(101), 'score');
    const result = parseScoreValue(123456.789);
    expect(!result.ok && result.detail).not.toContain('123456');
    const text = parseScoreValue(MARKER, 'ranked[0].score');
    expectRefused(text, 'ranked[0].score');
  });
});

describe('parseComponents', () => {
  it.each(ACCEPTED)('takes %s, and the copy holds the numbers as they came', (_what, numbers) => {
    expect(parseComponents(componentsOf(numbers))).toStrictEqual({ ok: true, value: componentsOf(numbers) });
  });

  it('gives the copy in the order of the names, whatever the order of the input', () => {
    const shuffled = { compliance: 100, reliability: 85, price: 90, lead_time: 80 };
    expect(Object.keys(must(parseComponents(shuffled)))).toStrictEqual([...NAMES]);
    expect(parseComponents(shuffled)).toStrictEqual({ ok: true, value: sample() });
  });

  it('gives a copy that shares no object with the input, and changes nothing of the input', () => {
    const input = sample();
    const before = JSON.stringify(input);
    const components = must(parseComponents(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(components).not.toBe(input);
    expect(Object.getPrototypeOf(components)).toBe(Object.prototype);
    for (const name of NAMES) expect(Object.hasOwn(components, name)).toBe(true);
  });

  it.each(NAMES)('refuses a number outside 0 to 100, and a value that is not a number, in the member %s, and takes the twins', (name) => {
    for (const bad of [100.0001, -0.0001, 101, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '90', null, true, [90], { value: 90 }, 90n, MARKER]) {
      expectRefused(parseComponents(change(sample(), [name], bad)), `components.${name}`);
    }
    for (const good of [0, 100, 87.5]) expect(parseComponents(change(sample(), [name], good)).ok).toBe(true);
  });

  it('refuses a member that is a function, which JSON cannot hold, and takes the twin', () => {
    for (const name of NAMES) expectRefused(parseComponents(change(sample(), [name], () => 1)), `components.${name}`);
    expect(parseComponents(sample()).ok).toBe(true);
  });

  it.each(NAMES)('refuses components with no member %s, and names it', (name) => {
    expectRefused(parseComponents(change(sample(), [name], undefined)), name);
    expect(parseComponents(sample()).ok).toBe(true);
  });

  it('refuses a fifth member, and a member that is not a component name in the place of one of the four', () => {
    expectRefused(parseComponents(change(sample(), ['extra'], 50)), 'extra');
    const named = change(change(sample(), ['compliance'], undefined), ['delivery'], 100);
    expectRefused(parseComponents(named), 'compliance');
    expect(parseComponents(sample()).ok).toBe(true);
  });

  it('refuses a name in another case or with another spelling, and a name of the prototype', () => {
    for (const name of ['Price', 'PRICE', 'lead-time', 'leadTime', 'lead_time ', 'constructor', 'toString']) {
      expectRefused(parseComponents(change(change(sample(), ['price'], undefined), [name], 90)), 'price');
    }
  });

  it.each([
    ['a list', []], ['a text', 'x'], ['null', null], ['a number', 1], ['undefined', undefined], ['true', true], ['a list of four numbers', [90, 80, 85, 100]],
  ])('refuses components that are %s', (_what, value) => {
    expectRefused(parseComponents(value), 'components');
  });

  it('reads the number minus zero as 0 in each member', () => {
    for (const name of NAMES) {
      const components = must(parseComponents(change(sample(), [name], -0)));
      expect(Object.is(components[name], 0), name).toBe(true);
    }
  });

  it('names the field that the caller gives, and never repeats a value in a detail', () => {
    expectRefused(parseComponents(null, 'scorer.components'), 'scorer.components');
    expectRefused(parseComponents(change(sample(), ['lead_time'], 101), 'scorer.components'), 'scorer.components.lead_time');
    expectRefused(parseComponents(change(sample(), ['extra'], 5), 'scorer.components'), 'scorer.components');
    const result = parseComponents(change(sample(), ['price'], 123456.789));
    expect(!result.ok && result.detail).not.toContain('123456');
  });
});

describe('a value that is not plain JSON data', () => {
  it.each(['price', 'compliance'])('refuses the member %s that is an accessor, and never runs the getter', (member) => {
    let reads = 0;
    const input = sample();
    const value = input[member];
    Object.defineProperty(input, member, { get() { reads += 1; return value; }, enumerable: true, configurable: true });
    expectRefused(parseComponents(input), member);
    expect(reads).toBe(0);
    expect(parseComponents(sample()).ok).toBe(true);
  });

  it('refuses the key __proto__, with a value that looks right, and the key that JSON.parse makes', () => {
    const input = sample();
    Object.defineProperty(input, '__proto__', { value: { x: 1 }, enumerable: true, configurable: true, writable: true });
    expectRefused(parseComponents(input), '__proto__');
    expectRefused(parseComponents(JSON.parse('{"price":90,"lead_time":80,"reliability":85,"compliance":100,"__proto__":{"x":1}}')), '__proto__');
  });

  it('refuses a key that is not a string or not enumerable', () => {
    expectRefused(parseComponents({ ...sample(), [Symbol('x')]: 1 }), 'components');
    const hidden = sample();
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false, configurable: true });
    expectRefused(parseComponents(hidden), 'components');
  });

  it('refuses a Proxy that throws and a Proxy that was revoked, and never throws', () => {
    const throws = new Proxy(sample(), { ownKeys() { throw new Error('the Proxy refuses'); } });
    expect(() => parseComponents(throws)).not.toThrow();
    expectRefused(parseComponents(throws), 'components');
    const { proxy, revoke } = Proxy.revocable(sample(), {});
    revoke();
    expect(() => parseComponents(proxy)).not.toThrow();
    expectRefused(parseComponents(proxy), 'components');
  });

  it('takes an object with no prototype, and refuses an object of a class', () => {
    const bare = Object.assign(Object.create(null) as Json, sample());
    expect(parseComponents(bare)).toStrictEqual({ ok: true, value: sample() });
    class Scores {
      price = 90;
      lead_time = 80;
      reliability = 85;
      compliance = 100;
    }
    expectRefused(parseComponents(new Scores()), 'components');
  });
});

describe('a prototype that was changed', () => {
  const PLAIN = parseComponents(sample());

  it.each([
    ['a setter for price on Object.prototype', 'price'], ['a setter for compliance on Object.prototype', 'compliance'], ['a setter for the index 0 on Object.prototype', '0'],
  ] as const)('with %s, the result is the result of the plain twin, and no setter runs', (_what, key) => {
    let calls = 0;
    const input = sample();
    const seen = withPrototype(Object.prototype, { [key]: { set() { calls += 1; } } }, () => parseComponents(input));
    expect(seen).toStrictEqual(PLAIN);
    expect(calls).toBe(0);
  });

  it('reads no member that a prototype holds: components with no own member are refused, and the copy has its own members', () => {
    const inherited = Object.fromEntries(NAMES.map((name) => [name, { value: 50, writable: true, enumerable: true }]));
    expect(withPrototype(Object.prototype, inherited, () => parseComponents({})).ok).toBe(false);
    const components = must(PLAIN);
    for (const name of NAMES) expect(Object.hasOwn(components, name)).toBe(true);
    expect(Object.keys(objectAt(sample(), []))).toStrictEqual([...NAMES]);
  });
});

describe('the fault that inverts the scores', () => {
  it('is named in the gap sentence of the Sourcing Agent, with what the code does: one scorer returns its component scores and its score reversed, as 100 minus each', () => {
    const sentence = faultGap('sourcing-agent') ?? '';
    expect(sentence).toContain('invert_scores');
    expect(sentence).toContain('component scores');
    expect(sentence).toContain('its score');
    expect(sentence).toContain('100 minus each');
    expect(FAULT_EFFECTS.invert_scores).toBe('one scorer returns its component scores and its score reversed, as 100 minus each');
  });
});
