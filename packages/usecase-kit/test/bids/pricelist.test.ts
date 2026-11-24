// packages/usecase-kit/test/bids/pricelist.test.ts: the price list of a Bid Desk in use case 3 (supplier bid evaluation). The Bid Desk serves the list as bytes, and its manifest holds the SHA-256 of those
// bytes, so `priceListSha256` hashes the text as it is served and writes no canonical form. The golden file is the example. The rule of the price is the break: the unit price of a quantity is the price
// of the break with the greatest `min_quantity` that is not above the quantity. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PRICE_LIST_SCHEMA, parsePriceList, priceFor, priceListSha256 } from '@vsa/usecase-kit/bids';
import type { PriceList } from '@vsa/usecase-kit/bids';
import { MARKER, change, expectRefused, golden, goldenText, listAt, must, objectAt, withPrototype } from './support.ts';
import type { Json } from './support.ts';

/** The SHA-256 of the bytes of the golden file. A change of the file shows here. */
const GOLDEN_FILE_SHA256 = 'cb4086f580328b375857bde3f4ac5744ee36f405ba3552bd760baf89d1a8765c';

/** What the golden file says: for each SKU, the lead time and the breaks as pairs of the minimum quantity and the unit price. The table is written out, so a change of the file shows in the test. */
const GOLDEN_TABLE = {
  'GLV-NIT-M': { lead: 14, breaks: [[1, 140], [50, 132], [100, 125], [500, 112]] },
  'SYR-10ML': { lead: 10, breaks: [[1, 42], [250, 36], [1000, 31]] },
  'MSK-N95': { lead: 21, breaks: [[1, 65], [25, 60], [100, 54], [1000, 47]] },
} as const;
const SKUS = Object.keys(GOLDEN_TABLE) as (keyof typeof GOLDEN_TABLE)[];

const MEMBERS = ['schema', 'items'] as const;
const ENTRY_MEMBERS = ['sku', 'lead_time_days', 'breaks'] as const;
const BREAK_MEMBERS = ['min_quantity', 'unit_price'] as const;

/** A price list with `count` entries: SKU-0, SKU-1 and so on, with one break each. */
const listOf = (count: number): Json => ({
  schema: PRICE_LIST_SCHEMA,
  items: Array.from({ length: count }, (_, index) => ({ sku: `SKU-${index}`, lead_time_days: 3, breaks: [{ min_quantity: 1, unit_price: 10 }] })),
});

/** The golden list with the breaks of its first entry replaced. */
const withBreaks = (breaks: unknown): Json => change(golden('price-list'), ['items', 0, 'breaks'], breaks);
/** A list of breaks from pairs of the minimum quantity and the unit price. */
const breaksOf = (...pairs: readonly (readonly [number, number])[]): Json[] => pairs.map(([min_quantity, unit_price]) => ({ min_quantity, unit_price }));

const goldenList = (): PriceList => must(parsePriceList(golden('price-list')));

/** The golden file as the tests below read it. The shape is the shape of the file, and the first test holds the file to its hash. */
interface GoldenFile {
  readonly items: readonly { readonly sku: string; readonly lead_time_days: number; readonly breaks: readonly { readonly min_quantity: number; readonly unit_price: number }[] }[];
}
const goldenFile = (): GoldenFile => JSON.parse(goldenText('price-list')) as GoldenFile;

describe('the golden price list', () => {
  it('is the file that the hash names, and it holds the members in their order', () => {
    expect(createHash('sha256').update(goldenText('price-list')).digest('hex')).toBe(GOLDEN_FILE_SHA256);
    expect(Object.keys(golden('price-list'))).toStrictEqual([...MEMBERS]);
    for (const entry of goldenFile().items) {
      expect(Object.keys(entry)).toStrictEqual([...ENTRY_MEMBERS]);
      for (const step of entry.breaks) expect(Object.keys(step)).toStrictEqual([...BREAK_MEMBERS]);
    }
  });

  it('lists three SKUs with three or four breaks each, and it is the table of this test', () => {
    const { items } = goldenFile();
    expect(items.map((entry) => entry.sku)).toStrictEqual(SKUS);
    for (const entry of items) {
      const expected = GOLDEN_TABLE[entry.sku as keyof typeof GOLDEN_TABLE];
      expect(entry.breaks.length).toBeGreaterThanOrEqual(3);
      expect(entry.breaks.length).toBeLessThanOrEqual(4);
      expect(entry.lead_time_days).toBe(expected.lead);
      expect(entry.breaks.map((step) => [step.min_quantity, step.unit_price])).toStrictEqual(expected.breaks);
    }
  });

  it('passes the parser, and the copy holds the same members in the same order', () => {
    const result = parsePriceList(golden('price-list'));
    expect(result).toStrictEqual({ ok: true, value: golden('price-list') });
    const list = must(result);
    expect(Object.keys(list)).toStrictEqual([...MEMBERS]);
    for (const entry of list.items) {
      expect(Object.keys(entry)).toStrictEqual([...ENTRY_MEMBERS]);
      for (const step of entry.breaks) expect(Object.keys(step)).toStrictEqual([...BREAK_MEMBERS]);
    }
    expect(parsePriceList(JSON.parse(goldenText('price-list')))).toStrictEqual(result);
  });

  it('has the schema of the price list', () => {
    expect(PRICE_LIST_SCHEMA).toBe('vector.usecase.price-list.v1');
    expect(golden('price-list').schema).toBe(PRICE_LIST_SCHEMA);
  });

  it('gives a copy that shares no object with the input, and changes nothing of the input', () => {
    const input = golden('price-list');
    const before = JSON.stringify(input);
    const list = must(parsePriceList(input));
    expect(JSON.stringify(input)).toBe(before);
    expect(list).not.toBe(input);
    expect(list.items).not.toBe(input.items);
    expect(list.items[0]).not.toBe(objectAt(input, ['items', 0]));
    expect(list.items[0]!.breaks).not.toBe(objectAt(input, ['items', 0]).breaks);
    expect(list.items[0]!.breaks[0]).not.toBe(listAt(input, ['items', 0, 'breaks'])[0]);
    expect(Object.getPrototypeOf(list.items[0]!.breaks[0])).toBe(Object.prototype);
  });

  it('holds only ASCII texts, so that no text of an accepted list changes in the NFC form', () => {
    for (const entry of goldenList().items) {
      expect(entry.sku).toMatch(/^[\x20-\x7e]+$/);
      expect(entry.sku).toBe(entry.sku.normalize('NFC'));
    }
  });
});

describe('parsePriceList', () => {
  it('takes 1 entry and 200 entries, and refuses no entry and 201 entries', () => {
    expect(parsePriceList(listOf(1)).ok).toBe(true);
    expect(parsePriceList(listOf(200)).ok).toBe(true);
    expectRefused(parsePriceList(listOf(0)), 'price list.items');
    expectRefused(parsePriceList(listOf(201)), 'price list.items');
  });

  it('refuses the same SKU two times, and names the second entry and never the SKU', () => {
    const result = parsePriceList(change(listOf(3), ['items', 2, 'sku'], 'SKU-0'));
    expectRefused(result, 'price list.items[2].sku');
    expect(!result.ok && result.detail).not.toContain('SKU-0');
    expect(parsePriceList(listOf(3)).ok).toBe(true);
  });

  it('takes two SKUs that differ in the case of a letter: they are two entries', () => {
    expect(parsePriceList(change(listOf(2), ['items', 1, 'sku'], 'sku-0')).ok).toBe(true);
  });

  it('takes 1 break and 8 breaks, and refuses no break and 9 breaks', () => {
    const rising = (count: number): Json[] => Array.from({ length: count }, (_, index) => ({ min_quantity: 1 + index * 10, unit_price: 100 - index }));
    expect(parsePriceList(withBreaks(rising(1))).ok).toBe(true);
    expect(parsePriceList(withBreaks(rising(8))).ok).toBe(true);
    expectRefused(parsePriceList(withBreaks(rising(0))), 'price list.items[0].breaks');
    expectRefused(parsePriceList(withBreaks(rising(9))), 'price list.items[0].breaks');
  });

  it.each([
    ['2', [[2, 10], [5, 9]]], ['0', [[0, 10], [5, 9]]], ['10', [[10, 10]]],
  ] as const)('refuses a first break at %s, and takes a first break at 1', (_start, pairs) => {
    expectRefused(parsePriceList(withBreaks(breaksOf(...pairs))), 'price list.items[0].breaks[0].min_quantity');
    expect(parsePriceList(withBreaks(breaksOf([1, 10], ...pairs.slice(1)))).ok).toBe(true);
  });

  it.each([
    ['equal to the one before', [[1, 10], [50, 9], [50, 8]], 2], ['equal to the first', [[1, 10], [1, 9]], 1], ['below the one before', [[1, 10], [50, 9], [40, 8]], 2],
    ['the same as the first of three, in the last place', [[1, 10], [50, 9], [1, 8]], 2], ['falling at the end', [[1, 10], [100, 9], [50, 8], [20, 7]], 2],
  ] as const)('refuses a break with a minimum quantity %s, and names the break', (_what, pairs, at) => {
    expectRefused(parsePriceList(withBreaks(breaksOf(...pairs))), `price list.items[0].breaks[${at}].min_quantity`);
    expect(parsePriceList(withBreaks(breaksOf([1, 10], [50, 9], [51, 8]))).ok).toBe(true);
  });

  it('takes breaks with a price that rises or stays: the rule of the price is the break, and no rule on the price falls out of it', () => {
    expect(parsePriceList(withBreaks(breaksOf([1, 10], [50, 10], [100, 12]))).ok).toBe(true);
  });

  it.each([
    ['0', 0], ['a negative number', -1], ['1,000,001', 1_000_001], ['a fraction', 1.5], ['a text', '50'], ['null', null], ['a list', [50]], ['true', true], ['a text with a line break', MARKER],
  ])('refuses the minimum quantity %s, and takes 2 and 1,000,000', (_what, minimum) => {
    expectRefused(parsePriceList(change(golden('price-list'), ['items', 0, 'breaks', 1, 'min_quantity'], minimum)), 'price list.items[0].breaks[1].min_quantity');
    expect(parsePriceList(withBreaks(breaksOf([1, 10], [2, 9]))).ok).toBe(true);
    expect(parsePriceList(withBreaks(breaksOf([1, 10], [1_000_000, 9]))).ok).toBe(true);
  });

  it.each([
    ['0', 0], ['a negative number', -1], ['1,000,001', 1_000_001], ['a fraction', 1.5], ['a text', '10'], ['null', null], ['a list', [10]], ['true', true], ['a number that a number cannot hold exactly', 2 ** 53],
    ['a text with a line break', MARKER],
  ])('refuses the unit price %s, and takes 1 and 1,000,000', (_what, price) => {
    expectRefused(parsePriceList(change(golden('price-list'), ['items', 1, 'breaks', 2, 'unit_price'], price)), 'price list.items[1].breaks[2].unit_price');
    expect(parsePriceList(change(golden('price-list'), ['items', 1, 'breaks', 2, 'unit_price'], 1)).ok).toBe(true);
    expect(parsePriceList(change(golden('price-list'), ['items', 1, 'breaks', 2, 'unit_price'], 1_000_000)).ok).toBe(true);
  });

  it.each([
    ['366', 366], ['a negative number', -1], ['a fraction', 1.5], ['a text', '14'], ['null', null], ['a list', [14]], ['true', true], ['a text with a line break', MARKER],
  ])('refuses the lead time %s, and takes 0 and 365', (_what, days) => {
    expectRefused(parsePriceList(change(golden('price-list'), ['items', 2, 'lead_time_days'], days)), 'price list.items[2].lead_time_days');
    expect(parsePriceList(change(golden('price-list'), ['items', 2, 'lead_time_days'], 0)).ok).toBe(true);
    expect(parsePriceList(change(golden('price-list'), ['items', 2, 'lead_time_days'], 365)).ok).toBe(true);
  });

  it('reads the lead time minus zero as 0, so that the copy holds no sign that JSON does not write', () => {
    const list = must(parsePriceList(JSON.parse(goldenText('price-list').replace('"lead_time_days": 14', '"lead_time_days": -0'))));
    expect(Object.is(list.items[0]!.lead_time_days, 0)).toBe(true);
    expect(JSON.stringify(list)).toBe(JSON.stringify(must(parsePriceList(change(golden('price-list'), ['items', 0, 'lead_time_days'], 0)))));
  });

  it.each([
    ['the empty text', ''], ['65 characters', 'A'.repeat(65)], ['a space', 'A B'], ['a slash', 'A/B'], ['a line break at the end', 'A\n'], ['a hyphen at the start', '-A'], ['a number', 5], ['null', null],
    ['a letter with a mark in the NFD form', 'e\u0301'], ['a letter with a mark in the NFC form', '\u00e9'], ['a text with a line break', MARKER],
  ])('refuses a SKU of %s, and takes the twins', (_what, sku) => {
    expectRefused(parsePriceList(change(golden('price-list'), ['items', 0, 'sku'], sku)), 'price list.items[0].sku');
    for (const good of ['A', 'a.b_c-d', '9', 'A'.repeat(64)]) expect(parsePriceList(change(golden('price-list'), ['items', 0, 'sku'], good)).ok, good).toBe(true);
  });

  it('checks each text as it is written: the Kelvin sign is refused in a SKU, although NFC turns it into the letter K, and the twin with the letter K passes', () => {
    for (const sku of ['\u212aSU-1', 'SKU-\u212a', 'x\u212ay']) {
      const result = parsePriceList(change(golden('price-list'), ['items', 0, 'sku'], sku));
      expectRefused(result, 'price list.items[0].sku');
      expect(!result.ok && result.detail).not.toContain('\u212a');
    }
    expect(must(parsePriceList(change(golden('price-list'), ['items', 0, 'sku'], 'KSU-1'))).items[0]!.sku).toBe('KSU-1');
  });

  it.each([
    ['the list', []], ['an entry', ['items', 0]], ['a break', ['items', 0, 'breaks', 0]],
  ])('refuses a member that is not listed in %s, and the twin without it passes', (_what, path) => {
    expectRefused(parsePriceList(change(golden('price-list'), [...path, 'extra'], 1)), 'extra');
    expect(parsePriceList(golden('price-list')).ok).toBe(true);
  });

  it.each([
    ['schema', []], ['items', []], ['sku', ['items', 0]], ['lead_time_days', ['items', 0]], ['breaks', ['items', 1]], ['min_quantity', ['items', 2, 'breaks', 3]], ['unit_price', ['items', 2, 'breaks', 0]],
  ])('refuses a list with no member %s', (name, path) => {
    expectRefused(parsePriceList(change(golden('price-list'), [...path, name], undefined)), name);
  });

  it.each([
    ['another version', 'vector.usecase.price-list.v2'], ['capital letters', 'VECTOR.USECASE.PRICE-LIST.V1'], ['the schema of the lots file', 'vector.usecase.lots.v1'], ['a number', 1], ['null', null],
    ['a text with a line break', MARKER],
  ])('refuses a schema that is %s', (_what, schema) => {
    expectRefused(parsePriceList(change(golden('price-list'), ['schema'], schema)), 'price list.schema');
  });

  it.each([
    ['an empty list', []], ['an object', { 0: {} }], ['a text', 'items'], ['null', null], ['a list that holds a text', ['SKU-1']], ['a list that holds null', [null]], ['a list that holds a list', [[]]],
  ])('refuses items that are %s', (_what, items) => {
    expectRefused(parsePriceList(change(golden('price-list'), ['items'], items)), 'price list.items');
  });

  it.each([
    ['an object', { 0: { min_quantity: 1, unit_price: 10 } }], ['a text', 'breaks'], ['null', null], ['a number', 1], ['a list that holds a text', ['1']], ['a list that holds a list', [[1, 10]]],
  ])('refuses breaks that are %s', (_what, breaks) => {
    expectRefused(parsePriceList(withBreaks(breaks)), 'price list.items[0].breaks');
  });

  it.each([
    ['a list', []], ['a text', 'x'], ['null', null], ['a number', 5], ['undefined', undefined],
  ])('refuses a price list that is %s', (_what, value) => {
    expectRefused(parsePriceList(value), 'price list');
  });

  it('never repeats a value in a detail', () => {
    for (const path of [['schema'], ['items', 0, 'sku'], ['items', 0, 'lead_time_days'], ['items', 0, 'breaks', 0, 'min_quantity'], ['items', 0, 'breaks', 0, 'unit_price']]) {
      expectRefused(parsePriceList(change(golden('price-list'), path, MARKER)), 'price list');
    }
  });
});

describe('a value that is not plain JSON data', () => {
  const PLACES: ReadonlyArray<readonly [string, readonly (string | number)[], string]> = [
    ['the list', [], 'schema'], ['an entry', ['items', 0], 'sku'], ['an entry, at its lead time', ['items', 1], 'lead_time_days'], ['a break', ['items', 2, 'breaks', 1], 'unit_price'],
  ];

  it.each(PLACES)('refuses a member of %s that is an accessor, and never runs the getter', (_place, path, member) => {
    let reads = 0;
    const input = golden('price-list');
    const holder = objectAt(input, path);
    const value = holder[member];
    Object.defineProperty(holder, member, { get() { reads += 1; return value; }, enumerable: true, configurable: true });
    expectRefused(parsePriceList(input), member);
    expect(reads).toBe(0);
    expect(parsePriceList(golden('price-list')).ok).toBe(true);
  });

  it.each(PLACES)('refuses the key __proto__ in %s, with a value that looks right', (_place, path) => {
    const input = golden('price-list');
    Object.defineProperty(objectAt(input, path), '__proto__', { value: { x: 1 }, enumerable: true, configurable: true, writable: true });
    expectRefused(parsePriceList(input), '__proto__');
  });

  it('refuses the key __proto__ that JSON.parse makes', () => {
    expectRefused(parsePriceList(JSON.parse('{"schema":"vector.usecase.price-list.v1","items":[],"__proto__":{"x":1}}')), '__proto__');
    expectRefused(
      parsePriceList(JSON.parse('{"schema":"vector.usecase.price-list.v1","items":[{"sku":"A","lead_time_days":1,"breaks":[{"min_quantity":1,"unit_price":5,"__proto__":{"x":1}}]}]}')),
      '__proto__',
    );
  });

  it('refuses a list with a hole, a list with a member that is not an index, and a list of another kind, in the items and in the breaks', () => {
    const sparse = golden('price-list');
    delete listAt(sparse, ['items'])[1];
    expectRefused(parsePriceList(sparse), 'price list.items[1]');
    const sparseBreaks = golden('price-list');
    delete listAt(sparseBreaks, ['items', 0, 'breaks'])[2];
    expectRefused(parsePriceList(sparseBreaks), 'price list.items[0].breaks[2]');
    const named = golden('price-list');
    Object.defineProperty(listAt(named, ['items', 0, 'breaks']), 'extra', { value: 1, enumerable: true, configurable: true });
    expectRefused(parsePriceList(named), 'price list.items[0].breaks');
    class Breaks extends Array<unknown> {}
    const other = golden('price-list');
    objectAt(other, ['items', 0]).breaks = Breaks.from(listAt(other, ['items', 0, 'breaks']));
    expectRefused(parsePriceList(other), 'price list.items[0].breaks');
    expect(parsePriceList(golden('price-list')).ok).toBe(true);
  });

  it('refuses a value that JSON cannot hold, and a key that is not a string or not enumerable', () => {
    expectRefused(parsePriceList(change(golden('price-list'), ['items', 0, 'breaks', 0, 'unit_price'], Number.NaN)), 'unit_price');
    expectRefused(parsePriceList(change(golden('price-list'), ['items', 0, 'lead_time_days'], Number.POSITIVE_INFINITY)), 'lead_time_days');
    expectRefused(parsePriceList({ ...golden('price-list'), extra: undefined }), 'extra');
    expectRefused(parsePriceList({ ...golden('price-list'), extra: () => 1 }), 'extra');
    expectRefused(parsePriceList({ ...golden('price-list'), [Symbol('x')]: 1 }), 'price list');
    const hidden = golden('price-list');
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false, configurable: true });
    expectRefused(parsePriceList(hidden), 'price list');
  });

  it('refuses a Proxy that throws and a Proxy that was revoked, and never throws', () => {
    const throws = new Proxy(golden('price-list'), { ownKeys() { throw new Error('the Proxy refuses'); } });
    expect(() => parsePriceList(throws)).not.toThrow();
    expectRefused(parsePriceList(throws), 'price list');
    const { proxy, revoke } = Proxy.revocable(golden('price-list'), {});
    revoke();
    expect(() => parsePriceList(proxy)).not.toThrow();
    expectRefused(parsePriceList(proxy), 'price list');
  });

  it('takes an object with no prototype, and refuses an object of a class', () => {
    const bare = Object.assign(Object.create(null) as Json, golden('price-list'));
    expect(parsePriceList(bare)).toStrictEqual({ ok: true, value: golden('price-list') });
    class Prices {
      schema = PRICE_LIST_SCHEMA;
      items = golden('price-list').items;
    }
    expectRefused(parsePriceList(new Prices()), 'price list');
  });
});

describe('a prototype that was changed', () => {
  const PLAIN = parsePriceList(golden('price-list'));

  it.each([
    ['a setter for sku on Object.prototype', Object.prototype, 'sku'],
    ['a setter for breaks on Object.prototype', Object.prototype, 'breaks'],
    ['a setter for unit_price on Object.prototype', Object.prototype, 'unit_price'],
    ['a setter for min_quantity on Object.prototype', Object.prototype, 'min_quantity'],
    ['a setter for lead_time_days on Object.prototype', Object.prototype, 'lead_time_days'],
    ['a setter for the index 0 on Array.prototype', Array.prototype, '0'],
    ['a setter for the index 0 on Object.prototype', Object.prototype, '0'],
  ] as const)('with %s, the result is the result of the plain twin, and no setter runs', (_what, target, key) => {
    let calls = 0;
    const input = golden('price-list');
    const seen = withPrototype(target, { [key]: { set() { calls += 1; } } }, () => parsePriceList(input));
    expect(seen).toStrictEqual(PLAIN);
    expect(calls).toBe(0);
  });

  it('reads no member that a prototype holds: a list with no own member is refused, and the copy has its own members', () => {
    const inherited = { items: { value: golden('price-list').items, writable: true, enumerable: true }, schema: { value: PRICE_LIST_SCHEMA, writable: true, enumerable: true } };
    expect(withPrototype(Object.prototype, inherited, () => parsePriceList({})).ok).toBe(false);
    const list = must(PLAIN);
    expect(Object.hasOwn(list, 'items')).toBe(true);
    expect(Object.hasOwn(list.items[0]!, 'breaks')).toBe(true);
    expect(Object.hasOwn(list.items[0]!.breaks[0]!, 'unit_price')).toBe(true);
    expect(Object.hasOwn(list.items[0]!.breaks, 0)).toBe(true);
  });
});

describe('priceFor', () => {
  const list = goldenList();

  it.each(SKUS.flatMap((sku) => GOLDEN_TABLE[sku].breaks.map(([minimum, price], at) => [sku, at, minimum, price] as const)))(
    'gives the price of break %# of %s ... the quantity at the minimum of the break takes that break',
    (sku, _at, minimum, price) => {
      expect(priceFor(list, sku, minimum)).toStrictEqual({ unit_price: price, lead_time_days: GOLDEN_TABLE[sku].lead });
    },
  );

  it('takes the break before when the quantity is one below the minimum of a break, and the same break one above its minimum', () => {
    for (const sku of SKUS) {
      const { breaks, lead } = GOLDEN_TABLE[sku];
      breaks.forEach(([minimum, price], at) => {
        if (at > 0) expect(priceFor(list, sku, minimum - 1), `${sku} at ${minimum - 1}`).toStrictEqual({ unit_price: breaks[at - 1]![1], lead_time_days: lead });
        if (at + 1 < breaks.length && minimum + 1 < breaks[at + 1]![0]) expect(priceFor(list, sku, minimum + 1), `${sku} at ${minimum + 1}`).toStrictEqual({ unit_price: price, lead_time_days: lead });
      });
    }
  });

  it('gives the price between two breaks to the lower break', () => {
    expect(priceFor(list, 'GLV-NIT-M', 75)).toStrictEqual({ unit_price: 132, lead_time_days: 14 });
    expect(priceFor(list, 'GLV-NIT-M', 499)).toStrictEqual({ unit_price: 125, lead_time_days: 14 });
    expect(priceFor(list, 'SYR-10ML', 600)).toStrictEqual({ unit_price: 36, lead_time_days: 10 });
    expect(priceFor(list, 'MSK-N95', 40)).toStrictEqual({ unit_price: 60, lead_time_days: 21 });
  });

  it('gives the price of the last break for a quantity above it, up to the most that a request holds and beyond', () => {
    for (const quantity of [5000, 1_000_000, 1_000_001, 2 ** 40]) {
      expect(priceFor(list, 'GLV-NIT-M', quantity)).toStrictEqual({ unit_price: 112, lead_time_days: 14 });
      expect(priceFor(list, 'SYR-10ML', quantity)).toStrictEqual({ unit_price: 31, lead_time_days: 10 });
      expect(priceFor(list, 'MSK-N95', quantity)).toStrictEqual({ unit_price: 47, lead_time_days: 21 });
    }
  });

  it('gives the price of the first break for a quantity of 1, and never the first break for a quantity above its minimum', () => {
    expect(priceFor(list, 'GLV-NIT-M', 1)).toStrictEqual({ unit_price: 140, lead_time_days: 14 });
    expect(priceFor(list, 'GLV-NIT-M', 49)).toStrictEqual({ unit_price: 140, lead_time_days: 14 });
    expect(priceFor(list, 'GLV-NIT-M', 100)).not.toStrictEqual({ unit_price: 140, lead_time_days: 14 });
  });

  it.each([
    ['a SKU that the list lacks', 'GLV-NIT-L'], ['a SKU in another case', 'glv-nit-m'], ['a SKU with a space', 'GLV-NIT-M '], ['the empty text', ''], ['a name of the prototype', 'constructor'],
    ['the key __proto__', '__proto__'], ['toString', 'toString'], ['a number', 5 as unknown as string], ['null', null as unknown as string], ['undefined', undefined as unknown as string],
  ])('gives null for %s', (_what, sku) => {
    for (const quantity of [1, 100, 5000]) expect(priceFor(list, sku, quantity)).toBeNull();
    expect(priceFor(list, 'GLV-NIT-M', 100)).not.toBeNull();
  });

  it.each([
    ['0', 0], ['a negative number', -1], ['minus zero', -0], ['a fraction', 1.5], ['a fraction below 1', 0.5], ['NaN', Number.NaN], ['infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY], ['a text', '100'], ['null', null], ['undefined', undefined], ['true', true], ['a list', [100]], ['a bigint', 100n],
  ])('gives null for the quantity %s, and the price for its twin', (_what, quantity) => {
    for (const sku of SKUS) expect(priceFor(list, sku, quantity as number)).toBeNull();
    expect(priceFor(list, 'GLV-NIT-M', 100)).toStrictEqual({ unit_price: 125, lead_time_days: 14 });
  });

  it('gives a new object with the two members, and never a member of the list', () => {
    const first = priceFor(list, 'GLV-NIT-M', 100);
    const second = priceFor(list, 'GLV-NIT-M', 100);
    expect(first).not.toBe(second);
    expect(Object.keys(first!)).toStrictEqual(['unit_price', 'lead_time_days']);
    expect(first).not.toBe(list.items[0]!.breaks[2]);
    Reflect.set(first!, 'unit_price', 1);
    expect(priceFor(list, 'GLV-NIT-M', 100)).toStrictEqual({ unit_price: 125, lead_time_days: 14 });
  });

  it('takes the break with the greatest minimum quantity that is not above the quantity, and does not rely on the order of the breaks of a list that was built by hand', () => {
    // A list of this kind never comes from the parser, which wants the minimum quantities to rise. The rule is the same for any order.
    const byHand: PriceList = { schema: PRICE_LIST_SCHEMA, items: [{ sku: 'A-1', lead_time_days: 3, breaks: [{ min_quantity: 1, unit_price: 9 }, { min_quantity: 100, unit_price: 7 }, { min_quantity: 10, unit_price: 8 }] }] };
    expect(priceFor(byHand, 'A-1', 50)).toStrictEqual({ unit_price: 8, lead_time_days: 3 });
    expect(priceFor(byHand, 'A-1', 100)).toStrictEqual({ unit_price: 7, lead_time_days: 3 });
    expect(priceFor(byHand, 'A-1', 5)).toStrictEqual({ unit_price: 9, lead_time_days: 3 });
  });

  it('gives null when no break is at or below the quantity, in a list that was built by hand with no break at 1', () => {
    const byHand: PriceList = { schema: PRICE_LIST_SCHEMA, items: [{ sku: 'A-1', lead_time_days: 3, breaks: [{ min_quantity: 10, unit_price: 8 }] }] };
    expect(priceFor(byHand, 'A-1', 9)).toBeNull();
    expect(priceFor(byHand, 'A-1', 10)).toStrictEqual({ unit_price: 8, lead_time_days: 3 });
  });
});

describe('priceListSha256', () => {
  it('is the hash of the bytes of the golden file', () => {
    expect(priceListSha256(goldenText('price-list'))).toBe(GOLDEN_FILE_SHA256);
    expect(priceListSha256(goldenText('price-list'))).toBe(createHash('sha256').update(Buffer.from(goldenText('price-list'), 'utf8')).digest('hex'));
  });

  it('has the form of a digest: 64 lower-case hex characters', () => {
    expect(priceListSha256(goldenText('price-list'))).toMatch(/^[0-9a-f]{64}$/);
    expect(priceListSha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('gives two hashes for two texts that differ by one space, a line break or the layout of a member', () => {
    const text = goldenText('price-list');
    const hashes = new Set([
      priceListSha256(text), priceListSha256(`${text} `), priceListSha256(` ${text}`), priceListSha256(text.trimEnd()), priceListSha256(text.replace('"sku": "GLV-NIT-M"', '"sku":  "GLV-NIT-M"')),
      priceListSha256(text.split('\n').join('\r\n')),
    ]);
    expect(hashes.size).toBe(6);
  });

  it('hashes the text and not the value: the same value in another layout has another hash', () => {
    const compact = JSON.stringify(golden('price-list'));
    expect(JSON.parse(compact)).toStrictEqual(golden('price-list'));
    expect(priceListSha256(compact)).not.toBe(priceListSha256(goldenText('price-list')));
  });

  it('hashes the UTF-8 bytes of the text, and keeps the NFC and the NFD form of a text apart', () => {
    expect(priceListSha256('caf\u00e9')).toBe(createHash('sha256').update(Buffer.from([0x63, 0x61, 0x66, 0xc3, 0xa9])).digest('hex'));
    expect(priceListSha256('caf\u00e9')).not.toBe(priceListSha256('cafe\u0301'));
  });

  it('refuses a value that is not a text with a TypeError, so that bytes of another kind are not hashed by mistake', () => {
    for (const value of [undefined, null, 1, {}, [], Buffer.from('a'), new Uint8Array(1)]) expect(() => priceListSha256(value as unknown as string)).toThrow(TypeError);
  });
});
