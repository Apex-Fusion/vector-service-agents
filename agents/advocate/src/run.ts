// agents/advocate/src/run.ts
// One job, from the request to the brief (rulings R-E8 and R-F2): five phases under one deadline, the arrival of the request plus JOB_DEADLINE_MS, which the
// server sets. The search (src/search.ts): the two queries one after the other, inside a phase that ends at the earlier of 15 s after it begins and the
// deadline, which the search is given as phaseEndMs and keeps to, each query cut at min(10 s, the time left). The pages (src/pages.ts): fetched until the
// earlier of 45 s after the phase begins and 20 s before the deadline; with 20 s or less left the model could not be started after any page, so the job
// answers deadline before it fetches one (ruling R-E20). The model (src/inference.ts): bought first from a chat supplier on the Vector marketplace, whose hire
// stops its waits 95 s before the deadline, and made through OpenRouter only when that hire fails, with min(90 s, the time left less 5 s) and never with less
// than 15 s (ruling R-E19 for a call cut short). The check (src/check.ts) and the brief (src/result.ts) take what is left. A brief from the marketplace whose
// every claim the check drops is no_supported_claims: the brief was the answer of the job, and no second call is made on the same pages.
//
// A job whose caller hangs up is stopped: the server aborts the signal of the job, which every fetch of the search, of the pages and of the call through
// OpenRouter carries, and which is looked at between the phases. Whatever the job then fails with on its way, it fails with aborted (499). The one exception
// is a write of the stranded store that failed after the Post of the chat sub-job (store_write_failed, 500): it stays what it is, so that the log names the
// escrow. The hire of the chat supplier never sees the signal (src/inference.ts): an escrow it posted ends on its own terms, accepted or recorded for the
// janitor (src/start.ts), and a hirer whose job failed reclaims its own escrow after its deliver_by.
// The run writes no log line of its own: its phases write theirs (counts, codes and statuses, never a text of the job), and the server writes the line of the
// job.
import type { Chain } from '@vsa/buyer-core';
import type { StrandedStore } from '@vsa/hire-kit';
import type { SafeFetchOpts } from '@vsa/vector-read';
import { SEARCH_MAX_MS, SEARCH_QUERY_TIMEOUT_MS, fetchDeadlineMs } from './budget.ts';
import { checkCitations } from './check.ts';
import { AdvocateError } from './errors.ts';
import { HopFailed, infer } from './inference.ts';
import type { Inference } from './inference.ts';
import type { Usage } from './model.ts';
import { fetchPages } from './pages.ts';
import type { AdvocateRequest } from './request.ts';
import { buildResult } from './result.ts';
import type { AdvocateResult } from './result.ts';
import { queriesFor, searchWeb } from './search.ts';

export interface RunDeps {
  fetchImpl: typeof fetch;
  clock: () => number;
  /** The key of the Brave Search API (BRAVE_SEARCH_API_KEY): sent with the two queries of a job, and nowhere else. */
  braveApiKey: string;
  /** The key of OpenRouter (OPENROUTER_API_KEY): sent with the call of the model through OpenRouter, and nowhere else. */
  openRouterApiKey: string;
  /** The model of OpenRouter the fallback calls (OPENROUTER_MODEL). */
  model: string;
  /** The deadline of the job on the clock: its arrival plus JOB_DEADLINE_MS, set by the server. */
  deadlineMs: number;
  /** Aborts when the caller of the job hangs up (the server's abortOnClose): the job is stopped and fails with aborted. */
  signal?: AbortSignal;
  log: (line: string) => void;
  /** The host lookup of the page fetches (safeFetch's own option), a test seam: a test answers with a public address and asks no DNS. The service never sets it. */
  lookup?: SafeFetchOpts['lookup'];
  /** The wait between the two queries of the search (its own timer by default), a test seam: a test gives one that returns at once. The service never sets it. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The chain of the buyer key, which posts and accepts the escrow of the chat sub-job. */
  chain: Chain;
  /** The escrows a hire posted and did not see accepted, in the state directory, for the janitor. */
  stranded: StrandedStore;
  /** The pause between the polls and the repeats of a hire. */
  sleep: (ms: number) => Promise<void>;
  /** The chat models the service hires (LLM_MODEL_ALLOWLIST) and the most an advert may be priced at (LLM_MAX_PRICE_LOVELACE). */
  allowlist: readonly string[];
  maxPriceLovelace: bigint;
  /** The marketplace indexer; the configured one when absent (VECTOR_MARKETPLACE_INDEXER_URL). */
  indexerUrl?: string;
  /** The key hash of the buyer key. */
  buyerPkh: string;
  /** Whether the marketplace path is open, one object for the life of the service. */
  marketplace: { on: boolean };
}
export interface RunOutcome {
  result: AdvocateResult; pagesKept: number; resultsFound: number; usage: Usage | null; dropped: { quotes: number; arguments: number };
  inference: Pick<Inference, 'path' | 'model' | 'subJob' | 'accepted' | 'fallbackFrom'>;
}

/** The failure of a job that was stopped because its caller hung up. */
const abandoned = (): AdvocateError => new AdvocateError('aborted', 'the caller hung up, and the job was stopped');
const isAbortError = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';

export async function runAdvocate(req: AdvocateRequest, deps: RunDeps): Promise<RunOutcome> {
  try {
    return await runJob(req, deps);
  } catch (error) {
    // A store that could not be written names an escrow the janitor does not know of: it stays a 500, whose line in the log names it.
    if (error instanceof HopFailed && error.code === 'store_write_failed') throw error;
    // Whatever else a job that was stopped fails with on its way (a cut query, a cut page, the cut call of the model), it failed because its caller hung up.
    if (deps.signal?.aborted === true || isAbortError(error)) throw abandoned();
    throw error;
  }
}

async function runJob(req: AdvocateRequest, deps: RunDeps): Promise<RunOutcome> {
  const { clock, deadlineMs, signal, log } = deps;
  /** Throws aborted once the caller has hung up: looked at between the phases. */
  const stopIfAbandoned = (): void => { if (signal?.aborted === true) throw abandoned(); };
  stopIfAbandoned();

  // The search: a phase that ends at the earlier of 15 s from now and the deadline, each query cut at min(10 s, the time left). The language of the request
  // shapes the brief alone (ruling R-E15): the search is not told it.
  const searchFrom = clock();
  if (deadlineMs - searchFrom <= 0) throw new AdvocateError('deadline', 'the deadline of the job had passed before it began');
  const results = await searchWeb(queriesFor(req.subject, req.side), {
    fetchImpl: deps.fetchImpl, apiKey: deps.braveApiKey, clock, timeoutMs: Math.min(SEARCH_QUERY_TIMEOUT_MS, deadlineMs - searchFrom),
    phaseEndMs: Math.min(searchFrom + SEARCH_MAX_MS, deadlineMs), wait: deps.wait, signal, log,
  });
  stopIfAbandoned();

  // The pages: until the earlier of 45 s from now and 20 s before the deadline. With 20 s or less left the model could not be started after any page, and the
  // phase would end at once with none: the job ran out of its time (R-E20).
  const fetchFrom = clock();
  const fetchUntil = fetchDeadlineMs(fetchFrom, deadlineMs);
  if (fetchUntil <= fetchFrom) {
    throw new AdvocateError('deadline', `the job had ${deadlineMs - fetchFrom} ms of its time left after the search, too little to fetch a page and still start the model`);
  }
  const pages = await fetchPages(results, { fetchImpl: deps.fetchImpl, clock, deadlineMs: fetchUntil, signal, log, lookup: deps.lookup });
  stopIfAbandoned();

  // The model: the marketplace first, OpenRouter when that hire fails (src/inference.ts), each in its part of the time left.
  const inference = await infer(req, pages, {
    chain: deps.chain, stranded: deps.stranded, fetchImpl: deps.fetchImpl, clock, sleep: deps.sleep, allowlist: deps.allowlist, maxPriceLovelace: deps.maxPriceLovelace,
    indexerUrl: deps.indexerUrl, buyerPkh: deps.buyerPkh, openRouterApiKey: deps.openRouterApiKey, openRouterModel: deps.model, marketplace: deps.marketplace,
    deadlineMs, signal, log,
  });

  // The check and the brief.
  const checked = checkCitations(inference.brief, pages);
  return {
    result: buildResult(req, inference.brief.thesis, checked, inference), pagesKept: pages.length, resultsFound: results.length, usage: inference.usage,
    dropped: { quotes: checked.droppedQuotes, arguments: checked.droppedArguments },
    inference: { path: inference.path, model: inference.model, subJob: inference.subJob, accepted: inference.accepted, fallbackFrom: inference.fallbackFrom },
  };
}
