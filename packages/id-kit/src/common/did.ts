// packages/id-kit/src/common/did.ts
// The names that the gateway gives: the DID of an agent, the DID URL of one of its keys, and the hash of a key.

import { blake2b } from '@noble/hashes/blake2b';

const DID = /^did:vector:([0-9a-f]{64})$/;
const KID = /^did:vector:([0-9a-f]{64})#([0-9a-f]{56})$/;

/** The DID of an agent: `did:vector:` and the identifier of 64 lowercase hex characters. */
export const didOf = (vectorId: string): string => `did:vector:${vectorId}`;

/** The identifier in a DID, or null when the text is not exactly one DID of an agent in its canonical form. */
export function vectorIdOf(did: unknown): string | null {
  return typeof did === 'string' ? (DID.exec(did)?.[1] ?? null) : null;
}

/** The two parts of the DID URL of a key, `did:vector:<id>#<key hash>`, or null for any other text. */
export function parseKid(kid: unknown): { readonly vectorId: string; readonly keyHash: string } | null {
  const match = typeof kid === 'string' ? KID.exec(kid) : null;
  return match === null ? null : { vectorId: match[1]!, keyHash: match[2]! };
}

/** The hash of a key as a record names it: blake2b-224 of the public key bytes (32 bytes for Ed25519, the 33-byte compressed point for P-256), in 56 hex characters. */
export function keyHashOf(publicKeyHex: string): string {
  return Buffer.from(blake2b(Buffer.from(publicKeyHex, 'hex'), { dkLen: 28 })).toString('hex');
}
