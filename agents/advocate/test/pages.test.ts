// agents/advocate/test/pages.test.ts
// The pages (ruling R-E4) through safeFetch and a fake fetch: the golden results give pages 1 to 3, their texts word for word, and drop the redirect, the
// PDF, the 404 and the thin page; each way a page is dropped, counted; the bounds of a page (200 characters, 1 MB, the excerpt); the headers sent; a page cut
// at the deadline; the pool of four. Every host is looked up by publicLookup, so no test touches DNS. Characters outside ASCII are written as escapes.
import { describe, expect, test, vi } from 'vitest';
import { operatorsText } from '@vsa/service-kit';
import { PAGE_TIMEOUT_MS } from '../src/budget.ts';
import { AdvocateError } from '../src/errors.ts';
import { EXCERPT_CHARS, MIN_PAGE_CHARS } from '../src/html.ts';
import { ACCEPTED_TYPES, PAGE_MAX_BYTES, USER_AGENT, fetchPages } from '../src/pages.ts';
import type { FetchPagesOptions, Page } from '../src/pages.ts';
import type { SearchResult } from '../src/search.ts';
import { GOLDEN_RESULTS, PAGE_ROUTES, at, never, publicLookup, reply, routedFetch, stuck } from './fake-fetch.ts';
import type { Route } from './fake-fetch.ts';

/** The clock of the tests: 2026-10-17T09:30:00.000Z, on a whole second. */
const NOW = Date.UTC(2026, 9, 17, 9, 30, 0);
const RETRIEVED = '2026-10-17T09:30:00.000Z';
/** The texts of the three golden pages: page-1.html and page-2.html through extractText, page-3.txt through collapseWhitespace. */
const PAGE_1_TEXT = [
  'Home Research',
  'Car-free centres: what the evidence says',
  'Over the last two decades a number of European cities have closed their historic centres to private cars, and the results have been counted closely.',
  "Cities that closed their centres to cars saw retail footfall rise by eleven percent within two years, according to the council's own count.",
  'Shopkeepers who had feared the change reported that customers stayed longer once the traffic had gone.',
  'Deliveries, they said, were the one thing that took time to settle.',
  'Published by the urban mobility desk.',
].join('\n');
const PAGE_2_TEXT = [
  'Clean air and the school run',
  'Parents & teachers asked for one thing: a street where children could walk to school without breathing exhaust.',
  'Nitrogen dioxide at the school gate fell by a third in the first year after the street was closed to through traffic.',
  "The council's three monitors \u2014 read every hour \u2014 showed the drop on weekdays and at weekends alike, from 41 to 27 micrograms.",
  'Cycling to school doubled over the same period, and the crossing patrol moved to a busier road nearby.',
].join('\n');
const PAGE_3_TEXT = [
  'NOTES ON URBAN FREIGHT',
  'Deliveries moved to early-morning windows and the number of vans in the centre at noon halved.',
  'Shops in the closed streets now take their goods between six and ten in the morning, while the streets are quiet.',
  'Couriers on cargo bikes carry the last stretch from a depot at the edge of the centre.',
  'A plain-text page is read as it is: <p> here is text, not a tag, and &amp; is not decoded.',
].join('\n');
function setup(routes: readonly Route[], over: Partial<FetchPagesOptions> = {}) {
  const fetchImpl = routedFetch(routes);
  const lines: string[] = [];
  const opts: FetchPagesOptions = { fetchImpl, clock: () => NOW, deadlineMs: NOW + 45_000, log: (line) => { lines.push(line); }, lookup: publicLookup, ...over };
  return { fetchImpl, lines, opts };
}
async function failure(p: Promise<unknown>): Promise<AdvocateError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AdvocateError); return e as AdvocateError; }
  throw new Error('the pages were fetched');
}
const result = (url: string): SearchResult => ({ title: `the result at ${url}`, url, description: '' });
/** A page of plain text of `n` characters. */
const plain = (n: number): string => 'x'.repeat(n);
const serve = (url: string, respond: Route['respond']): Route => ({ match: at(url), respond });
const OK_URL = 'https://example.org/ok';
const OK_ROUTE = serve(OK_URL, () => reply(200, plain(250), { 'content-type': 'text/plain' }));
const line = (kept: number, of: number, counts: { redirect?: number; status?: number; type?: number; thin?: number; failed?: number }): string =>
  `pages: ${kept} kept of ${of} (redirect ${counts.redirect ?? 0}, status ${counts.status ?? 0}, type ${counts.type ?? 0}, thin ${counts.thin ?? 0}, failed ${counts.failed ?? 0})`;

describe('the golden results', () => {
  test('pages 1 to 3 in the order of the results, with the title of the result, the time of the fetch and the text; four pages dropped and counted', async () => {
    expect([ACCEPTED_TYPES, PAGE_MAX_BYTES]).toStrictEqual([['text/html', 'application/xhtml+xml', 'text/plain'], 1_048_576]);
    const { lines, opts } = setup(PAGE_ROUTES);
    const pages = await fetchPages(GOLDEN_RESULTS, opts);
    expect(pages).toStrictEqual<Page[]>([
      { n: 1, title: 'Car-free centres: what the evidence says', url: 'https://example.org/car-free-centres', retrieved_at: RETRIEVED, excerpt: PAGE_1_TEXT },
      { n: 2, title: 'Clean air and the school run', url: 'https://example.net/clean-air', retrieved_at: RETRIEVED, excerpt: PAGE_2_TEXT },
      { n: 3, title: 'Notes on urban freight', url: 'https://example.com/freight.txt', retrieved_at: RETRIEVED, excerpt: PAGE_3_TEXT },
    ]);
    expect(Object.keys(pages[0])).toStrictEqual(['n', 'title', 'url', 'retrieved_at', 'excerpt']);
    // The sentences of the golden fixtures are in the texts of their pages: the first two hold the quotes the golden model answer cites.
    expect(pages[0].excerpt).toContain('retail footfall rise by eleven percent within two years');
    expect(pages[1].excerpt).toContain('fell by a third in the first year');
    expect(pages[2].excerpt).toContain('Deliveries moved to early-morning windows and the number of vans in the centre at noon halved.');
    expect(pages[0].excerpt).not.toMatch(/never|window\.counter|font-family|map of the closed streets/);
    for (const page of pages) expect(page.excerpt.length).toBeGreaterThanOrEqual(MIN_PAGE_CHARS);
    expect(lines).toStrictEqual([line(3, 7, { redirect: 1, status: 1, type: 1, thin: 1 })]);
  });

  test('the user agent and the accept header on every fetch, no redirect followed, a signal on every one', async () => {
    const { fetchImpl, opts } = setup(PAGE_ROUTES);
    await fetchPages(GOLDEN_RESULTS, opts);
    expect(fetchImpl.calls.map((call) => call.url)).toStrictEqual(GOLDEN_RESULTS.map((r) => r.url));
    for (const call of fetchImpl.calls) {
      const headers = new Headers(call.init?.headers);
      expect([headers.get('user-agent'), headers.get('accept'), call.init?.redirect]).toStrictEqual([USER_AGENT, 'text/html, text/plain;q=0.9, */*;q=0.1', 'manual']);
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(USER_AGENT).toBe('vector-service-agents/advocate (+https://github.com/Apex-Fusion/vector-service-agents)');
  });
});

describe('each page that is dropped, counted by why, and no page kept is no_sources (502)', () => {
  const private10 = async (host: string) => [{ address: host === 'intranet.example' ? '10.0.0.7' : '93.184.216.34', family: 4 }];
  test.each<[string, string, Route['respond'], Partial<FetchPagesOptions>, Parameters<typeof line>[2]]>([
    ['a redirect', 'https://example.org/moved', () => reply(301, null, { location: 'https://example.org/elsewhere' }), {}, { redirect: 1 }],
    ['a redirect with no location', 'https://example.org/moved', () => reply(307, null), {}, { redirect: 1 }],
    ['a 404', 'https://example.org/gone', () => reply(404, 'not found', { 'content-type': 'text/html' }), {}, { status: 1 }],
    ['a 500', 'https://example.org/broken', () => reply(500, 'oops', { 'content-type': 'text/html' }), {}, { status: 1 }],
    ['a 204', 'https://example.org/empty', () => reply(204, null), {}, { status: 1 }],
    ['a PDF', 'https://example.org/report.pdf', () => reply(200, '%PDF-1.7', { 'content-type': 'application/pdf' }), {}, { type: 1 }],
    ['an image', 'https://example.org/map.png', () => reply(200, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { 'content-type': 'image/png' }), {}, { type: 1 }],
    ['no content type', 'https://example.org/blob', () => new Response(new Uint8Array(300)), {}, { type: 1 }],
    ['a type that only begins like HTML', 'https://example.org/htmlx', () => reply(200, plain(300), { 'content-type': 'text/htmlx' }), {}, { type: 1 }],
    ['199 characters of text', 'https://example.org/thin.txt', () => reply(200, plain(199), { 'content-type': 'text/plain' }), {}, { thin: 1 }],
    ['an HTML page whose text is under 200 characters', 'https://example.org/thin', () => reply(200, `<p>${plain(150)}</p><script>${plain(500)}</script>`, { 'content-type': 'text/html' }), {}, { thin: 1 }],
    ['a body over 1 MB', 'https://example.org/huge.txt', () => reply(200, plain(PAGE_MAX_BYTES + 1), { 'content-type': 'text/plain' }), {}, { failed: 1 }],
    ['a network error', 'https://example.org/unrouted', () => { throw new TypeError('fetch failed'); }, {}, { failed: 1 }],
    ['a host that resolves to a private address', 'https://intranet.example/', () => reply(200, plain(300), { 'content-type': 'text/plain' }), { lookup: private10 }, { failed: 1 }],
    ['a private address in the URL', 'https://127.0.0.1/admin', () => reply(200, plain(300), { 'content-type': 'text/plain' }), {}, { failed: 1 }],
    ['an http URL', 'http://example.org/insecure', () => reply(200, plain(300), { 'content-type': 'text/plain' }), {}, { failed: 1 }],
  ])('%s', async (_name, url, respond, over, counts) => {
    const { lines, opts } = setup([serve(url, respond)], over);
    const e = await failure(fetchPages([result(url)], opts));
    const why = line(0, 1, counts).replace('pages: 0 kept of 1 ', '');
    expect([e.code, e.status, e.message, e.detail]).toStrictEqual(['no_sources', 502, operatorsText('no_sources'), `no page was kept of 1 ${why}`]);
    expect(lines).toStrictEqual([line(0, 1, counts)]);
  });

  test('a refusal of safeFetch makes no call: the private address, the http URL', async () => {
    const { fetchImpl, opts } = setup([OK_ROUTE]);
    await fetchPages([result('https://127.0.0.1/admin'), result('http://example.org/insecure'), result(OK_URL)], opts);
    expect(fetchImpl.calls.map((call) => call.url)).toStrictEqual([OK_URL]);
  });
});

describe('what a kept page holds', () => {
  test('the three types, in any case and with parameters; a plain-text page is not read as HTML', async () => {
    const { opts } = setup([
      serve('https://example.org/a', () => reply(200, `<p>${plain(210)}</p>`, { 'content-type': 'TEXT/HTML; Charset=UTF-8' })),
      serve('https://example.org/b', () => reply(200, `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${plain(210)}</p></body></html>`, { 'content-type': 'application/xhtml+xml' })),
      serve('https://example.org/c', () => reply(200, `<p>${plain(210)}</p>`, { 'content-type': 'text/plain; charset=utf-8' })),
    ]);
    const pages = await fetchPages(['https://example.org/a', 'https://example.org/b', 'https://example.org/c'].map(result), opts);
    expect(pages.map((page) => page.excerpt)).toStrictEqual([plain(210), plain(210), `<p>${plain(210)}</p>`]);
  });

  test('200 characters of text is enough; the excerpt is the first 12000 characters, counted as code points, never half of one', async () => {
    const emoji = '\u{1F600}';
    const long = `${'a'.repeat(EXCERPT_CHARS - 1)}${emoji}${'b'.repeat(100)}`;
    const { opts } = setup([
      serve('https://example.org/just', () => reply(200, plain(MIN_PAGE_CHARS), { 'content-type': 'text/plain' })),
      serve('https://example.org/long', () => reply(200, long, { 'content-type': 'text/plain' })),
    ]);
    const [just, cut] = await fetchPages([result('https://example.org/just'), result('https://example.org/long')], opts);
    expect(just.excerpt).toBe(plain(MIN_PAGE_CHARS));
    expect(cut.excerpt).toBe(`${'a'.repeat(EXCERPT_CHARS - 1)}${emoji}`);
    expect([...cut.excerpt].length).toBe(EXCERPT_CHARS);
  });

  test('a body of exactly 1 MB is read', async () => {
    const { opts } = setup([serve('https://example.org/mb.txt', () => reply(200, plain(PAGE_MAX_BYTES), { 'content-type': 'text/plain' }))]);
    const [page] = await fetchPages([result('https://example.org/mb.txt')], opts);
    expect(page.excerpt).toBe(plain(EXCERPT_CHARS));
  });

  test('retrieved_at is new Date(clock()).toISOString() when the page has come in, its milliseconds with it (R-E14)', async () => {
    let now = NOW;
    const { opts } = setup([serve(OK_URL, () => { now += 3_250; return reply(200, plain(250), { 'content-type': 'text/plain' }); })], { clock: () => now });
    const [page] = await fetchPages([result(OK_URL)], opts);
    expect(page.retrieved_at).toBe('2026-10-17T09:30:03.250Z');
  });

  test('a media type with a space before its parameters is read; a result url keeps its case; 150 characters of two UTF-16 units are thin', async () => {
    const mixed = 'https://example.org/Case/Sensitive?Q=1';
    const { opts } = setup([
      serve(mixed, () => reply(200, `<p>${plain(210)}</p>`, { 'content-type': 'text/html ; charset=utf-8' })),
      serve('https://example.org/emoji', () => reply(200, String.fromCodePoint(0x1f600).repeat(150), { 'content-type': 'text/plain' })),
    ]);
    const pages = await fetchPages([result(mixed), result('https://example.org/emoji')], opts);
    expect(pages.map((page) => page.url)).toStrictEqual([mixed]);
    expect(pages[0].excerpt).toBe(plain(210));
  });
});

describe('the deadline', () => {
  test('a page still in flight at the deadline is dropped and no longer waited for, even when it ignores its signal; the others are kept', async () => {
    const { lines, opts } = setup([serve('https://example.org/stuck', stuck), serve('https://example.org/a', () => reply(200, plain(250), { 'content-type': 'text/plain' })), serve('https://example.org/b', () => reply(200, plain(260), { 'content-type': 'text/plain' }))], { deadlineMs: NOW + 300 });
    const started = Date.now();
    const pages = await fetchPages(['https://example.org/stuck', 'https://example.org/a', 'https://example.org/b'].map(result), opts);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(pages.map((page) => [page.n, page.url])).toStrictEqual([[1, 'https://example.org/a'], [2, 'https://example.org/b']]);
    expect(lines).toStrictEqual([line(2, 3, { failed: 1 })]);
  });

  test('after the deadline no fetch starts: with one fetch at a time, the results after a stuck one are never fetched', async () => {
    const { fetchImpl, lines, opts } = setup([serve('https://example.org/stuck', stuck), OK_ROUTE], { deadlineMs: NOW + 200, concurrency: 1 });
    const e = await failure(fetchPages([result('https://example.org/stuck'), result(OK_URL), result(OK_URL)], opts));
    expect(e.code).toBe('no_sources');
    expect(fetchImpl.calls.map((call) => call.url)).toStrictEqual(['https://example.org/stuck']);
    expect(lines).toStrictEqual([line(0, 3, { failed: 3 })]);
  });

  test('a fetch in flight at the deadline is cut: its signal aborts', async () => {
    const { fetchImpl, opts } = setup([serve('https://example.org/slow', never), OK_ROUTE], { deadlineMs: NOW + 200 });
    const pages = await fetchPages([result('https://example.org/slow'), result(OK_URL)], opts);
    expect(pages.map((page) => page.url)).toStrictEqual([OK_URL]);
    expect(fetchImpl.calls[0].init?.signal?.aborted).toBe(true);
  });

  test('a deadline already past starts nothing', async () => {
    const { fetchImpl, lines, opts } = setup([OK_ROUTE], { deadlineMs: NOW - 1 });
    expect((await failure(fetchPages([result(OK_URL)], opts))).code).toBe('no_sources');
    expect(fetchImpl.calls).toStrictEqual([]);
    expect(lines).toStrictEqual([line(0, 1, { failed: 1 })]);
  });

  test('each page has min(15 s, the time left to the deadline) of its own, in whole milliseconds', async () => {
    const seen: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { seen.push(ms); return real(ms); });
    try {
      await fetchPages([result(OK_URL)], setup([OK_ROUTE]).opts);
      await fetchPages([result(OK_URL)], setup([OK_ROUTE], { deadlineMs: NOW + 4_000 }).opts);
      await fetchPages([result(OK_URL)], setup([OK_ROUTE], { deadlineMs: NOW + 4_000.9 }).opts);
    } finally { spy.mockRestore(); }
    expect(seen).toStrictEqual([PAGE_TIMEOUT_MS, 4_000, 4_000]);
  });
});

describe('the pool', () => {
  test('four fetches at a time, taken in the order of the results; the pages are numbered in that order, whichever answers first', async () => {
    let inFlight = 0;
    let most = 0;
    const pool: Route = {
      match: (url) => url.hostname.endsWith('.pool.example'),
      respond: async (url) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        const i = Number(url.hostname.split('.')[0]);
        await new Promise((resolve) => { setTimeout(resolve, 10 + (10 - i) * 5); });
        inFlight -= 1;
        return reply(200, `page ${i} ${plain(250)}`, { 'content-type': 'text/plain' });
      },
    };
    const results = Array.from({ length: 10 }, (_v, i) => result(`https://${i}.pool.example/`));
    const { fetchImpl, opts } = setup([pool]);
    const pages = await fetchPages(results, opts);
    expect(most).toBe(4);
    expect(fetchImpl.calls.map((call) => call.url)).toStrictEqual(results.map((r) => r.url));
    expect(pages.map((page) => [page.n, page.url, page.excerpt.slice(0, 7)])).toStrictEqual(results.map((r, i) => [i + 1, r.url, `page ${i} `]));
    most = 0;
    await fetchPages(results, setup([pool], { concurrency: 2 }).opts);
    expect(most).toBe(2);
  });

  test('the caller hanging up is aborted (499): before the phase nothing is fetched, during it the fetches are cut', async () => {
    const before = setup([OK_ROUTE], { signal: AbortSignal.abort() });
    expect((await failure(fetchPages([result(OK_URL)], before.opts))).code).toBe('aborted');
    expect(before.fetchImpl.calls).toStrictEqual([]);
    const caller = new AbortController();
    const during = setup([serve('https://example.org/slow', never)], { signal: caller.signal });
    setTimeout(() => { caller.abort(); }, 20);
    const e = await failure(fetchPages([result('https://example.org/slow')], during.opts));
    expect([e.code, e.status, e.detail]).toStrictEqual(['aborted', 499, 'the caller hung up while the pages were fetched']);
    expect(during.fetchImpl.calls[0].init?.signal?.aborted).toBe(true);
    expect(during.lines).toStrictEqual([]);
  });

  test('the caller hanging up ends the phase at once even when a fetch ignores its signal', async () => {
    const caller = new AbortController();
    const { opts } = setup([serve('https://example.org/stuck', stuck)], { signal: caller.signal });
    setTimeout(() => { caller.abort(); }, 20);
    const started = Date.now();
    let error: unknown;
    try { await fetchPages([result('https://example.org/stuck')], opts); } catch (e) { error = e; }
    expect((error as AdvocateError).code).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('a concurrency that is not a whole number of 1 or more is refused', async () => {
    await expect(fetchPages([result(OK_URL)], setup([OK_ROUTE], { concurrency: 0 }).opts)).rejects.toThrow(RangeError);
  });

  test('concurrency must be a whole number: 1.5 is refused as 0 is', async () => {
    await expect(fetchPages([result(OK_URL)], setup([OK_ROUTE], { concurrency: 1.5 }).opts)).rejects.toThrow(RangeError);
  });
});
