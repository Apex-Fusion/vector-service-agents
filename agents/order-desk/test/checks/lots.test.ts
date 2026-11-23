// agents/order-desk/test/checks/lots.test.ts: the lots file of the Order Desk. `loadLots` reads the bytes of the file, parses them with the parser of the kit, and gives the hash of the bytes. The manifest
// of the Order Desk holds that hash, so the test pins it: a change of the file is a change of the hash. The question: can a damaged file load, and is the hash the hash of the bytes that are served?
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOTS_SCHEMA, lotSizeOf, lotsFileSha256 } from '@vsa/usecase-kit/inventory';
import { loadLots } from '../../src/checks/index.ts';
import { LOTS_PATH } from './samples.ts';

/** The SHA-256 of the bytes of `lots.json`. */
const LOTS_SHA256 = 'b6879bc6de9226b8d4c56cfe53a8a956ff8c064038ff3ce2885d8bba28523fea';

const folders: string[] = [];
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A file with these bytes, in a new folder below the temporary folder. */
function fileWith(bytes: string | Uint8Array): string {
  const folder = mkdtempSync(join(tmpdir(), 'order-desk-lots-'));
  folders.push(folder);
  const path = join(folder, 'lots.json');
  writeFileSync(path, bytes);
  return path;
}

const GOOD = { schema: LOTS_SCHEMA, items: [{ sku: 'GLV-NIT-M', lots: { 'lot-small': 10, 'lot-medium': 50, 'lot-large': 200 } }] };

describe('the lots file of the package', () => {
  it('has the pinned hash, and the hash is the hash of the bytes of the file', () => {
    const loaded = loadLots(LOTS_PATH);
    expect(loaded.sha256).toBe(LOTS_SHA256);
    expect(loaded.sha256).toBe(createHash('sha256').update(readFileSync(LOTS_PATH)).digest('hex'));
    expect(loaded.sha256).toBe(lotsFileSha256(loaded.text));
  });

  it('gives the text of the file as it is, so that a host serves the bytes that the hash names', () => {
    const loaded = loadLots(LOTS_PATH);
    expect(loaded.text).toBe(readFileSync(LOTS_PATH, 'utf8'));
    expect(Buffer.from(loaded.text, 'utf8').equals(readFileSync(LOTS_PATH))).toBe(true);
  });

  it('holds the sizes of the three SKUs of the catalogue of the mock system', () => {
    const { file } = loadLots(LOTS_PATH);
    expect(file.schema).toBe(LOTS_SCHEMA);
    expect(file.items.map((item) => item.sku)).toEqual(['GLV-NIT-M', 'SYR-10ML', 'MSK-N95']);
    const sizes = (sku: string): Array<number | null> => (['lot-small', 'lot-medium', 'lot-large'] as const).map((lot) => lotSizeOf(file, sku, lot));
    expect(sizes('GLV-NIT-M')).toEqual([10, 50, 200]);
    expect(sizes('SYR-10ML')).toEqual([25, 100, 400]);
    expect(sizes('MSK-N95')).toEqual([20, 100, 400]);
    expect(sizes('OTHER')).toEqual([null, null, null]);
  });
});

describe('the hash', () => {
  it('is the hash of the bytes and not of a canonical form: the same data with other white space has another hash', () => {
    const compact = fileWith(JSON.stringify(GOOD));
    const spaced = fileWith(JSON.stringify(GOOD, null, 4));
    const a = loadLots(compact);
    const b = loadLots(spaced);
    expect(a.file).toEqual(b.file);
    expect(a.sha256).not.toBe(b.sha256);
    expect(a.sha256).toBe(createHash('sha256').update(JSON.stringify(GOOD)).digest('hex'));
    expect(b.sha256).toBe(createHash('sha256').update(JSON.stringify(GOOD, null, 4)).digest('hex'));
  });

  it('is the hash of the file that was given, so a file with a final line break and one without it differ', () => {
    expect(loadLots(fileWith(`${JSON.stringify(GOOD)}\n`)).sha256).not.toBe(loadLots(fileWith(JSON.stringify(GOOD))).sha256);
  });
});

describe('a damaged file', () => {
  const damaged: Array<[string, string | Uint8Array]> = [
    ['an empty file', ''],
    ['text that is not JSON', 'not json'],
    ['JSON that is cut', '{"schema":"vector.usecase.lots.v1","items":['],
    ['JSON null', 'null'],
    ['a list', '[]'],
    ['another schema', JSON.stringify({ ...GOOD, schema: 'vector.usecase.lots.v2' })],
    ['a member that is not listed', JSON.stringify({ ...GOOD, note: 'x' })],
    ['no items', JSON.stringify({ schema: LOTS_SCHEMA })],
    ['an empty list of items', JSON.stringify({ schema: LOTS_SCHEMA, items: [] })],
    ['a size of zero', JSON.stringify({ ...GOOD, items: [{ sku: 'GLV-NIT-M', lots: { 'lot-small': 0, 'lot-medium': 50, 'lot-large': 200 } }] })],
    ['a size that is a fraction', JSON.stringify({ ...GOOD, items: [{ sku: 'GLV-NIT-M', lots: { 'lot-small': 1.5, 'lot-medium': 50, 'lot-large': 200 } }] })],
    ['a lot that is missing', JSON.stringify({ ...GOOD, items: [{ sku: 'GLV-NIT-M', lots: { 'lot-small': 10, 'lot-medium': 50 } }] })],
    ['a SKU that is listed two times', JSON.stringify({ ...GOOD, items: [GOOD.items[0], GOOD.items[0]] })],
    ['a SKU that is not an identifier', JSON.stringify({ ...GOOD, items: [{ sku: 'GLV NIT', lots: GOOD.items[0]!.lots }] })],
    ['a byte order mark before the JSON', `\ufeff${JSON.stringify(GOOD)}`],
    ['bytes that are not UTF-8', Buffer.concat([Buffer.from('{"schema":"vector.usecase.lots.v1","items":[],"x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')])],
  ];

  it.each(damaged)('does not load: %s', (_name, bytes) => {
    expect(() => loadLots(fileWith(bytes))).toThrow(Error);
    // The twin: the same folder layout with a good file loads.
    expect(loadLots(fileWith(JSON.stringify(GOOD))).file.items).toHaveLength(1);
  });

  it('does not load a file that is not there, and a path that is a folder', () => {
    const folder = mkdtempSync(join(tmpdir(), 'order-desk-lots-'));
    folders.push(folder);
    expect(() => loadLots(join(folder, 'missing.json'))).toThrow(Error);
    expect(() => loadLots(folder)).toThrow(Error);
  });

  it('says what is wrong and never repeats a value of the file: the text of the file can be secret', () => {
    const secret = 'secret-marker-1234';
    const cases: Array<[string, string]> = [
      [`${secret} is not json`, 'JSON'],
      [JSON.stringify({ ...GOOD, items: [{ sku: `${secret} x`, lots: GOOD.items[0]!.lots }] }), 'sku'],
      [JSON.stringify({ ...GOOD, items: [{ sku: 'GLV-NIT-M', lots: { 'lot-small': 10, 'lot-medium': 50, 'lot-large': `${secret}` } }] }), 'lot-large'],
    ];
    for (const [text, words] of cases) {
      let message = '';
      try {
        loadLots(fileWith(text));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, text).toContain(words);
      expect(message, text).not.toContain(secret);
    }
  });
});
