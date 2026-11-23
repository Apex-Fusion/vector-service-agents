// packages/usecase-kit/src/dispute/file-journal.ts
// The journal of the challenges, on disk. `FileJournal` keeps the record of each job in one JSON file, so a restart of the service loses no record. The dispute code writes the record `started` before it sends
// the evidence, and it reads the journal first: a job that has a record gets that state, and a job never files two challenges. `MemoryJournal` forgets its records at a restart. This class does not.
//
// The folder. The caller gives the folder, for example the state volume of the service. The class reads and writes only in that folder. It reads no environment variable and no key. The constructor makes the folder
// when it is missing (mode 700, and the folders above it). It throws when the path has a `..` segment, and when the folder cannot be made, is not a folder, or cannot be written. The file of a job is named by
// its escrow with the hash sign replaced by an underscore: `<64 hex characters>_<index>`. Any other reference is an error, and no file is touched for it. The file holds the record that the dispute code
// gave, as one line of JSON.
//
// A write is whole, or it is not there. `put` writes a temporary file in the same folder, syncs it, renames it over the file of the job, syncs the folder, and then it returns. An error or a crash before the
// rename leaves the old file as it was, and the temporary file has a name that no read takes. The writes for one job run one after the other in the order of the calls, whatever instance of the process makes
// them (the queue is shared, and its key is the resolved path of the file), so a slow old write never lands after a newer one. Writes for two jobs do not wait for each other. When the sync of the folder fails,
// `put` rejects, although the new record may be in place. The caller reads a rejection as "not stored", which is the safe reading: the dispute code sends nothing after a failed write of the record `started`.
//
// A read gives null when the job has no file. It throws when the file cannot be read, and when the file does not hold a JSON object: a record that exists is never read as "no record". The dispute code checks the
// record that a read gives (`parseJobRecord`), so this class says nothing about the content.
//
// One process owns the folder. Nothing locks it across processes: two processes that read one lapsed record `started` can both go on, as journal.ts says.
import { randomBytes } from 'node:crypto';
import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { isPlainObject, parseJsonText, parseOutputRef } from '../protocol/index.ts';
import type { OutputRef } from '../protocol/index.ts';
import type { DisputeJournal, JobRecord } from './journal.ts';

/** The file system calls of the journal. The default is the file system of the process. A test gives its own, to make a write fail or to see the order of the calls. */
export interface JournalFs {
  /** The text of the file. It rejects with the code `ENOENT` when the file is not there. */
  readFile(path: string): Promise<string>;
  /** Makes a new file with the text. The name of a temporary file is new, so the call never replaces a file. */
  writeFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Returns when the data of the file, or the entries of the folder, are on the disk. */
  fsync(path: string): Promise<void>;
  /** Removes a temporary file after a write that failed. A failure of this call changes nothing. */
  unlink?(path: string): Promise<void>;
}

export interface FileJournalOptions {
  /** The file system calls. A call that the object leaves out is the call of the file system of the process. */
  readonly fs?: Partial<JournalFs>;
}

const NODE_FS: JournalFs = {
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

/** The path as an absolute path. A path that is not text, that is empty, that holds a NUL character or that has a `..` segment is refused: the folder is the one that the caller named. */
function absolutePath(path: unknown, what: string): string {
  if (typeof path !== 'string') throw new TypeError(`${what} must be text`);
  if (path === '' || path.includes('\0')) throw new RangeError(`${what} must be a path`);
  if (path.split(/[\\/]+/).includes('..')) throw new RangeError(`${what} must not have a ".." segment`);
  return resolve(path);
}

/** The folder is made when it is missing, and it must be a folder that the process can read and write. */
function prepareFolder(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!statSync(folder).isDirectory()) throw new Error('the journal folder is not a folder');
  accessSync(folder, constants.R_OK | constants.W_OK | constants.X_OK);
}

const isMissing = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { readonly code?: unknown }).code === 'ENOENT';

/** The text of a record: one line of JSON. It throws for a value that JSON cannot hold, such as a bigint, and for a value that is not an object. */
function textOf(record: unknown): string {
  if (!isPlainObject(record)) throw new TypeError('the journal record must be an object');
  const text: string | undefined = JSON.stringify(record);
  if (typeof text !== 'string') throw new TypeError('the journal record is not JSON data');
  return `${text}\n`;
}

/** The record in a file. A text that is not JSON, and JSON that is not an object, are errors: the text of the file is never part of the message. */
function recordOf(text: string): JobRecord {
  const parsed = parseJsonText(text, 'the journal file');
  if (!parsed.ok || !isPlainObject(parsed.value)) throw new Error('the journal file of the job does not hold a record');
  return parsed.value as unknown as JobRecord;
}

/** A temporary file, a sync of it, a rename over `target`, and a sync of the folder. A failure before the rename removes the temporary file, and leaves `target` as it was. */
async function writeDurably(fs: JournalFs, folder: string, target: string, text: string): Promise<void> {
  const temporary = join(folder, `.${basename(target)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temporary, text);
    await fs.fsync(temporary);
    await fs.rename(temporary, target);
  } catch (error) {
    try {
      await fs.unlink?.(temporary);
    } catch {
      // The temporary file stays. It is never read, and the error of the write is the error that counts.
    }
    throw error;
  }
  await fs.fsync(folder);
}

/**
 * The last write that is queued or running for each file of the process, by the resolved path of the file. Every instance shares it, so the writes for one file run one after the other in the order of the
 * calls, whatever instance makes them. A folder that is reached through a link has other keys.
 */
const queued = new Map<string, Promise<void>>();

/** Runs `write` when every write that was queued for the file before it has ended, whatever the outcome of those writes. The result is the outcome of `write`. */
function inOrder(file: string, write: () => Promise<void>): Promise<void> {
  const key = resolve(file);
  const run = (queued.get(key) ?? Promise.resolve()).then(write);
  const tail = run.then(() => undefined, () => undefined);
  queued.set(key, tail);
  tail.then(() => {
    if (queued.get(key) === tail) queued.delete(key);
  });
  return run;
}

export class FileJournal implements DisputeJournal {
  readonly #folder: string;
  readonly #fs: JournalFs;

  constructor(directory: string, options: FileJournalOptions = {}) {
    this.#folder = absolutePath(directory, 'the journal folder');
    prepareFolder(this.#folder);
    this.#fs = { ...NODE_FS, ...options.fs };
  }

  async get(escrow: OutputRef): Promise<JobRecord | null> {
    const file = this.#fileOf(escrow);
    let text: string;
    try {
      text = await this.#fs.readFile(file);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    return recordOf(text);
  }

  async put(escrow: OutputRef, record: JobRecord): Promise<void> {
    const file = this.#fileOf(escrow);
    // The text is made at the call, so a later change of the record object changes nothing that is written.
    const text = textOf(record);
    await inOrder(file, () => writeDurably(this.#fs, this.#folder, file, text));
  }

  /** The file of a job. Only an output reference gives one, so no other text reaches the file system. */
  #fileOf(escrow: OutputRef): string {
    if (!parseOutputRef(escrow).ok) throw new TypeError('the journal needs an output reference as the name of a job');
    return join(this.#folder, escrow.split('#').join('_'));
  }
}
