// packages/id-kit/src/verify/dpop.ts
// The check of a DPoP proof at a resource (RFC 9449 Sections 4.3 and 7.1). A resource accepts an access token that is bound to a key (`cnf.jkt`) only with a proof by that key for this
// call. The proof is a JWT: `typ` dpop+jwt, the public JWK of the key in its header, and `htm`, `htu`, `iat`, `jti` and `ath` in its claims. The check follows the steps of the RFC, and
// the last step records the `jti`: a proof is accepted once. The gateway sends no DPoP nonces, so the check reads no nonce claim.

import { MAX_TOKEN_LIFETIME_S } from '../common/constants.ts';
import { htuForm, tokenHash } from '../common/dpop.ts';
import { isNumber } from '../common/json.ts';
import { accept, refuse, type Check } from '../common/result.ts';
import { JoseError, algKeyKind, jwkThumbprint, parseJws, publicJwkKey, verifyJws, type Jws, type JwkKey } from '../vendored/m4/jose.ts';
import { ReplayStoreFull, type ReplayStore } from './replay.ts';

/** The rules of a DPoP check, one for each way that a proof fails. */
export const DPOP_RULES = [
  'dpop.missing',
  'dpop.multiple',
  'dpop.malformed',
  'dpop.typ',
  'dpop.alg',
  'dpop.key',
  'dpop.signature',
  'dpop.jti',
  'dpop.method',
  'dpop.url',
  'dpop.iat',
  'dpop.ath',
  'dpop.binding',
  'dpop.replay',
  'dpop.replay_store',
] as const;
export type DpopRule = (typeof DPOP_RULES)[number];

export interface DpopExpectation {
  /** The access token that the proof must name. */
  readonly accessToken: string;
  /** The thumbprint that the access token is bound to (`cnf.jkt`): the key of the proof must have it. */
  readonly boundThumbprint: string;
  /** The method of the request. */
  readonly method: string;
  /** The URL of the request as the client sees it: the public URL, not the address behind a proxy. */
  readonly url: string;
  readonly nowMs: number;
  readonly leewaySeconds: number;
  readonly replay: ReplayStore;
}

export interface VerifiedDpop {
  /** The thumbprint of the key of the proof. */
  readonly thumbprint: string;
  readonly jti: string;
  /** POSIX seconds. */
  readonly issuedAt: number;
}

export function checkDpopProof(proof: string | readonly string[] | undefined, expect: DpopExpectation): Check<VerifiedDpop, DpopRule> {
  const values = proof === undefined ? [] : typeof proof === 'string' ? [proof] : proof;
  if (values.length === 0 || values[0]!.trim() === '') return refuse('dpop.missing', 'the request has no DPoP proof, and the token is bound to a key');
  // A JWS in compact form never holds a comma, so a comma shows two header fields that a server joined into one.
  if (values.length > 1 || values[0]!.includes(',')) return refuse('dpop.multiple', 'the request has more than one DPoP header field');
  let jws: Jws;
  try {
    jws = parseJws(values[0]!.trim());
  } catch (e) {
    if (e instanceof JoseError) return refuse('dpop.malformed', `the DPoP proof is not a JWT: ${e.message}`);
    throw e;
  }
  const { header, payload } = jws;
  if (header.typ !== 'dpop+jwt') return refuse('dpop.typ', 'the typ of a DPoP proof is dpop+jwt');
  const kind = algKeyKind(header.alg);
  if (kind === null) return refuse('dpop.alg', 'the algorithm of a DPoP proof is EdDSA, Ed25519 or ES256');
  let key: JwkKey;
  try {
    key = publicJwkKey(header.jwk);
  } catch (e) {
    if (e instanceof JoseError) return refuse('dpop.key', `the jwk of the proof is not acceptable: ${e.message}`);
    throw e;
  }
  if (key.kind !== kind) return refuse('dpop.alg', 'the algorithm of the proof does not match its key');
  if (!verifyJws(jws, kind, key.key)) return refuse('dpop.signature', 'the signature of the proof does not verify with the key in its header');
  if (typeof payload.jti !== 'string' || payload.jti.length === 0 || payload.jti.length > 256) return refuse('dpop.jti', 'the proof needs a jti of 1 to 256 characters');
  if (payload.htm !== expect.method) return refuse('dpop.method', `the htm of the proof is not the method of the request, which is ${expect.method}`);
  const target = htuForm(expect.url);
  if (typeof payload.htu !== 'string' || htuForm(payload.htu) === null || htuForm(payload.htu) !== target) return refuse('dpop.url', 'the proof is for another URL than the request');
  if (!isNumber(payload.iat)) return refuse('dpop.iat', 'the proof needs iat');
  const nowS = expect.nowMs / 1000;
  if (payload.iat > nowS + expect.leewaySeconds || payload.iat < nowS - MAX_TOKEN_LIFETIME_S) return refuse('dpop.iat', 'the iat of the proof is outside the window that the gateway accepts');
  if (payload.ath !== tokenHash(expect.accessToken)) return refuse('dpop.ath', 'the proof does not name this access token by its hash (ath)');
  const thumbprint = jwkThumbprint(key.jwk);
  if (thumbprint !== expect.boundThumbprint) return refuse('dpop.binding', 'the key of the proof is not the key that the access token is bound to (cnf.jkt)');
  try {
    if (!expect.replay.use(`dpop\n${thumbprint}\n${payload.jti}`, (payload.iat + MAX_TOKEN_LIFETIME_S + expect.leewaySeconds) * 1000, expect.nowMs)) return refuse('dpop.replay', 'the proof was already used');
  } catch (e) {
    if (e instanceof ReplayStoreFull) return refuse('dpop.replay_store', 'the store of used proofs is full, so no new proof can be accepted');
    throw e;
  }
  return accept({ thumbprint, jti: payload.jti, issuedAt: payload.iat });
}
