// scripts/operator/lib/gateway-token.ts - one token request to the identity gateway under a delegation, for the task probe.
// The request is signed with two keys of the registry that the caller names: the authentication key of the agent (it signs the subject token) and the delegate key of the delegation (the proof
// of the request is made with it). The key objects of the two keys are made here and stay here: this file is the one place of the pack that names `jwsKey`, and a task never holds a key object.
// The answer that leaves this file holds no token and no proof. For a token that the gateway granted it holds the type, the end and the grant. For any other answer it holds what the gateway said.
import type { TaskSession } from './contract.ts';
import { createGatewayClient } from './platform.ts';

/** What one request names. The keys are registry NAMES. */
export interface TokenAsk {
  /** The DID of the agent that asks. */
  readonly did: string;
  /** The key that signs the subject token: the authentication key of the agent. */
  readonly subjectKey: string;
  /** The key that the proof of the request is made with: the delegate key of the delegation. */
  readonly dpopKey: string;
  /** The identifier of the delegation: 64 lower-case hex characters. */
  readonly delegation: string;
  readonly action: string;
  readonly resource: string;
}

/** What the gateway answered. `unreachable` and `unavailable` are answers that say nothing about the delegation. */
export type TokenAnswer =
  | { readonly kind: 'granted'; readonly tokenType: string; readonly expiresAt: number; readonly authorizationDetails: readonly Record<string, unknown>[] | null }
  | { readonly kind: 'refused'; readonly status: number; readonly error: string | null; readonly text: string }
  | { readonly kind: 'unavailable'; readonly status: number; readonly error: string | null; readonly text: string }
  | { readonly kind: 'unreachable'; readonly text: string }
  | { readonly kind: 'unreadable'; readonly status: number; readonly text: string };

const DELEGATION_ID = /^[0-9a-f]{64}$/;

/**
 * Asks the gateway for a token under the delegation: one request, the grant narrowed to the one action and the one resource, with the DPoP proof made by the delegate key. A request that the
 * client of the gateway would refuse before it sends it (a bad identifier, a bad URI) is a TypeError. The token and the proof stay inside this function.
 */
export async function askForToken(host: Pick<TaskSession, 'registry' | 'settings' | 'fetchImpl' | 'clock'>, ask: TokenAsk): Promise<TokenAnswer> {
  if (!DELEGATION_ID.test(ask.delegation)) throw new TypeError('the delegation is 64 lower-case hex characters');
  if (ask.subjectKey === ask.dpopKey) throw new TypeError('the subject key and the key of the proof are two keys');
  const client = createGatewayClient({ baseUrl: host.settings.urls.gateway, fetch: host.fetchImpl, now: () => host.clock.now() });
  const result = await client.requestToken({
    subject: { did: ask.did, key: host.registry.key(ask.subjectKey).jwsKey() },
    dpopKey: host.registry.key(ask.dpopKey).jwsKey(),
    resource: ask.resource,
    delegation: { identifier: ask.delegation, actions: [ask.action], locations: [ask.resource] },
  });
  if (result.ok) return { kind: 'granted', tokenType: result.value.tokenType, expiresAt: result.value.expiresAt, authorizationDetails: result.value.authorizationDetails };
  switch (result.rule) {
    case 'gateway.refused': return { kind: 'refused', status: result.status, error: result.error, text: result.detail };
    case 'gateway.unavailable': return { kind: 'unavailable', status: result.status, error: result.error, text: result.detail };
    case 'gateway.unreachable': return { kind: 'unreachable', text: result.detail };
    default: return { kind: 'unreadable', status: result.status, text: result.detail };
  }
}
