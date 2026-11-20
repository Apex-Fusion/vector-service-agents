// packages/usecase-kit/src/access/token.ts
// An access token for ONE route under ONE delegation. The request is the token exchange of the gateway: the subject token is signed by an authentication key of the caller, the request narrows
// the grant to the action and the resource of the route (`authorization_details`), and the DPoP proof is signed by the Ed25519 delegate key of the leaf delegation. The resource is the exact
// public URL `<public base>/t/<tenant>/<system>`. A token is asked for one route and is never kept: a call checks that it is the token of its route, and this folder has no cache.
import { inspect } from 'node:util';
import { presentToken, type GatewayClient, type KeyInput, type PresentedToken } from '@vsa/id-kit/client';
import { accepted, parseDelegationId, parseDid, type Accepted, type DelegationId, type Did } from '../protocol/index.ts';
import { fromRule, fromThrown, gatewayFailure, type GatewayFailure } from './gateway.ts';
import { MAX_WAIT_MS, type Clock } from './ports.ts';
import type { RouteId, TokenCallers, TokenTarget } from './routes.ts';

/** Who holds the token: the agent (an act chain of one link), or a subagent (two links). */
export type TokenHolder = 'agent' | 'subagent';

/**
 * An access token with the key that it is bound to, for one route. The token and the key are private: no property, no JSON text and no log line of the object shows them. `present` gives the two
 * header fields of one call, and nothing else gives the token out.
 */
export class RouteToken {
  readonly route: RouteId;
  readonly action: string;
  readonly resource: string;
  readonly callers: TokenCallers;
  readonly holder: TokenHolder;
  /** When the token ends, in POSIX milliseconds, by the clock of the client at the answer. */
  readonly expiresAt: number;
  readonly #accessToken: string;
  readonly #dpopKey: KeyInput;

  /** Made by `requestRouteToken` only. */
  constructor(facts: { route: RouteId; action: string; resource: string; callers: TokenCallers; holder: TokenHolder; expiresAt: number }, accessToken: string, dpopKey: KeyInput) {
    this.route = facts.route;
    this.action = facts.action;
    this.resource = facts.resource;
    this.callers = facts.callers;
    this.holder = facts.holder;
    this.expiresAt = facts.expiresAt;
    this.#accessToken = accessToken;
    this.#dpopKey = dpopKey;
  }

  /** `Authorization: DPoP <token>` and a new proof for this method and this URL. A proof is for one call. */
  present(method: string, url: string, now: () => number): Promise<PresentedToken> {
    return presentToken(this.#accessToken, this.#dpopKey, { method, url }, { now });
  }

  toJSON(): { route: RouteId; action: string; resource: string; holder: TokenHolder; expiresAt: number } {
    return { route: this.route, action: this.action, resource: this.resource, holder: this.holder, expiresAt: this.expiresAt };
  }

  toString(): string {
    return `RouteToken(${this.route}, ${this.holder})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export interface TokenDeps {
  /** The client of the gateway, made with the `fetch` and the clock of the caller: `createGatewayClient({ baseUrl, fetch, now })`. */
  readonly client: Pick<GatewayClient, 'requestToken'>;
}

export interface RouteTokenRequest {
  /** The route that the token is for. */
  readonly target: TokenTarget;
  readonly holder: TokenHolder;
  /** The caller: its DID and an Ed25519 authentication key of its record. It signs the subject token. */
  readonly subject: { readonly did: Did; readonly key: KeyInput };
  /** The Ed25519 delegate key of the leaf delegation. It signs the DPoP proof of the token request, and the token is bound to it. */
  readonly dpopKey: KeyInput;
  /** The leaf delegation: the one that names the caller as its delegate. */
  readonly delegation: DelegationId;
}

export type RouteTokenResult = Accepted<RouteToken> | GatewayFailure;

const same = (a: unknown, b: readonly string[]): boolean => Array.isArray(a) && a.length === b.length && a.every((item, index) => item === b[index]);

/** The grant of a token as the gateway wrote it: one object, with the one action and the one resource that were asked for. A wider grant is not the token of this route. */
function grantIsTheRoute(details: readonly Record<string, unknown>[] | null, target: TokenTarget, delegation: string): boolean {
  if (details === null || details.length !== 1) return false;
  const grant = details[0]!;
  return grant.identifier === delegation && same(grant.actions, [target.action]) && same(grant.locations, [target.resource]);
}

/**
 * Asks the gateway for a token for one route. It never throws. The token covers the action and the resource of the target only, even when the delegation covers more. A refusal of the gateway,
 * a gateway that cannot be reached, and a delegation that is too young each have their own code (see GatewayFailure). The request is not repeated.
 */
export async function requestRouteToken(deps: TokenDeps, request: RouteTokenRequest): Promise<RouteTokenResult> {
  const did = parseDid(request.subject.did, 'subject.did');
  if (!did.ok) return gatewayFailure('bad_request', did.detail);
  const delegation = parseDelegationId(request.delegation, 'delegation');
  if (!delegation.ok) return gatewayFailure('bad_request', delegation.detail);
  const { target } = request;
  if (request.holder === 'subagent' && target.callers !== 'agent-or-subagent') return gatewayFailure('bad_request', `the route ${target.route} takes the agent only: a subagent gets no token for it`);
  try {
    const issued = await deps.client.requestToken({
      subject: { did: did.value, key: request.subject.key },
      dpopKey: request.dpopKey,
      resource: target.resource,
      delegation: { identifier: delegation.value, actions: [target.action], locations: [target.resource] },
    });
    if (!issued.ok) return fromRule(issued);
    if (!grantIsTheRoute(issued.value.authorizationDetails, target, delegation.value)) {
      return gatewayFailure('gateway_bad_response', 'the grant of the token is not the one action and the one resource that were asked for');
    }
    const facts = { route: target.route, action: target.action, resource: target.resource, callers: target.callers, holder: request.holder, expiresAt: issued.value.expiresAt };
    return accepted(new RouteToken(facts, issued.value.accessToken, request.dpopKey));
  } catch (error) {
    return fromThrown(error);
  }
}

/** The subagent that gets a token under a sub-delegation. */
export interface SubagentTokenRequest {
  readonly target: TokenTarget;
  /** The subagent: its DID, an Ed25519 authentication key of its record, and its Ed25519 delegation key. The delegation key is the delegate key of the sub-delegation. */
  readonly subagent: { readonly did: Did; readonly authenticationKey: KeyInput; readonly delegationKey: KeyInput };
  /** The identifier of the sub-delegation. */
  readonly subDelegation: DelegationId;
}

/**
 * The token of a subagent. The subject is the subagent and the delegation is the sub-delegation, so the act chain of the token has two links. The route must take a subagent: a route that
 * takes the agent only gives `bad_request`, and nothing is sent.
 */
export function requestSubagentToken(deps: TokenDeps, request: SubagentTokenRequest): Promise<RouteTokenResult> {
  return requestRouteToken(deps, {
    target: request.target,
    holder: 'subagent',
    subject: { did: request.subagent.did, key: request.subagent.authenticationKey },
    dpopKey: request.subagent.delegationKey,
    delegation: request.subDelegation,
  });
}

export interface PatientOptions {
  /** The longest time, in milliseconds, to ask again while the gateway says that the delegation is too young. */
  readonly waitMs: number;
  /** The time between two requests, in milliseconds. */
  readonly pollMs: number;
}

/**
 * Runs `ask` and runs it again only while it gives `delegation_too_young`, until `waitMs` pass on the clock. A token and every other failure end it at once. The result of the last run is the
 * result: a delegation that stays too young gives `delegation_too_young`. The number of runs is at most `waitMs / pollMs + 1`, so it always ends.
 * Use it for a delegation that the caller saw with 30 confirmations and that the gateway, which reads the ledger by itself, has not yet seen so.
 */
export async function askWhileTooYoung(clock: Clock, ask: () => Promise<RouteTokenResult>, options: PatientOptions): Promise<RouteTokenResult> {
  if (!Number.isSafeInteger(options.waitMs) || options.waitMs < 0 || options.waitMs > MAX_WAIT_MS || !Number.isSafeInteger(options.pollMs) || options.pollMs < 1 || options.pollMs > MAX_WAIT_MS) {
    return gatewayFailure('bad_request', `waitMs must be a whole number from 0 to ${MAX_WAIT_MS}, and pollMs a whole number from 1 to ${MAX_WAIT_MS}`);
  }
  const deadline = clock.now() + options.waitMs;
  const runs = Math.floor(options.waitMs / options.pollMs) + 1;
  let result = await ask();
  for (let run = 1; run < runs && !result.ok && result.code === 'delegation_too_young' && clock.now() + options.pollMs <= deadline; run += 1) {
    await clock.sleep(options.pollMs);
    result = await ask();
  }
  return result;
}
