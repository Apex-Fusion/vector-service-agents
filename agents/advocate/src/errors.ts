// agents/advocate/src/errors.ts
// The failures of a job once its request has been read: the search, the pages, the model, the check of the quotes, and the time (rulings R-E3 to R-E8). Each
// is an AdvocateError with a stable code, the HTTP status the service answers with, and two texts. The message, which the buyer reads, is fixed: the kit's
// operatorsText of the code, for the runtime copies the first 200 characters of a failure to the buyer, and what a third party said (a status, the first
// characters of an answer) is the operator's to read. The detail, which the log reads, says what happened, and never holds a request, a page, a quote or a
// key. A refusal of the request itself is a RequestError (src/request.ts), which is not wrapped.
//
// The codes and their status:
//   422  deadline (the job ran out of its time, or had too little of it left to start the model)
//   499  aborted (the caller hung up and the job was stopped: never answered, for the connection is gone, and logged)
//   502  search_failed, search_empty, no_sources, model_failed, model_output_invalid, no_supported_claims (a third party failed, or gave nothing a brief can
//        stand on)
import { operatorsText } from '@vsa/service-kit';

export type JobCode = 'search_failed' | 'search_empty' | 'no_sources' | 'model_failed' | 'model_output_invalid' | 'no_supported_claims' | 'deadline' | 'aborted';

/** The HTTP status of each code: deadline 422, aborted 499, every other 502. */
export const JOB_STATUS: Record<JobCode, 422 | 499 | 502> = {
  search_failed: 502, search_empty: 502, no_sources: 502, model_failed: 502, model_output_invalid: 502, no_supported_claims: 502, deadline: 422, aborted: 499,
};

/** A failure of the job on this side or at a third party: the buyer gets fixed text (operatorsText(code) from the kit), the log gets `detail`. */
export class AdvocateError extends Error {
  readonly code: JobCode;
  readonly status: 422 | 499 | 502;
  readonly detail: string;
  constructor(code: JobCode, detail: string) {
    super(operatorsText(code));
    this.name = 'AdvocateError';
    this.code = code;
    this.status = JOB_STATUS[code];
    this.detail = detail;
  }
}
