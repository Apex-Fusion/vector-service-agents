// agents/bid-desk/test/checks/pricelist.test.ts: the price list of the Bid Desk. `loadPriceList` reads the bytes of the file, parses them with the parser of the kit, and gives the hash of the bytes. The manifest
// of the Bid Desk holds that hash, so the test pins it: a change of the file is a change of the hash. The question: can a damaged file load, and is the hash the hash of the bytes that are served?
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PRICE_LIST_SCHEMA, parsePriceList, priceFor, priceListSha256 } from '@vsa/usecase-kit/bids';
import { loadPriceList } from '../../src/checks/index.ts';
import { PRICE_LIST_PATH } from './samples.ts';

/** The SHA-256 of the bytes of the golden price list. */
const GOLDEN_SHA256 = 'b63a8b04ed7c662bc6a5edf360b79c9bec286ef4485d438e3691a1634f1bf6d2';

const folders: string[] = [];
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A file with these bytes, in a new folder below the temporary folder. */
function fileWith(bytes: string | Uint8Array): string {
  const folder = mkdtempSync(join(tmpdir(), 'bid-desk-price-list-'));
  folders.push(folder);
  const path = join(folder, 'price-list.json');
  writeFileSync(path, bytes);
  return path;
}

const ENTRY = { sku: 'GLV-NIT-M', lead_time_days: 12, breaks: [{ min_quantity: 1, unit_price: 138 }, { min_quantity: 50, unit_price: 130 }] };
const GOOD = { schema: PRICE_LIST_SCHEMA, items: [ENTRY] };
/** The text of a list with one entry whose members are replaced. */
const withEntry = (over: Record<string, unknown>): string => JSON.stringify({ ...GOOD, items: [{ ...ENTRY, ...over }] });

describe('the golden price list', () => {
  it('has the pinned hash, and the hash is the hash of the bytes of the file', () => {
    const loaded = loadPriceList(PRICE_LIST_PATH);
    expect(loaded.sha256).toBe(GOLDEN_SHA256);
    expect(loaded.sha256).toBe(createHash('sha256').update(readFileSync(PRICE_LIST_PATH)).digest('hex'));
    expect(loaded.sha256).toBe(priceListSha256(loaded.text));
  });

  it('gives the text of the file as it is, so that a host serves the bytes that the hash names', () => {
    const loaded = loadPriceList(PRICE_LIST_PATH);
    expect(loaded.text).toBe(readFileSync(PRICE_LIST_PATH, 'utf8'));
    expect(Buffer.from(loaded.text, 'utf8').equals(readFileSync(PRICE_LIST_PATH))).toBe(true);
  });

  it('gives the list that the parser of the kit gives for the text, with the three SKUs of the catalogue of the mock system', () => {
    const { list, text } = loadPriceList(PRICE_LIST_PATH);
    const parsed = parsePriceList(JSON.parse(text));
    if (!parsed.ok) throw new Error(parsed.detail);
    expect(list).toEqual(parsed.value);
    expect(list.schema).toBe(PRICE_LIST_SCHEMA);
    expect(list.items.map((item) => item.sku)).toEqual(['GLV-NIT-M', 'SYR-10ML', 'MSK-N95']);
  });

  it('gives a list whose prices follow the rule of the break, so the job can price a request from it', () => {
    const { list } = loadPriceList(PRICE_LIST_PATH);
    expect(priceFor(list, 'GLV-NIT-M', 100)).toEqual({ unit_price: 122, lead_time_days: 12 });
    expect(priceFor(list, 'MSK-N95', 24)).toEqual({ unit_price: 64, lead_time_days: 20 });
    expect(priceFor(list, 'MSK-N95', 25)).toEqual({ unit_price: 59, lead_time_days: 20 });
    expect(priceFor(list, 'OTHER', 1)).toBeNull();
  });
});

describe('the hash', () => {
  it('is the hash of the bytes and not of a canonical form: the same data with other white space has another hash', () => {
    const a = loadPriceList(fileWith(JSON.stringify(GOOD)));
    const b = loadPriceList(fileWith(JSON.stringify(GOOD, null, 4)));
    expect(a.list).toEqual(b.list);
    expect(a.sha256).not.toBe(b.sha256);
    expect(a.sha256).toBe(createHash('sha256').update(JSON.stringify(GOOD)).digest('hex'));
    expect(b.sha256).toBe(createHash('sha256').update(JSON.stringify(GOOD, null, 4)).digest('hex'));
  });

  it('is the hash of the file that was given, so a file with a final line break and one without it differ', () => {
    expect(loadPriceList(fileWith(`${JSON.stringify(GOOD)}\n`)).sha256).not.toBe(loadPriceList(fileWith(JSON.stringify(GOOD))).sha256);
  });
});

describe('a damaged file', () => {
  const damaged: Array<[string, string | Uint8Array]> = [
    ['an empty file', ''],
    ['text that is not JSON', 'not json'],
    ['JSON that is cut', '{"schema":"vector.usecase.price-list.v1","items":['],
    ['JSON null', 'null'],
    ['a list', '[]'],
    ['another schema', JSON.stringify({ ...GOOD, schema: 'vector.usecase.price-list.v2' })],
    ['a member that is not listed', JSON.stringify({ ...GOOD, note: 'x' })],
    ['no items', JSON.stringify({ schema: PRICE_LIST_SCHEMA })],
    ['an empty list of items', JSON.stringify({ schema: PRICE_LIST_SCHEMA, items: [] })],
    ['a unit price of zero', withEntry({ breaks: [{ min_quantity: 1, unit_price: 0 }] })],
    ['a unit price that is a fraction', withEntry({ breaks: [{ min_quantity: 1, unit_price: 1.5 }] })],
    ['a unit price above 1,000,000', withEntry({ breaks: [{ min_quantity: 1, unit_price: 1_000_001 }] })],
    ['a unit price that is a text', withEntry({ breaks: [{ min_quantity: 1, unit_price: '138' }] })],
    ['a first minimum quantity above 1', withEntry({ breaks: [{ min_quantity: 2, unit_price: 138 }] })],
    ['minimum quantities that do not rise', withEntry({ breaks: [{ min_quantity: 1, unit_price: 138 }, { min_quantity: 1, unit_price: 130 }] })],
    ['a lead time of 366 days', withEntry({ lead_time_days: 366 })],
    ['no breaks', withEntry({ breaks: [] })],
    ['a SKU that is listed two times', JSON.stringify({ ...GOOD, items: [ENTRY, ENTRY] })],
    ['a SKU that is not an identifier', withEntry({ sku: 'GLV NIT' })],
    ['a byte order mark before the JSON', `\ufeff${JSON.stringify(GOOD)}`],
    ['bytes that are not UTF-8', Buffer.concat([Buffer.from('{"schema":"vector.usecase.price-list.v1","items":[],"x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')])],
  ];

  it.each(damaged)('does not load: %s', (_name, bytes) => {
    expect(() => loadPriceList(fileWith(bytes))).toThrow(Error);
    // The twin: the same folder layout with a good file loads.
    expect(loadPriceList(fileWith(JSON.stringify(GOOD))).list.items).toHaveLength(1);
  });

  it('does not load a file that is not there, and a path that is a folder', () => {
    const folder = mkdtempSync(join(tmpdir(), 'bid-desk-price-list-'));
    folders.push(folder);
    expect(() => loadPriceList(join(folder, 'missing.json'))).toThrow(Error);
    expect(() => loadPriceList(folder)).toThrow(Error);
  });

  it('names the file and says what is wrong, and never repeats a value of the file: the text of the file can be secret', () => {
    const secret = 'secret-marker-1234';
    const cases: Array<[string, string]> = [
      [`${secret} is not json`, 'is not JSON'],
      [withEntry({ sku: `${secret} x` }), 'sku'],
      [withEntry({ breaks: [{ min_quantity: 1, unit_price: secret }] }), 'unit_price'],
      [withEntry({ lead_time_days: secret }), 'lead_time_days'],
    ];
    for (const [text, words] of cases) {
      let message = '';
      try {
        loadPriceList(fileWith(text));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, text).toContain('the price list file price-list.json');
      expect(message, text).toContain(words);
      expect(message, text).not.toContain(secret);
    }
    let notUtf8 = '';
    try {
      loadPriceList(fileWith(Buffer.from([0xff, 0xfe, 0xfd])));
    } catch (error) {
      notUtf8 = error instanceof Error ? error.message : String(error);
    }
    expect(notUtf8).toBe('the price list file price-list.json is not UTF-8 text');
  });
});
