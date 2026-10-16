// agents/document-pipeline/src/hire.ts
// One hire of a fleet supplier, the part every sub-job shares, an OCR page or the chat job: post the escrow and record it as stranded, hand the job to
// the supplier, poll it, read and check what it returns, accept, and only then forget the escrow. Every way it can end before the Accept is a
// PipelineError <hop>_<what>, and the escrow is left in the stranded store for the janitor (src/janitor.ts), which reclaims it after its deliver_by
// when it is Open or Claimed and keeps it when it is Submitted. The supplier's own endpoint, key and model were established before the Post
// (src/orchestrate.ts); nothing a supplier says here moves money but its signed receipt, checked against the hash its Submit put on chain. A write of
// the stranded store that fails after money moved is store_write_failed (500), naming the escrow, never a plain error; the one exception is the removal
// of an entry after its Accept is confirmed, which is logged and does not fail a job that is paid and verified (ruling R62).
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
import { ACCEPT_WINDOW_MS, AcceptWindowClosedError, DELIVER_BY_BUFFER_MS, TxNotConfirmedError, verifyFleetReceipt } from '@vsa/buyer-core';
import type { Chain, ChainEscrowState, FleetVerification, FleetVerifyInput, PollResult, PostResult, SendResult } from '@vsa/buyer-core';
import type { AdvertDatum } from '@vsa/vector-read';
import { BUSY_RETRY_MS, POLL_INTERVAL_MS, RECEIPT_HASH_WAIT_MS, SEND_CUTOFF_MS, checkWithin, deadlineError, fit, waitWithin } from './budget.ts';
import type { Clocked } from './budget.ts';
import { errorText, iso } from './format.ts';
import type { StrandedStore } from './janitor.ts';
import { PipelineError, verificationOf } from './result.ts';
import type { Accounting, Hop, HopFailure, SubJob } from './result.ts';

/** The supplier of a hire, as established before its Post: the advert on chain, the endpoint it names, the key /capability serves. */
export interface Supplier {
  hop: Hop;
  /** Canonical. */
  advertRef: string;
  /** The advert's datum as read on chain before the Post (ruling R31): what the escrow is planned from and pays. */
  advert: AdvertDatum;
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

export interface HireDeps extends Clocked { chain: Chain; stranded: StrandedStore; log?: (line: string) => void }

type Done = Extract<PollResult, { kind: 'done' }>;
/** The reasons a fleet supplier fails a job with when its own Submit went wrong (agents-marketplace supplier/src/jobRunner.ts). */
const SUBMIT_FAILURES: ReadonlySet<string> = new Set(['submit_timeout', 'submit_failed']);
const failure = (s: Supplier, what: HopFailure, message: string): PipelineError => new PipelineError(`${s.hop}_${what}`, message);
const named = (s: Supplier): string => (s.hop === 'ocr' ? 'The OCR supplier' : 'The chat supplier');
/** The state of the escrow, or null when it cannot be read. */
async function stateOf(chain: Chain, escrowRef: string): Promise<ChainEscrowState | null> {
  try { return await chain.escrowState(escrowRef); } catch { return null; }
}
const said = (state: ChainEscrowState | null): string => (state === null ? 'in a state that could not be read' : state);

/** A write of the stranded store after money moved; one that fails is store_write_failed (500), whose message starts with the escrow and says what follows. */
function recorded(write: () => void, escrowRef: string, consequence: string): void {
  try { write(); } catch (err) {
    throw new PipelineError('store_write_failed', `Escrow ${escrowRef} could not be recorded in the stranded store (${errorText(err)}): ${consequence}`, 500);
  }
}

/** Hires `supplier` for `job`: the sub-job of the result and what `read` kept of the answer, once the escrow is accepted. Records what it moved in `accounting`. */
export async function hire<T>(deps: HireDeps, supplier: Supplier, job: Job<T>, accounting: Accounting): Promise<{ subJob: SubJob; value: T }> {
  const post = await postEscrow(deps, supplier, job, accounting);
  const jobId = await handOver(deps, supplier, job, post);
  const done = await finished(deps, supplier, job, post, jobId);
  // The moment the supplier handed over its result: its Submit was confirmed before it answered, so the accept window ends 600 s from then at the latest.
  const answeredAt = deps.clock();
  let read: { responseHash: string; value: T };
  try { read = job.read(done.body); } catch (err) {
    throw failure(supplier, 'bad_result', `${named(supplier)}'s answer for ${job.label} cannot be used (${errorText(err)}); its escrow ${post.escrowRef} is not accepted and stays with the janitor.`);
  }
  const verification = await verified(deps, supplier, job, post, done, read.responseHash);
  await accept(deps, supplier, job, post, accounting, answeredAt);
  return {
    subJob: {
      capability_id: supplier.capabilityId, advert_ref: supplier.advertRef, escrow_ref: post.escrowRef, supplier_pkh: post.supplierPkh,
      receipt: done.receipt, receipt_signature: done.receiptSignature, verification: verificationOf(verification.checks),
    },
    value: read.value,
  };
}

/**
 * The Post, recorded as stranded once it is confirmed. One that failed after its signature is recorded with its validity, whether it may still land or
 * the submit API refused it (ruling R59: an API can answer 4xx for a transaction it forwarded); the janitor drops an entry the chain never shows once that
 * validity has passed. A Post that failed before its signature locked nothing and is not recorded.
 */
async function postEscrow<T>(deps: HireDeps, supplier: Supplier, job: Job<T>, accounting: Accounting): Promise<PostResult> {
  let post: PostResult;
  try {
    post = await deps.chain.postEscrow({ advertRef: supplier.advertRef, promptHash: job.promptHash });
  } catch (err) {
    if (err instanceof TxNotConfirmedError && err.deliverBy !== null) {
      const { escrowRef, deliverBy, validTo, mayLand } = err;
      recorded(() => deps.stranded.add({ escrow_ref: escrowRef, deliver_by: deliverBy, posted_at: deliverBy - supplier.windowMs - DELIVER_BY_BUFFER_MS, kind: supplier.hop, valid_to: validTo }),
        escrowRef, `its Post for ${job.label} was ${mayLand ? 'not seen confirmed and may land' : 'refused by the submit API after it was signed, and could land all the same if the API had forwarded it,'} until ${iso(validTo)}, and then the janitor does not know of it. Read it after its deliver_by (${iso(deliverBy)}) and reclaim it by hand if it landed.`);
      if (!mayLand) {
        throw failure(supplier, 'post_failed', `The submit API refused the Post for ${job.label} after it was signed (${errorText(err)}). Nothing should have been locked, but its escrow ${escrowRef} is recorded for the janitor in case it landed anyway: the janitor drops the record once the Post's validity has ended (${iso(validTo)}) and the ledger shows nothing at it, and reclaims the escrow after its deliver_by if it is there.`);
      }
      throw failure(supplier, 'post_failed', `The Post for ${job.label} was not confirmed (${errorText(err)}). It may still land until ${iso(validTo)}: its escrow ${escrowRef} is recorded for the janitor, which reclaims it after its deliver_by if it did.`);
    }
    throw failure(supplier, 'post_failed', `The Post for ${job.label} failed (${errorText(err)}). Nothing was locked for it.`);
  }
  accounting.posted(post);
  recorded(() => deps.stranded.add({ escrow_ref: post.escrowRef, deliver_by: post.deliverBy, posted_at: post.postedAt, kind: supplier.hop }),
    post.escrowRef, `it locks ${post.lockLovelace} lovelace for ${job.label} and the janitor does not know of it. Reclaim it by hand after its deliver_by (${iso(post.deliverBy)}).`);
  return post;
}

/** Sends the job until the supplier accepts it, and gives back the job id. */
async function handOver<T>(deps: HireDeps, supplier: Supplier, job: Job<T>, post: PostResult): Promise<string> {
  const sendUntil = post.deliverBy - SEND_CUTOFF_MS;
  const escrow = `its escrow ${post.escrowRef}`;
  /** What becomes of the escrow, in the words of the state it is read in now. */
  const leftTo = async (): Promise<string> => `${escrow} is ${said(await stateOf(deps.chain, post.escrowRef))} and goes to the janitor`;
  /**
   * The state of the escrow after a send that did not hand the job over (ruling R58): a state that cannot be read is no verdict, so it is read again
   * every 15 s until the send cutoff. Still unreadable then, the supplier may hold the job with no job id to ask it for: <hop>_send_lost.
   */
  const stateAfter = async (answer: string): Promise<ChainEscrowState> => {
    for (;;) {
      const state = await stateOf(deps.chain, post.escrowRef);
      if (state !== null) return state;
      const next = fit(deps, deps.clock() + BUSY_RETRY_MS, sendUntil);
      if (next === 'past the deadline') throw deadlineError(`${job.label} waited to read the state of its escrow`);
      if (next === 'past the limit') {
        throw failure(supplier, 'send_lost', `The send of ${job.label} got ${answer === '' ? 'no answer' : `the answer ${answer}`}, and the state of ${escrow} could not be read until ${SEND_CUTOFF_MS / 1000} s before its deliver_by: `
          + 'the supplier may hold the job, but there is no job id to ask it for the result. The escrow goes to the janitor.');
      }
      await deps.sleep(BUSY_RETRY_MS);
    }
  };
  let sends = 0;
  let unknownOutcomes = 0;
  for (;;) {
    const sent = await job.send(post.escrowRef);
    sends += 1;
    if (sent.kind === 'accepted') return sent.jobId;
    const answer = sent.kind === 'refused' ? `${sent.status} ${sent.reason}${sent.message === '' ? '' : `: ${sent.message}`}` : '';
    const notFound = sent.kind === 'refused' && sent.status === 404 && sent.reason === 'escrow_not_found';
    if (notFound) {
      const state = await stateAfter(answer);
      if (state !== 'Open') {
        throw failure(supplier, 'send_lost', `${named(supplier)} answered ${answer}, and ${escrow} is ${state}: the supplier may hold the job from an earlier send whose answer was lost, and there is no job id to ask it for the result. The escrow goes to the janitor.`);
      }
    }
    if (sent.kind === 'busy' || notFound) {
      const next = fit(deps, deps.clock() + BUSY_RETRY_MS, sendUntil);
      if (next === 'in time') {
        await deps.sleep(BUSY_RETRY_MS);
        continue;
      }
      if (next === 'past the deadline') throw deadlineError(`${job.label} waited for its supplier`);
      const tried = `${job.label} was sent ${sends} times, ${BUSY_RETRY_MS / 1000} s apart, until ${SEND_CUTOFF_MS / 1000} s before the deliver_by of the escrow`;
      throw notFound
        ? failure(supplier, 'refused', `${named(supplier)} kept answering ${answer}, as if the escrow were not on chain: ${tried}; ${await leftTo()}.`)
        : failure(supplier, 'busy', `${named(supplier)} stayed busy: ${tried}; ${await leftTo()}.`);
    }
    // A 4xx in the supplier's own envelope is the supplier turning the job down. A 4xx whose body is no JSON object, or a JSON object without a string
    // reason (bad_response), is something in front of the supplier, and is handled like no answer (ruling R57).
    if (sent.kind === 'refused' && sent.status >= 400 && sent.status < 500 && sent.reason !== 'bad_response') {
      throw failure(supplier, 'refused', `${named(supplier)} refused ${job.label} (${answer}); ${await leftTo()}.`);
    }
    // No answer, a 5xx, a 4xx page, or a 202 without a job id: the supplier may have claimed the escrow. Its state says whether the job can be sent again.
    const state = await stateAfter(answer);
    if (state === 'Open' && unknownOutcomes === 0) {
      unknownOutcomes += 1;
      checkWithin(deps, deps.clock(), sendUntil, () => failure(supplier, 'send_lost', `The send of ${job.label} got no answer and there is no time to send it again; ${escrow} is Open and goes to the janitor.`), `${job.label} was being sent`);
      continue;
    }
    if (state === 'Open' && sent.kind === 'refused') {
      throw failure(supplier, 'refused', `${named(supplier)} refused ${job.label} twice (${answer}); ${escrow} is Open and goes to the janitor.`);
    }
    throw failure(supplier, 'send_lost', state === 'Open'
      ? `The send of ${job.label} got no answer twice; ${escrow} is Open and goes to the janitor.`
      : `The send of ${job.label} got ${answer === '' ? 'no answer' : `the answer ${answer}`}, and ${escrow} is ${said(state)}: the supplier may hold the job, but there is no job id to ask it for the result. The escrow goes to the janitor.`);
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
    const why = polled.kind === 'gone' ? 'it no longer knows the job (404)' : `${polled.reason}${polled.message === '' ? '' : `: ${polled.message}`}`;
    if (state === 'Submitted' && polled.kind === 'failed' && SUBMIT_FAILURES.has(polled.reason)) {
      throw failure(supplier, 'receipt_unavailable', `${named(supplier)} failed ${job.label} at its own Submit (${why}) while ${escrow} reads Submitted: the receipt is on chain, but the supplier will not hand it over and no poll will bring it. The escrow is not accepted and stays with the janitor.`);
    }
    if (state === null || state === 'Submitted') continue;
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

/**
 * The Accept of a verified job (ruling R54): confirmed, booked and forgotten; sent but not seen confirmed, marked for the janitor (ruling R33). Any
 * other failure cannot land (a build that did not complete, a submit the API refused), so the Accept is made again every 15 s, with fresh inputs and a
 * fresh validity range, until the planner says the accept window has closed or 600 s have passed since `answeredAt`, the moment the supplier handed
 * over its result (its Submit came before it, so the window ends then at the latest). Only then is it <hop>_accept_failed. The deadline of the run
 * is not asked: a hire in its Accept finishes late (ruling R53).
 */
async function accept<T>(deps: HireDeps, supplier: Supplier, job: Job<T>, post: PostResult, accounting: Accounting, answeredAt: number): Promise<void> {
  const lastChance = answeredAt + ACCEPT_WINDOW_MS;
  let accepted: { txHash: string; feeLovelace: bigint } | undefined;
  for (let attempts = 1; accepted === undefined; attempts += 1) {
    try {
      accepted = await deps.chain.accept(post.escrowRef);
    } catch (err) {
      if (err instanceof TxNotConfirmedError && err.mayLand) {
        const { txHash, validTo } = err;
        recorded(() => deps.stranded.update(post.escrowRef, { accept_pending: { tx_hash: txHash, valid_to: validTo, by: 'run' } }),
          post.escrowRef, `its Accept ${txHash} for ${job.label} may land until ${iso(validTo)}, and the store does not say so: the janitor takes it for a Submitted escrow it cannot accept.`);
        return;
      }
      const closed = err instanceof AcceptWindowClosedError;
      if (closed || deps.clock() + BUSY_RETRY_MS > lastChance) {
        const why = closed ? 'the accept window has closed' : `the next one would start more than ${ACCEPT_WINDOW_MS / 1000} s after the supplier's answer, when the accept window may be over`;
        throw failure(supplier, 'accept_failed', `The Accept of ${job.label} was made ${attempts} ${attempts === 1 ? 'time' : 'times'}, ${BUSY_RETRY_MS / 1000} s apart, and the last attempt failed (${errorText(err)}); ${why}. Its escrow ${post.escrowRef} stays recorded for the janitor.`);
      }
      await deps.sleep(BUSY_RETRY_MS);
    }
  }
  accounting.accepted(accepted);
  // The one write of the store that does not fail the run (ruling R62): the job is paid and verified, and an entry the remove left behind reads spent, which
  // the janitor drops on its own. Every other write after money moved fails closed (recorded).
  try { deps.stranded.remove(post.escrowRef); } catch (err) {
    deps.log?.(`escrow ${post.escrowRef} was accepted for ${job.label} in ${accepted.txHash} and could not be removed from the stranded store (${errorText(err)}); the janitor drops it once it reads it spent`);
  }
}
