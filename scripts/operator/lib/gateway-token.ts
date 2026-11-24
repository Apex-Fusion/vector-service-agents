// The probe asks the identity gateway for a token under a delegation or for a subagent itself.
// The subject token uses the authentication key. The DPoP proof uses a different key with the delegation purpose.
// The key objects, the request credentials and the access token stay here. The subagent path returns only public fields and recognized gateway diagnostics.
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
type TokenHost = Pick<TaskSession, 'registry' | 'settings' | 'fetchImpl' | 'clock'>;
type SubagentTokenAsk = Omit<TokenAsk, 'delegation'>;

const PUBLIC_ERRORS: Record<string, true> = {
  invalid_request: true, invalid_token: true, agent_not_active: true, invalid_dpop_proof: true, invalid_client: true, invalid_grant: true,
  invalid_scope: true, invalid_authorization_details: true, unsupported_grant_type: true, temporarily_unavailable: true, server_error: true,
};
// Keep the gateway's subject-status diagnostic verbatim only when every part has a public, defined value.
const SUBJECT_STATUS_TEXT = /^subject_token: the agent's effective status is (?:suspended|revoked|retired)(?: \((?:invalidated|parentRevoked|parentRetired|deactivationPending|parentSuspended|notAuthentic|unaccountable)\))?, not active$/;

/**
 * Asks the gateway for a token under the delegation: one request, the grant narrowed to the one action and the one resource, with the DPoP proof made by the delegate key. A request that the
 * client of the gateway would refuse before it sends it (a bad identifier, a bad URI) is a TypeError. The token and the proof stay inside this function.
 */
export async function askForToken(host: Pick<TaskSession, 'registry' | 'settings' | 'fetchImpl' | 'clock'>, ask: TokenAsk): Promise<TokenAnswer> {
  if (!DELEGATION_ID.test(ask.delegation)) throw new TypeError('the delegation is 64 lower-case hex characters');
  return requestToken(host, ask, ask.delegation);
}

/** Asks for a token for the subagent itself. `action` labels the observation; a token without a delegation cannot grant an action. */
export async function askForSubagentToken(host: TokenHost, ask: SubagentTokenAsk): Promise<TokenAnswer> {
  if (host.registry.hashOf(ask.subjectKey) === host.registry.hashOf(ask.dpopKey)) throw new TypeError('the subject key and the key of the proof are two keys');
  const answer = await requestToken(host, ask);
  switch (answer.kind) {
    case 'granted': return answer.authorizationDetails === null ? answer
      : { kind: 'unreadable', status: 200, text: 'the answer unexpectedly names delegation details' };
    case 'refused': return {
      kind: answer.kind, status: answer.status, error: publicError(answer.error),
      text: SUBJECT_STATUS_TEXT.test(answer.text) ? answer.text : 'the gateway gave no recognized subject status diagnostic',
    };
    case 'unavailable': return { kind: answer.kind, status: answer.status, error: publicError(answer.error), text: 'the gateway is unavailable' };
    case 'unreadable': return { kind: answer.kind, status: answer.status, text: 'the gateway gave no readable token answer' };
    case 'unreachable': return { kind: answer.kind, text: 'the gateway did not answer' };
  }
}

const publicError = (error: string | null): string | null => error !== null && Object.hasOwn(PUBLIC_ERRORS, error) ? error : null;

async function requestToken(host: TokenHost, ask: SubagentTokenAsk, delegation?: string): Promise<TokenAnswer> {
  if (ask.subjectKey === ask.dpopKey) throw new TypeError('the subject key and the key of the proof are two keys');
  const client = createGatewayClient({ baseUrl: host.settings.urls.gateway, fetch: host.fetchImpl, now: () => host.clock.now() });
  const result = await client.requestToken({
    subject: { did: ask.did, key: host.registry.key(ask.subjectKey).jwsKey() },
    dpopKey: host.registry.key(ask.dpopKey).jwsKey(),
    resource: ask.resource,
    ...(delegation === undefined ? {} : { delegation: { identifier: delegation, actions: [ask.action], locations: [ask.resource] } }),
  });
  if (result.ok) return { kind: 'granted', tokenType: result.value.tokenType, expiresAt: result.value.expiresAt, authorizationDetails: result.value.authorizationDetails };
  switch (result.rule) {
    case 'gateway.refused': return { kind: 'refused', status: result.status, error: result.error, text: result.detail };
    case 'gateway.unavailable': return { kind: 'unavailable', status: result.status, error: result.error, text: result.detail };
    case 'gateway.unreachable': return { kind: 'unreachable', text: result.detail };
    default: return { kind: 'unreadable', status: result.status, text: result.detail };
  }
}
