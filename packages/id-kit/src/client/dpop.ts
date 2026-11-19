// packages/id-kit/src/client/dpop.ts
// DPoP proofs (RFC 9449). A proof is a JWT that the holder of a key signs for one request: `htm` is the method, `htu` is the URL without its query and fragment, `iat` is the
// time, and `jti` is used once. The token endpoint wants a proof by the key that the new token is bound to. A resource wants a proof for each call, and the proof names the
// access token by its hash (`ath`).

import { createHash } from 'node:crypto';
import { resolveKey, type KeyInput } from '../common/keys.ts';
import { signJws } from '../vendored/m4/jose.ts';
import { newJti, seconds } from './agent-jwt.ts';

export interface DpopProofOptions {
  /** The method of the request, for example `POST`. */
  readonly method: string;
  /** The URL of the request. The proof names it without the query and the fragment. */
  readonly url: string;
  /** The access token of the request. Give it for a call to a resource, and leave it out for a request to the token endpoint. */
  readonly accessToken?: string;
  /** The clock, in POSIX milliseconds. The default is `Date.now`. */
  readonly now?: () => number;
}

/** The URL as a proof names it: the scheme, the host and the path. The query and the fragment are not in it. */
export function proofTarget(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError('the URL of a DPoP proof is not a URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new TypeError('the URL of a DPoP proof is an http or https URL');
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

/** The hash that names an access token in a proof: the SHA-256 hash of the token as ASCII text, in base64url. */
export const tokenHash = (accessToken: string): string => createHash('sha256').update(accessToken, 'ascii').digest('base64url');

/** A DPoP proof, signed by `key`. The header holds the public JWK of the key and nothing else of it. */
export async function createDpopProof(key: KeyInput, options: DpopProofOptions): Promise<string> {
  if (!/^[A-Z]+$/.test(options.method)) throw new TypeError('the method of a DPoP proof is an upper case HTTP method');
  const resolved = resolveKey(key, 'the DPoP key');
  return signJws(
    { typ: 'dpop+jwt', alg: resolved.algorithm, jwk: resolved.jwk },
    {
      jti: newJti(),
      htm: options.method,
      htu: proofTarget(options.url),
      iat: seconds(options.now ?? Date.now),
      ...(options.accessToken === undefined ? {} : { ath: tokenHash(options.accessToken) }),
    },
    resolved,
  );
}

/** The two header fields of a call to a resource with a DPoP-bound access token. */
export interface PresentedToken {
  readonly authorization: string;
  readonly dpop: string;
}

/** The header fields for one call: `Authorization: DPoP <token>`, and a new proof for this method and this URL. The key is the one that the token is bound to. */
export async function presentToken(accessToken: string, key: KeyInput, request: { readonly method: string; readonly url: string }, options: { readonly now?: () => number } = {}): Promise<PresentedToken> {
  return { authorization: `DPoP ${accessToken}`, dpop: await createDpopProof(key, { ...request, accessToken, ...options }) };
}
