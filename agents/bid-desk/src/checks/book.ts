// agents/bid-desk/src/checks/book.ts
// The book of the Bid Desk: one entry for each request for quotation that the agent answered, by the sender and the identifier of the request. The third statement of the claim of the Bid Desk says that the agent
// gives one quote for each request and sender, so the agent keeps the record, and the check `not_duplicate` of its hook reads it. The job records a request after it built the quote.
//
// The key is the DID of the sender and the identifier of the request, each as it was written. The identifier is no number that a system counts without regard to case, so `RFQ-7` and `rfq-7` are two requests.
// The sender is a part of the key: the same identifier from another sender is a new request. The key is the JSON text of the pair, so no pair of texts reads as another pair. Each entry holds the SHA-256 of the
// quote that the agent gave, so a second record of the same key says whether it is the same quote.
//
//   MemoryRfqBook   the entries in memory
//   FileRfqBook     the entries in one JSON file on the state volume of the service
//
// A book that cannot answer rejects. The check of the Bid Desk turns the rejection into `check_unavailable`, and a book never answers "no quote" for a source that it could not read. The first start has no file, so
// the constructor of the file book writes the empty book then. A file that goes missing after the start is an error and never an empty book: a book that was deleted gives no go for a request that was answered.
// A file that is there and is damaged is an error too.
//
// A book holds at most RFQ_BOOK_LIMIT entries. It never drops an entry to make room, because a dropped entry reads as a new request. The record of a key that the book holds is a no-op for the same quote hash, and
// an error for another quote hash: the agent never gives two quotes for one request of one sender. A book that is full cannot take a new entry, so `has` rejects with a RangeError for a key that the book lacks,
// and it never answers false: a false gives a go, the service claims the escrow, and the record of that entry fails. A key that the book holds still answers true.
import { randomBytes } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseRfqId } from '@vsa/usecase-kit/bids';
import { isPlainObject, parseDid, parseDigest } from '@vsa/usecase-kit/protocol';
import type { Did, Digest } from '@vsa/usecase-kit/protocol';

/** The requests for quotation that the Bid Desk answered, by sender and identifier. */
export interface RfqBook {
  /**
   * Did this sender send this request, and did the agent answer it? The identifier counts as it is written. A book that cannot answer rejects. A book that is full and has no entry for the key rejects too
   * (a RangeError): the job could not record a new entry, so the book must not read the request as new. A key that the book holds is true also when the book is full.
   */
  has(sender: Did, rfqId: string): Promise<boolean>;
  /** Records the quote that the agent gave for the request. It resolves when the record is stored. */
  record(sender: Did, rfqId: string, quoteSha256: Digest): Promise<void>;
}

/** The most entries that a book holds. */
export const RFQ_BOOK_LIMIT = 10_000;

/** The version of the file. */
const FILE_SCHEMA = 'bid-desk.rfq-book.v1';

interface BookEntry {
  readonly sender_did: Did;
  readonly rfq_id: string;
  readonly quote_sha256: Digest;
}

/** The entries by key, in the order of the records. */
type Entries = Map<string, BookEntry>;

/** A sender: the DID form. Anything else is a TypeError, and the message never repeats the value. */
function senderOf(value: unknown): Did {
  const parsed = parseDid(value, 'sender');
  if (!parsed.ok) throw new TypeError(parsed.detail);
  return parsed.value;
}

/** The identifier of a request: 1 to 64 letters, digits, dots, hyphens and underscores. Anything else is a TypeError, and the message never repeats the value. */
function rfqIdOf(value: unknown): string {
  const parsed = parseRfqId(value, 'rfqId');
  if (!parsed.ok) throw new TypeError(parsed.detail);
  return parsed.value;
}

/** The hash of a quote: 64 lower-case hex characters. Anything else is a TypeError, and the message never repeats the value. */
function quoteHashOf(value: unknown): Digest {
  const parsed = parseDigest(value, 'quoteSha256');
  if (!parsed.ok) throw new TypeError(parsed.detail);
  return parsed.value;
}

const keyOf = (sender: Did, rfqId: string): string => JSON.stringify([sender, rfqId]);

/** The error of a book that is full. It names the book and the limit, and never a sender or an identifier. */
const full = (): RangeError => new RangeError(`the rfq book holds ${RFQ_BOOK_LIMIT} entries and is full`);

/**
 * Does the book hold the key? A book that is full and lacks the key rejects, and never answers false: the job could not record an entry for that request, so the book must not read it as new. A key that the book
 * holds is true also when the book is full.
 */
function holds(entries: Entries, key: string): boolean {
  if (entries.has(key)) return true;
  if (entries.size >= RFQ_BOOK_LIMIT) throw full();
  return false;
}

/**
 * Decides what the record of an entry does. It is true when the entry is new and the caller stores it. It is false when the book holds the same quote for the key already. It throws for another quote hash of a key
 * that the book holds, and for a book that is full.
 */
function isNew(entries: Entries, entry: BookEntry): boolean {
  const held = entries.get(keyOf(entry.sender_did, entry.rfq_id));
  if (held !== undefined) {
    if (held.quote_sha256 === entry.quote_sha256) return false;
    throw new Error('the rfq book holds another quote for this request');
  }
  if (entries.size >= RFQ_BOOK_LIMIT) throw full();
  return true;
}

/** The entries of an rfq book in memory. */
export class MemoryRfqBook implements RfqBook {
  readonly #entries: Entries = new Map();

  async has(sender: Did, rfqId: string): Promise<boolean> {
    return holds(this.#entries, keyOf(senderOf(sender), rfqIdOf(rfqId)));
  }

  async record(sender: Did, rfqId: string, quoteSha256: Digest): Promise<void> {
    const entry: BookEntry = { sender_did: senderOf(sender), rfq_id: rfqIdOf(rfqId), quote_sha256: quoteHashOf(quoteSha256) };
    if (isNew(this.#entries, entry)) this.#entries.set(keyOf(entry.sender_did, entry.rfq_id), entry);
  }
}

// --- The file ---------------------------------------------------------------------------------------------------------------------------------------------------------

/** The file system calls of the file book. The default is the file system of the process. A test gives its own, to make a write fail or to see the order of the calls. */
export interface BookFs {
  /** The text of the file. It rejects when the file is not there or cannot be read. The book reads a file that is not there as an error. */
  readFile(path: string): Promise<string>;
  /** Makes a new file with the text. The name of a temporary file is new, so the call never replaces a file. */
  writeFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Returns when the data of the file, or the entries of the folder, are on the disk. */
  fsync(path: string): Promise<void>;
  /** Removes a temporary file after a write that failed. A failure of this call changes nothing. */
  unlink(path: string): Promise<void>;
}

export interface FileRfqBookOptions {
  /** The file system calls. A call that the object leaves out is the call of the file system of the process. */
  readonly fs?: Partial<BookFs>;
}

const NODE_FS: BookFs = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
  rename,
  fsync: async (path) => {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  unlink,
};

/** The path as an absolute path. A path that is not a text, that is empty, that holds a NUL character or that has a `..` segment is refused: the file is the file that the caller named. */
function absolutePath(path: unknown): string {
  if (typeof path !== 'string') throw new TypeError('the path of the rfq book must be a text');
  if (path === '' || path.includes('\0')) throw new RangeError('the path of the rfq book must be a path');
  if (path.split(/[\\/]+/).includes('..')) throw new RangeError('the path of the rfq book must not have a ".." segment');
  return resolve(path);
}

/** The folder is made when it is missing, and it must be a folder that the process can read and write: a service that cannot record a request stops at its start. */
function prepareFolder(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!statSync(folder).isDirectory()) throw new Error('the folder of the rfq book is not a folder');
  accessSync(folder, constants.R_OK | constants.W_OK | constants.X_OK);
}

/** True for the error of a file that is not there. */
const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const damaged = (): Error => new Error('the rfq book file is damaged');

/** One entry of the file: exactly the three members, each in its form. Anything else is a damaged file. */
function entryOfFile(value: unknown): BookEntry {
  if (!isPlainObject(value) || Object.keys(value).length !== 3) throw damaged();
  const sender = parseDid(value.sender_did, 'sender_did');
  const id = parseRfqId(value.rfq_id, 'rfq_id');
  const hash = parseDigest(value.quote_sha256, 'quote_sha256');
  if (!sender.ok || !id.ok || !hash.ok) throw damaged();
  return { sender_did: sender.value, rfq_id: id.value, quote_sha256: hash.value };
}

/** The entries of a file. A text that is not JSON, and JSON that is not the file of the book, are errors: the content of the file is never part of the message. */
function parseEntries(text: string): Entries {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw damaged();
  }
  if (!isPlainObject(value) || Object.keys(value).length !== 2 || value.schema !== FILE_SCHEMA) throw damaged();
  const list = value.quotes;
  if (!Array.isArray(list) || list.length > RFQ_BOOK_LIMIT) throw damaged();
  const entries: Entries = new Map();
  for (const item of list) {
    const entry = entryOfFile(item);
    const key = keyOf(entry.sender_did, entry.rfq_id);
    if (entries.has(key)) throw damaged();
    entries.set(key, entry);
  }
  return entries;
}

/** The text of the file: one line of JSON. */
const fileText = (entries: Entries): string => `${JSON.stringify({ schema: FILE_SCHEMA, quotes: [...entries.values()] })}\n`;

/** A temporary file, a sync of it, a rename over `target`, and a sync of the folder. A failure before the rename removes the temporary file, and leaves `target` as it was. */
async function writeDurably(fs: BookFs, folder: string, target: string, text: string): Promise<void> {
  const temporary = join(folder, `.${basename(target)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temporary, text);
    await fs.fsync(temporary);
    await fs.rename(temporary, target);
  } catch (error) {
    try {
      await fs.unlink(temporary);
    } catch {
      // The temporary file stays. Nothing reads it, and the error of the write is the error that counts.
    }
    throw error;
  }
  await fs.fsync(folder);
}

/** Returns when the data of the file, or the entries of the folder, are on the disk. It uses the file system of the process. */
function flushSync(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Makes the file of a book that has none: the empty book. A file that is there stays as it is, whatever it holds. The write is whole or it is not there, as every write of the book is. The constructor cannot wait,
 * so this uses the file system of the process, and not the calls that a test gives.
 */
function startFile(folder: string, file: string): void {
  if (existsSync(file)) return;
  const temporary = join(folder, `.${basename(file)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(temporary, fileText(new Map()), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    flushSync(temporary);
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file stays. Nothing reads it, and the error of the write is the error that counts.
    }
    throw error;
  }
  flushSync(folder);
}

/**
 * The rfq book in one JSON file: `{ "schema", "quotes": [{ "sender_did", "rfq_id", "quote_sha256" }] }`, in the order of the records, with each identifier as it was written. The constructor writes the empty book when
 * the file is not there: that is the first start, and a start never writes over a file that is there. The class reads the file at each call, so a file that is damaged after the start is seen, and a file that is
 * missing after the start is an error and never an empty book. A new instance on the same file sees every entry: a restart loses nothing. A write is whole or it is not there: it writes a temporary file in the same
 * folder, syncs it, renames it over the file, and syncs the folder. A record resolves only after that. When the sync of the folder fails, the record rejects although the new file may be in place, and the caller
 * reads the rejection as "not stored". The records of one instance run one after the other in the order of the calls. One process owns the file: nothing locks it across processes.
 */
export class FileRfqBook implements RfqBook {
  readonly #file: string;
  readonly #folder: string;
  readonly #fs: BookFs;
  /** The last record that is queued or running. A record waits for the one in front of it, whatever its outcome. */
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string, options: FileRfqBookOptions = {}) {
    this.#file = absolutePath(path);
    this.#folder = dirname(this.#file);
    prepareFolder(this.#folder);
    startFile(this.#folder, this.#file);
    const given = options.fs;
    this.#fs = {
      readFile: given?.readFile ?? NODE_FS.readFile,
      writeFile: given?.writeFile ?? NODE_FS.writeFile,
      rename: given?.rename ?? NODE_FS.rename,
      fsync: given?.fsync ?? NODE_FS.fsync,
      unlink: given?.unlink ?? NODE_FS.unlink,
    };
  }

  async has(sender: Did, rfqId: string): Promise<boolean> {
    const key = keyOf(senderOf(sender), rfqIdOf(rfqId));
    return holds(await this.#read(), key);
  }

  async record(sender: Did, rfqId: string, quoteSha256: Digest): Promise<void> {
    const entry: BookEntry = { sender_did: senderOf(sender), rfq_id: rfqIdOf(rfqId), quote_sha256: quoteHashOf(quoteSha256) };
    const run = this.#tail.then(() => this.#add(entry));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #add(entry: BookEntry): Promise<void> {
    const entries = await this.#read();
    if (!isNew(entries, entry)) return;
    entries.set(keyOf(entry.sender_did, entry.rfq_id), entry);
    await writeDurably(this.#fs, this.#folder, this.#file, fileText(entries));
  }

  /** The entries of the file. A file that is not there is an error: the constructor made it at the start. */
  async #read(): Promise<Entries> {
    let text: string;
    try {
      text = await this.#fs.readFile(this.#file);
    } catch (error) {
      if (isMissing(error)) throw new Error('the rfq book file is missing', { cause: error });
      throw error;
    }
    return parseEntries(text);
  }
}
