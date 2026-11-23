// agents/order-desk/test/checks/book.test.ts: the order book of the Order Desk. The book holds one entry for each purchase order number of a tenant, and it counts a number without regard to case, as the
// supplier portal does. `MemoryOrderBook` and `FileOrderBook` pass one table of cases. The file book keeps its entries in one JSON file: a new instance reads them, a write is whole or it is not there,
// and a damaged file is an error and never an empty book. The question: can a purchase order number that was recorded read as new?
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileOrderBook, MemoryOrderBook, ORDER_BOOK_LIMIT } from '../../src/checks/index.ts';
import type { BookFs, OrderBook } from '../../src/checks/index.ts';

const folders: string[] = [];
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});
/** A new folder below the temporary folder. A test removes it when it ends. */
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'order-book-'));
  folders.push(path);
  return path;
}

const SCHEMA = 'order-desk.orders.v1';
const entry = (n: number): { tenant: string; po_number: string; order_id: string } => ({ tenant: 'run1', po_number: `po-${n}`, order_id: `SO-${n}` });
const fileOf = (orders: unknown, over: Record<string, unknown> = {}): string => JSON.stringify({ schema: SCHEMA, orders, ...over });

const BOOKS: Array<[string, () => OrderBook]> = [
  ['MemoryOrderBook', () => new MemoryOrderBook()],
  ['FileOrderBook', () => new FileOrderBook(join(folder(), 'orders.json'))],
];

describe.each(BOOKS)('%s', (_name, make) => {
  it('has no order for a number that it was not given, and has the order after record', async () => {
    const book = make();
    expect(await book.has('run1', 'run1-0001')).toBe(false);
    await book.record('run1', 'run1-0001', 'SO-run1-0001');
    expect(await book.has('run1', 'run1-0001')).toBe(true);
    expect(await book.has('run1', 'run1-0002')).toBe(false);
  });

  it('counts a purchase order number without regard to case, in both directions', async () => {
    const book = make();
    await book.record('run1', 'PO-7', 'SO-1');
    await book.record('run1', 'po-8', 'SO-2');
    expect(await book.has('run1', 'po-7')).toBe(true);
    expect(await book.has('run1', 'Po-7')).toBe(true);
    expect(await book.has('run1', 'PO-8')).toBe(true);
    expect(await book.has('run1', 'PO-9')).toBe(false);
  });

  it('keeps the tenants apart', async () => {
    const book = make();
    await book.record('run1', 'PO-7', 'SO-1');
    expect(await book.has('run2', 'PO-7')).toBe(false);
    await book.record('run2', 'PO-7', 'SO-2');
    expect(await book.has('run2', 'po-7')).toBe(true);
  });

  it('keeps tenant and number apart even when a text of one looks like a join of both', async () => {
    const book = make();
    await book.record('a-b', 'c', 'SO-1');
    expect(await book.has('a', 'b-c')).toBe(false);
    expect(await book.has('a-b', 'c')).toBe(true);
  });

  it('takes the same order again, and refuses another order id for a number that it holds', async () => {
    const book = make();
    await book.record('run1', 'PO-7', 'SO-1');
    await expect(book.record('run1', 'PO-7', 'SO-1')).resolves.toBeUndefined();
    await expect(book.record('run1', 'po-7', 'SO-2')).rejects.toThrow('another order');
    expect(await book.has('run1', 'PO-7')).toBe(true);
  });

  it('refuses an argument that is not a text of 1 to 64 characters, in has and in record, and records nothing for it', async () => {
    const book = make();
    const long = 'x'.repeat(65);
    for (const bad of [undefined, null, 5, '', long, {}] as unknown[]) {
      await expect(book.has(bad as string, 'po-1'), String(bad)).rejects.toBeInstanceOf(TypeError);
      await expect(book.has('run1', bad as string), String(bad)).rejects.toBeInstanceOf(TypeError);
      await expect(book.record(bad as string, 'po-1', 'SO-1'), String(bad)).rejects.toBeInstanceOf(TypeError);
      await expect(book.record('run1', bad as string, 'SO-1'), String(bad)).rejects.toBeInstanceOf(TypeError);
      await expect(book.record('run1', 'po-1', bad as string), String(bad)).rejects.toBeInstanceOf(TypeError);
    }
    expect(await book.has('run1', 'po-1')).toBe(false);
    // The twin: 64 characters pass.
    await book.record('run1', 'p'.repeat(64), 's'.repeat(64));
    expect(await book.has('run1', 'P'.repeat(64))).toBe(true);
  });
});

describe('MemoryOrderBook', () => {
  it(`holds ${ORDER_BOOK_LIMIT} orders and refuses the next one, and it answers for the orders that it holds`, async () => {
    const book = new MemoryOrderBook();
    for (let n = 0; n < ORDER_BOOK_LIMIT; n += 1) await book.record('run1', `po-${n}`, `SO-${n}`);
    await expect(book.record('run1', 'po-new', 'SO-new')).rejects.toBeInstanceOf(RangeError);
    expect(await book.has('run1', 'po-new')).toBe(false);
    expect(await book.has('run1', 'PO-0')).toBe(true);
    expect(await book.has('run1', `po-${ORDER_BOOK_LIMIT - 1}`)).toBe(true);
    // An order that the book holds is taken again when it is full.
    await expect(book.record('run1', 'po-5', 'SO-5')).resolves.toBeUndefined();
  });
});

describe('FileOrderBook', () => {
  it('is read by a new instance on the same file: a restart loses no order', async () => {
    const file = join(folder(), 'orders.json');
    const first = new FileOrderBook(file);
    await first.record('run1', 'PO-7', 'SO-1');
    const second = new FileOrderBook(file);
    expect(await second.has('run1', 'po-7')).toBe(true);
    expect(await second.has('run1', 'po-8')).toBe(false);
    await second.record('run1', 'po-8', 'SO-2');
    expect(await first.has('run1', 'PO-8')).toBe(true);
  });

  it('writes one JSON file with the schema and one entry for each order, in the order of the records, with the number as it was written', async () => {
    const file = join(folder(), 'orders.json');
    const book = new FileOrderBook(file);
    await book.record('run1', 'PO-7', 'SO-1');
    await book.record('run2', 'po-8', 'SO-2');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      schema: SCHEMA,
      orders: [{ tenant: 'run1', po_number: 'PO-7', order_id: 'SO-1' }, { tenant: 'run2', po_number: 'po-8', order_id: 'SO-2' }],
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps the first order id of a number when a second one comes, in the file too', async () => {
    const file = join(folder(), 'orders.json');
    const book = new FileOrderBook(file);
    await book.record('run1', 'PO-7', 'SO-1');
    await expect(book.record('run1', 'po-7', 'SO-2')).rejects.toThrow('another order');
    expect(JSON.parse(readFileSync(file, 'utf8')).orders).toEqual([{ tenant: 'run1', po_number: 'PO-7', order_id: 'SO-1' }]);
  });

  it('is an empty book when the file is not there, and it makes the folders of the path', async () => {
    const file = join(folder(), 'state', 'deep', 'orders.json');
    const book = new FileOrderBook(file);
    expect(statSync(dirname(file)).isDirectory()).toBe(true);
    expect(await book.has('run1', 'po-1')).toBe(false);
    await book.record('run1', 'po-1', 'SO-1');
    expect(readdirSync(dirname(file))).toEqual(['orders.json']);
  });

  it('reads the file at each call, so a file that is damaged after the start is seen', async () => {
    const file = join(folder(), 'orders.json');
    const book = new FileOrderBook(file);
    await book.record('run1', 'po-1', 'SO-1');
    expect(await book.has('run1', 'po-1')).toBe(true);
    writeFileSync(file, 'not json');
    await expect(book.has('run1', 'po-1')).rejects.toThrow('damaged');
  });

  it('holds 10,000 orders: a file with that many answers, and a record for a new number is refused', async () => {
    const file = join(folder(), 'orders.json');
    writeFileSync(file, fileOf(Array.from({ length: ORDER_BOOK_LIMIT }, (_, n) => entry(n))));
    const book = new FileOrderBook(file);
    expect(await book.has('run1', 'PO-9999')).toBe(true);
    expect(await book.has('run1', 'po-10000')).toBe(false);
    await expect(book.record('run1', 'po-10000', 'SO-10000')).rejects.toBeInstanceOf(RangeError);
    await expect(book.record('run1', 'po-3', 'SO-3')).resolves.toBeUndefined();
  });

  describe('a damaged file', () => {
    const damaged: Array<[string, string]> = [
      ['an empty file', ''],
      ['text that is not JSON', 'orders'],
      ['JSON that is cut', '{"schema":"order-desk.orders.v1","orders":['],
      ['JSON null', 'null'],
      ['a list', '[]'],
      ['another schema', fileOf([], { schema: 'order-desk.orders.v2' })],
      ['no schema', JSON.stringify({ orders: [] })],
      ['no orders', JSON.stringify({ schema: SCHEMA })],
      ['orders that are not a list', fileOf({})],
      ['a member that is not listed', fileOf([], { note: 'x' })],
      ['an entry that is not an object', fileOf(['po-1'])],
      ['an entry with a member missing', fileOf([{ tenant: 'run1', po_number: 'po-1' }])],
      ['an entry with a member that is not listed', fileOf([{ ...entry(1), extra: 1 }])],
      ['an entry with a member that is not a text', fileOf([{ ...entry(1), order_id: 5 }])],
      ['an entry with an empty text', fileOf([{ ...entry(1), tenant: '' }])],
      ['an entry with a text over 64 characters', fileOf([{ ...entry(1), po_number: 'x'.repeat(65) }])],
      ['two entries for one number that differ in case', fileOf([entry(1), { ...entry(1), po_number: 'PO-1', order_id: 'SO-9' }])],
      ['two entries that are the same', fileOf([entry(1), entry(1)])],
      ['more entries than the book holds', fileOf(Array.from({ length: ORDER_BOOK_LIMIT + 1 }, (_, n) => entry(n)))],
    ];

    it.each(damaged)('is an error in has and in record, and the file is not written over: %s', async (_name, text) => {
      const file = join(folder(), 'orders.json');
      writeFileSync(file, text);
      const book = new FileOrderBook(file);
      await expect(book.has('run1', 'po-1')).rejects.toThrow('damaged');
      await expect(book.record('run1', 'po-99', 'SO-99')).rejects.toThrow('damaged');
      expect(readFileSync(file, 'utf8')).toBe(text);
      // The twin: a good file with an entry for the same number is read.
      const good = join(folder(), 'orders.json');
      writeFileSync(good, fileOf([entry(1)]));
      expect(await new FileOrderBook(good).has('run1', 'po-1')).toBe(true);
    });

    it('does not say what the file holds in its message', async () => {
      const file = join(folder(), 'orders.json');
      writeFileSync(file, fileOf([{ tenant: 'run1', po_number: 'secret-marker-1234', order_id: 5 }]));
      const failure = await new FileOrderBook(file).has('run1', 'po-1').then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain('secret-marker');
    });

    it('is an error when the path is a folder', async () => {
      const base = folder();
      const book = new FileOrderBook(join(base, 'orders.json'));
      mkdirSync(join(base, 'orders.json'));
      await expect(book.has('run1', 'po-1')).rejects.toThrow(Error);
    });
  });

  describe('a write', () => {
    it('is whole or it is not there: a rename that fails leaves the old file, removes the temporary file, and the next write works', async () => {
      const file = join(folder(), 'orders.json');
      await new FileOrderBook(file).record('run1', 'po-1', 'SO-1');
      const before = readFileSync(file, 'utf8');
      const broken = new FileOrderBook(file, { fs: { rename: () => Promise.reject(new Error('the disk is full')) } });
      await expect(broken.record('run1', 'po-2', 'SO-2')).rejects.toThrow('the disk is full');
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(readdirSync(dirname(file))).toEqual(['orders.json']);
      expect(await broken.has('run1', 'po-2')).toBe(false);
      // The same instance writes again when the disk works.
      const working = new FileOrderBook(file);
      await working.record('run1', 'po-2', 'SO-2');
      expect(await new FileOrderBook(file).has('run1', 'po-2')).toBe(true);
    });

    it('leaves the old file when the temporary file cannot be written or synced, and the record is refused', async () => {
      const file = join(folder(), 'orders.json');
      await new FileOrderBook(file).record('run1', 'po-1', 'SO-1');
      const before = readFileSync(file, 'utf8');
      for (const fs of [{ writeFile: () => Promise.reject(new Error('no space')) }, { fsync: () => Promise.reject(new Error('io error')) }] as Array<Partial<BookFs>>) {
        const book = new FileOrderBook(file, { fs });
        await expect(book.record('run1', 'po-2', 'SO-2')).rejects.toThrow(Error);
        expect(readFileSync(file, 'utf8')).toBe(before);
      }
      expect(readdirSync(dirname(file))).toEqual(['orders.json']);
    });

    it('is a rejection when the sync of the folder fails: the record is not reported as stored', async () => {
      const file = join(folder(), 'orders.json');
      const dir = dirname(file);
      const book = new FileOrderBook(file, { fs: { fsync: (path) => (path === dir ? Promise.reject(new Error('io error')) : Promise.resolve()) } });
      await expect(book.record('run1', 'po-1', 'SO-1')).rejects.toThrow('io error');
    });

    it('syncs the temporary file, renames it over the file, and then syncs the folder, in this order', async () => {
      const file = join(folder(), 'orders.json');
      const dir = dirname(file);
      const events: string[] = [];
      const book = new FileOrderBook(file, {
        fs: {
          fsync: async (path) => { events.push(path === dir ? 'fsync folder' : path.endsWith('.tmp') ? 'fsync temporary' : `fsync ${path}`); },
          rename: async (from, to) => { events.push(to === file && from.endsWith('.tmp') ? 'rename' : `rename ${from} ${to}`); await rename(from, to); },
        },
      });
      await book.record('run1', 'po-1', 'SO-1');
      expect(events).toEqual(['fsync temporary', 'rename', 'fsync folder']);
    });

    it('does not write when the record is a number that the book holds, or an argument that is wrong', async () => {
      const file = join(folder(), 'orders.json');
      const events: string[] = [];
      const book = new FileOrderBook(file, { fs: { writeFile: async () => { events.push('write'); throw new Error('stop'); } } });
      await expect(book.record('run1', 5 as unknown as string, 'SO-1')).rejects.toBeInstanceOf(TypeError);
      expect(events).toEqual([]);
      writeFileSync(file, fileOf([entry(1)]));
      await expect(book.record('run1', 'PO-1', 'SO-1')).resolves.toBeUndefined();
      await expect(book.record('run1', 'PO-1', 'SO-2')).rejects.toThrow('another order');
      expect(events).toEqual([]);
    });

    it('lands every record of calls that run at one time: no record is lost, and the file lists them in the order of the calls', async () => {
      const file = join(folder(), 'orders.json');
      const book = new FileOrderBook(file);
      const count = 25;
      await Promise.all(Array.from({ length: count }, (_, n) => book.record('run1', `po-${n}`, `SO-${n}`)));
      const orders = (JSON.parse(readFileSync(file, 'utf8')) as { orders: Array<{ po_number: string }> }).orders;
      expect(orders.map((order) => order.po_number)).toEqual(Array.from({ length: count }, (_, n) => `po-${n}`));
      expect(readdirSync(dirname(file))).toEqual(['orders.json']);
    });

    it('lets a record for the same number that runs at one time win once: the second call is refused when its order id differs', async () => {
      const file = join(folder(), 'orders.json');
      const book = new FileOrderBook(file);
      const results = await Promise.allSettled([book.record('run1', 'PO-1', 'SO-1'), book.record('run1', 'po-1', 'SO-2'), book.record('run1', 'PO-1', 'SO-1')]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
      expect(JSON.parse(readFileSync(file, 'utf8')).orders).toEqual([{ tenant: 'run1', po_number: 'PO-1', order_id: 'SO-1' }]);
    });

    it('continues with the next record when a record before it failed', async () => {
      const file = join(folder(), 'orders.json');
      let fail = true;
      const book = new FileOrderBook(file, { fs: { rename: async (from, to) => { if (fail) { fail = false; throw new Error('the disk is full'); } await rename(from, to); } } });
      const results = await Promise.allSettled([book.record('run1', 'po-1', 'SO-1'), book.record('run1', 'po-2', 'SO-2')]);
      expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
      expect(await book.has('run1', 'po-1')).toBe(false);
      expect(await book.has('run1', 'po-2')).toBe(true);
    });
  });

  describe('the path', () => {
    it('is refused when it is not a text, is empty, holds a NUL character, or has a ".." segment', () => {
      const base = folder();
      for (const bad of [undefined, null, 5, '', `${base}/a\0b/orders.json`, `${base}/../orders.json`, '../orders.json', `${base}\\..\\orders.json`] as unknown[]) {
        expect(() => new FileOrderBook(bad as string), String(bad)).toThrow(Error);
      }
      expect(() => new FileOrderBook(join(base, 'orders.json'))).not.toThrow();
    });

    it('is refused when a folder of it cannot be made: a file stands in the way', () => {
      const base = folder();
      const blocker = join(base, 'blocker');
      writeFileSync(blocker, 'a file');
      expect(() => new FileOrderBook(join(blocker, 'state', 'orders.json'))).toThrow(Error);
    });
  });
});
