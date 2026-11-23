// packages/usecase-kit/src/janitor/store.ts
// The list of left sub-delegations: the sub-delegations that a run sent to the node and did not see ended, and the key of the agent that signs the Undelegate of each. The list is a port with two forms. `MemoryLeftStore`
// keeps the entries in memory, for a test. `FileLeftStore` keeps one JSON file for each delegation id in a folder of the service, so that a restart loses nothing.
//
// The write rule of the file form. A write goes to a temporary file in the same folder. The file is flushed, it is renamed over the file of the id, and then the folder is flushed. `put` settles only after the
// flush of the folder, so an entry that `put` accepted is on the disk. A write that fails leaves the old entry whole, because the rename is the only step that changes the file of the id. A failed flush of
// the folder is an error of `put` too: the caller must not send what the entry names. One instance runs its calls one at a time, so two writes of one process never mix. One process owns the folder.
//
// A file that is not an entry is never skipped in silence. `list` reads every file that ends in `.json`. A file that cannot be read, is not JSON, is not an entry in the form, or holds the entry of another id than
// its name is damaged: `list` throws `DamagedLeftEntriesError`, which names each damaged file and also carries the entries that it could read, so that a caller can go on with them. The store never removes a
// damaged file. A temporary file that a crash left does not end in `.json`, so it is not an entry.
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { LeftSubDelegation } from '../access/index.ts';
import { accepted, checkMembers, parseDelegationId, parseKeyHash, readMembers, refused, type DelegationId, type ProtocolResult } from '../protocol/index.ts';

/** A left sub-delegation and the key that ends it. */
export interface LeftEntry {
  readonly left: LeftSubDelegation;
  /** The hash of the live delegation key of the agent, the key that signs the Undelegate: 56 lower-case hex characters. */
  readonly signer_key_hash: string;
}

/** The list of left sub-delegations. `put` for an id that the list has replaces the entry: a later end attempt updates `endTxHash`. `remove` of an id that is not there is not an error. */
export interface LeftStore {
  /** Every entry. It throws `DamagedLeftEntriesError` when a file of the list is damaged: a damaged entry is never skipped in silence. */
  list(): Promise<readonly LeftEntry[]>;
  put(entry: LeftEntry): Promise<void>;
  remove(id: DelegationId): Promise<void>;
}

/** A file of the store that is not an entry in the form, and why. The detail never repeats what the file holds. */
export interface DamagedLeftEntry {
  readonly file: string;
  readonly detail: string;
}

/** `list` of a store with a damaged file. `entries` are the entries that could be read, and `damaged` names each file that could not. */
export class DamagedLeftEntriesError extends Error {
  readonly entries: readonly LeftEntry[];
  readonly damaged: readonly DamagedLeftEntry[];

  constructor(entries: readonly LeftEntry[], damaged: readonly DamagedLeftEntry[]) {
    super(`${damaged.length} ${damaged.length === 1 ? 'file' : 'files'} of the list of left sub-delegations ${damaged.length === 1 ? 'is' : 'are'} damaged: ${damaged.map((d) => `${d.file} (${d.detail})`).join('; ')}`);
    this.name = 'DamagedLeftEntriesError';
    this.entries = entries;
    this.damaged = damaged;
  }
}

/** The members of `LeftSubDelegation` in the order of its file form. */
const LEFT_MEMBERS = ['id', 'parent', 'action', 'resource', 'delegateTxHash', 'delegateValidTo', 'delegateTtlSlot', 'notAfter', 'endTxHash'];
/** The most characters of the action and of the resource. A resource is `<public base>/t/<tenant>/<system>`, far shorter. */
const MAX_TEXT_CHARS = 1_024;
const TX_HASH = /^[0-9a-f]{64}$/;
const isWhole = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

function textOf(value: unknown, field: string): ProtocolResult<string> {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_TEXT_CHARS ? accepted(value) : refused('bad_shape', `${field} must be text of 1 to ${MAX_TEXT_CHARS} characters`);
}

function parseLeft(value: unknown): ProtocolResult<LeftSubDelegation> {
  const members = readMembers(value, 'entry.left');
  if (!members.ok) return members;
  const wrong = checkMembers(members.value, 'entry.left', LEFT_MEMBERS);
  if (wrong !== null) return wrong;
  const left = members.value;
  const id = parseDelegationId(left.id, 'entry.left.id');
  if (!id.ok) return id;
  const parent = parseDelegationId(left.parent, 'entry.left.parent');
  if (!parent.ok) return parent;
  const action = textOf(left.action, 'entry.left.action');
  if (!action.ok) return action;
  const resource = textOf(left.resource, 'entry.left.resource');
  if (!resource.ok) return resource;
  const { delegateTxHash, endTxHash, delegateValidTo, delegateTtlSlot, notAfter } = left;
  if (typeof delegateTxHash !== 'string' || !TX_HASH.test(delegateTxHash)) return refused('bad_shape', 'entry.left.delegateTxHash must be 64 lower-case hex characters');
  if (!isWhole(delegateValidTo, 1)) return refused('bad_shape', 'entry.left.delegateValidTo must be a whole number of milliseconds, 1 or more');
  if (!isWhole(delegateTtlSlot, 0)) return refused('bad_shape', 'entry.left.delegateTtlSlot must be a whole number of slots, 0 or more');
  if (!isWhole(notAfter, 1)) return refused('bad_shape', 'entry.left.notAfter must be a whole number of milliseconds, 1 or more');
  if (endTxHash !== null && (typeof endTxHash !== 'string' || !TX_HASH.test(endTxHash))) return refused('bad_shape', 'entry.left.endTxHash must be null or 64 lower-case hex characters');
  return accepted({
    id: id.value, parent: parent.value, action: action.value, resource: resource.value, delegateTxHash, delegateValidTo, delegateTtlSlot, notAfter, endTxHash,
  });
}

/**
 * The entry that `value` describes, as a NEW object in the order of the file form, or a refusal that names the member and never repeats its value. It never throws. The members are `left` (the nine members of
 * `LeftSubDelegation`, and no other) and `signer_key_hash`. Every hash is in lower case. A getter, an inherited member and the key `__proto__` are refused.
 */
export function parseLeftEntry(value: unknown): ProtocolResult<LeftEntry> {
  const members = readMembers(value, 'entry');
  if (!members.ok) return members;
  const wrong = checkMembers(members.value, 'entry', ['left', 'signer_key_hash']);
  if (wrong !== null) return wrong;
  const left = parseLeft(members.value.left);
  if (!left.ok) return left;
  const signer = parseKeyHash(members.value.signer_key_hash, 'entry.signer_key_hash');
  return signer.ok ? accepted({ left: left.value, signer_key_hash: signer.value }) : signer;
}

const entryOrThrow = (value: unknown): LeftEntry => {
  const parsed = parseLeftEntry(value);
  if (!parsed.ok) throw new TypeError(parsed.detail);
  return parsed.value;
};

const idOrThrow = (value: unknown): string => {
  const parsed = parseDelegationId(value, 'id');
  if (!parsed.ok) throw new TypeError(parsed.detail);
  return parsed.value;
};

/** The list in memory, in the order of the first `put` of each id. A restart forgets it. */
export class MemoryLeftStore implements LeftStore {
  readonly #entries = new Map<string, LeftEntry>();

  async list(): Promise<readonly LeftEntry[]> {
    return [...this.#entries.values()].map((entry) => structuredClone(entry));
  }

  async put(entry: LeftEntry): Promise<void> {
    const checked = entryOrThrow(entry);
    this.#entries.set(checked.left.id, checked);
  }

  async remove(id: DelegationId): Promise<void> {
    this.#entries.delete(idOrThrow(id));
  }
}

/** What `FileLeftStore` needs from a disk. The default is `nodeLeftFs`; a test gives its own to watch the calls and to make one fail. A path is always inside the folder of the store. */
export interface LeftFs {
  /** Makes the folder and the folders above it, with mode 700. A folder that is there is not an error. */
  mkdir(path: string): Promise<void>;
  /** The names in the folder. It rejects with `code` `ENOENT` when the folder is not there. */
  readdir(path: string): Promise<readonly string[]>;
  /** The text of a file. */
  readFile(path: string): Promise<string>;
  /** Makes a new file with all of `text`, and rejects when the file is there. The file has mode 600. */
  writeFile(path: string, text: string): Promise<void>;
  /** Flushes a file, or a folder, to the disk. */
  fsync(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a file. It rejects with `code` `ENOENT` when the file is not there. */
  unlink(path: string): Promise<void>;
}

export const nodeLeftFs: LeftFs = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
  fsync: async (path) => {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
};

const FILE_NAME = /^([0-9a-f]{64})\.json$/;
/** The most characters of a file name that a detail or a message shows. */
const MAX_NAME_CHARS = 100;

/** The code of an error of the disk, such as `ENOENT`, or an empty text when the error has none. */
function codeOf(error: unknown): string {
  const code: unknown = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : '';
}

/** A name from the disk as a detail may show it: printable ASCII only, and cut. */
const shownName = (name: string): string => name.replace(/[^\x20-\x7e]/g, '?').slice(0, MAX_NAME_CHARS);

/** The list on disk: one file `<id>.json` for each delegation id, in `directory`. The write rule is in the head of this file. */
export class FileLeftStore implements LeftStore {
  readonly #directory: string;
  readonly #fs: LeftFs;
  #tail: Promise<unknown> = Promise.resolve();

  /** `directory` is a path with no part that is `..`. The folder is made at the first `put`, with mode 700. */
  constructor(directory: string, fs: LeftFs = nodeLeftFs) {
    if (typeof directory !== 'string' || directory.length === 0 || directory.split(/[\\/]/).includes('..')) {
      throw new TypeError('the folder of the list of left sub-delegations must be a path with no part that is ..');
    }
    this.#directory = resolve(directory);
    this.#fs = fs;
  }

  list(): Promise<readonly LeftEntry[]> {
    return this.#queued(() => this.#read());
  }

  async put(entry: LeftEntry): Promise<void> {
    const checked = entryOrThrow(entry);
    await this.#queued(() => this.#write(checked));
  }

  async remove(id: DelegationId): Promise<void> {
    const checked = idOrThrow(id);
    await this.#queued(() => this.#delete(checked));
  }

  /** Runs `job` after every call that came before it has ended, whatever its outcome. */
  #queued<T>(job: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(job);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #write(entry: LeftEntry): Promise<void> {
    const fs = this.#fs;
    const target = join(this.#directory, `${entry.left.id}.json`);
    const temporary = join(this.#directory, `${entry.left.id}.json.${randomBytes(6).toString('hex')}.tmp`);
    await fs.mkdir(this.#directory);
    try {
      await fs.writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`);
      await fs.fsync(temporary);
      await fs.rename(temporary, target);
    } catch (error) {
      try {
        await fs.unlink(temporary);
      } catch {
        // The clean-up is a courtesy: the file does not end in `.json`, so it is not an entry. The error of the write is the one to give.
      }
      throw error;
    }
    await fs.fsync(this.#directory);
  }

  async #delete(id: string): Promise<void> {
    try {
      await this.#fs.unlink(join(this.#directory, `${id}.json`));
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return;
      throw error;
    }
    await this.#fs.fsync(this.#directory);
  }

  async #read(): Promise<readonly LeftEntry[]> {
    let names: readonly string[];
    try {
      names = await this.#fs.readdir(this.#directory);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return [];
      throw error;
    }
    const entries: LeftEntry[] = [];
    const damaged: DamagedLeftEntry[] = [];
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const read = await this.#readFile(name);
      if (read.ok) entries.push(read.value);
      else damaged.push({ file: shownName(name), detail: read.detail });
    }
    if (damaged.length > 0) throw new DamagedLeftEntriesError(entries, damaged);
    return entries;
  }

  /** The entry in the file `name`, or why the file is damaged. The detail names the member that is wrong and never repeats what the file holds. */
  async #readFile(name: string): Promise<ProtocolResult<LeftEntry>> {
    const named = FILE_NAME.exec(name);
    if (named === null) return refused('bad_shape', 'the name of the file is not a delegation id of 64 lower-case hex characters and .json');
    let text: string;
    try {
      text = await this.#fs.readFile(join(this.#directory, name));
    } catch (error) {
      const code = codeOf(error);
      return refused('bad_shape', `the file could not be read${code === '' ? '' : ` (${code})`}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return refused('bad_shape', 'the file is not JSON');
    }
    const parsed = parseLeftEntry(json);
    if (!parsed.ok) return parsed;
    return parsed.value.left.id === named[1] ? parsed : refused('bad_shape', 'the file holds the entry of another id than its name');
  }
}
