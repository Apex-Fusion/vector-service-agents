// agents/bid-desk/test/checks/book.test.ts: the rfq book of the Bid Desk. The book holds one entry for each request for quotation that the agent answered, by the sender and the identifier as they were written,
// with the hash of the quote. `MemoryRfqBook` and `FileRfqBook` pass one table of cases. The file book keeps its entries in one JSON file: a new instance reads them, a write is whole or it is not there, and a
// damaged file, and a file that goes missing after the start, are errors and never an empty book. The question: can a request that was answered read as new, and can a request that was not answered read as old?
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRfqBook, MemoryRfqBook, RFQ_BOOK_LIMIT } from '../../src/checks/index.ts';
import type { BookFs, RfqBook } from '../../src/checks/index.ts';
import { OTHER_QUOTE_SHA256, OTHER_SENDER, QUOTE_SHA256, SENDER } from './samples.ts';

const folders: string[] = [];
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});
/** A new folder below the temporary folder. A test removes it when it ends. */
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'rfq-book-'));
  folders.push(path);
  return path;
}

/** The temporary file of a write: `.<name>.<hex>.tmp`. A test that lists a folder of a book skips these files, because a write that still runs has one. */
const TEMPORARY = /^\..+\.[0-9a-f]+\.tmp$/;
const filesIn = (path: string): string[] => readdirSync(path).filter((name) => !TEMPORARY.test(name));

const SCHEMA = 'bid-desk.rfq-book.v1';
const entry = (n: number, sender: string = SENDER): { sender_did: string; rfq_id: string; quote_sha256: string } => ({ sender_did: sender, rfq_id: `rfq-${n}`, quote_sha256: QUOTE_SHA256 });
const fileOf = (quotes: unknown, over: Record<string, unknown> = {}): string => JSON.stringify({ schema: SCHEMA, quotes, ...over });
/** The entries of the file of a book. A file that is not the file of a book is a fault of the test. */
function quotesOf(file: string): unknown {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof value !== 'object' || value === null || !('quotes' in value)) throw new Error('the file is not the file of a book');
  return value.quotes;
}

const BOOKS: Array<[string, () => RfqBook]> = [
  ['MemoryRfqBook', () => new MemoryRfqBook()],
  ['FileRfqBook', () => new FileRfqBook(join(folder(), 'rfq-book.json'))],
];

describe.each(BOOKS)('%s', (_name, make) => {
  it('has no entry for a request that it was not given, and has the entry after record', async () => {
    const book = make();
    expect(await book.has(SENDER, 'run1-rfq-1')).toBe(false);
    await book.record(SENDER, 'run1-rfq-1', QUOTE_SHA256);
    expect(await book.has(SENDER, 'run1-rfq-1')).toBe(true);
    expect(await book.has(SENDER, 'run1-rfq-2')).toBe(false);
  });

  it('counts the identifier as it was written: a text that differs in case is another request, in both directions', async () => {
    const book = make();
    await book.record(SENDER, 'RFQ-7', QUOTE_SHA256);
    expect(await book.has(SENDER, 'RFQ-7')).toBe(true);
    expect(await book.has(SENDER, 'rfq-7')).toBe(false);
    expect(await book.has(SENDER, 'Rfq-7')).toBe(false);
    // The other text is a new request: the book takes it, and it holds both.
    await book.record(SENDER, 'rfq-7', OTHER_QUOTE_SHA256);
    expect(await book.has(SENDER, 'rfq-7')).toBe(true);
    expect(await book.has(SENDER, 'RFQ-7')).toBe(true);
    expect(await book.has(SENDER, 'rfq-8')).toBe(false);
  });

  it('keeps the senders apart: the identifier of one sender is a new request for another sender', async () => {
    const book = make();
    await book.record(SENDER, 'rfq-7', QUOTE_SHA256);
    expect(await book.has(OTHER_SENDER, 'rfq-7')).toBe(false);
    await book.record(OTHER_SENDER, 'rfq-7', OTHER_QUOTE_SHA256);
    expect(await book.has(OTHER_SENDER, 'rfq-7')).toBe(true);
    expect(await book.has(SENDER, 'rfq-7')).toBe(true);
  });

  it('takes the same quote again, and refuses another quote for a request that it holds', async () => {
    const book = make();
    await book.record(SENDER, 'rfq-7', QUOTE_SHA256);
    await expect(book.record(SENDER, 'rfq-7', QUOTE_SHA256)).resolves.toBeUndefined();
    await expect(book.record(SENDER, 'rfq-7', OTHER_QUOTE_SHA256)).rejects.toThrow('another quote');
    expect(await book.has(SENDER, 'rfq-7')).toBe(true);
    // The twin: the same hash for another sender, or for another identifier, is a new request and is taken.
    await expect(book.record(OTHER_SENDER, 'rfq-7', OTHER_QUOTE_SHA256)).resolves.toBeUndefined();
    await expect(book.record(SENDER, 'rfq-8', OTHER_QUOTE_SHA256)).resolves.toBeUndefined();
  });

  it('refuses an argument that is not in its form, in has and in record, and records nothing for it', async () => {
    const book = make();
    const senders = [undefined, null, 5, '', 'did:vector:abc', SENDER.toUpperCase(), `${SENDER}0`, {}] as unknown[];
    const ids = [undefined, null, 5, '', 'x'.repeat(65), 'has space', '-lead', 'RFQ\u212a', {}] as unknown[];
    const hashes = [undefined, null, 5, '', 'AB'.repeat(32), 'ab'.repeat(31), `${QUOTE_SHA256}0`, {}] as unknown[];
    for (const bad of senders) {
      await expect(book.has(bad as string, 'rfq-1'), String(bad)).rejects.toBeInstanceOf(TypeError);
      await expect(book.record(bad as string, 'rfq-1', QUOTE_SHA256), String(bad)).rejects.toBeInstanceOf(TypeError);
    }
    for (const bad of ids) {
      await expect(book.has(SENDER, bad as string), String(bad)).rejects.toBeInstanceOf(TypeError);
      await expect(book.record(SENDER, bad as string, QUOTE_SHA256), String(bad)).rejects.toBeInstanceOf(TypeError);
    }
    for (const bad of hashes) await expect(book.record(SENDER, 'rfq-1', bad as string), String(bad)).rejects.toBeInstanceOf(TypeError);
    expect(await book.has(SENDER, 'rfq-1')).toBe(false);
    // The twin: an identifier of 64 characters passes, with a dot, a hyphen and an underscore in it.
    const long = `R${'x'.repeat(60)}._-`;
    expect(long).toHaveLength(64);
    await book.record(SENDER, long, QUOTE_SHA256);
    expect(await book.has(SENDER, long)).toBe(true);
  });

  it('does not say what an argument holds in the message of a refusal', async () => {
    const book = make();
    const secret = 'secret-marker-1234';
    const calls: Array<() => Promise<unknown>> = [
      () => book.has(secret, 'rfq-1'), () => book.has(SENDER, `${secret} x`), () => book.record(SENDER, 'rfq-1', secret), () => book.record(secret, 'rfq-1', QUOTE_SHA256),
    ];
    for (const call of calls) {
      const failure = await call().then(() => null, (error: unknown) => error);
      if (!(failure instanceof TypeError)) throw new Error('the call did not reject with a TypeError');
      expect(failure.message).not.toContain('secret-marker');
    }
  });
});

describe('MemoryRfqBook', () => {
  it(`holds ${RFQ_BOOK_LIMIT} entries and refuses the next one, and it answers for the entries that it holds`, async () => {
    const book = new MemoryRfqBook();
    for (let n = 0; n < RFQ_BOOK_LIMIT; n += 1) await book.record(SENDER, `rfq-${n}`, QUOTE_SHA256);
    await expect(book.record(SENDER, 'rfq-new', QUOTE_SHA256)).rejects.toBeInstanceOf(RangeError);
    expect(await book.has(SENDER, 'rfq-new')).toBe(false);
    expect(await book.has(SENDER, 'rfq-0')).toBe(true);
    expect(await book.has(SENDER, `rfq-${RFQ_BOOK_LIMIT - 1}`)).toBe(true);
    // An entry that the book holds is taken again when it is full, and nothing is dropped for the entry that was refused.
    await expect(book.record(SENDER, 'rfq-5', QUOTE_SHA256)).resolves.toBeUndefined();
    await expect(book.record(SENDER, 'rfq-5', OTHER_QUOTE_SHA256)).rejects.toThrow('another quote');
  });
});

describe('FileRfqBook', () => {
  it('is read by a new instance on the same file: a restart loses no entry', async () => {
    const file = join(folder(), 'rfq-book.json');
    const first = new FileRfqBook(file);
    await first.record(SENDER, 'RFQ-7', QUOTE_SHA256);
    const second = new FileRfqBook(file);
    expect(await second.has(SENDER, 'RFQ-7')).toBe(true);
    expect(await second.has(SENDER, 'rfq-7')).toBe(false);
    expect(await second.has(SENDER, 'rfq-8')).toBe(false);
    await second.record(SENDER, 'rfq-8', OTHER_QUOTE_SHA256);
    expect(await first.has(SENDER, 'rfq-8')).toBe(true);
    // The new instance keeps the hash of the first quote: a second quote for the request is an error there too.
    await expect(second.record(SENDER, 'RFQ-7', OTHER_QUOTE_SHA256)).rejects.toThrow('another quote');
  });

  it('writes one JSON file with the schema and one entry for each request, with the sender, the identifier as it was written and the hash of the quote, in the order of the records', async () => {
    const file = join(folder(), 'rfq-book.json');
    const book = new FileRfqBook(file);
    await book.record(SENDER, 'RFQ-7', QUOTE_SHA256);
    await book.record(OTHER_SENDER, 'rfq-8', OTHER_QUOTE_SHA256);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      schema: SCHEMA,
      quotes: [{ sender_did: SENDER, rfq_id: 'RFQ-7', quote_sha256: QUOTE_SHA256 }, { sender_did: OTHER_SENDER, rfq_id: 'rfq-8', quote_sha256: OTHER_QUOTE_SHA256 }],
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps the first quote hash of a request when a second one comes, in the file too', async () => {
    const file = join(folder(), 'rfq-book.json');
    const book = new FileRfqBook(file);
    await book.record(SENDER, 'rfq-7', QUOTE_SHA256);
    await expect(book.record(SENDER, 'rfq-7', OTHER_QUOTE_SHA256)).rejects.toThrow('another quote');
    expect(quotesOf(file)).toEqual([{ sender_did: SENDER, rfq_id: 'rfq-7', quote_sha256: QUOTE_SHA256 }]);
  });

  it('writes the empty book at the start when the file is not there, and it makes the folders of the path', async () => {
    const file = join(folder(), 'state', 'deep', 'rfq-book.json');
    const book = new FileRfqBook(file);
    expect(statSync(dirname(file)).isDirectory()).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schema: SCHEMA, quotes: [] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(filesIn(dirname(file))).toEqual(['rfq-book.json']);
    expect(await book.has(SENDER, 'rfq-1')).toBe(false);
    await book.record(SENDER, 'rfq-1', QUOTE_SHA256);
    expect(filesIn(dirname(file))).toEqual(['rfq-book.json']);
  });

  it('does not write over a file that is there when it starts: the entries of an earlier run stay, and so does a file that is damaged', () => {
    const file = join(folder(), 'rfq-book.json');
    const text = fileOf([entry(1), entry(2)]);
    writeFileSync(file, text);
    expect(() => new FileRfqBook(file)).not.toThrow();
    expect(readFileSync(file, 'utf8')).toBe(text);
    const broken = join(folder(), 'rfq-book.json');
    writeFileSync(broken, 'not json');
    expect(() => new FileRfqBook(broken)).not.toThrow();
    expect(readFileSync(broken, 'utf8')).toBe('not json');
  });

  it('is an error and never an empty book when the file is missing after the start, and a restart with no file is a first start', async () => {
    const file = join(folder(), 'rfq-book.json');
    const book = new FileRfqBook(file);
    await book.record(SENDER, 'RFQ-7', QUOTE_SHA256);
    // The twin: the book with its file knows the request.
    expect(await book.has(SENDER, 'RFQ-7')).toBe(true);
    rmSync(file);
    await expect(book.has(SENDER, 'RFQ-7')).rejects.toThrow('missing');
    await expect(book.has(SENDER, 'rfq-8')).rejects.toThrow('missing');
    await expect(book.record(SENDER, 'rfq-8', QUOTE_SHA256)).rejects.toThrow('missing');
    // A record does not make the file again. Only a start makes it.
    expect(existsSync(file)).toBe(false);
    const restarted = new FileRfqBook(file);
    expect(existsSync(file)).toBe(true);
    expect(await restarted.has(SENDER, 'RFQ-7')).toBe(false);
  });

  it('is an error when the folder of the file is removed after the start', async () => {
    const file = join(folder(), 'state', 'rfq-book.json');
    const book = new FileRfqBook(file);
    await book.record(SENDER, 'rfq-1', QUOTE_SHA256);
    expect(await book.has(SENDER, 'rfq-1')).toBe(true);
    rmSync(dirname(file), { recursive: true });
    await expect(book.has(SENDER, 'rfq-1')).rejects.toThrow('missing');
    await expect(book.record(SENDER, 'rfq-2', QUOTE_SHA256)).rejects.toThrow(Error);
  });

  it('reads the file at each call, so a file that is damaged after the start is seen', async () => {
    const file = join(folder(), 'rfq-book.json');
    const book = new FileRfqBook(file);
    await book.record(SENDER, 'rfq-1', QUOTE_SHA256);
    expect(await book.has(SENDER, 'rfq-1')).toBe(true);
    writeFileSync(file, 'not json');
    await expect(book.has(SENDER, 'rfq-1')).rejects.toThrow('damaged');
  });

  it('holds 10,000 entries: a file with that many answers, and a record for a new request is refused', async () => {
    const file = join(folder(), 'rfq-book.json');
    writeFileSync(file, fileOf(Array.from({ length: RFQ_BOOK_LIMIT }, (_, n) => entry(n))));
    const book = new FileRfqBook(file);
    expect(await book.has(SENDER, 'rfq-9999')).toBe(true);
    expect(await book.has(SENDER, 'rfq-10000')).toBe(false);
    await expect(book.record(SENDER, 'rfq-10000', QUOTE_SHA256)).rejects.toBeInstanceOf(RangeError);
    await expect(book.record(OTHER_SENDER, 'rfq-3', QUOTE_SHA256)).rejects.toBeInstanceOf(RangeError);
    // An entry that the book holds is taken again, and it is the only record that a full book takes.
    await expect(book.record(SENDER, 'rfq-3', QUOTE_SHA256)).resolves.toBeUndefined();
    expect(await book.has(SENDER, 'rfq-0')).toBe(true);
  });

  it('reads a file with two identifiers that differ in case as two requests: the book never folds the case', async () => {
    const file = join(folder(), 'rfq-book.json');
    writeFileSync(file, fileOf([{ ...entry(1), rfq_id: 'RFQ-1' }, { ...entry(1), rfq_id: 'rfq-1', quote_sha256: OTHER_QUOTE_SHA256 }]));
    const book = new FileRfqBook(file);
    expect(await book.has(SENDER, 'RFQ-1')).toBe(true);
    expect(await book.has(SENDER, 'rfq-1')).toBe(true);
    expect(await book.has(SENDER, 'Rfq-1')).toBe(false);
  });

  describe('a damaged file', () => {
    const damaged: Array<[string, string]> = [
      ['an empty file', ''],
      ['text that is not JSON', 'quotes'],
      ['JSON that is cut', '{"schema":"bid-desk.rfq-book.v1","quotes":['],
      ['JSON null', 'null'],
      ['a list', '[]'],
      ['another schema', fileOf([], { schema: 'bid-desk.rfq-book.v2' })],
      ['no schema', JSON.stringify({ quotes: [] })],
      ['no entries', JSON.stringify({ schema: SCHEMA })],
      ['entries that are not a list', fileOf({})],
      ['a member that is not listed', fileOf([], { note: 'x' })],
      ['an entry that is not an object', fileOf(['rfq-1'])],
      ['an entry with a member missing', fileOf([{ sender_did: SENDER, rfq_id: 'rfq-1' }])],
      ['an entry without the hash of the quote', fileOf([{ sender_did: SENDER, rfq_id: 'rfq-1', quote: QUOTE_SHA256 }])],
      ['an entry with a member that is not listed', fileOf([{ ...entry(1), extra: 1 }])],
      ['an entry with a hash that is not a text', fileOf([{ ...entry(1), quote_sha256: 5 }])],
      ['an entry with a hash that is not a hash', fileOf([{ ...entry(1), quote_sha256: 'AB'.repeat(32) }])],
      ['an entry with a sender that is not a DID', fileOf([{ ...entry(1), sender_did: 'did:vector:abc' }])],
      ['an entry with an empty identifier', fileOf([{ ...entry(1), rfq_id: '' }])],
      ['an entry with an identifier over 64 characters', fileOf([{ ...entry(1), rfq_id: 'x'.repeat(65) }])],
      ['an entry with an identifier that is not an identifier', fileOf([{ ...entry(1), rfq_id: 'rfq 1' }])],
      ['two entries for one request', fileOf([entry(1), { ...entry(1), quote_sha256: OTHER_QUOTE_SHA256 }])],
      ['two entries that are the same', fileOf([entry(1), entry(1)])],
      ['more entries than the book holds', fileOf(Array.from({ length: RFQ_BOOK_LIMIT + 1 }, (_, n) => entry(n)))],
    ];

    it.each(damaged)('is an error in has and in record, and the file is not written over: %s', async (_name, text) => {
      const file = join(folder(), 'rfq-book.json');
      writeFileSync(file, text);
      const book = new FileRfqBook(file);
      await expect(book.has(SENDER, 'rfq-1')).rejects.toThrow('damaged');
      await expect(book.record(SENDER, 'rfq-99', QUOTE_SHA256)).rejects.toThrow('damaged');
      expect(readFileSync(file, 'utf8')).toBe(text);
      // The twin: a good file with an entry for the same request is read.
      const good = join(folder(), 'rfq-book.json');
      writeFileSync(good, fileOf([entry(1)]));
      expect(await new FileRfqBook(good).has(SENDER, 'rfq-1')).toBe(true);
    });

    it('does not say what the file holds in its message', async () => {
      const file = join(folder(), 'rfq-book.json');
      writeFileSync(file, fileOf([{ sender_did: SENDER, rfq_id: 'secret-marker-1234', quote_sha256: 5 }]));
      const failure = await new FileRfqBook(file).has(SENDER, 'rfq-1').then(() => null, (error: unknown) => error);
      if (!(failure instanceof Error)) throw new Error('the call did not reject with an error');
      expect(failure.message).not.toContain('secret-marker');
    });

    it('is an error when the path is a folder', async () => {
      const base = folder();
      mkdirSync(join(base, 'rfq-book.json'));
      const book = new FileRfqBook(join(base, 'rfq-book.json'));
      await expect(book.has(SENDER, 'rfq-1')).rejects.toThrow(Error);
    });
  });

  describe('a write', () => {
    it('is whole or it is not there: a rename that fails leaves the old file, removes the temporary file, and the next write works', async () => {
      const file = join(folder(), 'rfq-book.json');
      await new FileRfqBook(file).record(SENDER, 'rfq-1', QUOTE_SHA256);
      const before = readFileSync(file, 'utf8');
      const broken = new FileRfqBook(file, { fs: { rename: () => Promise.reject(new Error('the disk is full')) } });
      await expect(broken.record(SENDER, 'rfq-2', QUOTE_SHA256)).rejects.toThrow('the disk is full');
      expect(readFileSync(file, 'utf8')).toBe(before);
      // The write has ended, and a write that failed removes its own temporary file: the listing is not filtered here.
      expect(readdirSync(dirname(file))).toEqual(['rfq-book.json']);
      expect(await broken.has(SENDER, 'rfq-2')).toBe(false);
      // The same file works again when the disk works.
      const working = new FileRfqBook(file);
      await working.record(SENDER, 'rfq-2', QUOTE_SHA256);
      expect(await new FileRfqBook(file).has(SENDER, 'rfq-2')).toBe(true);
    });

    it('leaves the old file when the temporary file cannot be written or synced, and the record is refused', async () => {
      const file = join(folder(), 'rfq-book.json');
      await new FileRfqBook(file).record(SENDER, 'rfq-1', QUOTE_SHA256);
      const before = readFileSync(file, 'utf8');
      for (const fs of [{ writeFile: () => Promise.reject(new Error('no space')) }, { fsync: () => Promise.reject(new Error('io error')) }] as Array<Partial<BookFs>>) {
        const book = new FileRfqBook(file, { fs });
        await expect(book.record(SENDER, 'rfq-2', QUOTE_SHA256)).rejects.toThrow(Error);
        expect(readFileSync(file, 'utf8')).toBe(before);
      }
      expect(readdirSync(dirname(file))).toEqual(['rfq-book.json']);
    });

    it('is a rejection when the sync of the folder fails: the record is not reported as stored', async () => {
      const file = join(folder(), 'rfq-book.json');
      const dir = dirname(file);
      const book = new FileRfqBook(file, { fs: { fsync: (path) => (path === dir ? Promise.reject(new Error('io error')) : Promise.resolve()) } });
      await expect(book.record(SENDER, 'rfq-1', QUOTE_SHA256)).rejects.toThrow('io error');
    });

    it('syncs the temporary file, renames it over the file, and then syncs the folder, in this order', async () => {
      const file = join(folder(), 'rfq-book.json');
      const dir = dirname(file);
      const events: string[] = [];
      const book = new FileRfqBook(file, {
        fs: {
          fsync: async (path) => { events.push(path === dir ? 'fsync folder' : path.endsWith('.tmp') ? 'fsync temporary' : `fsync ${path}`); },
          rename: async (from, to) => { events.push(to === file && from.endsWith('.tmp') ? 'rename' : `rename ${from} ${to}`); await rename(from, to); },
        },
      });
      await book.record(SENDER, 'rfq-1', QUOTE_SHA256);
      expect(events).toEqual(['fsync temporary', 'rename', 'fsync folder']);
      expect(filesIn(dir)).toEqual(['rfq-book.json']);
    });

    it('does not write when the record is a request that the book holds, or an argument that is wrong', async () => {
      const file = join(folder(), 'rfq-book.json');
      const events: string[] = [];
      const book = new FileRfqBook(file, { fs: { writeFile: async () => { events.push('write'); throw new Error('stop'); } } });
      await expect(book.record(SENDER, 5 as unknown as string, QUOTE_SHA256)).rejects.toBeInstanceOf(TypeError);
      expect(events).toEqual([]);
      writeFileSync(file, fileOf([entry(1)]));
      await expect(book.record(SENDER, 'rfq-1', QUOTE_SHA256)).resolves.toBeUndefined();
      await expect(book.record(SENDER, 'rfq-1', OTHER_QUOTE_SHA256)).rejects.toThrow('another quote');
      expect(events).toEqual([]);
    });

    it('lands every record of calls that run at one time: no record is lost, and the file lists them in the order of the calls', async () => {
      const file = join(folder(), 'rfq-book.json');
      const book = new FileRfqBook(file);
      const count = 25;
      await Promise.all(Array.from({ length: count }, (_, n) => book.record(SENDER, `rfq-${n}`, QUOTE_SHA256)));
      expect(quotesOf(file)).toEqual(Array.from({ length: count }, (_, n) => entry(n)));
      expect(filesIn(dirname(file))).toEqual(['rfq-book.json']);
    });

    it('lets a record for the same request that runs at one time win once: the second call is refused when its quote hash differs', async () => {
      const file = join(folder(), 'rfq-book.json');
      const book = new FileRfqBook(file);
      const results = await Promise.allSettled([
        book.record(SENDER, 'rfq-1', QUOTE_SHA256), book.record(SENDER, 'rfq-1', OTHER_QUOTE_SHA256), book.record(SENDER, 'rfq-1', QUOTE_SHA256),
      ]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
      expect(quotesOf(file)).toEqual([{ sender_did: SENDER, rfq_id: 'rfq-1', quote_sha256: QUOTE_SHA256 }]);
    });

    it('continues with the next record when a record before it failed', async () => {
      const file = join(folder(), 'rfq-book.json');
      let fail = true;
      const book = new FileRfqBook(file, { fs: { rename: async (from, to) => { if (fail) { fail = false; throw new Error('the disk is full'); } await rename(from, to); } } });
      const results = await Promise.allSettled([book.record(SENDER, 'rfq-1', QUOTE_SHA256), book.record(SENDER, 'rfq-2', QUOTE_SHA256)]);
      expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
      expect(await book.has(SENDER, 'rfq-1')).toBe(false);
      expect(await book.has(SENDER, 'rfq-2')).toBe(true);
    });
  });

  describe('the path', () => {
    it('is refused when it is not a text, is empty, holds a NUL character, or has a ".." segment', () => {
      const base = folder();
      for (const bad of [undefined, null, 5, '', `${base}/a\0b/rfq-book.json`, `${base}/../rfq-book.json`, '../rfq-book.json', `${base}\\..\\rfq-book.json`] as unknown[]) {
        expect(() => new FileRfqBook(bad as string), String(bad)).toThrow(Error);
      }
      expect(() => new FileRfqBook(join(base, 'rfq-book.json'))).not.toThrow();
    });

    it('is refused when a folder of it cannot be made: a file stands in the way', () => {
      const base = folder();
      const blocker = join(base, 'blocker');
      writeFileSync(blocker, 'a file');
      expect(() => new FileRfqBook(join(blocker, 'state', 'rfq-book.json'))).toThrow(Error);
    });
  });
});
