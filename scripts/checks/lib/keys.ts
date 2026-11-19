// scripts/checks/lib/keys.ts - the key files of the checks.
// A key file is read once, when a check starts. Its text is never printed, never copied to another file and never part of an error text: a refusal names the role of the key
// ("the member key") and the rule that the file broke, and nothing that the file holds. A key is made by no script: the operator gives each key as a file.
//
// The forms of a file (the forms that the signer and the template make):
//   - one line with the key: the bech32 form `ed25519_sk1...`, or 64 hex characters (a raw Ed25519 key);
//   - lines `NAME=value`, as `keygen` prints them: one of the values is the key, and an `addr1...` value is the wallet address of the key.
// A comment line starts with `#`. The file may be UTF-8, UTF-8 with a byte-order mark, or UTF-16 with one, and its lines may end with CR LF.
// Without an address line, the wallet of a key is its enterprise address on mainnet. With one, the wallet is that address, and the key must be its payment key.
import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { inspect } from 'node:util';
import { bech32Decode, keyCredentialOf } from './addresses.ts';
import { enterpriseAddressOf, keyHashOf, rawHexToBech32, signTransaction } from './platform.ts';

export type KeyRole = 'controller' | 'agent' | 'member';

/** Why a key file was refused. The text of a refusal never holds what the file holds. */
export type KeyFileReason = 'unreadable' | 'mode' | 'no_key' | 'more_than_one_key' | 'extended_key' | 'address_mismatch';

export class KeyFileError extends Error {
  readonly role: KeyRole;
  readonly reason: KeyFileReason;
  constructor(role: KeyRole, reason: KeyFileReason, message: string) {
    super(`the ${role} key file: ${message}`);
    this.name = 'KeyFileError';
    this.role = role;
    this.reason = reason;
  }
}

// ─── The text of a file ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function textOfFile(bytes: Buffer | string): string {
  if (typeof bytes === 'string') return bytes.replace(/^\uFEFF/, '');
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

/** The values of the lines of a file: the text after `NAME=` for such a line (without quotes), else the whole line. Comments and empty lines are left out. */
function valuesOf(text: string): string[] {
  const values: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const named = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
    values.push((named === null ? line : named[1]!).trim().replace(/^(["'])(.*)\1$/, '$2'));
  }
  return values;
}

const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const BECH32_KEY = /^ed25519_sk1[0-9a-z]+$/;
const EXTENDED_KEY = /^ed25519e_sk1[0-9a-z]+$/;
const ADDRESS = /^addr1[0-9a-z]+$/;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX_LENGTH = 12;

/** A key that was read from a file. The secret is in a private field: nothing that writes the object (JSON, text, inspect) shows it. */
export class LoadedKey {
  readonly role: KeyRole;
  readonly publicKeyHex: string;
  /** The hash of the public key: 56 hex characters. */
  readonly keyHash: string;
  /** The wallet of the key. */
  readonly address: string;
  readonly #seed: Buffer;

  constructor(role: KeyRole, seed: Buffer, address: string | null) {
    this.role = role;
    this.#seed = Buffer.from(seed);
    const publicKey = createPublicKey(this.#privateKey());
    this.publicKeyHex = Buffer.from(publicKey.export({ format: 'der', type: 'spki' })).subarray(SPKI_ED25519_PREFIX_LENGTH).toString('hex');
    this.keyHash = keyHashOf(this.publicKeyHex);
    this.address = address ?? enterpriseAddressOf(this.keyHash);
  }

  #privateKey(): KeyObject {
    return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, this.#seed]), format: 'der', type: 'pkcs8' });
  }

  /** The key as a Node key object, for the JWS of the identity gateway (a subject token, a DPoP proof, the proof of an SVID request). */
  jwsKey(): KeyObject {
    return this.#privateKey();
  }

  /** Adds the vkey witness of this key to a transaction that is unsigned or carries the witnesses of other keys. The body stays as it is. */
  signTransaction(cborHex: string): { signedCborHex: string; txHashHex: string } {
    return signTransaction(cborHex, rawHexToBech32(this.#seed.toString('hex')));
  }

  toJSON(): { role: KeyRole; keyHash: string } {
    return { role: this.role, keyHash: this.keyHash };
  }

  toString(): string {
    return `the ${this.role} key ${this.keyHash}`;
  }

  [inspect.custom](): string {
    return `LoadedKey(${this.role}, ${this.keyHash})`;
  }
}

/**
 * The key that a text holds. Exactly one value of the text is a key. An address value must belong to the key. A refusal says what rule the text broke and
 * for which role, and never what the text holds.
 */
export function parseKeyText(bytes: Buffer | string, role: KeyRole): LoadedKey {
  const values = valuesOf(textOfFile(bytes));
  if (values.some((value) => EXTENDED_KEY.test(value))) throw new KeyFileError(role, 'extended_key', 'an extended key (ed25519e_sk) is not supported: give an ed25519_sk key or 64 hex characters');
  const candidates = values.filter((value) => HEX_KEY.test(value) || BECH32_KEY.test(value));
  if (candidates.length === 0) throw new KeyFileError(role, 'no_key', 'it holds no key: expected a bech32 key (ed25519_sk1...) or 64 hex characters, alone or in a NAME=value line');
  if (candidates.length > 1) throw new KeyFileError(role, 'more_than_one_key', `it holds ${candidates.length} keys: a file holds one key`);
  const candidate = candidates[0]!;
  let seed: Buffer;
  if (HEX_KEY.test(candidate)) {
    seed = Buffer.from(candidate, 'hex');
  } else {
    const decoded = bech32Decode(candidate);
    if (decoded === null || decoded.hrp !== 'ed25519_sk' || decoded.bytes.length !== 32) throw new KeyFileError(role, 'no_key', 'its key is not a valid ed25519_sk bech32 text (the checksum or the length is wrong)');
    seed = Buffer.from(decoded.bytes);
  }
  const addresses = values.filter((value) => ADDRESS.test(value));
  const bare = new LoadedKey(role, seed, null);
  if (addresses.length === 0) return bare;
  if (addresses.length > 1) throw new KeyFileError(role, 'address_mismatch', `it holds ${addresses.length} addresses: a file holds the address of its key only`);
  const address = addresses[0]!;
  if (keyCredentialOf(address) !== bare.keyHash) throw new KeyFileError(role, 'address_mismatch', 'the address in the file is not an address of its key');
  return new LoadedKey(role, seed, address);
}

export interface KeyFileIo {
  read(path: string): Buffer;
  mode(path: string): { mode: number; isFile: boolean };
}

const realIo: KeyFileIo = {
  read: (path) => readFileSync(path),
  mode: (path) => { const stats = statSync(path); return { mode: stats.mode & 0o777, isFile: stats.isFile() }; },
};

/** Reads one key file. The file is read once. A file that other users can read is refused: set its mode to 600. */
export function readKeyFile(path: string, role: KeyRole, io: Partial<KeyFileIo> = {}): LoadedKey {
  const files = { ...realIo, ...io };
  let bytes: Buffer;
  try {
    const { mode, isFile } = files.mode(path);
    if (!isFile) throw new KeyFileError(role, 'unreadable', `${path} is not a file`);
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
      throw new KeyFileError(role, 'mode', `${path} has mode ${mode.toString(8)} and other users can read it: set mode 600 on it`);
    }
    bytes = files.read(path);
  } catch (err) {
    if (err instanceof KeyFileError) throw err;
    throw new KeyFileError(role, 'unreadable', `${path} could not be read`);
  }
  return parseKeyText(bytes, role);
}

/** The keys that the operator gave, by hash and by role. It signs for a key that it holds, and for no other. */
export class KeyRing {
  readonly #byHash = new Map<string, LoadedKey>();
  readonly #byRole = new Map<KeyRole, LoadedKey>();

  constructor(keys: readonly LoadedKey[]) {
    for (const key of keys) {
      if (this.#byRole.has(key.role)) throw new Error(`the key ring holds one key for each role, and it has two for the ${key.role} key`);
      if (this.#byHash.has(key.keyHash)) throw new Error(`the ${key.role} key file holds the same key as the ${this.#byHash.get(key.keyHash)!.role} key file: each role has its own key`);
      this.#byRole.set(key.role, key);
      this.#byHash.set(key.keyHash, key);
    }
  }

  has(keyHash: string): boolean {
    return this.#byHash.has(keyHash);
  }

  get(role: KeyRole): LoadedKey {
    const key = this.#byRole.get(role);
    if (key === undefined) throw new Error(`the ${role} key was not given`);
    return key;
  }

  find(role: KeyRole): LoadedKey | undefined {
    return this.#byRole.get(role);
  }

  keyHashes(): ReadonlySet<string> {
    return new Set(this.#byHash.keys());
  }

  /** The wallet address of each key, by key hash. */
  wallets(): ReadonlyMap<string, string> {
    return new Map([...this.#byHash].map(([hash, key]) => [hash, key.address]));
  }

  roleOf(keyHash: string): KeyRole | undefined {
    return this.#byHash.get(keyHash)?.role;
  }

  /** Adds the witness of the key `keyHash` to the transaction. */
  sign(keyHash: string, cborHex: string): string {
    const key = this.#byHash.get(keyHash);
    if (key === undefined) throw new Error(`the key ring holds no key with the hash ${keyHash}`);
    return key.signTransaction(cborHex).signedCborHex;
  }
}
