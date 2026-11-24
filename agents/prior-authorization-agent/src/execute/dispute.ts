// agents/prior-authorization-agent/src/execute/dispute.ts
// The call of the challenge of a delivery that the model did not accept (use case 2, prior authorization). This file builds the call and gives the kit result as it is. It takes plain inputs and a port, and it
// never sees a job: the job decides when to challenge, and it maps the result.
//
// The challenge is against the standing claim of the Insurer Intake Agent. The evidence is an intake record that does not name the hash of the request that was sent, and the evidence kind `intake_record` is about
// the second statement of that claim ("An intake record names the hash of the request this agent received"). The call carries the text of that statement from the claim constants of the kit, so the challenge names
// the text that the claim of the Insurer Intake Agent holds. The kit chooses the claim by the capability, the statement and the buyer keys, and it computes the hash of the request itself from the request that the
// evidence holds.
import type { Dispute, ChallengeResult } from '@vsa/usecase-kit/dispute';
import { INTAKE_CLAIM, PRIORAUTH_CAPABILITIES } from '@vsa/usecase-kit/priorauth';
import type { Did, Digest, Document, JsonObject } from '@vsa/usecase-kit/protocol';

/** The facts of one challenge. */
export interface DeliveryDispute {
  /** The Insurer Intake Agent that made the delivery. */
  readonly counterparty: Did;
  /** The escrow of the hire. */
  readonly escrow_ref: string;
  /** The request that this agent sent: the document of its handoff. */
  readonly request: Document;
  /** The intake record that the Insurer Intake Agent returned. */
  readonly intake_record: JsonObject;
  /** The hash that the signed receipt commits to for the text of the intake record. */
  readonly intake_record_sha256: Digest;
}

/**
 * Files the challenge. One call of `challengeDelivery`, with the capability of the Insurer Intake Agent, the text of the statement S2 of its claim, the buyer keys and the evidence of the intake record. The result
 * is the result of the dispute folder as it is, and an error of the dispute folder is not caught here.
 */
export async function disputeDelivery(deps: { readonly dispute: Pick<Dispute, 'challengeDelivery'> }, input: DeliveryDispute, buyerPkhs: readonly string[]): Promise<ChallengeResult> {
  return deps.dispute.challengeDelivery({
    counterparty: input.counterparty,
    escrow_ref: input.escrow_ref,
    capability_id: PRIORAUTH_CAPABILITIES.intake,
    statement_text: INTAKE_CLAIM.statements[1].text,
    buyer_pkhs: buyerPkhs,
    evidence: { kind: 'intake_record', request: input.request, intake_record: input.intake_record, intake_record_sha256: input.intake_record_sha256 },
  });
}
