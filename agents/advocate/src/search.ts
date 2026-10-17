// agents/advocate/src/search.ts
// The search of a job (rulings R-E3 and R-E15 to R-E17): two queries to the Brave Web Search API, the subject alone and the subject with the words of its
// side, each kept within Brave's limits of 400 characters and 50 words; their web results, the second query's first, deduped and held to https, at most
// MAX_RESULTS of them. Of a result only its title, its url and its description are read. The key of the API goes in the X-Subscription-Token header and
// nowhere else: never in a URL, a log line or a message. No language and no country is sent: Brave's codes are a list of its own, and the request's language
// shapes the brief only.
//
// The queries run one after the other, for the free plan allows about one request a second: every request starts at least QUERY_SPACING_MS after the start of
// the one before it, and none starts at or after the end of the search (phaseEndMs). A request has min(timeoutMs, the time left in the search), its answer read
// to the end. A 429 is sent again once, QUERY_SPACING_MS after it came. A query that answers anything but 200 (a 5xx among it, and a second 429), gives no
// answer in its time, answers with what is not a JSON object, or cannot start in time, has failed, and the search goes on with the other; both failing is
// search_failed (502). A 401 or a 403 says that the key was refused, which the other query cannot mend: that is search_failed at once, and no other request is
// sent. No https result at all is search_empty (502). The lines the search logs carry counts and statuses only, never a query, a URL or the key:
// `search: <n> and <m> results, <k> kept`, n of the first query and m of the second, after `search: query <i> failed (<why>)` for a query that failed while
// the other answered, and `search: query <i> answered HTTP 429, sent again after 1100 ms` for a query sent again.
import { AdvocateError } from './errors.ts';

export const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
export const RESULTS_PER_QUERY = 10;
export const MAX_RESULTS = 12;
/** Brave's limits on a query (R-E16): its characters, counted as code points, and its words. */
export const MAX_QUERY_CHARS = 400;
export const MAX_QUERY_WORDS = 50;
/** The least time between the starts of two requests, and the wait before a 429 is sent again (R-E17): the free plan allows about one request a second. */
export const QUERY_SPACING_MS = 1_100;

export interface SearchResult { title: string; url: string; description: string }
export interface SearchOptions {
  fetchImpl: typeof fetch;
  /** BRAVE_SEARCH_API_KEY: sent as the X-Subscription-Token header, and nowhere else. */
  apiKey: string;
  /** The clock the spacing of the requests and the end of the search are read on. */
  clock: () => number;
  /** The most one request takes, its answer read to the end: SEARCH_QUERY_TIMEOUT_MS in a job. */
  timeoutMs: number;
  /** The end of the search on the clock, from the caller: min(its start + SEARCH_MAX_MS, the deadline of the job). No request starts at or after it. */
  phaseEndMs: number;
  /** Aborts when the caller of the job hangs up: the request in flight and any wait are cut, and the search fails with aborted. */
  signal?: AbortSignal;
  log: (line: string) => void;
  /** How the search waits before a request: timerWait by default; a test gives one that returns at once. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The words the second query adds for a side: for and against have theirs, and a position in words is its own. */
function sideWords(side: string): string {
  if (side === 'for') return 'arguments in favour';
  if (side === 'against') return 'arguments against';
  return side;
}

const wordsOf = (text: string): string[] => text.split(/\s+/u).filter((word) => word !== '');
const chars = (s: string): number => [...s].length;
/** A query of these words is within Brave's limits. */
const fits = (words: readonly string[]): boolean => words.length <= MAX_QUERY_WORDS && chars(words.join(' ')) <= MAX_QUERY_CHARS;

/**
 * The two queries of a job (R-E16): the subject alone, and the subject followed by the words of the side. Each is its words joined by one space, within
 * MAX_QUERY_CHARS and MAX_QUERY_WORDS, cut at a word boundary: the second loses the end of the side words first, then the end of the subject.
 */
export function queriesFor(subject: string, side: string): [string, string] {
  const first = wordsOf(subject);
  while (!fits(first)) first.pop();
  const kept = wordsOf(subject);
  const added = wordsOf(sideWords(side));
  while (added.length > 0 && !fits([...kept, ...added])) added.pop();
  while (!fits([...kept, ...added])) kept.pop();
  return [first.join(' '), [...kept, ...added].join(' ')];
}

/** Where two results are one: the scheme, the host (its port with it) and the path, in lower case; the query and the fragment are not part of it. */
const sameAs = (url: URL): string => `${url.protocol}//${url.host}${url.pathname}`.toLowerCase();

/** The results kept, in their order: https only, one for each scheme, host and path (the first that comes), at most MAX_RESULTS. */
export function dedupeResults(results: readonly SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const kept: SearchResult[] = [];
  for (const result of results) {
    if (kept.length === MAX_RESULTS) break;
    let url: URL;
    try {
      url = new URL(result.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || seen.has(sameAs(url))) continue;
    seen.add(sameAs(url));
    kept.push(result);
  }
  return kept;
}

/** The wait of the search by default: a timer that resolves after `ms`, and rejects at once with the reason of `signal` when that aborts. */
export function timerWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type Outcome =
  | { kind: 'results'; results: SearchResult[] } | { kind: 'failed'; why: string } | { kind: 'busy' } | { kind: 'late' } | { kind: 'refused'; status: number }
  | { kind: 'stopped' };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nameOf = (error: unknown): string => (typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '');

/** The URL of a query: the query, ten results, moderate safe search and no decorations in the texts; no language and no country (R-E15). */
function queryUrl(query: string): string {
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(RESULTS_PER_QUERY));
  url.searchParams.set('safesearch', 'moderate');
  url.searchParams.set('text_decorations', 'false');
  return url.toString();
}

/** The web results of an answer: every one with a url that is text, its title and description read as text ('' when they are not). No web results, none. */
function resultsOf(answer: Record<string, unknown>): SearchResult[] {
  const list = isObject(answer.web) ? answer.web.results : undefined;
  if (!Array.isArray(list)) return [];
  const results: SearchResult[] = [];
  for (const item of list) {
    if (!isObject(item) || typeof item.url !== 'string') continue;
    results.push({ title: typeof item.title === 'string' ? item.title : '', url: item.url, description: typeof item.description === 'string' ? item.description : '' });
  }
  return results;
}

/** One request, to its outcome: it never rejects. */
async function request(query: string, opts: SearchOptions, timeoutMs: number): Promise<Outcome> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]);
  try {
    const res = await opts.fetchImpl(queryUrl(query), {
      headers: { 'X-Subscription-Token': opts.apiKey, Accept: 'application/json', 'Accept-Encoding': 'gzip' },
      signal,
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 401 || res.status === 403) return { kind: 'refused', status: res.status };
      return res.status === 429 ? { kind: 'busy' } : { kind: 'failed', why: `HTTP ${res.status}` };
    }
    const body = await res.text();
    let answer: unknown;
    try {
      answer = JSON.parse(body);
    } catch {
      return { kind: 'failed', why: 'an answer that is not JSON' };
    }
    return isObject(answer) ? { kind: 'results', results: resultsOf(answer) } : { kind: 'failed', why: 'an answer that is not a JSON object' };
  } catch (error) {
    if (opts.signal?.aborted === true) return { kind: 'stopped' };
    return { kind: 'failed', why: nameOf(error) === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : 'a network error' };
  }
}

function whyOf(outcome: Outcome): string {
  if (outcome.kind === 'failed') return outcome.why;
  if (outcome.kind === 'busy') return 'HTTP 429';
  if (outcome.kind === 'late') return 'not started: no time left in the search';
  return outcome.kind;
}
const found = (outcome: Outcome): SearchResult[] => (outcome.kind === 'results' ? outcome.results : []);

/** The results of the two queries of a job, deduped (dedupeResults): AdvocateError search_failed, search_empty, or aborted when the caller hangs up. */
export async function searchWeb(queries: readonly [string, string], opts: SearchOptions): Promise<SearchResult[]> {
  const wait = opts.wait ?? timerWait;
  const aborted = (): AdvocateError => new AdvocateError('aborted', 'the caller hung up during the search');
  const hungUp = (): boolean => opts.signal?.aborted === true;
  if (hungUp()) throw aborted();
  let lastStart: number | undefined;
  // A request starts `after` ms from now at the soonest and QUERY_SPACING_MS after the start of the request before it, and never at or after the end of the search.
  const send = async (query: string, after: number): Promise<Outcome> => {
    const gap = Math.max(after, lastStart === undefined ? 0 : lastStart + QUERY_SPACING_MS - opts.clock());
    if (opts.clock() + gap >= opts.phaseEndMs) return { kind: 'late' };
    if (gap > 0) await wait(gap, opts.signal);
    const left = Math.floor(opts.phaseEndMs - opts.clock());
    if (left <= 0) return { kind: 'late' };
    lastStart = opts.clock();
    return request(query, opts, Math.min(opts.timeoutMs, left));
  };
  // A query is one request, and one more after a 429.
  const ask = async (query: string, index: number): Promise<Outcome> => {
    const outcome = await send(query, 0);
    if (outcome.kind !== 'busy') return outcome;
    opts.log(`search: query ${index} answered HTTP 429, sent again after ${QUERY_SPACING_MS} ms`);
    const again = await send(query, QUERY_SPACING_MS);
    return again.kind === 'late' ? outcome : again;
  };
  const outcomes: Outcome[] = [];
  try {
    for (const [i, query] of queries.entries()) {
      const outcome = await ask(query, i + 1);
      if (outcome.kind === 'stopped' || hungUp()) throw aborted();
      if (outcome.kind === 'refused') {
        opts.log(`search: the key was refused (HTTP ${outcome.status})`);
        throw new AdvocateError('search_failed', `the Brave Search API refused the key (HTTP ${outcome.status})`);
      }
      outcomes.push(outcome);
    }
  } catch (error) {
    // A wait cut by the caller's hang-up rejects with the reason of its signal: that too is the caller hanging up.
    if (hungUp()) throw aborted();
    throw error;
  }
  const [first, second] = outcomes;
  if (first.kind !== 'results' && second.kind !== 'results') {
    throw new AdvocateError('search_failed', `both Brave queries failed: query 1 ${whyOf(first)}, query 2 ${whyOf(second)}`);
  }
  outcomes.forEach((outcome, i) => { if (outcome.kind !== 'results') opts.log(`search: query ${i + 1} failed (${whyOf(outcome)})`); });
  const kept = dedupeResults([...found(second), ...found(first)]);
  opts.log(`search: ${found(first).length} and ${found(second).length} results, ${kept.length} kept`);
  if (kept.length === 0) throw new AdvocateError('search_empty', `the two Brave queries gave no https result (${found(first).length} and ${found(second).length} results)`);
  return kept;
}
