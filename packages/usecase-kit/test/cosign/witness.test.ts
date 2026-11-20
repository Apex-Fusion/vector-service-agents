// packages/usecase-kit/test/cosign/witness.test.ts
// The check of the witness of the delegator, on its own: one witness of the key, a key of 32 bytes, a signature of 64 bytes, and a signature that verifies over the hash of the body. Each refusal has its
// twin, the one witness that is right.
import { describe, expect, it } from 'vitest';
import { delegatorSigned, verifies } from '../../src/cosign/witness.ts';
import { DELEG_A, PRINCIPAL, STRANGER, privateKeyOf } from './support.ts';
import type { TestKey } from './support.ts';

const bodyHash = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

interface Witness {
  keyHash: string;
  publicKey: Uint8Array;
  signature: Uint8Array;
}

/** The witness of `key` over `message`, as the route reads it from a transaction. */
const witnessOf = (key: TestKey, message: Uint8Array = bodyHash): Witness => ({
  keyHash: key.keyHash,
  publicKey: Uint8Array.from(Buffer.from(key.publicKey, 'hex')),
  signature: Uint8Array.from(privateKeyOf(key).sign(message).to_raw_bytes()),
});

const flipped = (bytes: Uint8Array, at = 10): Uint8Array => Uint8Array.from(bytes, (byte, i) => (i === at ? byte ^ 1 : byte));
const signed = (...witnesses: Witness[]): boolean => delegatorSigned({ witnesses, bodyHash }, PRINCIPAL.keyHash);

describe('the witness of the delegator', () => {
  it('is one witness of the key whose signature verifies over the hash of the body', () => {
    expect(signed(witnessOf(PRINCIPAL))).toBe(true);
  });

  it('is not there when the transaction has no witness, or has the witness of another key only', () => {
    expect(signed()).toBe(false);
    expect(signed(witnessOf(STRANGER), witnessOf(DELEG_A))).toBe(false);
    // The twin: the witness of the delegator among other witnesses.
    expect(signed(witnessOf(STRANGER), witnessOf(PRINCIPAL), witnessOf(DELEG_A))).toBe(true);
  });

  it('is not there when the signature is over another hash, or is changed, or is empty', () => {
    expect(signed(witnessOf(PRINCIPAL, Uint8Array.from(bodyHash).reverse()))).toBe(false);
    expect(signed({ ...witnessOf(PRINCIPAL), signature: flipped(witnessOf(PRINCIPAL).signature) })).toBe(false);
    expect(signed({ ...witnessOf(PRINCIPAL), signature: new Uint8Array(64) })).toBe(false);
  });

  it('is not there when the key has 31 or 33 bytes, or the signature has 63 or 65 bytes', () => {
    const good = witnessOf(PRINCIPAL);
    expect(signed({ ...good, publicKey: good.publicKey.slice(0, 31) })).toBe(false);
    expect(signed({ ...good, publicKey: Uint8Array.from([...good.publicKey, 0]) })).toBe(false);
    expect(signed({ ...good, signature: good.signature.slice(0, 63) })).toBe(false);
    expect(signed({ ...good, signature: Uint8Array.from([...good.signature, 0]) })).toBe(false);
    expect(signed(good)).toBe(true);
  });

  it('is not there when the key has two witnesses, also when the signatures are the same, and a good witness does not cover a bad one', () => {
    const good = witnessOf(PRINCIPAL);
    const bad = { ...good, signature: flipped(good.signature) };
    expect(signed(good, good)).toBe(false);
    expect(signed(good, bad)).toBe(false);
    expect(signed(bad, good)).toBe(false);
    expect(signed(good)).toBe(true);
  });

  it('refuses a key or a signature of the wrong length in the verifier too', () => {
    const good = witnessOf(PRINCIPAL);
    expect(verifies(good.publicKey, good.signature, bodyHash)).toBe(true);
    expect(verifies(good.publicKey.slice(0, 31), good.signature, bodyHash)).toBe(false);
    expect(verifies(good.publicKey, good.signature.slice(0, 63), bodyHash)).toBe(false);
    expect(verifies(good.publicKey, good.signature, Uint8Array.from(bodyHash).reverse())).toBe(false);
  });
});
