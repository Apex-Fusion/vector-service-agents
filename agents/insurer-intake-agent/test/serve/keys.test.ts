// agents/insurer-intake-agent/test/serve/keys.test.ts
// What the service makes of its one key from the value of the key: the key hash, the address, the public key, the signer and the key object. The object has no member that holds the key as text, and the key leaves it
// through `withKey` only. The service key is not the supplier key, which is the key of the runtime. No test reads a key file or a setting: `keyOf` takes the value.
import { createPublicKey } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, test } from 'vitest';
import { buyerIdentityOf, rawHexToBech32 } from '@vsa/buyer-core';
import { blake2b224Hex } from '@vsa/vector-read';
import { KEY_ROLES, keyClashOf, keyOf } from '../../src/serve/keys.ts';
import type { KeyMaterial, KeyRole } from '../../src/serve/keys.ts';
import { OTHER, SERVICE, SERVICE_ADDRESS, SUPPLIER, message, shows } from './support.ts';

const keys = (hex: string): Record<KeyRole, KeyMaterial> => ({ service: keyOf(hex) });

describe('keyOf', () => {
  test('gives the key hash, the address and the public key that the key derives to, as the buyer code derives them', () => {
    const material = keyOf(SERVICE.privateKeyHex);
    const derived = buyerIdentityOf(SERVICE.privateKeyHex);
    expect([material.pkh, material.address, material.publicKeyHex]).toStrictEqual([SERVICE.pkh, SERVICE_ADDRESS, SERVICE.pubKeyHex]);
    expect([material.pkh, material.address]).toStrictEqual([derived.buyerPkh, derived.address]);
    expect([material.signer.keyHash, material.signer.address]).toStrictEqual([material.pkh, material.address]);
    expect(material.pkh).toMatch(/^[0-9a-f]{56}$/);
    expect(material.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(material.address.startsWith('addr1v')).toBe(true);
  });

  test('gives an Ed25519 key object that signs the request for a JWT-SVID: its public key is the public key of the key hash', () => {
    const { keyObject } = keyOf(SERVICE.privateKeyHex);
    expect([keyObject.type, keyObject.asymmetricKeyType]).toStrictEqual(['private', 'ed25519']);
    const x = createPublicKey(keyObject).export({ format: 'jwk' }).x;
    expect(blake2b224Hex(Buffer.from(String(x), 'base64url').toString('hex'))).toBe(SERVICE.pkh);
  });

  test('keeps the key out of its own members: JSON, inspect and the text of the object show none of its forms, and withKey gives it to the one caller that asks', () => {
    const material = keyOf(SERVICE.privateKeyHex);
    const bech32 = rawHexToBech32(SERVICE.privateKeyHex);
    for (const text of [JSON.stringify(material), inspect(material, { depth: 6, showHidden: true }), String(material), JSON.stringify(Object.entries(material)), String(material.keyObject)]) {
      expect(text.toLowerCase()).not.toContain(SERVICE.privateKeyHex);
      expect(text.toLowerCase()).not.toContain(bech32);
    }
    expect(Object.values(material).every((value) => typeof value !== 'string' || (value !== SERVICE.privateKeyHex && value !== bech32))).toBe(true);
    expect(material.withKey((key) => key)).toBe(SERVICE.privateKeyHex);
    expect(material.withKey((key) => key.length)).toBe(64);
  });

  test('refuses a transaction that is not a transaction, and the refusal shows no key', () => {
    const text = message(() => keyOf(SERVICE.privateKeyHex).signUnsigned('00'));
    expect(text).toMatch(/^Transaction could not be decoded/);
    expect(shows(text, SERVICE.privateKeyHex)).toBe(false);
    expect(text.toLowerCase()).not.toContain(rawHexToBech32(SERVICE.privateKeyHex));
  });

  test('refuses a value that is no key without repeating it, and takes the twin: 64 lower-case hex characters', () => {
    for (const bad of ['', 'zz'.repeat(32), SERVICE.privateKeyHex.slice(2), `${SERVICE.privateKeyHex}00`, SERVICE.privateKeyHex.toUpperCase(), `0x${SERVICE.privateKeyHex}`, ` ${SERVICE.privateKeyHex}`]) {
      const text = message(() => keyOf(bad));
      expect(shows(text, bad), JSON.stringify(bad.slice(0, 8))).toBe(false);
    }
    expect(() => keyOf(OTHER.privateKeyHex)).not.toThrow();
  });
});

describe('keyClashOf', () => {
  test('the service has one key, with the role service', () => {
    expect(KEY_ROLES).toStrictEqual(['service']);
  });

  test('finds no clash when the service key and the supplier key are two keys', () => {
    expect(keyClashOf(keys(SERVICE.privateKeyHex), SUPPLIER.pkh)).toBeNull();
    expect(keyClashOf(keys(OTHER.privateKeyHex), SUPPLIER.pkh)).toBeNull();
  });

  test('finds the service key that is the supplier key: the supplier key is the key of the runtime, and a service that held it could sign as the runtime', () => {
    expect(keyClashOf(keys(SERVICE.privateKeyHex), SERVICE.pkh)).toStrictEqual({ kind: 'supplier', role: 'service' });
    // A key hash in capitals is the same key hash.
    expect(keyClashOf(keys(SERVICE.privateKeyHex), SERVICE.pkh.toUpperCase())).toStrictEqual({ kind: 'supplier', role: 'service' });
  });

  test('takes the key hash alone, as the manifest builder gives it: a key hash is a key hash, with the key or without it', () => {
    expect(keyClashOf({ service: { pkh: SUPPLIER.pkh } }, SUPPLIER.pkh)).toStrictEqual({ kind: 'supplier', role: 'service' });
    expect(keyClashOf({ service: { pkh: SUPPLIER.pkh.toUpperCase() } }, SUPPLIER.pkh)).toStrictEqual({ kind: 'supplier', role: 'service' });
    expect(keyClashOf({ service: { pkh: SERVICE.pkh } }, SUPPLIER.pkh)).toBeNull();
  });
});
