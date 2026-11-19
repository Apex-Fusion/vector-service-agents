// packages/id-kit/test/keys.test.ts: the two ways to give a key to the package (a key object, or a sign function), and what the package refuses.
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import { keyHashOf } from '../src/common/did.ts';
import { resolveKey, type SignerKey } from '../src/common/keys.ts';
import { ed25519Key, p256Key, signerOf } from '../src/testing/index.ts';
import { es256Verifies } from './support.ts';

const DATA = Buffer.from('the data to sign');

describe('resolveKey', () => {
  it('reads a private Ed25519 key object: EdDSA, the public JWK with three members, the key hash of the record, and a signature that verifies', async () => {
    const key = ed25519Key('keys: ed');
    const resolved = resolveKey(key.privateKey);
    expect(resolved.algorithm).toBe('EdDSA');
    expect(resolved.kind).toBe('Ed25519');
    expect(Object.keys(resolved.jwk).sort()).toStrictEqual(['crv', 'kty', 'x']);
    expect(resolved.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(resolved.keyHash).toBe(keyHashOf(resolved.publicKey));
    expect(resolved.keyHash).toMatch(/^[0-9a-f]{56}$/);
    expect(resolved.keyHash).toBe(key.keyHash);
    const signature = await resolved.sign(DATA);
    expect(signature).toHaveLength(64);
    expect(verify(null, DATA, key.publicKey, signature)).toBe(true);
  });

  it('reads a private P-256 key object: ES256, a JWK with four members, the compressed point as the key, and the signature in the form r then s', async () => {
    const key = p256Key('keys: p256');
    const resolved = resolveKey(key.privateKey);
    expect(resolved.algorithm).toBe('ES256');
    expect(resolved.kind).toBe('P256');
    expect(Object.keys(resolved.jwk).sort()).toStrictEqual(['crv', 'kty', 'x', 'y']);
    expect(resolved.publicKey).toMatch(/^0[23][0-9a-f]{64}$/);
    const signature = await resolved.sign(DATA);
    expect(signature).toHaveLength(64);
    expect(es256Verifies(DATA, signature, key.publicKey)).toBe(true);
  });

  it('a sign function gives the same key as the key object: the same JWK, the same key hash and a signature that verifies', async () => {
    for (const key of [ed25519Key('keys: signer ed'), p256Key('keys: signer p256')]) {
      const fromObject = resolveKey(key.privateKey);
      const fromFunction = resolveKey(signerOf(key));
      expect(fromFunction.jwk).toStrictEqual(fromObject.jwk);
      expect(fromFunction.keyHash).toBe(fromObject.keyHash);
      expect(fromFunction.thumbprint).toBe(fromObject.thumbprint);
      expect(await fromFunction.sign(DATA)).toHaveLength(64);
    }
  });

  it('a public key of a SignerKey can be a key object or a JWK', () => {
    const key = ed25519Key('keys: public forms');
    const sign = () => new Uint8Array(64);
    expect(resolveKey({ algorithm: 'EdDSA', publicKey: key.publicKey, sign }).keyHash).toBe(key.keyHash);
    expect(resolveKey({ algorithm: 'EdDSA', publicKey: key.jwk, sign }).keyHash).toBe(key.keyHash);
  });

  it.each<[string, () => unknown, RegExp]>([
    ['a public key object', () => ed25519Key('keys: refused public').publicKey, /must be a private key/],
    ['an RSA key', () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey, /not an Ed25519 \(OKP\) or P-256 \(EC\) public key/],
    ['a P-384 key', () => generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey, /not an Ed25519 \(OKP\) or P-256 \(EC\) public key/],
    ['a value that is not a key', () => 'a text', /must be a private key object or a SignerKey/],
    ['an object with no sign function', () => ({ algorithm: 'EdDSA', publicKey: ed25519Key('keys: no sign').jwk }), /must be a private key object or a SignerKey/],
    ['a SignerKey whose algorithm does not match its key', () => ({ algorithm: 'ES256', publicKey: ed25519Key('keys: mismatch').jwk, sign: () => new Uint8Array(64) }), /does not match the Ed25519 public key/],
    ['a SignerKey with a JWK that holds the private member d', () => ({ algorithm: 'EdDSA', publicKey: { ...ed25519Key('keys: private jwk').jwk, d: 'AAAA' }, sign: () => new Uint8Array(64) }), /private key material/],
  ])('refuses %s with a TypeError', (_name, make, message) => {
    expect(() => resolveKey(make() as never)).toThrow(TypeError);
    expect(() => resolveKey(make() as never)).toThrow(message);
  });

  it('a sign function that returns another length than 64 bytes fails when it signs, and one that returns 64 bytes works', async () => {
    const key = ed25519Key('keys: bad signature length');
    const make = (length: number): SignerKey => ({ algorithm: 'EdDSA', publicKey: key.jwk, sign: () => new Uint8Array(length) });
    await expect(resolveKey(make(63)).sign(DATA)).rejects.toThrow(/64 bytes/);
    await expect(resolveKey(make(65)).sign(DATA)).rejects.toThrow(/64 bytes/);
    await expect(resolveKey(make(64)).sign(DATA)).resolves.toHaveLength(64);
  });

  it('a sign function can be asynchronous', async () => {
    const key = ed25519Key('keys: async');
    const resolved = resolveKey({ algorithm: 'EdDSA', publicKey: key.jwk, sign: async () => new Uint8Array(64) });
    await expect(resolved.sign(DATA)).resolves.toHaveLength(64);
  });
});

describe('test keys', () => {
  it('a key made from a label is the same in each call, a key made without a label is not, and two labels give two keys', () => {
    expect(ed25519Key('same').keyHash).toBe(ed25519Key('same').keyHash);
    expect(p256Key('same').keyHash).toBe(p256Key('same').keyHash);
    expect(ed25519Key('one').keyHash).not.toBe(ed25519Key('two').keyHash);
    expect(p256Key('one').keyHash).not.toBe(p256Key('two').keyHash);
    expect(ed25519Key().keyHash).not.toBe(ed25519Key().keyHash);
    expect(p256Key().keyHash).not.toBe(p256Key().keyHash);
  });
});
