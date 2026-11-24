// agents/insurer-intake-agent/test/store/book.test.ts: the intake book of the Insurer Intake Agent. The book holds one entry for each request number of a tenant, and it counts a number without regard to
// case, as the insurer portal does. `MemoryIntakeBook` and `FileIntakeBook` pass one table of cases. The file book keeps its entries in one JSON file: a new instance reads them, a write is whole or it is
// not there, and a damaged file, and a file that goes missing after the start, are errors and never an empty book. The question: can a request number that was recorded read as new?
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileIntakeBook, INTAKE_BOOK_LIMIT, MemoryIntakeBook } from '../../src/store/index.ts';
import type { BookFs, IntakeBook } from '../../src/store/index.ts';

const folders: string[] = [];
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});
/** A new folder below the temporary folder. A test removes it when it ends. */
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'intake-book-'));
  folders.push(path);
  return path;
}

/** A write makes `.<name>.<hex>.tmp` and renames it, so a test that lists a folder skips these names, and a test of the cleanup of a write asks for them by name. */
const TEMPORARY = /^\..+\.[0-9a-f]{16}\.tmp$/;
const filesOf = (path: string): string[] => readdirSync(path).filter((name) => !TEMPORARY.test(name));
const temporariesOf = (path: string): string[] => readdirSync(path).filter((name) => TEMPORARY.test(name));

const SCHEMA = 'insurer-intake-agent.requests.v1';
const TENANT = 'demo-1';
const numberOf = (n: number): string => `${TENANT}-${n}`;
const idOf = (n: number): string => `INT-${TENANT}-${String(n).padStart(4, '0')}`;
const entry = (n: number): { tenant: string; request_number: string; intake_id: string } => ({ tenant: TENANT, request_number: numberOf(n), intake_id: idOf(n) });
const fileOf = (requests: unknown, over: Record<string, unknown> = {}): string => JSON.stringify({ schema: SCHEMA, requests, ...over });
/** The list of entries in the file of a book. */
function requestsIn(file: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('requests' in parsed)) throw new Error('the file is not a book');
  return parsed.requests;
}

/** The error that a call rejects with. A call that resolves, or that rejects with something that is no error, fails the test. */
async function rejection(call: Promise<unknown>): Promise<Error> {
  const outcome = await call.then(() => null, (error: unknown) => error);
  if (!(outcome instanceof Error)) throw new Error('the call must reject with an error');
  return outcome;
}

const BOOKS: Array<[string, () => IntakeBook]> = [
  ['MemoryIntakeBook', () => new MemoryIntakeBook()],
  ['FileIntakeBook', () => new FileIntakeBook(join(folder(), 'requests.json'))],
];

describe.each(BOOKS)('%s', (_name, make) => {
  it('has no entry for a number that it was not given, and has the entry after record', async () => {
    const book = make();
    expect(await book.has(TENANT, numberOf(1))).toBe(false);
    await book.record(TENANT, numberOf(1), idOf(1));
    expect(await book.has(TENANT, numberOf(1))).toBe(true);
    expect(await book.has(TENANT, numberOf(2))).toBe(false);
  });

  it('counts a request number without regard to case, in both directions: Demo-1-7 and demo-1-7 are one request', async () => {
    const book = make();
    await book.record(TENANT, 'Demo-1-7', idOf(7));
    await book.record(TENANT, 'demo-1-8', idOf(8));
    expect(await book.has(TENANT, 'demo-1-7')).toBe(true);
    expect(await book.has(TENANT, 'DEMO-1-7')).toBe(true);
    expect(await book.has(TENANT, 'dEMO-1-7')).toBe(true);
    expect(await book.has(TENANT, 'Demo-1-8')).toBe(true);
    // The twin: a number that differs in more than its case is a new number.
    expect(await book.has(TENANT, 'Demo-1-9')).toBe(false);
    expect(await book.has(TENANT, 'demo-1-70')).toBe(false);
  });

  it('keeps the tenants apart', async () => {
    const book = make();
    await book.record('demo-1', 'REQ-7', 'INT-1');
    expect(await book.has('demo-2', 'REQ-7')).toBe(false);
    await book.record('demo-2', 'REQ-7', 'INT-2');
    expect(await book.has('demo-2', 'req-7')).toBe(true);
  });

  it('keeps tenant and number apart even when a text of one looks like a join of both', async () => {
    const book = make();
    await book.record('a-b', 'c', 'INT-1');
    expect(await book.has('a', 'b-c')).toBe(false);
    expect(await book.has('a-b', 'c')).toBe(true);
  });

  it('takes the same intake id again, and refuses another intake id for a number that it holds, whatever the case of the number', async () => {
    const book = make();
    await book.record(TENANT, 'Demo-1-7', idOf(7));
    await expect(book.record(TENANT, 'Demo-1-7', idOf(7))).resolves.toBeUndefined();
    await expect(book.record(TENANT, 'DEMO-1-7', idOf(7))).resolves.toBeUndefined();
    await expect(book.record(TENANT, 'demo-1-7', idOf(8))).rejects.toThrow('another intake id');
    expect(await book.has(TENANT, 'Demo-1-7')).toBe(true);
    // The twin: another number takes that other intake id.
    await expect(book.record(TENANT, 'demo-1-8', idOf(8))).resolves.toBeUndefined();
  });

  it('refuses an argument that is not a text of 1 to 64 characters, in has and in record, and records nothing for it', async () => {
    const book = make();
    const long = 'x'.repeat(65);
    for (const bad of [undefined, null, 5, '', long, {}] as unknown[]) {
      await expect(book.has(bad as string, 'demo-1-1'), String(bad)).rejects.toBeInstanceOf(TypeError);
      await expect(book.has(TENANT, bad as string), String(bad)).rejects.toBeInstanceOf(TypeError);
      await expect(book.record(bad as string, 'demo-1-1', 'INT-1'), String(bad)).rejects.toBeInstanceOf(TypeError);
      await expect(book.record(TENANT, bad as string, 'INT-1'), String(bad)).rejects.toBeInstanceOf(TypeError);
      await expect(book.record(TENANT, 'demo-1-1', bad as string), String(bad)).rejects.toBeInstanceOf(TypeError);
    }
    // The message never repeats the text that it refuses.
    expect((await rejection(book.has(TENANT, long))).message).not.toContain(long);
    expect(await book.has(TENANT, 'demo-1-1')).toBe(false);
    // The twin: 64 characters pass.
    await book.record(TENANT, 'p'.repeat(64), 's'.repeat(64));
    expect(await book.has(TENANT, 'P'.repeat(64))).toBe(true);
  });
});

describe('MemoryIntakeBook', () => {
  it(`holds ${INTAKE_BOOK_LIMIT} entries and refuses the next one, and it answers for the entries that it holds`, async () => {
    const book = new MemoryIntakeBook();
    for (let n = 0; n < INTAKE_BOOK_LIMIT; n += 1) await book.record(TENANT, numberOf(n), idOf(n));
    await expect(book.record(TENANT, 'demo-1-new', 'INT-new')).rejects.toBeInstanceOf(RangeError);
    expect(await book.has(TENANT, 'demo-1-new')).toBe(false);
    expect(await book.has(TENANT, 'DEMO-1-0')).toBe(true);
    expect(await book.has(TENANT, numberOf(INTAKE_BOOK_LIMIT - 1))).toBe(true);
    // An entry that the book holds is taken again when it is full.
    await expect(book.record(TENANT, numberOf(5), idOf(5))).resolves.toBeUndefined();
  });
});

describe('FileIntakeBook', () => {
  it('is read by a new instance on the same file: a restart loses no entry', async () => {
    const file = join(folder(), 'requests.json');
    const first = new FileIntakeBook(file);
    await first.record(TENANT, 'Demo-1-7', idOf(7));
    const second = new FileIntakeBook(file);
    expect(await second.has(TENANT, 'demo-1-7')).toBe(true);
    expect(await second.has(TENANT, 'demo-1-8')).toBe(false);
    await second.record(TENANT, 'demo-1-8', idOf(8));
    expect(await first.has(TENANT, 'DEMO-1-8')).toBe(true);
  });

  it('writes one JSON file with the schema and one entry for each request, in the order of the records, with the number as it was written', async () => {
    const file = join(folder(), 'requests.json');
    const book = new FileIntakeBook(file);
    await book.record('demo-1', 'Demo-1-7', 'INT-1');
    await book.record('demo-2', 'demo-2-8', 'INT-2');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      schema: SCHEMA,
      requests: [{ tenant: 'demo-1', request_number: 'Demo-1-7', intake_id: 'INT-1' }, { tenant: 'demo-2', request_number: 'demo-2-8', intake_id: 'INT-2' }],
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps the first intake id of a number when a second one comes, in the file too', async () => {
    const file = join(folder(), 'requests.json');
    const book = new FileIntakeBook(file);
    await book.record(TENANT, 'Demo-1-7', 'INT-1');
    await expect(book.record(TENANT, 'demo-1-7', 'INT-2')).rejects.toThrow('another intake id');
    expect(requestsIn(file)).toEqual([{ tenant: TENANT, request_number: 'Demo-1-7', intake_id: 'INT-1' }]);
  });

  it('writes the empty book at the start when the file is not there, and it makes the folders of the path', async () => {
    const file = join(folder(), 'state', 'deep', 'requests.json');
    const book = new FileIntakeBook(file);
    expect(statSync(dirname(file)).isDirectory()).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schema: SCHEMA, requests: [] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(filesOf(dirname(file))).toEqual(['requests.json']);
    expect(temporariesOf(dirname(file))).toEqual([]);
    expect(await book.has(TENANT, numberOf(1))).toBe(false);
    await book.record(TENANT, numberOf(1), idOf(1));
    expect(filesOf(dirname(file))).toEqual(['requests.json']);
    expect(temporariesOf(dirname(file))).toEqual([]);
  });

  it('does not write over a file that is there when it starts: the entries of an earlier run stay, and so does a file that is damaged', () => {
    const file = join(folder(), 'requests.json');
    const text = fileOf([entry(1), entry(2)]);
    writeFileSync(file, text);
    expect(() => new FileIntakeBook(file)).not.toThrow();
    expect(readFileSync(file, 'utf8')).toBe(text);
    const broken = join(folder(), 'requests.json');
    writeFileSync(broken, 'not json');
    expect(() => new FileIntakeBook(broken)).not.toThrow();
    expect(readFileSync(broken, 'utf8')).toBe('not json');
  });

  it('is an error and never an empty book when the file is missing after the start, and a restart with no file is a first start', async () => {
    const file = join(folder(), 'requests.json');
    const book = new FileIntakeBook(file);
    await book.record(TENANT, 'Demo-1-7', idOf(7));
    // The twin: the book with its file knows the number.
    expect(await book.has(TENANT, 'demo-1-7')).toBe(true);
    rmSync(file);
    await expect(book.has(TENANT, 'demo-1-7')).rejects.toThrow('missing');
    await expect(book.has(TENANT, 'demo-1-8')).rejects.toThrow('missing');
    await expect(book.record(TENANT, 'demo-1-8', idOf(8))).rejects.toThrow('missing');
    // A record does not make the file again. Only a start makes it.
    expect(existsSync(file)).toBe(false);
    const restarted = new FileIntakeBook(file);
    expect(existsSync(file)).toBe(true);
    expect(await restarted.has(TENANT, 'demo-1-7')).toBe(false);
  });

  it('is an error when the folder of the file is removed after the start', async () => {
    const file = join(folder(), 'state', 'requests.json');
    const book = new FileIntakeBook(file);
    await book.record(TENANT, numberOf(1), idOf(1));
    expect(await book.has(TENANT, numberOf(1))).toBe(true);
    rmSync(dirname(file), { recursive: true });
    await expect(book.has(TENANT, numberOf(1))).rejects.toThrow('missing');
    await expect(book.record(TENANT, numberOf(2), idOf(2))).rejects.toThrow(Error);
  });

  it('reads the file at each call, so a file that is damaged after the start is seen', async () => {
    const file = join(folder(), 'requests.json');
    const book = new FileIntakeBook(file);
    await book.record(TENANT, numberOf(1), idOf(1));
    expect(await book.has(TENANT, numberOf(1))).toBe(true);
    writeFileSync(file, 'not json');
    await expect(book.has(TENANT, numberOf(1))).rejects.toThrow('damaged');
  });

  it('skips a temporary file in the folder: a write that a crash cut short is not the book, and the book does not remove it', async () => {
    const base = folder();
    const file = join(base, 'requests.json');
    const stray = join(base, '.requests.json.0123456789abcdef.tmp');
    const strayText = fileOf([entry(1)]);
    writeFileSync(stray, strayText);
    // A start with a temporary file and no book makes the empty book: it does not read the temporary file.
    const book = new FileIntakeBook(file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schema: SCHEMA, requests: [] });
    expect(await book.has(TENANT, numberOf(1))).toBe(false);
    await book.record(TENANT, numberOf(2), idOf(2));
    expect(requestsIn(file)).toEqual([entry(2)]);
    expect(filesOf(base)).toEqual(['requests.json']);
    expect(readFileSync(stray, 'utf8')).toBe(strayText);
    // The twin: the same entry in the file of the book is read.
    writeFileSync(file, fileOf([entry(1)]));
    expect(await book.has(TENANT, numberOf(1))).toBe(true);
    // A temporary file with damaged text changes nothing for a book whose file is good.
    writeFileSync(stray, 'not json');
    expect(await book.has(TENANT, numberOf(1))).toBe(true);
    await book.record(TENANT, numberOf(3), idOf(3));
    expect(requestsIn(file)).toEqual([entry(1), entry(3)]);
  });

  it('holds 10,000 entries: a file with that many answers, and a record for a new number is refused', async () => {
    const file = join(folder(), 'requests.json');
    writeFileSync(file, fileOf(Array.from({ length: INTAKE_BOOK_LIMIT }, (_, n) => entry(n))));
    const book = new FileIntakeBook(file);
    expect(await book.has(TENANT, 'DEMO-1-9999')).toBe(true);
    expect(await book.has(TENANT, 'demo-1-10000')).toBe(false);
    await expect(book.record(TENANT, 'demo-1-10000', idOf(10000))).rejects.toBeInstanceOf(RangeError);
    await expect(book.record(TENANT, numberOf(3), idOf(3))).resolves.toBeUndefined();
  });

  it('takes the 10,000th entry and refuses the 10,001st, and it drops no entry to make room', async () => {
    const file = join(folder(), 'requests.json');
    writeFileSync(file, fileOf(Array.from({ length: INTAKE_BOOK_LIMIT - 1 }, (_, n) => entry(n))));
    const book = new FileIntakeBook(file);
    await book.record(TENANT, 'demo-1-last', 'INT-last');
    expect(requestsIn(file)).toHaveLength(INTAKE_BOOK_LIMIT);
    const full = readFileSync(file, 'utf8');
    await expect(book.record(TENANT, 'demo-1-over', 'INT-over')).rejects.toBeInstanceOf(RangeError);
    expect(readFileSync(file, 'utf8')).toBe(full);
    expect(await book.has(TENANT, numberOf(0))).toBe(true);
    expect(await book.has(TENANT, 'DEMO-1-LAST')).toBe(true);
    expect(await book.has(TENANT, 'demo-1-over')).toBe(false);
  });

  describe('a damaged file', () => {
    const damaged: Array<[string, string]> = [
      ['an empty file', ''],
      ['text that is not JSON', 'requests'],
      ['JSON that is cut', `{"schema":"${SCHEMA}","requests":[`],
      ['JSON null', 'null'],
      ['a list', '[]'],
      ['another schema', fileOf([], { schema: 'insurer-intake-agent.requests.v2' })],
      ['no schema', JSON.stringify({ requests: [] })],
      ['no requests', JSON.stringify({ schema: SCHEMA })],
      ['requests that are not a list', fileOf({})],
      ['a member that is not listed', fileOf([], { note: 'x' })],
      ['an entry that is not an object', fileOf(['demo-1-1'])],
      ['an entry with a member missing', fileOf([{ tenant: TENANT, request_number: numberOf(1) }])],
      ['an entry with a member that is not listed', fileOf([{ ...entry(1), extra: 1 }])],
      ['an entry with a member that is not a text', fileOf([{ ...entry(1), intake_id: 5 }])],
      ['an entry with an empty text', fileOf([{ ...entry(1), tenant: '' }])],
      ['an entry with a text over 64 characters', fileOf([{ ...entry(1), request_number: 'x'.repeat(65) }])],
      ['two entries for one number that differ in case', fileOf([entry(1), { ...entry(1), request_number: numberOf(1).toUpperCase(), intake_id: 'INT-9' }])],
      ['two entries that are the same', fileOf([entry(1), entry(1)])],
      ['more entries than the book holds', fileOf(Array.from({ length: INTAKE_BOOK_LIMIT + 1 }, (_, n) => entry(n)))],
    ];

    it.each(damaged)('is an error in has and in record, and the file is not written over: %s', async (_name, text) => {
      const file = join(folder(), 'requests.json');
      writeFileSync(file, text);
      const book = new FileIntakeBook(file);
      await expect(book.has(TENANT, numberOf(1))).rejects.toThrow('damaged');
      await expect(book.record(TENANT, numberOf(99), idOf(99))).rejects.toThrow('damaged');
      expect(readFileSync(file, 'utf8')).toBe(text);
      // The twin: a good file with an entry for the same number is read.
      const good = join(folder(), 'requests.json');
      writeFileSync(good, fileOf([entry(1)]));
      expect(await new FileIntakeBook(good).has(TENANT, numberOf(1))).toBe(true);
    });

    it('does not say what the file holds in its message', async () => {
      const file = join(folder(), 'requests.json');
      writeFileSync(file, fileOf([{ tenant: TENANT, request_number: 'secret-marker-1234', intake_id: 5 }]));
      const failure = await rejection(new FileIntakeBook(file).has(TENANT, numberOf(1)));
      expect(failure.message).not.toContain('secret-marker');
    });

    it('is an error when the path is a folder', async () => {
      const base = folder();
      mkdirSync(join(base, 'requests.json'));
      const book = new FileIntakeBook(join(base, 'requests.json'));
      await expect(book.has(TENANT, numberOf(1))).rejects.toThrow(Error);
    });
  });

  describe('a write', () => {
    it('is whole or it is not there: a rename that fails leaves the old file, removes the temporary file, and the next write works', async () => {
      const file = join(folder(), 'requests.json');
      await new FileIntakeBook(file).record(TENANT, numberOf(1), idOf(1));
      const before = readFileSync(file, 'utf8');
      const broken = new FileIntakeBook(file, { fs: { rename: () => Promise.reject(new Error('the disk is full')) } });
      await expect(broken.record(TENANT, numberOf(2), idOf(2))).rejects.toThrow('the disk is full');
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(temporariesOf(dirname(file))).toEqual([]);
      expect(filesOf(dirname(file))).toEqual(['requests.json']);
      expect(await broken.has(TENANT, numberOf(2))).toBe(false);
      // The same file takes the record when the disk works.
      const working = new FileIntakeBook(file);
      await working.record(TENANT, numberOf(2), idOf(2));
      expect(await new FileIntakeBook(file).has(TENANT, numberOf(2))).toBe(true);
    });

    it('leaves the old file when the temporary file cannot be written or synced, and the record is refused', async () => {
      const file = join(folder(), 'requests.json');
      await new FileIntakeBook(file).record(TENANT, numberOf(1), idOf(1));
      const before = readFileSync(file, 'utf8');
      for (const fs of [{ writeFile: () => Promise.reject(new Error('no space')) }, { fsync: () => Promise.reject(new Error('io error')) }] as Array<Partial<BookFs>>) {
        const book = new FileIntakeBook(file, { fs });
        await expect(book.record(TENANT, numberOf(2), idOf(2))).rejects.toThrow(Error);
        expect(readFileSync(file, 'utf8')).toBe(before);
      }
      expect(temporariesOf(dirname(file))).toEqual([]);
      expect(filesOf(dirname(file))).toEqual(['requests.json']);
    });

    it('is a rejection when the sync of the folder fails: the record is not reported as stored', async () => {
      const file = join(folder(), 'requests.json');
      const dir = dirname(file);
      const book = new FileIntakeBook(file, { fs: { fsync: (path) => (path === dir ? Promise.reject(new Error('io error')) : Promise.resolve()) } });
      await expect(book.record(TENANT, numberOf(1), idOf(1))).rejects.toThrow('io error');
    });

    it('syncs the temporary file, renames it over the file, and then syncs the folder, in this order', async () => {
      const file = join(folder(), 'requests.json');
      const dir = dirname(file);
      const events: string[] = [];
      const book = new FileIntakeBook(file, {
        fs: {
          fsync: async (path) => { events.push(path === dir ? 'fsync folder' : path.endsWith('.tmp') ? 'fsync temporary' : `fsync ${path}`); },
          rename: async (from, to) => { events.push(to === file && from.endsWith('.tmp') ? 'rename' : `rename ${from} ${to}`); await rename(from, to); },
        },
      });
      await book.record(TENANT, numberOf(1), idOf(1));
      expect(events).toEqual(['fsync temporary', 'rename', 'fsync folder']);
    });

    it('does not write when the record is a number that the book holds, or an argument that is wrong', async () => {
      const file = join(folder(), 'requests.json');
      const events: string[] = [];
      const book = new FileIntakeBook(file, { fs: { writeFile: async () => { events.push('write'); throw new Error('stop'); } } });
      await expect(book.record(TENANT, 5 as unknown as string, idOf(1))).rejects.toBeInstanceOf(TypeError);
      expect(events).toEqual([]);
      writeFileSync(file, fileOf([entry(1)]));
      await expect(book.record(TENANT, numberOf(1).toUpperCase(), idOf(1))).resolves.toBeUndefined();
      await expect(book.record(TENANT, numberOf(1).toUpperCase(), idOf(2))).rejects.toThrow('another intake id');
      expect(events).toEqual([]);
      // The twin: a new number reaches the write.
      await expect(book.record(TENANT, numberOf(2), idOf(2))).rejects.toThrow('stop');
      expect(events).toEqual(['write']);
    });

    it('lands every record of calls that run at one time: no record is lost, and the file lists them in the order of the calls', async () => {
      const file = join(folder(), 'requests.json');
      const book = new FileIntakeBook(file);
      const count = 25;
      await Promise.all(Array.from({ length: count }, (_, n) => book.record(TENANT, numberOf(n), idOf(n))));
      expect(requestsIn(file)).toEqual(Array.from({ length: count }, (_, n) => entry(n)));
      expect(temporariesOf(dirname(file))).toEqual([]);
      expect(filesOf(dirname(file))).toEqual(['requests.json']);
    });

    it('lets a record for the same number that runs at one time win once: the second call is refused when its intake id differs', async () => {
      const file = join(folder(), 'requests.json');
      const book = new FileIntakeBook(file);
      const results = await Promise.allSettled([book.record(TENANT, 'Demo-1-1', 'INT-1'), book.record(TENANT, 'demo-1-1', 'INT-2'), book.record(TENANT, 'Demo-1-1', 'INT-1')]);
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
      expect(requestsIn(file)).toEqual([{ tenant: TENANT, request_number: 'Demo-1-1', intake_id: 'INT-1' }]);
    });

    it('continues with the next record when a record before it failed', async () => {
      const file = join(folder(), 'requests.json');
      let fail = true;
      const book = new FileIntakeBook(file, { fs: { rename: async (from, to) => { if (fail) { fail = false; throw new Error('the disk is full'); } await rename(from, to); } } });
      const results = await Promise.allSettled([book.record(TENANT, numberOf(1), idOf(1)), book.record(TENANT, numberOf(2), idOf(2))]);
      expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
      expect(await book.has(TENANT, numberOf(1))).toBe(false);
      expect(await book.has(TENANT, numberOf(2))).toBe(true);
    });
  });

  describe('the path', () => {
    it('is refused when it is not a text, is empty, holds a NUL character, or has a ".." segment', () => {
      const base = folder();
      for (const bad of [undefined, null, 5, '', `${base}/a\0b/requests.json`, `${base}/../requests.json`, '../requests.json', `${base}\\..\\requests.json`] as unknown[]) {
        expect(() => new FileIntakeBook(bad as string), String(bad)).toThrow(Error);
      }
      expect(() => new FileIntakeBook(join(base, 'requests.json'))).not.toThrow();
    });

    it('is refused when a folder of it cannot be made: a file stands in the way', () => {
      const base = folder();
      const blocker = join(base, 'blocker');
      writeFileSync(blocker, 'a file');
      expect(() => new FileIntakeBook(join(blocker, 'state', 'requests.json'))).toThrow(Error);
    });
  });
});
