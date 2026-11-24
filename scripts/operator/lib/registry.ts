// scripts/operator/lib/registry.ts - the named key registry of the operator pack.
// A key has a name (`run`, `fee`, `reorder-service`). Its file is `<dir>/shared/<name>.seed` for a key that several use cases share, and `<dir>/<use case>/<name>.seed` for a key of one use
// case. A file holds 64 lower-case hex characters and one newline: the 32 bytes of the key. The key folders have mode 700 and the files mode 600.
// The registry never prints, logs, returns or copies a seed, except through `secretHexForEnv`. A refusal names the key and the rule that it broke, and nothing that a file holds: no text, no
// path and no message of the file system (only its short error code). `keys-public.json` lists the public part of each key, so that a person can see the wallets and compare them with the files.
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fchmodSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { writeFileAtomically } from '../../checks/lib/files.ts';
import type { WriteIo } from '../../checks/lib/files.ts';
import { KeyRing, parseKeyText } from '../../checks/lib/keys.ts';
import type { LoadedKey } from '../../checks/lib/keys.ts';

/** A key of a use case: its name, who shares it, and a public sentence about what it is for. */
export interface KeySpec { readonly name: string; readonly scope: 'shared' | 'use-case'; readonly about: string }

export type KeyStoreReason = 'folder' | 'unreadable' | 'mode' | 'missing' | 'shape' | 'duplicate' | 'manifest' | 'unknown_name';

export class KeyStoreError extends Error {
  readonly reason: KeyStoreReason;
  constructor(reason: KeyStoreReason, message: string) {
    super(message);
    this.name = 'KeyStoreError';
    this.reason = reason;
  }
}

/** What a path is: a file or a folder, and its permission bits. */
export interface KeyStat { isFile: boolean; isFolder: boolean; mode: number }

/** What the registry needs from the file system. A test gives a fake for the parts that it breaks. */
export interface KeyStoreIo {
  /** The kind and the permission bits of a path, or null when nothing is there. */
  stat(path: string): KeyStat | null;
  read(path: string): string;
  /** Makes a folder with mode 700, and the folders above it when they are missing. */
  makeFolder(path: string): void;
  /** Writes a new file with mode 600: it is made with the flag `wx`, every byte is written, and the file is flushed. It fails when the file exists. */
  writeNew(path: string, bytes: Buffer): void;
  /** Gives the file `from` the second name `to`. It fails with the code EEXIST when `to` exists, and never replaces it. */
  link(from: string, to: string): void;
  /** Removes a file. A file that is not there is no error. */
  remove(path: string): void;
  /** Flushes a folder, so that its entries survive a crash. */
  flushFolder(path: string): void;
  /** 32 bytes from the random source of the system. */
  randomSeed(): Buffer;
}

const FOLDER_MODE = 0o700;
const FILE_MODE = 0o600;
const CHECK_MODES = process.platform !== 'win32';
const NAME = /^[a-z][a-z0-9-]{0,47}$/;
const SEED_TEXT = /^[0-9a-f]{64}\n?$/;
const MAX_KEYS = 64;
const MAX_ABOUT = 200;
/** The codes of a platform that cannot flush a folder: the entries stand, unflushed. */
const CANNOT_FLUSH: Record<string, true> = { EPERM: true, EINVAL: true, EISDIR: true };

/** The short code of a system error (EIO, ENOSPC), and nothing else of it: the message of a system error holds a path. */
function codeOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,24}$/.test(code) ? code : 'ERROR';
}

const realIo: KeyStoreIo = {
  stat: (path) => {
    const stats = statSync(path, { throwIfNoEntry: false });
    return stats === undefined ? null : { isFile: stats.isFile(), isFolder: stats.isDirectory(), mode: stats.mode & 0o777 };
  },
  read: (path) => readFileSync(path, 'utf8'),
  makeFolder: (path) => {
    mkdirSync(path, { recursive: true, mode: FOLDER_MODE });
    chmodSync(path, FOLDER_MODE);
  },
  writeNew: (path, bytes) => {
    const fd = openSync(path, 'wx', FILE_MODE);
    try {
      fchmodSync(fd, FILE_MODE);
      for (let written = 0; written < bytes.length;) {
        const n = writeSync(fd, bytes, written, bytes.length - written);
        if (n <= 0) throw new Error('the write made no progress');
        written += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  link: linkSync,
  remove: (path) => {
    try { unlinkSync(path); } catch (err) {
      if (codeOf(err) !== 'ENOENT') throw err;
    }
  },
  flushFolder: (path) => {
    let fd: number;
    try { fd = openSync(path, 'r'); } catch (err) {
      if (CANNOT_FLUSH[codeOf(err)] === true) return;
      throw err;
    }
    try { fsyncSync(fd); } catch (err) {
      if (CANNOT_FLUSH[codeOf(err)] !== true) throw err;
    } finally {
      closeSync(fd);
    }
  },
  randomSeed: () => randomBytes(32),
};

/** A name for a message: the name when it has the form of a key name, else a phrase that holds nothing of it. */
const shown = (name: unknown): string => (typeof name === 'string' && NAME.test(name) ? name : 'a name that is no key name');

/** Runs a call of the file system and turns its failure into a refusal that holds the code and none of the message. */
function attempt<T>(reason: KeyStoreReason, what: string, run: () => T): T {
  try { return run(); } catch (err) {
    if (err instanceof KeyStoreError) throw err;
    throw new KeyStoreError(reason, `${what} (${codeOf(err)})`);
  }
}

function checkSpecs(useCase: string, specs: readonly KeySpec[]): void {
  if (typeof useCase !== 'string' || !NAME.test(useCase) || useCase === 'shared') {
    throw new KeyStoreError('shape', 'the use case name is the name of a folder: it has lower-case letters, digits and hyphens, starts with a letter, has at most 48 characters, and is not the name shared');
  }
  if (specs.length > MAX_KEYS) throw new KeyStoreError('shape', `a registry holds at most ${MAX_KEYS} keys`);
  const seen = new Set<string>();
  specs.forEach((spec, index) => {
    if (typeof spec.name !== 'string' || !NAME.test(spec.name)) {
      throw new KeyStoreError('shape', `the key number ${index + 1} has no valid name: a key name has lower-case letters, digits and hyphens, starts with a letter, and has at most 48 characters`);
    }
    if (seen.has(spec.name)) throw new KeyStoreError('duplicate', `the key name ${spec.name} is in the list twice`);
    seen.add(spec.name);
    if (spec.scope !== 'shared' && spec.scope !== 'use-case') throw new KeyStoreError('shape', `the key ${spec.name} has a scope that is neither shared nor use-case`);
    if (typeof spec.about !== 'string' || spec.about.trim() === '' || spec.about.length > MAX_ABOUT) {
      throw new KeyStoreError('shape', `the key ${spec.name} needs an about text of 1 to ${MAX_ABOUT} characters`);
    }
  });
}

/** The folder of a scope, below the key folder: `shared`, or the name of the use case. */
const folderOf = (dir: string, useCase: string, scope: KeySpec['scope']): string => join(dir, scope === 'shared' ? 'shared' : useCase);

/** The folders that the keys of `specs` live in, once each, with the words that a message uses for them. */
function foldersOf(dir: string, useCase: string, specs: readonly KeySpec[]): { path: string; label: string }[] {
  return [...new Set(specs.map((spec) => spec.scope))].map((scope) => ({ path: folderOf(dir, useCase, scope), label: scope === 'shared' ? 'the shared key folder' : 'the key folder of the use case' }));
}

/** Checks that a folder that is there is a folder with mode 700. */
function checkFolder(found: KeyStat, label: string): void {
  if (!found.isFolder) throw new KeyStoreError('folder', `${label} is not a folder`);
  if (CHECK_MODES && found.mode !== FOLDER_MODE) throw new KeyStoreError('folder', `${label} has mode ${found.mode.toString(8)}: set mode 700 on it`);
}

/** Makes a folder with mode 700 when it is not there, and checks one that is. */
function readyFolder(store: KeyStoreIo, path: string, label: string): void {
  const found = attempt('folder', `${label} could not be read`, () => store.stat(path));
  if (found === null) attempt('folder', `${label} could not be made`, () => store.makeFolder(path));
  else checkFolder(found, label);
}

/**
 * Makes the key of each spec whose file is missing. A key is made with 32 bytes of the system random source, written to a temporary file in its own folder (flag `wx`, mode 600, flushed),
 * then linked to its final name: a name that exists is never replaced, and its key is `kept`. The temporary file is removed at once, so a failure leaves no partial key file. The call
 * makes the folders with mode 700 and refuses a key folder that has another mode. It gives names only.
 */
export function makeMissingKeys(dir: string, useCase: string, specs: readonly KeySpec[], io: Partial<KeyStoreIo> = {}): { made: string[]; kept: string[] } {
  const store: KeyStoreIo = { ...realIo, ...io };
  checkSpecs(useCase, specs);
  readyFolder(store, dir, 'the key folder');
  for (const folder of foldersOf(dir, useCase, specs)) readyFolder(store, folder.path, folder.label);
  const made: string[] = [];
  const kept: string[] = [];
  const touched = new Set<string>();
  for (const spec of specs) {
    const folder = folderOf(dir, useCase, spec.scope);
    const file = join(folder, `${spec.name}.seed`);
    if (attempt('folder', `the key ${spec.name} could not be looked up`, () => store.stat(file)) === null && createKey(store, folder, file, spec.name)) {
      made.push(spec.name);
      touched.add(folder);
    } else {
      kept.push(spec.name);
    }
  }
  if (touched.size > 0) for (const folder of [...touched, dir]) attempt('folder', 'a key folder could not be flushed', () => store.flushFolder(folder));
  return { made, kept };
}

/** Makes one key file. It gives true when it linked the file and false when the name existed already. */
function createKey(store: KeyStoreIo, folder: string, file: string, name: string): boolean {
  const temporary = join(folder, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  let step = 'random source';
  let created = false;
  let failure: unknown;
  try {
    const seed = store.randomSeed();
    if (seed.length !== 32) throw new Error('the seed is not 32 bytes');
    step = 'write';
    store.writeNew(temporary, Buffer.from(`${seed.toString('hex')}\n`));
    step = 'link';
    try { store.link(temporary, file); created = true; } catch (err) {
      if (codeOf(err) !== 'EEXIST') throw err;
    }
  } catch (err) {
    failure = err;
  }
  try { store.remove(temporary); } catch (err) {
    if (failure === undefined) { failure = err; step = 'cleanup'; }
  }
  if (failure !== undefined) throw new KeyStoreError('folder', `the key ${name} could not be made: the step ${step} failed (${codeOf(failure)})`);
  return created;
}

/** A key that was loaded, with the seed that its file holds. */
interface RegistryEntry { readonly spec: KeySpec; readonly key: LoadedKey; readonly seed: string }

export interface PublicKeyEntry { scope: 'shared' | 'use-case'; about: string; public_key_hex: string; key_hash: string; address: string }
export interface PublicManifest { note: string; network: string; use_case: string; keys: Record<string, PublicKeyEntry> }

const MANIFEST_NOTE = 'The public part of the keys of the operator pack: the public key, the key hash and the wallet address of each key. This file holds no secret.';

/**
 * The keys of one use case, by name. The ring is the `KeyRing` of the checks, keyed by name. Each seed stays in a private field and leaves through `secretHexForEnv` only. It is built by
 * `loadRegistry`.
 */
export class Registry {
  readonly useCase: string;
  readonly ring: KeyRing;
  readonly #entries: ReadonlyMap<string, RegistryEntry>;
  readonly #complete: boolean;

  constructor(useCase: string, entries: readonly RegistryEntry[], complete: boolean) {
    this.useCase = useCase;
    this.#entries = new Map(entries.map((entry) => [entry.spec.name, entry]));
    this.#complete = complete;
    this.ring = new KeyRing(entries.map((entry) => entry.key));
  }

  #entry(name: string): RegistryEntry {
    const entry = this.#entries.get(name);
    if (entry === undefined) throw new KeyStoreError('unknown_name', `the registry holds no key named ${shown(name)}`);
    return entry;
  }

  /** The names of the keys that the registry holds, in the order of the list of the use case. */
  names(): string[] {
    return [...this.#entries.keys()];
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  /** True when the registry holds every key of the use case, and false when it was loaded for some of them. */
  isComplete(): boolean {
    return this.#complete;
  }

  key(name: string): LoadedKey {
    return this.#entry(name).key;
  }

  hashOf(name: string): string {
    return this.#entry(name).key.keyHash;
  }

  addressOf(name: string): string {
    return this.#entry(name).key.address;
  }

  publicKeyOf(name: string): string {
    return this.#entry(name).key.publicKeyHex;
  }

  nameOfHash(hash: string): string | undefined {
    return this.ring.roleOf(hash);
  }

  /**
   * The seed of a key: 64 lower-case hex characters. This is the ONE function of the pack that returns a seed, and the env writer is its one caller. A test of the sources fails when
   * another file of the pack (outside the tests) names it.
   */
  secretHexForEnv(name: string): string {
    return this.#entry(name).seed;
  }

  /** The public part of each key that the registry holds. */
  publicManifest(network: string): PublicManifest {
    if (typeof network !== 'string' || network.trim() === '') throw new KeyStoreError('manifest', 'the public key file needs the name of the network');
    const keys: Record<string, PublicKeyEntry> = {};
    for (const { spec, key } of this.#entries.values()) {
      keys[spec.name] = { scope: spec.scope, about: spec.about, public_key_hex: key.publicKeyHex, key_hash: key.keyHash, address: key.address };
    }
    return { note: MANIFEST_NOTE, network, use_case: this.useCase, keys };
  }

  toJSON(): { useCase: string; names: string[] } {
    return { useCase: this.useCase, names: this.names() };
  }

  toString(): string {
    return `the key registry of ${this.useCase}: ${this.names().join(', ') || 'no key'}`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** Reads the seed of one key. The file must exist, be a file, have mode 600, and hold 64 lower-case hex characters and at most one newline. */
function readSeed(store: KeyStoreIo, folder: string, name: string): string {
  const file = join(folder, `${name}.seed`);
  const found = attempt('unreadable', `the key ${name} could not be read`, () => store.stat(file));
  if (found === null) throw new KeyStoreError('missing', `the key ${name} is missing: its key file does not exist`);
  if (!found.isFile) throw new KeyStoreError('unreadable', `the key ${name} is not a file`);
  if (CHECK_MODES && found.mode !== FILE_MODE) throw new KeyStoreError('mode', `the key ${name} has mode ${found.mode.toString(8)}: set mode 600 on its key file`);
  const text = attempt('unreadable', `the key ${name} could not be read`, () => store.read(file));
  if (!SEED_TEXT.test(text)) throw new KeyStoreError('shape', `the key ${name} is not 64 lower-case hex characters`);
  return text.slice(0, 64);
}

/**
 * Loads the keys that `need` names (all keys of `specs` when it is missing). It refuses a key file that is missing, a folder or a file with another mode than 700 or 600, a text that is not
 * 64 lower-case hex characters, and two files that hold one key. A file that no spec names is ignored, and so is the file of a key that `need` leaves out. An empty `need` loads nothing and
 * reads no folder.
 */
export function loadRegistry(options: { dir: string; useCase: string; specs: readonly KeySpec[]; need?: readonly string[]; io?: Partial<KeyStoreIo> }): Registry {
  const { dir, useCase, specs } = options;
  const store: KeyStoreIo = { ...realIo, ...options.io };
  checkSpecs(useCase, specs);
  const names = new Set(specs.map((spec) => spec.name));
  for (const name of options.need ?? []) {
    if (!names.has(name)) throw new KeyStoreError('unknown_name', `the key ${shown(name)} is not in the list of keys of this use case`);
  }
  const needed = new Set(options.need ?? names);
  const wanted = specs.filter((spec) => needed.has(spec.name));
  if (wanted.length === 0) return new Registry(useCase, [], specs.length === 0);
  const root = attempt('unreadable', 'the key folder could not be read', () => store.stat(dir));
  if (root !== null) checkFolder(root, 'the key folder');
  for (const folder of foldersOf(dir, useCase, wanted)) {
    const found = attempt('unreadable', `${folder.label} could not be read`, () => store.stat(folder.path));
    if (found !== null) checkFolder(found, folder.label);
  }
  const entries: RegistryEntry[] = [];
  const owners = new Map<string, string>();
  for (const spec of wanted) {
    const seed = readSeed(store, folderOf(dir, useCase, spec.scope), spec.name);
    const key = parseKeyText(seed, spec.name);
    const owner = owners.get(key.keyHash);
    if (owner !== undefined) throw new KeyStoreError('duplicate', `the keys ${owner} and ${spec.name} hold the same key: each name has its own key`);
    owners.set(key.keyHash, spec.name);
    entries.push({ spec, key, seed });
  }
  return new Registry(useCase, entries, wanted.length === specs.length);
}

/** Writes the public key file: the public part of every key, with mode 600, whole or not at all. A registry that holds only some of the keys cannot write it. */
export function writePublicManifest(path: string, registry: Registry, meta: { network: string; useCase: string }, io: Partial<WriteIo> = {}): void {
  if (!registry.isComplete()) throw new KeyStoreError('manifest', 'the registry holds only some of the keys, and the public key file lists all of them');
  if (meta.useCase !== registry.useCase) throw new KeyStoreError('manifest', 'the use case of the public key file is not the use case of the registry');
  writeFileAtomically(path, `${JSON.stringify(registry.publicManifest(meta.network), null, 2)}\n`, io);
}

/**
 * Refuses a public key file that does not equal what the key files give. The file is read as JSON, so its layout may differ, and its content must be the content that `writePublicManifest`
 * writes for this registry: the same use case, the same keys with the same scope, about text, public key, key hash and address, in the same order. Only the network is taken from the
 * file, because the keys do not give it. A registry that holds only some of the keys cannot check the file.
 */
export function checkPublicManifest(path: string, registry: Registry): void {
  if (!registry.isComplete()) throw new KeyStoreError('manifest', 'the registry holds only some of the keys: load all of them to check the public key file');
  let found: unknown;
  try { found = JSON.parse(readFileSync(path, 'utf8')); } catch (err) {
    throw new KeyStoreError('manifest', `the public key file ${codeOf(err) === 'ENOENT' ? 'does not exist' : err instanceof SyntaxError ? 'is not JSON' : 'could not be read'}`);
  }
  const network = typeof found === 'object' && found !== null && 'network' in found && typeof found.network === 'string' ? found.network : '';
  if (JSON.stringify(found) !== JSON.stringify(registry.publicManifest(network))) throw new KeyStoreError('manifest', 'the public key file does not equal what the key files give');
}
