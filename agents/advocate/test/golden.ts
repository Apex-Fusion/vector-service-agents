// agents/advocate/test/golden.ts
// The golden job, shared by the run, the server and the spec page: the request of the spec page; the answers of the search, of the seven result pages, of the
// chat supplier on the marketplace and of OpenRouter, as the fixtures hold them; and every value of what the service must make of them, on its two paths. The
// search and the pages are served by the routes of test/fake-fetch.ts (BRAVE_ROUTES, PAGE_ROUTES), OpenRouter by modelRoute here, and the marketplace by
// test/fake-chain-support.ts (a FakeChain, its indexer and its chat supplier). The pages are the three that fetchPages keeps, numbered in the order of the
// results, with the text the service reads from the fixture files. The brief is the model's answer after the post-check, every value written out; the chat
// supplier answers with the same brief as OpenRouter does, so the two paths give the same arguments and differ in `model` and `inference` alone. The sub-job of
// the marketplace path was computed from the stub supplier alone (what it signs for the input the service must send), not from a run of the code under test.
// The keys are made at run time from a label, so that none is written in the repository.
import { createHash } from 'node:crypto';
import { EXCERPT_CHARS, collapseWhitespace, extractText } from '../src/html.ts';
import { OPENROUTER_ENDPOINT } from '../src/model.ts';
import type { ModelBrief } from '../src/model.ts';
import type { Page } from '../src/pages.ts';
import type { AdvocateResult } from '../src/result.ts';
import type { RunOutcome } from '../src/run.ts';
import { market } from './fake-chain-support.ts';
import type { Market } from './fake-chain-support.ts';
import { BRAVE_ROUTES, GOLDEN_QUERIES, GOLDEN_RESULTS, GOLDEN_SUBJECT, PAGE_ROUTES, at, braveQuery, fixture, reply, routedFetch } from './fake-fetch.ts';
import type { Route, RoutedFetch } from './fake-fetch.ts';

/** Keys in the forms of the two services, made at run time from a label. */
export const TEST_BRAVE_KEY = `BSA${createHash('sha256').update('advocate test: the Brave Search API key').digest('hex').slice(0, 28)}`;
export const TEST_OPENROUTER_KEY = `sk-or-v1-${createHash('sha256').update('advocate test: the OpenRouter API key').digest('hex')}`;
/** The wait of the search in a test: it returns at once, so that the two queries are not 1100 ms of real time apart. */
export const noWait = async (_ms: number, _signal?: AbortSignal): Promise<void> => undefined;

/** The clock of the golden job: every page is fetched at this time (ruling R-E14: the ISO time with its milliseconds), before the hire moves it on. */
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

/** The answer of the model in the golden job: test/fixtures/model-answer.json. */
export const MODEL_ANSWER = fixture('model-answer.json');
/** The text of that answer, which the chat supplier on the marketplace gives back as its output text. */
export const MODEL_ANSWER_TEXT = (JSON.parse(MODEL_ANSWER) as { choices: Array<{ message: { content: string } }> }).choices[0].message.content;

const SOURCE_1 = { title: 'Car-free centres: what the evidence says', url: PAGE_1, retrieved_at: GOLDEN_RETRIEVED_AT, quote: 'retail footfall rise by eleven percent within two years' };
const SOURCE_2 = { title: 'Clean air and the school run', url: PAGE_2, retrieved_at: GOLDEN_RETRIEVED_AT, quote: 'fell by a third in the first year' };

/** The escrow the golden hire opens on the FakeChain (its first Post), and the key of the stub chat supplier. */
const GOLDEN_ESCROW = 'e3b87652a5a3234ad03cbdad5e9e34ebd2c6d3b063bbf168e615c29ca225afce#0';
const CHAT_SUPPLIER_PKH = 'bf76c61ab0368b17de63c36c3460eb943cb618ab18b57903c212025b';
/** The chat sub-job of the golden job: the receipt and signature as the stub supplier gives them, and the seven checks, every one passed. */
export const GOLDEN_SUB_JOB = {
  capability_id: 'llm.text.generate.v1',
  advert_ref: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2#1',
  escrow_ref: GOLDEN_ESCROW,
  supplier_pkh: CHAT_SUPPLIER_PKH,
  receipt: {
    escrow_ref: GOLDEN_ESCROW,
    supplier_pkh: CHAT_SUPPLIER_PKH,
    prompt_hash: '5895ab2d7847be7366c185709e57a974d6a7bb5a060ee0acd5a2b23db41c4a21',
    response_hash: '96d87c0a747046250fa57afb65d2ec5c50530ae85d4a49d31831c6ed753c39ed',
    model: 'deepseek/deepseek-v4-flash',
    prompt_tokens: 4321,
    completion_tokens: 512,
    wallclock_ms: 1830,
  },
  receipt_signature: '0cafdf0a8cfbccace4089baf9ce74dde37b2bda63c830eb09a4fab1a3f52794b344d64a8987f5831d8e89701fcf3d4fa2ef72e63e50023f82b429ee8bf51ee04',
  verification: {
    escrow_ref_matches: true, response_hash_matches: true, supplier_key_matches: true, signature_valid: true, on_chain_hash_matches: true, prompt_hash_matches: true,
    model_matches: true,
  },
};

/** The brief of the golden job on the marketplace path, key for key in the order of the spec: the first argument and the page 2 quote of the third survive the check. */
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
  model: 'deepseek/deepseek-v4-flash via the Vector marketplace',
  inference: { path: 'marketplace', fallback_from: null, sub_job: GOLDEN_SUB_JOB, accepted: 'confirmed' },
};

/** What runAdvocate gives back for the golden job on the marketplace path: the brief and the counts the line of the job carries. */
export const GOLDEN_OUTCOME: RunOutcome = {
  result: GOLDEN_RESULT, pagesKept: 3, resultsFound: 7, usage: { prompt_tokens: 4321, completion_tokens: 512 }, dropped: { quotes: 3, arguments: 1 },
  inference: { path: 'marketplace', model: 'deepseek/deepseek-v4-flash', subJob: GOLDEN_SUB_JOB, accepted: 'confirmed', fallbackFrom: null },
};

/** The brief of the golden job on the fallback: the indexer lists no chat supplier, and the call is made through OpenRouter. */
export const GOLDEN_FALLBACK_RESULT: AdvocateResult = {
  ...GOLDEN_RESULT,
  model: 'deepseek/deepseek-v4-flash via OpenRouter',
  inference: { path: 'openrouter', fallback_from: 'llm_supplier_unavailable', sub_job: null, accepted: null },
};

/** What runAdvocate gives back for the golden job on the fallback. */
export const GOLDEN_FALLBACK_OUTCOME: RunOutcome = {
  ...GOLDEN_OUTCOME,
  result: GOLDEN_FALLBACK_RESULT,
  inference: { path: 'openrouter', model: 'deepseek/deepseek-v4-flash', subJob: null, accepted: null, fallbackFrom: 'llm_supplier_unavailable' },
};

/** The marketplace of the golden job: the FakeChain at GOLDEN_T0, its indexer, and the chat supplier answering with the golden brief. */
export const goldenMarket = (opts: Omit<Parameters<typeof market>[0], 't0' | 'answer'> = {}): Market => market({ t0: GOLDEN_T0, answer: MODEL_ANSWER_TEXT, ...opts });

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
 * The fake fetch of the golden job: BRAVE_ROUTES for the two queries, PAGE_ROUTES for the seven pages, the model answering with `model` (model-answer.json by
 * default), and the routes of `more` (the indexer and the chat supplier of a marketplace). A call no route takes fails as a network error does (routedFetch).
 */
export function goldenFetch(model: Route['respond'] = goldenAnswer, more: readonly Route[] = []): { fetchImpl: RoutedFetch; seen: Seen } {
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
    ...more,
  ]);
  return { fetchImpl, seen };
}
