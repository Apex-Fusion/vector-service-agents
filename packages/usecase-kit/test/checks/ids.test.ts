// packages/usecase-kit/test/checks/ids.test.ts: the form of a hex member, and the hash of a key. A member is read only in the form of its kind: lower-case hex characters, and the exact length.
// `Buffer.from(text, 'hex')` stops at the first character that is not hex. So a text that only starts like a key must never read as the key.
import { describe, expect, it } from 'vitest';
import { KEY_BYTES, KEY_HASH_BYTES, isHex, keyHashOf } from '../../src/checks/ids.ts';
import { ISSUER_KEY, leavingForm } from './support.ts';

describe('isHex', () => {
  it('accepts a text of lower-case hex characters that has exactly the length of its kind', () => {
    expect(isHex('00ff', 2)).toBe(true);
    expect(isHex('0123456789abcdef', 8)).toBe(true);
    expect(isHex(ISSUER_KEY.publicKey, KEY_BYTES)).toBe(true);
    expect(isHex(ISSUER_KEY.keyHash, KEY_HASH_BYTES)).toBe(true);
  });

  it('refuses a text in upper case, a text with another character, and a text of another length', () => {
    for (const text of leavingForm(ISSUER_KEY.publicKey)) expect(isHex(text, KEY_BYTES), text).toBe(false);
    for (const text of leavingForm(ISSUER_KEY.keyHash)) expect(isHex(text, KEY_HASH_BYTES), text).toBe(false);
    // The length is the length of the kind: a key is not a key hash, and the other way round.
    expect(isHex(ISSUER_KEY.publicKey, KEY_HASH_BYTES)).toBe(false);
    expect(isHex(ISSUER_KEY.keyHash, KEY_BYTES)).toBe(false);
  });

  it('refuses a value that is not a text, also when it holds the same bytes', () => {
    for (const value of [undefined, null, 7, true, {}, ['ab'], Buffer.from('ab', 'hex'), new Uint8Array([0xab])]) expect(isHex(value, 1)).toBe(false);
    expect(isHex('ab', 1)).toBe(true);
  });
});

describe('keyHashOf', () => {
  it('gives the hash of a key as the registry holds it', () => {
    expect(keyHashOf(ISSUER_KEY.publicKey)).toBe(ISSUER_KEY.keyHash);
  });

  it('refuses a text that is not a key in lower-case hex: a key with more characters after it is not read as the key', () => {
    for (const text of leavingForm(ISSUER_KEY.publicKey)) expect(() => keyHashOf(text), text).toThrow(TypeError);
    // The error has a fixed text: it never repeats the text that it refused.
    expect(() => keyHashOf(`${ISSUER_KEY.publicKey}zz`)).toThrowError(new TypeError('a public key is 64 lower-case hex characters'));
  });
});
