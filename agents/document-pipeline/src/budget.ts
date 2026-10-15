// agents/document-pipeline/src/budget.ts
// The time and money rules of a run, in one place. The deadline is the orchestrator's own: the server sets it 1620000 ms after the request arrives,
// 60 s inside the runtime's SERVICE_TIMEOUT_MS, so that a run answers, with a result or a refusal, before the runtime gives up on it. Every wait of a
// run (a busy supplier, a poll, the hash on chain) ends at the deadline at the latest; no page starts without the 480 s a page can take, and no chat
// job without 300 s. What a run may lock is checked before the first Post: the collateral output, and a float for every sub-job it could post.
import { PipelineError } from './result.ts';

/**
 * No page starts with less than this left before the deadline: a page can take until the deliver_by of its escrow, 480 s after its Post (the OCR
 * advert's 300 s window and the 180 s buffer every Post adds).
 */
export const PAGE_MIN_LEFT_MS = 480_000;
/** No chat job starts with less than this left before the deadline. */
export const LLM_MIN_LEFT_MS = 300_000;
/** A busy supplier is sent the same job again this often, on the same escrow... */
export const BUSY_RETRY_MS = 15_000;
/** ...until this long before the escrow's deliver_by: a send waits up to 75 s for the supplier's Claim, so the last one ends 15 s before deliver_by. */
export const SEND_CUTOFF_MS = 90_000;
/** A job is polled this often, and the hash of the receipt on chain is read again this often while the indexer catches up. */
export const POLL_INTERVAL_MS = 3_000;
/** How long the hash of the supplier's Submit may take to show on chain once the supplier has answered with the receipt (Koios lag, ruling R16). */
export const RECEIPT_HASH_WAIT_MS = 120_000;
/** The float a run needs for each sub-job it could post, outside the collateral output; a run of `max_pages` posts up to max_pages + 1 of them. */
export const FLOAT_PER_SUB_JOB_LOVELACE = 4_500_000n;
/** The most base64 the OCR supplier takes for one page. */
export const OCR_IMAGE_B64_MAX = 12_000_000;

/** The float a run of `maxPages` pages needs before its first Post: (max_pages + 1) x 4500000 lovelace. */
export const floatNeeded = (maxPages: number): bigint => BigInt(maxPages + 1) * FLOAT_PER_SUB_JOB_LOVELACE;

/** What the rules read: the run's clock, its sleep, and its deadline (POSIX milliseconds). */
export interface Clocked { clock: () => number; sleep: (ms: number) => Promise<void>; deadlineMs: number }

/** Throws `deadline` unless at least `minLeftMs` is left before the deadline, for `what` (page 2, the summary), which is then not started. */
export function assertTimeLeft(t: Clocked, minLeftMs: number, what: string): void {
  const left = t.deadlineMs - t.clock();
  if (left < minLeftMs) {
    throw new PipelineError('deadline', `${Math.max(0, Math.floor(left / 1000))} s are left before the deadline of the job, less than the ${minLeftMs / 1000} s that ${what} needs, so it was not started.`);
  }
}

/**
 * Throws when `at` is past `limit` or past the deadline, the error of whichever ends first (`deadline` when they are the same moment); returns when it
 * is neither. `onLimit` makes the error of the limit, `doing` says what the run was doing for the deadline's message. A moment equal to a limit is in time.
 */
export function checkWithin(t: Clocked, at: number, limit: number, onLimit: () => PipelineError, doing: string): void {
  const end = Math.min(limit, t.deadlineMs);
  if (at <= end) return;
  throw end === t.deadlineMs ? new PipelineError('deadline', `The deadline of the job came while ${doing}.`) : onLimit();
}

/** Sleeps `ms` when the attempt after the sleep still starts within `limit` and the deadline (checkWithin); otherwise throws, without sleeping. */
export async function waitWithin(t: Clocked, ms: number, limit: number, onLimit: () => PipelineError, doing: string): Promise<void> {
  checkWithin(t, t.clock() + ms, limit, onLimit, doing);
  await t.sleep(ms);
}
