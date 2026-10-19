// agents/advocate/src/budget.ts
// The time of a job (rulings R-E8 and R-F2). A job must end with a result or a refusal before the runtime gives up on the service, SERVICE_TIMEOUT_MS (360000 ms)
// after the call began, and that is 120 s inside the window of 8 min the advert gives (max_processing_ms 480000; the runtime refuses to boot unless the timeout
// is at least 60 s inside it). So the deadline of a job is its arrival plus 300 s, 60 s inside the runtime's timeout, the margin of the Document Pipeline.
// Inside it: the search gets at most 15 s, its two queries one after the other and each request 10 s at most (R-E17); the fetch of the pages ends at the
// earlier of 45 s after it begins and 20 s before the deadline, each page with at most 15 s and four at a time. Then the model (src/inference.ts): first the
// hire of a chat supplier on the Vector marketplace, whose own waits stop at the hop deadline, FALLBACK_RESERVE_MS (95 s) before the deadline of the job, so
// that the 90 s of a call through OpenRouter and the 5 s of the check and the result still fit after a hire that failed; no hire is begun with less than
// HOP_MIN_MS (60 s) left before the hop deadline. The choice of the supplier has 15 s, three candidates at most, and ends within 25 s with the read of its
// advert on chain; the read of the buyer wallet has 10 s. Only when the hire fails is the call made through OpenRouter: min(90 s, the time left less 5 s),
// and never started with less than 15 s.
//
// The arithmetic, in seconds after the request arrives, each phase at its worst. The search ends by 15 and the pages by 60; the choice ends by 85 and the read
// of the wallet by 95, so the Post starts by 95, well before the latest start the hop allows, 205 - 60 = 145. From the Post to the hop deadline at 205 there are
// 110 s for the Post, the supplier's Claim, its work and its Submit. A hire that ends well is verified and accepted by about 215, and the check and the result
// follow. A hire that fails by 205 leaves the call through OpenRouter its full 90 s, to 295, and the check and the result their 5 s, to 300. The receipt of a
// supplier that has answered is read on chain until 280 (receiptByMs: the deadline less MODEL_MIN_MS and RESULT_RESERVE_MS), so a receipt that fails then
// leaves OpenRouter 15 s, and one that fails later leaves too little and the job answers deadline. Past 300 only a Post or an Accept that is being confirmed
// runs on, as a hire in its Accept at the deadline is not cut; the 60 s to the runtime's timeout cover a normal confirmation.

/** The deadline of a job, after its arrival: 300 s. */
export const JOB_DEADLINE_MS = 300_000;
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
/** The most the model call through OpenRouter takes. */
export const MODEL_MAX_MS = 90_000;
/** The least time the model call through OpenRouter is started with; with less, the job answers deadline. */
export const MODEL_MIN_MS = 15_000;
/** What the model call leaves before the deadline, for the check and the result. */
export const RESULT_RESERVE_MS = 5_000;
/** What the hire of a chat supplier leaves before the deadline of the job: the time of a call through OpenRouter and of the check and the result. */
export const FALLBACK_RESERVE_MS = 95_000;
/** The least time a hire is begun with before the hop deadline: the Post, the supplier's Claim and Submit, the Accept and a short answer. */
export const HOP_MIN_MS = 60_000;
/** The time the choice of a chat supplier gives its candidates, and how many it asks at most. */
export const CHOICE_BUDGET_MS = 15_000;
export const CHOICE_MAX_CANDIDATES = 3;
/** The most the choice of a chat supplier takes, the read of its advert on chain included. */
export const CHOICE_WITHIN_MS = 25_000;
/** The most the read of the buyer wallet takes before the Post. */
export const WALLET_READ_MS = 10_000;

/** The end of the fetch phase that begins at `nowMs`: min(now + FETCH_PHASE_MAX_MS, the deadline of the job less FETCH_RESERVE_MS). */
export function fetchDeadlineMs(nowMs: number, jobDeadlineMs: number): number {
  return Math.min(nowMs + FETCH_PHASE_MAX_MS, jobDeadlineMs - FETCH_RESERVE_MS);
}

/** The time the model call gets with `leftMs` of the job left: min(MODEL_MAX_MS, leftMs - RESULT_RESERVE_MS), or null when that is under MODEL_MIN_MS. */
export function modelBudgetMs(leftMs: number): number | null {
  const budget = Math.min(MODEL_MAX_MS, leftMs - RESULT_RESERVE_MS);
  return budget >= MODEL_MIN_MS ? budget : null;
}

/** The hop deadline of a job whose deadline is `jobDeadlineMs`: the waits of its hire stop there, FALLBACK_RESERVE_MS before it. */
export function hopDeadlineMs(jobDeadlineMs: number): number {
  return jobDeadlineMs - FALLBACK_RESERVE_MS;
}

/** Until when the receipt of a supplier that has answered is read on chain: the deadline less the least time of a call through OpenRouter and of the result. */
export function receiptByMs(jobDeadlineMs: number): number {
  return jobDeadlineMs - MODEL_MIN_MS - RESULT_RESERVE_MS;
}
