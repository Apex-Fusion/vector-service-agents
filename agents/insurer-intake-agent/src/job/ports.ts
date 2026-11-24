// agents/insurer-intake-agent/src/job/ports.ts
// The ports of the job of the Insurer Intake Agent (use case 2, prior authorization). Everything that the job reads, writes or decides goes through one of them. The job reads no key file, no environment
// variable and no clock of its own. The service gives the real ports when it starts, and a test gives fakes. The types here are the whole contract between the job and the service.
//
// This file holds types only. The service builds one `IntakeDeps` for a job. The record of the checks that the hook made and the report of the attestations of the sender come in as functions of the deps,
// and the shapes of their answers are written here: this folder imports the kit, the workspace packages and itself, and no other folder of the package. The service fits its own stores and its own report to
// these shapes.
import type { KeyInput } from '@vsa/id-kit/client';
import type { CallDeps, SvidDeps } from '@vsa/usecase-kit/access';
import type { ChecksRecord } from '@vsa/usecase-kit/checks';
import type { DecideResult } from '@vsa/usecase-kit/decision';
import type { AttestationState } from '@vsa/usecase-kit/priorauth';
import type { DelegationId, Did, Digest, JsonValue } from '@vsa/usecase-kit/protocol';

/**
 * What the hook of the Insurer Intake Agent kept for one escrow: the record of the checks that passed, and the hash of the request that it checked (`canonicalSha256` of the handoff). It is a plain copy of the
 * entry of the store of the hook. This folder does not import the folder of the hook or the folder of the stores, so the shape is written here, and the service gives `take` of the store as `takeChecks`.
 */
export interface TakenChecks {
  readonly record: ChecksRecord;
  readonly request_sha256: Digest;
}

/** The part of the intake book that the job uses: it records the request that the insurer portal took. It resolves when the entry is stored, and it rejects when it cannot store it. */
export interface BookPort {
  record(tenant: string, requestNumber: string, intakeId: string): Promise<void>;
}

/**
 * What the model chooses for the decision `completeness`: whether the request meets every requirement of the insurer, and the ids of the requirements that it does not meet. It is a type alias, so that it is
 * JSON data. `complete: true` goes with an empty list, and `complete: false` goes with one or more ids. The decision that checks this is in the second half of the job.
 */
export type CompletenessChoice = { complete: boolean; missing: string[] };

/** The input of the report of the attestations: the sender of the request, the delegation that paid for it, and the time of the job. The report reads the root delegator of the delegation itself. */
export interface ReportInput {
  readonly sender: Did;
  readonly delegation: DelegationId;
  readonly atMs: number;
}

/** What the report found about the sender: one word of `ATTESTATION_STATES` for each of the three attestations. The report never refuses a job. */
export interface AttestationReport {
  readonly provenance: AttestationState;
  readonly software: AttestationState;
  readonly principal_binding: AttestationState;
}

/**
 * Everything that one job of the Insurer Intake Agent needs from the service. The agent has no fault switch, so there is no port for one: the intake record always says `fault_mode: ''`, and the service stamps
 * the same value on the result.
 */
export interface IntakeDeps {
  /** The service key: the DID of the Insurer Intake Agent and its authentication key. The key signs the request for the JWT-SVID, and nothing else. */
  readonly agent: { readonly did: Did; readonly authenticationKey: KeyInput };
  /** The client of the identity gateway, for the JWT-SVID. */
  readonly svid: SvidDeps;
  /**
   * The calls to the insurer portal: the `fetch` and the clock of the caller, and the two origins of the mock service. A call with a JWT-SVID goes through `fetch` to the public origin. `timeoutMs` (60
   * seconds when it is not set) is the longest time of one call, and the service sets 20,000 milliseconds.
   */
  readonly calls: CallDeps;
  /** Takes the record that the hook kept for the escrow, and removes it. It gives null when there is none. The service gives `take` of the store of the hook, with its clock. */
  readonly takeChecks: (escrowRef: string) => TakenChecks | null;
  readonly book: BookPort;
  /** Reports the attestations of the sender. It runs after the Claim, it has its own time budget, and it never throws for a source that cannot be read: that source is the state `unreadable`. */
  readonly report: (input: ReportInput) => Promise<AttestationReport>;
  /**
   * Makes the decision `completeness` for an input of the job. `requirementIds` are the ids of the requirement set of the insurer: the model may name these ids and no others. The service gives `decide` of
   * the kit with `completenessDecision(requirementIds)`, its limits and the deadline of the job.
   */
  readonly decide: (input: JsonValue, requirementIds: readonly string[]) => Promise<DecideResult<CompletenessChoice>>;
  /** The time now, in milliseconds: the clock that gave `arrivedAt`. The job uses it for the time of a log line, and for the time that is left until `deliver_by`. */
  readonly clock: () => number;
  /** Writes one line to the log of the service. A line has codes and references, and no key, no token and no part of a request. A function that throws changes nothing. */
  readonly log: (line: string) => void;
}
