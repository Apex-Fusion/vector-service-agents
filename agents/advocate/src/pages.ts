// agents/advocate/src/pages.ts
// The pages of a job (ruling R-E4): each search result fetched by the service itself through safeFetch (https only, no redirect followed, private and reserved
// addresses refused, at most 1 MB, one time limit with the host lookup inside it), FETCH_CONCURRENCY at a time, under one deadline. A page is kept when it
// answers 200 with a content type of text/html, application/xhtml+xml or text/plain and its text (src/html.ts) has at least MIN_PAGE_CHARS characters; its
// excerpt is the first EXCERPT_CHARS characters of that text. The kept pages are numbered 1 to k in the order of the results, which is the order the model
// cites them by, and each carries the title of its search result and the time it was fetched. Any other page is dropped without a word to the hirer, and
// counted by why: a redirect, a status that is not 200, a type that is not one of the three, too little text, or a failure (a refusal of safeFetch, a body
// over 1 MB, no answer within its time, a fetch still in flight at the deadline or never started before it). No page kept is no_sources (502).
//
// After the deadline no fetch starts, and a fetch still in flight is no longer waited for: each is raced against the deadline, and cut by it. Each fetch also
// has min(PAGE_TIMEOUT_MS, the time left to the deadline) of its own. The line the phase logs carries counts only, never a URL:
// `pages: <k> kept of <m> (redirect <a>, status <b>, type <c>, thin <d>, failed <e>)`.
import { safeFetch } from '@vsa/vector-read';
import type { SafeFetchOpts } from '@vsa/vector-read';
import { FETCH_CONCURRENCY, PAGE_TIMEOUT_MS } from './budget.ts';
import { AdvocateError } from './errors.ts';
import { EXCERPT_CHARS, MIN_PAGE_CHARS, collapseWhitespace, extractText } from './html.ts';
import type { SearchResult } from './search.ts';

/** The content types a page is kept with, by the media type of its Content-Type (before any parameter, in any case). */
export const ACCEPTED_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'] as const;
/** The most bytes a page may have: 1 MB. */
export const PAGE_MAX_BYTES = 1_048_576;
export const USER_AGENT = 'vector-service-agents/advocate (+https://github.com/Apex-Fusion/vector-service-agents)';
const ACCEPT = 'text/html, text/plain;q=0.9, */*;q=0.1';
// The most a timer waits: setTimeout fires at once for a longer delay.
const MAX_TIMER_MS = 2_147_483_647;

export interface Page { n: number; title: string; url: string; retrieved_at: string; excerpt: string }
export interface FetchPagesOptions {
  fetchImpl: typeof fetch;
  clock: () => number;
  /** The end of the phase on the clock: fetchDeadlineMs (src/budget.ts) in a job. */
  deadlineMs: number;
  /** Aborts when the caller of the job hangs up: the fetches are cut, and the phase fails with aborted. */
  signal?: AbortSignal;
  log: (line: string) => void;
  /** How many fetches run at a time: FETCH_CONCURRENCY by default. */
  concurrency?: number;
  /** How safeFetch looks a host up: the system's lookup by default; a test gives one that answers a public address, so that no test touches DNS. */
  lookup?: SafeFetchOpts['lookup'];
}

type Why = 'redirect' | 'status' | 'type' | 'thin' | 'failed';
type Outcome = { kind: 'kept'; page: Omit<Page, 'n'> } | { kind: 'dropped'; why: Why };

/** The first `n` characters of a text, as code points: never half of a surrogate pair. */
function firstChars(text: string, n: number): string {
  let at = 0;
  for (let count = 0; count < n && at < text.length; count += 1) at += (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
  return text.slice(0, at);
}
const chars = (s: string): number => [...s].length;
/** The media type of a Content-Type header: before its parameters, trimmed, in lower case. */
const mediaType = (header: string | null): string => (header ?? '').split(';')[0].trim().toLowerCase();

/** One page, to its outcome: a failure of the page, its host or the network is an outcome, not a rejection. */
async function fetchOne(result: SearchResult, opts: FetchPagesOptions, signal: AbortSignal, timeoutMs: number): Promise<Outcome> {
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(result.url, { headers: { 'user-agent': USER_AGENT, accept: ACCEPT }, signal }, {
      maxResponseBytes: PAGE_MAX_BYTES, timeoutMs, lookup: opts.lookup, fetchImpl: opts.fetchImpl,
    });
  } catch (error) {
    // safeFetch refuses a redirect with this sentence, and every other refusal, a timeout and a network error with others.
    return { kind: 'dropped', why: error instanceof Error && error.message.startsWith('safeFetch: redirect to ') ? 'redirect' : 'failed' };
  }
  if (res.status !== 200) return { kind: 'dropped', why: 'status' };
  const type = mediaType(res.headers.get('content-type'));
  if (!(ACCEPTED_TYPES as readonly string[]).includes(type)) return { kind: 'dropped', why: 'type' };
  const excerpt = firstChars(type === 'text/plain' ? collapseWhitespace(res.text) : extractText(res.text), EXCERPT_CHARS);
  if (chars(excerpt) < MIN_PAGE_CHARS) return { kind: 'dropped', why: 'thin' };
  return { kind: 'kept', page: { title: result.title, url: result.url, retrieved_at: new Date(opts.clock()).toISOString(), excerpt } };
}

/** The pages of the results, numbered 1 to k in their order: AdvocateError no_sources when none is kept, aborted when the caller hangs up. */
export async function fetchPages(results: readonly SearchResult[], opts: FetchPagesOptions): Promise<Page[]> {
  const concurrency = opts.concurrency ?? FETCH_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError(`concurrency must be a whole number of 1 or more, got ${concurrency}`);
  const aborted = (): AdvocateError => new AdvocateError('aborted', 'the caller hung up while the pages were fetched');
  const hungUp = (): boolean => opts.signal?.aborted === true;
  if (hungUp()) throw aborted();
  // Until its fetch answers, a result counts as failed: one cut at the deadline, and one never started, failed for want of time.
  const outcomes: Outcome[] = results.map(() => ({ kind: 'dropped', why: 'failed' }));
  // The end of the phase, at the deadline or when the caller hangs up: it cuts the fetches in flight, and no fetch starts after it.
  const stop = new AbortController();
  let ended = false;
  let resolveEnd: (value: null) => void = () => undefined;
  const end = new Promise<null>((resolve) => { resolveEnd = resolve; });
  const endPhase = (): void => { ended = true; stop.abort(); resolveEnd(null); };
  // The timer is not unref'd: it is what ends the phase, so it holds the process open until the phase is over (it is cleared on every path, below).
  const timer = setTimeout(endPhase, Math.min(MAX_TIMER_MS, Math.max(0, opts.deadlineMs - opts.clock())));
  opts.signal?.addEventListener('abort', endPhase, { once: true });
  const signal = opts.signal === undefined ? stop.signal : AbortSignal.any([stop.signal, opts.signal]);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!ended && next < results.length) {
      const left = Math.floor(opts.deadlineMs - opts.clock());
      if (left <= 0) return;
      const index = next;
      next += 1;
      const outcome = await Promise.race([fetchOne(results[index], opts, signal, Math.min(PAGE_TIMEOUT_MS, left)), end]);
      if (outcome !== null) outcomes[index] = outcome;
    }
  };
  try {
    await Promise.race([Promise.all(Array.from({ length: Math.min(concurrency, results.length) }, worker)), end]);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', endPhase);
    stop.abort();
  }
  if (hungUp()) throw aborted();
  const counts: Record<Why, number> = { redirect: 0, status: 0, type: 0, thin: 0, failed: 0 };
  const pages: Page[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === 'kept') pages.push({ n: pages.length + 1, ...outcome.page });
    else counts[outcome.why] += 1;
  }
  const why = `redirect ${counts.redirect}, status ${counts.status}, type ${counts.type}, thin ${counts.thin}, failed ${counts.failed}`;
  opts.log(`pages: ${pages.length} kept of ${results.length} (${why})`);
  if (pages.length === 0) throw new AdvocateError('no_sources', `no page was kept of ${results.length} (${why})`);
  return pages;
}
