// agents/advocate/src/run.ts
// One job, from the request to the brief (ruling R-E8): five phases under one deadline, the arrival of the request plus JOB_DEADLINE_MS, which the server
// sets. The search (src/search.ts): the two queries one after the other, inside a phase that ends at the earlier of 15 s after it begins and the deadline,
// which the search is given as phaseEndMs and keeps to, each query cut at min(10 s, the time left). The pages (src/pages.ts): fetched until the earlier of
// 45 s after the phase begins and 20 s before the deadline; with 20 s or less left the model could not be started after any page, so the job answers deadline
// before it fetches one (ruling R-E20). The model (src/model.ts): one call that gets min(90 s, the time left less 5 s), never started with less than 15 s; a
// call that runs out of a time the deadline cut short is deadline too (ruling R-E19). The check (src/check.ts) and the brief (src/result.ts) take what is
// left. So a job ends before its deadline: the call of the model ends at least 5 s before it, and nothing after the call waits on anything.
//
// A job whose caller hangs up is stopped: the server aborts the signal of the job, which every fetch of the job carries (the queries, the pages, the call of
// the model), and which is looked at between the phases. Whatever the job then fails with on its way, it fails with aborted (499), and nothing of it is kept.
// The service holds no chain key and posts nothing: a job that fails locks nothing of the service's, and the hirer reclaims the escrow after its deliver_by.
// The run writes no log line of its own: its phases write theirs (counts and statuses, never a text of the job), and the server writes the line of the job.
import type { SafeFetchOpts } from '@vsa/vector-read';
import { SEARCH_MAX_MS, SEARCH_QUERY_TIMEOUT_MS, fetchDeadlineMs, modelBudgetMs } from './budget.ts';
import { checkCitations } from './check.ts';
import { AdvocateError } from './errors.ts';
import { callModel, parseBriefAnswer } from './model.ts';
import type { Usage } from './model.ts';
import { fetchPages } from './pages.ts';
import { SHAPES, messagesFor } from './prompt.ts';
import type { AdvocateRequest } from './request.ts';
import { buildResult } from './result.ts';
import type { AdvocateResult } from './result.ts';
import { queriesFor, searchWeb } from './search.ts';

export interface RunDeps {
  fetchImpl: typeof fetch;
  clock: () => number;
  /** The key of the Brave Search API (BRAVE_SEARCH_API_KEY): sent with the two queries of a job, and nowhere else. */
  braveApiKey: string;
  /** The key of OpenRouter (OPENROUTER_API_KEY): sent with the call of the model, and nowhere else. */
  openRouterApiKey: string;
  /** The model of OpenRouter the job calls (OPENROUTER_MODEL). */
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
}
export interface RunOutcome { result: AdvocateResult; pagesKept: number; resultsFound: number; usage: Usage | null; dropped: { quotes: number; arguments: number } }

/** The failure of a job that was stopped because its caller hung up. */
const abandoned = (): AdvocateError => new AdvocateError('aborted', 'the caller hung up, and the job was stopped');
const isAbortError = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';

export async function runAdvocate(req: AdvocateRequest, deps: RunDeps): Promise<RunOutcome> {
  try {
    return await runJob(req, deps);
  } catch (error) {
    // Whatever a job that was stopped fails with on its way (a cut query, a cut page, the cut call of the model), it failed because its caller hung up.
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

  // The model: min(90 s, the time left less 5 s), and not started with less than 15 s. callModel answers deadline itself when that time runs out under 90 s.
  const left = deadlineMs - clock();
  const budget = modelBudgetMs(left);
  if (budget === null) throw new AdvocateError('deadline', `the job had ${left} ms of its time left for the model, too little to start it`);
  const { content, usage } = await callModel(messagesFor(req, pages), {
    fetchImpl: deps.fetchImpl, apiKey: deps.openRouterApiKey, model: deps.model, maxTokens: SHAPES[req.length].maxTokens, timeoutMs: budget, signal, log,
  });
  stopIfAbandoned();

  // The check and the brief.
  const brief = parseBriefAnswer(content);
  const checked = checkCitations(brief, pages);
  return {
    result: buildResult(req, brief.thesis, checked, deps.model), pagesKept: pages.length, resultsFound: results.length, usage,
    dropped: { quotes: checked.droppedQuotes, arguments: checked.droppedArguments },
  };
}
