// packages/usecase-kit/src/checks/ids.ts
// Small helpers that the checks share: the identifier of a DID, the form of a hex member of an answer, the key hash of a public key, and a text that is cut to a short length. Not part of the public surface.
import { blake2b } from '@noble/hashes/blake2b';
import type { Did } from '../protocol/index.ts';

const DID_PREFIX = 'did:vector:';

/** The 64 hex characters of a DID of the protocol. The input has the form of a DID: the callers check it first. */
export const idOf = (did: Did): string => did.substring(DID_PREFIX.length);

/** The DID of an identifier of 64 hex characters. */
export const didOf = (id: string): Did => `${DID_PREFIX}${id}`;

/** The size of each kind of hex member that the ledger and the gateway give, in bytes. A member is written as twice as many lower-case hex characters. */
export const KEY_BYTES = 32;
export const KEY_HASH_BYTES = 28;
export const ID_BYTES = 32;
export const DIGEST_BYTES = 32;
export const TX_HASH_BYTES = 32;

const LOWER_HEX = /^[0-9a-f]*$/;

/**
 * True for a text of exactly `bytes` bytes, written as lower-case hex characters: no upper-case letter, no other character and no other length. The ledger codec and the gateway write every
 * hex member in this form. Another form is not read as a form of the same value: a text that only starts like a key is not the key.
 */
export const isHex = (value: unknown, bytes: number): value is string => typeof value === 'string' && value.length === 2 * bytes && LOWER_HEX.test(value);

/**
 * The hash of a public key as the registry holds it: BLAKE2b with 28 bytes, as 56 lower-case hex characters. The input is a key as 64 lower-case hex characters. Any other text is a TypeError:
 * `Buffer.from(text, 'hex')` stops at the first character that is not hex, so a key with more characters after it would read as the key. A caller reads the key from an answer that was
 * checked at its entry (answers.ts), so this error is the fault of a caller and never an answer of a source.
 */
export function keyHashOf(publicKeyHex: string): string {
  if (!isHex(publicKeyHex, KEY_BYTES)) throw new TypeError('a public key is 64 lower-case hex characters');
  return Buffer.from(blake2b(Buffer.from(publicKeyHex, 'hex'), { dkLen: KEY_HASH_BYTES })).toString('hex');
}

/**
 * A text for a detail: one line, printable characters only, each run of 56 or more hex characters (an identifier, a hash) cut to its first 8 characters, and at most `max` characters. Text
 * that comes from a read of the chain can be long.
 */
export function clip(text: string, max = 160): string {
  const line = text.replace(/[^\x20-\x7e]/g, '?').replace(/[0-9a-f]{56,}/g, (hex) => `${hex.substring(0, 8)}..`);
  return line.length <= max ? line : `${line.substring(0, max - 3)}...`;
}
