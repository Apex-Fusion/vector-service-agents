// packages/usecase-kit/src/protocol/results.ts
// The results of a buyer-side agent, as types, and the one rule for their exit state. A buyer-side agent answers 200 with an `outcome` whenever it could read the request, so the signed receipt of the
// job commits to what happened.
//
//   propose  ProposalResult: the document, the salt and the digest of the proposal, the decisions of the model and the sub-jobs that bought them.
//   execute  ExecuteResult: the outcome, its reason, the exit state, the handoff to the counterparty, the writes to the mock systems, the challenge, and the decisions.
//
// `reason` is a code or a sentence that goes with the outcome: the code of the counterparty for `refused_by_counterparty`, the evaluation error of the node for `vault_refused`, the code of the mock
// system for `refused_by_system`, and a code for `failed`. A job that was carried out has no reason. `fault_mode` is in every result: it is empty in a clean run.
//
// The exit state is fixed by one rule, `exitStateOf`, and the types below agree with it: a result with a pair of outcome and exit state that the function cannot give does not compile. The one exception
// is the reason `approval_expired` with the state `Rejected`: see RefusedResult. A result is made with no cast:
//   completed, failed, disputed (two forms)       write the one state of the form: `Completed`, `Failed`, `Escalated`, or `Failed`.
//   vault_refused                                 `exit_state: exitStateOf({ outcome: 'vault_refused', ... })`. For this outcome the type of the call is the state type of the result.
//   refused_by_counterparty, refused_by_system    `...refusedExit(reason)`. It gives the reason and its state together, and the type of a refused result needs that pair.
import type { ExecuteOutcome, ExitState, UseCase } from './codes.ts';
import type { FaultSetting } from './faults.ts';
import type { Did, Digest, KeyHash, OutputRef, Salt } from './identifiers.ts';
import type { Document, JsonObject, JsonValue } from './json.ts';
import type { PROPOSAL_SCHEMA, RESULT_SCHEMA } from './messages.ts';

/** The eight checks that a buyer runs on the receipt of a sub-job before it accepts the escrow, in the order of the verification object. */
export const RECEIPT_CHECKS = [
  'escrow_ref_matches', 'response_hash_matches', 'supplier_key_matches', 'signature_valid', 'on_chain_hash_matches', 'prompt_hash_matches', 'model_matches', 'fields_match',
] as const;
export type ReceiptCheck = (typeof RECEIPT_CHECKS)[number];
/** Each check of a receipt, true when it passed. An escrow is accepted only when all eight are true. */
export type ReceiptVerification = Readonly<Record<ReceiptCheck, boolean>>;

/** A job that an agent bought from another agent: its escrow, the signed receipt as the supplier gave it, and the checks that the buyer ran on it. */
export interface SubJob {
  readonly capability_id: string;
  readonly advert_ref: OutputRef;
  readonly escrow_ref: OutputRef;
  /** The hash of the supplier key: 56 lower-case hex characters. */
  readonly supplier_pkh: KeyHash;
  readonly receipt: JsonObject;
  readonly receipt_signature: string;
  readonly verification: ReceiptVerification;
}

/** The sub-job of a hire that was paid, and whether its Accept was seen on the chain: `confirmed` when the Accept was seen on the chain, and `pending` when it was sent and not yet seen. */
export interface PaidDelivery {
  readonly sub_job: SubJob;
  readonly accepted: 'confirmed' | 'pending';
}

/**
 * A decision of the model. The agent keeps the choice as the model gave it: no code of the agent changes, clamps or computes it again. `C` is the type of the choice: a caller that knows the shape of its
 * choice reads `Decision<C>`, and with no argument the choice is any JSON value.
 */
export interface Decision<C extends JsonValue = JsonValue> {
  readonly name: string;
  readonly choice: C;
  readonly reasoning: string;
  readonly inference: { readonly path: 'marketplace' } & PaidDelivery;
}

interface ProposalResultBase {
  readonly schema: typeof PROPOSAL_SCHEMA;
  readonly use_case: UseCase;
  readonly decisions: readonly Decision[];
  readonly sub_jobs: readonly SubJob[];
  readonly fault_mode: FaultSetting;
}

/** A proposal that was made. The hirer reads the document and approves `proposal_digest`. A run gets its exit state at its end, so a proposal that was made has none. */
export interface ProposedResult extends ProposalResultBase {
  readonly document: Document;
  readonly salt: Salt;
  readonly proposal_digest: Digest;
  readonly outcome: 'proposed';
  readonly exit_state: null;
  readonly reason: null;
}

/** A job that could not make a proposal. The exit state is `Failed`. The document, the salt and the digest are null when the job failed before it had a document. */
export interface FailedProposalResult extends ProposalResultBase {
  readonly document: Document | null;
  readonly salt: Salt | null;
  readonly proposal_digest: Digest | null;
  readonly outcome: 'failed';
  readonly exit_state: 'Failed';
  readonly reason: string;
}

export type ProposalResult = ProposedResult | FailedProposalResult;

/** The hire of the counterparty. An escrow that the counterparty refused before it claimed has no receipt: the members of the delivery are then null. */
export interface HandoffRecord {
  readonly counterparty_did: Did;
  readonly advert_ref: OutputRef;
  readonly escrow_ref: OutputRef;
  readonly paid_from_vault: boolean;
  readonly receipt: JsonObject | null;
  readonly receipt_signature: string | null;
  readonly verification: ReceiptVerification | null;
  /** The result that the counterparty returned: the confirmation, the intake record or the quote. */
  readonly result: JsonObject | null;
  readonly accepted: 'confirmed' | 'pending' | 'no' | null;
}

/** A call that changed a mock system. */
export interface WriteRecord {
  readonly system: string;
  /** For example `POST /po`. */
  readonly route: string;
  readonly status: number;
  readonly ref: string | null;
}

/** The challenge that the agent filed: the claim, the transaction that published the evidence, and the challenge output. */
export interface ChallengeRecord {
  readonly claim: OutputRef;
  readonly evidence: string;
  readonly challenge: OutputRef;
}

/** The reason of a dispute with no challenge when the other party has no open claim, so that the agent files no challenge. */
export const NO_OPEN_CLAIM = 'no_open_claim';

interface ExecuteResultBase {
  readonly schema: typeof RESULT_SCHEMA;
  readonly use_case: UseCase;
  readonly proposal_digest: Digest;
  /** The hire of the counterparty, or null when no escrow was posted, and in the third use case, which hires no counterparty to execute. */
  readonly handoff: HandoffRecord | null;
  readonly writes: readonly WriteRecord[];
  readonly decisions: readonly Decision[];
  readonly fault_mode: FaultSetting;
}

/** The approved proposal was carried out. */
export interface CompletedResult extends ExecuteResultBase {
  readonly outcome: 'completed';
  readonly reason: null;
  readonly challenge: null;
  readonly exit_state: 'Completed';
}

/** The agent did not accept the delivery and filed a challenge. */
export interface EscalatedResult extends ExecuteResultBase {
  readonly outcome: 'disputed';
  readonly reason: null;
  readonly challenge: ChallengeRecord;
  readonly exit_state: 'Escalated';
}

/** The agent did not accept the delivery and filed no challenge. The reason is NO_OPEN_CLAIM, or the code of the step that failed. */
export interface UnfiledDisputeResult extends ExecuteResultBase {
  readonly outcome: 'disputed';
  readonly reason: string;
  readonly challenge: null;
  readonly exit_state: 'Failed';
}

export type DisputedResult = EscalatedResult | UnfiledDisputeResult;

interface RefusedResultBase extends ExecuteResultBase {
  readonly outcome: 'refused_by_counterparty' | 'refused_by_system';
  readonly challenge: null;
}

/** The reason of a refused result and its exit state, as a pair. TypeScript proves the state for a reason that is a literal type, so the third form takes any other reason. `refusedExit` makes the pair. */
export type RefusedExit =
  | { readonly reason: 'approval_expired'; readonly exit_state: 'Expired' }
  | { readonly reason: 'delegation_ended'; readonly exit_state: 'Cancelled' }
  | { readonly reason: string; readonly exit_state: 'Rejected' };

/**
 * The counterparty or a mock system refused. The reason is its code. The state follows the reason, as `exitStateOf` gives it: `Expired` for `approval_expired`, `Cancelled` for `delegation_ended`, and
 * `Rejected` for any other code. The type cannot refuse the reason `approval_expired` with the state `Rejected`, because TypeScript has no type for a string that is not one of two given strings. Make the
 * reason and the state with `...refusedExit(reason)`, so that the pair is right. `exit_state: exitStateOf(...)` does not compile here: the type of that call does not prove that the state goes with the
 * reason that stands beside it.
 */
export type RefusedResult = RefusedResultBase & RefusedExit;

/** The ledger refused the payment from the vault. The reason is the evaluation error. The state is `Cancelled` when the hirer ended the delegation, and `Failed` in every other case. Make the state with `exitStateOf`. */
export interface VaultRefusedResult extends ExecuteResultBase {
  readonly outcome: 'vault_refused';
  readonly reason: string;
  readonly challenge: null;
  readonly exit_state: 'Cancelled' | 'Failed';
}

/** The job could not be finished. The reason is a code. */
export interface FailedResult extends ExecuteResultBase {
  readonly outcome: 'failed';
  readonly reason: string;
  readonly challenge: null;
  readonly exit_state: 'Failed';
}

export type ExecuteResult = CompletedResult | DisputedResult | RefusedResult | VaultRefusedResult | FailedResult;

/** What the exit state of an `execute` result depends on. */
export interface ExitStateInput {
  readonly outcome: ExecuteOutcome;
  /** The reason of the result, or null when it has none. */
  readonly reason: string | null;
  /** True when the agent filed a challenge. */
  readonly challenge_filed: boolean;
  /** True when the agent read the delegation after a refusal of the vault and found that the hirer ended it. */
  readonly delegation_ended: boolean;
}

/** The input of `exitStateOf` for an outcome that the compiler knows. */
type ExitStateInputFor<O extends ExecuteOutcome> = ExitStateInput & { readonly outcome: O };

/**
 * The exit state of an `execute` result. It is the one rule for every buyer-side agent:
 *   completed                                    Completed
 *   disputed, challenge filed                    Escalated
 *   disputed, no challenge filed                 Failed
 *   refused_by_counterparty, refused_by_system   Expired for the reason `approval_expired`, Cancelled for the reason `delegation_ended`, and Rejected for any other reason
 *   vault_refused                                Cancelled when the delegation ended, and Failed in every other case
 *   failed                                       Failed
 * A flag counts only when it is the boolean `true`. An outcome that the protocol does not have gives `Failed`: it is never a pass.
 *
 * An outcome that the compiler knows gives the state type of the result for that outcome, so `exit_state: exitStateOf({ outcome: 'vault_refused', ... })` needs no cast. An outcome that only the run
 * knows gives `ExitState`. A refused outcome gives `Rejected`, `Expired` or `Cancelled`, but the type of a refused result links the state to the reason: take the pair from `refusedExit`.
 */
export function exitStateOf(input: ExitStateInputFor<'completed'>): 'Completed';
export function exitStateOf(input: ExitStateInputFor<'failed'>): 'Failed';
export function exitStateOf(input: ExitStateInputFor<'vault_refused'>): 'Cancelled' | 'Failed';
export function exitStateOf(input: ExitStateInputFor<'disputed'>): 'Escalated' | 'Failed';
export function exitStateOf(input: ExitStateInputFor<'refused_by_counterparty' | 'refused_by_system'>): 'Rejected' | 'Expired' | 'Cancelled';
export function exitStateOf(input: ExitStateInput): ExitState;
export function exitStateOf(input: ExitStateInput): ExitState {
  const { outcome, reason } = input;
  switch (outcome) {
    case 'completed':
      return 'Completed';
    case 'disputed':
      return input.challenge_filed === true ? 'Escalated' : 'Failed';
    case 'refused_by_counterparty':
    case 'refused_by_system':
      return reason === 'approval_expired' ? 'Expired' : reason === 'delegation_ended' ? 'Cancelled' : 'Rejected';
    case 'vault_refused':
      return input.delegation_ended === true ? 'Cancelled' : 'Failed';
    case 'failed':
      return 'Failed';
    default:
      return 'Failed';
  }
}

/**
 * The reason of a refused result and its exit state, as the pair that the type of the result needs: `Expired` for `approval_expired`, `Cancelled` for `delegation_ended`, and `Rejected` for any other reason.
 * Spread it into the result: `{ ...base, outcome, ...refusedExit(reason), challenge: null }`. It gives the state that `exitStateOf` gives for a refused outcome with the same reason.
 */
export function refusedExit(reason: string): RefusedExit {
  if (reason === 'approval_expired') return { reason, exit_state: 'Expired' };
  if (reason === 'delegation_ended') return { reason, exit_state: 'Cancelled' };
  return { reason, exit_state: 'Rejected' };
}
