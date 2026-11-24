// agents/insurer-intake-agent/src/store/book.ts
// The intake book of the Insurer Intake Agent: one entry for each request number of a tenant. The third statement of the claim of the agent says that it files one entry for each request number, so the agent
// keeps the record, and the duplicate check of its hook reads it. The job records an entry after the insurer portal took the request.
//
// The insurer portal files one entry for each number without regard to case, so the book keys each number by `requestNumberKey` of the kit (the number in lower case): `Demo-1-7` and `demo-1-7` are one request.
// The tenant is part of the key, because the portal keeps one list of entries for each tenant. The key is the JSON text of the tenant and the key of the number, so no pair of texts reads as another pair.
//
//   MemoryIntakeBook   the entries in memory
//   FileIntakeBook     the entries in one JSON file on the state volume of the service
//
// A book that cannot answer rejects. The hook of the agent turns the rejection into `check_unavailable`, and a book never answers "no entry" for a source that it could not read. The first start has no file, so
// the constructor of the file book writes the empty book then. A file that goes missing after the start is an error and never an empty book: a book that was deleted would let a number that was recorded read as new.
// A file that is there and is damaged is an error too.
//
// A book holds at most INTAKE_BOOK_LIMIT entries. It never drops an entry to make room, because a dropped entry reads as a new one. The record of a number that the book holds is a no-op for the same intake id,
// and an error for another intake id: the portal never files two entries for one number.
import { randomBytes } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { requestNumberKey } from '@vsa/usecase-kit/priorauth';
import { isPlainObject } from '@vsa/usecase-kit/protocol';

/** The requests that the Insurer Intake Agent filed, by request number. */
export interface IntakeBook {
  /** Is there an entry for the request number of this tenant? The number counts without regard to case. A book that cannot answer rejects. */
  has(tenant: string, requestNumber: string): Promise<boolean>;
  /** Records the entry that the insurer portal filed for the number. It resolves when the record is stored. */
  record(tenant: string, requestNumber: string, intakeId: string): Promise<void>;
}

/** The most entries that a book holds. */
export const INTAKE_BOOK_LIMIT = 10_000;

/** The most characters of a tenant, of a request number and of an intake id. */
const MAX_TEXT = 64;

/** The version of the file. */
const FILE_SCHEMA = 'insurer-intake-agent.requests.v1';

interface IntakeEntry {
  readonly tenant: string;
  readonly request_number: string;
  readonly intake_id: string;
}

/** The entries by key, in the order of the records. */
type Entries = Map<string, IntakeEntry>;

/** A text of 1 to MAX_TEXT characters. Anything else is a TypeError, and the message never repeats the value. */
function textOf(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_TEXT) throw new TypeError(`${name} must be a text of 1 to ${MAX_TEXT} characters`);
  return value;
}

const keyOf = (tenant: string, requestNumber: string): string => JSON.stringify([tenant, requestNumberKey(requestNumber)]);

/**
 * Decides what the record of an entry does. It is true when the entry is new and the caller stores it. It is false when the book holds the same entry already. It throws for another intake id of a number that the
 * book holds, and for a book that is full.
 */
function isNew(entries: Entries, entry: IntakeEntry): boolean {
  const held = entries.get(keyOf(entry.tenant, entry.request_number));
  if (held !== undefined) {
    if (held.intake_id === entry.intake_id) return false;
    throw new Error('the intake book holds another intake id for this request number');
  }
  if (entries.size >= INTAKE_BOOK_LIMIT) throw new RangeError(`the intake book holds ${INTAKE_BOOK_LIMIT} entries and is full`);
  return true;
}

/** The entries of an intake book in memory. */
export class MemoryIntakeBook implements IntakeBook {
  readonly #entries: Entries = new Map();

  async has(tenant: string, requestNumber: string): Promise<boolean> {
    return this.#entries.has(keyOf(textOf(tenant, 'tenant'), textOf(requestNumber, 'requestNumber')));
  }

  async record(tenant: string, requestNumber: string, intakeId: string): Promise<void> {
    const entry: IntakeEntry = { tenant: textOf(tenant, 'tenant'), request_number: textOf(requestNumber, 'requestNumber'), intake_id: textOf(intakeId, 'intakeId') };
    if (isNew(this.#entries, entry)) this.#entries.set(keyOf(entry.tenant, entry.request_number), entry);
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

export interface FileIntakeBookOptions {
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
  if (typeof path !== 'string') throw new TypeError('the path of the intake book must be a text');
  if (path === '' || path.includes('\0')) throw new RangeError('the path of the intake book must be a path');
  if (path.split(/[\\/]+/).includes('..')) throw new RangeError('the path of the intake book must not have a ".." segment');
  return resolve(path);
}

/** The folder is made when it is missing, and it must be a folder that the process can read and write: a service that cannot record an entry stops at its start. */
function prepareFolder(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!statSync(folder).isDirectory()) throw new Error('the folder of the intake book is not a folder');
  accessSync(folder, constants.R_OK | constants.W_OK | constants.X_OK);
}

/** True for the error of a file that is not there. */
const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const damaged = (): Error => new Error('the intake book file is damaged');

/** A member of an entry of the file: a text of 1 to MAX_TEXT characters. Anything else is a damaged file. */
function memberOf(entry: Record<string, unknown>, name: string): string {
  const member = entry[name];
  if (typeof member !== 'string' || member.length < 1 || member.length > MAX_TEXT) throw damaged();
  return member;
}

/** One entry of the file: exactly the three members, each a text of the right size. Anything else is a damaged file. */
function entryOf(value: unknown): IntakeEntry {
  if (!isPlainObject(value) || Object.keys(value).length !== 3) throw damaged();
  return { tenant: memberOf(value, 'tenant'), request_number: memberOf(value, 'request_number'), intake_id: memberOf(value, 'intake_id') };
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
  const list = value.requests;
  if (!Array.isArray(list) || list.length > INTAKE_BOOK_LIMIT) throw damaged();
  const entries: Entries = new Map();
  for (const item of list) {
    const entry = entryOf(item);
    const key = keyOf(entry.tenant, entry.request_number);
    if (entries.has(key)) throw damaged();
    entries.set(key, entry);
  }
  return entries;
}

/** The text of the file: one line of JSON. */
const fileText = (entries: Entries): string => `${JSON.stringify({ schema: FILE_SCHEMA, requests: [...entries.values()] })}\n`;

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
 * The intake book in one JSON file: `{ "schema", "requests": [{ "tenant", "request_number", "intake_id" }] }`, in the order of the records, with each number as it was written. The constructor writes the empty
 * book when the file is not there: that is the first start, and a start never writes over a file that is there. The class reads the file at each call, so a file that is damaged after the start is seen, and a file
 * that is missing after the start is an error and never an empty book. A new instance on the same file sees every entry: a restart loses nothing. A write is whole or it is not there: it writes a temporary file in
 * the same folder, syncs it, renames it over the file, and syncs the folder. A record resolves only after that. When the sync of the folder fails, the record rejects although the new file may be in place, and the
 * caller reads the rejection as "not stored". The records of one instance run one after the other in the order of the calls. One process owns the file: nothing locks it across processes.
 */
export class FileIntakeBook implements IntakeBook {
  readonly #file: string;
  readonly #folder: string;
  readonly #fs: BookFs;
  /** The last record that is queued or running. A record waits for the one in front of it, whatever its outcome. */
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string, options: FileIntakeBookOptions = {}) {
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

  async has(tenant: string, requestNumber: string): Promise<boolean> {
    const key = keyOf(textOf(tenant, 'tenant'), textOf(requestNumber, 'requestNumber'));
    return (await this.#read()).has(key);
  }

  async record(tenant: string, requestNumber: string, intakeId: string): Promise<void> {
    const entry: IntakeEntry = { tenant: textOf(tenant, 'tenant'), request_number: textOf(requestNumber, 'requestNumber'), intake_id: textOf(intakeId, 'intakeId') };
    const run = this.#tail.then(() => this.#add(entry));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #add(entry: IntakeEntry): Promise<void> {
    const entries = await this.#read();
    if (!isNew(entries, entry)) return;
    entries.set(keyOf(entry.tenant, entry.request_number), entry);
    await writeDurably(this.#fs, this.#folder, this.#file, fileText(entries));
  }

  /** The entries of the file. A file that is not there is an error: the constructor made it at the start. */
  async #read(): Promise<Entries> {
    let text: string;
    try {
      text = await this.#fs.readFile(this.#file);
    } catch (error) {
      if (isMissing(error)) throw new Error('the intake book file is missing', { cause: error });
      throw error;
    }
    return parseEntries(text);
  }
}
