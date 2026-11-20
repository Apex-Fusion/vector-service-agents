// packages/usecase-kit/src/checks/delegation.ts
// The checks of the delegation, and the check that the escrow was paid from a vault of that delegation. Each function takes what a read gave, and it reads nothing.
//   - the delegation exists, is authentic, names the sender as its delegate and the key of the escrow as its delegate key   (delegation_invalid)
//   - the delegation and every ancestor can be used now to hire                                                          (delegation_ended)
//   - the escrow was paid from a vault of the delegation                                                                 (not_vault_paid)
// Each function checks the type of the answer first (answers.ts). An answer of the wrong type, or for another question, is `check_unavailable`. It is never the code of a rule.
// "Now" is the time of the run. A delegation that has fewer confirmations than the gateway asks for is usable: the check does not wait for confirmations.
import type { DelegationUseCheck, DelegationView, EscrowVaultReason, EscrowVaultResult } from '@vsa/buyer-core';
import { accepted, agentIdOf, refused } from '../protocol/index.ts';
import type { DelegationId, Did, OutputRef, ProtocolResult } from '../protocol/index.ts';
import { delegationViewOf, paymentOf, useCheckOf } from './answers.ts';
import { clip } from './ids.ts';

/**
 * The delegation that was read is a live delegation (an authentic output that holds its token), its delegate is the sender, and its delegate key is the key of the escrow.
 * A delegation that does not exist, and one that was ended by an Undelegate, have no output: the read gives an empty chain. `buyerPkh` is 56 lower-case hex characters, from the job context.
 * An answer that is not for this delegation, or that has the wrong type, is `check_unavailable`.
 */
export function checkDelegationNamesSender(answer: DelegationView, id: DelegationId, senderDid: Did, buyerPkh: string): ProtocolResult<null, 'delegation_invalid' | 'check_unavailable'> {
  const checked = delegationViewOf(answer, id);
  if (!checked.ok) return checked;
  const link = checked.value.chain[0];
  // Decided: a delegation that is not found gets `delegation_invalid`. This holds also when the hirer ended it a moment before the check.
  // One read cannot tell the two apart: an ended delegation has no output, as one that never existed. The run then ends as Rejected, and not as Cancelled. This is a known limit.
  if (link === undefined) return refused('delegation_invalid', 'no live delegation has this identifier: it does not exist, or it was ended');
  if (link.delegation.delegate !== agentIdOf(senderDid)) return refused('delegation_invalid', 'the delegate of the delegation is not the sender');
  if (link.delegation.delegateKey !== buyerPkh) return refused('delegation_invalid', 'the delegate key of the delegation is not the key of the escrow');
  return accepted(null);
}

/**
 * The delegation and every ancestor can be used at the time `atMs` for the hire action on `resource`. The use check lists each problem: a period that is over, a parent that was ended, a delegate
 * that is not Active or no longer lists its delegation key, a root delegator that is not Active, or a pattern that does not cover the action or the resource. Any problem is `delegation_ended`.
 * An answer that is for another delegation, time, action or resource, or that has the wrong type, is `check_unavailable`. It is never a pass.
 */
export function checkDelegationUsable(answer: DelegationUseCheck, id: DelegationId, atMs: number, resource: string): ProtocolResult<null, 'delegation_ended' | 'check_unavailable'> {
  if (typeof resource !== 'string' || resource === '') throw new TypeError('the resource of the use check must be a text that is not empty');
  const checked = useCheckOf(answer, { id, atMs, resource });
  if (!checked.ok) return checked;
  const use = checked.value;
  // The answer says "usable" exactly when it lists no problem, so a delegation that is not usable has a first problem to name.
  return use.usable ? accepted(null) : refused('delegation_ended', `the delegation cannot be used now: ${clip(use.problems[0])}`);
}

// A transaction that the source does not know is a source that cannot say, and so is a vault datum that cannot be read. Every other reason is an answer: the transaction was read, and it was not a
// payment from a vault of this delegation.
const NOT_PAID: Record<EscrowVaultReason, 'not_vault_paid' | 'check_unavailable'> = {
  transaction_not_found: 'check_unavailable',
  unreadable_vault_datum: 'check_unavailable',
  contract_failed: 'not_vault_paid',
  not_an_escrow_output: 'not_vault_paid',
  continuation: 'not_vault_paid',
  no_vault_input: 'not_vault_paid',
  not_a_payment: 'not_vault_paid',
  other_delegation: 'not_vault_paid',
};

/**
 * The escrow of the job context was paid from a vault of the delegation of the request: the vault script ran a Pay on a Live vault output of that delegation. An escrow that a wallet paid,
 * and an escrow that a vault of another delegation paid, are `not_vault_paid`. A transaction that the source does not know, and a vault datum that cannot be read, are
 * `check_unavailable`. So is an answer for another escrow or another delegation, an answer with the wrong type, and a reason that this code does not know.
 */
export function checkVaultPaid(answer: EscrowVaultResult, escrowRef: OutputRef, delegation: DelegationId): ProtocolResult<null, 'not_vault_paid' | 'check_unavailable'> {
  const checked = paymentOf(answer, escrowRef, delegation);
  if (!checked.ok) return checked;
  const result = checked.value;
  if (result.paid) return accepted(null);
  const code = Object.hasOwn(NOT_PAID, result.reason) ? NOT_PAID[result.reason] : undefined;
  if (code === undefined) return refused('check_unavailable', 'the vault read gave a reason that this code does not know');
  return refused(code, code === 'not_vault_paid' ? `the escrow was not paid from a vault of the delegation (${result.reason})` : `the payment of the escrow could not be read (${result.reason})`);
}
