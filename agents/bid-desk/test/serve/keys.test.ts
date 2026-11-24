// agents/bid-desk/test/serve/keys.test.ts
// The key of the Bid Desk as a value: what the service key derives to, a key object, a signer that never shows the key, and the clash of the service key with the supplier key. The question behind this file:
// does a key reach a log, a manifest, an answer or a detail? Here: not through the key file of the service.
import { createPublicKey } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { rawHexToBech32 } from '@vsa/buyer-core';
import { blake2b224Hex } from '@vsa/vector-read';
import { keyClashOf, serviceKeyOf } from '../../src/serve/keys.ts';
import { supplierKeyOf } from '../../src/serve/settings.ts';
import { FULL_ENV, SERVICE, SERVICE_ADDRESS, SUPPLIER, message, shows } from './support.ts';

describe('serviceKeyOf', () => {
  test('gives the key hash and the mainnet address that the key derives to, and an Ed25519 key object', () => {
    const key = serviceKeyOf(SERVICE.privateKeyHex);
    expect([key.pkh, key.address]).toStrictEqual([SERVICE.pkh, SERVICE_ADDRESS]);
    expect(SERVICE_ADDRESS.startsWith('addr1v')).toBe(true);
    expect([key.authentication.type, key.authentication.asymmetricKeyType]).toStrictEqual(['private', 'ed25519']);
    const x = createPublicKey(key.authentication).export({ format: 'jwk' }).x;
    expect(blake2b224Hex(Buffer.from(String(x), 'base64url').toString('hex'))).toBe(SERVICE.pkh);
  });

  test('shows the key in no member and in no text of its own: a log of the object, its JSON and its inspection hold none of the two forms', () => {
    const key = serviceKeyOf(SERVICE.privateKeyHex);
    for (const text of [JSON.stringify(key), String(key.authentication), JSON.stringify(Object.keys(key))]) {
      expect(text.toLowerCase()).not.toContain(SERVICE.privateKeyHex);
      expect(text.toLowerCase()).not.toContain(rawHexToBech32(SERVICE.privateKeyHex));
    }
  });

  test('refuses a key of another form without repeating it', () => {
    for (const bad of ['zz', SERVICE.privateKeyHex.toUpperCase(), SERVICE.privateKeyHex.slice(2), `${SERVICE.privateKeyHex}00`]) {
      const text = message(() => serviceKeyOf(bad));
      expect(shows(text, bad.length > 16 ? bad : 'not a key at all'), bad).toBe(false);
    }
  });

  test('a transaction that is not a transaction is refused by the signer, and the refusal shows no key', () => {
    const key = serviceKeyOf(SERVICE.privateKeyHex);
    const text = message(() => key.sign('00'));
    expect(text).toMatch(/^Transaction could not be decoded/);
    expect(shows(text, SERVICE.privateKeyHex)).toBe(false);
    expect(text.toLowerCase()).not.toContain(rawHexToBech32(SERVICE.privateKeyHex));
  });
});

describe('keyClashOf', () => {
  const supplier = supplierKeyOf(FULL_ENV);

  test('a service key beside a supplier key of its own is no clash', () => {
    expect(keyClashOf(serviceKeyOf(SERVICE.privateKeyHex), supplier)).toBe(false);
    expect(keyClashOf({ pkh: SERVICE.pkh }, supplier)).toBe(false);
  });

  test('the service key as the supplier key is a clash: a service key made from the key of the supplier has the key hash of the supplier', () => {
    expect(keyClashOf(serviceKeyOf(SUPPLIER.privateKeyHex), supplier)).toBe(true);
    expect(keyClashOf({ pkh: SUPPLIER.pkh }, supplier)).toBe(true);
  });

  test('the key hash decides, and a service key that differs by one character from the supplier key hash is no clash', () => {
    const near = `${SUPPLIER.pkh.slice(0, -1)}${SUPPLIER.pkh.endsWith('0') ? '1' : '0'}`;
    expect(keyClashOf({ pkh: near }, supplier)).toBe(false);
    expect(keyClashOf({ pkh: SUPPLIER.pkh }, { pkh: SUPPLIER.pkh, pubKeyHex: SERVICE.pubKeyHex })).toBe(true);
  });

  test('the two key hashes are compared in lower case: a hash in capitals is the same key, on either side', () => {
    expect(keyClashOf({ pkh: SUPPLIER.pkh.toUpperCase() }, supplier)).toBe(true);
    expect(keyClashOf({ pkh: SUPPLIER.pkh }, { pkh: SUPPLIER.pkh.toUpperCase(), pubKeyHex: SUPPLIER.pubKeyHex })).toBe(true);
    expect(keyClashOf({ pkh: SERVICE.pkh.toUpperCase() }, supplier)).toBe(false);
  });
});
