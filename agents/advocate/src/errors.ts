// agents/advocate/src/errors.ts
// The failures of a job once its request has been read: the search, the pages, the model, the check of the quotes, the hire of the chat supplier, and the time
// (rulings R-E3 to R-E8 and R-F10). Each is an AdvocateError with a stable code, the HTTP status the service answers with, and two texts: the message, the
// kit's fixed text for the code (operatorsText), and the detail, which says what happened and never holds a request, a page, a quote, a key or the words of a
// supplier. The server hands the kit the detail (src/server.ts), and the answer is what the page says: at 502 and 500 the buyer reads the fixed text and the
// log the detail, for the runtime copies the first 200 characters of a failure to the buyer, and what a third party said (a status, the first characters of
// an answer) or which escrow is in play is the operator's to read; at 422 (deadline) and 499 (aborted, which nobody receives) the answer carries the detail,
// which holds nothing of the request, and the log the code and the status. A refusal of the request itself is a RequestError (src/request.ts), which is not
// wrapped. A failure of the hire is a HopFailed (src/inference.ts), an AdvocateError with the code of the hire beside it.
//
// The codes and their status:
//   422  deadline (the job ran out of its time, or had too little of it left to start the model)
//   499  aborted (the caller hung up and the job was stopped: never answered, for the connection is gone, and logged)
//   500  store_write_failed (the stranded store could not be written after the escrow of the chat sub-job was posted; the detail names the escrow)
//   502  search_failed, search_empty, no_sources, model_failed, model_output_invalid, no_supported_claims (a third party failed, or gave nothing a brief can
//        stand on), inference_failed (the hire of the chat supplier failed where the job does not fall back to OpenRouter: an Accept that could not be made)
import { operatorsText } from '@vsa/service-kit';

export type JobCode =
  | 'search_failed' | 'search_empty' | 'no_sources' | 'model_failed' | 'model_output_invalid' | 'no_supported_claims' | 'inference_failed' | 'store_write_failed'
  | 'deadline' | 'aborted';

/** The HTTP status of each code: deadline 422, aborted 499, store_write_failed 500, every other 502. */
export const JOB_STATUS: Record<JobCode, 422 | 499 | 500 | 502> = {
  search_failed: 502, search_empty: 502, no_sources: 502, model_failed: 502, model_output_invalid: 502, no_supported_claims: 502, inference_failed: 502,
  store_write_failed: 500, deadline: 422, aborted: 499,
};

/**
 * A failure of the job on this side or at a third party. Its message is the kit's fixed text for the code (operatorsText); the buyer reads it at 502 and 500,
 * with the detail in the log, and reads the detail at 422 and 499.
 */
export class AdvocateError extends Error {
  readonly code: JobCode;
  readonly status: 422 | 499 | 500 | 502;
  readonly detail: string;
  constructor(code: JobCode, detail: string) {
    super(operatorsText(code));
    this.name = 'AdvocateError';
    this.code = code;
    this.status = JOB_STATUS[code];
    this.detail = detail;
  }
}
