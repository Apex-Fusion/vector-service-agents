// agents/reorder-agent/test/serve/keys.test.ts
// What the service makes of a key from its value: the key hash, the address, the public key, the signers and the key object. The object has no member that holds the key as text, and the key leaves it through
// `withKey` only. The five keys of the service are five keys: two that are one, and one that is the supplier key, are found.
import { createPublicKey, verify } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, test } from 'vitest';
import { buyerIdentityOf } from '@vsa/buyer-core';
import { KEY_ROLES, keyClashOf, keyOf } from '../../src/serve/keys.ts';
import type { KeyMaterial, KeyRole } from '../../src/serve/keys.ts';
import { KEY_NUMBERS, SUPPLIER, rawKey } from './support.ts';
import { testKey } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';

const keys = (over: Partial<Record<KeyRole, number>> = {}): Record<KeyRole, KeyMaterial> =>
  Object.fromEntries(KEY_ROLES.map((role) => [role, keyOf(rawKey(over[role] ?? KEY_NUMBERS[role]))])) as Record<KeyRole, KeyMaterial>;

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

  test('refuses a value that is no key with a TypeError that never repeats it', () => {
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

describe('keyClashOf', () => {
  test('finds none when the five keys and the supplier key are six keys', () => {
    expect(keyClashOf(keys(), SUPPLIER.keyHash)).toBeNull();
  });

  test('finds two keys that are one key, for each pair, and names the two roles in the order of the roles', () => {
    for (const [index, first] of KEY_ROLES.entries()) {
      for (const second of KEY_ROLES.slice(index + 1)) {
        expect(keyClashOf(keys({ [second]: KEY_NUMBERS[first] }), SUPPLIER.keyHash)).toStrictEqual({ kind: 'equal', first, second });
      }
    }
  });

  test('finds a key that is the supplier key, for each role', () => {
    for (const role of KEY_ROLES) {
      expect(keyClashOf(keys({ [role]: 23 }), SUPPLIER.keyHash)).toStrictEqual({ kind: 'supplier', role });
    }
  });
});
