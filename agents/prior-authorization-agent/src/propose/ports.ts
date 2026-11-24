// agents/prior-authorization-agent/src/propose/ports.ts
// What `runPropose` needs from the outside, as ports: functions and plain values. The service joins them to the real ledger reads, evidence, reader of the insurer, model and counter, and a test gives its own.
// This folder does not import the model, evidence, insurer, counter, execute or serve folders of the agent. The evidence, the reader of the insurer, the counter and the decision come in as functions, written
// here as plain shapes that the real parts of the service fit, and the kit gives the types of the rest.
import type { Clock, SerialQueue, TxSigner } from '@vsa/usecase-kit/access';
import type { LedgerReads } from '@vsa/usecase-kit/buyer';
import type { Guideline, RecordSet } from '@vsa/usecase-kit/priorauth';
import type { Decision, DelegationId, Did, OutputRef, ProposeRequest as ProtocolProposeRequest, ProtocolResult, TenantId } from '@vsa/usecase-kit/protocol';

/** A `propose` request of the Prior Authorization Agent: the members of the protocol, the clinical order to draft a request for, and the insurer whose intake agent takes the request. */
export type ProposeRequest = ProtocolProposeRequest<{ readonly order_id: string; readonly insurer_did: Did }>;

/** A delegation key of this agent that the service holds. A delegation names one of them as its delegate key. */
export interface DelegationKey {
  /** The signer of the key. It signs the Delegate and the Undelegate of a sub-delegation, and its hash is the delegate key of the delegation of the hirer. */
  readonly signer: TxSigner;
  /** The address of the wallet of the key. The wallet pays the fees of the sub-delegations and gets their deposits back. */
  readonly walletAddress: string;
  /** The queue of the wallet: the one object that holds every transaction of this key, also those of the hires and of the janitor. */
  readonly queue: SerialQueue;
}

/** What the evidence reads for: the tenant and the order of the request, the delegation of the hirer, and the delegation key that is the delegate key of that delegation. */
export interface EvidenceRequest {
  readonly tenant: TenantId;
  readonly order_id: string;
  readonly delegation: DelegationId;
  readonly key: DelegationKey;
}

/** The time of the evidence. `deadline` is a POSIX time in milliseconds: a read does not start when it would end after it. `signal` aborts when the caller hangs up. */
export interface EvidenceRun {
  readonly deadline: number;
  readonly signal?: AbortSignal;
}

/** What the evidence gives: the record set of the order and the guideline of its service, as the two subagents read them, or the code of the failure. */
export type EvidenceResult = { readonly ok: true; readonly record_set: RecordSet; readonly guideline: Guideline } | { readonly ok: false; readonly code: string };

/** The choice of the decision `justification`: the text of the justification, and the criteria of the guideline and the records that it cites. */
export interface JustificationChoice {
  readonly justification: string;
  readonly guideline_refs: readonly string[];
  readonly record_refs: readonly string[];
}

/**
 * The decision `justification`: the decision with its receipt and the choice that it holds, or the code of the failure. A failure holds no decision. The code of a failure is the reason of the failed decision,
 * for example `llm_out_of_time`, `model_output_invalid`, or `bad_input` for a prompt that is too large: a decision that fails before it hires the model, as `bad_input` does, paid nothing. `choice` must be the
 * choice that `decision.choice` records, with the same members and the same values: `runPropose` builds the request from `choice` only when the two are equal, and it fails with `decision_mismatch` when they
 * differ.
 */
export type JustifyAnswer = { readonly ok: true; readonly decision: Decision; readonly choice: JustificationChoice } | { readonly ok: false; readonly code: string };

/**
 * Everything that `runPropose` reads or does outside its own code. Each failure of a port is a typed result of the job, and no port gets a retry.
 * - `agent.did` is the DID that the delegation of the hirer names as its delegate.
 * - `reads` is the ledger reads of the kit. Its reading of a delegation holds the delegate and whether the chain is whole, and not the delegate key.
 * - `delegateKeyOf` gives the hash of the delegate key of the delegation, `null` when the ledger shows no such delegation, and rejects when the ledger cannot be read. `delegationKeys.find` gives the key of
 *   this agent with that hash, or `null`.
 * - `readInsurer` reads the advert of the Insurer Intake Agent of the insurer. It reads the chain and the list of adverts, and it sends nothing. It gives the reference of the advert, or the code of the failure.
 * - `evidence` reads the record set of the order and the guideline of its service through two subagents. It gets the time that the decision leaves it: `run.deadline` is earlier than the deadline of the job.
 * - `justify` asks the model for the justification of the request. It gets the record set and the guideline that the job checked.
 * - `counter` gives the number of the request. It stores the number before it gives it out. The job asks it only after every check passed.
 * - `clock` is the clock of the job.
 * - `log` gets one line for each job that stops, with the step and the code. A line has codes and references, and no key, token or part of a record. A function that throws changes no result.
 */
export interface ProposeDeps {
  readonly agent: { readonly did: Did };
  readonly reads: LedgerReads;
  readonly delegateKeyOf: (id: DelegationId) => Promise<string | null>;
  readonly delegationKeys: { find(keyHash: string): DelegationKey | null };
  readonly readInsurer: (insurer: Did) => Promise<ProtocolResult<{ readonly advert_ref: OutputRef }, string>>;
  readonly evidence: (request: EvidenceRequest, run: EvidenceRun) => Promise<EvidenceResult>;
  readonly justify: (set: RecordSet, guideline: Guideline) => Promise<JustifyAnswer>;
  readonly counter: { next(tenant: string): Promise<number> };
  readonly clock: Clock;
  readonly log: (line: string) => void;
}
