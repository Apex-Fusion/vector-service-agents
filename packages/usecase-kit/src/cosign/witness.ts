// packages/usecase-kit/src/cosign/witness.ts
// The checks of a vkey witness. A signature of the delegator over the body is the first thing that the route asks for: the agent signs a body only after the delegator signed it, so that nobody else can make
// the agent hold a delegation key for a body that the delegator never sent.
import { CML } from '@lucid-evolution/lucid';
import type { DelegateFacts } from './read.ts';

/** True when `signature` verifies over `message` for `publicKey`. A key or a signature of the wrong length does not verify. */
export function verifies(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean {
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
