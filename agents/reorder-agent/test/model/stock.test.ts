// agents/reorder-agent/test/model/stock.test.ts
// The stock reading that the buyer ERP gives, and its hash. The six members and their number rules are those of the ERP of the mock service: the numbers are numbers and never text. Each refusal
// has an accepted twin, and no detail repeats the value that failed.
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { parseStockReading, stockReadingSha256 } from '../../src/model/index.ts';
import { MARKER, expectNames, goldenList, must, refusal } from './support.ts';

const readings = (): Record<string, unknown>[] => goldenList('stock-readings.json');
const first = (): Record<string, unknown> => readings()[0]!;
const MEMBERS = ['sku', 'on_hand', 'threshold', 'daily_usage', 'lead_time_days', 'open_orders'];

describe('parseStockReading: the readings of the mock data', () => {
  test.each([0, 1, 2])('accepts the reading %i and returns a new object equal to it', (index) => {
    const input = readings()[index]!;
    const value = must(parseStockReading(input));
    expect(value).toStrictEqual(input);
    expect(value).not.toBe(input);
  });

  test('returns the six members in a fixed order, whatever the order of the input', () => {
    const permuted = { open_orders: 0, threshold: 100, sku: 'GLV-NIT-M', lead_time_days: 7, on_hand: 60, daily_usage: 12 };
    expect(Object.keys(must(parseStockReading(permuted)))).toStrictEqual(MEMBERS);
  });

  test('works on a copy: a change of the input after the call does not change the result', () => {
    const input = first();
    const value = must(parseStockReading(input));
    input.on_hand = 1;
    expect(value.on_hand).toBe(60);
  });
});

describe('parseStockReading: the limits of each number', () => {
  // The accepted twin of each refusal below: a value at the edge of the limit.
  test.each([
    ['on_hand', 0], ['on_hand', 10_000_000],
    ['threshold', 0], ['threshold', 10_000_000],
    ['open_orders', 0], ['open_orders', 10_000_000],
    ['lead_time_days', 0], ['lead_time_days', 365],
    ['daily_usage', 0], ['daily_usage', 12.5], ['daily_usage', 10_000_000],
  ])('accepts %s of %d', (name, number) => {
    expect(must(parseStockReading({ ...first(), [name]: number }))[name as 'on_hand']).toBe(number);
  });

  test.each([
    ['on_hand', -1, 'a negative number'],
    ['on_hand', 10_000_001, 'a number above the limit'],
    ['on_hand', 1.5, 'a fraction'],
    ['on_hand', '60', 'a text number'],
    ['on_hand', Number.NaN, 'NaN'],
    ['on_hand', Number.POSITIVE_INFINITY, 'an infinite number'],
    ['on_hand', 2 ** 53, 'a number that a double cannot hold exactly'],
    ['on_hand', null, 'null'],
    ['on_hand', true, 'a boolean'],
    ['on_hand', [60], 'a list'],
    ['threshold', -1, 'a negative number'],
    ['threshold', 10_000_001, 'a number above the limit'],
    ['threshold', 0.5, 'a fraction'],
    ['threshold', '100', 'a text number'],
    ['open_orders', -1, 'a negative number'],
    ['open_orders', 10_000_001, 'a number above the limit'],
    ['open_orders', 2.5, 'a fraction'],
    ['open_orders', '0', 'a text number'],
    ['lead_time_days', -1, 'a negative number'],
    ['lead_time_days', 366, 'a number above the limit'],
    ['lead_time_days', 6.5, 'a fraction'],
    ['lead_time_days', '7', 'a text number'],
    ['daily_usage', -0.5, 'a negative number'],
    ['daily_usage', 10_000_001, 'a number above the limit'],
    ['daily_usage', Number.NaN, 'NaN'],
    ['daily_usage', Number.POSITIVE_INFINITY, 'an infinite number'],
    ['daily_usage', '12', 'a text number'],
    ['daily_usage', null, 'null'],
  ])('refuses %s of %j (%s)', (name, value, _what) => {
    const { code, detail } = refusal(parseStockReading({ ...first(), [name]: value }));
    expect(code).toBe('bad_shape');
    expectNames(detail, `stock reading.${name}`);
  });
});

describe('parseStockReading: the SKU and the members', () => {
  test.each(['A'.repeat(64), '9.b-c_d'])('accepts the SKU %s', (sku) => {
    expect(must(parseStockReading({ ...first(), sku })).sku).toBe(sku);
  });

  test.each(['A'.repeat(65), '', 'GLV/NIT', '-GLV', 'GLV\n', MARKER, 7, null])('refuses the SKU %j', (sku) => {
    const { code, detail } = refusal(parseStockReading({ ...first(), sku }));
    expect(code).toBe('bad_shape');
    expectNames(detail, 'stock reading.sku');
  });

  test.each(MEMBERS)('refuses a reading with no member %s', (name) => {
    const input = first();
    delete input[name];
    const { code, detail } = refusal(parseStockReading(input));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test.each(['on_order', 'note', '__proto__'])('refuses the extra member %s', (name) => {
    const input = JSON.parse(JSON.stringify({ ...first() })) as Record<string, unknown>;
    Object.defineProperty(input, name, { value: 'x', enumerable: true, configurable: true, writable: true });
    const { code, detail } = refusal(parseStockReading(input));
    expect(code).toBe('bad_shape');
    expectNames(detail, name);
  });

  test.each([null, [], 'GLV-NIT-M', 60, undefined])('refuses %j in place of the reading', (input) => {
    expect(refusal(parseStockReading(input)).code).toBe('bad_shape');
  });

  test('refuses a getter and never runs it', () => {
    let reads = 0;
    const input = first();
    Object.defineProperty(input, 'on_hand', { enumerable: true, get: () => { reads += 1; return 60; } });
    expectNames(refusal(parseStockReading(input)).detail, 'accessor');
    expect(reads).toBe(0);
  });

  test('refuses a Proxy that throws when it is read, and never throws itself', () => {
    const hostile = new Proxy(first(), { ownKeys: () => { throw new Error('the keys cannot be read'); } });
    expect(refusal(parseStockReading(hostile)).code).toBe('bad_shape');
  });
});

describe('stockReadingSha256', () => {
  // The canonical text: the keys in the order of their code units, no white space, the numbers as JSON writes them.
  const canonical = (reading: Record<string, unknown>): string => JSON.stringify(Object.fromEntries(Object.entries(reading).sort(([a], [b]) => (a < b ? -1 : 1))));
  const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

  test('is the SHA-256 of the canonical text of the reading, for each of the three readings', () => {
    for (const reading of readings()) {
      expect(must(stockReadingSha256(must(parseStockReading(reading))))).toBe(sha256(canonical(reading)));
    }
  });

  test('pins the digest of the first reading, so a change of the canonical form shows here', () => {
    expect(canonical(first())).toBe('{"daily_usage":12,"lead_time_days":7,"on_hand":60,"open_orders":0,"sku":"GLV-NIT-M","threshold":100}');
    expect(must(stockReadingSha256(must(parseStockReading(first()))))).toBe('11532e38e5314a47c1b641dad8e7ab340f400f1fe1290eb72283270119f1b3a5');
  });

  test('does not depend on the order of the members of the input', () => {
    const permuted = { open_orders: 0, threshold: 100, sku: 'GLV-NIT-M', lead_time_days: 7, on_hand: 60, daily_usage: 12 };
    expect(must(stockReadingSha256(must(parseStockReading(permuted))))).toBe(must(stockReadingSha256(must(parseStockReading(first())))));
  });

  test.each([['sku', 'GLV-NIT-L'], ['on_hand', 61], ['threshold', 101], ['daily_usage', 12.5], ['lead_time_days', 8], ['open_orders', 1]])('changes when %s changes', (name, value) => {
    const base = must(stockReadingSha256(must(parseStockReading(first()))));
    expect(must(stockReadingSha256(must(parseStockReading({ ...first(), [name]: value }))))).not.toBe(base);
  });

  test('gives a refusal and never throws for a value that JSON cannot hold', () => {
    const broken = { ...must(parseStockReading(first())), daily_usage: Number.NaN };
    expect(refusal(stockReadingSha256(broken)).code).toBe('bad_shape');
  });
});
