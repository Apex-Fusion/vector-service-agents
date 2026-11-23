// packages/usecase-kit/src/cosign/file-register.ts
// The register of the signed bodies, on disk. `FileKeyRegister` keeps the entries of the contract in register.ts in one JSON file, so a restart of the service does not free a key that holds a body that the
// agent signed. `KeyReservations` forgets its entries at a restart. This class does not.
//
// The rules are those of `KeyReservations`. `take` and `commit` are one compare-and-set on the key, and `release` removes only an entry of its own body that is not committed. An entry whose time has come
// (`nowMs >= untilMs`) is dropped when the file is read, and the next write leaves it out. A time that is not a finite number is a `RangeError`, and it makes no entry. A claim whose key hash or body hash is
// not text, or is empty, is a `TypeError`: the file never holds an entry that it cannot read back.
//
// What the disk adds. Each call reads the file again, so the file is the truth, and a file that was damaged after the last call is seen at this call. All calls of one instance run in one promise queue, so two
// calls never overlap in one process. A call that changes the entry writes the whole file before it returns: a temporary file in the same folder, a sync of it, a rename over the register file, and a sync of
// the folder. `commit` always writes, also for an entry that is committed already, so a `commit` that settles with 'held' never rests on a file that no call has synced. A call that changes nothing writes
// nothing. A crash between a `take` and its `commit` leaves the entry that the `take` made, so the key stays held until `untilMs`. When the write fails, the call rejects, and the route reads that as
// `check_unavailable` and sends no signature. A failure before the rename leaves the old file whole. A failure of the sync of the folder leaves the new file in place, so the key stays held for the body, which
// is the safe side: a key that is held too long never gives a second body.
//
// A file that is not there is a register with no entries. A file that cannot be read, that is not JSON, or that is not in its form makes every call throw. It never reads as a free key, and the call changes
// nothing. The form is `{"version":1,"entries":[{"key_hash":..,"body_hash":..,"until_ms":..,"committed":..}]}` with one entry for each key. It holds hashes and times, and no key and no part of a request.
//
// The path. The caller gives the path of the file, for example in the state volume of the service. The class reads and writes only that file and its temporary files, and it reads no environment variable. The
// constructor throws when the path has a `..` segment, or when its folder is missing, is not a folder, or cannot be written. It does not make the folder. One process owns the file: a second process that writes
// to it is outside the contract.
import { randomBytes } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { checkMembers, isPlainObject, parseJsonText } from '../protocol/index.ts';
import type { ClaimResult, KeyClaim, KeyRegister } from './register.ts';

/** The file system calls of the register. The default is the file system of the process. A test gives its own, to make a write fail or to see the order of the calls. */
export interface RegisterFs {
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

export interface FileKeyRegisterOptions {
  /** The file system calls. A call that the object leaves out is the call of the file system of the process. */
  readonly fs?: Partial<RegisterFs>;
}

const NODE_FS: RegisterFs = {
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

/** What the register holds for a key. */
interface Entry {
  readonly bodyHash: string;
  readonly untilMs: number;
  readonly committed: boolean;
}

/** The path as an absolute path. A path that is not text, that is empty, that holds a NUL character or that has a `..` segment is refused: the file is the one that the caller named. */
function absolutePath(path: unknown, what: string): string {
  if (typeof path !== 'string') throw new TypeError(`${what} must be text`);
  if (path === '' || path.includes('\0')) throw new RangeError(`${what} must be a path`);
  if (path.split(/[\\/]+/).includes('..')) throw new RangeError(`${what} must not have a ".." segment`);
  return resolve(path);
}

/** The folder of the register file must be there, and the process must be able to read and write it. */
function checkFolder(folder: string): void {
  if (!statSync(folder).isDirectory()) throw new Error('the folder of the register file is not a folder');
  accessSync(folder, constants.R_OK | constants.W_OK | constants.X_OK);
}

const isMissing = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { readonly code?: unknown }).code === 'ENOENT';

const isHash = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The check of a claim before the register reads or writes anything. */
function checkClaim(claim: Pick<KeyClaim, 'keyHash' | 'bodyHash'>): void {
  if (!isHash(claim.keyHash) || !isHash(claim.bodyHash)) throw new TypeError('the register needs a key hash and a body hash that are text');
}

/** The reason is a fixed text: nothing of the file is part of the message. */
const damaged = (reason: string): Error => new Error(`the register file is damaged: ${reason}`);

/** The entries of a register file, by key hash. A text that is not in the form of the file is an error. */
function entriesOf(text: string): Map<string, Entry> {
  const parsed = parseJsonText(text, 'the register file');
  if (!parsed.ok) throw damaged('it is not JSON');
  const root = parsed.value;
  if (!isPlainObject(root) || checkMembers(root, 'the register file', ['version', 'entries']) !== null) throw damaged('it is not in its form');
  if (root.version !== 1 || !Array.isArray(root.entries)) throw damaged('it is not in its form');
  const entries = new Map<string, Entry>();
  for (const item of root.entries as unknown[]) {
    if (!isPlainObject(item) || checkMembers(item, 'an entry', ['key_hash', 'body_hash', 'until_ms', 'committed']) !== null) throw damaged('an entry is not in its form');
    const { key_hash: keyHash, body_hash: bodyHash, until_ms: untilMs, committed } = item;
    if (!isHash(keyHash) || !isHash(bodyHash) || typeof untilMs !== 'number' || !Number.isFinite(untilMs) || typeof committed !== 'boolean') throw damaged('an entry is not in its form');
    if (entries.has(keyHash)) throw damaged('a key has two entries');
    entries.set(keyHash, { bodyHash, untilMs, committed });
  }
  return entries;
}

/** The text of the register file for the entries: one line of JSON. */
function textOf(entries: ReadonlyMap<string, Entry>): string {
  const list = [...entries].map(([keyHash, held]) => ({ key_hash: keyHash, body_hash: held.bodyHash, until_ms: held.untilMs, committed: held.committed }));
  return `${JSON.stringify({ version: 1, entries: list })}\n`;
}

/** A temporary file, a sync of it, a rename over `target`, and a sync of the folder. A failure before the rename removes the temporary file, and leaves `target` as it was. */
async function writeDurably(fs: RegisterFs, folder: string, target: string, text: string): Promise<void> {
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

export class FileKeyRegister implements KeyRegister {
  readonly #file: string;
  readonly #folder: string;
  readonly #fs: RegisterFs;
  /** The end of the last call that is queued or running. A call starts when the call in front of it has ended, whatever its outcome. */
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string, options: FileKeyRegisterOptions = {}) {
    this.#file = absolutePath(path, 'the register path');
    this.#folder = dirname(this.#file);
    checkFolder(this.#folder);
    this.#fs = { ...NODE_FS, ...options.fs };
  }

  take(claim: KeyClaim, nowMs: number): Promise<ClaimResult> {
    return this.#inOrder(() => this.#claim(claim, nowMs, false));
  }

  commit(claim: KeyClaim, nowMs: number): Promise<ClaimResult> {
    return this.#inOrder(() => this.#claim(claim, nowMs, true));
  }

  release(claim: Pick<KeyClaim, 'keyHash' | 'bodyHash'>): Promise<void> {
    return this.#inOrder(async () => {
      checkClaim(claim);
      const entries = await this.#read();
      const held = entries.get(claim.keyHash);
      if (held === undefined || held.bodyHash !== claim.bodyHash || held.committed) return;
      entries.delete(claim.keyHash);
      await this.#write(entries);
    });
  }

  /** The compare-and-set of `take` and of `commit`. A `take` writes only when it makes the entry. A `commit` writes whenever it answers 'held'. */
  async #claim(claim: KeyClaim, nowMs: number, committed: boolean): Promise<ClaimResult> {
    if (!(Number.isFinite(nowMs) && Number.isFinite(claim.untilMs))) throw new RangeError('the register needs a time that is a number');
    checkClaim(claim);
    const entries = await this.#read();
    for (const [keyHash, entry] of entries) {
      if (nowMs >= entry.untilMs) entries.delete(keyHash);
    }
    const held = entries.get(claim.keyHash);
    if (held !== undefined && held.bodyHash !== claim.bodyHash) return 'in_use';
    if (held === undefined) entries.set(claim.keyHash, { bodyHash: claim.bodyHash, untilMs: claim.untilMs, committed });
    else if (committed) entries.set(claim.keyHash, { ...held, committed: true });
    if (held === undefined || committed) await this.#write(entries);
    return 'held';
  }

  /** The entries of the file. A file that is not there has none. Any other failure of the read, and a file that is damaged, are errors. */
  async #read(): Promise<Map<string, Entry>> {
    let text: string;
    try {
      text = await this.#fs.readFile(this.#file);
    } catch (error) {
      if (isMissing(error)) return new Map();
      throw error;
    }
    return entriesOf(text);
  }

  #write(entries: ReadonlyMap<string, Entry>): Promise<void> {
    return writeDurably(this.#fs, this.#folder, this.#file, textOf(entries));
  }

  /** Runs `call` when every call that was queued before it has ended. The result is the outcome of `call`. */
  #inOrder<T>(call: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(call);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
