// agents/document-pipeline/src/budget.ts
// The time and float rules of a run, in one place. The deadline is the orchestrator's own: the server sets it 1620000 ms after the request arrives,
// 60 s inside the runtime's SERVICE_TIMEOUT_MS, so that a run answers, with a result or a refusal, before the runtime gives up on it. It does so
// except where something the deadline does not cut is still under way when it comes: a Post or an Accept confirming, the repeats of an Accept, a send,
// a poll or a read of the chain in flight (see below).
//
// What one hire waits for, part by part (ruling R40): its Post confirmed (up to 180 s, the chain's own wait), the supplier's Claim (up to 60 s, before
// it answers the send), the work (up to 240 s for an OCR page, 180 s for the chat job), the supplier's Submit (about 30 s), the hash of the receipt
// showing on chain (up to 120 s) and the Accept confirmed (up to 180 s). No page is started with less than 660 s left before the deadline and no chat
// job with less than 420 s. For a page the Claim, the work, the Submit and the hash wait take up to 450 s, which leaves its Post and its Accept 210 s
// between them; for the chat job those four take up to 390 s and leave its two transactions 30 s. The minimums are not the sum of every worst case
// (810 s for a page, 750 s for the chat job).
//
// What the deadline cuts is what the run waits for on its own: the repeats of a send, the polls, the repeats of a read of the receipt hash, and the
// pauses between them (fit, checkWithin and waitWithin below). Past the deadline none of them starts again, and the run fails with `deadline`, the escrows it
// leaves behind going to the janitor. The deadline does not cut the confirmation of a Post or of an Accept: Chain.postEscrow and Chain.accept take no
// deadline, and RealChain gives each up to 60 s to build and 180 s to submit and confirm. Nor does it cut the repeats of an Accept that failed in a way
// that cannot land, every 15 s for up to 600 s after the supplier's answer (ruling R54). So a hire in its Accept at the deadline runs on, and its Accept
// completes, is left accept_pending or fails accept_failed; the next hop then fails with `deadline` (assertTimeLeft), or, after the chat job, the run
// still answers, which can be after the runtime has given up on it (60 s after the deadline at the latest). A call already under way when the deadline
// comes is not cut either: a send in flight (up to 75 s), a poll in flight (up to 20 s) and a read of the chain each end when they end. The tests of
// "the deadline" in test/orchestrate.test.ts show the waits that are cut and the transactions that are not.
//
// What a run may lock is checked before the first Post: the collateral output, and a float for every sub-job it could post. The gate needs no supplier
// (the health check makes it too): FLOAT_PER_SUB_JOB_LOVELACE assumes adverts priced at or under the price ceilings of the service (1000000 lovelace
// each by default, src/start.ts) with bonds of 1000000 and 1000000, so a lock of at most 3000000 and two fees at the floor of 500000, which these
// transactions cost today; an Accept whose script execution cost more would exceed it. That is under 4500000. Once
// both suppliers are chosen, a second look checks the float against the locks their adverts really take (src/orchestrate.ts): larger bonds, or a
// ceiling raised above that, are caught there.
import { PipelineError } from './result.ts';
export { OutOfTime, within } from '@vsa/service-kit';

/** How long after its request arrived a run must be over: the server sets the deadline of each request to its arrival plus this (see the head of this file). */
export const JOB_DEADLINE_MS = 1_620_000;
/** No page is started with less than this left before the deadline (ruling R40; see the head of this file). */
export const PAGE_MIN_LEFT_MS = 660_000;
/** No chat job is started with less than this left before the deadline (ruling R40). */
export const LLM_MIN_LEFT_MS = 420_000;
/** A chat supplier chosen longer ago than this when the pages are done is chosen again before its Post (ruling R35). */
export const LLM_SELECTION_MAX_AGE_MS = 600_000;
/** A busy supplier, or one that does not see the escrow yet, is sent the same job again this often, on the same escrow... */
export const BUSY_RETRY_MS = 15_000;
/** ...until this long before the escrow's deliver_by: a send waits up to 75 s for the supplier's Claim, so the last one ends 15 s before deliver_by. */
export const SEND_CUTOFF_MS = 90_000;
/** A job is polled this often, and the hash of the receipt on chain is read again this often while the indexer catches up. */
export const POLL_INTERVAL_MS = 3_000;
/** An OCR supplier whose /status could not be read is asked once more this long after, before the job is refused (each ask has the 2 s of a /status call). */
export const STATUS_RETRY_MS = 3_000;
/** How long a read of the buyer wallet may take, a job's as the health check's (src/server.ts): a read that has not answered then is abandoned. */
export const WALLET_READ_TIMEOUT_MS = 30_000;

/** How long the hash of the supplier's Submit may take to show on chain once the supplier has answered with the receipt (Koios lag, ruling R16). */
export const RECEIPT_HASH_WAIT_MS = 120_000;
/**
 * The float a run needs for each sub-job it could post, outside the collateral output; a run of `max_pages` posts up to max_pages + 1 of them. It holds for
 * adverts at or under the price ceilings with bonds of 1000000 each (see the head of this file); the second look of src/orchestrate.ts covers the rest.
 */
export const FLOAT_PER_SUB_JOB_LOVELACE = 4_500_000n;
/** The most base64 the OCR supplier takes for one page. */
export const OCR_IMAGE_B64_MAX = 12_000_000;

/** The float a run of `maxPages` pages needs before its first Post: (max_pages + 1) x 4500000 lovelace. */
export const floatNeeded = (maxPages: number): bigint => BigInt(maxPages + 1) * FLOAT_PER_SUB_JOB_LOVELACE;

/** What the rules read: the run's clock, its sleep, and its deadline (POSIX milliseconds). */
export interface Clocked { clock: () => number; sleep: (ms: number) => Promise<void>; deadlineMs: number }

/** The refusal of a run whose deadline came while it was `doing` something. */
export const deadlineError = (doing: string): PipelineError => new PipelineError('deadline', `The deadline of the job came while ${doing}.`);

/** Throws `deadline` unless at least `minLeftMs` is left before the deadline, for `what` (page 2, the summary), which is then not started. */
export function assertTimeLeft(t: Clocked, minLeftMs: number, what: string): void {
  const left = t.deadlineMs - t.clock();
  if (left < minLeftMs) {
    throw new PipelineError('deadline', `${Math.max(0, Math.floor(left / 1000))} s are left before the deadline of the job, less than the ${minLeftMs / 1000} s that ${what} needs, so it was not started.`);
  }
}

/**
 * Where the moment `at` stands: in time for `limit` and the deadline, or past whichever of the two ends first (the deadline when they are the same
 * moment). A moment equal to a limit is in time.
 */
export function fit(t: Clocked, at: number, limit: number): 'in time' | 'past the limit' | 'past the deadline' {
  const end = Math.min(limit, t.deadlineMs);
  if (at <= end) return 'in time';
  return end === t.deadlineMs ? 'past the deadline' : 'past the limit';
}

/** Throws when `at` is past `limit` (the error `onLimit` makes) or past the deadline (`deadline`, saying what the run was `doing`); returns otherwise. */
export function checkWithin(t: Clocked, at: number, limit: number, onLimit: () => PipelineError, doing: string): void {
  const where = fit(t, at, limit);
  if (where === 'past the deadline') throw deadlineError(doing);
  if (where === 'past the limit') throw onLimit();
}

/** Sleeps `ms` when the attempt after the sleep still starts within `limit` and the deadline (checkWithin); otherwise throws, without sleeping. */
export async function waitWithin(t: Clocked, ms: number, limit: number, onLimit: () => PipelineError, doing: string): Promise<void> {
  checkWithin(t, t.clock() + ms, limit, onLimit, doing);
  await t.sleep(ms);
}
