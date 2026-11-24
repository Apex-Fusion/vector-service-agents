// packages/usecase-kit/test/bids/ids.test.ts: the names of use case 3 (supplier bid evaluation), the rule of an identifier that a SKU and a request id share, and the field rules of the folder: a whole
// number, a quantity and a date. The folder does not import the inventory folder, so it writes the rules again, and a drift test holds each rule to the same rule in the inventory folder. The last
// part holds the folder to the shape that the package asks of a folder. Each refusal has an accepted twin.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { accepted, isModelName, refused } from '@vsa/usecase-kit/protocol';
import type { ProtocolResult } from '@vsa/usecase-kit/protocol';
import * as byName from '@vsa/usecase-kit/bids';
import { BID_CAPABILITIES, BID_DESK_MODEL, MAX_RFQ_ITEMS, SOURCING_MODEL, parseRfqId, parseSku } from '@vsa/usecase-kit/bids';
import * as byPath from '../../src/bids/index.ts';
import { MAX_ITEM_QUANTITY, isList, noNegativeZero, objectOf, parseDay, parseQuantity, parseWhole, valuesOf } from '../../src/bids/ids.ts';
import { parseDay as inventoryDay, parseId as inventoryId, parseQuantity as inventoryQuantity } from '../../src/inventory/lots.ts';
import { MARKER, expectRefused, withPrototype } from './support.ts';

const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));
const FOLDER = join(PACKAGE, 'src', 'bids');
const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts'));

/** Runs Node in the package folder and returns what it prints. The flag for type stripping is in the arguments, so that a Node 22 version before 22.18 runs a .ts file too. */
function node(args: readonly string[]): string {
  return execFileSync(process.execPath, ['--no-warnings', ...args], { cwd: PACKAGE, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The values that every rule of an identifier, a quantity and a date is held to: what the rule says is the value that passes, or the code of the refusal. The wording of a detail is no part of a rule. */
const verdict = (result: ProtocolResult<unknown>): unknown => (result.ok ? { value: result.value } : { code: result.code });

const IDS: readonly unknown[] = [
  'A', 'a', '9', 'a.b_c-d', 'A'.repeat(64), 'A'.repeat(65), '', ' ', 'A B', 'A/B', 'A\n', '\nA', 'A\r', '-A', '.A', '_A', 'A-', 'a..b', 'GLV-NIT-M', 'rfq-2026.12_01', '\u00e9', 'e\u0301', '\u212a', 'x\u212ay',
  '\uff21', 'A\u0000', '\u0663', 'A\u200b', MARKER, 5, 0, null, undefined, true, {}, [], ['A'], new String('A'), Symbol('A'),
];

const QUANTITIES: readonly unknown[] = [
  1, 2, 100, 999_999, 1_000_000, 1_000_001, 0, -1, -0, 1.5, 0.1, 999_999.99, '1', '', ' 1', null, undefined, true, [], [1], {}, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER, 2 ** 53, 1e21, new Number(5), 5n, MARKER,
];

const DAYS: readonly unknown[] = [
  '2026-12-20', '2024-02-29', '2000-02-29', '2100-02-29', '2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-1', '26-01-01', '2026/01/01', '20260101',
  '2026-01-01T00:00:00Z', ' 2026-01-01', '2026-01-01 ', '2026-01-01\n', '0100-01-01', '0099-12-31', '0000-01-01', '9999-12-31', '\u0662\u0660\u0662\u0666-\u0661\u0662-\u0662\u0660',
  '\uff12\uff10\uff12\uff16-\uff11\uff12-\uff12\uff10', 20_261_220, null, undefined, MARKER, new Date(0), ['2026-12-20'],
];

describe('the capabilities and the models', () => {
  it('are the capability of the Sourcing Agent, the capability of the Bid Desk, and the two model names', () => {
    expect(BID_CAPABILITIES).toStrictEqual({ evaluate: 'supplychain.rfq.evaluate.v1', quote: 'supplychain.rfq.quote.v1' });
    expect(SOURCING_MODEL).toBe('sourcing-agent-v1');
    expect(BID_DESK_MODEL).toBe('bid-desk-v1');
  });

  it('are names that the protocol takes, and each is one name', () => {
    expect(isModelName(SOURCING_MODEL)).toBe(true);
    expect(isModelName(BID_DESK_MODEL)).toBe(true);
    expect(new Set([SOURCING_MODEL, BID_DESK_MODEL, ...Object.values(BID_CAPABILITIES)]).size).toBe(4);
  });

  it('cannot be changed', () => {
    expect(Object.isFrozen(BID_CAPABILITIES)).toBe(true);
    expect(Reflect.set(BID_CAPABILITIES, 'quote', 'other')).toBe(false);
    expect(Reflect.deleteProperty(BID_CAPABILITIES, 'evaluate')).toBe(false);
    expect(BID_CAPABILITIES.quote).toBe('supplychain.rfq.quote.v1');
  });

  it('give the limits of a request: 20 items, and a quantity of at most 1,000,000', () => {
    expect(MAX_RFQ_ITEMS).toBe(20);
    expect(MAX_ITEM_QUANTITY).toBe(1_000_000);
  });
});

describe.each([['a SKU', parseSku], ['a request id', parseRfqId]] as const)('%s', (_name, parse) => {
  it.each(['A', 'a', '9', 'a.b_c-d', 'A'.repeat(64), 'GLV-NIT-M', 'rfq-2026.12_01', 'KSU-1'])('takes %s', (text) => {
    expect(parse(text, 'x')).toStrictEqual({ ok: true, value: text });
  });

  it.each([
    ['the empty text', ''], ['65 characters', 'A'.repeat(65)], ['a space', 'A B'], ['a slash', 'A/B'], ['a line break at the end', 'A\n'], ['a line break at the start', '\nA'], ['a hyphen at the start', '-A'],
    ['a dot at the start', '.A'], ['an underscore at the start', '_A'], ['a number', 5], ['null', null], ['undefined', undefined], ['a list', ['A']], ['an object', { id: 'A' }], ['a String object', new String('A')],
    ['a symbol', Symbol('A')], ['a letter with a mark in the NFD form', 'e\u0301'], ['a letter with a mark in the NFC form', '\u00e9'], ['a full-width letter', '\uff21'], ['a zero-width space', 'A\u200b'],
    ['a text with a line break', MARKER],
  ])('refuses %s, names the field, and takes the twin', (_what, value) => {
    expectRefused(parse(value, 'item.sku'), 'item.sku');
    expect(parse('A', 'item.sku').ok).toBe(true);
  });

  it('checks the text as it is written: the Kelvin sign is refused, although the NFC form turns it into the letter K, and the twin with the letter K passes', () => {
    for (const text of ['\u212aSU-1', 'SKU-\u212a', 'x\u212ay']) {
      const result = parse(text, 'item.sku');
      expectRefused(result, 'item.sku');
      expect(!result.ok && result.detail).not.toContain('\u212a');
      expect(text.normalize('NFC')).toMatch(/^[A-Za-z0-9._-]+$/);
    }
    expect(parse('KSU-1', 'item.sku').ok).toBe(true);
  });

  it('refuses the same text in the NFD form as in the NFC form, because the rule is ASCII', () => {
    expect('caf\u00e9'.normalize('NFD')).not.toBe('caf\u00e9');
    expectRefused(parse('caf\u00e9', 'x'), 'x');
    expectRefused(parse('cafe\u0301', 'x'), 'x');
    expect(parse('cafe', 'x').ok).toBe(true);
  });

  it('never repeats the value in the detail', () => {
    const result = parse(MARKER, 'rfq.items[3].sku');
    expectRefused(result, 'rfq.items[3].sku');
    expect(!result.ok && result.detail).not.toContain('#7f3');
  });
});

describe('a whole number from a minimum to a maximum', () => {
  it.each([[0, 0, 365], [365, 0, 365], [1, 1, 8], [8, 1, 8], [1_000_000, 1, 1_000_000], [Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER]])('takes %s between %s and %s', (value, min, max) => {
    expect(parseWhole(value, 'x', min, max)).toStrictEqual({ ok: true, value });
  });

  it.each([
    ['one below the minimum', -1], ['one above the maximum', 366], ['a fraction', 1.5], ['a text', '5'], ['null', null], ['undefined', undefined], ['true', true], ['a list', [5]], ['a text with a line break', MARKER],
    ['NaN', Number.NaN], ['infinity', Number.POSITIVE_INFINITY], ['a number that a number cannot hold exactly', 2 ** 53], ['a bigint', 5n],
  ])('refuses %s, and names the field and the range', (_what, value) => {
    expectRefused(parseWhole(value, 'entry.lead_time_days', 0, 365), 'entry.lead_time_days');
    const result = parseWhole(value, 'entry.lead_time_days', 0, 365);
    expect(!result.ok && result.detail).toContain('from 0 to 365');
    expect(parseWhole(5, 'entry.lead_time_days', 0, 365).ok).toBe(true);
  });

  it('reads the number minus zero as zero, so that no copy holds a sign that JSON does not write', () => {
    const result = parseWhole(-0, 'x', 0, 365);
    expect(result.ok && Object.is(result.value, 0)).toBe(true);
    expect(parseWhole(JSON.parse('-0'), 'x', 0, 365)).toStrictEqual({ ok: true, value: 0 });
    expect(noNegativeZero(-0)).toBe(0);
    expect(Object.is(noNegativeZero(-0), 0)).toBe(true);
    expect(noNegativeZero(-3)).toBe(-3);
    expect(noNegativeZero(3)).toBe(3);
    expect(noNegativeZero(0.25)).toBe(0.25);
  });
});

describe('a quantity', () => {
  it.each([1, 2, 100, 999_999, 1_000_000])('takes %s', (quantity) => {
    expect(parseQuantity(quantity, 'x')).toStrictEqual({ ok: true, value: quantity });
  });

  it.each([
    ['0', 0], ['a negative number', -1], ['minus zero', -0], ['1,000,001', 1_000_001], ['a fraction', 1.5], ['a text', '10'], ['null', null], ['a list', [10]], ['NaN', Number.NaN],
    ['a number that a number cannot hold exactly', 2 ** 53], ['a text with a line break', MARKER],
  ])('refuses %s, and takes the twins 1 and 1,000,000', (_what, quantity) => {
    expectRefused(parseQuantity(quantity, 'item.quantity'), 'item.quantity');
    expect(parseQuantity(1, 'item.quantity').ok).toBe(true);
    expect(parseQuantity(1_000_000, 'item.quantity').ok).toBe(true);
  });
});

describe('a date', () => {
  it.each(['2026-12-20', '2024-02-29', '2000-02-29', '0100-01-01', '9999-12-31', '2026-01-01', '2026-12-31'])('takes %s', (day) => {
    expect(parseDay(day, 'x')).toStrictEqual({ ok: true, value: day });
  });

  it.each([
    ['a day that does not exist', '2026-02-30'], ['a day of a common year', '2026-02-29'], ['the 29th of February of a year of 100', '2100-02-29'], ['the 31st of April', '2026-04-31'],
    ['a month of 13', '2026-13-01'], ['a month of 0', '2026-00-10'], ['a day of 0', '2026-01-00'], ['a year before 0100', '0099-12-31'], ['the year 0', '0000-01-01'], ['a month with one digit', '2026-1-1'],
    ['a year with two digits', '26-01-01'], ['slashes', '2026/01/01'], ['no separator', '20260101'], ['a time', '2026-01-01T00:00:00Z'], ['a space at the start', ' 2026-01-01'], ['a space at the end', '2026-01-01 '],
    ['a line break at the end', '2026-01-01\n'], ['Arabic-Indic digits', '\u0662\u0660\u0662\u0666-\u0661\u0662-\u0662\u0660'], ['full-width digits', '\uff12\uff10\uff12\uff16-\uff11\uff12-\uff12\uff10'],
    ['a number', 20_261_220], ['null', null], ['a Date object', new Date(0)], ['a list', ['2026-12-20']], ['a text with a line break', MARKER],
  ])('refuses %s, and names the field', (_what, value) => {
    expectRefused(parseDay(value, 'rfq.needed_by'), 'rfq.needed_by');
    expect(parseDay('2026-12-20', 'rfq.needed_by').ok).toBe(true);
  });

  it('reads a year from 0 to 99 as a year of its own and refuses it, where Date.UTC reads it as a year of the twentieth century', () => {
    expect(new Date(Date.UTC(99, 0, 1)).getUTCFullYear()).toBe(1999);
    expectRefused(parseDay('0099-01-01', 'x'), 'x');
    expect(parseDay('0100-01-01', 'x').ok).toBe(true);
  });
});

describe('the helpers of a list and of an object', () => {
  it('say that a list is a list, and an object is an object', () => {
    expect(isList([])).toBe(true);
    expect(isList({})).toBe(false);
    expect(objectOf({ a: 1 }, 'x')).toStrictEqual({ ok: true, value: { a: 1 } });
    for (const value of [[], null, 'a', 1, true]) expectRefused(objectOf(value, 'x.items[1]'), 'x.items[1]');
  });

  it('give the values of a list of results, or the first refusal itself', () => {
    expect(valuesOf([accepted('a'), accepted('b')])).toStrictEqual({ ok: true, value: ['a', 'b'] });
    expect(valuesOf([])).toStrictEqual({ ok: true, value: [] });
    const first = refused('bad_shape', 'the first');
    expect(valuesOf([accepted(1), first, refused('bad_shape', 'the second')])).toBe(first);
  });

  it('build the list of values with no setter of a prototype: a setter for the index 0 on Array.prototype never runs', () => {
    let calls = 0;
    const result = withPrototype(Array.prototype, { 0: { set() { calls += 1; } } }, () => valuesOf([accepted(1), accepted(2)]));
    expect(result).toStrictEqual({ ok: true, value: [1, 2] });
    expect(calls).toBe(0);
  });
});

describe('the field rules and the rules of the inventory folder', () => {
  // The inventory folder holds the same rules for a SKU, a quantity and a date. The kit folders do not import each other, so this test is the only place where the two meet. It gives each rule the
  // same table of values and compares the answers: a change of one rule without the other shows here.
  it.each(IDS)('gives the same answer for the identifier %o', (value) => {
    expect(verdict(parseSku(value, 'x'))).toStrictEqual(verdict(inventoryId(value, 'x')));
    expect(verdict(parseRfqId(value, 'x'))).toStrictEqual(verdict(inventoryId(value, 'x')));
  });

  it.each(QUANTITIES)('gives the same answer for the quantity %o', (value) => {
    expect(verdict(parseQuantity(value, 'x'))).toStrictEqual(verdict(inventoryQuantity(value, 'x')));
  });

  it.each(DAYS)('gives the same answer for the date %o', (value) => {
    expect(verdict(parseDay(value, 'x'))).toStrictEqual(verdict(inventoryDay(value, 'x')));
  });

  it('has the table of values that holds a value of each kind, so that the comparison has teeth', () => {
    for (const table of [IDS, QUANTITIES, DAYS]) {
      const answers = table.map((value) => (table === IDS ? parseSku(value, 'x') : table === QUANTITIES ? parseQuantity(value, 'x') : parseDay(value, 'x')).ok);
      expect(answers).toContain(true);
      expect(answers).toContain(false);
    }
    expect(MAX_ITEM_QUANTITY).toBe(1_000_000);
  });
});

const NAMES = [
  'BID_CAPABILITIES', 'BID_DESK_CLAIM', 'BID_DESK_MODEL', 'MAX_ITEM_QUANTITY', 'MAX_RFQ_ITEMS', 'PRICE_LIST_SCHEMA', 'SOURCING_CLAIM', 'SOURCING_MODEL', 'WEIGHT_NAMES', 'parsePriceList', 'parseRfqDocument',
  'parseRfqId', 'parseSku', 'parseWeights', 'priceFor', 'priceListSha256', 'rfqSha256',
];

describe('the subpath @vsa/usecase-kit/bids', () => {
  it('is the folder src/bids, and it exports the names of this part of the folder', () => {
    expect(byName.parseSku).toBe(byPath.parseSku);
    expect(Object.keys(byName).sort()).toStrictEqual(Object.keys(byPath).sort());
    for (const name of NAMES) expect(Object.keys(byName), name).toContain(name);
  });

  it('exports the helpers of the field rules to no one: they stay inside the folder', () => {
    for (const name of ['parseWhole', 'parseQuantity', 'parseDay', 'parseId', 'noNegativeZero', 'isList', 'objectOf', 'valuesOf']) expect(Object.keys(byName), name).not.toContain(name);
  });

  it('loads with Node type stripping and with tsx, and gives the same names as vitest', () => {
    // The folder is loaded in a new Node process on purpose: the test exercises the loading boundary, so a static import of vitest cannot stand in for it.
    const script = "const m = await import('@vsa/usecase-kit/bids'); console.log(Object.keys(m).sort().join(','));";
    const expected = Object.keys(byName).sort().join(',');
    expect(node(['--experimental-strip-types', '--input-type=module', '-e', script])).toBe(expected);
    expect(node(['--import', 'tsx', '--input-type=module', '-e', script])).toBe(expected);
  }, 60_000);
});

describe('the files of the folder', () => {
  it('has an index and the files of the parts, and nothing else', () => {
    expect(files).toContain('index.ts');
    expect(readdirSync(FOLDER).filter((name) => !name.endsWith('.ts'))).toStrictEqual([]);
  });

  it.each(files)('%s imports the protocol folder, the files of this folder and the hash module of Node, and no other folder of the package', (name) => {
    const text = readFileSync(join(FOLDER, name), 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s+'([^']+)'/g)) {
      const specifier = match[1]!;
      const allowed = specifier.startsWith('./') || specifier === '../protocol/index.ts' || specifier === 'node:crypto';
      expect(allowed, `${name} imports ${specifier}`).toBe(true);
    }
  });

  it.each(files)('%s reads no environment variable and no file, makes no connection, and does not read the clock', (name) => {
    const text = readFileSync(join(FOLDER, name), 'utf8');
    for (const forbidden of ['process.env', 'node:fs', 'readFileSync', 'writeFileSync', 'node:child_process', 'node:http', 'node:https', 'node:net', 'node:dns', 'fetch(', 'Date.now', 'new Date()', 'Math.random']) {
      expect(text.includes(forbidden), `${name} uses ${forbidden}`).toBe(false);
    }
  });
});
