// packages/usecase-kit/src/protocol/results.ts
// The results of a buyer-side agent, as types. A buyer-side agent answers 200 with an `outcome` whenever it could read the request, so the signed receipt of the job commits to what happened.
//
//   propose  ProposalResult: the document, the salt and the digest of the proposal, the decisions of the model and the sub-jobs that bought them.
//   execute  ExecuteResult: the outcome, its reason, the exit state, the handoff to the counterparty, the writes to the mock systems, the challenge, and the decisions.
//
// `reason` is a code or a sentence that goes with the outcome: the code of the counterparty for `refused_by_counterparty`, the evaluation error of the node for `vault_refused`, the code of the mock
// system for `refused_by_system`, and a code for `failed`. A job that was carried out has no reason. `fault_mode` is in every result: it is empty in a clean run.
import type { ExecuteOutcome, ExitState, UseCase } from './codes.ts';
import type { FaultSetting } from './faults.ts';
import type { Did, Digest, OutputRef, Salt } from './identifiers.ts';
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
  readonly supplier_pkh: string;
  readonly receipt: JsonObject;
  readonly receipt_signature: string;
  readonly verification: ReceiptVerification;
}

/** A decision of the model. The agent keeps the choice as the model gave it: no code of the agent changes, clamps or computes it again. */
export interface Decision {
  readonly name: string;
  readonly choice: JsonValue;
  readonly reasoning: string;
  readonly inference: {
    readonly path: 'marketplace';
    readonly sub_job: SubJob;
    /** `confirmed` when the Accept was seen on the chain, and `pending` when it was sent and not yet seen. */
    readonly accepted: 'confirmed' | 'pending';
  };
}

interface ProposalResultBase {
  readonly schema: typeof PROPOSAL_SCHEMA;
  readonly use_case: UseCase;
  readonly decisions: readonly Decision[];
  readonly sub_jobs: readonly SubJob[];
  /** The exit state is null for a job that proposed. A run gets its exit state at its end. */
  readonly exit_state: ExitState | null;
  readonly fault_mode: FaultSetting;
}

/** A proposal that was made. The hirer reads the document and approves `proposal_digest`. */
export interface ProposedResult extends ProposalResultBase {
  readonly document: Document;
  readonly salt: Salt;
  readonly proposal_digest: Digest;
  readonly outcome: 'proposed';
  readonly reason: null;
}

/** A job that could not make a proposal. The document, the salt and the digest are null when the job failed before it had a document. */
export interface FailedProposalResult extends ProposalResultBase {
  readonly document: Document | null;
  readonly salt: Salt | null;
  readonly proposal_digest: Digest | null;
  readonly outcome: 'failed';
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

interface ExecuteResultBase {
  readonly schema: typeof RESULT_SCHEMA;
  readonly use_case: UseCase;
  readonly exit_state: ExitState;
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
}

/** The agent did not accept the delivery and filed a challenge. There is no challenge, and the reason says why, when the other party had no open claim. */
export interface DisputedResult extends ExecuteResultBase {
  readonly outcome: 'disputed';
  readonly reason: string | null;
  readonly challenge: ChallengeRecord | null;
}

/** The vault, the counterparty or a mock system refused, or the job failed. The reason says why. */
export interface RefusedResult extends ExecuteResultBase {
  readonly outcome: Exclude<ExecuteOutcome, 'completed' | 'disputed'>;
  readonly reason: string;
  readonly challenge: null;
}

export type ExecuteResult = CompletedResult | DisputedResult | RefusedResult;
