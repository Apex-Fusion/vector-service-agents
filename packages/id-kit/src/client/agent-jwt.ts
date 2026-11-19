// packages/id-kit/src/client/agent-jwt.ts
// The JWT that an agent signs with one of its authentication keys. The gateway reads it as the subject token of a token request, as the subject token of a JWT-SVID, and
// as the proof of an X.509-SVID request. The rules of the gateway: `kid` is the DID URL of the key, `iss` and `sub` are the DID, `aud` is the token endpoint, `iat` and `exp`
// are at most five minutes apart, and `jti` is used once.

import { randomBytes } from 'node:crypto';
import { MAX_TOKEN_LIFETIME_S } from '../common/constants.ts';
import { vectorIdOf } from '../common/did.ts';
import { resolveKey, type JwsAlgorithm, type KeyInput } from '../common/keys.ts';
import { signJws } from '../vendored/m4/jose.ts';

/** An agent as the client knows it: its DID, and the authentication key that its record lists. */
export interface AgentIdentity {
  /** `did:vector:` and the 64 hex characters of the identifier. */
  readonly did: string;
  /** The authentication key. A subject token needs an Ed25519 key. */
  readonly key: KeyInput;
}

export interface AgentJwtOptions {
  /** The clock, in POSIX milliseconds. The default is `Date.now`. */
  readonly now?: () => number;
  /** The life of the JWT in seconds, from 1 to 300. The default is 120. */
  readonly lifetimeSeconds?: number;
}

export const DEFAULT_LIFETIME_S = 120;

/** A token identifier of 128 random bits. Every JWT and every proof of the client has its own. */
export const newJti = (): string => randomBytes(16).toString('base64url');

/** The seconds of the clock, as the `iat` of a JWT. */
export const seconds = (now: () => number): number => Math.floor(now() / 1000);

/**
 * Signs a JWT as `agent` for `audience`. `extraClaims` add members (the nonce and the key of an SVID request); they never replace `iss`, `sub`, `aud`, `iat`, `exp` or `jti`.
 * `algorithms` are the JWS algorithms that the key may have: the gateway reads a subject token only if it is EdDSA.
 */
export async function createAgentJwt(
  agent: AgentIdentity,
  audience: string,
  options: AgentJwtOptions & { readonly extraClaims?: Record<string, unknown>; readonly algorithms: readonly JwsAlgorithm[] },
): Promise<string> {
  if (vectorIdOf(agent.did) === null) throw new TypeError('the DID of the agent must be "did:vector:" and 64 lowercase hex characters');
  const key = resolveKey(agent.key, 'the authentication key');
  if (!options.algorithms.includes(key.algorithm)) throw new TypeError(`the authentication key must use ${options.algorithms.join(' or ')}, not ${key.algorithm}`);
  const lifetime = options.lifetimeSeconds ?? DEFAULT_LIFETIME_S;
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > MAX_TOKEN_LIFETIME_S) throw new RangeError(`the life of a token is a whole number of seconds from 1 to ${MAX_TOKEN_LIFETIME_S}`);
  const iat = seconds(options.now ?? Date.now);
  return signJws(
    { alg: key.algorithm, kid: `${agent.did}#${key.keyHash}`, typ: 'JWT' },
    { ...options.extraClaims, iss: agent.did, sub: agent.did, aud: audience, iat, exp: iat + lifetime, jti: newJti() },
    key,
  );
}

/** The subject token of a token request: an EdDSA JWT whose audience is the token endpoint `<gateway>/token`. */
export function createSubjectToken(agent: AgentIdentity, tokenEndpoint: string, options: AgentJwtOptions = {}): Promise<string> {
  return createAgentJwt(agent, tokenEndpoint, { ...options, algorithms: ['EdDSA'] });
}
