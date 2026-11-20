// packages/usecase-kit/src/checks/ids.ts
// Small helpers that the checks share: the identifier of a DID, the key hash of a public key, and a text that is cut to a short length. Not part of the public surface.
import { blake2b } from '@noble/hashes/blake2b';
import type { Did } from '../protocol/index.ts';

const DID_PREFIX = 'did:vector:';

/** The 64 hex characters of a DID of the protocol. The input has the form of a DID: the callers check it first. */
export const idOf = (did: Did): string => did.substring(DID_PREFIX.length);

/** The DID of an identifier of 64 hex characters. */
export const didOf = (id: string): Did => `${DID_PREFIX}${id}`;

/** The hash of a public key as the registry holds it: BLAKE2b with 28 bytes, as 56 lower-case hex characters. The input is the key as hex. */
export const keyHashOf = (publicKeyHex: string): string => Buffer.from(blake2b(Buffer.from(publicKeyHex, 'hex'), { dkLen: 28 })).toString('hex');

/**
 * A text for a detail: one line, printable characters only, each run of 56 or more hex characters (an identifier, a hash) cut to its first 8 characters, and at most `max` characters. Text
 * that comes from a read of the chain can be long.
 */
export function clip(text: string, max = 160): string {
  const line = text.replace(/[^\x20-\x7e]/g, '?').replace(/[0-9a-f]{56,}/g, (hex) => `${hex.substring(0, 8)}..`);
  return line.length <= max ? line : `${line.substring(0, max - 3)}...`;
}
