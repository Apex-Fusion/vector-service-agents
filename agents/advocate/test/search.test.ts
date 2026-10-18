// agents/advocate/test/search.test.ts
// The search (rulings R-E3 and R-E15 to R-E17) against a fake Brave and a fake time: the two queries, cut to Brave's limits and sent one after the other with
// their parameters, the key in its header and nowhere else; the spacing of the requests, the second sending of a 429 and the end of the search; the two golden
// answers deduped; and the failures: one query failing while the other answers, both failing, a refused key, a query with no answer in its time, the caller
// hanging up. Characters outside ASCII are written as escapes.
import { describe, expect, test } from 'vitest';
import { operatorsText } from '@vsa/service-kit';
import { SEARCH_MAX_MS } from '../src/budget.ts';
import { AdvocateError } from '../src/errors.ts';
import {
  BRAVE_ENDPOINT, MAX_QUERY_CHARS, MAX_QUERY_WORDS, MAX_RESULTS, QUERY_SPACING_MS, RESULTS_PER_QUERY, dedupeResults, queriesFor, searchWeb, timerWait,
} from '../src/search.ts';
import type { SearchOptions, SearchResult } from '../src/search.ts';
import { BRAVE_ROUTES, GOLDEN_QUERIES, GOLDEN_RESULTS, GOLDEN_SUBJECT, braveQuery, fixture, never, reply, routedFetch } from './fake-fetch.ts';
import type { Route } from './fake-fetch.ts';

const KEY = 'brave-test-key-not-a-real-one';
const [Q1, Q2] = GOLDEN_QUERIES;
const T0 = 1_760_000_000_000;
/** The time of a test: the clock stands still but for the waits, which return at once and move it on by what they were asked. */
function fakeTime() {
  let now = T0;
  const waits: number[] = [];
  return { clock: () => now, advance: (ms: number) => { now += ms; }, waits, wait: async (ms: number) => { waits.push(ms); now += ms; } };
}
function setup(routes: readonly Route[], over: Partial<SearchOptions> = {}, time = fakeTime()) {
  const fetchImpl = routedFetch(routes);
  const lines: string[] = [];
  const opts: SearchOptions = {
    fetchImpl, apiKey: KEY, clock: time.clock, timeoutMs: 10_000, phaseEndMs: T0 + SEARCH_MAX_MS, log: (line) => { lines.push(line); }, wait: time.wait, ...over,
  };
  return { fetchImpl, lines, opts, time };
}
async function failure(p: Promise<unknown>): Promise<AdvocateError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AdvocateError); return e as AdvocateError; }
  throw new Error('the search did not fail');
}
const answer = (status: number, body: unknown) => (): Response => reply(status, typeof body === 'string' ? body : JSON.stringify(body), { 'content-type': 'application/json' });
const json = { 'content-type': 'application/json' };
const q1 = (respond: Route['respond']): Route => ({ match: braveQuery(Q1), respond });
const q2 = (respond: Route['respond']): Route => ({ match: braveQuery(Q2), respond });
const urls = (results: readonly SearchResult[]): string[] => results.map((r) => r.url);
const sent = (calls: ReadonlyArray<{ url: string }>): Array<string | null> => calls.map((call) => new URL(call.url).searchParams.get('q'));
const FIRST_ONLY = ['https://EXAMPLE.org/car-free-centres#section', 'https://example.com/freight.txt', 'https://example.org/gone', 'https://example.org/thin'];
const SECOND_ONLY = ['https://example.org/car-free-centres', 'https://example.org/moved', 'https://example.net/clean-air', 'https://example.org/report.pdf'];

describe('queriesFor (R-E16)', () => {
  test('the subject alone, then the subject and the words of the side', () => {
    expect(queriesFor(GOLDEN_SUBJECT, 'for')).toStrictEqual([GOLDEN_SUBJECT, `${GOLDEN_SUBJECT} arguments in favour`]);
    expect(queriesFor(GOLDEN_SUBJECT, 'against')).toStrictEqual([GOLDEN_SUBJECT, `${GOLDEN_SUBJECT} arguments against`]);
    expect(queriesFor(GOLDEN_SUBJECT, 'for a ban on weekends only')).toStrictEqual([GOLDEN_SUBJECT, `${GOLDEN_SUBJECT} for a ban on weekends only`]);
    expect(queriesFor(GOLDEN_SUBJECT, 'for')).toStrictEqual(GOLDEN_QUERIES);
  });

  test('a subject of 300 characters with a side of 120: the second query loses the end of the side, word by word, to 400 characters at most', () => {
    expect([MAX_QUERY_CHARS, MAX_QUERY_WORDS]).toStrictEqual([400, 50]);
    const word = (letter: string, i: number, width: number): string => `${letter}${i}`.padEnd(width, letter);
    const subject = Array.from({ length: 7 }, (_v, i) => word('s', i, 42)).join(' ');
    const side = Array.from({ length: 11 }, (_v, i) => word('t', i, 10)).join(' ');
    expect([subject.length, side.length]).toStrictEqual([300, 120]);
    const [first, second] = queriesFor(subject, side);
    expect(first).toBe(subject);
    expect(second).toBe(`${subject} ${side.split(' ').slice(0, 9).join(' ')}`);
    expect(second.length).toBe(399);
  });

  test('a subject of 60 one-letter words: both queries are its first 50 words, the second losing all the words of the side first', () => {
    const letters = Array.from({ length: 60 }, (_v, i) => String.fromCharCode(97 + (i % 26)));
    const [first, second] = queriesFor(letters.join(' '), 'for');
    expect(first).toBe(letters.slice(0, 50).join(' '));
    expect(second).toBe(first);
  });

  test('the word limit cuts the side first: a subject of 48 words keeps two of the words of "arguments in favour"', () => {
    const subject = Array.from({ length: 48 }, (_v, i) => `w${i}`).join(' ');
    expect(queriesFor(subject, 'for')).toStrictEqual([subject, `${subject} arguments in`]);
  });

  test('a word is never cut: a side of one word that does not fit is left out whole; the words of a query are joined by one space', () => {
    const subject = 'y'.repeat(300);
    expect(queriesFor(subject, 'x'.repeat(120))).toStrictEqual([subject, subject]);
    expect(queriesFor('  Should   a city\nban cars?\t', 'against')).toStrictEqual(['Should a city ban cars?', 'Should a city ban cars? arguments against']);
  });

  test('a character is a code point: 300 of two UTF-16 units each and a word of 99 make a query of 400', () => {
    const subject = '\u{1F600}'.repeat(300);
    expect(queriesFor(subject, 'z'.repeat(99))).toStrictEqual([subject, `${subject} ${'z'.repeat(99)}`]);
    expect(queriesFor(subject, 'z'.repeat(100))).toStrictEqual([subject, subject]);
  });
});

describe('the requests (R-E15, R-E17)', () => {
  test('one after the other, with ten results, moderate safe search and no decorations; no language and no country; the key in its header and in no URL', async () => {
    expect([BRAVE_ENDPOINT, RESULTS_PER_QUERY]).toStrictEqual(['https://api.search.brave.com/res/v1/web/search', 10]);
    const { fetchImpl, opts } = setup(BRAVE_ROUTES);
    await searchWeb(GOLDEN_QUERIES, opts);
    expect(fetchImpl.calls.map((call) => call.url)).toStrictEqual([
      `${BRAVE_ENDPOINT}?q=Should+a+city+ban+cars+from+its+centre%3F&count=10&safesearch=moderate&text_decorations=false`,
      `${BRAVE_ENDPOINT}?q=Should+a+city+ban+cars+from+its+centre%3F+arguments+in+favour&count=10&safesearch=moderate&text_decorations=false`,
    ]);
    for (const call of fetchImpl.calls) {
      expect([...new URL(call.url).searchParams.keys()]).toStrictEqual(['q', 'count', 'safesearch', 'text_decorations']);
      const headers = new Headers(call.init?.headers);
      expect([headers.get('x-subscription-token'), headers.get('accept'), headers.get('accept-encoding')]).toStrictEqual([KEY, 'application/json', 'gzip']);
      expect(call.url).not.toContain(KEY);
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test('the key is in the X-Subscription-Token header and in no other header', async () => {
    const { fetchImpl, opts } = setup(BRAVE_ROUTES);
    await searchWeb(GOLDEN_QUERIES, opts);
    for (const call of fetchImpl.calls) {
      const headers = new Headers(call.init?.headers);
      expect([...headers.keys()].sort()).toStrictEqual(['accept', 'accept-encoding', 'x-subscription-token']);
      expect([...headers].filter(([, value]) => value.includes(KEY)).map(([name]) => name)).toStrictEqual(['x-subscription-token']);
      expect(call.init?.body).toBeUndefined();
    }
  });

  test('no redirect is followed, for it would carry the key to another host: every request says so, and an answer that redirects is a failed query like any other', async () => {
    const moved = (): Response => reply(302, null, { location: 'https://elsewhere.example/search' });
    const one = setup([q1(moved), BRAVE_ROUTES[1]]);
    expect(urls(await searchWeb(GOLDEN_QUERIES, one.opts))).toStrictEqual(SECOND_ONLY);
    expect(one.lines).toStrictEqual(['search: query 1 failed (HTTP 302)', 'search: 0 and 5 results, 4 kept']);
    expect(sent(one.fetchImpl.calls)).toStrictEqual([Q1, Q2]);
    expect(one.fetchImpl.calls.map((call) => call.init?.redirect)).toStrictEqual(['error', 'error']);
    const both = setup([q1(moved), q2(moved)]);
    const e = await failure(searchWeb(GOLDEN_QUERIES, both.opts));
    expect([e.code, e.status, e.message, e.detail]).toStrictEqual(['search_failed', 502, operatorsText('search_failed'), 'both Brave queries failed: query 1 HTTP 302, query 2 HTTP 302']);
    expect(both.lines).toStrictEqual([]);
  });

  test('the second query is sent only once the first has answered', async () => {
    let answerFirst: (res: Response) => void = () => undefined;
    const held: Route = { match: braveQuery(Q1), respond: () => new Promise<Response>((resolve) => { answerFirst = resolve; }) };
    const { fetchImpl, opts } = setup([held, BRAVE_ROUTES[1]]);
    const search = searchWeb(GOLDEN_QUERIES, opts);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(sent(fetchImpl.calls)).toStrictEqual([Q1]);
    answerFirst(reply(200, fixture('brave-q1.json'), { 'content-type': 'application/json' }));
    expect(await search).toStrictEqual(GOLDEN_RESULTS);
    expect(sent(fetchImpl.calls)).toStrictEqual([Q1, Q2]);
  });

  test('the second request starts 1100 ms after the first started: it waits what the first left of the 1100 ms, and nothing after a slow first', async () => {
    expect(QUERY_SPACING_MS).toBe(1_100);
    for (const [took, waits, second] of [[300, [800], T0 + 1_100], [1_500, [], T0 + 1_500]] as const) {
      const time = fakeTime();
      const starts: number[] = [];
      const timed = (route: Route): Route => ({ match: route.match, respond: (url, init) => { starts.push(time.clock()); time.advance(took); return route.respond(url, init); } });
      const { opts } = setup(BRAVE_ROUTES.map(timed), {}, time);
      await searchWeb(GOLDEN_QUERIES, opts);
      expect(time.waits).toStrictEqual(waits);
      expect(starts).toStrictEqual([T0, second]);
    }
  });

  test('a 429 is sent again once, 1100 ms after it came, and the second query keeps its spacing from that second sending', async () => {
    let busy = true;
    const busyOnce = q1(() => {
      if (!busy) return reply(200, fixture('brave-q1.json'), { 'content-type': 'application/json' });
      busy = false;
      return reply(429, '{"type":"ErrorResponse"}', { 'content-type': 'application/json' });
    });
    const { fetchImpl, lines, opts, time } = setup([busyOnce, BRAVE_ROUTES[1]]);
    expect(await searchWeb(GOLDEN_QUERIES, opts)).toStrictEqual(GOLDEN_RESULTS);
    expect(sent(fetchImpl.calls)).toStrictEqual([Q1, Q1, Q2]);
    expect(time.waits).toStrictEqual([1_100, 1_100]);
    expect(lines).toStrictEqual(['search: query 1 answered HTTP 429, sent again after 1100 ms', 'search: 4 and 5 results, 7 kept']);
  });

  test('a second 429 is a failure of its query, and the search goes on with the other; a 503 is not sent again', async () => {
    const twice = setup([q1(answer(429, {})), BRAVE_ROUTES[1]]);
    expect(urls(await searchWeb(GOLDEN_QUERIES, twice.opts))).toStrictEqual(SECOND_ONLY);
    expect(sent(twice.fetchImpl.calls)).toStrictEqual([Q1, Q1, Q2]);
    expect(twice.lines).toStrictEqual(['search: query 1 answered HTTP 429, sent again after 1100 ms', 'search: query 1 failed (HTTP 429)', 'search: 0 and 5 results, 4 kept']);
    const other = setup([q1(answer(503, 'upstream')), BRAVE_ROUTES[1]]);
    expect(urls(await searchWeb(GOLDEN_QUERIES, other.opts))).toStrictEqual(SECOND_ONLY);
    expect(sent(other.fetchImpl.calls)).toStrictEqual([Q1, Q2]);
    expect(other.lines).toStrictEqual(['search: query 1 failed (HTTP 503)', 'search: 0 and 5 results, 4 kept']);
  });

  test('a 429 that took 700 ms to come is sent again 1100 ms after it came, not 1100 ms after it started', async () => {
    const time = fakeTime();
    const starts: number[] = [];
    let first = true;
    const slow429 = q1(() => {
      starts.push(time.clock());
      if (first) { first = false; time.advance(700); return reply(429, '{}', json); }
      return reply(200, fixture('brave-q1.json'), json);
    });
    const { opts } = setup([slow429, BRAVE_ROUTES[1]], {}, time);
    expect(await searchWeb(GOLDEN_QUERIES, opts)).toStrictEqual(GOLDEN_RESULTS);
    expect(time.waits[0]).toBe(1_100);
    expect(starts).toStrictEqual([T0, T0 + 700 + 1_100]);
  });

  test('a 429 whose resend cannot start before the end of the search sends nothing and says nothing of a resend: its query has failed as not started', async () => {
    const time = fakeTime();
    const late429 = q1(() => { time.advance(14_500); return reply(429, '{}', json); });
    const { fetchImpl, lines, opts } = setup([late429, BRAVE_ROUTES[1]], {}, time);
    await searchWeb(GOLDEN_QUERIES, opts);
    expect(sent(fetchImpl.calls)).toStrictEqual([Q1, Q2]);
    expect(lines).toStrictEqual(['search: query 1 failed (not started: no time left in the search)', 'search: 0 and 5 results, 4 kept']);
  });

  test('the end of the search: a request has the time left in it at most, and none starts at or after it', async () => {
    const cut = setup([q1(never), BRAVE_ROUTES[1]], { phaseEndMs: T0 + 50 });
    const e = await failure(searchWeb(GOLDEN_QUERIES, cut.opts));
    expect(e.detail).toBe('both Brave queries failed: query 1 no answer within 50 ms, query 2 not started: no time left in the search');
    expect(sent(cut.fetchImpl.calls)).toStrictEqual([Q1]);
    const late = setup(BRAVE_ROUTES, { phaseEndMs: T0 + 1_000 });
    expect(urls(await searchWeb(GOLDEN_QUERIES, late.opts))).toStrictEqual(FIRST_ONLY);
    expect(late.lines).toStrictEqual(['search: query 2 failed (not started: no time left in the search)', 'search: 4 and 0 results, 4 kept']);
    expect(late.time.waits).toStrictEqual([]);
    const over = setup(BRAVE_ROUTES, { phaseEndMs: T0 });
    const none = await failure(searchWeb(GOLDEN_QUERIES, over.opts));
    expect(none.detail).toBe('both Brave queries failed: query 1 not started: no time left in the search, query 2 not started: no time left in the search');
    expect(over.fetchImpl.calls).toStrictEqual([]);
  });

  test('a clock with fractions of a millisecond: the time of a request is whole milliseconds', async () => {
    const { opts } = setup(BRAVE_ROUTES, { clock: () => T0 + 0.5, phaseEndMs: T0 + 5_000.25 });
    expect(await searchWeb(GOLDEN_QUERIES, opts)).toStrictEqual(GOLDEN_RESULTS);
  });

  test('the wait by default: a timer that resolves after its time, and rejects at once with the reason of its signal when that aborts', async () => {
    const started = performance.now();
    await timerWait(30);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    const caller = new AbortController();
    const cut = timerWait(10_000, caller.signal);
    setTimeout(() => { caller.abort(new Error('hung up')); }, 10);
    await expect(cut).rejects.toThrow('hung up');
    await expect(timerWait(10_000, AbortSignal.abort(new Error('gone')))).rejects.toThrow('gone');
  });

  test('the caller hanging up during the wait between the queries is aborted (499) at once, and the second query is not sent', async () => {
    const caller = new AbortController();
    const { fetchImpl, opts } = setup(BRAVE_ROUTES, { signal: caller.signal, clock: Date.now, phaseEndMs: Date.now() + SEARCH_MAX_MS, wait: undefined });
    setTimeout(() => { caller.abort(); }, 50);
    const started = performance.now();
    const e = await failure(searchWeb(GOLDEN_QUERIES, opts));
    expect([e.code, e.status, e.detail]).toStrictEqual(['aborted', 499, 'the caller hung up during the search']);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(sent(fetchImpl.calls)).toStrictEqual([Q1]);
  });

  test('the caller hanging up during the wait before a resend: no resend, and no line that says one was made', async () => {
    const caller = new AbortController();
    const { fetchImpl, lines, opts } = setup([q1(() => reply(429, '{}', json)), BRAVE_ROUTES[1]],
      { signal: caller.signal, clock: Date.now, phaseEndMs: Date.now() + SEARCH_MAX_MS, wait: undefined });
    setTimeout(() => { caller.abort(); }, 50);
    await expect(searchWeb(GOLDEN_QUERIES, opts)).rejects.toMatchObject({ code: 'aborted' });
    expect(sent(fetchImpl.calls)).toStrictEqual([Q1]);
    expect(lines).toStrictEqual([]);
  });
});

describe('the results', () => {
  test('the golden answers: the second query\'s results first, the http one, the duplicate of page 1 and the one without a url dropped', async () => {
    const { lines, opts } = setup(BRAVE_ROUTES);
    expect(await searchWeb(GOLDEN_QUERIES, opts)).toStrictEqual(GOLDEN_RESULTS);
    expect(lines).toStrictEqual(['search: 4 and 5 results, 7 kept']);
  });

  test('only title, url and description are read: a title or a description that is not text is \'\', a result whose url is not text is skipped', async () => {
    const { lines, opts } = setup([
      q1(answer(200, { web: { results: [{ title: 7, url: 'https://a.example/1', description: null, age: '2 days' }, { title: 'no url', url: 42 }, 'junk', { title: 'B', url: 'https://b.example/2', description: 'b' }] } })),
      q2(answer(200, { query: { original: Q2 } })),
    ]);
    expect(await searchWeb(GOLDEN_QUERIES, opts)).toStrictEqual([{ title: '', url: 'https://a.example/1', description: '' }, { title: 'B', url: 'https://b.example/2', description: 'b' }]);
    expect(lines).toStrictEqual(['search: 2 and 0 results, 2 kept']);
  });

  test('dedupeResults: https only, one result for a scheme, host and path in any case, whatever its query and fragment, the first kept, at most 12', () => {
    const r = (url: string): SearchResult => ({ title: url, url, description: '' });
    const mixed = [r('http://a.example/x'), r('https://a.example/x'), r('https://A.EXAMPLE/X#top'), r('https://a.example/x?page=2'), r('https://a.example:443/x'), r('ftp://a.example/y'), r('not a url'), r('https://a.example/y'), r('https://a.example:8443/x')];
    expect(urls(dedupeResults(mixed))).toStrictEqual(['https://a.example/x', 'https://a.example/y', 'https://a.example:8443/x']);
    expect(MAX_RESULTS).toBe(12);
    const many = Array.from({ length: 20 }, (_v, i) => r(`https://site-${i}.example/`));
    expect(dedupeResults(many)).toStrictEqual(many.slice(0, MAX_RESULTS));
  });

  test('no https result at all is search_empty (502), after the line of the counts', async () => {
    const { lines, opts } = setup([q1(answer(200, { web: { results: [{ title: 'x', url: 'http://a.example/' }] } })), q2(answer(200, {}))]);
    const e = await failure(searchWeb(GOLDEN_QUERIES, opts));
    expect([e.code, e.status, e.message, e.detail]).toStrictEqual(['search_empty', 502, operatorsText('search_empty'), 'the two Brave queries gave no https result (1 and 0 results)']);
    expect(lines).toStrictEqual(['search: 1 and 0 results, 0 kept']);
  });
});

describe('the failures', () => {
  test('the second query with no answer within its time and the first 200: the search goes on with the first query\'s results alone', async () => {
    const { lines, opts } = setup([BRAVE_ROUTES[0], q2(never)], { timeoutMs: 50 });
    expect(urls(await searchWeb(GOLDEN_QUERIES, opts))).toStrictEqual(FIRST_ONLY);
    expect(lines).toStrictEqual(['search: query 2 failed (no answer within 50 ms)', 'search: 4 and 0 results, 4 kept']);
  });

  test.each<[string, Route[], number, string]>([
    ['a 503 and an answer that is not JSON', [q1(answer(503, 'upstream')), q2(answer(200, '<html>not json</html>'))], 10_000, 'query 1 HTTP 503, query 2 an answer that is not JSON'],
    ['two answers that are not JSON objects', [q1(answer(200, [])), q2(answer(200, 'null'))], 10_000, 'query 1 an answer that is not a JSON object, query 2 an answer that is not a JSON object'],
    ['a 500 and a network error', [q1(answer(500, ''))], 10_000, 'query 1 HTTP 500, query 2 a network error'],
    ['two queries with no answer in their time', [q1(never), q2(never)], 50, 'query 1 no answer within 50 ms, query 2 no answer within 50 ms'],
  ])('both failing is search_failed (502): %s', async (_name, routes, timeoutMs, why) => {
    const { lines, opts } = setup(routes, { timeoutMs });
    const e = await failure(searchWeb(GOLDEN_QUERIES, opts));
    expect([e.code, e.status, e.message, e.detail]).toStrictEqual(['search_failed', 502, operatorsText('search_failed'), `both Brave queries failed: ${why}`]);
    expect(lines).toStrictEqual([]);
  });

  test.each([401, 403])('a %s is search_failed at once: the second query is not sent, and the log names the status and never the key', async (status) => {
    const { fetchImpl, lines, opts } = setup([q1(answer(status, { type: 'ErrorResponse' })), BRAVE_ROUTES[1]]);
    const e = await failure(searchWeb(GOLDEN_QUERIES, opts));
    expect([e.code, e.status, e.message, e.detail]).toStrictEqual(['search_failed', 502, operatorsText('search_failed'), `the Brave Search API refused the key (HTTP ${status})`]);
    expect(lines).toStrictEqual([`search: the key was refused (HTTP ${status})`]);
    expect(sent(fetchImpl.calls)).toStrictEqual([Q1]);
  });

  test('a refused key is search_failed even when the other query has answered', async () => {
    const { lines, opts } = setup([BRAVE_ROUTES[0], q2(answer(401, ''))]);
    expect((await failure(searchWeb(GOLDEN_QUERIES, opts))).detail).toBe('the Brave Search API refused the key (HTTP 401)');
    expect(lines).toStrictEqual(['search: the key was refused (HTTP 401)']);
  });

  test('the caller hanging up is aborted (499): before the search nothing is sent, during a request it is cut and nothing more is sent', async () => {
    const before = setup(BRAVE_ROUTES, { signal: AbortSignal.abort() });
    expect((await failure(searchWeb(GOLDEN_QUERIES, before.opts))).code).toBe('aborted');
    expect(before.fetchImpl.calls).toStrictEqual([]);
    const caller = new AbortController();
    const during = setup([q1(never), q2(never)], { signal: caller.signal, timeoutMs: 60_000 });
    setTimeout(() => { caller.abort(); }, 20);
    const e = await failure(searchWeb(GOLDEN_QUERIES, during.opts));
    expect([e.code, e.status, e.detail]).toStrictEqual(['aborted', 499, 'the caller hung up during the search']);
    expect(during.fetchImpl.calls.map((call) => call.init?.signal?.aborted)).toStrictEqual([true]);
  });

  test('no line, no message and no detail ever holds the key', async () => {
    const runs: Array<{ routes: Route[]; timeoutMs: number }> = [
      { routes: [...BRAVE_ROUTES], timeoutMs: 10_000 }, { routes: [q1(answer(401, KEY)), q2(answer(403, KEY))], timeoutMs: 10_000 },
      { routes: [q1(answer(500, KEY)), q2(never)], timeoutMs: 50 }, { routes: [q1(answer(429, KEY)), BRAVE_ROUTES[1]], timeoutMs: 10_000 },
      { routes: [q1(answer(200, KEY)), BRAVE_ROUTES[1]], timeoutMs: 10_000 },
    ];
    for (const { routes, timeoutMs } of runs) {
      const { lines, opts } = setup(routes, { timeoutMs });
      const said = await searchWeb(GOLDEN_QUERIES, opts).then(() => '', (e: AdvocateError) => `${e.message} ${e.detail}`);
      expect(`${lines.join('\n')} ${said}`).not.toContain(KEY);
    }
  });
});
