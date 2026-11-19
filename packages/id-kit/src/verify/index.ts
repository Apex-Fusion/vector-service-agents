// packages/id-kit/src/verify/index.ts
// The verifier of the identity gateway for a relying party (a mock system, a service): `createVerifier` reads what the gateway publishes (key set, bundle, status lists) through
// a reader with a cache, and checks an access token with its DPoP proof, a JWT-SVID, an X.509-SVID and an identity credential. Every check returns a typed result: `ok` with the
// facts, or a refusal that names the rule that failed. The pure checks under it (`checkAccessToken`, `decodeTokenStatusList`, `verifyX509Svid`, and the others) are exported too.
//
// A token whose authority ended is never honoured: a token that has expired, a status entry that reads revoked or suspended, an actor that is no longer Active (when the caller gives
// `checkActors`) and a delegation that the ledger no longer shows (when the caller gives `checkDelegation`) each refuse the call. A status list that cannot be read, or that is old,
// refuses nothing: the result says `read: false`, so that the caller can write it to its log. The caller decides what that costs.

import { MAX_DELEGATION_DEPTH, MAX_TOKEN_LIFETIME_S } from '../common/constants.ts';
import { accept, refuse, type Check } from '../common/result.ts';
import type { GatewayClient } from '../client/index.ts';
import { ACCESS_TOKEN_RULES, checkAccessToken, parseAuthorization, type AccessTokenContext, type AccessTokenRule, type DelegationGrant, type Principal, type RequiredGrant, type VerifiedAccessToken } from './access-token.ts';
import { checkCredential, type CredentialRule, type VerifiedCredential } from './credential.ts';
import { KEY_SET_RULES, type KeySet } from './keys.ts';
import { createGatewayReader, isSoftListRule, type BundleReadRule, type GatewayReader, type GatewayReaderOptions, type KeysRule } from './reader.ts';
import { createReplayStore, type ReplayStore } from './replay.ts';
import { bitstringEntryStatus, tokenEntryStatus } from './status-list.ts';
import { verifyJwtSvid, verifyX509Svid, type JwtSvidRule, type VerifiedJwtSvid, type VerifiedX509Svid, type X509SvidRule } from './svid.ts';

export interface VerifierOptions extends GatewayReaderOptions {
  /** The store of the DPoP proofs that the verifier accepted. The default is a new store for this verifier. */
  readonly replay?: ReplayStore;
  /** The longest life of an access token that the verifier accepts, in seconds. The default is 300, the gateway's. */
  readonly maxLifetimeSeconds?: number;
  /** The most levels of the `act` chain. The default is 4, the longest delegation chain. */
  readonly maxActDepth?: number;
}

/** The result of a read of a status list that did not refuse the call. */
export type StatusReading =
  /** The list was read, and the entry is valid. `refreshError` is set when the reader used an older copy because a fresh one could not be read. */
  | { readonly read: true; readonly list: string; readonly fetchedAt: number; readonly refreshError: string | null }
  /** The list was not read: it could not be fetched (`unavailable`), or it is over (`stale`). The call is not refused. The caller logs `detail`. */
  | { readonly read: false; readonly list: string; readonly reason: 'unavailable' | 'stale'; readonly detail: string };

export interface CallRequest {
  /** The `Authorization` header field, `DPoP <token>`. Give it, or `accessToken`. */
  readonly authorization?: string;
  readonly accessToken?: string;
  /** The `DPoP` header field of the request. */
  readonly dpop: string | readonly string[] | undefined;
  readonly method: string;
  /** The URL of the request as the client sees it: the public URL. */
  readonly url: string;
}

/** The answer of a check that the caller supplies: the call goes on, or it is refused for `detail`. A check that throws is a refusal. */
export type AuthorityVerdict = { readonly ok: true } | { readonly ok: false; readonly detail: string };
/** Checks agents by DID, for example that each is Active. `agents` are the actors of the token, the principal when it is an agent, and the agent that asked. */
export type ActorCheck = (agents: readonly string[]) => Promise<AuthorityVerdict> | AuthorityVerdict;

export interface DelegationContext {
  readonly delegation: DelegationGrant;
  readonly principal: Principal;
  readonly actors: readonly string[];
  /** The action and the resource of the call, when the policy names them. */
  readonly require: RequiredGrant | null;
  readonly nowMs: number;
}
/** An extra check of the delegation of a token, for example a check of its whole chain on the ledger. It runs for a token that has a delegation. */
export type DelegationCheck = (context: DelegationContext) => Promise<AuthorityVerdict> | AuthorityVerdict;

export interface AccessTokenPolicy {
  /** The identifier of this resource: the audience of the token must name it. */
  readonly audience: string;
  /** The action and the resource of this call. When given, the token must have a delegation, and a pattern of its grant must cover each of them. */
  readonly require?: RequiredGrant;
  readonly checkActors?: ActorCheck;
  readonly checkDelegation?: DelegationCheck;
}

export type VerifiedCall = VerifiedAccessToken & {
  /** What the Token Status List says about the agent that asked for the token. */
  readonly status: StatusReading;
};

export const CALL_RULES = [...ACCESS_TOKEN_RULES, 'keys.unavailable', ...KEY_SET_RULES, 'status.revoked', 'status.suspended', 'status.value', 'status.list', 'actors.refused', 'delegation.refused'] as const;
export type CallRule = AccessTokenRule | KeysRule | 'status.revoked' | 'status.suspended' | 'status.value' | 'status.list' | 'actors.refused' | 'delegation.refused';

export const CREDENTIAL_CALL_RULES = ['credential.revoked', 'credential.suspended', 'credential.status_list'] as const;
export type CredentialCheckRule = CredentialRule | KeysRule | (typeof CREDENTIAL_CALL_RULES)[number];

export type SvidCheckRule<R extends string> = R | BundleReadRule;

export interface VerifiedCredentialStatus extends VerifiedCredential {
  /** What the Bitstring Status List says about the agent: both bits are clear, or the list was not read. */
  readonly listStatus: StatusReading;
}

export interface Verifier {
  readonly reader: GatewayReader;
  readonly issuer: string;
  readonly trustDomain: string;
  /** Checks the access token of a call with its DPoP proof, reads the status list that the token names, and runs the checks that the policy gives. */
  accessToken(request: CallRequest, policy: AccessTokenPolicy): Promise<Check<VerifiedCall, CallRule>>;
  /** Checks a JWT-SVID for this resource against the bundle. */
  jwtSvid(token: string, policy: { readonly audience: string }): Promise<Check<VerifiedJwtSvid, SvidCheckRule<JwtSvidRule>>>;
  /** Checks an X.509-SVID (PEM, base64 DER, or DER bytes) against the bundle. */
  x509Svid(certificate: string | Uint8Array): Promise<Check<VerifiedX509Svid, SvidCheckRule<X509SvidRule>>>;
  /** Checks an identity credential, and reads the Bitstring Status List that it names for the revocation bit and the suspension bit of the agent. */
  credential(jwt: string, policy?: { readonly subject?: string }): Promise<Check<VerifiedCredentialStatus, CredentialCheckRule>>;
}

async function run(check: () => Promise<AuthorityVerdict> | AuthorityVerdict): Promise<AuthorityVerdict> {
  try {
    return await check();
  } catch (e) {
    return { ok: false, detail: `the check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function createVerifier(options: VerifierOptions): Verifier {
  const reader = createGatewayReader(options);
  const replay = options.replay ?? createReplayStore();
  const maxLifetimeSeconds = options.maxLifetimeSeconds ?? MAX_TOKEN_LIFETIME_S;
  const maxActDepth = options.maxActDepth ?? MAX_DELEGATION_DEPTH;
  const { issuer, leewaySeconds } = reader;

  /** The result of a read of a list that is no refusal, as a StatusReading; a list that was read and is wrong is a refusal that the caller names. */
  const softReading = (list: string, rule: string, detail: string): StatusReading => ({ read: false, list, reason: rule === 'list.expired' ? 'stale' : 'unavailable', detail });

  async function tokenStatus(claim: { readonly uri: string; readonly index: number }): Promise<Check<StatusReading, 'status.revoked' | 'status.suspended' | 'status.value' | 'status.list'>> {
    const read = await reader.tokenList(claim.uri);
    if (!read.ok) return isSoftListRule(read.rule) ? accept(softReading(claim.uri, read.rule, read.detail)) : refuse('status.list', `${read.rule}: ${read.detail}`);
    const entry = tokenEntryStatus(read.value.list, claim.index);
    if (!entry.ok) return refuse(entry.rule === 'list.value' ? 'status.value' : 'status.list', entry.detail);
    if (entry.value === 'revoked') return refuse('status.revoked', 'the Token Status List says that the agent that asked for the token is revoked');
    if (entry.value === 'suspended') return refuse('status.suspended', 'the Token Status List says that the agent that asked for the token is suspended');
    return accept({ read: true, list: claim.uri, fetchedAt: read.value.fetchedAt, refreshError: read.value.refreshError });
  }

  async function accessToken(request: CallRequest, policy: AccessTokenPolicy): Promise<Check<VerifiedCall, CallRule>> {
    const token = request.accessToken !== undefined ? accept(request.accessToken) : parseAuthorization(request.authorization);
    if (!token.ok) return token;
    const context = (keys: KeySet): AccessTokenContext => ({
      keys, issuer, audience: policy.audience, nowMs: reader.now(), leewaySeconds, maxLifetimeSeconds, maxActDepth, replay, require: policy.require ?? null,
    });
    const call = { accessToken: token.value, dpop: request.dpop, method: request.method, url: request.url };
    const keys = await reader.keys();
    if (!keys.ok) return keys;
    let checked = checkAccessToken(call, context(keys.value));
    // A token that names a key that the set lacks: the gateway changed its keys. The first check stops before it records the proof, so a second check is safe.
    if (!checked.ok && checked.rule === 'token.kid') {
      const again = await reader.keys(true);
      if (again.ok) checked = checkAccessToken(call, context(again.value));
    }
    if (!checked.ok) return checked;
    const verified = checked.value;

    const status = await tokenStatus(verified.statusClaim);
    if (!status.ok) return status;
    if (policy.checkActors !== undefined) {
      const agents = [...new Set([...verified.actors, ...(verified.principal.kind === 'agent' ? [verified.principal.did] : []), verified.clientId])];
      const verdict = await run(() => policy.checkActors!(agents));
      if (!verdict.ok) return refuse('actors.refused', verdict.detail);
    }
    if (policy.checkDelegation !== undefined && verified.delegation !== null) {
      const verdict = await run(() => policy.checkDelegation!({ delegation: verified.delegation!, principal: verified.principal, actors: verified.actors, require: policy.require ?? null, nowMs: reader.now() }));
      if (!verdict.ok) return refuse('delegation.refused', verdict.detail);
    }
    return accept({ ...verified, status: status.value });
  }

  return {
    reader,
    issuer,
    trustDomain: reader.trustDomain,
    accessToken,

    async jwtSvid(token, policy) {
      const bundle = await reader.bundle();
      if (!bundle.ok) return bundle;
      return verifyJwtSvid(token, { bundle: bundle.value, trustDomain: reader.trustDomain, nowMs: reader.now(), leewaySeconds, audience: policy.audience });
    },

    async x509Svid(certificate) {
      const bundle = await reader.bundle();
      if (!bundle.ok) return bundle;
      return verifyX509Svid(certificate, { bundle: bundle.value, trustDomain: reader.trustDomain, nowMs: reader.now(), leewaySeconds });
    },

    async credential(jwt, policy = {}) {
      const keys = await reader.keys();
      if (!keys.ok) return keys;
      const context = (k: KeySet) => ({ keys: k, issuer, nowMs: reader.now(), leewaySeconds, subject: policy.subject ?? null });
      let checked = checkCredential(jwt, context(keys.value));
      if (!checked.ok && checked.rule === 'credential.kid') {
        const again = await reader.keys(true);
        if (again.ok) checked = checkCredential(jwt, context(again.value));
      }
      if (!checked.ok) return checked;
      const { list, position } = checked.value.status;
      const read = await reader.bitstringList(list);
      if (!read.ok) return isSoftListRule(read.rule) ? accept({ ...checked.value, listStatus: softReading(list, read.rule, read.detail) }) : refuse('credential.status_list', `${read.rule}: ${read.detail}`);
      const entry = bitstringEntryStatus(read.value.list, position);
      if (!entry.ok) return refuse('credential.status_list', entry.detail);
      if (entry.value === 'revoked') return refuse('credential.revoked', 'the revocation bit of the agent is set in the Bitstring Status List');
      if (entry.value === 'suspended') return refuse('credential.suspended', 'the suspension bit of the agent is set in the Bitstring Status List');
      return accept({ ...checked.value, listStatus: { read: true, list, fetchedAt: read.value.fetchedAt, refreshError: read.value.refreshError } });
    },
  };
}

/**
 * A check of actors for `checkActors` that resolves each DID at the gateway and requires the effective status Active. An agent that does not resolve, is deactivated, is suspended, or
 * cannot be resolved because the gateway fails, refuses the call.
 */
export function gatewayActorCheck(client: GatewayClient): ActorCheck {
  return async (agents) => {
    for (const did of agents) {
      const resolved = await client.resolve(did);
      if (!resolved.ok) return { ok: false, detail: `${did} cannot be resolved: ${resolved.detail}` };
      if (resolved.value.kind === 'not_found') return { ok: false, detail: `${did} does not resolve to an agent` };
      if (resolved.value.effectiveStatus !== 'active') return { ok: false, detail: `${did} has the effective status ${resolved.value.effectiveStatus}${resolved.value.effectiveReason === null ? '' : ` (${resolved.value.effectiveReason})`}` };
    }
    return { ok: true };
  };
}

export { ACCESS_TOKEN_RULES, checkAccessToken, parseAuthorization } from './access-token.ts';
export type { AccessTokenContext, AccessTokenRequest, AccessTokenRule, DelegationGrant, Principal, RequiredGrant, VerifiedAccessToken } from './access-token.ts';
export { CREDENTIAL_RULES, checkCredential } from './credential.ts';
export type { CredentialContext, CredentialRule, VerifiedCredential } from './credential.ts';
export { DPOP_RULES, checkDpopProof } from './dpop.ts';
export type { DpopRule, VerifiedDpop } from './dpop.ts';
export { KEY_SET_RULES, parseKeySet, verifyGatewayJws } from './keys.ts';
export type { GatewayKey, KeySet, KeySetRule } from './keys.ts';
export { createGatewayReader, isSoftListRule } from './reader.ts';
export type { BundleReadRule, GatewayReader, GatewayReaderOptions, KeysRule, ListReadRule, ListSnapshot } from './reader.ts';
export { ReplayStoreFull, createReplayStore } from './replay.ts';
export type { ReplayStore, ReplayStoreOptions } from './replay.ts';
export { STATUS_LIST_RULES, bitstringEntryStatus, decodeBitstringStatusList, decodeTokenStatusList, tokenEntryStatus } from './status-list.ts';
export type { BitstringStatusList, EntryStatus, ListContext, StatusListRule, TokenStatusList } from './status-list.ts';
export { BUNDLE_RULES, JWT_SVID_RULES, X509_SVID_RULES, parseBundle, parseSpiffeId, verifyJwtSvid, verifyX509Svid } from './svid.ts';
export type { BundleRule, JwtSvidRule, SpiffeBundle, SvidContext, VerifiedJwtSvid, VerifiedX509Svid, X509SvidRule } from './svid.ts';
