// agents/advocate/test/fake-fetch.ts
// The outbound calls of the tests: no test touches the network or DNS. routedFetch is a fetch that answers from a list of routes, the first whose match takes
// the call, and records every call with its init, so that a test reads the headers it sent; a call that no route takes fails as a network error does.
// publicLookup answers every host with one public address, for safeFetch. The golden fixtures (test/fixtures: the two Brave answers and the pages) are served
// here by BRAVE_ROUTES and PAGE_ROUTES, and GOLDEN_RESULTS are the results the search keeps from them, in their order.
import { readFileSync } from 'node:fs';
import { BRAVE_ENDPOINT } from '../src/search.ts';
import type { SearchResult } from '../src/search.ts';

export interface Route { match: (url: URL, init?: RequestInit) => boolean; respond: (url: URL, init?: RequestInit) => Response | Promise<Response> }
export interface Call { url: string; init?: RequestInit }
export type RoutedFetch = typeof fetch & { calls: Call[] };

export function routedFetch(routes: readonly Route[]): RoutedFetch {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    calls.push(init === undefined ? { url: raw } : { url: raw, init });
    const url = new URL(raw);
    const route = routes.find((r) => r.match(url, init));
    if (route === undefined) throw new TypeError(`fetch failed: no route for ${raw}`);
    return route.respond(url, init);
  }) as typeof fetch;
  return Object.assign(fetchImpl, { calls });
}

export const reply = (status: number, body: string | Uint8Array | null, headers: Record<string, string> = {}): Response =>
  new Response(body as BodyInit | null, { status, headers });

/** An answer that never comes: it rejects with the reason of the call's signal once that aborts, as the platform fetch does. */
export function never(_url: URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) return;
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
  });
}
/** An answer that never comes and never gives up, whatever its signal does: a stuck server behind a stuck connection. */
export const stuck = (): Promise<Response> => new Promise<Response>(() => undefined);

/** The host lookup of safeFetch in the tests: every host is the public address 93.184.216.34. */
export const publicLookup = async (_host: string): Promise<Array<{ address: string; family: number }>> => [{ address: '93.184.216.34', family: 4 }];

/** A fixture of test/fixtures, as text. */
export const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
/** The match of one URL: its origin, path and query, whatever its fragment. */
export const at = (href: string): Route['match'] => {
  const want = new URL(href);
  return (url) => url.origin === want.origin && url.pathname === want.pathname && url.search === want.search;
};
/** The match of one Brave query: the endpoint, with q the query. */
export const braveQuery = (query: string): Route['match'] => (url) => `${url.origin}${url.pathname}` === BRAVE_ENDPOINT && url.searchParams.get('q') === query;

/** The golden request's subject, and the two queries its search makes (for the side for): the queries the two Brave fixtures answer. */
export const GOLDEN_SUBJECT = 'Should a city ban cars from its centre?';
export const GOLDEN_QUERIES: [string, string] = [GOLDEN_SUBJECT, `${GOLDEN_SUBJECT} arguments in favour`];
export const BRAVE_ROUTES: readonly Route[] = [
  { match: braveQuery(GOLDEN_QUERIES[0]), respond: () => reply(200, fixture('brave-q1.json'), { 'content-type': 'application/json' }) },
  { match: braveQuery(GOLDEN_QUERIES[1]), respond: () => reply(200, fixture('brave-q2.json'), { 'content-type': 'application/json' }) },
];

/** The page of under 200 characters of text. */
export const THIN_HTML = '<!doctype html><html><head><title>Thin</title></head><body><p>Too short to cite.</p></body></html>';
/** The seven result pages of the golden fixtures: pages 1 to 3 from test/fixtures, then the redirect, the PDF, the 404 and the thin page. */
export const PAGE_ROUTES: readonly Route[] = [
  { match: at('https://example.org/car-free-centres'), respond: () => reply(200, fixture('page-1.html'), { 'content-type': 'text/html; charset=utf-8' }) },
  { match: at('https://example.net/clean-air'), respond: () => reply(200, fixture('page-2.html'), { 'content-type': 'text/html' }) },
  { match: at('https://example.com/freight.txt'), respond: () => reply(200, fixture('page-3.txt'), { 'content-type': 'text/plain' }) },
  { match: at('https://example.org/moved'), respond: () => reply(302, null, { location: 'https://example.org/car-free-centres' }) },
  { match: at('https://example.org/report.pdf'), respond: () => reply(200, '%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n', { 'content-type': 'application/pdf' }) },
  { match: at('https://example.org/gone'), respond: () => reply(404, '<!doctype html><title>Not found</title><p>Not found.</p>', { 'content-type': 'text/html' }) },
  { match: at('https://example.org/thin'), respond: () => reply(200, THIN_HTML, { 'content-type': 'text/html' }) },
];

const result = (title: string, url: string, description: string): SearchResult => ({ title, url, description });
/** What the search keeps from the two Brave fixtures: the second query's results first, the http one and the duplicate of page 1 dropped. */
export const GOLDEN_RESULTS: readonly SearchResult[] = [
  result('Car-free centres: what the evidence says', 'https://example.org/car-free-centres', 'What happened to footfall, air and deliveries after centres closed to cars.'),
  result('This page has moved', 'https://example.org/moved', 'A page that answers with a redirect.'),
  result('Clean air and the school run', 'https://example.net/clean-air', 'Nitrogen dioxide at a school gate before and after a street closed.'),
  result('Car-free centres, the full report', 'https://example.org/report.pdf', 'The report as a PDF.'),
  result('Notes on urban freight', 'https://example.com/freight.txt', 'Plain notes on deliveries in a centre closed to through traffic.'),
  result('Page not found', 'https://example.org/gone', 'A page that is no longer there.'),
  result('A thin page', 'https://example.org/thin', 'A page with almost no text.'),
];
