// packages/id-kit/src/testing/keys.ts
// Keys that a test makes. A key made from a label is the same in every run, so a failure repeats and no key is written in the repository. A key made without a label is random.
// None of these keys signs anything outside a test.

import { KeyObject, createECDH, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { resolveKey, type ResolvedKey, type SignerKey } from '../common/keys.ts';
import type { KeyKind, PublicJwk } from '../vendored/m4/jose.ts';

export interface TestKey {
  readonly kind: KeyKind;
  /** Give this to the client as a key. */
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly jwk: PublicJwk;
  /** The key bytes as a record stores them, in hex. */
  readonly publicKeyHex: string;
  /** The hash of the key, 56 hex characters. */
  readonly keyHash: string;
  readonly thumbprint: string;
}

/** The order of the P-256 group: a private scalar is a number from 1 up to this number, not included. */
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function wrap(privateKey: KeyObject, kind: KeyKind): TestKey {
  const resolved: ResolvedKey = resolveKey(privateKey);
  return { kind, privateKey, publicKey: createPublicKey(privateKey), jwk: resolved.jwk, publicKeyHex: resolved.publicKey, keyHash: resolved.keyHash, thumbprint: resolved.thumbprint };
}

function seedOf(label: string): Buffer {
  return createHash('sha256').update(`id-kit test key: ${label}`).digest();
}

/** An Ed25519 key. With a label, the same key in each run. */
export function ed25519Key(label?: string): TestKey {
  if (label === undefined) return wrap(generateKeyPairSync('ed25519').privateKey, 'Ed25519');
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seedOf(label)]);
  return wrap(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }), 'Ed25519');
}

/** A P-256 key. With a label, the same key in each run. */
export function p256Key(label?: string): TestKey {
  if (label === undefined) return wrap(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, 'P256');
  let scalar = seedOf(label);
  // A hash is below the order of the group with a probability of nearly 1. Hash again for the rare case that it is not.
  while (BigInt(`0x${scalar.toString('hex')}`) === 0n || BigInt(`0x${scalar.toString('hex')}`) >= P256_ORDER) scalar = createHash('sha256').update(scalar).digest();
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(scalar);
  const point = ecdh.getPublicKey();
  const jwk = { kty: 'EC', crv: 'P-256', d: scalar.toString('base64url'), x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') };
  return wrap(createPrivateKey({ key: jwk, format: 'jwk' }), 'P256');
}

/** The same key as a sign function, to test the path of a caller that holds no key object. */
export function signerOf(key: TestKey): SignerKey {
  const resolved = resolveKey(key.privateKey);
  return { algorithm: resolved.algorithm, publicKey: key.jwk, sign: (data) => resolved.sign(data) };
}

/** A random identifier of 64 lowercase hex characters, or the same one in each run for the same label. */
export function identifier(label?: string): string {
  return label === undefined ? randomBytes(32).toString('hex') : createHash('sha256').update(`id-kit test identifier: ${label}`).digest('hex');
}
