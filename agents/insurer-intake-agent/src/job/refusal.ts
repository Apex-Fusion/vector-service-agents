// agents/insurer-intake-agent/src/job/refusal.ts
// The refusal of the job of the Insurer Intake Agent. A job that ends with a refusal or a failure throws an `IntakeRefusal`: it has the form of the `Refusal` of the service kit (a code, a status, a message and
// the kind `job`), so the service takes it as it is. The status is the status of the code in ERROR_STATUS of the protocol, and a caller cannot choose another one. For a status of 500 or more the service kit
// tells the buyer the code only and writes the message to its log, and the log of the job has the cause. For `duplicate_request` and `deadline` the buyer reads the message, so it is fixed text.
//
// The codes of the whole job, and the step that gives each one:
//   precheck_missing      the hook did not check this body: no record of passed checks for the escrow, a record of another body, or a record that cannot be read (500)
//   svid_failed           the identity gateway gave no JWT-SVID (502)
//   mock_system_failed    the insurer portal did not take a call: a refusal, a failure, an answer that cannot be read, a requirement set for another service code (502). A code of the portal is never a code of this job.
//   inference_failed      the hire of the model for the decision `completeness` failed (502)
//   model_output_invalid  the answer of the model cannot be used (502)
//   duplicate_request     the insurer portal already holds an entry for the request number (403)
//   store_write_failed    a store could not be written: the intake book, or the record of the model hire (500)
//   internal              a fault of the service (500)
//   deadline              the caller hung up, or the job has too little time left to file (422)
import type { Refusal } from '@vsa/service-kit';
import { ERROR_STATUS } from '@vsa/usecase-kit/protocol';

/** The status of each code of a refusal of the job: the status of that code in ERROR_STATUS of the protocol, so that the table of the job and the table of the protocol are one. */
export const INTAKE_REFUSAL_STATUS = Object.freeze({
  precheck_missing: ERROR_STATUS.precheck_missing,
  svid_failed: ERROR_STATUS.svid_failed,
  mock_system_failed: ERROR_STATUS.mock_system_failed,
  inference_failed: ERROR_STATUS.inference_failed,
  model_output_invalid: ERROR_STATUS.model_output_invalid,
  duplicate_request: ERROR_STATUS.duplicate_request,
  store_write_failed: ERROR_STATUS.store_write_failed,
  internal: ERROR_STATUS.internal,
  deadline: ERROR_STATUS.deadline,
} as const);

export type IntakeRefusalCode = keyof typeof INTAKE_REFUSAL_STATUS;

/** A job that ends with a refusal or a failure. The message is fixed text: no value of a request, a record or a portal stands in it. */
export class IntakeRefusal extends Error implements Refusal {
  readonly code: IntakeRefusalCode;
  readonly status: number;
  readonly kind = 'job' as const;

  constructor(code: IntakeRefusalCode, message: string) {
    super(message);
    this.name = 'IntakeRefusal';
    this.code = code;
    this.status = INTAKE_REFUSAL_STATUS[code];
  }
}

/** The fixed texts of the codes that the first steps of the job give, and that the later steps give too. Each is fixed: no value of a request, a record or a portal stands in it. */
export const INTAKE_REFUSAL_TEXT = Object.freeze({
  precheck_missing: 'The job has no record of passed checks for this request.',
  svid_failed: 'The Insurer Intake Agent could not get a JWT-SVID from the identity gateway.',
  mock_system_failed: 'The insurer portal did not take the call.',
  internal: 'The job stopped on a fault of the service.',
} as const);

/**
 * The refusal for a failure of a step, after one line in the log with the reason. The line is `insurer intake: <code>: <why>`. The reason has codes, references and the names of members, and never a key, a
 * token, a body of the portal or a part of a request. A log that throws changes nothing: the refusal is made all the same. The caller throws the refusal.
 */
export function refuse(log: (line: string) => void, code: IntakeRefusalCode, message: string, why: string): IntakeRefusal {
  try {
    log(`insurer intake: ${code}: ${why}`);
  } catch {
    // A log that fails changes nothing.
  }
  return new IntakeRefusal(code, message);
}
