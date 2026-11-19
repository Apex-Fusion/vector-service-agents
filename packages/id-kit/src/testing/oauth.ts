// packages/id-kit/src/testing/oauth.ts
// The rules that the gateway applies to a request at its token endpoint, written again for the stub (identity-gateway/src/m4/: agent-jwt.ts, dpop.ts, delegation.ts, tokens.ts, http.ts):
// the form, the JWT of an agent, the DPoP proof, the single-use values, the audiences, the authorization details, and the use checks of a delegation chain. The error codes and the
// words of the refusals are the gateway's, so that a test sees what a client sees. This file is the stub's own code: it does not use the verifier of the package.

import { CLOCK_LEEWAY_S, DELEGATION_DETAILS_TYPE, MAX_ACTIONS, MAX_AUDIENCES, MAX_AUDIENCE_LENGTH, MAX_DELEGATION_DEPTH, MAX_LOCATIONS, MAX_TOKEN_LIFETIME_S, PURPOSE } from '../common/constants.ts';
import { parseKid } from '../common/did.ts';
import { isActionPattern, isResourcePattern, narrower } from '../vendored/m4/delegation-patterns.ts';
import { JoseError, algKeyKind, has, jwkThumbprint, parseJws, publicJwkKey, recordKeyObject, verifyJws, type JwkKey, type KeyKind } from '../vendored/m4/jose.ts';
import type { ListedKey, StubAgent, StubDelegation, StubState } from './state.ts';

/** A refusal in the form of an OAuth error response (RFC 6749 Section 5.2). */
export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    description: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(description);
  }
}

export const invalidRequest = (description: string): OAuthError => new OAuthError(400, 'invalid_request', description);
export const unavailable = (description: string): OAuthError => new OAuthError(503, 'temporarily_unavailable', description, { 'retry-after': '5' });

/** Single-use values: the `jti` of a JWT and of a proof, and the nonces of the SVID endpoint. */
export class SingleUse {
  private readonly entries = new Map<string, number>();

  /** Records `key` until `expiresAt` (POSIX ms). False when the key is already recorded: a replay. */
  use(key: string, expiresAt: number, now: number): boolean {
    for (const [known, until] of this.entries) if (until <= now) this.entries.delete(known);
    if (this.entries.has(key)) return false;
    this.entries.set(key, expiresAt);
    return true;
  }
}

// ── the form ──

/** An `application/x-www-form-urlencoded` body. A parameter without a value counts as omitted. */
export function parseForm(contentType: string | null, body: string): Map<string, string[]> {
  if ((contentType ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw invalidRequest('the body must be application/x-www-form-urlencoded');
  const params = new Map<string, string[]>();
  for (const [name, value] of new URLSearchParams(body)) {
    if (value === '') continue;
    params.set(name, [...(params.get(name) ?? []), value]);
  }
  return params;
}

/** The single value of a parameter. A parameter that appears twice is refused. */
export function single(params: Map<string, string[]>, name: string): string | undefined {
  const values = params.get(name);
  if (values === undefined) return undefined;
  if (values.length > 1) throw invalidRequest(`the parameter ${name} appears more than once`);
  return values[0];
}

/** A JSON object body. */
export function parseJsonObject(contentType: string | null, body: string): Record<string, unknown> {
  if ((contentType ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') throw invalidRequest('the body must be application/json');
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw invalidRequest('the body is not UTF-8 JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest('the body is not a JSON object');
  return value as Record<string, unknown>;
}

// ── the JWT of an agent ──

/** Why an agent JWT was refused. `inactive`: the JWT is valid, but the effective status of the agent is not Active. */
export class AgentJwtError extends Error {
  constructor(
    message: string,
    readonly reason: 'invalid' | 'inactive',
  ) {
    super(message);
  }
}

export interface VerifiedAgentJwt {
  readonly agent: StubAgent;
  readonly did: string;
  readonly key: ListedKey;
  readonly claims: Record<string, unknown>;
}

const numericDate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The rules of identity-gateway/src/m4/agent-jwt.ts. */
export function verifyAgentJwt(state: StubState, replay: SingleUse, token: unknown, options: { readonly audience: string; readonly kinds: readonly KeyKind[] }): VerifiedAgentJwt {
  const invalid = (message: string): AgentJwtError => new AgentJwtError(message, 'invalid');
  let jws;
  try {
    jws = parseJws(token);
  } catch (e) {
    throw invalid(e instanceof JoseError ? e.message : 'the token is not a JWS');
  }
  const { header, payload: claims } = jws;
  if (has(header, 'typ') && (typeof header.typ !== 'string' || header.typ.toLowerCase() !== 'jwt')) throw invalid('the JWT type (typ) must be JWT');
  const kind = algKeyKind(header.alg);
  if (kind === null || !options.kinds.includes(kind)) throw invalid(`the algorithm ${String(header.alg)} is not accepted here`);
  const kid = parseKid(header.kid);
  if (kid === null) throw invalid('the kid must be the DID URL of the key: did:vector:<id>#<key hash>');
  const did = `did:vector:${kid.vectorId}`;
  if (claims.iss !== did || claims.sub !== did) throw invalid('iss and sub must both be the DID of the key in kid');
  const aud = claims.aud;
  if (!(aud === options.audience || (Array.isArray(aud) && aud.length === 1 && aud[0] === options.audience))) throw invalid(`aud must be ${options.audience}`);
  if (!numericDate(claims.iat) || !numericDate(claims.exp)) throw invalid('iat and exp are required');
  if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TOKEN_LIFETIME_S) throw invalid('exp - iat must be more than 0 and at most 300 seconds');
  const now = state.now();
  const nowS = now / 1000;
  if (claims.iat > nowS + CLOCK_LEEWAY_S) throw invalid('iat is in the future');
  if (claims.exp <= nowS - CLOCK_LEEWAY_S) throw invalid('the token has expired');
  if (has(claims, 'nbf') && (!numericDate(claims.nbf) || claims.nbf > nowS + CLOCK_LEEWAY_S)) throw invalid('the token is not valid yet (nbf)');
  if (typeof claims.jti !== 'string' || claims.jti.length === 0 || claims.jti.length > 256) throw invalid('jti must be a string of 1 to 256 characters');

  const agent = state.agent(kid.vectorId);
  if (agent === null) throw invalid('the DID does not resolve to a registered agent');
  const key = agent.keys.find((k) => k.key.keyHash === kid.keyHash && (k.purposes & PURPOSE.authentication) !== 0);
  if (key === undefined) throw invalid('the key in kid is not an authentication key of the agent');
  if (key.key.kind !== kind) throw invalid('the algorithm does not match the key type');
  if (!verifyJws(jws, kind, recordKeyObject(key.key.kind, key.key.publicKeyHex))) throw invalid('the signature does not verify');
  const effective = state.effective(agent);
  if (effective.status !== 'active') {
    throw new AgentJwtError(`the agent's effective status is ${effective.status}${effective.reason === null ? '' : ` (${effective.reason})`}, not active`, 'inactive');
  }
  if (!replay.use(`jti\n${did}\n${claims.jti}`, (claims.exp + CLOCK_LEEWAY_S) * 1000, now)) throw invalid('the jti was already used');
  return { agent, did, key, claims };
}

// ── the DPoP proof at the token endpoint ──

export interface DpopProof extends JwkKey {
  readonly jkt: string;
  readonly jti: string;
  /** POSIX seconds. */
  readonly iat: number;
}

/** The comparison form of `htu`: the scheme, the host and the path, with no query and no fragment. Null for a text that is not an http or https URL. */
function htuForm(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  return url.protocol === 'https:' || url.protocol === 'http:' ? `${url.protocol}//${url.host}${url.pathname}` : null;
}

const badProof = (description: string): OAuthError => new OAuthError(400, 'invalid_dpop_proof', description);

/** RFC 9449 Section 4.3, steps 1 to 11, for a request without an access token. */
export function verifyDpopProof(fieldValues: readonly string[] | undefined, options: { readonly method: string; readonly uri: string; readonly now: number }): DpopProof {
  if (!fieldValues || fieldValues.length === 0) throw badProof('a DPoP proof is required: the gateway issues only DPoP-bound tokens');
  if (fieldValues.length > 1) throw badProof('the request has more than one DPoP header field');
  let jws;
  try {
    jws = parseJws(fieldValues[0]!.trim());
  } catch (e) {
    throw badProof(`the DPoP proof is not a JWT: ${e instanceof JoseError ? e.message : 'parse error'}`);
  }
  const { header, payload } = jws;
  if (header.typ !== 'dpop+jwt') throw badProof('the DPoP proof typ must be dpop+jwt');
  const kind = algKeyKind(header.alg);
  if (kind === null) throw badProof('the DPoP proof algorithm must be EdDSA, Ed25519 or ES256');
  let key: JwkKey;
  try {
    key = publicJwkKey(header.jwk);
  } catch (e) {
    throw badProof(`the DPoP proof jwk is not acceptable: ${e instanceof JoseError ? e.message : 'invalid'}`);
  }
  if (key.kind !== kind) throw badProof('the DPoP proof algorithm does not match its key');
  if (!verifyJws(jws, kind, key.key)) throw badProof('the DPoP proof signature does not verify');
  if (typeof payload.jti !== 'string' || payload.jti.length === 0 || payload.jti.length > 256) throw badProof('the DPoP proof needs a jti of 1 to 256 characters');
  if (payload.htm !== options.method) throw badProof(`the DPoP proof htm must be ${options.method}`);
  const expected = htuForm(options.uri);
  if (typeof payload.htu !== 'string' || htuForm(payload.htu) === null || htuForm(payload.htu) !== expected) throw badProof(`the DPoP proof htu must be ${options.uri}`);
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) throw badProof('the DPoP proof needs iat');
  const nowS = options.now / 1000;
  if (payload.iat > nowS + CLOCK_LEEWAY_S || payload.iat < nowS - MAX_TOKEN_LIFETIME_S) throw badProof('the DPoP proof iat is outside the accepted window');
  return { ...key, jkt: jwkThumbprint(key.jwk), jti: payload.jti, iat: payload.iat };
}

/** A proof is accepted once while it is acceptable. */
export function useDpopProof(proof: DpopProof, replay: SingleUse, now: number): void {
  if (!replay.use(`dpop\n${proof.jkt}\n${proof.jti}`, (proof.iat + MAX_TOKEN_LIFETIME_S + CLOCK_LEEWAY_S) * 1000, now)) throw badProof('the DPoP proof was already used');
}

// ── the audiences and the authorization details ──

/** The `resource` and `audience` values of a request: the `aud` of the token. */
export function audiencesOf(params: Map<string, string[]>): string[] {
  const resources = params.get('resource') ?? [];
  for (const resource of resources) {
    let url: URL | null = null;
    try {
      url = new URL(resource);
    } catch {
      // handled below
    }
    if (url === null || resource.includes('#')) throw new OAuthError(400, 'invalid_target', 'each resource must be an absolute URI without a fragment');
  }
  const audiences = [...new Set([...resources, ...(params.get('audience') ?? [])])];
  if (audiences.length === 0) throw new OAuthError(400, 'invalid_target', "name the token's audience with resource or audience");
  if (audiences.length > MAX_AUDIENCES || audiences.some((a) => a.length > MAX_AUDIENCE_LENGTH)) throw new OAuthError(400, 'invalid_target', `at most ${MAX_AUDIENCES} audiences of at most ${MAX_AUDIENCE_LENGTH} characters`);
  return audiences;
}

export interface DelegationRequest {
  readonly identifier: string;
  readonly actions?: readonly string[];
  readonly locations?: readonly string[];
}

const invalidDetails = (description: string): OAuthError => new OAuthError(400, 'invalid_authorization_details', description);
const DETAIL_MEMBERS: Record<string, true> = { type: true, identifier: true, actions: true, locations: true };

function patternList(value: unknown, name: string, max: number, valid: (p: string) => boolean): string[] | undefined {
  if (value === undefined) return undefined;
  const items: unknown[] = Array.isArray(value) ? value : [];
  if (!Array.isArray(value) || items.length > max || !items.every((p): p is string => typeof p === 'string' && valid(p))) throw invalidDetails(`${name} must be a list of at most ${max} patterns as in Part 2 Section 5.1`);
  return items;
}

/** RFC 9396 `authorization_details`: exactly one object of the delegation type. */
export function parseDelegationRequest(text: string | undefined): DelegationRequest | null {
  if (text === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidDetails('authorization_details is not JSON');
  }
  if (!Array.isArray(value) || value.length !== 1 || value[0] === null || typeof value[0] !== 'object' || Array.isArray(value[0])) throw invalidDetails('authorization_details must be a list with one delegation object');
  const detail = value[0] as Record<string, unknown>;
  if (detail.type !== DELEGATION_DETAILS_TYPE) throw invalidDetails(`the authorization details type must be ${DELEGATION_DETAILS_TYPE}`);
  const unknown = Object.keys(detail).find((k) => DETAIL_MEMBERS[k] !== true);
  if (unknown !== undefined) throw invalidDetails(`unknown authorization details member ${unknown}`);
  if (typeof detail.identifier !== 'string' || !/^[0-9a-f]{64}$/.test(detail.identifier)) throw invalidDetails('identifier must be the delegation identifier (64 lowercase hex)');
  const actions = patternList(detail.actions, 'actions', MAX_ACTIONS, isActionPattern);
  if (actions !== undefined && actions.length === 0) throw invalidDetails('actions must not be empty');
  const locations = patternList(detail.locations, 'locations', MAX_LOCATIONS, isResourcePattern);
  if (locations !== undefined && locations.length === 0) throw invalidDetails('locations must not be empty: an empty resource list covers nothing');
  return { identifier: detail.identifier, ...(actions ? { actions } : {}), ...(locations ? { locations } : {}) };
}

// ── the use checks of a delegation chain ──

export interface ChainRequest {
  readonly leafId: string;
  /** The start of the time range of the token (POSIX ms). */
  readonly atMs: number;
  /** The identifier of the agent that must be the delegate of the leaf. */
  readonly delegate: string;
  readonly actions?: readonly string[];
  readonly resources?: readonly string[];
  /** The key hash that the request proved, which must be the `delegate_key` of the leaf; null when the request proved no Ed25519 key. */
  readonly provenKeyHash: string | null;
}

export interface CheckedChain {
  /** The leaf delegation first, then each parent up to the root. */
  readonly chain: readonly StubDelegation[];
  readonly delegate: StubAgent;
  /** The earliest `not_after` of the chain (POSIX ms): a token must end by then. */
  readonly notAfter: number;
}

export type ChainCheck = { readonly ok: true; readonly value: CheckedChain } | { readonly ok: false; readonly reason: string };

/** The live delegation with this identifier, or why there is none. The gateway reads it from the ledger. */
function readDelegation(state: StubState, id: string): { readonly ok: true; readonly record: StubDelegation } | { readonly ok: false; readonly reason: string } {
  const record = state.delegations.get(id);
  if (record === undefined) return { ok: false, reason: `delegation ${id} does not exist` };
  if (record.ended) return { ok: false, reason: `delegation ${id} was undelegated` };
  if (record.confirmations < 30) return { ok: false, reason: `delegation ${id} has fewer than 30 confirmations` };
  return { ok: true, record };
}

function agentActive(state: StubState, id: string): { readonly ok: true; readonly agent: StubAgent } | { readonly ok: false; readonly reason: string } {
  const agent = state.agent(id);
  if (agent === null) return { ok: false, reason: `agent ${id} is not registered` };
  const effective = state.effective(agent);
  if (effective.status !== 'active') return { ok: false, reason: `agent ${id} has effective status ${effective.status}, not active` };
  return { ok: true, agent };
}

/** Part 2 Section 5.2, use by a dependent contract, for the whole chain of `leafId` (identity-gateway/src/m4/delegation.ts, `checkDelegationChain`). */
export function checkDelegationChain(state: StubState, request: ChainRequest): ChainCheck {
  const chain: StubDelegation[] = [];
  let id: string | null = request.leafId;
  while (id !== null) {
    if (chain.length === MAX_DELEGATION_DEPTH) return { ok: false, reason: 'the delegation chain is deeper than 4' };
    if (chain.some((d) => d.id === id)) return { ok: false, reason: 'the delegation chain names one of its own delegations' };
    const lookup = readDelegation(state, id);
    if (!lookup.ok) return { ok: false, reason: lookup.reason };
    chain.push(lookup.record);
    id = lookup.record.parent;
  }
  if (chain[0]!.delegate !== request.delegate) return { ok: false, reason: 'the subject is not the delegate of the delegation' };

  // Links: chain[i + 1] is the parent of chain[i].
  const root = chain[chain.length - 1]!;
  if (root.depth !== 1) return { ok: false, reason: 'the root delegation does not have depth 1' };
  for (let i = 0; i + 1 < chain.length; i++) {
    const child = chain[i]!;
    const parent = chain[i + 1]!;
    if (child.delegator.type !== 'agent' || child.delegator.id !== parent.delegate) return { ok: false, reason: `delegation ${child.id} is not made by the delegate of its parent` };
    if (child.depth !== parent.depth + 1) return { ok: false, reason: `delegation ${child.id} has the wrong depth` };
    if (parent.remaining < 1 || child.remaining > parent.remaining - 1) return { ok: false, reason: `delegation ${child.id} exceeds the hops that its parent allows` };
    if (!narrower(parent.actions, child.actions) || !narrower(parent.resources, child.resources)) return { ok: false, reason: `delegation ${child.id} is not narrower than its parent` };
    if (child.notBefore < parent.notBefore || child.notAfter > parent.notAfter) return { ok: false, reason: `delegation ${child.id} is outside the period of its parent` };
    const limit = parent.value;
    if (limit !== null && (child.value === null || child.value.perTx > limit.perTx || child.value.total > limit.total || child.value.periodMs < limit.periodMs)) {
      return { ok: false, reason: `delegation ${child.id} exceeds the value limit of its parent` };
    }
  }
  if (chain.some((d) => d.depth + d.remaining > MAX_DELEGATION_DEPTH)) return { ok: false, reason: 'a delegation allows more hops than depth 4' };

  // Use checks.
  for (const d of chain) {
    if (request.atMs < d.notBefore || request.atMs >= d.notAfter) return { ok: false, reason: `the time is outside the period of delegation ${d.id}` };
    if (d.resources.length === 0) return { ok: false, reason: `delegation ${d.id} has an empty resource list, which covers no resource` };
    if (request.actions && !narrower(d.actions, request.actions)) return { ok: false, reason: `delegation ${d.id} does not cover the requested actions` };
    if (request.resources && !narrower(d.resources, request.resources)) return { ok: false, reason: `delegation ${d.id} does not cover the requested resources` };
  }
  // A delegator agent below the root is the delegate of the parent link, so its record must still list the delegate key of the parent.
  for (let i = 0; i < chain.length; i++) {
    const delegator = chain[i]!.delegator;
    if (delegator.type !== 'agent') continue;
    const status = agentActive(state, delegator.id);
    if (!status.ok) return { ok: false, reason: `delegator ${status.reason}` };
    const parent = chain[i + 1];
    if (parent !== undefined && !state.listsDelegationKey(status.agent, parent.delegateKey)) {
      return { ok: false, reason: `the delegate_key of delegation ${parent.id} is not a listed Ed25519 key of its delegate with the delegation purpose` };
    }
  }
  const leaf = chain[0]!;
  const delegate = agentActive(state, leaf.delegate);
  if (!delegate.ok) return { ok: false, reason: `delegate ${delegate.reason}` };
  if (!state.listsDelegationKey(delegate.agent, leaf.delegateKey)) return { ok: false, reason: 'the delegate_key is not a listed Ed25519 key of the delegate with the delegation purpose' };
  if (request.provenKeyHash !== leaf.delegateKey) return { ok: false, reason: 'the DPoP proof key is not the delegate_key of the delegation' };
  return { ok: true, value: { chain, delegate: delegate.agent, notAfter: Math.min(...chain.map((d) => d.notAfter)) } };
}

/** The `sub` and `act` claims of a delegation token (RFC 8693 Section 4.1): `sub` is the root delegator, and `act` nests the delegates with the requester outermost. */
export function delegationClaims(chain: readonly StubDelegation[], baseUrl: string): { readonly sub: string; readonly act: Record<string, unknown> } {
  const principal = chain[chain.length - 1]!.delegator;
  const sub = principal.type === 'agent' ? `did:vector:${principal.id}` : `${baseUrl}/principals/key/${principal.id}`;
  let act: Record<string, unknown> | null = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const actor = { sub: `did:vector:${chain[i]!.delegate}` };
    act = act === null ? actor : { ...actor, act };
  }
  return { sub, act: act! };
}

/** The RFC 9396 authorization details of a delegation token: the granted actions and resources. */
export function delegationDetails(leaf: StubDelegation, actions: readonly string[], resources: readonly string[]): Record<string, unknown> {
  return { type: DELEGATION_DETAILS_TYPE, identifier: leaf.id, actions: [...actions], locations: [...resources], ...(leaf.purpose === null ? {} : { purpose: leaf.purpose }) };
}
