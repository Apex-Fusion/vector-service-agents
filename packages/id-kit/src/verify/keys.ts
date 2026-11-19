// packages/id-kit/src/verify/keys.ts
// The keys that the gateway signs with, as a verifier holds them: the key set of GET /.well-known/jwks.json, and the JWT-SVID keys of the SPIFFE bundle. A key set maps `kid` to a
// public key. `verifyGatewayJws` checks one compact JWS against a key set, as every token, list and credential of the gateway is signed: ES256 by its P-256 key.

import type { KeyObject } from 'node:crypto';
import { isRecord } from '../common/json.ts';
import { accept, refuse, type Check } from '../common/result.ts';
import { JoseError, has, parseJws, publicJwkKey, verifyJws, type Jws, type KeyKind, type PublicJwk } from '../vendored/m4/jose.ts';

export interface GatewayKey {
  readonly kid: string;
  readonly kind: KeyKind;
  readonly key: KeyObject;
  readonly jwk: PublicJwk;
}

/** The public keys of the gateway by `kid`. */
export type KeySet = ReadonlyMap<string, GatewayKey>;

export const KEY_SET_RULES = ['jwks.malformed', 'jwks.private_key', 'jwks.no_usable_key'] as const;
export type KeySetRule = (typeof KEY_SET_RULES)[number];

/** The members of a JWK that hold private key material (RFC 7517, RFC 7518 Section 6). A key set that has one is refused. */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];

const algOf = (kind: KeyKind): string => (kind === 'Ed25519' ? 'EdDSA' : 'ES256');

/**
 * Reads a JWK set (RFC 7517 Section 5). A key of another type (not Ed25519, not P-256), a key for another use than signing, a key with no `kid`, and a key whose `alg` is not the
 * one of its type are left out. A set that holds private key material, or two keys with one `kid`, or no usable key, is refused.
 */
export function parseKeySet(value: unknown, use: 'sig' | null = 'sig'): Check<KeySet, KeySetRule> {
  const list = isRecord(value) ? value.keys : undefined;
  if (!Array.isArray(list)) return refuse('jwks.malformed', 'the key set is not an object with a keys list');
  const keys = new Map<string, GatewayKey>();
  for (const entry of list) {
    if (!isRecord(entry)) return refuse('jwks.malformed', 'a key of the set is not an object');
    const jwk = entry;
    if (PRIVATE_MEMBERS.some((m) => has(jwk, m))) return refuse('jwks.private_key', 'a key of the set holds private key material');
    const supported = (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') || (jwk.kty === 'EC' && jwk.crv === 'P-256');
    if (!supported || typeof jwk.kid !== 'string' || jwk.kid.length === 0) continue;
    if (use !== null && has(jwk, 'use') && jwk.use !== use) continue;
    let parsed;
    try {
      parsed = publicJwkKey(jwk);
    } catch (e) {
      if (e instanceof JoseError) continue;
      throw e;
    }
    if (has(jwk, 'alg') && jwk.alg !== algOf(parsed.kind) && !(parsed.kind === 'Ed25519' && jwk.alg === 'Ed25519')) continue;
    if (keys.has(jwk.kid)) return refuse('jwks.malformed', 'two keys of the set have the same kid');
    keys.set(jwk.kid, { kid: jwk.kid, kind: parsed.kind, key: parsed.key, jwk: parsed.jwk });
  }
  return keys.size === 0 ? refuse('jwks.no_usable_key', 'the key set has no Ed25519 or P-256 key for signatures') : accept(keys);
}

/** The rule names that `verifyGatewayJws` gives for each way that a JWS fails: a check names its own, so that a refusal says which kind of document it is about. */
export interface JwsRules<R extends string> {
  readonly malformed: R;
  readonly alg: R;
  readonly typ: R;
  readonly kid: R;
  readonly signature: R;
}

export interface SignedDocument {
  readonly jws: Jws;
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly key: GatewayKey;
}

/**
 * Checks a compact JWS that the gateway signed: a JWS whose payload is a JSON object, ES256, the `typ` (and `cty`, when one is named) that this kind of document has, a `kid` that
 * the key set holds for a P-256 key, and a signature that verifies. The check of the signature is last, so that a document of another kind never gets that far.
 */
export function verifyGatewayJws<R extends string>(token: unknown, keys: KeySet, expect: { readonly typ: string; readonly cty?: string }, rules: JwsRules<R>): Check<SignedDocument, R> {
  let jws: Jws;
  try {
    jws = parseJws(token);
  } catch (e) {
    if (e instanceof JoseError) return refuse(rules.malformed, e.message);
    throw e;
  }
  const { header, payload } = jws;
  if (header.alg !== 'ES256') return refuse(rules.alg, `the algorithm is ${JSON.stringify(header.alg)}, and the gateway signs with ES256`);
  if (header.typ !== expect.typ) return refuse(rules.typ, `the JWT type (typ) is ${JSON.stringify(header.typ)}, and a document of this kind has ${expect.typ}`);
  if (expect.cty !== undefined && header.cty !== expect.cty) return refuse(rules.typ, `the content type (cty) is ${JSON.stringify(header.cty)}, and a document of this kind has ${expect.cty}`);
  const key = typeof header.kid === 'string' ? keys.get(header.kid) : undefined;
  if (key === undefined) return refuse(rules.kid, `the key set of the gateway has no key with the kid ${JSON.stringify(header.kid)}`);
  if (key.kind !== 'P256') return refuse(rules.kid, 'the key named by kid is not a P-256 key');
  if (!verifyJws(jws, 'P256', key.key)) return refuse(rules.signature, 'the signature does not verify with the key that kid names');
  return accept({ jws, header, payload, key });
}
