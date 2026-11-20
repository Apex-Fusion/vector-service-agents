// packages/usecase-kit/test/cosign/witness.test.ts
// The check of the witness of the delegator, on its own: one witness of the key, a key of 32 bytes, a signature of 64 bytes, and a signature that verifies over the hash of the body. Each refusal has its
// twin, the one witness that is right.
import { createHash } from 'node:crypto';
import { CML } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';
import { describe, expect, it } from 'vitest';
import { SMALL_ORDER_ENCODINGS, delegatorSigned, hasSmallOrder, verifies } from '../../src/cosign/witness.ts';
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

// The group order, the identity point and the base point of Ed25519, in the encodings of the ledger.
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const IDENTITY = Uint8Array.from(Buffer.from(`01${'00'.repeat(31)}`, 'hex'));
const BASE_POINT = Uint8Array.from(Buffer.from(`58${'66'.repeat(31)}`, 'hex'));

const littleEndian = (bytes: Uint8Array): bigint => bytes.reduceRight((n, byte) => (n << 8n) + BigInt(byte), 0n);
const scalarBytes = (n: bigint): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const sha512 = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(createHash('sha512').update(Buffer.concat(parts)).digest());
const publicKeyOf = (key: TestKey): Uint8Array => Uint8Array.from(Buffer.from(key.publicKey, 'hex'));
/** The check of the library alone, with no rule about a small order. */
const libraryVerifies = (publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean =>
  CML.PublicKey.from_bytes(publicKey).verify(message, CML.Ed25519Signature.from_raw_bytes(signature));

/** The secret scalar of a test key: the first half of the SHA-512 of its seed, clamped. */
function scalarOf(key: TestKey): bigint {
  const half = sha512(Buffer.alloc(32, key.n)).subarray(0, 32);
  half[0]! &= 248;
  half[31]! &= 127;
  half[31]! |= 64;
  return littleEndian(half);
}

/** A signature of `key` over `message` whose R is the identity point: S = h·a, so that S·B = h·A, and the equation holds. */
function identityR(key: TestKey, message: Uint8Array): Uint8Array {
  const h = littleEndian(sha512(IDENTITY, publicKeyOf(key), message)) % L;
  return Uint8Array.from([...IDENTITY, ...scalarBytes((h * scalarOf(key)) % L)]);
}

describe('a key or an R of small order never verifies', () => {
  const one = scalarBytes(1n);
  const zero = scalarBytes(0n);

  it('refuses the identity point as the key with R = the identity point and S = 0, and with R = the base point and S = 1, which the library alone accepts', () => {
    for (const signature of [Uint8Array.from([...IDENTITY, ...zero]), Uint8Array.from([...BASE_POINT, ...one])]) {
      for (const message of [bodyHash, Uint8Array.from(bodyHash).reverse()]) {
        expect(libraryVerifies(IDENTITY, signature, message)).toBe(true);
        expect(verifies(IDENTITY, signature, message)).toBe(false);
      }
    }
  });

  it('refuses a signature whose R is the identity point for a key that the signer holds, which the library alone accepts; the signature that the key makes verifies', () => {
    const signature = identityR(PRINCIPAL, bodyHash);
    expect(libraryVerifies(publicKeyOf(PRINCIPAL), signature, bodyHash)).toBe(true);
    expect(verifies(publicKeyOf(PRINCIPAL), signature, bodyHash)).toBe(false);
    expect(verifies(publicKeyOf(PRINCIPAL), witnessOf(PRINCIPAL).signature, bodyHash)).toBe(true);
  });

  it.each(SMALL_ORDER_ENCODINGS)('finds a small order in %s with and without the sign bit, as a key and as R', (hex) => {
    const point = Uint8Array.from(Buffer.from(hex, 'hex'));
    const signed = Uint8Array.from(point, (byte, i) => (i === 31 ? byte | 0x80 : byte));
    expect([hasSmallOrder(point), hasSmallOrder(signed)]).toStrictEqual([true, true]);
    const good = witnessOf(PRINCIPAL);
    expect(verifies(point, good.signature, bodyHash)).toBe(false);
    expect(verifies(good.publicKey, Uint8Array.from([...point, ...good.signature.subarray(32)]), bodyHash)).toBe(false);
  });

  it('finds no small order in the keys and the R of real signatures', () => {
    for (const key of [PRINCIPAL, STRANGER, DELEG_A]) {
      const good = witnessOf(key);
      expect([hasSmallOrder(good.publicKey), hasSmallOrder(good.signature.subarray(0, 32))]).toStrictEqual([false, false]);
    }
  });

  it('does not take the witness of a key of small order as the witness of the delegator whose hash it has', () => {
    const keyHash = Buffer.from(blake2b(IDENTITY, { dkLen: 28 })).toString('hex');
    const witness = { keyHash, publicKey: IDENTITY, signature: Uint8Array.from([...BASE_POINT, ...one]) };
    expect(delegatorSigned({ witnesses: [witness], bodyHash }, keyHash)).toBe(false);
  });
});
