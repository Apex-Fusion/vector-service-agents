// packages/id-kit/src/common/keys.ts
// How a caller gives a key to the package: a private key object of node:crypto, or a sign function with its public key. The package reads no key file and no
// environment variable. It never exports a private key. Both forms end as one ResolvedKey: the algorithm, the public JWK, the key hash and one sign function.

import { KeyObject, createPublicKey, sign as nodeSign } from 'node:crypto';
import { jwkThumbprint, publicJwkKey, type JwkKey, type KeyKind, type PublicJwk } from '../vendored/m4/jose.ts';
import { keyHashOf } from './did.ts';

/** The two JWS algorithms of the gateway: EdDSA with Ed25519, and ES256 with P-256. */
export type JwsAlgorithm = 'EdDSA' | 'ES256';

/**
 * A key that signs through a function, for a key that the process cannot hold as an object (a hardware key, a signer service).
 * `sign` returns the 64 bytes of the JWS form: the Ed25519 signature, or ES256 as r then s (32 bytes each). ES256 signs the SHA-256 hash of `data`.
 */
export interface SignerKey {
  readonly algorithm: JwsAlgorithm;
  /** The public half: a public key object, or a public JWK with no private member. */
  readonly publicKey: KeyObject | PublicJwk;
  sign(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/** A key as the caller gives it: a private Ed25519 or P-256 key object, or a SignerKey. */
export type KeyInput = KeyObject | SignerKey;

export interface ResolvedKey {
  readonly algorithm: JwsAlgorithm;
  readonly kind: KeyKind;
  /** The public JWK with the members of RFC 7638 only: `kty`, `crv`, `x` and, for P-256, `y`. */
  readonly jwk: PublicJwk;
  /** The key bytes as a record stores them, in hex: 32 bytes (Ed25519) or the compressed point (P-256). */
  readonly publicKey: string;
  /** The hash of the key, 56 hex characters: the fragment of the DID URL of the key. */
  readonly keyHash: string;
  /** The SHA-256 thumbprint of the public JWK (RFC 7638), in base64url. */
  readonly thumbprint: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

const ALGORITHM_OF: Record<KeyKind, JwsAlgorithm> = { Ed25519: 'EdDSA', P256: 'ES256' };

function publicOf(source: KeyObject | PublicJwk, what: string): JwkKey {
  try {
    if (!(source instanceof KeyObject)) return publicJwkKey(source);
    return publicJwkKey((source.type === 'public' ? source : createPublicKey(source)).export({ format: 'jwk' }));
  } catch (e) {
    throw new TypeError(`${what}: ${e instanceof Error ? e.message : 'the public key is not acceptable'}`);
  }
}

function resolved(pub: JwkKey, sign: ResolvedKey['sign']): ResolvedKey {
  return { algorithm: ALGORITHM_OF[pub.kind], kind: pub.kind, jwk: pub.jwk, publicKey: pub.publicKey, keyHash: keyHashOf(pub.publicKey), thumbprint: jwkThumbprint(pub.jwk), sign };
}

/** Reads the key the caller gave. Throws a TypeError for a public key, for a curve or a key type that the gateway does not accept, and for an algorithm that does not match the key. */
export function resolveKey(input: KeyInput, what = 'the key'): ResolvedKey {
  if (input instanceof KeyObject) {
    if (input.type !== 'private') throw new TypeError(`${what} must be a private key`);
    const pub = publicOf(input, what);
    return resolved(pub, (data) => Promise.resolve(new Uint8Array(pub.kind === 'Ed25519' ? nodeSign(null, data, input) : nodeSign('sha256', data, { key: input, dsaEncoding: 'ieee-p1363' }))));
  }
  if (input === null || typeof input !== 'object' || typeof input.sign !== 'function') throw new TypeError(`${what} must be a private key object or a SignerKey`);
  const pub = publicOf(input.publicKey, what);
  if (input.algorithm !== ALGORITHM_OF[pub.kind]) throw new TypeError(`${what}: the algorithm ${String(input.algorithm)} does not match the ${pub.kind} public key`);
  return resolved(pub, async (data) => {
    const signature = await input.sign(data);
    if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new TypeError(`${what}: the sign function must return the 64 bytes of the JWS form`);
    return signature;
  });
}
