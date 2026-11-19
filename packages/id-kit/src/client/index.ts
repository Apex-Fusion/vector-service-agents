// packages/id-kit/src/client/index.ts
// The client of the identity gateway: what an agent sends to get a token, an SVID or its credential, and how it reads DID resolution. `createGatewayClient` binds the calls to one
// gateway, one `fetch` function and one clock. The builders under it (`createSubjectToken`, `createDpopProof`, `presentToken`) make a JWT or a proof with no call.
// The caller gives every key as a key object or as a sign function. The client reads no key file and no environment variable.

import { contextOf, type GatewayClientOptions } from './context.ts';
import { fetchCredential } from './credential.ts';
import { resolveAgent, type Resolution } from './resolve.ts';
import { requestJwtSvid, requestX509Svid, type IssuedJwtSvid, type IssuedX509Svid, type JwtSvidRequest, type X509SvidRequest } from './svid.ts';
import { requestAccessToken, type IssuedToken, type TokenRequest } from './token.ts';
import type { GatewayResult } from '../common/result.ts';

export interface GatewayClient {
  /** The origin of the gateway. */
  readonly baseUrl: string;
  /** `<origin>/token`: the audience of a subject token. */
  readonly tokenEndpoint: string;
  /** A token request: a token for the agent, or, with `delegation`, a token for a delegation chain. */
  requestToken(request: TokenRequest): Promise<GatewayResult<IssuedToken>>;
  /** An X.509-SVID for a P-256 key. */
  x509Svid(request: X509SvidRequest): Promise<GatewayResult<IssuedX509Svid>>;
  /** A JWT-SVID. */
  jwtSvid(request: JwtSvidRequest): Promise<GatewayResult<IssuedJwtSvid>>;
  /** The identity credential of an agent, as a compact JWS. Give a DID or the identifier. */
  credential(agent: string): Promise<GatewayResult<string>>;
  /** DID resolution of an agent. */
  resolve(did: string): Promise<GatewayResult<Resolution>>;
}

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  const ctx = contextOf(options);
  return {
    baseUrl: ctx.origin,
    tokenEndpoint: ctx.tokenEndpoint,
    requestToken: (request) => requestAccessToken(ctx, request),
    x509Svid: (request) => requestX509Svid(ctx, request),
    jwtSvid: (request) => requestJwtSvid(ctx, request),
    credential: (agent) => fetchCredential(ctx, agent),
    resolve: (did) => resolveAgent(ctx, did),
  };
}

export type { GatewayClientOptions } from './context.ts';
export { createAgentJwt, createSubjectToken, newJti, type AgentIdentity, type AgentJwtOptions } from './agent-jwt.ts';
export { createDpopProof, presentToken, proofTarget, tokenHash, type DpopProofOptions, type PresentedToken } from './dpop.ts';
export { createCertificationRequest, pem } from './csr.ts';
export { identifierOf } from './credential.ts';
export { EFFECTIVE_STATUSES, type EffectiveStatus, type RecordKey, type Resolution } from './resolve.ts';
export type { DelegationRequest, IssuedToken, TokenRequest } from './token.ts';
export type { IssuedJwtSvid, IssuedX509Svid, JwtSvidRequest, X509SvidRequest } from './svid.ts';
export { resolveKey, type JwsAlgorithm, type KeyInput, type ResolvedKey, type SignerKey } from '../common/keys.ts';
export { accept, refuse, GATEWAY_RULES, type Accepted, type Check, type GatewayRefused, type GatewayResult, type GatewayRule, type Refused } from '../common/result.ts';
export { didOf, keyHashOf, parseKid, vectorIdOf } from '../common/did.ts';
