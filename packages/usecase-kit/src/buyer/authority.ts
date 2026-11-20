// packages/usecase-kit/src/buyer/authority.ts
// The authority check of a job. The agent reads the delegation of the request. A delegation that exists and names another agent as its delegate is refused: `delegation_not_mine`. A delegation
// that is not found does not stop the job, because the ledger refuses the payment later and the flow then reads the delegation again. The agent does not judge what the delegation covers: the
// vault, the counterparty and the mock systems do that. A delegation that cannot be read is neither "mine" nor "not found": it has its own code, `ledger_unavailable`, and the job does not go on.
import { accepted, agentIdOf, parseDelegationId, parseDid, refused } from '@vsa/usecase-kit/protocol';
import type { DelegationId, Did, ProtocolResult } from '@vsa/usecase-kit/protocol';
import type { DelegationReading, LedgerReads } from './ports.ts';

const AGENT_ID = /^[0-9a-f]{64}$/;

/** What the check found, for a job that goes on. */
export type DelegationState = 'names_agent' | 'not_found';

/** The codes of a check that stops the job. `ledger_unavailable` says that the ledger could not be read. */
export type AuthorityRefusal = 'delegation_not_mine' | 'ledger_unavailable' | 'bad_shape';

/** The delegation as a port gave it, in the form of `DelegationReading`, or `null` for a delegation that is not found. Any other shape is no reading. */
export function readingOf(value: unknown): ProtocolResult<DelegationReading | null> {
  if (value === null) return accepted(null);
  if (typeof value !== 'object' || Array.isArray(value)) return refused('bad_shape', 'the reading of the delegation is not an object');
  const delegate: unknown = Reflect.get(value, 'delegate');
  const whole: unknown = Reflect.get(value, 'chain_whole');
  if (typeof delegate !== 'string' || !AGENT_ID.test(delegate)) return refused('bad_shape', 'the reading of the delegation has no delegate of the form of an agent id');
  if (typeof whole !== 'boolean') return refused('bad_shape', 'the reading of the delegation does not say whether its chain is whole');
  return accepted({ delegate, chain_whole: whole });
}

/**
 * Reads the delegation and compares its delegate with the agent. `agent` is the DID of this agent, and `delegation` is the name of the delegation in the request.
 * `ok: true` means that the job goes on: the delegation names this agent, or the ledger has no such delegation.
 */
export async function checkAuthority(
  reads: LedgerReads, agent: Did, delegation: DelegationId,
): Promise<{ readonly ok: true; readonly delegation: DelegationState } | { readonly ok: false; readonly code: AuthorityRefusal; readonly detail: string }> {
  const checkedAgent = parseDid(agent, 'agent_did');
  if (!checkedAgent.ok) return { ok: false, code: 'bad_shape', detail: checkedAgent.detail };
  const checkedDelegation = parseDelegationId(delegation, 'authority.delegation');
  if (!checkedDelegation.ok) return { ok: false, code: 'bad_shape', detail: checkedDelegation.detail };
  let read: unknown;
  try {
    read = await reads.delegation(checkedDelegation.value);
  } catch {
    return { ok: false, code: 'ledger_unavailable', detail: 'the ledger could not be read for the delegation of the request' };
  }
  const reading = readingOf(read);
  if (!reading.ok) return { ok: false, code: 'ledger_unavailable', detail: reading.detail };
  if (reading.value === null) return { ok: true, delegation: 'not_found' };
  if (reading.value.delegate !== agentIdOf(checkedAgent.value)) {
    return { ok: false, code: 'delegation_not_mine', detail: 'authority.delegation names another agent as its delegate' };
  }
  return { ok: true, delegation: 'names_agent' };
}

/** What the delegation is after a Pay was refused: the hirer ended it (`ended`), it still stands (`live`), or the ledger could not be read (`unreadable`). */
export type DelegationAfter = 'live' | 'ended' | 'unreadable';

/**
 * Reads the delegation again after the vault refused a Pay. A delegation that is no more on the ledger, and a delegation whose ancestor was undelegated, are ended. A read that fails, or a reading
 * of a wrong shape, is `unreadable`: the flow does not guess that the delegation ended, and the exit state stays `Failed`.
 */
export async function delegationAfter(reads: LedgerReads, delegation: DelegationId): Promise<DelegationAfter> {
  let read: unknown;
  try {
    read = await reads.delegation(delegation);
  } catch {
    return 'unreadable';
  }
  const reading = readingOf(read);
  if (!reading.ok) return 'unreadable';
  return reading.value === null || !reading.value.chain_whole ? 'ended' : 'live';
}
