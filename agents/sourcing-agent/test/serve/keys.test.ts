// agents/sourcing-agent/test/serve/keys.test.ts
// What the service makes of a key from its value: the key hash, the address, the public key, the signers and the key object. The object has no member that holds the key as text, and the key leaves it through
// `withKey` only. The nine keys of the service are nine keys: two that are one, and one that is the supplier key, are found, for every pair and for every role.
import { createPublicKey, verify } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, test } from 'vitest';
import { buyerIdentityOf } from '@vsa/buyer-core';
import { blake2b224Hex } from '@vsa/vector-read';
import { KEY_ROLES, keyClashOf, keyOf } from '../../src/serve/keys.ts';
import type { KeyMaterial, KeyRole } from '../../src/serve/keys.ts';
import { KEY_NUMBERS, KEY_VARIABLES, SUPPLIER, rawKey } from './support.ts';
import { testKey } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';

const keys = (over: Partial<Record<KeyRole, number>> = {}): Record<KeyRole, KeyMaterial> =>
  Object.fromEntries(KEY_ROLES.map((role) => [role, keyOf(rawKey(over[role] ?? KEY_NUMBERS[role]))])) as Record<KeyRole, KeyMaterial>;

describe('the roles of the nine keys', () => {
  test('are the service key, the two delegation keys, and the authentication key and the delegation key of each of the three scorers, in this order', () => {
    expect(KEY_ROLES).toStrictEqual([
      'service', 'delegation1', 'delegation2', 'scorer1Authentication', 'scorer1Delegation', 'scorer2Authentication', 'scorer2Delegation', 'scorer3Authentication', 'scorer3Delegation',
    ]);
    expect(new Set(KEY_ROLES).size).toBe(9);
    expect(Object.keys(KEY_VARIABLES)).toStrictEqual([...KEY_ROLES]);
  });
});

describe('keyOf', () => {
  test('gives the key hash, the address and the public key of the key, as the buyer code and the fixture world derive them', () => {
    const material = keyOf(rawKey(24));
    const derived = buyerIdentityOf(rawKey(24));
    expect(material.pkh).toBe(derived.buyerPkh);
    expect(material.address).toBe(derived.address);
    expect(material.signer.keyHash).toBe(material.pkh);
    expect(material.signer.address).toBe(material.address);
    expect(material.publicKeyHex).toBe(testKey(24).publicKey);
    expect(material.pkh).toBe(testKey(24).keyHash);
    expect(material.pkh).toMatch(/^[0-9a-f]{56}$/);
    expect(material.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(material.address).toMatch(/^addr1/);
  });

  test('gives a key hash that is the hash of its own public key, so the two cannot come apart', () => {
    for (const role of KEY_ROLES) {
      const material = keyOf(rawKey(KEY_NUMBERS[role]));
      expect(blake2b224Hex(material.publicKeyHex)).toBe(material.pkh);
    }
  });

  test('signs a body hash with the key: the signature verifies under the public key, and under no other', () => {
    const material = keyOf(rawKey(21));
    const hash = Uint8Array.from({ length: 32 }, (_, index) => index);
    const signature = material.signBodyHash(hash);
    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature).toHaveLength(64);
    const publicKey = (hex: string) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(hash), publicKey(material.publicKeyHex), Buffer.from(signature))).toBe(true);
    expect(verify(null, Buffer.from(hash), publicKey(keyOf(rawKey(22)).publicKeyHex), Buffer.from(signature))).toBe(false);
    expect(verify(null, Buffer.from(Uint8Array.from({ length: 32 }, () => 7)), publicKey(material.publicKeyHex), Buffer.from(signature))).toBe(false);
  });

  test('keeps the key out of its own members: JSON, inspect and the text of the object show none of it, and withKey gives it to the one caller that asks', () => {
    const hex = rawKey(31);
    const material = keyOf(hex);
    for (const text of [JSON.stringify(material), inspect(material, { depth: 6, showHidden: true }), String(material), JSON.stringify(Object.entries(material))]) {
      expect(text.toLowerCase()).not.toContain(hex);
    }
    expect(Object.values(material).every((value) => typeof value !== 'string' || value !== hex)).toBe(true);
    expect(material.withKey((key) => key)).toBe(hex);
    expect(material.withKey((key) => key.length)).toBe(64);
  });

  test('refuses a value that is no key with an Error that never repeats it', () => {
    for (const bad of ['', 'zz'.repeat(32), 'ab'.repeat(31), 'AB'.repeat(32), 'ab'.repeat(33)]) {
      let thrown: unknown;
      try {
        keyOf(bad);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).not.toContain(bad === '' ? '\u0000' : bad);
    }
    expect(() => keyOf(rawKey(5))).not.toThrow();
  });
});

describe('the nine keys', () => {
  test('give nine key hashes, nine public keys and nine addresses, and each is the key of its number', () => {
    const material = keys();
    expect(new Set(KEY_ROLES.map((role) => material[role].pkh)).size).toBe(9);
    expect(new Set(KEY_ROLES.map((role) => material[role].publicKeyHex)).size).toBe(9);
    expect(new Set(KEY_ROLES.map((role) => material[role].address)).size).toBe(9);
    for (const role of KEY_ROLES) {
      expect(material[role].pkh).toBe(testKey(KEY_NUMBERS[role]).keyHash);
      expect(material[role].pkh).not.toBe(SUPPLIER.keyHash);
    }
  });
});

describe('keyClashOf', () => {
  test('finds none when the nine keys and the supplier key are ten keys', () => {
    expect(keyClashOf(keys(), SUPPLIER.keyHash)).toBeNull();
  });

  test('finds two keys that are one key, for each of the 36 pairs, and names the two roles in the order of the roles', () => {
    let pairs = 0;
    for (const [index, first] of KEY_ROLES.entries()) {
      for (const second of KEY_ROLES.slice(index + 1)) {
        expect(keyClashOf(keys({ [second]: KEY_NUMBERS[first] }), SUPPLIER.keyHash)).toStrictEqual({ kind: 'equal', first, second });
        pairs += 1;
      }
    }
    expect(pairs).toBe(36);
  });

  test('finds a key that is the supplier key, for each of the nine roles, and names the role', () => {
    for (const role of KEY_ROLES) {
      expect(keyClashOf(keys({ [role]: 23 }), SUPPLIER.keyHash)).toStrictEqual({ kind: 'supplier', role });
    }
  });

  test('names a clash between two keys before a clash with the supplier key, when both are there', () => {
    expect(keyClashOf(keys({ delegation2: 21, scorer3Delegation: 23 }), SUPPLIER.keyHash)).toStrictEqual({ kind: 'equal', first: 'delegation1', second: 'delegation2' });
  });
});
