// agents/advocate/test/run.test.ts
// One job end to end, through the fake fetch of test/fake-fetch.ts with its public host lookup and a wait that returns at once, so that no test touches the
// network or DNS or waits for the spacing of the queries, and a clock the test moves: the golden brief and its counts; what each phase is given of the
// deadline (Review Focus 5), read from spies on the three modules that make the calls, with a clock that jumps while the pages are fetched; the deadline
// answered before a phase that could not end in time, with nothing called after it; a call of the model that runs out of its time (ruling R-E19); the
// failures of the search and of the pages passed on as they are; a caller that hangs up before the job, during the search, during the pages and during the
// call of the model; and the log lines of a job, which carry counts and statuses only.
import { beforeEach, describe, test, expect, vi } from 'vitest';
import { FETCH_CONCURRENCY, JOB_DEADLINE_MS, modelBudgetMs } from '../src/budget.ts';
import { AdvocateError } from '../src/errors.ts';
import { DEFAULT_MODEL } from '../src/model.ts';
import { messagesFor } from '../src/prompt.ts';
import { parseRequest } from '../src/request.ts';
import { runAdvocate } from '../src/run.ts';
import type { RunDeps } from '../src/run.ts';
import { GOLDEN_QUERIES, PAGE_ROUTES, at, fixture, never, publicLookup, reply, routedFetch } from './fake-fetch.ts';
import type { Route } from './fake-fetch.ts';
import {
  GOLDEN_OUTCOME, GOLDEN_PAGES, GOLDEN_REQUEST, GOLDEN_RESULT, GOLDEN_T0, RESULT_URLS, TEST_BRAVE_KEY, TEST_OPENROUTER_KEY, braveAnswer, braveAnswers, goldenAnswer,
  goldenFetch, modelRoute, noWait, recorded,
} from './golden.ts';

// What the run gives each of its three calls, recorded on the way to the real one.
const spy = vi.hoisted(() => ({
  search: [] as Array<{ timeoutMs: number; phaseEndMs: number; wait: unknown }>,
  pages: [] as Array<{ deadlineMs: number; lookup: unknown }>,
  model: [] as Array<{ timeoutMs: number; maxTokens: number; model: string }>,
}));
vi.mock('../src/search.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/search.ts')>();
  return {
    ...real,
    searchWeb: (...args: Parameters<typeof real.searchWeb>) => {
      const { timeoutMs, phaseEndMs, wait } = args[1];
      spy.search.push({ timeoutMs, phaseEndMs, wait });
      return real.searchWeb(...args);
    },
  };
});
vi.mock('../src/pages.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/pages.ts')>();
  return {
    ...real,
    fetchPages: (...args: Parameters<typeof real.fetchPages>) => {
      const { deadlineMs, lookup } = args[1];
      spy.pages.push({ deadlineMs, lookup });
      return real.fetchPages(...args);
    },
  };
});
vi.mock('../src/model.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/model.ts')>();
  return {
    ...real,
    callModel: (...args: Parameters<typeof real.callModel>) => {
      const { timeoutMs, maxTokens, model } = args[1];
      spy.model.push({ timeoutMs, maxTokens, model });
      return real.callModel(...args);
    },
  };
});
beforeEach(() => { spy.search.length = 0; spy.pages.length = 0; spy.model.length = 0; });

const request = (over: Record<string, unknown> = {}) => parseRequest(JSON.stringify({ ...GOLDEN_REQUEST, ...over }));
const deps = (over: Partial<RunDeps> = {}): RunDeps => ({
  fetchImpl: goldenFetch().fetchImpl, clock: () => GOLDEN_T0, braveApiKey: TEST_BRAVE_KEY, openRouterApiKey: TEST_OPENROUTER_KEY, model: DEFAULT_MODEL,
  deadlineMs: GOLDEN_T0 + JOB_DEADLINE_MS, log: () => undefined, lookup: publicLookup, wait: noWait, ...over,
});
async function failureOf(work: Promise<unknown>): Promise<AdvocateError> {
  try { await work; } catch (e) { if (e instanceof AdvocateError) return e; throw e; }
  throw new Error('it did not fail');
}
const PAGE_1 = 'https://example.org/car-free-centres';
/** A search that finds these URLs, for both queries. */
const found = (urls: string[]): Route[] => braveAnswers(() => braveAnswer(urls.map((url) => ({ title: 'Car-free centres: what the evidence says', url, description: 'd' }))));
/** The rejection fetch gives at the end of AbortSignal.timeout, at once, so that no test waits the time of the call. */
const timedOut = (): Promise<Response> => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

/**
 * The fetch of a job whose search finds two pages: the first page of the golden job, answered at once, and a slow page that answers 404 after 20 ms of real
 * time and moves the clock of the job to `to` as it answers: the time the pages took, as the clock sees it. `models` gets the clock at each call of the model,
 * which `model` answers (the golden answer by default).
 */
function slowPages(now: { t: number }, to: number, model: Route['respond'] = goldenAnswer): { fetchImpl: typeof fetch; models: number[] } {
  const models: number[] = [];
  const fetchImpl = routedFetch([
    ...found([PAGE_1, 'https://example.org/slow']),
    ...PAGE_ROUTES,
    { match: at('https://example.org/slow'), respond: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); now.t = to; return reply(404, 'not found'); } },
    modelRoute((url, init) => { models.push(now.t); return model(url, init); }),
  ]);
  return { fetchImpl, models };
}

describe('the golden job', () => {
  test('the brief, every value of it, and the counts of the job; the model is given the three pages kept, numbered in the order of the results', async () => {
    const { fetchImpl, seen } = goldenFetch();
    const outcome = await runAdvocate(request(), deps({ fetchImpl }));
    expect(outcome).toStrictEqual(GOLDEN_OUTCOME);
    // The runtime hashes JSON.stringify(result) into the receipt, so the body is held character for character, the order of every key with it.
    expect(JSON.stringify(outcome.result)).toBe(JSON.stringify(GOLDEN_RESULT));
    expect([...seen.queries].sort()).toStrictEqual([...GOLDEN_QUERIES].sort());
    expect(seen.braveKeys).toStrictEqual([TEST_BRAVE_KEY, TEST_BRAVE_KEY]);
    expect([...seen.pages].sort()).toStrictEqual([...RESULT_URLS].sort());
    expect(seen.models).toHaveLength(1);
    expect(seen.models[0].headers.get('authorization')).toBe(`Bearer ${TEST_OPENROUTER_KEY}`);
    expect(seen.models[0].body).toStrictEqual({ model: DEFAULT_MODEL, messages: messagesFor(request(), GOLDEN_PAGES), temperature: 0, max_tokens: 2000, response_format: { type: 'json_object' } });
  });

  test('each phase is given its part of the time: the search a phase of 15 s with 10 s a query, the pages until 45 s after the search, the model 90 s and the token limit of the length', async () => {
    await runAdvocate(request(), deps());
    expect(spy).toStrictEqual({
      search: [{ timeoutMs: 10_000, phaseEndMs: GOLDEN_T0 + 15_000, wait: noWait }],
      pages: [{ deadlineMs: GOLDEN_T0 + 45_000, lookup: publicLookup }],
      model: [{ timeoutMs: 90_000, maxTokens: 2000, model: DEFAULT_MODEL }],
    });
    await runAdvocate(request({ length: 'standard' }), deps({ model: 'openai/gpt-4o-mini' }));
    expect(spy.model.at(-1)).toStrictEqual({ timeoutMs: 90_000, maxTokens: 4500, model: 'openai/gpt-4o-mini' });
  });

  test('the brief names the model the job called, and the search is given the side of the request', async () => {
    const { fetchImpl, seen } = goldenFetch();
    const outcome = await runAdvocate(request(), deps({ fetchImpl, model: 'openai/gpt-4o-mini' }));
    expect([outcome.result.model, seen.models.map((m) => (m.body as { model: string }).model)]).toStrictEqual(['openai/gpt-4o-mini via OpenRouter', ['openai/gpt-4o-mini']]);
    // A job against: every query is answered, whatever it asks, so that the test reads the two queries the search was given.
    const anyQuery: Route = { match: (url) => url.searchParams.has('q'), respond: () => braveAnswer([{ title: 'T', url: PAGE_1, description: 'd' }]) };
    const against = routedFetch([anyQuery, ...PAGE_ROUTES, modelRoute(() => goldenAnswer())]);
    await runAdvocate(request({ side: 'against' }), deps({ fetchImpl: against }));
    expect(against.calls.slice(0, 2).map((call) => new URL(call.url).searchParams.get('q'))).toStrictEqual([GOLDEN_QUERIES[0], `${GOLDEN_QUERIES[0]} arguments against`]);
  });

  test('the log lines of a job carry counts and statuses only: no subject, no side, no URL, no quote and no key', async () => {
    const lines: string[] = [];
    await runAdvocate(request(), deps({ log: (line) => lines.push(line) }));
    const refused = routedFetch(braveAnswers(() => reply(401, `{"message":"the token ${TEST_BRAVE_KEY} is not valid"}`)));
    await failureOf(runAdvocate(request(), deps({ fetchImpl: refused, log: (line) => lines.push(line) })));
    expect(lines).toContain('search: the key was refused (HTTP 401)');
    const text = lines.join('\n');
    for (const word of ['Should a city', 'arguments in favour', 'example.', 'footfall', 'bicycles', TEST_BRAVE_KEY.slice(-16), TEST_OPENROUTER_KEY.slice(-16)]) expect(text, word).not.toContain(word);
  });
});

describe('the time of a job (Review Focus 5)', () => {
  test('pages that take the clock to 59 s: the model gets the time left less 5 s, 86 s, so that its call ends 5 s before the deadline', async () => {
    const now = { t: GOLDEN_T0 };
    const { fetchImpl, models } = slowPages(now, GOLDEN_T0 + 59_000);
    const outcome = await runAdvocate(request(), deps({ fetchImpl, clock: () => now.t }));
    expect(spy.pages).toStrictEqual([{ deadlineMs: GOLDEN_T0 + 45_000, lookup: publicLookup }]);
    expect(spy.model).toStrictEqual([{ timeoutMs: 86_000, maxTokens: 2000, model: DEFAULT_MODEL }]);
    expect(59_000 + 86_000 + 5_000).toBe(JOB_DEADLINE_MS);
    expect([models, outcome.pagesKept, outcome.resultsFound]).toStrictEqual([[GOLDEN_T0 + 59_000], 1, 2]);
  });

  test('the model is not started with under 15 s: 19 s left is deadline (422) and the model is never called; 20 s left starts it with 15 s', async () => {
    expect([modelBudgetMs(20_000), modelBudgetMs(19_999)]).toStrictEqual([15_000, null]);
    const late = { t: GOLDEN_T0 };
    const refused = slowPages(late, GOLDEN_T0 + 131_000);
    const e = await failureOf(runAdvocate(request(), deps({ fetchImpl: refused.fetchImpl, clock: () => late.t })));
    expect([e.code, e.status, e.detail]).toStrictEqual(['deadline', 422, 'the job had 19000 ms of its time left for the model, too little to start it']);
    expect([spy.model, refused.models]).toStrictEqual([[], []]);
    const edge = { t: GOLDEN_T0 };
    const started = slowPages(edge, GOLDEN_T0 + 130_000);
    await runAdvocate(request(), deps({ fetchImpl: started.fetchImpl, clock: () => edge.t }));
    expect([spy.model, started.models]).toStrictEqual([[{ timeoutMs: 15_000, maxTokens: 2000, model: DEFAULT_MODEL }], [GOLDEN_T0 + 130_000]]);
  });

  test('a call of the model that runs out of its time: deadline (422) when the deadline had cut it to 86 s, model_failed (502) when it had the full 90 s (R-E19)', async () => {
    const now = { t: GOLDEN_T0 };
    const cut = slowPages(now, GOLDEN_T0 + 59_000, timedOut);
    const e = await failureOf(runAdvocate(request(), deps({ fetchImpl: cut.fetchImpl, clock: () => now.t })));
    expect([e.code, e.status, e.detail]).toStrictEqual(['deadline', 422, 'the model did not answer within the 86000 ms the deadline of the job left it']);
    const full = await failureOf(runAdvocate(request(), deps({ fetchImpl: goldenFetch(timedOut).fetchImpl })));
    expect([full.code, full.status, full.detail]).toStrictEqual(['model_failed', 502, 'OpenRouter did not answer within 90000 ms']);
    expect(spy.model.map((m) => m.timeoutMs)).toStrictEqual([86_000, 90_000]);
  });

  test('a clock with a fraction of a millisecond: the model is given whole milliseconds', async () => {
    const now = { t: GOLDEN_T0 };
    const outcome = await runAdvocate(request(), deps({ fetchImpl: slowPages(now, GOLDEN_T0 + 59_000.5).fetchImpl, clock: () => now.t }));
    expect([spy.model, outcome.pagesKept]).toStrictEqual([[{ timeoutMs: 85_999, maxTokens: 2000, model: DEFAULT_MODEL }], 1]);
  });

  test('20 s or less left after the search is deadline before any page is fetched (R-E20); the search then has the time left, under 10 s a query', async () => {
    const { fetchImpl, seen } = goldenFetch();
    const e = await failureOf(runAdvocate(request(), deps({ fetchImpl, deadlineMs: GOLDEN_T0 + 8_000 })));
    expect([e.code, e.status, e.detail]).toStrictEqual(['deadline', 422, 'the job had 8000 ms of its time left after the search, too little to fetch a page and still start the model']);
    expect(spy.search).toStrictEqual([{ timeoutMs: 8_000, phaseEndMs: GOLDEN_T0 + 8_000, wait: noWait }]);
    expect([spy.pages, seen.pages, spy.model, seen.models]).toStrictEqual([[], [], [], []]);
    const edge = await failureOf(runAdvocate(request(), deps({ deadlineMs: GOLDEN_T0 + 20_000 })));
    expect([edge.code, spy.search.at(-1), spy.pages]).toStrictEqual(['deadline', { timeoutMs: 10_000, phaseEndMs: GOLDEN_T0 + 15_000, wait: noWait }, []]);
  });

  test('the pages are timed from the end of the search: 45 s after a search of 5 s, and 20 s left after it in a job of 25 s is deadline', async () => {
    const slowSearch = (now: { t: number }): typeof fetch => routedFetch([
      ...braveAnswers(() => { now.t = GOLDEN_T0 + 5_000; return braveAnswer(RESULT_URLS.map((url) => ({ title: 'Car-free centres: what the evidence says', url, description: 'd' }))); }),
      ...PAGE_ROUTES, modelRoute(() => goldenAnswer()),
    ]);
    const full = { t: GOLDEN_T0 };
    await runAdvocate(request(), deps({ fetchImpl: slowSearch(full), clock: () => full.t }));
    expect(spy.pages).toStrictEqual([{ deadlineMs: GOLDEN_T0 + 50_000, lookup: publicLookup }]);
    const short = { t: GOLDEN_T0 };
    const e = await failureOf(runAdvocate(request(), deps({ fetchImpl: slowSearch(short), clock: () => short.t, deadlineMs: GOLDEN_T0 + 25_000 })));
    expect([e.code, e.detail]).toStrictEqual(['deadline', 'the job had 20000 ms of its time left after the search, too little to fetch a page and still start the model']);
  });

  test('a job whose deadline has passed before it begins is deadline, and nothing is called', async () => {
    const { fetchImpl, seen } = goldenFetch();
    const e = await failureOf(runAdvocate(request(), deps({ fetchImpl, deadlineMs: GOLDEN_T0 })));
    expect([e.code, e.status, e.detail]).toStrictEqual(['deadline', 422, 'the deadline of the job had passed before it began']);
    expect([spy.search, seen.queries, seen.pages, seen.models]).toStrictEqual([[], [], [], []]);
  });
});

describe('the failures of the search and of the pages, passed on as they are', () => {
  test('both queries failing is search_failed, no result at all is search_empty, and no page that can be used is no_sources; the model is never called', async () => {
    const unusable = ['https://example.org/moved', 'https://example.org/report.pdf', 'https://example.org/gone', 'https://example.org/thin'];
    const cases: Array<[string, Route[], string]> = [
      ['both queries answer 503', braveAnswers(() => reply(503, 'unavailable')), 'search_failed'],
      ['the search finds nothing', braveAnswers(() => braveAnswer([])), 'search_empty'],
      ['no result page can be used', [...found(unusable), ...PAGE_ROUTES], 'no_sources'],
    ];
    for (const [label, routes, code] of cases) {
      let models = 0;
      const fetchImpl = routedFetch([...routes, modelRoute(() => { models += 1; return goldenAnswer(); })]);
      const e = await failureOf(runAdvocate(request(), deps({ fetchImpl })));
      expect([e.code, e.status, models], label).toStrictEqual([code, 502, 0]);
    }
  });

  test('a model answer in which no quote survives is no_supported_claims (502)', async () => {
    const madeUp = JSON.stringify({ thesis: 'T.', arguments: [{ claim: 'C.', support: 'S.', sources: [{ n: 1, quote: 'a sentence that no page of the job holds' }] }] });
    const { fetchImpl } = goldenFetch(() => reply(200, JSON.stringify({ choices: [{ message: { content: madeUp } }] }), { 'content-type': 'application/json' }));
    const e = await failureOf(runAdvocate(request(), deps({ fetchImpl })));
    expect([e.code, e.status]).toStrictEqual(['no_supported_claims', 502]);
  });
});

describe('a caller that hangs up', () => {
  test('before the job begins: aborted (499), and nothing is called', async () => {
    const caller = new AbortController();
    caller.abort();
    const { fetchImpl, seen } = goldenFetch();
    const e = await failureOf(runAdvocate(request(), deps({ fetchImpl, signal: caller.signal })));
    expect([e.code, e.status, e.detail]).toStrictEqual(['aborted', 499, 'the caller hung up, and the job was stopped']);
    expect([seen.queries, seen.pages, seen.models]).toStrictEqual([[], [], []]);
  });

  test('while the search answers: aborted, no page is fetched and the model is not called', async () => {
    const caller = new AbortController();
    const pages: string[] = [];
    let models = 0;
    const fetchImpl = routedFetch([
      ...braveAnswers(() => { caller.abort(); return braveAnswer([{ title: 'T', url: PAGE_1, description: 'd' }]); }),
      ...recorded(PAGE_ROUTES, pages),
      modelRoute(() => { models += 1; return goldenAnswer(); }),
    ]);
    const e = await failureOf(runAdvocate(request(), deps({ fetchImpl, signal: caller.signal })));
    expect([e.code, e.status, pages, models, spy.pages]).toStrictEqual(['aborted', 499, [], 0, []]);
  });

  test('a hang-up while the first query answers: the second is never sent, and the job is stopped with the words of the job', async () => {
    const caller = new AbortController();
    const queries: string[] = [];
    const fetchImpl = routedFetch([
      ...recorded(braveAnswers(() => { caller.abort(); return braveAnswer([{ title: 'T', url: PAGE_1, description: 'd' }]); }), queries),
      ...PAGE_ROUTES, modelRoute(() => goldenAnswer()),
    ]);
    const e = await failureOf(runAdvocate(request(), deps({ fetchImpl, signal: caller.signal })));
    expect([e.code, e.detail, queries.length]).toStrictEqual(['aborted', 'the caller hung up, and the job was stopped', 1]);
  });

  test('while the pages are fetched: aborted, and the model is not called', async () => {
    const caller = new AbortController();
    let models = 0;
    const fetchImpl = routedFetch([
      ...found(RESULT_URLS),
      { match: at(PAGE_1), respond: () => { caller.abort(); return reply(200, fixture('page-1.html'), { 'content-type': 'text/html' }); } },
      ...PAGE_ROUTES,
      modelRoute(() => { models += 1; return goldenAnswer(); }),
    ]);
    const e = await failureOf(runAdvocate(request(), deps({ fetchImpl, signal: caller.signal })));
    expect([e.code, e.status, models, spy.model]).toStrictEqual(['aborted', 499, 0, []]);
  });

  test('a hang-up while the pages are fetched: no page fetch starts after it', async () => {
    const caller = new AbortController();
    const pages: string[] = [];
    const fetchImpl = routedFetch([
      ...found(RESULT_URLS),
      ...recorded([{ match: at(PAGE_1), respond: () => { caller.abort(); return reply(200, fixture('page-1.html'), { 'content-type': 'text/html' }); } }, ...PAGE_ROUTES], pages),
      modelRoute(() => goldenAnswer()),
    ]);
    const e = await failureOf(runAdvocate(request(), deps({ fetchImpl, signal: caller.signal })));
    expect(e.code).toBe('aborted');
    expect(pages.length).toBeLessThanOrEqual(FETCH_CONCURRENCY);
  });

  test('while the model writes: its call is cut, and the job is aborted', async () => {
    const caller = new AbortController();
    const { fetchImpl, seen } = goldenFetch((url, init) => { const waiting = never(url, init); caller.abort(); return waiting; });
    const e = await failureOf(runAdvocate(request(), deps({ fetchImpl, signal: caller.signal })));
    expect([e.code, e.status, seen.models.length]).toStrictEqual(['aborted', 499, 1]);
  });

  test('a hang-up as the model answers: the answer is read, and the job is stopped all the same', async () => {
    const caller = new AbortController();
    const { fetchImpl } = goldenFetch(() => { caller.abort(); return goldenAnswer(); });
    const e = await failureOf(runAdvocate(request(), deps({ fetchImpl, signal: caller.signal })));
    expect([e.code, e.status]).toStrictEqual(['aborted', 499]);
  });

  test('an AbortError on the way is aborted, even when the caller is still there', async () => {
    const abortError = async (): Promise<void> => { throw new DOMException('This operation was aborted', 'AbortError'); };
    const e = await failureOf(runAdvocate(request(), deps({ wait: abortError })));
    expect([e.code, e.status]).toStrictEqual(['aborted', 499]);
  });
});
