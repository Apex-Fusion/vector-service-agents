// agents/order-desk/test/serve/keys.test.ts
// The keys of the Order Desk as values: what the service key derives to, a key object that signs the request for the X.509-SVID, a signer that never shows the key, and the clash of two keys. The question of the
// slice behind this file: does a key reach a log, a manifest, an answer or a detail? Here: not through the key file of the service.
import { createPublicKey } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { rawHexToBech32 } from '@vsa/buyer-core';
import { blake2b224Hex } from '@vsa/vector-read';
import { keyClashOf, serviceKeyOf } from '../../src/serve/keys.ts';
import { LARGE, MEDIUM, SERVICE, SERVICE_ADDRESS, SMALL, message, shows } from './support.ts';

const runtimes = {
  'lot-small': { pkh: SMALL.pkh, pubKeyHex: SMALL.pubKeyHex },
  'lot-medium': { pkh: MEDIUM.pkh, pubKeyHex: MEDIUM.pubKeyHex },
  'lot-large': { pkh: LARGE.pkh, pubKeyHex: LARGE.pubKeyHex },
};

describe('serviceKeyOf', () => {
  test('gives the key hash and the mainnet address that the key derives to, and an Ed25519 key object for the request for the X.509-SVID', () => {
    const key = serviceKeyOf(SERVICE.privateKeyHex);
    expect([key.pkh, key.address]).toStrictEqual([SERVICE.pkh, SERVICE_ADDRESS]);
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
  const service = { pkh: SERVICE.pkh };

  test('three runtimes with three keys of their own, and a service key beside them, have no clash', () => {
    expect(keyClashOf(service, runtimes)).toBeNull();
  });

  test('the service key as the key of a runtime is a clash, whichever runtime it is', () => {
    for (const lot of ['lot-small', 'lot-medium', 'lot-large'] as const) {
      expect(keyClashOf({ pkh: runtimes[lot].pkh }, runtimes), lot).toStrictEqual({ kind: 'service', lot });
    }
  });

  test('two runtimes with one key hash, or with one public key, are a clash; the later runtime is the second', () => {
    expect(keyClashOf(service, { ...runtimes, 'lot-medium': runtimes['lot-small'] })).toStrictEqual({ kind: 'runtimes', first: 'lot-small', second: 'lot-medium' });
    expect(keyClashOf(service, { ...runtimes, 'lot-large': runtimes['lot-medium'] })).toStrictEqual({ kind: 'runtimes', first: 'lot-medium', second: 'lot-large' });
    expect(keyClashOf(service, { ...runtimes, 'lot-large': { ...runtimes['lot-large'], pubKeyHex: SMALL.pubKeyHex } })).toStrictEqual({ kind: 'runtimes', first: 'lot-small', second: 'lot-large' });
    expect(keyClashOf(service, { ...runtimes, 'lot-large': { ...runtimes['lot-large'], pkh: SMALL.pkh } })).toStrictEqual({ kind: 'runtimes', first: 'lot-small', second: 'lot-large' });
  });

  test('the clash of the service key is reported before the clash of two runtimes', () => {
    expect(keyClashOf({ pkh: SMALL.pkh }, { ...runtimes, 'lot-medium': runtimes['lot-small'] })).toStrictEqual({ kind: 'service', lot: 'lot-small' });
  });
});
