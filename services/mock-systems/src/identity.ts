// services/mock-systems/src/identity.ts
// The decisions about who calls and with what right. Each function returns an `Outcome`: it passes with the verified facts, or it is refused with a code and the rule that failed. The
// service makes no other decision about a caller, and no success is read from a text.
//
// A token call (`authorizeToken`) is a direct check at each call, with the verifier of @vsa/id-kit:
//   - the act chain is no deeper than the route takes (one agent, or an agent and its subagent). The check comes first and needs no read of the gateway or the ledger: the route chooses
//     the verifier by that depth;
//   - the token is bound to the route: its audience is the resource of the route, and the policy names the action and the resource of the route, matched exactly, so that a grant for another
//     action, another system or another tenant covers nothing here;
//   - the proof of the call is for this method and this URL, and it is used once;
//   - each DID of the act chain (the agents of the chain and the one that asked) resolves at the gateway with the effective status Active, now (`checkActors`);
//   - the whole chain of the delegation is usable on the ledger for the action and the resource of the route, now (`checkDelegation`, with `checkDelegationUse` of buyer-core);
//   - a status list that cannot be read, or that is old, does not refuse the call. The result says so, and the service writes it to the log.
// An SVID call (`authorizeX509Svid`, `authorizeJwtSvid`) checks the certificate or the JWT against the bundle of the gateway, and then the agent of the SPIFFE ID: it resolves, it is Active
// now, and its record names the organisation of the tenant for the route with `organisationVerified`.
// A gateway or a ledger that cannot be read refuses the call (503). An error never turns into a pass.
import { createGatewayClient, createReplayStore, createVerifier, gatewayActorCheck, parseAuthorization } from '@vsa/id-kit';
import type { AccessTokenPolicy, AuthorityVerdict, GatewayClient, StatusReading, Verifier } from '@vsa/id-kit';
import type { DelegationUseCheck, DelegationUseParams } from '@vsa/buyer-core';
import { errorText, flatText } from '@vsa/service-kit';
import { pass, refuse } from './errors.ts';
import type { Outcome, Refused } from './errors.ts';
import type { Actor, TokenStatusNote } from './tenants.ts';
import { isJsonObject } from './validate.ts';

/** The check of a delegation on the ledger: `checkDelegationUse` of buyer-core, bound to a node and an indexer. A test gives a ledger of fixture data. */
export type LedgerPort = (params: DelegationUseParams) => Promise<DelegationUseCheck>;

export interface IdentityDeps {
  /**
   * The verifier of a route that takes an act chain of one agent (`1`), and of a route that takes an agent and its subagent (`2`). The verifier refuses a chain that is deeper than its
   * limit before it reads anything. The two share the store of used proofs, so that a proof is used once whatever route it is sent to. Both read the same gateway.
   */
  readonly verifiers: Readonly<Record<1 | 2, Verifier>>;
  readonly client: GatewayClient;
  readonly ledger: LedgerPort;
  readonly now: () => number;
}

/** How often the bundle of the gateway is read again, in seconds. */
export const BUNDLE_REFRESH_SECONDS = 300;

/** The verifiers and the gateway client of the service, made in one place so that the service and its tests make them with the same options. */
export function createIdentityDeps(options: { gatewayUrl: string; fetch: typeof fetch; now: () => number; ledger: LedgerPort }): IdentityDeps {
  const { gatewayUrl, fetch: fetchImpl, now } = options;
  const replay = createReplayStore();
  const verifier = (maxActDepth: 1 | 2): Verifier => createVerifier({ baseUrl: gatewayUrl, fetch: fetchImpl, now, bundleCacheSeconds: BUNDLE_REFRESH_SECONDS, maxActDepth, replay });
  const client = createGatewayClient({ baseUrl: gatewayUrl, fetch: fetchImpl, now });
  return { verifiers: { 1: verifier(1), 2: verifier(2) }, client, ledger: options.ledger, now };
}

/** What a call shows of its caller while it is checked, for the log line. A field is set only with a fact that was verified. */
export interface CallTrace {
  sub: string | null;
  act: string[];
  delegation: string | null;
  tokenStatus: TokenStatusNote | null;
  /** The gateway could not be read during a check that the service made (a DID resolution). */
  gatewayFault: boolean;
  /** The ledger could not be read during the check of the delegation. */
  ledgerFault: boolean;
}

export const newTrace = (): CallTrace => ({ sub: null, act: [], delegation: null, tokenStatus: null, gatewayFault: false, ledgerFault: false });

/** What a route needs of a token: the action, the exact resource, and the deepest act chain that it takes (1 for an agent, 2 for a subagent). */
export interface TokenNeed {
  readonly action: string;
  readonly resource: string;
  readonly maxActors: 1 | 2;
}

export interface TokenCall {
  readonly method: string;
  /** The public URL of the request, with no query: the URL that the DPoP proof names. */
  readonly url: string;
  readonly authorization: string | undefined;
  readonly dpop: string | undefined;
}

export interface TokenAuth {
  readonly actor: Extract<Actor, { kind: 'token' }>;
  /** The agent that asked for the token: the first of the act chain. */
  readonly sender: string;
}

/** The rules of a token check that fail before the signature of the token is verified, or that fail because a key could not be read. They say nothing that is a fact about the token. */
const BEFORE_SIGNATURE: Readonly<Record<string, true>> = {
  'token.missing': true, 'token.scheme': true, 'token.malformed': true, 'token.alg': true, 'token.typ': true, 'token.kid': true, 'token.signature': true,
  'keys.unavailable': true, 'jwks.malformed': true, 'jwks.private_key': true, 'jwks.no_usable_key': true,
};
const LOG_TEXT_MAX = 200;

/** The claims of a token whose signature was verified, for the log of a call that a later check refuses. A claim that is not as expected gives nothing. */
function verifiedClaims(token: string): { sub: string | null; act: string[]; delegation: string | null } {
  const empty = { sub: null, act: [] as string[], delegation: null };
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    if (!isJsonObject(claims)) return empty;
    const act: string[] = [];
    for (let current: unknown = claims.act; isJsonObject(current) && act.length < 8; current = current.act) if (typeof current.sub === 'string') act.push(flatText(current.sub, LOG_TEXT_MAX));
    const details = Array.isArray(claims.authorization_details) ? (claims.authorization_details[0] as unknown) : undefined;
    return {
      sub: typeof claims.sub === 'string' ? flatText(claims.sub, LOG_TEXT_MAX) : null,
      act,
      delegation: isJsonObject(details) && typeof details.identifier === 'string' ? flatText(details.identifier, LOG_TEXT_MAX) : null,
    };
  } catch {
    return empty;
  }
}

/** The status list note of an allowed call, for the log: the age of the list that was read, or why it was not read. */
function noteOf(status: StatusReading, nowMs: number): TokenStatusNote {
  if (status.read) return { read: true, age_seconds: status.issuedAt === null ? null : Math.max(0, Math.round((nowMs - status.issuedAt) / 1000)) };
  return { read: false, reason: status.reason, detail: errorText(status.detail, 200) };
}

/** The client with a resolution that notes a failure of the gateway in the trace, so that "the gateway failed" is told apart from "the agent is not Active" without reading a text. */
function observing(client: GatewayClient, trace: CallTrace): GatewayClient {
  return {
    ...client,
    async resolve(did) {
      const resolved = await client.resolve(did);
      if (!resolved.ok) trace.gatewayFault = true;
      return resolved;
    },
  };
}

/** The refusal for a rule of the verifier of a token call. Every rule that is not named is a token that is not valid: a rule that the service does not know never passes. */
function tokenRefusal(rule: string, detail: string, trace: CallTrace): Refused {
  switch (rule) {
    case 'delegation.missing':
    case 'delegation.unchecked':
    case 'delegation.action':
    case 'delegation.resource':
      return refuse('not_covered', rule, `the token gives no right for this action on this resource: ${detail}`);
    case 'act.depth':
      return refuse('chain_too_deep', rule, `the act chain of the token is deeper than this route takes: ${detail}`);
    case 'actors.refused':
      return trace.gatewayFault
        ? refuse('gateway_unavailable', rule, `an agent of the act chain could not be checked, because the gateway could not be read: ${detail}`)
        : refuse('actor_not_active', rule, `an agent of the act chain is not Active: ${detail}`);
    case 'delegation.refused':
      return trace.ledgerFault
        ? refuse('ledger_unavailable', rule, `the delegation could not be checked, because the ledger could not be read: ${detail}`)
        : refuse('delegation_ended', rule, `the delegation cannot be used now: ${detail}`);
    case 'keys.unavailable':
    case 'jwks.malformed':
    case 'jwks.private_key':
    case 'jwks.no_usable_key':
      return refuse('gateway_unavailable', rule, `the key set of the gateway could not be used: ${detail}`);
    case 'dpop.replay_store':
      return refuse('service_busy', rule, `the service cannot take a new proof now: ${detail}`);
    default:
      return refuse('token_invalid', rule, `the token or its proof is not valid (${rule}): ${detail}`);
  }
}

/** The answer of the ledger as a verdict: the delegation is usable only when the ledger says so and names no problem. */
function ledgerVerdict(used: DelegationUseCheck): AuthorityVerdict {
  if (used.usable === true && used.problems.length === 0) return { ok: true };
  return { ok: false, detail: used.problems.length > 0 ? used.problems.join('; ') : 'the ledger does not show the delegation as usable' };
}

/** Checks the token of one call for the need of its route. */
export async function authorizeToken(deps: IdentityDeps, call: TokenCall, need: TokenNeed, trace: CallTrace): Promise<Outcome<TokenAuth>> {
  const parsed = parseAuthorization(call.authorization);
  const token = parsed.ok ? parsed.value : null;
  const actorsCheck = gatewayActorCheck(observing(deps.client, trace));
  const policy: AccessTokenPolicy = {
    audience: need.resource,
    require: { action: need.action, resource: need.resource },
    checkActors: actorsCheck,
    checkDelegation: async (context) => {
      if (context.require === null) return { ok: false, detail: 'the policy of this call names no action and no resource' };
      try {
        return ledgerVerdict(await deps.ledger({ id: context.delegation.identifier, action: context.require.action, resource: context.require.resource, atMs: context.nowMs }));
      } catch (error) {
        trace.ledgerFault = true;
        return { ok: false, detail: `the ledger could not be read: ${errorText(error, 200)}` };
      }
    },
  };
  const checked = await deps.verifiers[need.maxActors].accessToken({ authorization: call.authorization, dpop: call.dpop, method: call.method, url: call.url }, policy);
  if (!checked.ok) {
    // A refusal after the signature was verified is a fact about the token: the log says whose token it was.
    if (token !== null && !Object.hasOwn(BEFORE_SIGNATURE, checked.rule)) Object.assign(trace, verifiedClaims(token));
    return tokenRefusal(checked.rule, checked.detail, trace);
  }
  const verified = checked.value;
  trace.sub = flatText(verified.subject, LOG_TEXT_MAX);
  trace.act = verified.actors.map((actor) => flatText(actor, LOG_TEXT_MAX));
  trace.delegation = verified.delegation === null ? null : flatText(verified.delegation.identifier, LOG_TEXT_MAX);
  // These cannot happen with a verifier that was given a policy with `require` and no `acceptDirect`. They are not a refusal that a caller can cause: they are a fault of the service, and the
  // call must never be honoured because of one.
  if (verified.delegation === null || verified.actors.length === 0) throw new Error('the verifier passed a token with no delegation or no actor');
  if (verified.actors.length > need.maxActors) throw new Error(`the verifier passed an act chain of ${verified.actors.length} for a route that takes ${need.maxActors}`);
  trace.tokenStatus = noteOf(verified.status, deps.now());
  return pass({ actor: { kind: 'token', sub: verified.subject, act: [...verified.actors], delegation: verified.delegation.identifier }, sender: verified.clientId });
}

// ── SVIDs ──

const ZULU = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** POSIX ms of a time as the gateway writes it in a party (`YYYY-MM-DDThh:mm:ssZ`), or null. */
function partyTime(value: unknown): number | null {
  if (typeof value !== 'string' || !ZULU.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The agent of a SPIFFE ID must resolve, be Active now, and have a record whose Accountable Party names `organisation` and has `organisationVerified`. The party must be in force now:
 * a party that is not yet in force, or whose period has ended, does not name the organisation.
 */
export async function authorizeAgent(deps: IdentityDeps, did: string, organisation: string, trace: CallTrace): Promise<Outcome<null>> {
  const resolved = await observing(deps.client, trace).resolve(did);
  if (!resolved.ok) return refuse('gateway_unavailable', 'agent.resolve', `the agent ${did} could not be checked, because the gateway could not be read: ${errorText(resolved.detail, 200)}`);
  const record = resolved.value;
  if (record.kind === 'not_found') return refuse('agent_not_active', 'agent.not_found', `the agent ${did} does not resolve to a record`);
  if (record.kind === 'deactivated') return refuse('agent_not_active', 'agent.deactivated', `the record of the agent ${did} has ended (${record.effectiveStatus})`);
  if (record.effectiveStatus !== 'active') return refuse('agent_not_active', 'agent.status', `the agent ${did} has the effective status ${record.effectiveStatus}`);
  const nowMs = deps.now();
  const parties: unknown[] = Array.isArray(record.metadata.vectorParties) ? record.metadata.vectorParties : [];
  const naming = parties.filter((party): party is Record<string, unknown> => {
    if (!isJsonObject(party) || party.role !== 'accountable' || typeof party.organisation !== 'string' || party.organisation.toLowerCase() !== organisation.toLowerCase()) return false;
    const from = partyTime(party.notBefore);
    const until = party.notAfter === undefined ? Number.POSITIVE_INFINITY : partyTime(party.notAfter);
    return from !== null && until !== null && from <= nowMs && nowMs < until;
  });
  if (naming.length === 0) return refuse('organisation_mismatch', 'agent.organisation', `the record of the agent ${did} does not name ${organisation} as the organisation of an Accountable Party that is in force`);
  if (!naming.some((party) => party.organisationVerified === true)) return refuse('organisation_unverified', 'agent.organisation_verified', `the record of the agent ${did} names ${organisation}, and the gateway has not verified the organisation`);
  return pass(null);
}

/** The refusal for a rule of the check of an SVID. A bundle that cannot be read is the gateway; every other rule is an SVID that is not valid. */
function svidRefusal(rule: string, detail: string): Refused {
  if (rule === 'bundle.unavailable' || rule === 'bundle.malformed') return refuse('gateway_unavailable', rule, `the bundle of the gateway could not be used: ${detail}`);
  return refuse('svid_invalid', rule, `the SVID is not valid (${rule}): ${detail}`);
}

export interface SvidAuth {
  readonly actor: Extract<Actor, { kind: 'x509-svid' | 'jwt-svid' }>;
}

/** Checks the certificate of the client (the bytes of the DER) against the bundle, and then the agent of its SPIFFE ID. */
export async function authorizeX509Svid(deps: IdentityDeps, certificate: Uint8Array, organisation: string, trace: CallTrace): Promise<Outcome<SvidAuth>> {
  const checked = await deps.verifiers[2].x509Svid(certificate);
  if (!checked.ok) return svidRefusal(checked.rule, checked.detail);
  trace.sub = checked.value.spiffeId;
  const agent = await authorizeAgent(deps, checked.value.did, organisation, trace);
  if (!agent.ok) return agent;
  return pass({ actor: { kind: 'x509-svid', spiffe_id: checked.value.spiffeId, did: checked.value.did } });
}

/** Checks a JWT-SVID for its audience against the bundle, and then the agent of its SPIFFE ID. */
export async function authorizeJwtSvid(deps: IdentityDeps, token: string, audience: string, organisation: string, trace: CallTrace): Promise<Outcome<SvidAuth>> {
  const checked = await deps.verifiers[2].jwtSvid(token, { audience });
  if (!checked.ok) return svidRefusal(checked.rule, checked.detail);
  trace.sub = checked.value.spiffeId;
  const agent = await authorizeAgent(deps, checked.value.did, organisation, trace);
  if (!agent.ok) return agent;
  return pass({ actor: { kind: 'jwt-svid', spiffe_id: checked.value.spiffeId, did: checked.value.did } });
}

/**
 * The supplier of the top rank of a ranking: its record resolves and its effective status is Active now. A record that does not resolve, that has ended, or that is suspended is
 * `supplier_not_active`. A gateway that cannot be read refuses the call (503): it never counts as Active.
 */
export async function authorizeSupplier(deps: IdentityDeps, did: string, trace: CallTrace): Promise<Outcome<null>> {
  const resolved = await observing(deps.client, trace).resolve(did);
  if (!resolved.ok) return refuse('gateway_unavailable', 'supplier.resolve', `the supplier ${did} could not be checked, because the gateway could not be read: ${errorText(resolved.detail, 200)}`);
  const record = resolved.value;
  if (record.kind === 'not_found') return refuse('supplier_not_active', 'supplier.not_found', `the supplier ${did} does not resolve to a record`);
  if (record.kind === 'deactivated') return refuse('supplier_not_active', 'supplier.deactivated', `the record of the supplier ${did} has ended (${record.effectiveStatus})`);
  if (record.effectiveStatus !== 'active') return refuse('supplier_not_active', 'supplier.status', `the supplier ${did} has the effective status ${record.effectiveStatus}`);
  return pass(null);
}
