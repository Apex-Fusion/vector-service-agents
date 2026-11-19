// packages/id-kit/src/verify/access-token.ts
// The check of an access token of the gateway at a resource. The token is a JWT (RFC 9068, `typ` at+jwt) that the gateway signed with ES256. A check is the rules, in this order, and
// the first rule that fails is the result:
//   the signature against the key set of the gateway; `iss` is the gateway; `aud` names this resource; the time (`exp`, `iat`, `nbf`, a life of 5 minutes at most);
//   `cnf.jkt`, and the DPoP proof of this call by that key (see dpop.ts), which is also accepted once;
//   the chain of actors (`act`) is a chain of DIDs, and not deeper than the longest delegation chain;
//   the authorization details name a delegation; a token with a delegation is accepted only when the caller names the action and the resource of the call, and a pattern of the grant covers each of them (the pattern rule of the delegation);
//   the status claim names an entry in a Token Status List of the gateway.
// The check does not read the status list, the DID of an actor, or the ledger. It returns what it found, so that the caller can (see index.ts).

import { DELEGATION_DETAILS_TYPE, LIST_SIZE, MAX_ACTIONS, MAX_LOCATIONS } from '../common/constants.ts';
import { vectorIdOf } from '../common/did.ts';
import { isNumber, isRecord, isStringList } from '../common/json.ts';
import { accept, refuse, type Check } from '../common/result.ts';
import { covers, isActionPattern, isResourcePattern } from '../vendored/m4/delegation-patterns.ts';
import { has } from '../vendored/m4/jose.ts';
import { DPOP_RULES, checkDpopProof, type DpopRule } from './dpop.ts';
import { verifyGatewayJws, type KeySet } from './keys.ts';
import type { ReplayStore } from './replay.ts';

/** The rules of `checkAccessToken`. */
export const ACCESS_TOKEN_RULES = [
  'token.missing',
  'token.scheme',
  'token.malformed',
  'token.alg',
  'token.typ',
  'token.kid',
  'token.signature',
  'token.issuer',
  'token.audience',
  'token.lifetime',
  'token.expired',
  'token.not_yet_valid',
  'token.claims',
  ...DPOP_RULES,
  'act.invalid',
  'act.depth',
  'delegation.details',
  'delegation.missing',
  'delegation.unchecked',
  'delegation.action',
  'delegation.resource',
  'status.claim',
] as const;
export type AccessTokenRule = (typeof ACCESS_TOKEN_RULES)[number] | DpopRule;

const TOKEN_JWS_RULES = { malformed: 'token.malformed', alg: 'token.alg', typ: 'token.typ', kid: 'token.kid', signature: 'token.signature' } as const;
const HEX_64 = /^[0-9a-f]{64}$/;
const KEY_PRINCIPAL_PATH = /^\/principals\/key\/([0-9a-f]{56})$/;
const TOKEN_LIST_PATH = /^\/status\/tsl\/(0|[1-9][0-9]{0,8})$/;

/** What the caller asks of the call: an action of a delegation on a resource, as concrete values (not patterns). */
export interface RequiredGrant {
  readonly action: string;
  readonly resource: string;
}

export interface AccessTokenRequest {
  readonly accessToken: string;
  /** The value of the `DPoP` header field of the request: one value, or the list of the values that a server read. */
  readonly dpop: string | readonly string[] | undefined;
  /** The method of the request. */
  readonly method: string;
  /** The URL of the request as the client sees it: the public URL, not the address behind a proxy. */
  readonly url: string;
}

export interface AccessTokenContext {
  readonly keys: KeySet;
  /** The origin of the gateway. */
  readonly issuer: string;
  /** The identifier of this resource: a value of the `aud` claim must equal it. */
  readonly audience: string;
  readonly nowMs: number;
  readonly leewaySeconds: number;
  readonly maxLifetimeSeconds: number;
  /** The most levels that the `act` chain may have. */
  readonly maxActDepth: number;
  readonly replay: ReplayStore;
  readonly require: RequiredGrant | null;
  /** True when a token with no delegation is accepted too, with `require`. */
  readonly acceptDirect: boolean;
}

export type Principal = { readonly kind: 'agent'; readonly did: string } | { readonly kind: 'key'; readonly keyHash: string; readonly id: string };

/** The grant of a delegation token: the delegation, and the actions and resource locations that it covers (patterns). */
export interface DelegationGrant {
  /** The identifier of the leaf delegation. */
  readonly identifier: string;
  readonly actions: readonly string[];
  readonly locations: readonly string[];
  /** The hash of the purpose of the delegation, in 64 hex characters, when it has one. */
  readonly purpose: string | null;
}

export interface VerifiedAccessToken {
  readonly jti: string;
  readonly issuer: string;
  readonly audience: readonly string[];
  /** The `sub` claim: the principal of a delegation token, or the agent itself for a token with no delegation. */
  readonly subject: string;
  readonly principal: Principal;
  /** The agent that asked for the token (`client_id`): the current actor of a delegation token. */
  readonly clientId: string;
  /** The chain of actors, as DIDs, the current actor first. Empty for a token with no delegation. */
  readonly actors: readonly string[];
  readonly delegation: DelegationGrant | null;
  /** The entry in the Token Status List that names the agent that asked for the token: the status claim of the token. */
  readonly statusClaim: { readonly uri: string; readonly index: number };
  /** POSIX ms. */
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** The thumbprint of the key that the token is bound to. */
  readonly keyThumbprint: string;
}

/** The token in an `Authorization` header field of the form `DPoP <token>`. A token that is sent as `Bearer` is refused: a token that is bound to a key is no bearer token. */
export function parseAuthorization(header: string | undefined): Check<string, 'token.missing' | 'token.scheme'> {
  if (header === undefined || header.trim() === '') return refuse('token.missing', 'the request has no Authorization header field');
  const parts = /^(\S+) (\S+)$/.exec(header.trim());
  if (parts === null) return refuse('token.scheme', 'the Authorization header field is not a scheme and a token');
  if (parts[1]!.toLowerCase() !== 'dpop') return refuse('token.scheme', `the Authorization scheme is ${parts[1]}, and an access token of the gateway is sent with DPoP`);
  return accept(parts[2]!);
}

/** The audience claim as a list of strings, or null when it is not one string or a non-empty list of strings. */
function audiencesOf(aud: unknown): string[] | null {
  if (typeof aud === 'string') return [aud];
  return isStringList(aud) && aud.length > 0 ? aud : null;
}

/** The hash of a principal key in a `sub` of the form `<origin>/principals/key/<key hash>`, or null. */
function keyPrincipalHash(subject: string, issuer: string): string | null {
  let url: URL;
  try {
    url = new URL(subject);
  } catch {
    return null;
  }
  if (url.origin !== issuer || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') return null;
  return KEY_PRINCIPAL_PATH.exec(url.pathname)?.[1] ?? null;
}

function readPrincipal(subject: string, issuer: string, delegated: boolean): Principal | null {
  if (vectorIdOf(subject) !== null) return { kind: 'agent', did: subject };
  const hash = delegated ? keyPrincipalHash(subject, issuer) : null;
  return hash === null ? null : { kind: 'key', keyHash: hash, id: subject };
}

/** The chain of actors (RFC 8693 Section 4.1): the current actor is the outermost `act.sub`, and each earlier delegate is a nested `act`. */
function readActors(act: unknown, maxDepth: number): Check<string[], 'act.invalid' | 'act.depth'> {
  const actors: string[] = [];
  for (let current: unknown = act; current !== undefined; current = isRecord(current) ? current.act : undefined) {
    if (!isRecord(current)) return refuse('act.invalid', 'an act claim is not an object');
    if (actors.length === maxDepth) return refuse('act.depth', `the chain of actors is deeper than ${maxDepth}`);
    if (typeof current.sub !== 'string' || vectorIdOf(current.sub) === null) return refuse('act.invalid', 'an actor is not named by a DID of the form did:vector:<64 hex characters>');
    actors.push(current.sub);
  }
  return accept(actors);
}

/** The delegation grant of the authorization details: one object of the delegation type, with an identifier, actions and locations of the delegation rules. */
function readGrant(details: unknown): Check<DelegationGrant, 'delegation.details'> {
  if (!Array.isArray(details) || details.length !== 1 || !isRecord(details[0])) return refuse('delegation.details', 'authorization_details is not a list with one object');
  const detail = details[0];
  if (detail.type !== DELEGATION_DETAILS_TYPE) return refuse('delegation.details', 'the authorization details object is not of the delegation type');
  if (typeof detail.identifier !== 'string' || !HEX_64.test(detail.identifier)) return refuse('delegation.details', 'the delegation identifier is not 64 lowercase hex characters');
  const { actions, locations } = detail;
  if (!isStringList(actions) || actions.length === 0 || actions.length > MAX_ACTIONS || !actions.every(isActionPattern)) return refuse('delegation.details', `actions is not a list of 1 to ${MAX_ACTIONS} action patterns`);
  if (!isStringList(locations) || locations.length === 0 || locations.length > MAX_LOCATIONS || !locations.every(isResourcePattern)) return refuse('delegation.details', `locations is not a list of 1 to ${MAX_LOCATIONS} resource patterns`);
  const purpose = detail.purpose;
  if (purpose !== undefined && (typeof purpose !== 'string' || !HEX_64.test(purpose))) return refuse('delegation.details', 'the purpose is not 64 lowercase hex characters');
  return accept({ identifier: detail.identifier, actions, locations, purpose: purpose ?? null });
}

/** The entry of the Token Status List that the status claim names: a position below 131,072, in a list of the gateway (`<origin>/status/tsl/<n>`). */
function readStatusClaim(status: unknown, issuer: string): Check<{ uri: string; index: number }, 'status.claim'> {
  const list = isRecord(status) ? status.status_list : undefined;
  if (!isRecord(list) || typeof list.uri !== 'string' || typeof list.idx !== 'number' || !Number.isInteger(list.idx) || list.idx < 0 || list.idx >= LIST_SIZE) {
    return refuse('status.claim', 'the token has no status claim with a position below 131,072 and the URI of a list');
  }
  let url: URL;
  try {
    url = new URL(list.uri);
  } catch {
    return refuse('status.claim', 'the URI of the status list is not a URL');
  }
  if (url.origin !== issuer || !TOKEN_LIST_PATH.test(url.pathname) || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    return refuse('status.claim', 'the status list is not a Token Status List of the gateway');
  }
  return accept({ uri: `${url.origin}${url.pathname}`, index: list.idx });
}

/** True when `value` is an action that can be asked for: not a wildcard pattern. */
const concreteAction = (value: string): boolean => isActionPattern(value) && value !== '*' && !value.endsWith('.*');
/** True when `value` is a resource that can be asked for: not a wildcard pattern. */
const concreteResource = (value: string): boolean => isResourcePattern(value) && value !== '*';

/**
 * Checks the shape of the policy of a call, and throws a TypeError for a mistake of the caller. `require` is nothing, or an object with an `action` and a `resource` that are text and
 * concrete values. `acceptDirect` is nothing, true or false, and true goes with `require`.
 */
export function assertPolicy(policy: { readonly require?: unknown; readonly acceptDirect?: unknown }): void {
  const { require: required, acceptDirect } = policy;
  if (acceptDirect !== undefined && typeof acceptDirect !== 'boolean') {
    throw new TypeError('acceptDirect is true or false. Any other value, such as the text "false", is a mistake of the caller.');
  }
  if (required === undefined || required === null) {
    if (acceptDirect === true) throw new TypeError('acceptDirect goes with require: with no require, only a token with no delegation is accepted, and a token with a delegation is refused.');
    return;
  }
  if (!isRecord(required) || typeof required.action !== 'string' || typeof required.resource !== 'string') {
    throw new TypeError('require is an object with an action and a resource, both text: for example { action: "erp.stock.read", resource: "https://example.org/erp" }.');
  }
  if (!concreteAction(required.action) || !concreteResource(required.resource)) {
    throw new TypeError('the action and the resource of a call are concrete values: an action such as erp.stock.read, and a resource such as an https URL or script:<56 hex characters>. They are not patterns.');
  }
}

export function checkAccessToken(request: AccessTokenRequest, ctx: AccessTokenContext): Check<VerifiedAccessToken, AccessTokenRule> {
  assertPolicy(ctx);
  const required = ctx.require;
  const signed = verifyGatewayJws(request.accessToken, ctx.keys, { typ: 'at+jwt' }, TOKEN_JWS_RULES);
  if (!signed.ok) return signed;
  const claims = signed.value.payload;

  if (claims.iss !== ctx.issuer) return refuse('token.issuer', 'the issuer of the token is not the gateway');
  const audience = audiencesOf(claims.aud);
  if (audience === null || !audience.includes(ctx.audience)) return refuse('token.audience', 'the audience of the token does not name this resource');
  if (!isNumber(claims.iat) || !isNumber(claims.exp)) return refuse('token.lifetime', 'the token needs iat and exp');
  if (claims.exp <= claims.iat || claims.exp - claims.iat > ctx.maxLifetimeSeconds) return refuse('token.lifetime', `the life of the token is not from 1 to ${ctx.maxLifetimeSeconds} seconds`);
  const nowS = ctx.nowMs / 1000;
  if (claims.exp <= nowS - ctx.leewaySeconds) return refuse('token.expired', 'the token has expired');
  if (claims.iat > nowS + ctx.leewaySeconds) return refuse('token.not_yet_valid', 'the token is issued in the future');
  if (has(claims, 'nbf') && (!isNumber(claims.nbf) || claims.nbf > nowS + ctx.leewaySeconds)) return refuse('token.not_yet_valid', 'the token is not valid yet (nbf)');
  const { jti, sub: subject, client_id: clientId, cnf } = claims;
  if (typeof jti !== 'string' || jti.length === 0 || jti.length > 256) return refuse('token.claims', 'the token needs a jti of 1 to 256 characters');
  if (typeof clientId !== 'string' || vectorIdOf(clientId) === null) return refuse('token.claims', 'client_id is not a DID of the form did:vector:<64 hex characters>');
  if (typeof subject !== 'string') return refuse('token.claims', 'the token needs a sub');
  if (!isRecord(cnf) || typeof cnf.jkt !== 'string' || cnf.jkt.length === 0) return refuse('token.claims', 'the token is not bound to a key: it has no cnf.jkt');

  const dpop = checkDpopProof(request.dpop, {
    accessToken: request.accessToken,
    boundThumbprint: cnf.jkt,
    method: request.method,
    url: request.url,
    nowMs: ctx.nowMs,
    leewaySeconds: ctx.leewaySeconds,
    replay: ctx.replay,
  });
  if (!dpop.ok) return dpop;

  // A token with a delegation has `act` and `authorization_details`; a token with none has neither.
  const delegated = claims.act !== undefined || claims.authorization_details !== undefined;
  const actors = readActors(claims.act, ctx.maxActDepth);
  if (!actors.ok) return actors;
  if (delegated && (actors.value.length === 0 || claims.authorization_details === undefined)) return refuse('act.invalid', 'a delegation token has both act and authorization_details');
  const principal = readPrincipal(subject, ctx.issuer, delegated);
  if (principal === null) return refuse('token.claims', 'sub is not an agent DID, or, for a delegation token, an agent DID or a principal key of the gateway');
  if (clientId !== (actors.value[0] ?? subject)) return refuse('token.claims', 'client_id is not the current actor of the token');

  let grant: DelegationGrant | null = null;
  if (claims.authorization_details !== undefined) {
    const read = readGrant(claims.authorization_details);
    if (!read.ok) return read;
    grant = read.value;
  }
  if (required === null) {
    // The delegate chooses the audience of a token, and the gateway does not compare it with the delegation. A token with a delegation is the grant of somebody else, so nothing here may take it for the call.
    if (grant !== null) return refuse('delegation.unchecked', 'the token carries a delegation, and the policy of this call names no action and no resource that its grant must cover');
  } else if (grant === null) {
    if (!ctx.acceptDirect) return refuse('delegation.missing', 'the token names no delegation, so it grants no action and no resource');
  } else {
    if (!grant.actions.some((pattern) => covers(pattern, required.action))) return refuse('delegation.action', 'no action pattern of the grant covers the action of this call');
    if (!grant.locations.some((pattern) => covers(pattern, required.resource))) return refuse('delegation.resource', 'no resource pattern of the grant covers the resource of this call');
  }

  const statusClaim = readStatusClaim(claims.status, ctx.issuer);
  if (!statusClaim.ok) return statusClaim;
  return accept({
    jti,
    issuer: ctx.issuer,
    audience,
    subject,
    principal,
    clientId,
    actors: actors.value,
    delegation: grant,
    statusClaim: statusClaim.value,
    issuedAt: claims.iat * 1000,
    expiresAt: claims.exp * 1000,
    keyThumbprint: dpop.value.thumbprint,
  });
}
