// packages/usecase-kit/src/cosign/witness.ts
// The checks of a vkey witness. A signature of the delegator over the body is the first thing that the route asks for: the agent signs a body only after the delegator signed it, so that nobody else can make
// the agent hold a delegation key for a body that the delegator never sent.
import { CML } from '@lucid-evolution/lucid';
import type { DelegateFacts } from './read.ts';

/**
 * The encodings of the points of order 1, 2, 4 and 8 (the y of each), with the two other spellings of 0 and 1 (p and p + 1). The sign bit is not compared. A public key or a signature start that is in this
 * list is refused. Any other non-canonical spelling is of a point that nobody can sign for, so it needs no rule of its own.
 */
export const SMALL_ORDER_ENCODINGS: readonly string[] = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];

/** True when the point that `bytes` spells, without its sign bit, has a small order. */
export function hasSmallOrder(bytes: Uint8Array): boolean {
  const point = Buffer.from(bytes);
  point[31]! &= 0x7f;
  return SMALL_ORDER_ENCODINGS.includes(point.toString('hex'));
}

/**
 * True when `signature` verifies over `message` for `publicKey`, by the rules of the ledger. A key or a signature of the wrong length does not verify. The library of the node refuses a public key of small
 * order and a signature whose R has a small order; the check of CML does not: for the identity point as the key, a signature of R = the identity point and S = 0, or of R = the base point and S = 1, verifies
 * over every message, and a signature with R = the identity point and a matching S verifies for a key that the signer holds. So those two rules are checked here first, and CML checks the encoding of R, S
 * below the group order, and the equation.
 */
export function verifies(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  if (hasSmallOrder(publicKey) || hasSmallOrder(signature.subarray(0, 32))) return false;
  try {
    return CML.PublicKey.from_bytes(publicKey).verify(message, CML.Ed25519Signature.from_raw_bytes(signature));
  } catch {
    return false;
  }
}

/**
 * True when the delegator signed this body: the transaction holds ONE witness whose key hashes to `keyHash`, the key has 32 bytes and the signature has 64 bytes, and the signature verifies over the hash
 * of the body. Two witnesses of the key are not one, also when their signatures are the same: a witness of the key that does not verify cannot hide behind a witness that does.
 */
export function delegatorSigned(facts: Pick<DelegateFacts, 'witnesses' | 'bodyHash'>, keyHash: string): boolean {
  const own = facts.witnesses.filter((witness) => witness.keyHash === keyHash);
  if (own.length !== 1) return false;
  const { publicKey, signature } = own[0]!;
  return publicKey.length === 32 && signature.length === 64 && verifies(publicKey, signature, facts.bodyHash);
}
