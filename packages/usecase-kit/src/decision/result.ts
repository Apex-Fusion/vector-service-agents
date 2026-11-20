// packages/usecase-kit/src/decision/result.ts
// What `decide` returns. It is a typed result: `{ ok: true, value }` with the decision, or `{ ok: false, code, reason, detail, ... }` with a failure. No code reads success from a text. A failure never
// holds a decision, so a decision that the model did not give cannot be recorded by mistake.
//
// The decision is the `Decision<C>` of the protocol, where `C` is the type of the choice that the parser of the decision gives: the value is the same as an untyped `Decision`, and the caller reads
// `choice` as the type of its parser and does not parse it again. `TypedDecision<C>` is the name of that type in this folder.
//
// A failure has two codes. `code` is the error code of the protocol: it is the code of an error answer of a counterparty, and `ERROR_STATUS[code]` is its status. `reason` is what a buyer-side agent
// writes as the `reason` of a result that has the outcome `failed`.
//
//   code                  reason                         when
//   inference_failed      the code of hire-kit           the hire of the model failed, or its receipt did not pass the checks: `llm_supplier_unavailable` (no model on the allowlist at or
//                                                        under the three limits), `llm_post_failed`, `llm_busy`, `llm_refused`, `llm_send_lost`, `llm_failed`, `llm_timeout`, `llm_bad_result`,
//                                                        `llm_receipt_failed`, `llm_receipt_unavailable`, `llm_accept_failed`, `llm_out_of_time` (the deadline of the run came; when the decision
//                                                        did not start its hire because less than HIRE_MIN_MS was left, nothing was locked), or `hire_threw` (a port threw, or the result of the
//                                                        hire could not be read)
//   store_write_failed    store_write_failed             the stranded store of the key could not be written for the escrow of the hire. At the stage `accept` the Accept was sent and may still land:
//                                                        the supplier may be paid, and the failure has a delivery
//   model_output_invalid  model_output_invalid           the hire completed, and the answer is not an object of the shape that the decision asks for
//   internal              bad_limit                      a limit is missing or has a wrong type, or the deps of the decision cannot be read: nothing was hired
//   internal              bad_decision                   the definition of the decision is wrong, an async parser is wrong, or a parser cannot be read: nothing was hired. Or the parser returned a
//                                                        promise: that is after the hire, so the failure has a delivery
//   internal              bad_input                      the input is not JSON data, or its prompt has more than MAX_PROMPT_BYTES bytes: nothing was hired
//   internal              bad_deps                       the clock does not give the time, or the deadline is not a number: nothing was hired
//   internal              choice_changed                 the parser of the decision returned a value that is not the choice that the model gave
//
// `delivery` is set for every failure after an Accept: the hire was paid, and the failure says so. A store that cannot be written for an Accept that was sent and may still land is one of them: the
// supplier may be paid, and `accepted` is `pending`. The delivery holds the complete sub-job (`PaidDelivery`) when the record of the hire can be recorded, and otherwise as much of it as can be recorded
// (`UnrecordedDelivery`: the escrow, the advert, the key hash of the supplier and the eight checks, and a typed member that says that the receipt is not recorded). The agent carries the delivery in its
// failed result. A failure before an Accept has no delivery. `escrow_ref` and `stage` are set for every failure after a Post, and they say where the hire ended. An escrow that a failed hire left is with
// the janitor of the key.
import type { HireStage } from '@vsa/hire-kit';
import type { Accepted, Decision, ErrorCode, JsonValue, OutputRef, PaidDelivery, ReceiptVerification, Refused } from '../protocol/index.ts';

/** The error codes that a failed decision has. Each is a code of the protocol, so `ERROR_STATUS` gives its status. */
export const DECISION_FAILURE_CODES = ['inference_failed', 'store_write_failed', 'model_output_invalid', 'internal'] as const satisfies readonly ErrorCode[];
export type DecisionFailureCode = (typeof DECISION_FAILURE_CODES)[number];

/**
 * A hire that was paid, and whose sub-job cannot be recorded in full. `sub_job` is null, and `receipt` says that the receipt is not recorded: it cannot be copied as JSON data, or a check of it is
 * not true, or the record of the hire was not handed over at all (a port threw after the Accept, the store could not be written for an Accept that may still land, or the result of the hire could not
 * be read). Each other member is what could be read, and it is null when it could not be: the escrow, the advert, the key hash of the supplier and the eight checks. The supplier writes the receipt,
 * so a supplier can make a hire that is paid and has no complete sub-job.
 */
export interface UnrecordedDelivery {
  readonly sub_job: null;
  readonly receipt: 'not_recordable';
  readonly accepted: 'confirmed' | 'pending';
  readonly escrow_ref: OutputRef | null;
  readonly advert_ref: OutputRef | null;
  readonly supplier_pkh: string | null;
  readonly verification: ReceiptVerification | null;
}

export interface DecisionFailure extends Refused<DecisionFailureCode> {
  /** What a result with the outcome `failed` gives as its `reason`. See the table at the head of this file. */
  readonly reason: string;
  /** The hire that was paid, for every failure after an Accept: whole (`sub_job` is a sub-job), or as much as can be recorded (`sub_job` is null). Null for every other failure. */
  readonly delivery: PaidDelivery | UnrecordedDelivery | null;
  /** The escrow of the hire, for every failure after a Post when its reference is known. It is a public reference. */
  readonly escrow_ref: OutputRef | null;
  /**
   * Where the hire was when it ended: `accept` for a hire that was paid, or may be, whatever failed after the Accept. For an error that hire-kit did not make, the last stage that the ledger told of:
   * `post` once it booked the Post. A hire that gave a result that could not be read is at `accept`. Null when no escrow was posted and the failure is not a failure of the hire, and for a throw that no ledger call came before.
   */
  readonly stage: HireStage | null;
}

/** A decision whose choice has the type of the parser of the decision. It is the generic `Decision` of the protocol. */
export type TypedDecision<C extends JsonValue> = Decision<C>;

export type DecideResult<C extends JsonValue> = Accepted<TypedDecision<C>> | DecisionFailure;
