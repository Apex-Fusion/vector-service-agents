// agents/prior-authorization-agent/src/counter/counter.ts
// The counter of request numbers, one for each tenant. `propose` takes a number with `next(tenant)` and writes it in `request_number` (`<tenant>-<counter>`). The number is stored BEFORE `next` gives it out:
// a crash after the store and before the use leaves a gap, and a gap is allowed. A number that was given out is never given again, so two requests of one tenant never share a number.
//
// `MemoryRequestCounter` keeps the numbers in memory, for a test. `FileRequestCounter` keeps them in one JSON file that holds the last number of each tenant, for the service: `{"run1":3,"run2":1}`. The first
// number of a tenant is 1.
//
// The file form. A write goes to a temporary file in the same folder. The file is synced, it is renamed over the counter file, and then the folder is synced. `next` gives the number out only after the sync
// of the folder. A write that fails before the rename leaves the old file whole. Every call reads the file again, so the file is the one source of truth: a call whose sync of the folder failed rejects, the
// file may already hold its number, and the next call then goes on from that number. That is a gap and never a reuse. Calls of one counter run one at a time in the order of the calls. One counter object owns the file: the service builds one `FileRequestCounter` for each file.
//
// A file that cannot be read is an error, and a file that is damaged is an error: neither is taken as "no number yet", because a new start at 1 would give out numbers that were used. Only a file that does
// not exist is an empty counter. The message of an error that this file writes never repeats the path or what the file holds. An error of the file system keeps its own message. A temporary file that a crash
// left does not end in `.json`, and no read takes it.
import { randomBytes } from 'node:crypto';
import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { requestNumberOf } from '@vsa/usecase-kit/priorauth';

export interface RequestCounter {
  /**
   * The next request number of a tenant: 1 for the first, and one more each time. It settles after the number is stored. A tenant that a request number cannot hold is a TypeError. A number is never given
   * twice, and a call that rejects gave no number.
   */
  next(tenant: string): Promise<number>;
}

/** Checks that a request number can hold the tenant, with the rule of `requestNumberOf` of the kit. It throws a TypeError whose message never repeats the tenant. */
function checkTenant(tenant: string): void {
  requestNumberOf(tenant, 0);
}

/** The largest number that a counter gives out: a number that a double holds exactly. */
const LAST_NUMBER = Number.MAX_SAFE_INTEGER;

function numberAfter(last: number): number {
  if (last >= LAST_NUMBER) throw new RangeError('the counter of the tenant is at its largest number');
  return last + 1;
}

export class MemoryRequestCounter implements RequestCounter {
  readonly #last = new Map<string, number>();

  // The body of an async method runs to its end before another call starts, so two calls at one time get two numbers.
  async next(tenant: string): Promise<number> {
    checkTenant(tenant);
    const number = numberAfter(this.#last.get(tenant) ?? 0);
    this.#last.set(tenant, number);
    return number;
  }
}

/** The file system calls of the counter. The default is the file system of the process. A test gives its own, to make a write fail or to see the order of the calls. */
export interface CounterFs {
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

export interface FileRequestCounterOptions {
  /** The file system calls. A call that the object leaves out is the call of the file system of the process. */
  readonly fs?: Partial<CounterFs>;
}

const NODE_FS: CounterFs = {
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

/** The path as an absolute path. A path that is not text, that is empty, that holds a NUL character or that has a `..` segment is refused: the file is the one that the caller named. */
function absolutePath(path: unknown): string {
  if (typeof path !== 'string') throw new TypeError('the path of the counter file must be text');
  if (path === '' || path.includes('\0')) throw new RangeError('the path of the counter file must be a path');
  if (path.split(/[\\/]+/).includes('..')) throw new RangeError('the path of the counter file must not have a ".." segment');
  return resolve(path);
}

/** The folder is made when it is missing, and it must be a folder that the process can read and write. */
function prepareFolder(folder: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (!statSync(folder).isDirectory()) throw new Error('the folder of the counter file is not a folder');
  accessSync(folder, constants.R_OK | constants.W_OK | constants.X_OK);
}

/** The last number of each tenant in a file, or an error for a text that is not such a file. The error never repeats the text. */
function stateOf(text: string): Map<string, number> {
  const damaged = (): Error => new Error('the counter file is damaged: it is not an object with a last number for each tenant');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw damaged();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw damaged();
  const state = new Map<string, number>();
  for (const [tenant, last] of Object.entries(parsed)) {
    try {
      checkTenant(tenant);
    } catch {
      throw damaged();
    }
    if (typeof last !== 'number' || !Number.isSafeInteger(last) || last < 0) throw damaged();
    state.set(tenant, last);
  }
  return state;
}

/** A temporary file, a sync of it, a rename over `target`, and a sync of the folder. A failure before the rename removes the temporary file, and leaves `target` as it was. */
async function writeDurably(fs: CounterFs, folder: string, target: string, text: string): Promise<void> {
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

export class FileRequestCounter implements RequestCounter {
  readonly #path: string;
  readonly #folder: string;
  readonly #fs: CounterFs;
  /** The last call that is queued or running. A call waits for the one in front of it, whatever the outcome of that one. */
  #tail: Promise<unknown> = Promise.resolve();

  /** Throws when the path is not a usable path, or when its folder cannot be made, is not a folder, or cannot be written. */
  constructor(path: string, options: FileRequestCounterOptions = {}) {
    this.#path = absolutePath(path);
    this.#folder = dirname(this.#path);
    prepareFolder(this.#folder);
    this.#fs = { ...NODE_FS, ...options.fs };
  }

  next(tenant: string): Promise<number> {
    const turn = this.#tail.then(() => this.#take(tenant));
    this.#tail = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  async #take(tenant: string): Promise<number> {
    checkTenant(tenant);
    const state = await this.#read();
    const number = numberAfter(state.get(tenant) ?? 0);
    state.set(tenant, number);
    const sorted = [...state].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    await writeDurably(this.#fs, this.#folder, this.#path, `${JSON.stringify(Object.fromEntries(sorted))}\n`);
    return number;
  }

  /** The state in the file. A file that is not there is an empty state, and any other failure of the read is an error. */
  async #read(): Promise<Map<string, number>> {
    let text: string;
    try {
      text = await this.#fs.readFile(this.#path);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new Map();
      throw error;
    }
    return stateOf(text);
  }
}
