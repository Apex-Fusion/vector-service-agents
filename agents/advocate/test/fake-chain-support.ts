// agents/advocate/test/fake-chain-support.ts
// The Vector marketplace the tests of the inference run against, all in memory, as the Document Pipeline's tests have theirs (agents/document-pipeline/test/stub-suppliers.ts): a
// FakeChain of @vsa/buyer-core that holds the advert of one chat supplier, an indexer that lists it, and that supplier speaking the fleet's Responses protocol through the routes
// of test/fake-fetch.ts. The supplier is the model supplier of @vsa/hire-kit/testing, in the world of these tests: it plays its own part of the escrow on the FakeChain, the Claim
// when it takes a job (markClaimed) and the Submit when it finishes one (markSubmitted, with the hash of the receipt it signed), and signs its receipts with the real commitment
// functions and a key made from fixed bytes: Ed25519 signs deterministically, so every run gives the same receipt, and the golden sub-job of test/golden.ts is pinned byte for
// byte. It can be told to misbehave the ways the tests of the fallback rule need: answer busy, answer that it does not see the escrow, lose a send before or after its Claim,
// refuse, fail the job, forget the job, fail its own Submit, sign with another key, sign token counts that are not counts, answer with a body the service cannot read, or an
// answer that is cut or is no brief. No test touches the network, DNS or a chain: the endpoint of the supplier is an https IP literal of the documentation range 203.0.113.0/24,
// which safeFetch takes as public without a host lookup, and the indexer is read with the injected fetch as it is.
import { INDEXER, marketplace, stubWorld } from '@vsa/hire-kit/testing';
import type { StubModelSupplier } from '@vsa/hire-kit/testing';
import type { FakeChain, FakeChainOptions } from '@vsa/buyer-core';
import type { AdvertDatum } from '@vsa/vector-read';
import type { Route } from './fake-fetch.ts';

export { INDEXER, LLM_ADVERT_REF as CHAT_ADVERT_REF, LLM_CAPABILITY as CHAT_CAPABILITY, LLM_ENDPOINT as CHAT_ENDPOINT, LLM_MODEL as CHAT_MODEL, stubKey } from '@vsa/hire-kit/testing';
export type { PollStep, StubKey } from '@vsa/hire-kit/testing';

/** The window of the flash adverts on the indexer of 2026-10-19: deliver_by is posted_at + 3600000 + 180000. */
export const WINDOW_MS = 3_600_000;
/** The tokens the supplier's receipt names, the same as the usage of the OpenRouter answer of the golden job. */
export const RECEIPT_TOKENS = { prompt_tokens: 4321, completion_tokens: 512 };

/** The world of the tests of the inference: its prefix, the label of its keys, its window, the counts of its receipts and the day its supplier was last seen. */
const world = stubWorld({
  prefix: 'advocate-test/', label: 'advocate test', windowMs: WINDOW_MS, lastSeen: '2026-10-19T08:00:00.000Z',
  chatReceipt: { promptTokens: RECEIPT_TOKENS.prompt_tokens, completionTokens: RECEIPT_TOKENS.completion_tokens, wallclockMs: 1830 },
});
/** The escrow the n-th Post opens (from 1): FakeChain's refs are sha256(prefix + n)#0. */
export const { escrowNo, indexerRow } = world;
export const CHAT_KEY = world.llmKey;
/** Not the key of the advert: what a forged receipt is signed with. */
export const FORGER_KEY = world.forgerKey;

/** The advert of the chat supplier, with the fields a test changes. */
export const chatAdvert = (over: Partial<AdvertDatum> = {}): AdvertDatum => ({ ...world.llmAdvert, ...over });

/** The chat supplier of the advert, on the Responses API of the fleet. */
export type ChatSupplier = StubModelSupplier;

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface Market {
  /** The time of the FakeChain, in POSIX milliseconds; the tests give the run the same clock. */
  clock: { now: number };
  chain: FakeChain;
  supplier: ChatSupplier;
  /** What the indexer lists at /suppliers. A test may change it before the run. */
  rows: Array<Record<string, unknown>>;
  /** The routes of the indexer and of the supplier, for the fetch of the test. */
  routes: Route[];
  /** Every pause the hire asked for; each moves the clock on by its length. */
  sleeps: number[];
  sleep: (ms: number) => Promise<void>;
}

/**
 * The FakeChain (the advert of the chat supplier, the clock at `t0`), the indexer listing it free, and the supplier, answering the golden brief `answer`.
 * `advert` replaces the datum of the advert, on the chain and in the indexer's row alike.
 */
export function market(opts: Pick<FakeChainOptions, 'floatLovelace' | 'collateralLovelace' | 'lockLovelace'> & { t0: number; answer: string; advert?: AdvertDatum }): Market {
  const { t0, answer, advert = chatAdvert(), ...chainOpts } = opts;
  const shared = marketplace({ ...chainOpts, world, listed: ['llm'], llmAdvert: advert, t0 });
  const supplier = shared.llm;
  supplier.answer = answer;
  const sleeps: number[] = [];
  const mine = (url: URL): boolean => url.origin === supplier.endpoint;
  const methodOf = (init?: RequestInit): string => init?.method ?? 'GET';
  const header = (init?: RequestInit): string => new Headers(init?.headers).get('x-escrow-ref') ?? '';
  const routes: Route[] = [
    { match: (url, init) => url.origin === INDEXER && methodOf(init) === 'GET' && url.pathname === '/suppliers', respond: () => json(200, shared.rows) },
    { match: (url, init) => mine(url) && methodOf(init) === 'GET' && url.pathname === '/capability', respond: () => supplier.handle('GET', '/capability', null, '') },
    { match: (url, init) => mine(url) && methodOf(init) === 'GET' && url.pathname === '/status', respond: () => supplier.handle('GET', '/status', null, '') },
    { match: (url, init) => mine(url) && init?.method === 'POST' && url.pathname === '/v1/responses', respond: (_url, init) => supplier.handle('POST', '/v1/responses', header(init), String(init?.body ?? '')) },
    { match: (url, init) => mine(url) && methodOf(init) === 'GET' && url.pathname.startsWith('/v1/responses/'), respond: (url) => supplier.handle('GET', url.pathname, null, '') },
  ];
  return { clock: shared.clock, chain: shared.chain, supplier, rows: shared.rows, routes, sleeps, sleep: async (ms) => { sleeps.push(ms); shared.clock.now += ms; } };
}
