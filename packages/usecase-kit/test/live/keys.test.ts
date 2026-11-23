// packages/usecase-kit/test/live/keys.test.ts: the key object of a raw Ed25519 key. It has the public key and the signatures of the vectors of RFC 8032, its key hash is the one that the buyer code gives for the same
// text, and the identity kit takes it as a key. A text that is not 64 lower-case hex characters, and a value that is not text, is a TypeError whose message never repeats the value. No way of showing the object shows the key.
import { createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { format, inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buyerIdentityOf } from '@vsa/buyer-core';
import { keyHashOf, resolveKey } from '@vsa/id-kit';
import { keyObjectOfRawKey } from '../../src/live/index.ts';

/** The first three test vectors of RFC 8032, section 7.1: a secret key, its public key, a message (hex) and the signature of that message. */
const VECTORS = [
  {
    secret: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    message: '',
    signature: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  },
  {
    secret: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    publicKey: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    message: '72',
    signature: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  },
  {
    secret: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
    publicKey: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    message: 'af82',
    signature: '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
  },
] as const;
const GOOD = VECTORS[0].secret;

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** The public key object of the 32 bytes of a public key, made with no help of the code under test. */
const publicKeyOf = (publicKeyHex: string): KeyObject => createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
/** The 32 bytes of the public key of a private key object, in hex. */
const publicHexOf = (key: KeyObject): string => Buffer.from(String(createPublicKey(key).export({ format: 'jwk' }).x), 'base64url').toString('hex');

/** The error that a call throws. A call that does not throw is a failure of the test. */
function refusal(value: unknown): Error {
  try {
    keyObjectOfRawKey(value as string);
  } catch (error) {
    return error as Error;
  }
  throw new Error('the key object was made');
}

/** True when the message holds a piece of 8 characters of the text. */
function repeats(message: string, text: string): boolean {
  for (let at = 0; at + 8 <= text.length; at += 1) if (message.includes(text.slice(at, at + 8))) return true;
  return false;
}

describe('keyObjectOfRawKey', () => {
  it.each(VECTORS)('is the private Ed25519 key of the vector with the public key $publicKey', (vector) => {
    const key = keyObjectOfRawKey(vector.secret);
    expect(key.type).toBe('private');
    expect(key.asymmetricKeyType).toBe('ed25519');
    expect(publicHexOf(key)).toBe(vector.publicKey);
  });

  it.each(VECTORS)('signs the message of the vector with the signature of the vector, and the public key of the vector verifies it', (vector) => {
    const message = Buffer.from(vector.message, 'hex');
    const signature = sign(null, message, keyObjectOfRawKey(vector.secret));
    expect(signature.toString('hex')).toBe(vector.signature);
    expect(verify(null, message, publicKeyOf(vector.publicKey), signature)).toBe(true);
    // The twins: the signature does not verify another message, and it does not verify under another key.
    expect(verify(null, Buffer.concat([message, Buffer.from([1])]), publicKeyOf(vector.publicKey), signature)).toBe(false);
    const other = VECTORS.find((candidate) => candidate.publicKey !== vector.publicKey)!;
    expect(verify(null, message, publicKeyOf(other.publicKey), signature)).toBe(false);
  });

  it.each(VECTORS)('has the key hash that the buyer code gives for the same text', (vector) => {
    expect(keyHashOf(publicHexOf(keyObjectOfRawKey(vector.secret)))).toBe(buyerIdentityOf(vector.secret).buyerPkh);
  });

  it('is a key of the identity kit: it resolves to the public key and the key hash of its text, and it signs as the vector says', async () => {
    const vector = VECTORS[0];
    const resolved = resolveKey(keyObjectOfRawKey(vector.secret));
    expect(resolved).toMatchObject({ kind: 'Ed25519', algorithm: 'EdDSA', publicKey: vector.publicKey, keyHash: buyerIdentityOf(vector.secret).buyerPkh });
    expect(Buffer.from(await resolved.sign(Buffer.alloc(0))).toString('hex')).toBe(vector.signature);
  });

  it('makes the same key for the same text and another key for another text', () => {
    expect(publicHexOf(keyObjectOfRawKey(GOOD))).toBe(publicHexOf(keyObjectOfRawKey(GOOD)));
    expect(publicHexOf(keyObjectOfRawKey(VECTORS[1].secret))).not.toBe(publicHexOf(keyObjectOfRawKey(GOOD)));
  });

  it.each([['00'.repeat(32)], ['ff'.repeat(32)]])('takes every text of 64 lower-case hex characters, also %s', (text) => {
    expect(keyObjectOfRawKey(text).asymmetricKeyType).toBe('ed25519');
  });
});

describe('keyObjectOfRawKey: a text that is not a key', () => {
  const TEXTS: ReadonlyArray<readonly [string, string]> = [
    ['a text of 63 characters', GOOD.slice(0, 63)],
    ['a text of 65 characters', `${GOOD}0`],
    ['a text of 128 characters', GOOD + GOOD],
    ['an empty text', ''],
    ['an upper-case text', GOOD.toUpperCase()],
    ['a text with one upper-case character', `${GOOD[0]}D${GOOD.slice(2)}`],
    ['a text with a 0x prefix', `0x${GOOD}`],
    ['a text of 64 characters that starts with 0x', `0x${GOOD.slice(2)}`],
    ['a text with a character that is not hex', `${GOOD.slice(0, 63)}g`],
    ['a text with a new line at the end', `${GOOD}\n`],
    ['a text with a space at the start', ` ${GOOD}`],
    ['a text with a space inside', `${GOOD.slice(0, 32)} ${GOOD.slice(33)}`],
  ];

  it.each(TEXTS)('refuses %s with a TypeError that does not repeat it', (_name, text) => {
    const error = refusal(text);
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message.length).toBeGreaterThan(0);
    expect(repeats(error.message, text)).toBe(false);
    expect(error.cause).toBeUndefined();
  });

  const VALUES: ReadonlyArray<readonly [string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a big integer', 42n],
    ['true', true],
    ['an object', {}],
    ['a list', [GOOD]],
    ['the bytes of a key', Buffer.from(GOOD, 'hex')],
    ['a list of 32 bytes', new Uint8Array(32)],
    ['an object whose text is a good key', { toString: () => GOOD }],
    ['a String object that holds a good key', new String(GOOD)],
    ['a symbol', Symbol('key')],
    ['a function', () => GOOD],
  ];

  it.each(VALUES)('refuses %s, which is not text, with a TypeError that does not repeat it', (_name, value) => {
    const error = refusal(value);
    expect(error).toBeInstanceOf(TypeError);
    expect(repeats(error.message, GOOD)).toBe(false);
    expect(error.cause).toBeUndefined();
  });

  it('takes the good text after each refusal: the twin', () => {
    for (const [, text] of TEXTS) refusal(text);
    expect(publicHexOf(keyObjectOfRawKey(GOOD))).toBe(VECTORS[0].publicKey);
  });
});

describe('the key object does not show the key', () => {
  const bytes = Buffer.from(GOOD, 'hex');
  const pieces = [GOOD, GOOD.toUpperCase(), bytes.toString('base64'), bytes.toString('base64url'), [...bytes].join(',')];
  const key = keyObjectOfRawKey(GOOD);

  it('is shown by inspect, JSON.stringify, String, a template and format with no part of the key', () => {
    const shown = [
      inspect(key),
      inspect(key, { showHidden: true, depth: 10 }),
      inspect({ key }, { depth: 10 }),
      JSON.stringify(key),
      JSON.stringify({ key }),
      String(key),
      `${key}`,
      Object.prototype.toString.call(key),
      format('%s|%j|%o|%O', key, key, key, key),
    ];
    for (const text of shown) for (const piece of pieces) expect(text).not.toContain(piece);
  });

  it('has no own member that a program reads by name, and it holds the key only inside node:crypto', () => {
    expect(Object.keys(key)).toStrictEqual([]);
    expect(JSON.stringify(key)).toBe('{}');
  });

  it('exports the key only when a caller asks: the export that it gives is the key', () => {
    const der = key.export({ format: 'der', type: 'pkcs8' });
    expect(Buffer.from(der).subarray(-32).equals(bytes)).toBe(true);
  });
});
