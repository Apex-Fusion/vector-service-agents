// agents/advocate/test/golden.ts
// The golden job, shared by the run, the server and the spec page: the request of the spec page; the answers of the search, of the seven result pages and of
// the model, as the fixtures hold them; and every value of what the service must make of them. The search and the pages are served by the routes of
// test/fake-fetch.ts (BRAVE_ROUTES, PAGE_ROUTES) and the model by modelRoute here. The pages are the three that fetchPages keeps, numbered in the order of the
// results, with the text the service reads from the fixture files; the brief is the model's answer after the post-check, every value written out. The keys
// are made at run time from a label, so that none is written in the repository.
import { createHash } from 'node:crypto';
import { EXCERPT_CHARS, collapseWhitespace, extractText } from '../src/html.ts';
import { OPENROUTER_ENDPOINT } from '../src/model.ts';
import type { ModelBrief } from '../src/model.ts';
import type { Page } from '../src/pages.ts';
import type { AdvocateResult } from '../src/result.ts';
import type { RunOutcome } from '../src/run.ts';
import { BRAVE_ROUTES, GOLDEN_QUERIES, GOLDEN_RESULTS, GOLDEN_SUBJECT, PAGE_ROUTES, at, braveQuery, fixture, reply, routedFetch } from './fake-fetch.ts';
import type { Route, RoutedFetch } from './fake-fetch.ts';

/** Keys in the forms of the two services, made at run time from a label. */
export const TEST_BRAVE_KEY = `BSA${createHash('sha256').update('advocate test: the Brave Search API key').digest('hex').slice(0, 28)}`;
export const TEST_OPENROUTER_KEY = `sk-or-v1-${createHash('sha256').update('advocate test: the OpenRouter API key').digest('hex')}`;
/** The wait of the search in a test: it returns at once, so that the two queries are not 1100 ms of real time apart. */
export const noWait = async (_ms: number, _signal?: AbortSignal): Promise<void> => undefined;

/** The clock of the golden job, which does not move: every page is fetched at this time (ruling R-E14: the ISO time with its milliseconds). */
export const GOLDEN_T0 = Date.UTC(2026, 9, 17, 9, 0, 0);
export const GOLDEN_RETRIEVED_AT = '2026-10-17T09:00:00.000Z';

/** The request of the spec page, as a hirer writes it. */
export const GOLDEN_REQUEST = { subject: GOLDEN_SUBJECT, side: 'for', length: 'short', language: 'en' };
/** The seven result URLs of the golden search, the three kept and the four dropped, in the order of the results. */
export const RESULT_URLS = GOLDEN_RESULTS.map((result) => result.url);

const PAGE_1 = 'https://example.org/car-free-centres';
const PAGE_2 = 'https://example.net/clean-air';
const PAGE_3 = 'https://example.com/freight.txt';
/** The first EXCERPT_CHARS characters of a text, as code points. */
const excerptOf = (text: string): string => [...text].slice(0, EXCERPT_CHARS).join('');
/** The three pages fetchPages keeps from the golden results, in the order of the results, each with the title of its result. */
export const GOLDEN_PAGES: Page[] = [
  { n: 1, title: 'Car-free centres: what the evidence says', url: PAGE_1, retrieved_at: GOLDEN_RETRIEVED_AT, excerpt: excerptOf(extractText(fixture('page-1.html'))) },
  { n: 2, title: 'Clean air and the school run', url: PAGE_2, retrieved_at: GOLDEN_RETRIEVED_AT, excerpt: excerptOf(extractText(fixture('page-2.html'))) },
  { n: 3, title: 'Notes on urban freight', url: PAGE_3, retrieved_at: GOLDEN_RETRIEVED_AT, excerpt: excerptOf(collapseWhitespace(fixture('page-3.txt'))) },
];

const CLAIM_1 = 'Shops gain visitors when the cars leave the centre.';
const SUPPORT_1 = "The cities that closed their centres to cars counted more people in their shopping streets: by the council's own count, retail footfall rose by eleven percent within two years.";
const CLAIM_3 = 'Children breathe cleaner air on the way to school.';
const SUPPORT_3 = 'Where a street was closed to through traffic, nitrogen dioxide at the school gate fell by a third in the first year, so the school run itself became cleaner.';
const THESIS = 'A city should ban cars from its centre, because the centres that did so gained shoppers and cleaner air.';

/** The brief in the content of test/fixtures/model-answer.json: a true quote, a quote made up, a page that does not exist, and a quote too short. */
export const GOLDEN_MODEL_BRIEF: ModelBrief = {
  thesis: THESIS,
  arguments: [
    { claim: CLAIM_1, support: SUPPORT_1, sources: [{ n: 1, quote: 'retail footfall rise by eleven percent within two years' }] },
    {
      claim: 'People switch to bicycles at once.',
      support: 'Once the street closed, people took to their bicycles straight away, and the vans that served the shops moved their rounds to the early morning.',
      sources: [{ n: 2, quote: 'the street became a river of bicycles overnight' }, { n: 9, quote: 'the number of vans in the centre at noon halved' }],
    },
    { claim: CLAIM_3, support: SUPPORT_3, sources: [{ n: 1, quote: 'footfall r' }, { n: 2, quote: 'fell by a third in the first year' }] },
  ],
};

const SOURCE_1 = { title: 'Car-free centres: what the evidence says', url: PAGE_1, retrieved_at: GOLDEN_RETRIEVED_AT, quote: 'retail footfall rise by eleven percent within two years' };
const SOURCE_2 = { title: 'Clean air and the school run', url: PAGE_2, retrieved_at: GOLDEN_RETRIEVED_AT, quote: 'fell by a third in the first year' };
/** The brief of the golden job, key for key in the order of the spec: the first argument and the page 2 quote of the third survive the check. */
export const GOLDEN_RESULT: AdvocateResult = {
  schema: 'vector.advocate.brief.v1',
  declared_bias: { side: 'for', statement: 'This brief argues one side only, by design, and omits counter-arguments.' },
  thesis: THESIS,
  arguments: [
    { claim: CLAIM_1, support: SUPPORT_1, sources: [SOURCE_1] },
    { claim: CLAIM_3, support: SUPPORT_3, sources: [SOURCE_2] },
  ],
  sources: [SOURCE_1, SOURCE_2],
  omitted_by_design: 'counter-arguments and rebuttals',
  search: 'Brave Search API',
  model: 'deepseek/deepseek-v4-flash via OpenRouter',
};

/** What runAdvocate gives back for the golden job: the brief and the counts the line of the job carries. */
export const GOLDEN_OUTCOME: RunOutcome = {
  result: GOLDEN_RESULT, pagesKept: 3, resultsFound: 7, usage: { prompt_tokens: 4321, completion_tokens: 512 }, dropped: { quotes: 3, arguments: 1 },
};

/** The answer of the model in the golden job: test/fixtures/model-answer.json. */
export const MODEL_ANSWER = fixture('model-answer.json');
const JSON_TYPE = { 'content-type': 'application/json' };
/** The answer of the model of the golden job, as a respond of a route. */
export const goldenAnswer = (): Response => reply(200, MODEL_ANSWER, JSON_TYPE);

/** The route of the model: the chat completions of OpenRouter. */
export const modelRoute = (respond: Route['respond']): Route => ({ match: at(OPENROUTER_ENDPOINT), respond });
/** A Brave Search answer that lists `results`. */
export const braveAnswer = (results: Array<Record<string, unknown>>): Response => reply(200, JSON.stringify({ query: { original: 'q' }, web: { results } }), JSON_TYPE);
/** The routes of the two queries of the golden request, both answered by `respond`: for a search that answers otherwise than the fixtures. */
export const braveAnswers = (respond: Route['respond']): Route[] => GOLDEN_QUERIES.map((query) => ({ match: braveQuery(query), respond }));
/** `routes`, with the URL of each call they answer recorded in `into`. */
export const recorded = (routes: readonly Route[], into: string[]): Route[] =>
  routes.map((route) => ({ match: route.match, respond: (url, init) => { into.push(url.href); return route.respond(url, init); } }));

/** What the fake fetch of the golden job was asked: the two queries and the key each carried, the pages, and each call of the model. */
export interface Seen { queries: string[]; braveKeys: Array<string | null>; pages: string[]; models: Array<{ headers: Headers; body: unknown }> }

/**
 * The fake fetch of the golden job: BRAVE_ROUTES for the two queries, PAGE_ROUTES for the seven pages, and the model answering with `model`
 * (model-answer.json by default). A call no route takes fails as a network error does (routedFetch).
 */
export function goldenFetch(model: Route['respond'] = goldenAnswer): { fetchImpl: RoutedFetch; seen: Seen } {
  const seen: Seen = { queries: [], braveKeys: [], pages: [], models: [] };
  const fetchImpl = routedFetch([
    ...BRAVE_ROUTES.map((route): Route => ({
      match: route.match,
      respond: (url, init) => {
        seen.queries.push(url.searchParams.get('q') ?? '');
        seen.braveKeys.push(new Headers(init?.headers).get('x-subscription-token'));
        return route.respond(url, init);
      },
    })),
    ...recorded(PAGE_ROUTES, seen.pages),
    modelRoute((url, init) => {
      seen.models.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return model(url, init);
    }),
  ]);
  return { fetchImpl, seen };
}
