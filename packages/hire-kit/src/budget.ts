// packages/hire-kit/src/budget.ts
// The waits of one hire, in one place: how often a send is made again and until when, how often a job is polled, how long the hash of a receipt may take
// to show on chain, and the three rules that hold a wait to its limit and to the deadline of the run (fit, checkWithin and waitWithin). Moved from
// agents/document-pipeline/src/budget.ts, which keeps the time rules of a Pipeline run and its float gate.
//
// What the deadline cuts is what the hire waits for on its own: the repeats of a send, the polls, the repeats of a read of the receipt hash, and the
// pauses between them (fit, checkWithin and waitWithin below). Past the deadline none of them starts again, and the hire fails with the deadline error
// of the caller's factory (HireErrors, src/hire.ts), the escrow it leaves behind going to the janitor. The deadline does not cut the confirmation of a
// Post or of an Accept: Chain.postEscrow and Chain.accept take no deadline, and RealChain gives each up to 60 s to build and 180 s to submit and confirm.
// Nor does it cut the repeats of an Accept that failed in a way that cannot land, every 15 s for up to 600 s after the supplier's answer (ruling R54). So a
// hire in its Accept at the deadline runs on, and its Accept completes, is left accept_pending or fails accept_failed. A call already under way when the
// deadline comes is not cut either: a send in flight (up to 75 s), a poll in flight (up to 20 s) and a read of the chain each end when they end.

/** A busy supplier, or one that does not see the escrow yet, is sent the same job again this often, on the same escrow... */
export const BUSY_RETRY_MS = 15_000;
/** ...until this long before the escrow's deliver_by: a send waits up to 75 s for the supplier's Claim, so the last one ends 15 s before deliver_by. */
export const SEND_CUTOFF_MS = 90_000;
/** A job is polled this often, and the hash of the receipt on chain is read again this often while the indexer catches up. */
export const POLL_INTERVAL_MS = 3_000;
/** How long the hash of the supplier's Submit may take to show on chain once the supplier has answered with the receipt (Koios lag, ruling R16). */
export const RECEIPT_HASH_WAIT_MS = 120_000;

/** What the rules read: the run's clock, its sleep, and its deadline (POSIX milliseconds). */
export interface Clocked { clock: () => number; sleep: (ms: number) => Promise<void>; deadlineMs: number }

/**
 * Where the moment `at` stands: in time for `limit` and the deadline, or past whichever of the two ends first (the deadline when they are the same
 * moment). A moment equal to a limit is in time.
 */
export function fit(t: Clocked, at: number, limit: number): 'in time' | 'past the limit' | 'past the deadline' {
  const end = Math.min(limit, t.deadlineMs);
  if (at <= end) return 'in time';
  return end === t.deadlineMs ? 'past the deadline' : 'past the limit';
}

/** Throws when `at` is past `limit` (the error `onLimit` makes) or past the deadline (the error `onDeadline` makes); returns otherwise. */
export function checkWithin<E>(t: Clocked, at: number, limit: number, onLimit: () => E, onDeadline: () => E): void {
  const where = fit(t, at, limit);
  if (where === 'past the deadline') throw onDeadline();
  if (where === 'past the limit') throw onLimit();
}

/** Sleeps `ms` when the attempt after the sleep still starts within `limit` and the deadline (checkWithin); otherwise throws, without sleeping. */
export async function waitWithin<E>(t: Clocked, ms: number, limit: number, onLimit: () => E, onDeadline: () => E): Promise<void> {
  checkWithin(t, t.clock() + ms, limit, onLimit, onDeadline);
  await t.sleep(ms);
}
