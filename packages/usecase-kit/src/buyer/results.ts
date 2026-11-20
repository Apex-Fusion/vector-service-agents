// packages/usecase-kit/src/buyer/results.ts
// The results of a buyer-side agent, made from their pieces. A caller gives the pieces once, and the helper writes every member of the result: no caller builds a result by hand and leaves a
// member out. The exit state of an `execute` result comes from `exitStateOf` of the protocol, in this file only, and no helper writes a state of its own. A piece of the wrong shape is a
// fault of the code of the caller: the helper throws a TypeError and makes no result.
//
//   propose  proposedResult, failedProposalResult
//   execute  completedResult, refusedResult, vaultRefusedResult, failedResult, disputedResult, and settledResult for the steps of the hire that need nothing more from the use case
import { DOCUMENT_SCHEMAS, HANDOFF_USE_CASES, PROPOSAL_SCHEMA, RECEIPT_CHECKS, RESULT_SCHEMA, USE_CASES, exitStateOf, makeProposal, parseDigest, refusedExit } from '@vsa/usecase-kit/protocol';
import type {
  ChallengeRecord, CompletedResult, Decision, Digest, DisputedResult, ExecuteOutcome, ExecuteResult, ExitState, FailedProposalResult, FailedResult, FaultSetting, HandoffRecord,
  Proposal, ProposalResult, RefusedResult, SubJob, UseCase, VaultRefusedResult, WriteRecord,
} from '@vsa/usecase-kit/protocol';
import type { CompletedStep, HireStep, InterruptionCause, NotAcceptedStep, RefusedStep } from './steps.ts';

/** The reason of a result for an error that ended the hire after the Pay was confirmed. */
export const INTERRUPTION_REASONS: Readonly<Record<InterruptionCause, string>> = {
  deadline: 'deadline', store_write: 'store_write_failed', decision_error: 'decision_error', other: 'hire_interrupted',
};
/** The reason of a result for a Pay that was sent and not seen confirmed. */
export const PAY_UNCONFIRMED = 'pay_unconfirmed';
/** The reason of a proposal whose document the protocol or the use case refuses. */
export const BAD_DOCUMENT = 'bad_document';

/** What every `execute` result holds besides its outcome. */
export interface ResultPieces {
  readonly use_case: UseCase;
  /** The digest of the proposal that the hirer approved. */
  readonly proposal_digest: Digest;
  /** The hire of the counterparty, or `null` when no escrow was posted. */
  readonly handoff: HandoffRecord | null;
  /** Every call that changed a mock system. */
  readonly writes: readonly WriteRecord[];
  /** Every decision of the model in the job. */
  readonly decisions: readonly Decision[];
  /** The value of the fault setting: the empty text in a clean run. */
  readonly fault_mode: FaultSetting;
}

function checkedPieces(pieces: ResultPieces): ResultPieces {
  const { use_case: useCase, proposal_digest: digest, handoff, writes, decisions, fault_mode: fault } = pieces;
  if (!(USE_CASES as readonly unknown[]).includes(useCase)) throw new TypeError('use_case must be one of the use cases of the protocol');
  if (!parseDigest(digest, 'proposal_digest').ok) throw new TypeError('proposal_digest must be the digest of a proposal');
  if (handoff !== null && (typeof handoff !== 'object' || Array.isArray(handoff))) throw new TypeError('handoff must be a record of a hire, or null');
  if (!Array.isArray(writes)) throw new TypeError('writes must be a list');
  if (!Array.isArray(decisions)) throw new TypeError('decisions must be a list');
  if (typeof fault !== 'string') throw new TypeError('fault_mode must be a text');
  return { use_case: useCase, proposal_digest: digest, handoff, writes: [...writes], decisions: [...decisions], fault_mode: fault };
}

/** The members that every `execute` result has. */
function baseOf(pieces: ResultPieces): ResultPieces & { readonly schema: typeof RESULT_SCHEMA } {
  return { schema: RESULT_SCHEMA, ...checkedPieces(pieces) };
}

/** The exit state that the rule of the protocol gives. A state that the type of the result cannot hold is a fault, and it never becomes a result. */
function stateOf(outcome: ExecuteOutcome, reason: string | null, filed: boolean, ended: boolean): ExitState {
  return exitStateOf({ outcome, reason, challenge_filed: filed, delegation_ended: ended });
}

function reasonOf(reason: unknown): string {
  if (typeof reason !== 'string' || reason === '') throw new TypeError('the reason must be a code that is not empty');
  return reason;
}

function wrongState(outcome: ExecuteOutcome, state: ExitState): Error {
  return new Error(`exitStateOf gave ${state} for ${outcome}, which the result of ${outcome} cannot hold`);
}

/** The record of a hire that was verified and accepted: the receipt and its signature, all eight checks true, and the Accept confirmed or pending. */
function holdsAcceptedHire(handoff: HandoffRecord | null): boolean {
  if (handoff === null) return false;
  const { verification } = handoff;
  const accepted = handoff.accepted === 'confirmed' || handoff.accepted === 'pending';
  return accepted && handoff.receipt !== null && handoff.receipt_signature !== null && verification !== null && RECEIPT_CHECKS.every((check) => verification[check] === true);
}

/**
 * The approved proposal was carried out. A use case that hires a counterparty needs the record of a hire that was verified and accepted: a record that holds none is a fault of the caller, and
 * the function throws and makes no result. Use case 3 (supplier bid evaluation) hires no counterparty to execute, so its record is `null`.
 */
export function completedResult(pieces: ResultPieces): CompletedResult {
  const base = baseOf(pieces);
  if ((HANDOFF_USE_CASES as readonly string[]).includes(base.use_case) && !holdsAcceptedHire(base.handoff)) {
    throw new TypeError('a completed result of this use case needs the record of a hire that was verified and accepted');
  }
  const state = stateOf('completed', null, false, false);
  if (state !== 'Completed') throw wrongState('completed', state);
  return { ...base, outcome: 'completed', reason: null, challenge: null, exit_state: state };
}

/** The counterparty (`by` is `counterparty`) or a mock system (`system`) refused. `reason` is its code. The exit state follows the reason: `refusedExit` of the protocol gives the two as one pair. */
export function refusedResult(by: 'counterparty' | 'system', pieces: ResultPieces, reason: string): RefusedResult {
  const outcome = by === 'counterparty' ? 'refused_by_counterparty' : 'refused_by_system';
  if (by !== 'counterparty' && by !== 'system') throw new TypeError('a refusal is by the counterparty or by a mock system');
  return { ...baseOf(pieces), outcome, ...refusedExit(reasonOf(reason)), challenge: null };
}

/** The ledger refused the Pay from the vault. `reason` is the evaluation error. `delegationEnded` is true when the flow read the delegation again and found that the hirer ended it. */
export function vaultRefusedResult(pieces: ResultPieces, reason: string, delegationEnded: boolean): VaultRefusedResult {
  if (typeof delegationEnded !== 'boolean') throw new TypeError('delegationEnded must be a boolean');
  const code = reasonOf(reason);
  const state = stateOf('vault_refused', code, false, delegationEnded);
  if (state !== 'Cancelled' && state !== 'Failed') throw wrongState('vault_refused', state);
  return { ...baseOf(pieces), outcome: 'vault_refused', reason: code, challenge: null, exit_state: state };
}

/** The job could not be finished. `reason` is a code. */
export function failedResult(pieces: ResultPieces, reason: string): FailedResult {
  const code = reasonOf(reason);
  const state = stateOf('failed', code, false, false);
  if (state !== 'Failed') throw wrongState('failed', state);
  return { ...baseOf(pieces), outcome: 'failed', reason: code, challenge: null, exit_state: state };
}

/**
 * The agent did not accept the delivery. With a challenge that it filed, the state is `Escalated`. With no challenge, `reason` is `NO_OPEN_CLAIM`, or the code of the step that failed, and the
 * state is `Failed`.
 */
export function disputedResult(pieces: ResultPieces, dispute: { readonly challenge: ChallengeRecord } | { readonly reason: string }): DisputedResult {
  if ('challenge' in dispute) {
    const state = stateOf('disputed', null, true, false);
    if (state !== 'Escalated') throw wrongState('disputed', state);
    return { ...baseOf(pieces), outcome: 'disputed', reason: null, challenge: dispute.challenge, exit_state: state };
  }
  const code = reasonOf(dispute.reason);
  const state = stateOf('disputed', code, false, false);
  if (state !== 'Failed') throw wrongState('disputed', state);
  return { ...baseOf(pieces), outcome: 'disputed', reason: code, challenge: null, exit_state: state };
}

/** The steps that the use case has to finish itself: a completed hire writes to a mock system, a delivery that was not accepted is disputed, and a refused request is an error answer. */
export type SettledStep = Exclude<HireStep, CompletedStep | NotAcceptedStep | RefusedStep>;

/**
 * The result for a step of the hire that needs nothing more from the use case. The handoff comes from the step. A step that the use case must finish (`completed`, `not_accepted`, `refused`)
 * is a fault of the caller: the function throws and makes no result.
 */
export function settledResult(step: SettledStep, pieces: Omit<ResultPieces, 'handoff'>): ExecuteResult {
  switch (step.kind) {
    case 'refused_by_counterparty': return refusedResult('counterparty', { ...pieces, handoff: step.handoff }, step.reason);
    case 'vault_refused': return vaultRefusedResult({ ...pieces, handoff: null }, step.reason, step.delegation_ended);
    case 'failed': return failedResult({ ...pieces, handoff: step.handoff }, step.reason);
    case 'interrupted': return failedResult({ ...pieces, handoff: step.handoff }, INTERRUPTION_REASONS[step.cause_kind]);
    case 'pay_unconfirmed': return failedResult({ ...pieces, handoff: step.handoff }, PAY_UNCONFIRMED);
    default: {
      const exhaustive: never = step;
      throw new TypeError(`the step ${String(Reflect.get(exhaustive, 'kind'))} needs the use case to finish it`);
    }
  }
}

/** What every `propose` result holds besides its outcome. */
export interface ProposalPieces {
  readonly use_case: UseCase;
  readonly decisions: readonly Decision[];
  readonly sub_jobs: readonly SubJob[];
  readonly fault_mode: FaultSetting;
}

function checkedProposalPieces(pieces: ProposalPieces): ProposalPieces {
  const { use_case: useCase, decisions, sub_jobs: subJobs, fault_mode: fault } = pieces;
  if (!(USE_CASES as readonly unknown[]).includes(useCase)) throw new TypeError('use_case must be one of the use cases of the protocol');
  if (!Array.isArray(decisions)) throw new TypeError('decisions must be a list');
  if (!Array.isArray(subJobs)) throw new TypeError('sub_jobs must be a list');
  if (typeof fault !== 'string') throw new TypeError('fault_mode must be a text');
  return { use_case: useCase, decisions: [...decisions], sub_jobs: [...subJobs], fault_mode: fault };
}

/** A job that could not make a proposal. The document, the salt and the digest are those of `proposal`, and they are null when the job failed before it had a document. */
export function failedProposalResult(pieces: ProposalPieces, reason: string, proposal: Proposal | null = null): FailedProposalResult {
  const code = reasonOf(reason);
  const state = stateOf('failed', code, false, false);
  if (state !== 'Failed') throw wrongState('failed', state);
  return {
    schema: PROPOSAL_SCHEMA, ...checkedProposalPieces(pieces), document: proposal?.document ?? null, salt: proposal?.salt ?? null, proposal_digest: proposal?.proposal_digest ?? null,
    outcome: 'failed', exit_state: state, reason: code,
  };
}

/**
 * The result of `propose` for the document of a use case: the proposal that `makeProposal` makes (with `salt` when it is given, else a new salt), and the decisions and sub-jobs that made the
 * document. Nothing is paid here. A document that the protocol refuses, or whose `schema` is not the schema of the use case, is a failed proposal with the reason `bad_document` and no document:
 * the hirer is never shown a document that the digest cannot cover.
 */
export function proposedResult(document: unknown, pieces: ProposalPieces, salt?: unknown): ProposalResult {
  const checked = checkedProposalPieces(pieces);
  const proposal = makeProposal(document, salt);
  if (!proposal.ok || proposal.value.document.schema !== DOCUMENT_SCHEMAS[checked.use_case]) return failedProposalResult(checked, BAD_DOCUMENT);
  return {
    schema: PROPOSAL_SCHEMA, ...checked, document: proposal.value.document, salt: proposal.value.salt, proposal_digest: proposal.value.proposal_digest,
    outcome: 'proposed', exit_state: null, reason: null,
  };
}
