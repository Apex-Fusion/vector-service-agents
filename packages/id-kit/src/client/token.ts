// packages/id-kit/src/client/token.ts
// The token request: OAuth token exchange (RFC 8693) at `<gateway>/token`.
// - The form has the grant type, the subject token (an EdDSA JWT of the agent), its type, and the audience of the new token in `audience` or `resource` (at least one value).
// - With a delegation, the form also has `authorization_details` of the type https://id.vector.apexfusion.org/ns/delegation: the identifier of the leaf delegation and,
//   if the caller wants a narrower grant, the actions and the resource locations. The proof must then be signed by the Ed25519 delegate key of that delegation.
// - The request has a DPoP header: a proof for `POST` on the token endpoint, signed by the key that the new token is bound to.
// The client checks the request against the limits of the gateway before it sends it, and it reads the answer into a typed result.

import { ACCESS_TOKEN_TYPE, DELEGATION_DETAILS_TYPE, JWT_TOKEN_TYPE, MAX_ACTIONS, MAX_AUDIENCES, MAX_AUDIENCE_LENGTH, MAX_LOCATIONS, TOKEN_EXCHANGE_GRANT } from '../common/constants.ts';
import { badBody, failureOf, jsonObject, send } from '../common/http.ts';
import { resolveKey, type KeyInput } from '../common/keys.ts';
import { accept, type GatewayResult } from '../common/result.ts';
import { isActionPattern, isResourcePattern } from '../vendored/m4/delegation-patterns.ts';
import { createSubjectToken, type AgentIdentity } from './agent-jwt.ts';
import type { ClientContext } from './context.ts';
import { createDpopProof } from './dpop.ts';

export interface DelegationRequest {
  /** The identifier of the leaf delegation: 64 lowercase hex characters. */
  readonly identifier: string;
  /** Patterns that narrow the grant. Every delegation of the chain must cover them. The default is the actions of the delegation. At most 16. */
  readonly actions?: readonly string[];
  /** Patterns of resources that narrow the grant. The default is the resources of the delegation. At most 8. */
  readonly locations?: readonly string[];
}

export interface TokenRequest {
  /** The agent that asks: its DID and its Ed25519 authentication key. */
  readonly subject: AgentIdentity;
  /** The key that the new token is bound to (`cnf.jkt` is its thumbprint). With a delegation, it must be the Ed25519 delegate key of the leaf delegation. */
  readonly dpopKey: KeyInput;
  /** The audience of the token. At least one value of `audience` and `resource` together, at most 8, of at most 512 characters each. */
  readonly audience?: string | readonly string[];
  /** The resource of the token, as an absolute URI with no fragment. It becomes an audience of the token. */
  readonly resource?: string | readonly string[];
  /** A delegation to act under. Without it, the token has the agent as its subject and no `act` chain. */
  readonly delegation?: DelegationRequest;
  /** The type of token to ask for. The default is `access_token`. */
  readonly requestedTokenType?: 'access_token' | 'jwt';
}

export interface IssuedToken {
  /** The access token: a JWT that the gateway signed with ES256. Send it with `Authorization: DPoP <token>` and a proof for each call (`presentToken`). */
  readonly accessToken: string;
  readonly tokenType: 'DPoP';
  readonly issuedTokenType: string;
  /** The life that the gateway names, in seconds. */
  readonly expiresIn: number;
  /** The time that the token ends, in POSIX milliseconds, by the clock of the client at the answer. */
  readonly expiresAt: number;
  /** The grant as the gateway wrote it into the token, for a token with a delegation; null for a token without one. */
  readonly authorizationDetails: readonly Record<string, unknown>[] | null;
}

const list = (value: string | readonly string[] | undefined): readonly string[] => (value === undefined ? [] : typeof value === 'string' ? [value] : value);

/** The audiences of the request. Throws a TypeError or RangeError for a value that the gateway would refuse. */
function audiencesOf(request: TokenRequest): { audiences: string[]; resources: string[] } {
  const resources = [...list(request.resource)];
  for (const resource of resources) {
    let url: URL | null = null;
    try {
      url = new URL(resource);
    } catch {
      // handled below
    }
    if (url === null || resource.includes('#')) throw new TypeError('each resource must be an absolute URI without a fragment');
  }
  const audiences = [...new Set(list(request.audience))];
  const all = new Set([...resources, ...audiences]);
  if (all.size === 0) throw new TypeError('name the audience of the token with `audience` or `resource`');
  if (all.size > MAX_AUDIENCES || [...all].some((a) => a.length > MAX_AUDIENCE_LENGTH)) throw new RangeError(`at most ${MAX_AUDIENCES} audiences of at most ${MAX_AUDIENCE_LENGTH} characters`);
  return { audiences, resources: [...new Set(resources)] };
}

function patternsOf(name: string, value: readonly string[] | undefined, max: number, valid: (pattern: string) => boolean): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > max || !value.every((p) => typeof p === 'string' && valid(p))) {
    throw new TypeError(`${name} must be a list of 1 to ${max} patterns of the delegation rules`);
  }
  return value;
}

/** The `authorization_details` text of a delegation request. */
function detailsOf(delegation: DelegationRequest): string {
  if (!/^[0-9a-f]{64}$/.test(delegation.identifier)) throw new TypeError('the delegation identifier is 64 lowercase hex characters');
  const actions = patternsOf('actions', delegation.actions, MAX_ACTIONS, isActionPattern);
  const locations = patternsOf('locations', delegation.locations, MAX_LOCATIONS, isResourcePattern);
  return JSON.stringify([{ type: DELEGATION_DETAILS_TYPE, identifier: delegation.identifier, ...(actions ? { actions } : {}), ...(locations ? { locations } : {}) }]);
}

function parseGrant(status: number, body: string, now: number): GatewayResult<IssuedToken> {
  const json = jsonObject(body);
  if (json === null) return badBody(status, 'the answer to a token request is not a JSON object');
  if ('error' in json || 'error_description' in json || 'error_uri' in json) return badBody(status, 'the HTTP 200 token response contains OAuth error fields');
  const { access_token: accessToken, token_type: tokenType, issued_token_type: issuedTokenType, expires_in: expiresIn, authorization_details: details } = json;
  if (typeof accessToken !== 'string' || accessToken.split('.').length !== 3) return badBody(status, 'the answer has no access token in the form of a JWS');
  if (tokenType !== 'DPoP') return badBody(status, 'the token type of the answer is not DPoP');
  if (typeof issuedTokenType !== 'string') return badBody(status, 'the answer has no issued token type');
  if (typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn < 1) return badBody(status, 'the answer has no life for the token');
  const authorizationDetails = details === undefined ? null : Array.isArray(details) && details.every((d) => d !== null && typeof d === 'object' && !Array.isArray(d)) ? (details as Record<string, unknown>[]) : undefined;
  if (authorizationDetails === undefined) return badBody(status, 'the authorization details of the answer are not a list of objects');
  return accept({ accessToken, tokenType: 'DPoP', issuedTokenType, expiresIn, expiresAt: now + expiresIn * 1000, authorizationDetails });
}

export async function requestAccessToken(ctx: ClientContext, request: TokenRequest): Promise<GatewayResult<IssuedToken>> {
  const { audiences, resources } = audiencesOf(request);
  const dpopKey = resolveKey(request.dpopKey, 'the DPoP key');
  if (request.delegation !== undefined && dpopKey.kind !== 'Ed25519') throw new TypeError('with a delegation, the DPoP key must be the Ed25519 delegate key of the delegation');
  const details = request.delegation === undefined ? null : detailsOf(request.delegation);

  const form = new URLSearchParams();
  form.set('grant_type', TOKEN_EXCHANGE_GRANT);
  form.set('subject_token', await createSubjectToken(request.subject, ctx.tokenEndpoint, { now: ctx.now }));
  form.set('subject_token_type', JWT_TOKEN_TYPE);
  if (request.requestedTokenType !== undefined) form.set('requested_token_type', request.requestedTokenType === 'jwt' ? JWT_TOKEN_TYPE : ACCESS_TOKEN_TYPE);
  for (const audience of audiences) form.append('audience', audience);
  for (const resource of resources) form.append('resource', resource);
  if (details !== null) form.set('authorization_details', details);

  const outcome = await send(ctx, ctx.tokenEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      dpop: await createDpopProof(request.dpopKey, { method: 'POST', url: ctx.tokenEndpoint, now: ctx.now }),
    },
    body: form.toString(),
  });
  if (!outcome.reached || outcome.reply.status !== 200) return failureOf(outcome, 'a token request');
  return parseGrant(outcome.reply.status, outcome.reply.body, ctx.now());
}
