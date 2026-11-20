// packages/id-kit/test/support.ts
// Shared by the tests: a stub gateway with a client on it, the decoding of a JWT, and the check of a JWS signature. No key is written in the repository: a key comes from a label.

import { verify, type KeyObject } from 'node:crypto';
import { createGatewayClient, type GatewayClient } from '../src/client/index.ts';
import { createStubGateway, type StubGateway, type StubGatewayOptions } from '../src/testing/index.ts';
import { parseJws, verifyJws, type KeyKind } from '../src/vendored/m4/jose.ts';

export interface World {
  readonly gateway: StubGateway;
  readonly client: GatewayClient;
}

/** A stub gateway and a client on its `fetch` and its clock. */
export function world(options: StubGatewayOptions = {}): World {
  const gateway = createStubGateway(options);
  return { gateway, client: createGatewayClient({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: gateway.now }) };
}

export interface DecodedJwt {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
}

/** The header and the claims of a compact JWS, with no check of the signature. */
export function decodeJwt(jwt: string): DecodedJwt {
  const { header, payload } = parseJws(jwt);
  return { header, payload };
}

/** True when the JWS signature verifies with the public key. */
export function signedBy(jwt: string, kind: KeyKind, publicKey: KeyObject): boolean {
  return verifyJws(parseJws(jwt), kind, publicKey);
}

/** True when an ES256 signature in the form r then s verifies over `data`. */
export function es256Verifies(data: Uint8Array, signature: Uint8Array, publicKey: KeyObject): boolean {
  return verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
}

/**
 * True when `text` holds a credential or a part of one: the whole credential, one of its dot-separated parts, or any run of 24 characters of it. A refusal that a service returns or
 * writes to a log must hold none of these.
 */
export function repeatsCredential(text: string, credential: string): boolean {
  if (text.includes(credential) || credential.split('.').some((part) => part.length > 0 && text.includes(part))) return true;
  for (let start = 0; start + 24 <= credential.length; start++) if (text.includes(credential.substring(start, start + 24))) return true;
  return false;
}

/** The text of a value that must be a string. */
export function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`expected a string, got ${typeof value}`);
  return value;
}

/** The first request that the stub received for a path. */
export function requestTo(gateway: StubGateway, path: string): StubGateway['requests'][number] {
  const found = gateway.requests.find((r) => r.path === path);
  if (found === undefined) throw new Error(`the stub gateway received no request for ${path}`);
  return found;
}
