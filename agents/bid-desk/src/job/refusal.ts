// agents/bid-desk/src/job/refusal.ts
// The refusal of the job of the Bid Desk: the codes that a job can end with, the status of each, the fixed texts, and what a failed decision turns into. A job that fails ends with a `QuoteRefusal` and
// writes nothing after it.
//
// The status of each code is the status of that code in ERROR_STATUS of the protocol, so the table of the job and the table of the protocol are one. For a status of 500 or more the service kit tells the buyer
// the code only and writes the message to its log. For `duplicate_rfq` and `deadline` the buyer reads the message, so it is fixed text: no value of a request, a record or a price list stands in any text.
import type { Refusal } from '@vsa/service-kit';
import { DECISION_FAILURE_CODES } from '@vsa/usecase-kit/decision';
import type { DecisionFailure, DecisionFailureCode } from '@vsa/usecase-kit/decision';
import { ERROR_STATUS } from '@vsa/usecase-kit/protocol';

/** The status of each code of a refusal of the job: the status of that code in ERROR_STATUS of the protocol. A failed decision has one of the codes `inference_failed`, `store_write_failed`, `model_output_invalid` and `internal`. */
export const QUOTE_REFUSAL_STATUS = Object.freeze({
  precheck_missing: ERROR_STATUS.precheck_missing,
  duplicate_rfq: ERROR_STATUS.duplicate_rfq,
  credential_failed: ERROR_STATUS.credential_failed,
  inference_failed: ERROR_STATUS.inference_failed,
  model_output_invalid: ERROR_STATUS.model_output_invalid,
  store_write_failed: ERROR_STATUS.store_write_failed,
  internal: ERROR_STATUS.internal,
  deadline: ERROR_STATUS.deadline,
} as const);

export type QuoteRefusalCode = keyof typeof QUOTE_REFUSAL_STATUS;

/**
 * A job that ends with a refusal or a failure. It has the form of the `Refusal` of the service kit: a code, a status, a message and the kind `job`. The status is the status of the code, and a caller cannot
 * choose another one.
 */
export class QuoteRefusal extends Error implements Refusal {
  readonly code: QuoteRefusalCode;
  readonly status: number;
  readonly kind = 'job' as const;

  constructor(code: QuoteRefusalCode, message: string) {
    super(message);
    this.name = 'QuoteRefusal';
    this.code = code;
    this.status = QUOTE_REFUSAL_STATUS[code];
  }
}

/** The texts of the refusals. Each is fixed: no value of a request, a record, a price list or a credential stands in it. */
export const QUOTE_TEXT = {
  precheck_missing: 'The job has no record of passed checks for this request.',
  duplicate_rfq: 'This agent already gave a quote for this request for quotation from this sender.',
  credential_failed: 'The Bid Desk could not get its credential from the identity gateway.',
  rfq_book: 'The rfq book could not record the quote.',
  deadline: 'The caller hung up, and the job stopped before it went on.',
  no_time: 'The job has too little time left to give the quote.',
  internal: 'The job stopped on a fault of the service.',
} as const;

/** The text of each failed decision: one for each code that `decide` of the kit gives. The job also uses the text of `model_output_invalid` for a choice that it cannot use. */
export const DECISION_TEXT = {
  inference_failed: 'The model hire for the decision quote failed.',
  model_output_invalid: 'The answer of the model for the decision quote cannot be used.',
  store_write_failed: 'The record of the model hire could not be written.',
  internal: 'The decision quote stopped on a fault of the service.',
} as const satisfies Record<DecisionFailureCode, string>;

/** The code of a failed decision: one of the four codes of the kit, and `internal` for anything else, so that a result that cannot be read never has a code that the protocol does not list. */
export function decisionCodeOf(failure: DecisionFailure): DecisionFailureCode {
  return (DECISION_FAILURE_CODES as readonly unknown[]).includes(failure?.code) ? failure.code : 'internal';
}

/** What a failed decision says in the log: the reason of the hire, its stage and its escrow, and whether the supplier of the model was paid. Never the detail, the prompt or the answer. */
export function describeDecision(failure: DecisionFailure): string {
  const paid = failure?.delivery?.accepted;
  const parts = [
    `the decision quote failed: reason ${String(failure?.reason)}, stage ${String(failure?.stage)}`,
    typeof failure?.escrow_ref === 'string' ? `escrow ${failure.escrow_ref}` : '',
    paid === undefined ? '' : `the model supplier may be paid (accepted ${String(paid)})`,
  ];
  return parts.filter((part) => part !== '').join(', ');
}
