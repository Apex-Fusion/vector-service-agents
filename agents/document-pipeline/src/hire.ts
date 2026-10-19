// agents/document-pipeline/src/hire.ts
// One hire of a fleet supplier, the part every sub-job shares, an OCR page or the chat job: post the escrow and record it as stranded, hand the job to
// the supplier, poll it, read and check what it returns, accept, and only then forget the escrow. Every way it can end before the Accept is a
// PipelineError <hop>_<what>, and the escrow is left in the stranded store for the janitor (src/janitor.ts), which reclaims it after its deliver_by
// when it is Open or Claimed and keeps it when it is Submitted. The supplier's own endpoint, key and model were established before the Post
// (src/orchestrate.ts); nothing a supplier says here moves value but its signed receipt, checked against the hash its Submit put on chain. A write of
// the stranded store that fails after an escrow was posted is store_write_failed (500), naming the escrow, never a plain error; the one exception is the removal
// of an entry after its Accept is confirmed, which is logged and does not fail a job that is settled and verified (ruling R62).
//
// The Post. Confirmed: it is recorded in the stranded store before anything else. Failed after its signature: recorded too, with the end of its
// validity, whether it may still land or the submit API refused it (ruling R59), and <hop>_post_failed. Failed before its signature: nothing was locked.
//
// The send (75 s at most each). Accepted: there is a job id to poll. Busy (409 supplier_busy): sent again every 15 s, on the same escrow, until 90 s
// before its deliver_by (<hop>_busy). Not found (404 escrow_not_found, ruling R32): the supplier looks the Post output up before anything else, and
// does not find it either because it does not see the Post yet or because its own Claim, after an earlier send whose answer was lost, has spent it.
// So the escrow is read: Open, and the job is sent again like a busy one (<hop>_refused for a supplier that never sees it); anything else means the
// supplier may hold the job with no job id to ask it for (<hop>_send_lost). Only a 404 is a not-found: the same reason on a 5xx is handled as any 5xx.
// Any other 4xx in the supplier's own envelope is the supplier turning the job down (<hop>_refused); a 4xx whose body is no JSON object (bad_response)
// is a page of something in front of the supplier and is handled like no answer (ruling R57). No answer, a 5xx, a 4xx page, or a 202 without a job id
// may come after the supplier's Claim, so the escrow is read before anything else: Open allows one more send (a second unknown outcome is
// <hop>_send_lost, a second 5xx or page <hop>_refused); anything else means the supplier may hold the escrow with no job id to ask it for
// (<hop>_send_lost). A state that cannot be read is no verdict: it is read again every 15 s, until 90 s before the deliver_by, and only a state still
// unreadable then is <hop>_send_lost (ruling R58). A send is never repeated blindly, and every message that gives the escrow up says the state it was
// read in.
//
// The poll, every 3 s until deliver_by (<hop>_timeout). A poll that gets no answer of the supplier's own rejects and is made again (ruling R21); a 404
// is gone only in the supplier's own envelope, with the reason job_not_found (ruling R57, packages/buyer-core/src/fleet-clients.ts). A failed or gone answer
// is final only when the escrow is not Submitted: a gateway can answer a JSON error with a reason, and a supplier can fail its job after its Submit
// landed (ruling R23). So the escrow is read: Submitted, or a state that cannot be read, and the polls go on; anything else is <hop>_failed. One case is
// final at once (ruling R34): a supplier that failed its own Submit step (submit_timeout, submit_failed) while the escrow reads Submitted has put the
// receipt on chain and will not hand it over, which no poll changes (<hop>_receipt_unavailable).
//
// The answer. The hop's `read` checks the shape of the finished body and recomputes the response hash; a body it cannot use, and a hash that throws
// on it (a body nested past the stack), is <hop>_bad_result (ruling R25). The receipt is checked twice: first without the chain, where a failed check
// is final (<hop>_receipt_failed) and the chain is not asked; then with the hash on chain, read again every 3 s for up to 120 s while it is not
// listed or cannot be read (ruling R16; the supplier answers only after its Submit, but the indexer can lag). Only VERIFIED is accepted.
//
// The Accept. Confirmed: its fee is booked and the escrow leaves the store. Sent but not seen confirmed, so that it may still land (ruling R33): the job
// stands, verified, its fee is not booked, and the escrow stays in the store marked accept_pending, for the janitor to confirm. Failed in a way that
// cannot land (a build that did not complete, a submit the API refused): made again every 15 s, until the planner says the accept window has closed or
// 600 s have passed since the supplier's answer, and only then <hop>_accept_failed (ruling R54).
//
// The deadline of the run (`deadline`) cuts the waits of this file that are its own: the repeats of a send, the polls, the repeats of a read of the receipt
// hash, the reads of an escrow state that could not be read, and the pauses between them. It does not cut the confirmation of a Post or of an Accept,
// which the chain waits for (up to 180 s each; no deadline is passed to it), nor the repeats of an Accept (ruling R54): a hire in its Accept at the
// deadline runs on. Nor does it cut a call already under way: a send in flight (up to 75 s), a poll in flight (up to 20 s) and a read of the chain
// each end when they end, after the deadline if it came meanwhile. See the head of src/budget.ts.
//
// The hire itself is packages/hire-kit's (hireOne, in its src/hire.ts), moved there from this file with the words above, which still say what a hire of the
// Pipeline does. What stays here is the Pipeline's seam: the factory that makes every failure of a hire a PipelineError with its code and status, and
// hire, which gives the kit's record back as the sub-job of the result and sets neither option of the kit (firstSendBy, receiptBy).
import { hireOne } from '@vsa/hire-kit';
import type { HireDeps, HireErrors, HireJob, HireSupplier } from '@vsa/hire-kit';
import { deadlineError } from './budget.ts';
import { PipelineError } from './result.ts';
import type { Accounting, SubJob } from './result.ts';

export type { HireDeps } from '@vsa/hire-kit';
/** The supplier of a hire, as established before its Post: the advert on chain, the endpoint it names, the key /capability serves. */
export type Supplier = HireSupplier;
/** One job for that supplier. */
export type Job<T> = HireJob<T>;

/** Every failure of a hire as the Pipeline answers it: <hop>_<what> (422), deadline (422, src/budget.ts), store_write_failed (500). The kit writes the messages. */
const PIPELINE_ERRORS: HireErrors<PipelineError> = {
  failure: (kind, what, message) => new PipelineError(`${kind}_${what}`, message),
  deadline: (doing) => deadlineError(doing),
  storeWrite: (message) => new PipelineError('store_write_failed', message, 500),
};

/** Hires `supplier` for `job`: the sub-job of the result and what `read` kept of the answer, once the escrow is accepted. Records what it moved in `accounting`. */
export async function hire<T>(deps: HireDeps, supplier: Supplier, job: Job<T>, accounting: Accounting): Promise<{ subJob: SubJob; value: T }> {
  const { record, value } = await hireOne(deps, supplier, job, accounting, PIPELINE_ERRORS);
  return { subJob: record, value };
}
