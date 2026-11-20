// services/mock-systems/src/approval.ts
// The approval check of a ranking. The service does not make the check: the app factory takes it as a dependency, in the shape below. The check reads the attestation on the ledger and
// answers with a typed result: it passes, or it names the one of eight codes that failed. The attestation must exist, have the approval type, name the sender as its subject, come from
// the root delegator of the delegation, be valid now, and its digest must be the digest of the ranking and the salt. The service never reads success from a text, and it never takes an
// answer that is not exactly one of the two shapes: an answer of another shape, and a check that throws, refuse the call.
import { APPROVAL_CODES, pass, refuse } from './errors.ts';
import type { ApprovalCode, Outcome } from './errors.ts';
import type { Json } from './validate.ts';
import { errorText } from '@vsa/service-kit';

/** What the check needs to decide: who asked, under which delegation, which approval was named, what the approval must cover, and the time of the call. */
export interface ApprovalInput {
  /** The agent that makes the call: the subject that the approval must name. */
  readonly sender: string;
  /** The identifier of the leaf delegation of the token. The root delegator of its chain is the issuer that the approval must have. */
  readonly delegation: string;
  /** The reference of the approval: the name of its attestation and the record of its issuer. */
  readonly attestation: string;
  readonly issuerDid: string;
  /** The ranking exactly as it was sent: its digest is SHA-256 of the salt and the canonical document. */
  readonly document: Json;
  readonly salt: string;
  /** The time of the call, in POSIX milliseconds. */
  readonly atMs: number;
}

export type ApprovalAnswer =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ApprovalCode; readonly detail: string };

export type ApprovalCheck = (input: ApprovalInput) => Promise<ApprovalAnswer>;

/** Runs the check and turns its answer into a decision. Only `ok: true`, the boolean, passes. */
export async function decideApproval(check: ApprovalCheck, input: ApprovalInput): Promise<Outcome<null>> {
  let answer: unknown;
  try {
    answer = await check(input);
  } catch (error) {
    return refuse('approval_unavailable', 'approval.failed', `the approval check could not run: ${errorText(error, 200)}`);
  }
  if (typeof answer === 'object' && answer !== null && 'ok' in answer) {
    if (answer.ok === true) return pass(null);
    if (answer.ok === false && 'code' in answer && 'detail' in answer && typeof answer.detail === 'string') {
      const code = APPROVAL_CODES.find((candidate) => candidate === answer.code);
      if (code !== undefined) return refuse(code, `approval.${code}`, answer.detail.length > 300 ? `${answer.detail.slice(0, 300)}...` : answer.detail);
    }
  }
  return refuse('approval_unavailable', 'approval.bad_answer', 'the approval check gave an answer that is not a pass and is not one of its eight refusals');
}
