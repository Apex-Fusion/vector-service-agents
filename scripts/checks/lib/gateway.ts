// scripts/checks/lib/gateway.ts - what checks 5 and 6 share: the client of the identity gateway, the read of the record by DID resolution, and the facts of the delegation of check 1.
import { join } from 'node:path';
import { createGatewayClient } from './platform.ts';
import type { GatewayClient } from './platform.ts';
import { PreconditionError } from './session.ts';
import type { Session } from './session.ts';
import { StateFile } from './state.ts';

/** The client of the gateway that the settings name, on the `fetch` and the clock of the session. */
export const clientOf = (session: Pick<Session, 'settings' | 'fetchImpl' | 'clock'>): GatewayClient =>
  createGatewayClient({ baseUrl: session.settings.urls.gateway, fetch: session.fetchImpl, now: () => session.clock.now() });

/**
 * Reads the test record as the gateway resolves it: it must be Active, and it must list the authentication key with the authentication purpose (and the delegation purpose when
 * `delegation` is true). Gives the lines that the step prints.
 */
export async function resolveRecord(session: Pick<Session, 'settings' | 'fetchImpl' | 'clock' | 'authKey' | 'out' | 'ring'>, delegation: boolean): Promise<void> {
  const auth = session.authKey;
  if (auth === null) throw new PreconditionError('the check has no authentication key');
  const resolved = await clientOf(session).resolve(session.settings.recordDid);
  if (!resolved.ok) throw new PreconditionError(`the gateway could not resolve ${session.settings.recordDid}: ${resolved.rule}: ${resolved.detail}`);
  if (resolved.value.kind !== 'resolved') throw new PreconditionError(`the record ${session.settings.recordDid} does not resolve as an agent: ${resolved.value.kind}`);
  if (resolved.value.effectiveStatus !== 'active') throw new PreconditionError(`the record ${session.settings.recordDid} has the effective status ${resolved.value.effectiveStatus}: it must be active`);
  const listed = (keyHash: string, purpose: string): boolean => resolved.value.kind === 'resolved' && resolved.value.keys.some((key) => key.keyHash === keyHash && key.purposes.includes(purpose));
  if (!listed(auth.keyHash, 'authentication')) throw new PreconditionError('the record does not list the authentication key with the authentication purpose');
  const agent = session.ring.find('agent');
  if (delegation && (agent === undefined || !listed(agent.keyHash, 'delegation'))) throw new PreconditionError('the record does not list the agent key with the delegation purpose');
  session.out.out(`the gateway resolves ${session.settings.recordDid} as active, and the record lists the authentication key${delegation ? ' and the delegation key' : ''}`);
}

/** The delegation of check 1, from its state file: its identifier, its grant and its end. It must be made, and not ended. */
export interface DelegationFacts {
  id: string;
  actions: string[];
  resources: string[];
  notAfter: number;
  delegateKeyHash: string;
}

export function delegationOfCheckOne(session: Pick<Session, 'settings' | 'clock'>): DelegationFacts {
  const state = StateFile.peek(join(session.settings.stateDir, 'delegation.state.json'));
  const made = state?.steps.delegate;
  if (state === null || made === undefined) throw new PreconditionError('check 1 (the delegation) has not made its delegation: run its step delegate first');
  if (state.steps.undelegate !== undefined) throw new PreconditionError('the delegation of check 1 has ended: it cannot be used for a token');
  const { actions, resources, not_after: notAfter, delegate_key_hash: delegateKeyHash } = made.facts;
  const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
  if (typeof notAfter !== 'number' || typeof delegateKeyHash !== 'string' || made.refs.delegation_id === undefined) throw new PreconditionError('the state file of check 1 does not hold the facts of its delegation');
  if (notAfter <= session.clock.now()) throw new PreconditionError('the delegation of check 1 has passed its end');
  return { id: made.refs.delegation_id, actions: texts(actions), resources: texts(resources), notAfter, delegateKeyHash };
}
