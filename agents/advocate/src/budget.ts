// agents/advocate/src/budget.ts
// The time of a job (ruling R-E8). A job must end with a result or a refusal before the runtime gives up on the service, SERVICE_TIMEOUT_MS (180000 ms) after
// the call began, and that is 120 s inside the window of 5 min the advert gives (max_processing_ms 300000; the runtime refuses to boot unless the timeout is at
// least 60 s inside it). So the deadline of a job is its arrival plus 150 s, 30 s before the runtime's timeout. Inside it: the search gets at most 15 s, its two
// queries one after the other and each request 10 s at most (R-E17); the fetch of the pages ends at the earlier of 45 s after it begins and 20 s before the
// deadline, each page with at most 15 s and four at a time; the model gets at most 90 s and 5 s less than the time left, and is not started with less than
// 15 s; the check and the result take what is left. At the worst every phase takes all it may (15 s, 45 s, then the 85 s the model is given) and the job ends
// 5 s before its deadline.

/** The deadline of a job, after its arrival: 150 s. */
export const JOB_DEADLINE_MS = 150_000;
/** The most the search of a job takes: its two queries, one after the other (R-E17). */
export const SEARCH_MAX_MS = 15_000;
/** The most one request of a query takes, its answer read to the end. */
export const SEARCH_QUERY_TIMEOUT_MS = 10_000;
/** The most the fetch of the pages takes, from its start. */
export const FETCH_PHASE_MAX_MS = 45_000;
/** What the fetch of the pages leaves before the deadline, for the model, the check and the result. */
export const FETCH_RESERVE_MS = 20_000;
/** The most one page takes, its host lookup and its body included. */
export const PAGE_TIMEOUT_MS = 15_000;
/** The pages fetched at a time. */
export const FETCH_CONCURRENCY = 4;
/** The most the model call takes. */
export const MODEL_MAX_MS = 90_000;
/** The least time the model call is started with; with less, the job answers deadline. */
export const MODEL_MIN_MS = 15_000;
/** What the model call leaves before the deadline, for the check and the result. */
export const RESULT_RESERVE_MS = 5_000;

/** The end of the fetch phase that begins at `nowMs`: min(now + FETCH_PHASE_MAX_MS, the deadline of the job less FETCH_RESERVE_MS). */
export function fetchDeadlineMs(nowMs: number, jobDeadlineMs: number): number {
  return Math.min(nowMs + FETCH_PHASE_MAX_MS, jobDeadlineMs - FETCH_RESERVE_MS);
}

/** The time the model call gets with `leftMs` of the job left: min(MODEL_MAX_MS, leftMs - RESULT_RESERVE_MS), or null when that is under MODEL_MIN_MS. */
export function modelBudgetMs(leftMs: number): number | null {
  const budget = Math.min(MODEL_MAX_MS, leftMs - RESULT_RESERVE_MS);
  return budget >= MODEL_MIN_MS ? budget : null;
}
