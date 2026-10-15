// agents/document-pipeline/src/hire.ts
// One hire of a fleet supplier, the part every sub-job shares, an OCR page or the chat job: post the escrow and record it as stranded, hand the job to
// the supplier, poll it, read and check what it returns, accept, and only then forget the escrow. Every way it can end before the Accept is a
// PipelineError <hop>_<what>, and the escrow is left in the stranded store for the janitor (src/janitor.ts), which reclaims it after its deliver_by
// when it is Open or Claimed and keeps it when it is Submitted. The supplier's own endpoint, key and model were established before the Post
// (src/orchestrate.ts); nothing a supplier says here moves money but its signed receipt, checked against the hash its Submit put on chain.
//
// The send (75 s at most each). Accepted: there is a job id to poll. Busy (409 supplier_busy, the escrow still Open): sent again every 15 s, on the
// same escrow, until 90 s before its deliver_by (<hop>_busy). A 4xx refusal is the supplier turning the job down before it claimed (<hop>_refused).
// No answer, a 5xx, or a 202 without a job id may come after the supplier's Claim, so the escrow is read before anything else: Open allows one more
// send (a second unknown outcome is <hop>_send_lost, a second 5xx <hop>_refused); anything else, or a state that cannot be read, means the supplier may
// hold the escrow with no job id to ask it for (<hop>_send_lost). A send is never repeated blindly.
//
// The poll, every 3 s until deliver_by (<hop>_timeout). A poll that gets no answer of the supplier's own rejects and is made again (ruling R21). A
// failed or gone answer is final only when the escrow is not Submitted: a gateway can answer a JSON error with a reason, and a supplier can fail its
// job after its Submit landed (ruling R23). So the escrow is read: Submitted, or a state that cannot be read, and the polls go on; anything else is
// <hop>_failed.
//
// The answer. The hop's `read` checks the shape of the finished body and recomputes the response hash; a body it cannot use, and a hash that throws
// on it (a body nested past the stack), is <hop>_bad_result (ruling R25). The receipt is checked twice: first without the chain, where a failed check
// is final (<hop>_receipt_failed) and the chain is not asked; then with the hash on chain, read again every 3 s for up to 120 s while it is not
// listed or cannot be read (ruling R16; the supplier answers only after its Submit, but the indexer can lag). Only VERIFIED is accepted.
// Throughout, nothing waits past the deadline of the run (`deadline`).
import { DELIVER_BY_BUFFER_MS, TxNotConfirmedError, verifyFleetReceipt } from '@vsa/buyer-core';
import type { Chain, ChainEscrowState, FleetVerification, FleetVerifyInput, PollResult, PostResult, SendResult } from '@vsa/buyer-core';
import { BUSY_RETRY_MS, POLL_INTERVAL_MS, RECEIPT_HASH_WAIT_MS, SEND_CUTOFF_MS, checkWithin, waitWithin } from './budget.ts';
import type { Clocked } from './budget.ts';
import type { StrandedStore } from './janitor.ts';
import { PipelineError, errorText, verificationOf } from './result.ts';
import type { Accounting, Hop, HopFailure, SubJob } from './result.ts';

/** The supplier of a hire, as established before its Post: the advert on chain, the endpoint it names, the key /capability serves. */
export interface Supplier {
  hop: Hop;
  /** Canonical. */
  advertRef: string;
  capabilityId: string;
  /** The advert's model: the receipt must name it. */
  model: string;
  endpoint: string;
  pubKeyHex: string;
  /** The advert's max_processing_ms: deliver_by is posted_at + this + 180 s. */
  windowMs: number;
}

/** One job for that supplier. */
export interface Job<T> {
  /** What the job is, in messages: "page 2", "the summary". */
  label: string;
  /** The prompt hash of exactly the request `send` sends. */
  promptHash: string;
  send: (escrowRef: string) => Promise<SendResult>;
  poll: (jobId: string, escrowRef: string) => Promise<PollResult>;
  /** The response hash recomputed from the finished body, and what the run keeps of it. Throws for a body it cannot use. */
  read: (body: Record<string, unknown>) => { responseHash: string; value: T };
}

export interface HireDeps extends Clocked { chain: Chain; stranded: StrandedStore }

type Done = Extract<PollResult, { kind: 'done' }>;
const iso = (ms: number): string => new Date(ms).toISOString();
const failure = (s: Supplier, what: HopFailure, message: string): PipelineError => new PipelineError(`${s.hop}_${what}`, message);
const named = (s: Supplier): string => (s.hop === 'ocr' ? 'The OCR supplier' : 'The chat supplier');
/** The state of the escrow, or null when it cannot be read. */
async function stateOf(chain: Chain, escrowRef: string): Promise<ChainEscrowState | null> {
  try { return await chain.escrowState(escrowRef); } catch { return null; }
}
const said = (state: ChainEscrowState | null): string => (state === null ? 'in a state that could not be read' : state);

/** Hires `supplier` for `job`: the sub-job of the result and what `read` kept of the answer, once the escrow is accepted. Records what it moved in `accounting`. */
export async function hire<T>(deps: HireDeps, supplier: Supplier, job: Job<T>, accounting: Accounting): Promise<{ subJob: SubJob; value: T }> {
  const post = await postEscrow(deps, supplier, job, accounting);
  const jobId = await handOver(deps, supplier, job, post);
  const done = await finished(deps, supplier, job, post, jobId);
  let read: { responseHash: string; value: T };
  try { read = job.read(done.body); } catch (err) {
    throw failure(supplier, 'bad_result', `${named(supplier)}'s answer for ${job.label} cannot be used (${errorText(err)}); its escrow ${post.escrowRef} is not accepted and stays with the janitor.`);
  }
  const verification = await verified(deps, supplier, job, post, done, read.responseHash);
  let accepted: { txHash: string; feeLovelace: bigint };
  try { accepted = await deps.chain.accept(post.escrowRef); } catch (err) {
    throw failure(supplier, 'accept_failed', `The Accept of ${job.label} failed (${errorText(err)}); its escrow ${post.escrowRef} stays recorded for the janitor.`);
  }
  accounting.accepted(accepted);
  deps.stranded.remove(post.escrowRef);
  return {
    subJob: {
      capability_id: supplier.capabilityId, advert_ref: supplier.advertRef, escrow_ref: post.escrowRef, supplier_pkh: post.supplierPkh,
      receipt: done.receipt, receipt_signature: done.receiptSignature, verification: verificationOf(verification.checks),
    },
    value: read.value,
  };
}

/** The Post, recorded as stranded once it is confirmed; one that failed after its signature and may still land is recorded with its validity. */
async function postEscrow<T>(deps: HireDeps, supplier: Supplier, job: Job<T>, accounting: Accounting): Promise<PostResult> {
  let post: PostResult;
  try {
    post = await deps.chain.postEscrow({ advertRef: supplier.advertRef, promptHash: job.promptHash });
  } catch (err) {
    if (err instanceof TxNotConfirmedError && err.mayLand && err.deliverBy !== null) {
      deps.stranded.add({
        escrow_ref: err.escrowRef, deliver_by: err.deliverBy, posted_at: err.deliverBy - supplier.windowMs - DELIVER_BY_BUFFER_MS, kind: supplier.hop, valid_to: err.validTo,
      });
      throw failure(supplier, 'post_failed', `The Post for ${job.label} was not confirmed (${errorText(err)}). It may still land until ${iso(err.validTo)}: its escrow ${err.escrowRef} is recorded for the janitor, which reclaims it after its deliver_by if it did.`);
    }
    throw failure(supplier, 'post_failed', `The Post for ${job.label} failed (${errorText(err)}). Nothing was locked for it.`);
  }
  accounting.posted(post);
  deps.stranded.add({ escrow_ref: post.escrowRef, deliver_by: post.deliverBy, posted_at: post.postedAt, kind: supplier.hop });
  return post;
}

/** Sends the job until the supplier accepts it, and gives back the job id. */
async function handOver<T>(deps: HireDeps, supplier: Supplier, job: Job<T>, post: PostResult): Promise<string> {
  const sendUntil = post.deliverBy - SEND_CUTOFF_MS;
  const escrow = `its escrow ${post.escrowRef}`;
  let sends = 0;
  let unknownOutcomes = 0;
  for (;;) {
    const sent = await job.send(post.escrowRef);
    sends += 1;
    if (sent.kind === 'accepted') return sent.jobId;
    if (sent.kind === 'busy') {
      await waitWithin(deps, BUSY_RETRY_MS, sendUntil, () => failure(supplier, 'busy',
        `${named(supplier)} stayed busy: ${job.label} was sent ${sends} times, ${BUSY_RETRY_MS / 1000} s apart, until ${SEND_CUTOFF_MS / 1000} s before the deliver_by of ${escrow}, which is Open and goes to the janitor.`,
      ), `${job.label} waited for a busy supplier`);
      continue;
    }
    const refusal = sent.kind === 'refused' ? `${sent.status} ${sent.reason}${sent.message === '' ? '' : `: ${sent.message}`}` : '';
    if (sent.kind === 'refused' && sent.status >= 400 && sent.status < 500) {
      throw failure(supplier, 'refused', `${named(supplier)} refused ${job.label} before it claimed the escrow (${refusal}); ${escrow} is Open and goes to the janitor.`);
    }
    // No answer, a 5xx, or a 202 without a job id: the supplier may have claimed the escrow. Its state says whether the job can be sent again.
    const state = await stateOf(deps.chain, post.escrowRef);
    if (state === 'Open' && unknownOutcomes === 0) {
      unknownOutcomes += 1;
      checkWithin(deps, deps.clock(), sendUntil, () => failure(supplier, 'send_lost', `The send of ${job.label} got no answer and there is no time to send it again; ${escrow} is Open and goes to the janitor.`), `${job.label} was being sent`);
      continue;
    }
    if (state === 'Open' && sent.kind === 'refused') {
      throw failure(supplier, 'refused', `${named(supplier)} refused ${job.label} twice (${refusal}); ${escrow} is Open and goes to the janitor.`);
    }
    throw failure(supplier, 'send_lost', state === 'Open'
      ? `The send of ${job.label} got no answer twice; ${escrow} is Open and goes to the janitor.`
      : `The send of ${job.label} got ${refusal === '' ? 'no answer' : `the answer ${refusal}`}, and ${escrow} is ${said(state)}: the supplier may hold the job, but there is no job id to ask it for the result. The escrow goes to the janitor.`);
  }
}

/** Polls the job every 3 s until the supplier hands over its result, and gives back the finished answer. */
async function finished<T>(deps: HireDeps, supplier: Supplier, job: Job<T>, post: PostResult, jobId: string): Promise<Done> {
  const escrow = `its escrow ${post.escrowRef}`;
  for (;;) {
    await waitWithin(deps, POLL_INTERVAL_MS, post.deliverBy, () => failure(supplier, 'timeout',
      `${named(supplier)} had not finished ${job.label} by the deliver_by of ${escrow} (${iso(post.deliverBy)}); the escrow goes to the janitor.`,
    ), `${job.label} was being polled`);
    let polled: PollResult;
    // A poll that rejects got no answer of the supplier's own: not a verdict, and the job may well be running (ruling R21).
    try { polled = await job.poll(jobId, post.escrowRef); } catch { continue; }
    if (polled.kind === 'done') return polled;
    if (polled.kind === 'running') continue;
    // The supplier's word that the job failed, or is gone, is final only when its escrow is not Submitted (ruling R23).
    const state = await stateOf(deps.chain, post.escrowRef);
    if (state === null || state === 'Submitted') continue;
    const why = polled.kind === 'gone' ? 'it no longer knows the job (404)' : `${polled.reason}${polled.message === '' ? '' : `: ${polled.message}`}`;
    throw failure(supplier, 'failed', `${named(supplier)} failed ${job.label} (${why}); ${escrow} is ${state} and goes to the janitor.`);
  }
}

/** The receipt's seven checks, VERIFIED, or a PipelineError: first without the chain, then against the hash on chain, waiting for it up to 120 s. */
async function verified<T>(deps: HireDeps, supplier: Supplier, job: Job<T>, post: PostResult, done: Done, responseHashHex: string): Promise<FleetVerification> {
  const escrow = `its escrow ${post.escrowRef}`;
  const input: Omit<FleetVerifyInput, 'onChainReceiptHash'> = {
    escrowRef: post.escrowRef, receipt: done.receipt, receiptSignature: done.receiptSignature, responseHashHex, promptHashHex: job.promptHash,
    supplierPubKeyHex: supplier.pubKeyHex, supplierPkhExpected: post.supplierPkh, model: supplier.model,
  };
  const failed = (v: FleetVerification): PipelineError => {
    const checks = Object.entries(v.checks).filter(([, state]) => state === 'fail').map(([check]) => check).join(', ');
    return failure(supplier, 'receipt_failed', `The receipt for ${job.label} failed ${checks}; ${escrow} is not accepted and stays with the janitor.`);
  };
  // A check of the receipt's own that fails is final whatever the chain holds, so the chain is not asked.
  const own = await verifyFleetReceipt({ ...input, onChainReceiptHash: async () => null });
  if (own.verdict === 'FAILED') throw failed(own);
  const until = deps.clock() + RECEIPT_HASH_WAIT_MS;
  for (;;) {
    let checked: FleetVerification | null = null;
    let why = 'no Submitted output with a receipt hash is listed for it yet';
    try { checked = await verifyFleetReceipt({ ...input, onChainReceiptHash: () => deps.chain.onChainReceiptHash(post.escrowRef) }); } catch (err) { why = `the read failed: ${errorText(err)}`; }
    if (checked?.verdict === 'VERIFIED') return checked;
    if (checked?.verdict === 'FAILED') throw failed(checked);
    await waitWithin(deps, POLL_INTERVAL_MS, until, () => failure(supplier, 'receipt_failed',
      `The hash of the receipt for ${job.label} could not be read on chain within ${RECEIPT_HASH_WAIT_MS / 1000} s of the supplier's answer (${why}); ${escrow} is not accepted and stays with the janitor.`,
    ), `the receipt for ${job.label} was being checked`);
  }
}
