// packages/usecase-kit/src/decision/result.ts
// What `decide` returns. It is a typed result: `{ ok: true, value }` with the decision, or `{ ok: false, code, reason, detail, ... }` with a failure. No code reads success from a text. A failure never
// holds a decision, so a decision that the model did not give cannot be recorded by mistake.
//
// The decision is the `Decision` of the protocol. `TypedDecision<C>` is that decision with a narrower type for the choice: the value is the same, and the caller reads `choice` as the type of
// its parser and does not parse it again.
//
// A failure has two codes. `code` is the error code of the protocol: it is the code of an error answer of a counterparty, and `ERROR_STATUS[code]` is its status. `reason` is what a buyer-side agent
// writes as the `reason` of a result that has the outcome `failed`.
//
//   code                  reason                         when
//   inference_failed      the code of hire-kit           the hire of the model failed, or its receipt did not pass the checks: `llm_supplier_unavailable` (no model on the allowlist at or
//                                                        under the three limits), `llm_post_failed`, `llm_busy`, `llm_refused`, `llm_send_lost`, `llm_failed`, `llm_timeout`, `llm_bad_result`,
//                                                        `llm_receipt_failed`, `llm_receipt_unavailable`, `llm_accept_failed`, `llm_out_of_time`, or `hire_threw` (a port threw)
//   store_write_failed    store_write_failed             the stranded store of the key could not be written for the escrow of the hire
//   model_output_invalid  model_output_invalid           the hire completed, and the answer is not an object of the shape that the decision asks for
//   internal              bad_limit                      a limit is missing or has a wrong type: nothing was hired
//   internal              bad_decision                   the definition of the decision is wrong: nothing was hired
//   internal              bad_input                      the input is not JSON data: nothing was hired
//   internal              choice_changed                 the parser of the decision returned a value that is not the choice that the model gave
//
// `delivery` is set when the model was hired and paid, and its answer could not be used (`model_output_invalid` and `choice_changed`). The sub-job is real: the escrow was accepted, so the agent
// carries the sub-job in its failed result. The other failures have no delivery. `escrow_ref` and `stage` say where a failed hire ended. An escrow that a failed hire left is with the janitor of the key.
import type { HireStage } from '@vsa/hire-kit';
import type { Accepted, Decision, ErrorCode, JsonValue, OutputRef, Refused, SubJob } from '../protocol/index.ts';

/** The error codes that a failed decision has. Each is a code of the protocol, so `ERROR_STATUS` gives its status. */
export const DECISION_FAILURE_CODES = ['inference_failed', 'store_write_failed', 'model_output_invalid', 'internal'] as const satisfies readonly ErrorCode[];
export type DecisionFailureCode = (typeof DECISION_FAILURE_CODES)[number];

/** The sub-job of a hire that was paid, and whether its Accept was seen on the chain. */
export interface PaidDelivery {
  readonly sub_job: SubJob;
  readonly accepted: 'confirmed' | 'pending';
}

export interface DecisionFailure extends Refused<DecisionFailureCode> {
  /** What a result with the outcome `failed` gives as its `reason`. See the table at the head of this file. */
  readonly reason: string;
  /** The hire that was paid and whose answer could not be used. Null for every other failure. */
  readonly delivery: PaidDelivery | null;
  /** The escrow of the hire, when one was posted. It is a public reference. */
  readonly escrow_ref: OutputRef | null;
  /** Where the hire was when it ended. Null when the failure is not a failure of the hire. */
  readonly stage: HireStage | null;
}

/** A decision of the protocol whose choice has the type of the parser of the decision. */
export interface TypedDecision<C extends JsonValue> extends Decision {
  readonly choice: C;
}

export type DecideResult<C extends JsonValue> = Accepted<TypedDecision<C>> | DecisionFailure;
