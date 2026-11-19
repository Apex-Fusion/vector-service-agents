// packages/id-kit/src/testing/gateway.ts
// The stub gateway: the identity gateway in one process, with no network, for tests of this package and of the packages that use it. It answers every route that the client and the
// verifier call, with the wire formats of the real gateway (identity-gateway/src/m4/, and its DID resolution):
//   GET  /.well-known/jwks.json, GET /.well-known/oauth-authorization-server
//   POST /token                      token exchange, DPoP-bound tokens, delegation chains
//   POST /spiffe/nonce, POST /spiffe/x509-svid, POST /spiffe/jwt-svid, GET /spiffe/bundle
//   GET  /status/bsl/<n>, GET /status/tsl/<n>
//   GET  /agents/<identifier>/credential
//   GET  /1.0/identifiers/<did>      DID resolution
//   GET  /healthz
// It has no /introspect and no /revoke. The keys are keys that the test makes. The world (agents, keys, delegations, statuses) is the test's: build it with the methods below.
// `stub.fetch` is a `fetch` function that routes in process. Give it to the client and to the verifier. Give `stub.now` to both as their clock.

import { randomBytes } from 'node:crypto';
import { ACCESS_TOKEN_TYPE, DELEGATION_DETAILS_TYPE, JWT_TOKEN_TYPE, LIST_SIZE, MAX_TOKEN_LIFETIME_S, PURPOSE, TOKEN_EXCHANGE_GRANT } from '../common/constants.ts';
import { didOf, keyHashOf, vectorIdOf } from '../common/did.ts';
import { gatewayOrigin } from '../common/http.ts';
import { resolveKey } from '../common/keys.ts';
import { jwkThumbprint, publicJwkKey, signJws } from '../vendored/m4/jose.ts';
import { ed25519Key, identifier, p256Key, type TestKey } from './keys.ts';
import { StubLists, formatTime, listPosition } from './lists.ts';
import { multikey } from './multikey.ts';
import {
  AgentJwtError, OAuthError, SingleUse, audiencesOf, checkDelegationChain, delegationClaims, delegationDetails, invalidRequest, parseDelegationRequest, parseForm, parseJsonObject, single, useDpopProof, verifyAgentJwt, verifyDpopProof,
  type VerifiedAgentJwt,
} from './oauth.ts';
import { StubState, type AgentStatus, type Delegator, type ListedKey, type StubAgent, type StubDelegation } from './state.ts';
import { CsrError, derFromText, parseCertificationRequest, pem, signingCertificate, x509Svid, type CaKey, type SigningCertificate } from './x509.ts';
import type { KeyKind } from '../vendored/m4/jose.ts';

export interface StubGatewayOptions {
  /** The origin of the stub. The default is the origin of the live gateway: no network call is made, because `stub.fetch` answers in process. */
  readonly baseUrl?: string;
  /** The clock, in POSIX milliseconds. The default is a fixed clock that the test moves with `setNow` and `advance`. */
  readonly now?: () => number;
  /** The `ttl` of the status lists, in milliseconds. The default is one minute, as the gateway's. */
  readonly listRefreshMs?: number;
}

export interface AgentOptions {
  /** A name that fixes the identifier and the keys of the agent: the same in each run. Without it, a number does. */
  readonly label?: string;
  /** The name in the profile of the record. */
  readonly name?: string;
  /** The key of the subject tokens. The default is an Ed25519 key made from the label. */
  readonly authentication?: TestKey;
  /** The delegation key. The default is an Ed25519 key made from the label. */
  readonly delegation?: TestKey;
  /** The keys that the record lists. The default is the authentication key (purpose authentication) and the delegation key (purpose delegation). */
  readonly keys?: readonly ListedKey[];
  readonly status?: AgentStatus;
  /** The position of the agent in the status lists. The default is the next free one, from 0. */
  readonly statusIndex?: number;
  /** The parent of a subagent. A subagent has the status of its parents too. */
  readonly parent?: StubAgent;
  readonly organisation?: { readonly domain: string; readonly verified?: boolean };
  readonly capabilities?: readonly string[];
  readonly endpoint?: string;
}

export interface DelegationOptions {
  /** The root delegator: an agent, or a principal key (a key without a record). A sub-delegation names the delegate of its parent as its delegator. */
  readonly delegator: StubAgent | { readonly principalKey: TestKey | string; readonly organisation?: string };
  readonly delegate: StubAgent;
  /** The delegate key. The default is the delegation key of the delegate. */
  readonly delegateKey?: TestKey;
  readonly actions: readonly string[];
  readonly resources: readonly string[];
  /** The period, in POSIX ms. The default is from one hour before the clock to one day after. */
  readonly notBefore?: number;
  readonly notAfter?: number;
  /** The parent delegation of a sub-delegation. */
  readonly parent?: StubDelegation;
  /** The hops below this delegation. The default is 1 for a root and 0 for a sub-delegation. */
  readonly remaining?: number;
  /** A 32-byte hash of a purpose, in 64 hex characters. */
  readonly purpose?: string | null;
  readonly value?: { readonly perTx: bigint; readonly total: bigint; readonly periodMs: number } | null;
  /** The blocks that confirm the delegation. The default is 30, which counts. */
  readonly confirmations?: number;
  readonly id?: string;
}

/** A request that the stub received. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly path: string;
  /** The header fields, with lower case names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** What the stub answers instead of the real answer: a status with a body, or a failure of the network. */
export type Fault = { readonly status: number; readonly body?: string; readonly headers?: Readonly<Record<string, string>> } | 'network';

/** The answer of the live gateway while it builds its status lists, as a fault. */
export const LISTS_UNAVAILABLE = {
  status: 503,
  body: JSON.stringify({ error: 'temporarily_unavailable', error_description: 'the status lists could not be built from the ledger' }),
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '5' },
} as const satisfies Fault;

export interface StubGateway {
  readonly baseUrl: string;
  readonly trustDomain: string;
  readonly gatewayDid: string;
  /** The keys of the gateway: Ed25519 for agent cards, and P-256 for everything that it signs. */
  readonly keys: { readonly ed25519: TestKey; readonly p256: TestKey };
  readonly fetch: typeof fetch;
  /** Every request that the stub received, in order. */
  readonly requests: RecordedRequest[];
  now(): number;
  setNow(ms: number): void;
  advance(ms: number): void;
  createAgent(options?: AgentOptions): StubAgent;
  /** Changes the status of an agent. The gateway revokes the tokens that depend on it. */
  setStatus(agent: StubAgent, status: AgentStatus, reason?: string): void;
  /** Takes a key out of the record of the agent. */
  removeKey(agent: StubAgent, key: TestKey | string): void;
  setPurposes(agent: StubAgent, key: TestKey | string, purposes: number): void;
  delegate(options: DelegationOptions): StubDelegation;
  /** An Undelegate: the delegation ends, and so does every delegation below it. */
  endDelegation(delegation: StubDelegation | string): void;
  readonly lists: {
    /** The lists stay as they are until `thaw` or `refresh`. A test then moves the clock to age them. */
    freeze(): void;
    thaw(): void;
    /** Builds the lists again now. */
    refresh(): void;
    /** The time that the lists in use were built, in POSIX ms. */
    builtAt(): number;
  };
  /** Makes the stub answer one path with a fault. `null` takes the fault away. */
  fault(path: string, fault: Fault | null): void;
}

const BACKDATE_MS = 60_000;
const X509_SVID_LIFETIME_MS = 3_600_000;
const NONCE_LIFETIME_MS = 300_000;
const BUNDLE_REFRESH_HINT_S = 300;
const CREDENTIAL_VALIDITY_MS = 86_400_000;
const KEY_SET_MAX_AGE_S = 300;
const NO_STORE = { 'cache-control': 'no-store' } as const;

const STATUS_LIST = /^\/status\/(bsl|tsl)\/(0|[1-9][0-9]{0,8})$/;
const CREDENTIAL = /^\/agents\/([0-9a-f]{64})\/credential$/;
const RESOLUTION_PREFIX = '/1.0/identifiers/';
const PURPOSE_NAMES: ReadonlyArray<readonly [string, number]> = [['authentication', PURPOSE.authentication], ['assertion', PURPOSE.assertion], ['transaction', PURPOSE.transaction], ['delegation', PURPOSE.delegation]];

const jsonResponse = (status: number, value: unknown, headers: Readonly<Record<string, string>> = NO_STORE): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const publicData = (maxAgeSeconds: number): Record<string, string> => ({ 'cache-control': `public, max-age=${maxAgeSeconds}`, 'access-control-allow-origin': '*' });
const errorResponse = (e: OAuthError): Response => jsonResponse(e.status, { error: e.code, error_description: e.message }, { ...NO_STORE, ...e.headers });

/** A DID resolution result for an error (DID Resolution v1.0). */
const resolutionError = (status: number, type: string, title: string): Response =>
  new Response(JSON.stringify({ didDocument: null, didResolutionMetadata: { error: { type: `https://www.w3.org/ns/did#${type}`, title } }, didDocumentMetadata: {} }), {
    status,
    headers: { 'content-type': 'application/did-resolution', ...NO_STORE },
  });

interface Call {
  readonly request: RecordedRequest;
}

type Handler = (call: Call) => Response | Promise<Response>;

export function createStubGateway(options: StubGatewayOptions = {}): StubGateway {
  const baseUrl = gatewayOrigin(options.baseUrl ?? 'https://id.vector.apexfusion.org');
  const trustDomain = new URL(baseUrl).hostname;
  const tokenEndpoint = `${baseUrl}/token`;
  const gatewayDid = didOf(identifier(`stub gateway ${baseUrl}`));
  const keys = { ed25519: ed25519Key(`stub gateway ed25519 ${baseUrl}`), p256: p256Key(`stub gateway p256 ${baseUrl}`) };
  const signer = resolveKey(keys.p256.privateKey);
  const kid = `${gatewayDid}#${keys.p256.keyHash}`;
  const caKey: CaKey = { key: signer, spki: Buffer.from(keys.p256.publicKey.export({ format: 'der', type: 'spki' })) };

  const state = new StubState(options.now ?? null);
  const replay = new SingleUse();
  const lists = new StubLists(state, { baseUrl, gatewayDid, key: signer, kid, refreshMs: options.listRefreshMs ?? 60_000 });
  const requests: RecordedRequest[] = [];
  const faults = new Map<string, Fault>();
  const nonces = new Map<string, number>();
  const bundleSequence = Math.floor(state.now() / 1000);
  let ca: Promise<SigningCertificate> | null = null;

  const jwkOf = (key: TestKey): Record<string, unknown> => ({ ...key.jwk, kid: `${gatewayDid}#${key.keyHash}`, alg: key.kind === 'Ed25519' ? 'EdDSA' : 'ES256', use: 'sig' });
  const newJti = (): string => randomBytes(16).toString('base64url');
  const spiffeIdOf = (id: string): string => `spiffe://${trustDomain}/agent/${id}`;

  /** The signing certificate of the trust domain: built once, with its own serial number and a start time one minute before the first use. */
  const signingCert = (): Promise<SigningCertificate> => (ca ??= signingCertificate(caKey, trustDomain, state.now() - BACKDATE_MS));

  /** The agent JWT rules at the SPIFFE endpoints; a refused JWT is `code` (400), and an agent whose status is not Active is agent_not_active (403). */
  function agentJwt(token: unknown, kinds: readonly KeyKind[], name: string, code: string): VerifiedAgentJwt {
    try {
      return verifyAgentJwt(state, replay, token, { audience: tokenEndpoint, kinds });
    } catch (e) {
      if (!(e instanceof AgentJwtError)) throw e;
      throw e.reason === 'inactive' ? new OAuthError(403, 'agent_not_active', `${name}: ${e.message}`) : new OAuthError(400, code, `${name}: ${e.message}`);
    }
  }

  /** The subject token of a token request (RFC 8693 Section 2.2.2): a token that is invalid, or that the gateway cannot accept, is invalid_request, whatever the reason. */
  function subjectToken(token: unknown): VerifiedAgentJwt {
    try {
      return verifyAgentJwt(state, replay, token, { audience: tokenEndpoint, kinds: ['Ed25519'] });
    } catch (e) {
      if (e instanceof AgentJwtError) throw invalidRequest(`subject_token: ${e.message}`);
      throw e;
    }
  }

  // ── POST /token ──

  async function token(call: Call): Promise<Response> {
    const { headers, body } = call.request;
    const params = parseForm(headers['content-type'] ?? null, body);
    const grantType = single(params, 'grant_type');
    if (grantType === undefined) throw invalidRequest('grant_type is missing');
    if (grantType !== TOKEN_EXCHANGE_GRANT) throw new OAuthError(400, 'unsupported_grant_type', `the gateway supports only ${TOKEN_EXCHANGE_GRANT}`);
    const subjectText = single(params, 'subject_token');
    if (subjectText === undefined) throw invalidRequest('subject_token is missing');
    if (single(params, 'subject_token_type') !== JWT_TOKEN_TYPE) throw invalidRequest(`subject_token_type must be ${JWT_TOKEN_TYPE}`);
    if (params.has('actor_token') || params.has('actor_token_type')) throw invalidRequest('the gateway does not accept actor tokens');
    const requestedType = single(params, 'requested_token_type') ?? ACCESS_TOKEN_TYPE;
    if (requestedType !== ACCESS_TOKEN_TYPE && requestedType !== JWT_TOKEN_TYPE) throw invalidRequest(`requested_token_type must be ${ACCESS_TOKEN_TYPE} or ${JWT_TOKEN_TYPE}`);
    if (single(params, 'scope') !== undefined) throw new OAuthError(400, 'invalid_scope', 'the gateway issues no scopes; name a delegation in authorization_details');
    const audiences = audiencesOf(params);
    const delegationRequest = parseDelegationRequest(single(params, 'authorization_details'));
    if (params.has('client_assertion') || params.has('client_assertion_type') || params.has('client_id')) throw new OAuthError(401, 'invalid_client', 'the stub gateway does not authenticate clients');

    const dpopValues = headers.dpop === undefined ? undefined : headers.dpop.split(',').map((v) => v.trim());
    const proof = verifyDpopProof(dpopValues, { method: 'POST', uri: tokenEndpoint, now: state.now() });
    const subject = subjectToken(subjectText);
    // The proof is used up only now that the subject token verified: a request that does not authenticate writes nothing to the single-use store.
    useDpopProof(proof, replay, state.now());

    const now = state.now();
    const iat = Math.floor(now / 1000);
    let exp = iat + MAX_TOKEN_LIFETIME_S;
    let delegated: ({ sub: string; act: Record<string, unknown>; details: Record<string, unknown>; agents: string[] }) | null = null;
    if (delegationRequest !== null) {
      const check = checkDelegationChain(state, {
        leafId: delegationRequest.identifier,
        atMs: iat * 1000,
        delegate: subject.agent.id,
        ...(delegationRequest.actions ? { actions: delegationRequest.actions } : {}),
        ...(delegationRequest.locations ? { resources: delegationRequest.locations } : {}),
        provenKeyHash: proof.kind === 'Ed25519' ? keyHashOf(proof.publicKey) : null,
      });
      if (!check.ok) throw new OAuthError(400, 'invalid_authorization_details', check.reason);
      const { chain, notAfter } = check.value;
      exp = Math.min(exp, Math.floor(notAfter / 1000));
      if (exp <= iat) throw new OAuthError(400, 'invalid_authorization_details', 'the delegation period ends within a second');
      const leaf = chain[0]!;
      delegated = {
        ...delegationClaims(chain, baseUrl),
        details: delegationDetails(leaf, delegationRequest.actions ?? leaf.actions, delegationRequest.locations ?? leaf.resources),
        agents: chain.flatMap((d) => (d.delegator.type === 'agent' ? [d.delegator.id] : [])),
      };
    }

    const { n, p } = listPosition(subject.agent.index);
    const jti = newJti();
    const claims = {
      iss: baseUrl,
      sub: delegated?.sub ?? subject.did,
      aud: audiences.length === 1 ? audiences[0] : audiences,
      iat,
      exp,
      jti,
      client_id: subject.did,
      cnf: { jkt: proof.jkt },
      status: { status_list: { idx: p, uri: `${baseUrl}/status/tsl/${n}` } },
      ...(delegated ? { act: delegated.act, authorization_details: [delegated.details] } : {}),
    };
    const accessToken = await signJws({ alg: 'ES256', kid, typ: 'at+jwt' }, claims, signer);
    state.recordIssued({ jti, kind: 'access_token', agents: [...new Set([subject.agent.id, ...(delegated?.agents ?? [])])], issuedAt: now, expiresAt: exp * 1000 });
    return jsonResponse(200, { access_token: accessToken, issued_token_type: requestedType, token_type: 'DPoP', expires_in: exp - iat, ...(delegated ? { authorization_details: [delegated.details] } : {}) });
  }

  // ── SPIFFE ──

  function nonce(): Response {
    const value = randomBytes(40).toString('base64url');
    nonces.set(value, state.now());
    return jsonResponse(200, { nonce: value, expires_in: NONCE_LIFETIME_MS / 1000 });
  }

  /** Uses a nonce up. "unknown": the stub did not issue it, or it is used. "expired": it is older than its life. */
  function consumeNonce(value: string): 'ok' | 'unknown' | 'expired' {
    const issuedAt = nonces.get(value);
    if (issuedAt === undefined) return 'unknown';
    if (state.now() - issuedAt > NONCE_LIFETIME_MS) return 'expired';
    nonces.delete(value);
    return 'ok';
  }

  async function x509(call: Call): Promise<Response> {
    const body = parseJsonObject(call.request.headers['content-type'] ?? null, call.request.body);
    const der = typeof body.csr === 'string' ? derFromText(body.csr, ['CERTIFICATE REQUEST', 'NEW CERTIFICATE REQUEST']) : null;
    if (der === null) throw new OAuthError(400, 'invalid_request', 'csr must be a PEM certificate request or base64url DER');
    let csr;
    try {
      csr = parseCertificationRequest(der);
    } catch (e) {
      throw new OAuthError(400, 'invalid_csr', e instanceof CsrError ? e.message : 'the certificate request is not valid');
    }
    const proof = agentJwt(body.proof, ['Ed25519', 'P256'], 'proof', 'invalid_proof');
    const cnf = proof.claims.cnf;
    const proofJwk = cnf !== null && typeof cnf === 'object' && 'jwk' in cnf ? cnf.jwk : undefined;
    let proofKey: string | null = null;
    try {
      proofKey = jwkThumbprint(publicJwkKey(proofJwk).jwk);
    } catch {
      // A missing or invalid JWK names no key.
    }
    if (proofKey !== jwkThumbprint(csr.jwk)) throw new OAuthError(400, 'invalid_proof', 'proof: cnf.jwk must be the public key of the certificate request');
    if (typeof proof.claims.nonce !== 'string') throw new OAuthError(400, 'invalid_nonce', 'proof: the nonce claim is missing');
    const nonceCheck = consumeNonce(proof.claims.nonce);
    if (nonceCheck !== 'ok') throw new OAuthError(400, 'invalid_nonce', nonceCheck === 'expired' ? 'the nonce is older than 5 minutes' : 'the nonce is unknown or was already used');
    const spiffeId = spiffeIdOf(proof.agent.id);
    const notBeforeMs = state.now() - BACKDATE_MS;
    const notAfterMs = notBeforeMs + X509_SVID_LIFETIME_MS;
    const issuer = await signingCert();
    const svid = await x509Svid(caKey, issuer, { spki: csr.spki, spiffeId, notBeforeMs, notAfterMs });
    return jsonResponse(200, { spiffe_id: spiffeId, x509_svid: pem('CERTIFICATE', svid), bundle: pem('CERTIFICATE', issuer.der), expires_at: Math.floor(notAfterMs / 1000) });
  }

  async function jwtSvid(call: Call): Promise<Response> {
    const body = parseJsonObject(call.request.headers['content-type'] ?? null, call.request.body);
    const audience = typeof body.audience === 'string' ? [body.audience] : body.audience;
    if (!Array.isArray(audience) || audience.length === 0 || audience.length > 8 || !audience.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 512)) {
      throw new OAuthError(400, 'invalid_request', 'audience must be 1 to 8 non-empty strings');
    }
    const subject = agentJwt(body.subject_token, ['Ed25519'], 'subject_token', 'invalid_request');
    const now = state.now();
    const iat = Math.floor(now / 1000);
    const exp = iat + MAX_TOKEN_LIFETIME_S;
    const jti = newJti();
    const spiffeId = spiffeIdOf(subject.agent.id);
    // JWT-SVID Section 2: only alg, kid and typ in the header.
    const svid = await signJws({ alg: 'ES256', kid, typ: 'JWT' }, { sub: spiffeId, aud: audience.length === 1 ? audience[0] : audience, iat, exp, jti }, signer);
    state.recordIssued({ jti, kind: 'jwt_svid', agents: [subject.agent.id], issuedAt: now, expiresAt: exp * 1000 });
    return jsonResponse(200, { spiffe_id: spiffeId, svid, expires_at: exp });
  }

  async function bundle(): Promise<Response> {
    const issuer = await signingCert();
    const key = { ...keys.p256.jwk };
    return jsonResponse(
      200,
      {
        spiffe_sequence: bundleSequence,
        spiffe_refresh_hint: BUNDLE_REFRESH_HINT_S,
        keys: [
          // X509-SVID Section 6.1: use x509-svid, no kid, x5c with the CA certificate. JWT-SVID Section 6.1: use jwt-svid, kid set.
          { ...key, use: 'x509-svid', x5c: [issuer.der.toString('base64')] },
          { ...key, use: 'jwt-svid', kid },
        ],
      },
      publicData(BUNDLE_REFRESH_HINT_S),
    );
  }

  // ── status lists, credential, resolution ──

  async function statusList(kind: 'bsl' | 'tsl', n: number): Promise<Response> {
    const signed = await lists.signedList(kind, n);
    if (signed === null) throw new OAuthError(404, 'not_found', 'no such status list');
    const contentType = kind === 'bsl' ? 'application/vc+jwt' : 'application/statuslist+jwt';
    return new Response(signed, { status: 200, headers: { 'content-type': contentType, ...publicData(Math.max(1, Math.round((options.listRefreshMs ?? 60_000) / 1000))) } });
  }

  async function credential(id: string): Promise<Response> {
    const agent = state.agent(id);
    if (agent === null) throw new OAuthError(404, 'not_found', 'the DID does not resolve to a registered agent');
    const effective = state.effective(agent);
    if (effective.status === 'revoked' || effective.status === 'retired') throw new OAuthError(410, 'deactivated', `the DID is deactivated (effective status ${effective.status})`);
    if (effective.status !== 'active') throw new OAuthError(409, 'agent_not_active', `the agent's effective status is ${effective.status}${effective.reason === null ? '' : ` (${effective.reason})`}`);
    const { n, p } = listPosition(agent.index);
    const list = `${baseUrl}/status/bsl/${n}`;
    const entry = (purpose: 'revocation' | 'suspension', index: number): Record<string, string> => ({ id: `${list}#${index}`, type: 'BitstringStatusListEntry', statusPurpose: purpose, statusListIndex: String(index), statusListCredential: list });
    const now = state.now();
    const claims = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', 'VectorAgentIdentityCredential'],
      issuer: gatewayDid,
      validFrom: formatTime(now),
      validUntil: formatTime(now + CREDENTIAL_VALIDITY_MS),
      credentialSubject: { id: agent.did, created: formatTime(agent.created), origin: 'registered', ...(agent.parent === null ? {} : { parent: didOf(agent.parent) }) },
      credentialStatus: [entry('revocation', p), entry('suspension', LIST_SIZE + p)],
    };
    const jwt = await signJws({ alg: 'ES256', kid, typ: 'vc+jwt', cty: 'vc' }, claims, signer);
    return new Response(jwt, { status: 200, headers: { 'content-type': 'application/vc+jwt', ...NO_STORE } });
  }

  function resolution(encoded: string): Response {
    let did: string;
    try {
      did = decodeURIComponent(encoded);
    } catch {
      return resolutionError(400, 'INVALID_DID', 'Invalid DID: the path is not valid percent-encoding');
    }
    const id = vectorIdOf(did);
    if (id === null) return resolutionError(400, 'INVALID_DID', 'Invalid DID: not a did:vector identifier of 64 lowercase hex characters');
    const agent = state.agent(id);
    if (agent === null) return resolutionError(404, 'NOT_FOUND', 'DID not found: no confirmed version');
    const effective = state.effective(agent);
    const ended = effective.status === 'revoked' || effective.status === 'retired';
    const purposesOf = (k: ListedKey): string[] => PURPOSE_NAMES.filter(([, bit]) => (k.purposes & bit) !== 0).map(([name]) => name);
    const refs = (name: string): string[] => agent.keys.filter((k) => purposesOf(k).includes(name)).map((k) => `#${k.key.keyHash}`);
    const document = {
      '@context': 'https://www.w3.org/ns/did/v1.1',
      id: did,
      verificationMethod: agent.keys.map((k) => ({ id: `${did}#${k.key.keyHash}`, type: 'Multikey', controller: did, publicKeyMultibase: multikey(k.key.kind, k.key.publicKeyHex) })),
      ...(refs('authentication').length === 0 ? {} : { authentication: refs('authentication') }),
      ...(refs('assertion').length === 0 ? {} : { assertionMethod: refs('assertion') }),
      ...(refs('delegation').length === 0 ? {} : { capabilityDelegation: refs('delegation') }),
    };
    const created = formatTime(agent.created);
    const metadata = {
      canonicalId: did,
      created,
      updated: created,
      versionId: '1',
      vectorOrigin: 'registered',
      vectorStatus: { status: agent.status, effective: effective.status, ...(effective.reason === null ? {} : { effectiveReason: effective.reason }), ...(agent.statusReason === null ? {} : { reason: agent.statusReason }) },
      vectorKeys: agent.keys.map((k) => ({ id: `#${k.key.keyHash}`, type: k.key.kind === 'Ed25519' ? 'Ed25519' : 'P-256', ...(purposesOf(k).length === 0 ? {} : { purposes: purposesOf(k) }) })),
      ...(agent.organisation === null
        ? {}
        : { vectorParties: [{ role: 'accountable', signer: 'controller', organisation: agent.organisation.domain, ...(agent.organisation.verified ? { organisationVerified: true } : {}), rights: ['suspend', 'revoke'], notBefore: created }] }),
      vectorProfile: { name: agent.name, ...(agent.capabilities.length === 0 ? {} : { capabilities: agent.capabilities }), ...(agent.endpoint === null ? {} : { endpoint: agent.endpoint }), createdAt: created },
      ...(agent.parent === null ? {} : { vectorParent: { parent: didOf(agent.parent), parentEpoch: 0, depth: 1 } }),
      ...(ended ? { deactivated: true } : {}),
    };
    const result = { didDocument: ended ? null : document, didResolutionMetadata: ended ? {} : { contentType: 'application/did' }, didDocumentMetadata: metadata };
    return new Response(JSON.stringify(result), { status: ended ? 410 : 200, headers: { 'content-type': 'application/did-resolution', ...NO_STORE } });
  }

  // ── the routes ──

  const fixed: Record<string, { readonly method: 'GET' | 'POST'; readonly handler: Handler }> = {
    '/.well-known/jwks.json': { method: 'GET', handler: () => jsonResponse(200, { keys: [jwkOf(keys.ed25519), jwkOf(keys.p256)] }, publicData(KEY_SET_MAX_AGE_S)) },
    '/.well-known/oauth-authorization-server': {
      method: 'GET',
      handler: () =>
        jsonResponse(
          200,
          {
            issuer: baseUrl,
            token_endpoint: tokenEndpoint,
            jwks_uri: `${baseUrl}/.well-known/jwks.json`,
            response_types_supported: [],
            grant_types_supported: [TOKEN_EXCHANGE_GRANT],
            token_endpoint_auth_methods_supported: ['private_key_jwt', 'none'],
            token_endpoint_auth_signing_alg_values_supported: ['EdDSA', 'Ed25519'],
            dpop_signing_alg_values_supported: ['EdDSA', 'Ed25519', 'ES256'],
            authorization_details_types_supported: [DELEGATION_DETAILS_TYPE],
          },
          publicData(KEY_SET_MAX_AGE_S),
        ),
    },
    '/token': { method: 'POST', handler: token },
    '/spiffe/nonce': { method: 'POST', handler: nonce },
    '/spiffe/x509-svid': { method: 'POST', handler: x509 },
    '/spiffe/jwt-svid': { method: 'POST', handler: jwtSvid },
    '/spiffe/bundle': { method: 'GET', handler: bundle },
    '/healthz': { method: 'GET', handler: () => jsonResponse(200, { status: 'ok' }) },
  };

  function endpointOf(path: string): { readonly method: 'GET' | 'POST'; readonly handler: Handler } | null {
    if (Object.prototype.hasOwnProperty.call(fixed, path)) return fixed[path]!;
    const list = STATUS_LIST.exec(path);
    if (list) return { method: 'GET', handler: () => statusList(list[1] === 'bsl' ? 'bsl' : 'tsl', Number(list[2])) };
    const credentialMatch = CREDENTIAL.exec(path);
    if (credentialMatch) return { method: 'GET', handler: () => credential(credentialMatch[1]!) };
    if (path.startsWith(RESOLUTION_PREFIX)) return { method: 'GET', handler: () => resolution(path.substring(RESOLUTION_PREFIX.length)) };
    return null;
  }

  async function dispatch(request: RecordedRequest): Promise<Response> {
    const endpoint = endpointOf(request.path);
    if (endpoint === null) return new Response('not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...NO_STORE } });
    if (request.method !== endpoint.method) return jsonResponse(405, { error: 'invalid_request', error_description: `use ${endpoint.method}` }, { ...NO_STORE, allow: endpoint.method });
    try {
      return await endpoint.handler({ request });
    } catch (e) {
      if (e instanceof OAuthError) return errorResponse(e);
      throw e;
    }
  }

  const stubFetch: typeof fetch = async (input, init) => {
    const incoming = new Request(input, init);
    incoming.signal.throwIfAborted();
    const url = new URL(incoming.url);
    const recorded: RecordedRequest = {
      method: incoming.method,
      url: incoming.url,
      path: url.pathname,
      headers: Object.fromEntries(incoming.headers),
      body: incoming.method === 'GET' || incoming.method === 'HEAD' ? '' : await incoming.text(),
    };
    requests.push(recorded);
    if (url.origin !== baseUrl) throw new TypeError(`fetch failed: the stub gateway serves ${baseUrl} only, not ${url.origin}`);
    const fault = faults.get(url.pathname);
    if (fault === 'network') throw new TypeError('fetch failed: the stub gateway simulates a network failure');
    if (fault !== undefined) return new Response(fault.body ?? '', { status: fault.status, headers: fault.headers });
    return dispatch(recorded);
  };

  // ── the world of the test ──

  const hashOfKey = (key: TestKey | string): string => (typeof key === 'string' ? key : key.keyHash);

  return {
    baseUrl,
    trustDomain,
    gatewayDid,
    keys,
    fetch: stubFetch,
    requests,
    now: () => state.now(),
    setNow: (ms) => state.setNow(ms),
    advance: (ms) => state.setNow(state.now() + ms),

    createAgent(agentOptions = {}) {
      const number = state.nextAgentNumber();
      const seed = agentOptions.label ?? `agent ${number}`;
      const id = identifier(`stub agent ${seed}`);
      if (state.agents.has(id)) throw new Error(`the stub gateway has an agent with the label ${seed}`);
      const authentication = agentOptions.authentication ?? ed25519Key(`${seed}/authentication`);
      const delegation = agentOptions.delegation ?? ed25519Key(`${seed}/delegation`);
      const index = agentOptions.statusIndex ?? [...state.agents.values()].reduce((next, a) => Math.max(next, a.index + 1), 0);
      if ([...state.agents.values()].some((a) => a.index === index)) throw new Error(`the status list position ${index} is taken`);
      const agent: StubAgent = {
        id,
        did: didOf(id),
        name: agentOptions.name ?? seed,
        index,
        keys: [...(agentOptions.keys ?? [{ key: authentication, purposes: PURPOSE.authentication }, { key: delegation, purposes: PURPOSE.delegation }])],
        authentication,
        delegation,
        parent: agentOptions.parent?.id ?? null,
        created: state.now(),
        status: agentOptions.status ?? 'active',
        statusReason: null,
        organisation: agentOptions.organisation === undefined ? null : { domain: agentOptions.organisation.domain, verified: agentOptions.organisation.verified ?? false },
        capabilities: [...(agentOptions.capabilities ?? [])],
        endpoint: agentOptions.endpoint ?? null,
      };
      state.agents.set(id, agent);
      return agent;
    },

    setStatus(agent, status, reason) {
      agent.status = status;
      agent.statusReason = reason ?? null;
      state.watchStatuses();
    },

    removeKey(agent, key) {
      const at = agent.keys.findIndex((k) => k.key.keyHash === hashOfKey(key));
      if (at < 0) throw new Error('the record of the agent does not list this key');
      agent.keys.splice(at, 1);
    },

    setPurposes(agent, key, purposes) {
      const listed = agent.keys.find((k) => k.key.keyHash === hashOfKey(key));
      if (listed === undefined) throw new Error('the record of the agent does not list this key');
      listed.purposes = purposes;
    },

    delegate(spec) {
      const now = state.now();
      const delegator: Delegator = 'principalKey' in spec.delegator
        ? { type: 'key', id: hashOfKey(spec.delegator.principalKey), organisation: spec.delegator.organisation ?? null }
        : { type: 'agent', id: spec.delegator.id, organisation: null };
      const id = spec.id ?? identifier(`stub delegation ${state.nextDelegationNumber()}`);
      const record: StubDelegation = {
        id,
        delegator,
        parent: spec.parent?.id ?? null,
        delegate: spec.delegate.id,
        delegateKey: (spec.delegateKey ?? spec.delegate.delegation).keyHash,
        actions: [...spec.actions],
        resources: [...spec.resources],
        notBefore: spec.notBefore ?? now - 3_600_000,
        notAfter: spec.notAfter ?? now + 86_400_000,
        depth: spec.parent === undefined ? 1 : spec.parent.depth + 1,
        remaining: spec.remaining ?? (spec.parent === undefined ? 1 : 0),
        purpose: spec.purpose ?? null,
        value: spec.value ?? null,
        confirmations: spec.confirmations ?? 30,
        ended: false,
      };
      state.delegations.set(id, record);
      return record;
    },

    endDelegation(delegation) {
      const record = state.delegations.get(typeof delegation === 'string' ? delegation : delegation.id);
      if (record === undefined) throw new Error('the stub gateway has no such delegation');
      record.ended = true;
    },

    lists: {
      freeze() {
        lists.rebuild();
        lists.frozen = true;
      },
      thaw() {
        lists.frozen = false;
      },
      refresh() {
        lists.rebuild();
      },
      builtAt: () => lists.builtAt,
    },

    fault(path, fault) {
      if (fault === null) faults.delete(path);
      else faults.set(path, fault);
    },
  };
}
