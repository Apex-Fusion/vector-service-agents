// agents/advocate/test/server.test.ts
// The manifest the service publishes and what is the service's own on the HTTP surface of packages/service-kit: the fields of the manifest, its limits read
// from the code, its gaps, notes and behaviour, the buyer key hash it publishes, the request schema held to the intake on a table, the template file; the
// three routes and the token; the golden job over HTTP on its two paths, the marketplace and the fallback, with its one line in the log; the refusals of the
// intake and of a job with their statuses; the deadline and the signal set on arrival; the interim lines of the kit while a job runs; a caller that hangs up,
// whose job is stopped and whose slot is freed, and one that hangs up during the hop, whose hop ends on its own terms first; and a stranded store that cannot
// be written, after which the marketplace path is off. The generic behaviour of the surface (the slot, the body cap, the refusal log) is tested in
// packages/service-kit.
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import Ajv from 'ajv';
import { afterEach, describe, test, expect, vi } from 'vitest';
import { operatorsText } from '@vsa/service-kit';
import { REGISTRY_ADDRESS } from '@vsa/vector-read';
import { JOB_DEADLINE_MS, PAGE_TIMEOUT_MS } from '../src/budget.ts';
import { AdvocateError, JOB_STATUS } from '../src/errors.ts';
import type { JobCode } from '../src/errors.ts';
import { DEADLINE_GAP, INPUT_GAP, ONE_SIDED_GAP, PAGES_GAP, QUOTE_GAP, SEARCH_GAP, SUPPLIERS_GAP, gapsFor, modelGap } from '../src/gaps.ts';
import { EXCERPT_CHARS, MIN_PAGE_CHARS } from '../src/html.ts';
import { HopFailed } from '../src/inference.ts';
import { DEFAULT_MODEL } from '../src/model.ts';
import { PAGE_MAX_BYTES } from '../src/pages.ts';
import { DECLARED_BIAS_STATEMENT, OMITTED_BY_DESIGN, QUOTE_MAX_CHARS, QUOTE_MIN_CHARS } from '../src/prompt.ts';
import { DEFAULT_LANGUAGE, DEFAULT_LENGTH, MAX_AUDIENCE_CHARS, MAX_SIDE_CHARS, MAX_SUBJECT_CHARS, RequestError, parseRequest } from '../src/request.ts';
import type { RunDeps } from '../src/run.ts';
import { MAX_RESULTS } from '../src/search.ts';
import { JobSlot, MIN_PROCESSING_WINDOW_MS, TEMPLATE_ENV, manifestFromEnv, renderTemplate } from '../src/server.ts';
import type { ServerOptions } from '../src/server.ts';
import { INDEXER, escrowNo } from './fake-chain-support.ts';
import type { Market } from './fake-chain-support.ts';
import { never } from './fake-fetch.ts';
import {
  GOLDEN_FALLBACK_RESULT, GOLDEN_OUTCOME, GOLDEN_REQUEST, GOLDEN_RESULT, GOLDEN_T0, TEST_BRAVE_KEY, TEST_OPENROUTER_KEY, goldenAnswer, goldenFetch, goldenMarket,
} from './golden.ts';
import { BUYER, FULL_ENV, SUPPLIER, T0, TEST_AUTH, TEST_CONTACT, baseDeps, cleanDirs, serve, until, wire } from './server-support.ts';

afterEach(() => { vi.restoreAllMocks(); cleanDirs(); });

// The ledger's native unit is named once in the repository, in docs/HIRE.md. Spelled in two parts, so that a search for the name finds only the guide.
const UNIT_NAME = new RegExp('AP' + '3X', 'i');
const MANIFEST = manifestFromEnv({ ...FULL_ENV, ADVOCATE_BUYER_PKH: BUYER.pkh });
const SPEC_URL = 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/advocate.md';
const logs: string[] = [];
const log = (line: string): void => { logs.push(line); };
afterEach(() => { logs.length = 0; });
type Run = NonNullable<ServerOptions['runAdvocate']>;
const options = (over: Partial<ServerOptions> = {}): Omit<ServerOptions, 'authHeader'> => ({ manifest: MANIFEST, deps: baseDeps({ log }), log, ...over });
/** The deps of the golden job with its marketplace path off: its fetch, its clock that does not move, and the log of the test. */
const goldenDeps = (fetchImpl: typeof fetch): Omit<RunDeps, 'deadlineMs' | 'signal'> => baseDeps({ fetchImpl, clock: () => GOLDEN_T0, log });
/** The deps of the golden job on the marketplace `m`: its chain, its clock and its sleep, its indexer, and the fetch of the golden job with the routes of `m`. */
const marketDeps = (m: Market, over: Partial<Omit<RunDeps, 'deadlineMs' | 'signal'>> = {}): Omit<RunDeps, 'deadlineMs' | 'signal'> => baseDeps({
  fetchImpl: goldenFetch(goldenAnswer, m.routes).fetchImpl, clock: () => m.clock.now, sleep: m.sleep, chain: m.chain, buyerPkh: m.chain.buyerPkh, indexerUrl: INDEXER,
  marketplace: { on: true }, log, ...over,
});
/** The brief of the golden job with the marketplace path off, as the deps of baseDeps have it: from OpenRouter at once. */
const OFF_RESULT = { ...GOLDEN_FALLBACK_RESULT, inference: { ...GOLDEN_FALLBACK_RESULT.inference, fallback_from: 'marketplace_off' } };
/** A request written on a raw socket, as the runtime's fetch writes it, so that a test can hang up or read the interim lines. */
const rawPost = (body: string): string =>
  ['POST / HTTP/1.1', 'Host: 127.0.0.1', 'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, `Authorization: ${TEST_AUTH}`, 'Connection: close', '', ''].join('\r\n') + body;

describe('manifest', () => {
  test('a full environment gives every field of the manifest, in the order the design gives them', () => {
    expect(Object.keys(MANIFEST)).toStrictEqual(['schema', 'name', 'capability_id', 'version', 'description', 'operator', 'identity', 'keys', 'interface', 'terms', 'behaviour', 'status', 'gaps', 'links']);
    expect(MANIFEST).toStrictEqual({
      schema: 'vector.agent-manifest.v1',
      name: 'Advocate',
      capability_id: 'research.advocate.onesided.v1',
      version: '0.1.0',
      description: 'The strongest one-sided brief for a position, with citations: it argues one side only, by design, omits counter-arguments, and says so in every output.',
      operator: { name: 'Apex Fusion Foundation', contact: TEST_CONTACT },
      identity: { did: 'did:test', controller_pkh: SUPPLIER.pkh, registry_address: REGISTRY_ADDRESS },
      keys: { supplier_pkh: SUPPLIER.pkh, pub_key_hex: SUPPLIER.pubKeyHex, buyer_pkh: BUYER.pkh },
      interface: {
        request_schema: MANIFEST.interface.request_schema, // held against the intake below
        response_schema: { $ref: `${SPEC_URL}#response` },
        routes: { job: '/v1/job', status: '/status', capability: '/capability' },
        notes: MANIFEST.interface.notes, // held against the code below
      },
      terms: {
        price_lovelace: 3_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 480_000,
        input_limits: { request_bytes: 900_000, subject_chars: 300, side_chars: 120, audience_chars: 200, results: 12, page_bytes: 1_048_576, excerpt_chars: 12_000, quote_chars_min: 20, quote_chars_max: 300 },
      },
      behaviour: {
        declared_bias: { statement: 'This brief argues one side only, by design, and omits counter-arguments.', omitted: 'counter-arguments and rebuttals' },
        data_handling: 'The subject, the side, the audience, the length and the language are held in memory while a job runs, with the pages the service fetches, and none of them is kept after the job. '
          + 'The service writes only the bookkeeping of the escrows it posts (references, times, the hop, a transaction hash) to its state directory, and nothing else to disk. '
          + 'The two search queries go to the Brave Search API, each page fetch to the host of that page, and the prompt (the subject, the side, the audience, the language and the length, and the titles, URLs and excerpts of the fetched pages) '
          + 'to the chat supplier the service hires on the Vector marketplace and the model provider behind it, or, only when that hire fails, to OpenRouter and the model provider behind it. '
          + 'On the ledger the escrow of the job carries only the sha256 of the wire payload and the escrow of the chat sub-job only a sha256 commitment to its input, and the request stays off the ledger. '
          + 'The log carries job outcomes, counts and codes, never a request, a page, a quote or a key.',
        third_parties: [
          'Brave Search API (the two search queries)',
          'the hosts of the result pages (the fetch of each page)',
          'a chat supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it (the prompt: the subject, the side, the audience, the language and the length, and the titles, URLs and excerpts of the fetched pages)',
          'OpenRouter and the model provider behind it (the same prompt), only when that hire fails',
        ],
      },
      status: { chip: 'proposed', since: '2026-10-13' },
      gaps: [...gapsFor('deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash')],
      links: { spec: SPEC_URL, source: 'https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/advocate', explorer_advert: '' },
    });
    expect(Object.keys(MANIFEST.behaviour)).toStrictEqual(['declared_bias', 'data_handling', 'third_parties']);
  });

  test('the data handling and the third parties name what the prompt carries in one list (R-E32), the list of the third parties (R-E27, R-F12), and the store as the one thing on disk', () => {
    const list = /^a chat supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it [(]the prompt: (.+)[)]$/.exec(MANIFEST.behaviour.third_parties[2])?.[1] ?? '';
    expect(list).toBe('the subject, the side, the audience, the language and the length, and the titles, URLs and excerpts of the fetched pages');
    expect(MANIFEST.behaviour.data_handling).toContain(`, and the prompt (${list}) to the chat supplier the service hires on the Vector marketplace`);
    expect(MANIFEST.behaviour.data_handling.split('OpenRouter')).toHaveLength(2);
    expect(MANIFEST.behaviour.data_handling).toContain('The service writes only the bookkeeping of the escrows it posts (references, times, the hop, a transaction hash) to its state directory, and nothing else to disk.');
    expect(MANIFEST.behaviour.third_parties[3]).toBe('OpenRouter and the model provider behind it (the same prompt), only when that hire fails');
  });

  test('the declared bias of the manifest is the one every brief carries, read from the code that writes it', () => {
    expect(MANIFEST.behaviour.declared_bias).toStrictEqual({ statement: DECLARED_BIAS_STATEMENT, omitted: OMITTED_BY_DESIGN });
    expect(GOLDEN_RESULT.declared_bias.statement).toBe(MANIFEST.behaviour.declared_bias.statement);
    expect(GOLDEN_RESULT.omitted_by_design).toBe(MANIFEST.behaviour.declared_bias.omitted);
  });

  test('the limits are the numbers the code enforces, read from it, and the window holds the deadline and the runtime timeout (R-F2)', () => {
    expect(MANIFEST.terms.input_limits).toStrictEqual({
      request_bytes: 900_000, subject_chars: MAX_SUBJECT_CHARS, side_chars: MAX_SIDE_CHARS, audience_chars: MAX_AUDIENCE_CHARS, results: MAX_RESULTS,
      page_bytes: PAGE_MAX_BYTES, excerpt_chars: EXCERPT_CHARS, quote_chars_min: QUOTE_MIN_CHARS, quote_chars_max: QUOTE_MAX_CHARS,
    });
    expect(MIN_PROCESSING_WINDOW_MS).toBe(480_000);
    // The runtime's SERVICE_TIMEOUT_MS, 360000, is 60 s after the deadline of a job, and the runtime boots only with it at least 60 s inside the window.
    expect(JOB_DEADLINE_MS + 60_000).toBe(360_000);
    expect(360_000).toBeLessThanOrEqual(MIN_PROCESSING_WINDOW_MS - 60_000);
  });

  test('without the identity the keys are empty strings; the supplier key hash is both controller and supplier, and the buyer key hash is published beside them', () => {
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT }).keys).toStrictEqual({ supplier_pkh: '', pub_key_hex: '', buyer_pkh: '' });
    const m = manifestFromEnv({ ...FULL_ENV, SUPPLIER_PKH: 'ab'.repeat(28), AGENT_DID: 'did:vector:agent:x:y', ADVOCATE_BUYER_PKH: 'cd'.repeat(28) });
    expect([m.identity.did, m.identity.controller_pkh, m.keys.supplier_pkh, m.keys.buyer_pkh]).toStrictEqual(['did:vector:agent:x:y', 'ab'.repeat(28), 'ab'.repeat(28), 'cd'.repeat(28)]);
  });

  test('agent.json.template is the manifest with a placeholder for each of the five fields the operator supplies, byte for byte what renderTemplate prints', () => {
    const file = readFileSync(new URL('../agent.json.template', import.meta.url), 'utf8');
    expect(JSON.parse(file)).toStrictEqual(manifestFromEnv(TEMPLATE_ENV));
    expect(file).toBe(renderTemplate());
    expect(file.endsWith('}\n')).toBe(true);
    expect(file).not.toContain('\r');
    expect(file.match(/<[A-Z_]+>/g)?.sort()).toStrictEqual(['<ADVOCATE_BUYER_PKH>', '<AGENT_DID>', '<OPERATOR_CONTACT>', '<SUPPLIER_PKH>', '<SUPPLIER_PKH>', '<SUPPLIER_PUB_KEY_HEX>']);
    expect(/^[\x20-\x7e\n]*$/.test(file)).toBe(true);
  });

  test('GET /agent.json serves exactly the bytes JSON.stringify gives for the manifest', async () => {
    await serve(options(), async (api) => {
      const r = await api.get('/agent.json');
      expect([r.status, r.headers.get('content-type'), r.text]).toStrictEqual([200, 'application/json', JSON.stringify(MANIFEST)]);
    });
  });

  test('OPERATOR_CONTACT is required, and no address is built into the code', () => {
    for (const v of [undefined, '', ' ']) expect(() => manifestFromEnv(v === undefined ? {} : { OPERATOR_CONTACT: v }), JSON.stringify(v)).toThrow(/^environment variable OPERATOR_CONTACT is required/);
    expect(JSON.stringify(manifestFromEnv({ OPERATOR_CONTACT: 'a role' }))).not.toMatch(/@/);
    for (const file of ['server.ts', 'start.ts', 'gaps.ts', 'index.ts', 'model.ts', 'prompt.ts', 'check.ts', 'result.ts', 'run.ts', 'inference.ts']) {
      expect(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), file).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]/);
    }
  });

  test('defaults: proposed since 2026-10-13, price 3 units, both bonds 1 unit, an 8 min window; a smaller window is refused, a larger one is used', () => {
    const m = manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT });
    expect([m.status, m.terms.price_lovelace, m.terms.max_processing_ms]).toStrictEqual([{ chip: 'proposed', since: '2026-10-13' }, 3_000_000, 480_000]);
    for (const bad of ['0', '300000', '479999']) {
      expect(() => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_MAX_PROCESSING_MS: bad }), bad).toThrow(/^environment variable ADVERT_MAX_PROCESSING_MS must be at least 480000 \(the window of 8 min that the deadline of a job, 300000 ms, assumes\), got \d+$/);
    }
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_MAX_PROCESSING_MS: '600000', ADVERT_PRICE_LOVELACE: '4000000' }).terms).toMatchObject({ price_lovelace: 4_000_000, max_processing_ms: 600_000 });
    for (const bad of ['two', '-1', '1.5']) expect(() => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_PRICE_LOVELACE: bad }), bad).toThrow(/ADVERT_PRICE_LOVELACE/);
  });

  test('AGENT_STATUS_CHIP: live, deployed or proposed in any case, carried in lower case, proposed by default; AGENT_STATUS_SINCE a date, 2026-10-13 by default', () => {
    const chip = (value?: string) => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ...(value === undefined ? {} : { AGENT_STATUS_CHIP: value }) }).status.chip;
    expect([chip(), chip(''), chip('Deployed'), chip('LIVE'), chip('proposed')]).toStrictEqual(['proposed', 'proposed', 'deployed', 'live', 'proposed']);
    for (const bad of ['built', 'proposed ', 'up']) expect(() => chip(bad), bad).toThrow(/AGENT_STATUS_CHIP/);
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, AGENT_STATUS_SINCE: '2026-11-02' }).status.since).toBe('2026-11-02');
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, AGENT_STATUS_SINCE: ' ' }).status.since).toBe('2026-10-13');
    for (const bad of ['yesterday', '2026-10-1']) expect(() => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, AGENT_STATUS_SINCE: bad }), bad).toThrow(/AGENT_STATUS_SINCE/);
  });

  test('AGENT_VERSION that is empty or blank is not set, and the version is 0.1.0; a value is published without the space around it', () => {
    for (const v of [undefined, '', ' ', '\n']) {
      expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ...(v === undefined ? {} : { AGENT_VERSION: v }) }).version, JSON.stringify(v)).toBe('0.1.0');
    }
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, AGENT_VERSION: ' 0.2.0\n' }).version).toBe('0.2.0');
  });

  test('ADVERT_EXPLORER_URL is published as the link of the advert, and that link is empty while it is not set', () => {
    const url = 'https://explorer.example.test/advert/1';
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_EXPLORER_URL: url }).links.explorer_advert).toBe(url);
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT }).links.explorer_advert).toBe('');
  });

  test('the gaps: eight sentences in order, word for word, each one line of plain text whose numbers are the code\'s, the fifth naming the model of each path, the sixth and the seventh what a hire on the marketplace is today (R-F12, R-F18, R-F19)', () => {
    expect(gapsFor(DEFAULT_MODEL, DEFAULT_MODEL)).toStrictEqual([ONE_SIDED_GAP, QUOTE_GAP, PAGES_GAP, SEARCH_GAP, modelGap(DEFAULT_MODEL, DEFAULT_MODEL), SUPPLIERS_GAP, INPUT_GAP, DEADLINE_GAP]);
    expect(ONE_SIDED_GAP).toBe('The brief argues one side only, by design: it leaves out counter-arguments and rebuttals, says so in declared_bias and omitted_by_design, and gives no balanced answer and no fairness guarantee.');
    expect(QUOTE_GAP).toBe('A quote in the brief was found in the text the service fetched from the source it names, which shows that the source says it, not that it is right; the receipt commits to the brief, not to the page text.');
    expect(PAGES_GAP).toBe('Only pages the service could fetch can be cited: a page that redirects, is not HTML or plain text, is over 1 MB, has under 200 characters of text, or does not answer within 15 s is dropped, and only the first 12000 characters of a page are read.');
    expect(SEARCH_GAP).toBe('The sources are what two Brave Search queries return, at most 12 pages: a subject the search covers thinly gives a thin brief, and a job that gets no usable page or no claim that survives the check fails with search_empty, no_sources or no_supported_claims and returns no brief.');
    expect(modelGap(DEFAULT_MODEL, DEFAULT_MODEL)).toBe('The model is deepseek/deepseek-v4-flash, bought from a chat supplier on the Vector marketplace, or through OpenRouter when that hire fails: its claims can be wrong even when their quotes are real, and the check reads quotes, not reasoning.');
    expect(SUPPLIERS_GAP).toBe("Every chat supplier on the Vector marketplace today is first-party, operated on the same side as this agent: a hire of one proves the path and is not an arm's-length transaction.");
    expect(INPUT_GAP).toBe("On the marketplace path the prompt is sent as one input string with no temperature, output-format or token-limit setting, so the shape of the answer depends on the supplier's model; the fallback path sets all three.");
    expect(DEADLINE_GAP).toBe('A job has a deadline of its own, 300000 ms after its request arrives: a job cut at the deadline fails with the code deadline and returns no result. A hire in its Accept at the deadline runs on, as the Pipeline\'s does.');
    expect(PAGES_GAP).toContain(`is over ${PAGE_MAX_BYTES / 1_048_576} MB, has under ${MIN_PAGE_CHARS} characters of text, or does not answer within ${PAGE_TIMEOUT_MS / 1000} s`);
    expect(PAGES_GAP).toContain(`only the first ${EXCERPT_CHARS} characters`);
    expect(SEARCH_GAP).toContain(`at most ${MAX_RESULTS} pages`);
    expect(DEADLINE_GAP).toContain(`${JOB_DEADLINE_MS} ms after its request arrives`);
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, OPENROUTER_MODEL: 'openai/gpt-4o-mini' }).gaps[4]).toBe(modelGap('openai/gpt-4o-mini', 'openai/gpt-4o-mini'));
    expect(() => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, OPENROUTER_MODEL: 'gpt' })).toThrow(/^environment variable OPENROUTER_MODEL must be the id of a model of OpenRouter/);
    for (const gap of [...gapsFor('openai/gpt-4o-mini', DEFAULT_MODEL), modelGap(DEFAULT_MODEL, DEFAULT_MODEL)]) {
      expect(gap).toMatch(/^[A-Za-z0-9].*\.$/);
      expect(gap).not.toMatch(/[\r\n\u{2013}\u{2014}]/u);
      expect(gap).not.toMatch(UNIT_NAME);
    }
  });

  test('the gap of the model names one model when the first of LLM_MODEL_ALLOWLIST is the model of OPENROUTER_MODEL, and the two when it is another, the market model first (R-F19)', () => {
    expect(modelGap('openai/gpt-4o-mini', DEFAULT_MODEL)).toBe('The model is openai/gpt-4o-mini, bought from a chat supplier on the Vector marketplace, or deepseek/deepseek-v4-flash through OpenRouter when that hire fails: its claims can be wrong even when their quotes are real, and the check reads quotes, not reasoning.');
    const gapOf = (env: NodeJS.ProcessEnv): string => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ...env }).gaps[4];
    // Not set, or naming the model of OPENROUTER_MODEL first: one model.
    expect(gapOf({})).toBe(modelGap(DEFAULT_MODEL, DEFAULT_MODEL));
    expect(gapOf({ LLM_MODEL_ALLOWLIST: ' deepseek/deepseek-v4-flash , openai/gpt-4o-mini' })).toBe(modelGap(DEFAULT_MODEL, DEFAULT_MODEL));
    // Another model first: both, the market model first and the model of OPENROUTER_MODEL second.
    expect(gapOf({ LLM_MODEL_ALLOWLIST: 'openai/gpt-4o-mini,deepseek/deepseek-v4-flash' })).toBe(modelGap('openai/gpt-4o-mini', DEFAULT_MODEL));
    expect(gapOf({ LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash', OPENROUTER_MODEL: 'openai/gpt-4o-mini' })).toBe('The model is deepseek/deepseek-v4-flash, bought from a chat supplier on the Vector marketplace, or openai/gpt-4o-mini through OpenRouter when that hire fails: its claims can be wrong even when their quotes are real, and the check reads quotes, not reasoning.');
    // A list that names no model is refused here as at the start.
    expect(() => gapOf({ LLM_MODEL_ALLOWLIST: ' , ' })).toThrow(/^environment variable LLM_MODEL_ALLOWLIST must name at least one model, as a comma-separated list$/);
  });

  test('the notes say what the schema cannot: the side, a letter or digit in the subject and the side, the language rule, the pages the service fetches itself, and the two paths of the model call', () => {
    expect(MANIFEST.interface.notes).toStrictEqual([
      'The side is for, against, or a position in words of at most 120 characters, and the brief argues that side alone; the subject and the side must each hold at least one letter or digit, and a request that breaks a rule of the intake is refused with bad_shape (400).',
      'The language is a code such as en or en-GB, 2 to 8 letters and optional hyphen-separated subtags of up to 8 letters or digits, at most 16 characters, en by default: the model is asked to write the brief in it, and the search is not told it.',
      'The service runs the search and fetches the result pages itself, at most 12 pages of at most 1048576 bytes each, and cites only what it could fetch: a quote that is not in the text of the page it names is dropped, and so is an argument left without one.',
      "The model call is bought first from a chat supplier on the Vector marketplace: the service posts a bonded escrow with its own buyer key, sends the prompt, verifies the supplier's signed receipt and accepts; only when that hire fails is the call made through OpenRouter, and the result says which path it took.",
    ]);
    for (const note of MANIFEST.interface.notes) expect(note).not.toMatch(/[\r\n\u{2013}\u{2014}]/u);
  });
});

describe('manifest: request_schema is what the intake accepts', () => {
  const schema = MANIFEST.interface.request_schema;
  const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
  const intake = (value: unknown): boolean => {
    try { parseRequest(JSON.stringify(value)); return true; } catch (e) { if (e instanceof RequestError) return false; throw e; }
  };
  const req = (over: Record<string, unknown> = {}) => ({ subject: 'Should a city ban cars from its centre?', side: 'for', ...over });
  const without = (key: string) => { const value: Record<string, unknown> = req(); delete value[key]; return value; };
  const CASES: Array<[string, unknown]> = [
    // the shapes the spec shows
    ['the example of the spec', { subject: 'Should a city ban cars from its centre?', side: 'for', length: 'short', language: 'en' }],
    ['the subject and the side alone', req()],
    ['against', req({ side: 'against' })],
    ['a position in words', req({ side: 'only on weekdays, with deliveries before ten' })],
    ['a side with the space a hand leaves around it', req({ side: '  for  ' })],
    ['an audience', req({ audience: 'a city council' })],
    ['every field', req({ audience: 'a city council', length: 'standard', language: 'hr' })],
    ['length short', req({ length: 'short' })],
    ['length standard', req({ length: 'standard' })],
    // the object itself
    ['an unknown key', req({ extra: 1 })],
    ['no subject', without('subject')],
    ['no side', without('side')],
    ['an empty object', {}],
    ['an array', []],
    ['null', null],
    ['text', 'a request'],
    // the subject
    ['a subject of 300 characters', req({ subject: 'a'.repeat(300) })],
    ['a subject of 301 characters', req({ subject: 'a'.repeat(301) })],
    ['a subject of 300 characters outside the BMP', req({ subject: '\u{1F600}'.repeat(299) + 'a' })],
    ['an empty subject', req({ subject: '' })],
    ['a subject that is a number', req({ subject: 5 })],
    ['a subject that is null', req({ subject: null })],
    ['a subject that is a list', req({ subject: ['a subject'] })],
    // the side
    ['a side of 120 characters', req({ side: 's'.repeat(120) })],
    ['a side of 121 characters', req({ side: 's'.repeat(121) })],
    ['an empty side', req({ side: '' })],
    ['a side that is a number', req({ side: 1 })],
    ['a side that is true', req({ side: true })],
    ['a side that is null', req({ side: null })],
    // the audience
    ['an audience of 200 characters', req({ audience: 'a'.repeat(200) })],
    ['an audience of 201 characters', req({ audience: 'a'.repeat(201) })],
    ['an empty audience', req({ audience: '' })],
    ['a blank audience', req({ audience: '   ' })],
    ['an audience of white space of every kind', req({ audience: ' \t\n\r\u{a0}\u{3000}\u{feff}' })],
    ['an audience of one mark', req({ audience: '?' })],
    ['an audience that is a number', req({ audience: 5 })],
    ['an audience that is null', req({ audience: null })],
    // the length
    ...['long', 'Short', 'STANDARD', '', 3, null].map((l): [string, unknown] => [`length ${JSON.stringify(l)}`, req({ length: l })]),
    // the language
    ...['en', 'EN', 'de', 'hr', 'en-GB', 'zh-Hant-TW', 'es-419', 'yue', 'haw', 'abcdefgh', 'zh-Hant-TW-abcde'].map((l): [string, unknown] => [`language ${l}`, req({ language: l })]),
    ...['', 'e', 'abcdefghi', 'en_GB', '1en', 'en-', 'en-abcdefghi', 'zh-Hant-TW-abcdef', 'auto', 'AUTO', 5, null].map((l): [string, unknown] => [`language ${JSON.stringify(l)}`, req({ language: l })]),
  ];

  test("the schema compiles in strict mode, and its defaults are the intake's", () => {
    expect(schema).toMatchObject({ type: 'object', required: ['subject', 'side'], additionalProperties: false });
    expect(Object.keys(schema.properties)).toStrictEqual(['subject', 'side', 'audience', 'length', 'language']);
    expect([schema.properties.length.default, schema.properties.language.default]).toStrictEqual([DEFAULT_LENGTH, DEFAULT_LANGUAGE]);
    expect(parseRequest(JSON.stringify(req()))).toMatchObject({ length: schema.properties.length.default, language: schema.properties.language.default, audience: null });
  });

  test.each(CASES)('agrees with parseRequest on: %s', (_label, value) => {
    expect(validate(JSON.parse(JSON.stringify(value))), JSON.stringify(validate.errors)).toBe(intake(value));
  });

  test('the table has both answers in good number, so agreement is not agreement about nothing', () => {
    const accepted = CASES.filter(([, value]) => intake(value)).length;
    expect(accepted).toBeGreaterThan(20);
    expect(CASES.length - accepted).toBeGreaterThan(35);
  });

  test('the space a hand leaves around a value: the intake reads the value trimmed, and the schema, which gives the language in its plain form, refuses it there and takes it around free text', () => {
    for (const value of [req({ language: ' en' }), req({ language: 'en\n' })]) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
      expect(intake(value), JSON.stringify(value)).toBe(true);
    }
    // A side and an audience are free text, which the schema bounds by its length (and an audience by one character that is not white space, R-E34), as the
    // table holds for a side of '  for  ' and the notes test for a side of spaces: the schema takes the space around them, and the intake reads them trimmed.
    for (const value of [req({ side: ' against ' }), req({ audience: ' the council ' })]) {
      expect(validate(value), JSON.stringify(value)).toBe(true);
      expect(intake(value), JSON.stringify(value)).toBe(true);
    }
    // The length is the one value the intake takes in its plain form only (ruling R-E21): a space around it is refused by both.
    for (const value of [req({ length: ' short' }), req({ length: 'standard\n' })]) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
      expect(intake(value), JSON.stringify(value)).toBe(false);
    }
  });

  test('what the notes say and a schema cannot: a subject or a side without a letter or digit; the intake refuses them, and the schema lets them through', () => {
    for (const value of [req({ subject: '?!' }), req({ subject: ' ' }), req({ side: '...' }), req({ side: '   ' })]) {
      expect(validate(value), JSON.stringify(value)).toBe(true);
      expect(() => parseRequest(JSON.stringify(value)), JSON.stringify(value)).toThrow(expect.objectContaining({ code: 'bad_shape', status: 400 }));
    }
  });
});

describe('the routes and the token', () => {
  test('the three routes: /healthz always ok, for the service has no health check of its own; /agent.json the manifest; POST / the job; anything else 404', async () => {
    const { fetchImpl } = goldenFetch();
    await serve(options({ deps: goldenDeps(fetchImpl) }), async (api) => {
      const health = await api.get('/healthz');
      expect([health.status, health.json]).toStrictEqual([200, { ok: true }]);
      expect((await api.get('/agent.json')).text).toBe(JSON.stringify(MANIFEST));
      expect((await api.post(wire(GOLDEN_REQUEST))).status).toBe(200);
      expect((await api.get('/healthz')).json).toStrictEqual({ ok: true });
      for (const [method, path] of [['GET', '/'], ['GET', '/v1/job'], ['POST', '/v1/job'], ['POST', '/?x=1'], ['PUT', '/']]) {
        const r = await api.request(method, path, method === 'GET' ? undefined : wire(GOLDEN_REQUEST));
        expect([r.status, r.json], `${method} ${path}`).toStrictEqual([404, { error: 'not_found' }]);
      }
    });
  });

  test('POST / without the token of the runtime, or with another value, is a 401 and no job runs; the open routes need none', async () => {
    const run = vi.fn<Run>();
    await serve(options({ runAdvocate: run }), async (api) => {
      expect((await api.request('POST', '/', wire(GOLDEN_REQUEST), { authorization: null })).status).toBe(401);
      expect((await api.request('POST', '/', wire(GOLDEN_REQUEST), { authorization: `Bearer ${TEST_OPENROUTER_KEY}` })).status).toBe(401);
      expect((await api.request('GET', '/healthz', undefined, { authorization: null })).status).toBe(200);
      expect((await api.request('GET', '/agent.json', undefined, { authorization: 'Bearer wrong' })).status).toBe(200);
    });
    expect(run).not.toHaveBeenCalled();
    expect(TEST_AUTH).toMatch(/^Bearer [0-9a-f]{64}$/);
  });
});

describe('POST /: the job and its refusals', () => {
  test('the golden job on the marketplace over HTTP: 200 with JSON.stringify of the brief, byte for byte, and one line in the log with its counts and its path, and no word of the job', async () => {
    const m = goldenMarket();
    await serve(options({ deps: marketDeps(m) }), async (api) => {
      const r = await api.post(wire(GOLDEN_REQUEST));
      expect([r.status, r.headers.get('content-type')]).toStrictEqual([200, 'application/json']);
      expect(r.text).toBe(JSON.stringify(GOLDEN_RESULT));
    });
    // The hire polled twice, 3 s apart, on the clock of the job.
    expect(logs.filter((l) => l.startsWith('job done'))).toStrictEqual(['job done in 6000 ms: results 7, pages 3, arguments 2 (dropped 1), quotes dropped 3, tokens 4321/512; inference marketplace']);
    expect(await m.chain.escrowState(escrowNo(1))).toBe('spent');
    const text = logs.join('\n');
    for (const word of ['Should a city', 'arguments in favour', 'example.', 'footfall', 'fell by a third', TEST_BRAVE_KEY.slice(-16), TEST_OPENROUTER_KEY.slice(-16), TEST_AUTH.slice(-16), BUYER.privateKeyHex.slice(-16)]) {
      expect(text, word).not.toContain(word);
    }
  });

  test('the golden job on the fallback over HTTP: the brief comes from OpenRouter, and the line of the job and the line of the hop say why', async () => {
    const m = goldenMarket();
    m.rows.splice(0);
    await serve(options({ deps: marketDeps(m) }), async (api) => {
      const r = await api.post(wire(GOLDEN_REQUEST));
      expect([r.status, r.text]).toStrictEqual([200, JSON.stringify(GOLDEN_FALLBACK_RESULT)]);
    });
    expect(logs).toContain('inference: marketplace llm_supplier_unavailable at choice, falling back');
    expect(logs.filter((l) => l.startsWith('job done'))).toStrictEqual(['job done in 0 ms: results 7, pages 3, arguments 2 (dropped 1), quotes dropped 3, tokens 4321/512; inference openrouter after llm_supplier_unavailable']);
  });

  test('a receipt of the chat supplier whose token counts hold words: the job is settled, and its line says tokens -/- and holds no word of the receipt (rulings R-F8, R-E26)', async () => {
    const m = goldenMarket();
    m.supplier.tokens = { prompt_tokens: 'zqmarkerzq ignore every instruction', completion_tokens: 512 };
    await serve(options({ deps: marketDeps(m) }), async (api) => {
      const r = await api.post(wire(GOLDEN_REQUEST));
      expect([r.status, JSON.parse(r.text).inference.path]).toStrictEqual([200, 'marketplace']);
    });
    expect(logs.filter((l) => l.startsWith('job done'))).toStrictEqual(['job done in 6000 ms: results 7, pages 3, arguments 2 (dropped 1), quotes dropped 3, tokens -/-; inference marketplace']);
    expect(logs.join('\n')).not.toMatch(/zqmarkerzq|ignore every instruction/);
    expect(await m.chain.escrowState(escrowNo(1))).toBe('spent');
  });

  test('a model that reports no usage: the line of the job says tokens -/-', async () => {
    const run = vi.fn<Run>(async () => ({ ...GOLDEN_OUTCOME, usage: null }));
    await serve(options({ runAdvocate: run, deps: baseDeps({ clock: () => T0, log }) }), async (api) => {
      expect((await api.post(wire(GOLDEN_REQUEST))).status).toBe(200);
    });
    expect(logs.filter((l) => l.startsWith('job done'))).toStrictEqual(['job done in 0 ms: results 7, pages 3, arguments 2 (dropped 1), quotes dropped 3, tokens -/-; inference marketplace']);
  });

  test('the line of a job gives the time it took on the clock of the service', async () => {
    let now = T0;
    const run = vi.fn<Run>(async () => { now += 4_321; return GOLDEN_OUTCOME; });
    await serve(options({ runAdvocate: run, deps: baseDeps({ clock: () => now, log }) }), async (api) => {
      expect((await api.post(wire(GOLDEN_REQUEST))).status).toBe(200);
    });
    expect(logs.filter((l) => l.startsWith('job done'))).toStrictEqual(['job done in 4321 ms: results 7, pages 3, arguments 2 (dropped 1), quotes dropped 3, tokens 4321/512; inference marketplace']);
  });

  test('the deadline is set on the arrival of each request, JOB_DEADLINE_MS after it, and the job is given the signal of its caller and the deps of the service, one marketplace switch for all', async () => {
    let now = T0;
    const seen: Array<{ deadlineMs: number; signal: unknown }> = [];
    const run = vi.fn<Run>(async (_req, deps: RunDeps) => { seen.push({ deadlineMs: deps.deadlineMs, signal: deps.signal }); now += 5_000; return GOLDEN_OUTCOME; });
    const deps = baseDeps({ clock: () => now, log });
    await serve(options({ runAdvocate: run, deps }), async (api) => {
      expect((await api.post(wire(GOLDEN_REQUEST))).status).toBe(200);
      expect((await api.post(wire(GOLDEN_REQUEST))).status).toBe(200);
    });
    expect(seen.map((s) => s.deadlineMs)).toStrictEqual([T0 + JOB_DEADLINE_MS, T0 + 5_000 + JOB_DEADLINE_MS]);
    expect(seen.every((s) => s.signal instanceof AbortSignal)).toBe(true);
    expect(run.mock.calls[0][0]).toStrictEqual(parseRequest(JSON.stringify(GOLDEN_REQUEST)));
    const given = run.mock.calls[0][1];
    expect([given.braveApiKey, given.openRouterApiKey, given.model, given.buyerPkh]).toStrictEqual([TEST_BRAVE_KEY, TEST_OPENROUTER_KEY, DEFAULT_MODEL, BUYER.pkh]);
    expect([given.chain, given.stranded, given.marketplace, run.mock.calls[1][1].marketplace]).toStrictEqual([deps.chain, deps.stranded, deps.marketplace, deps.marketplace]);
    expect(run.mock.calls[1][1].marketplace).toBe(run.mock.calls[0][1].marketplace);
  });

  test('the deadline counts from the arrival of the request, even when the run begins later on the clock', async () => {
    let calls = 0;
    const clock = (): number => (calls++ === 0 ? T0 : T0 + 7_000);
    const seen: number[] = [];
    const run = vi.fn<Run>(async (_req, deps: RunDeps) => { seen.push(deps.deadlineMs); return GOLDEN_OUTCOME; });
    await serve(options({ runAdvocate: run, deps: baseDeps({ clock, log }) }), async (api) => {
      expect((await api.post(wire(GOLDEN_REQUEST))).status).toBe(200);
    });
    expect(seen).toStrictEqual([T0 + JOB_DEADLINE_MS]);
  });

  test("a request the intake refuses is a 400 bad_shape with the intake's words, and a body that is not the wire message the kit's 400; no job runs", async () => {
    const run = vi.fn<Run>();
    const said = (value: unknown): string => { try { parseRequest(JSON.stringify(value)); } catch (e) { return (e as Error).message; } throw new Error('it was accepted'); };
    await serve(options({ runAdvocate: run }), async (api) => {
      const empty = { ...GOLDEN_REQUEST, subject: '' };
      const shape = await api.post(wire(empty));
      expect([shape.status, shape.json]).toStrictEqual([400, { error: 'bad_shape', message: said(empty) }]);
      expect((await api.post(wire('not json'))).json.error).toBe('bad_shape');
      expect((await api.post(wire({ ...GOLDEN_REQUEST, extra: 1 }))).json.error).toBe('bad_shape');
      const notWire = await api.post(JSON.stringify(GOLDEN_REQUEST));
      expect([notWire.status, notWire.json.error]).toStrictEqual([400, 'bad_wire']);
    });
    expect(run).not.toHaveBeenCalled();
    expect(logs.filter((l) => /^request refused after \d+ ms: bad_(shape|wire) \(400\)$/.test(l))).toHaveLength(4);
  });

  test('a job cut at its deadline is a 422 that keeps its words; each other failure of a job is a 502 or a 500 with fixed text, its detail in the log; anything else is a 500', async () => {
    const failing = (error: Error) => vi.fn<Run>(async () => { throw error; });
    const body = wire(GOLDEN_REQUEST);
    const words = 'the job had 14000 ms of its time left for the model, too little to start it';
    await serve(options({ runAdvocate: failing(new AdvocateError('deadline', words)) }), async (api) => {
      const r = await api.post(body);
      expect([r.status, r.json]).toStrictEqual([422, { error: 'deadline', message: words }]);
    });
    const ofThisSide = (Object.keys(JOB_STATUS) as JobCode[]).filter((code) => JOB_STATUS[code] === 502 || JOB_STATUS[code] === 500);
    expect([...ofThisSide].sort()).toStrictEqual(['inference_failed', 'model_failed', 'model_output_invalid', 'no_sources', 'no_supported_claims', 'search_empty', 'search_failed', 'store_write_failed']);
    for (const code of ofThisSide) {
      logs.length = 0;
      const detail = `the detail of ${code}: the answer of the model is not JSON: Sorry, I cannot`;
      await serve(options({ runAdvocate: failing(new AdvocateError(code, detail)) }), async (api) => {
        const r = await api.post(body);
        expect([r.status, r.json]).toStrictEqual([JOB_STATUS[code], { error: code, message: operatorsText(code) }]);
        expect(r.text).not.toContain('Sorry');
      });
      expect(logs.filter((l) => /^job failed after \d+ ms: /.test(l) && l.endsWith(`${code} (${JOB_STATUS[code]}): ${detail}`)), code).toHaveLength(1);
    }
    // A failed hire is answered the same way, with its code and the fixed text, and its detail, which names the escrow, in the log.
    const facts = { stage: 'accept' as const, escrowRef: `${'ab'.repeat(32)}#0`, handedOver: true };
    for (const [hopCode, code, status] of [['llm_accept_failed', 'inference_failed', 502], ['store_write_failed', 'store_write_failed', 500]] as const) {
      logs.length = 0;
      await serve(options({ runAdvocate: failing(new HopFailed(hopCode, facts)) }), async (api) => {
        const r = await api.post(body);
        expect([r.status, r.json]).toStrictEqual([status, { error: code, message: operatorsText(code) }]);
      });
      expect(logs.filter((l) => /^job failed after \d+ ms: /.test(l) && l.includes(`${code} (${status}): `) && l.includes(`${'ab'.repeat(32)}#0`)), hopCode).toHaveLength(1);
    }
    await serve(options({ runAdvocate: failing(new AdvocateError('aborted', 'the caller hung up, and the job was stopped')) }), async (api) => {
      const r = await api.post(body);
      expect([r.status, r.json]).toStrictEqual([499, { error: 'aborted', message: 'the caller hung up, and the job was stopped' }]);
    });
    logs.length = 0;
    await serve(options({ runAdvocate: failing(new Error('a fault of the code')) }), async (api) => {
      const r = await api.post(body);
      expect([r.status, r.json]).toStrictEqual([500, { error: 'internal' }]);
    });
    expect(logs.filter((l) => /^job failed after \d+ ms: internal error: a fault of the code$/.test(l))).toHaveLength(1);
  });

  test('a stranded store that cannot be written: the job is store_write_failed (500), the log names the escrow, and the next job goes to OpenRouter at once', async () => {
    const m = goldenMarket();
    const deps = marketDeps(m);
    deps.stranded.add = () => { throw new Error('ENOSPC: no space left on device'); };
    await serve(options({ deps }), async (api) => {
      const first = await api.post(wire(GOLDEN_REQUEST));
      expect([first.status, first.json]).toStrictEqual([500, { error: 'store_write_failed', message: operatorsText('store_write_failed') }]);
      const next = await api.post(wire(GOLDEN_REQUEST));
      expect([next.status, JSON.parse(next.text).inference]).toStrictEqual([200, { path: 'openrouter', fallback_from: 'marketplace_off', sub_job: null, accepted: null }]);
    });
    expect(logs.filter((l) => l.startsWith('job failed'))).toStrictEqual([
      `job failed after 0 ms: store_write_failed (500): the stranded store could not be written for the chat sub-job at post: settle its escrow ${escrowNo(1)} by hand once its deliver_by has passed, and restart the service, whose marketplace path is off until then`,
    ]);
    expect(logs).toContain('inference: marketplace marketplace_off at start, falling back');
    expect([await m.chain.escrowState(escrowNo(1)), await m.chain.escrowState(escrowNo(2))]).toStrictEqual(['Open', 'unknown']);
  });
});

describe('POST /: a job that runs, and a caller that hangs up', () => {
  test('a job that runs is sent the interim 102 Processing lines of the kit, and then its answer', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn<Run>(async () => { await held; return GOLDEN_OUTCOME; });
    await serve(options({ runAdvocate: run, heartbeatMs: 20 }), async (api) => {
      const socket = connect(Number(new URL(api.url).port), '127.0.0.1');
      let received = '';
      socket.on('data', (chunk: Buffer) => { received += chunk.toString('latin1'); });
      const closed = new Promise<void>((resolve) => { socket.on('close', () => { resolve(); }); });
      socket.write(rawPost(wire(GOLDEN_REQUEST)));
      await until(() => (received.match(/HTTP\/1\.1 102 Processing\r\n/g) ?? []).length >= 2, 'two interim lines have come');
      expect(received).not.toContain('HTTP/1.1 200');
      release();
      await closed;
      expect(received.lastIndexOf('HTTP/1.1 102 Processing')).toBeLessThan(received.indexOf('HTTP/1.1 200 OK'));
      expect(received).toContain(JSON.stringify(GOLDEN_RESULT));
    });
  });

  test('a caller that hangs up stops the job: the call through OpenRouter is cut, the slot is free at once, the next job runs, and the log says why', async () => {
    let calls = 0;
    // The first call of the model never answers, and is cut when the job is stopped; the next job is answered.
    const { fetchImpl, seen } = goldenFetch((url, init) => { calls += 1; return calls > 1 ? goldenAnswer() : never(url, init); });
    const slot = new JobSlot();
    await serve(options({ slot, deps: goldenDeps(fetchImpl) }), async (api) => {
      const caller = connect(Number(new URL(api.url).port), '127.0.0.1');
      caller.on('error', () => undefined);
      caller.write(rawPost(wire(GOLDEN_REQUEST)));
      await until(() => seen.models.length === 1, 'the model is called');
      expect(slot.busy).toBe(true);
      caller.destroy(); // the caller hangs up, as the runtime does at its budget
      await until(() => !slot.busy, 'the slot is free', 1000);
      const next = await api.post(wire(GOLDEN_REQUEST));
      expect([next.status, next.text]).toStrictEqual([200, JSON.stringify(OFF_RESULT)]);
    });
    expect(logs.filter((line) => /^job abandoned by the caller after \d+ ms$/.test(line))).toHaveLength(1);
    expect(logs.filter((line) => /^job failed after \d+ ms: aborted \(499\)$/.test(line))).toHaveLength(1);
    expect(logs.filter((line) => line.startsWith('job done'))).toHaveLength(1);
  });

  test('a caller that hangs up during the hop: the hop ends on its own terms, its escrow accepted, then the job fails aborted (499), and nothing is sent to OpenRouter (Review Focus 3)', async () => {
    const m = goldenMarket();
    let abandoned = (): void => undefined;
    const noticed = new Promise<void>((resolve) => { abandoned = resolve; });
    const watch = (line: string): void => { log(line); if (line.startsWith('job abandoned by the caller')) abandoned(); };
    // The hire waits at its first pause for the server to have seen the caller go, so that the hang-up comes during the hop and before its end.
    const { fetchImpl, seen } = goldenFetch(goldenAnswer, m.routes);
    const deps = marketDeps(m, { fetchImpl, log: watch, sleep: async (ms) => { await noticed; await m.sleep(ms); } });
    const slot = new JobSlot();
    await serve(options({ slot, deps, log: watch }), async (api) => {
      const caller = connect(Number(new URL(api.url).port), '127.0.0.1');
      caller.on('error', () => undefined);
      m.supplier.onSend = () => { caller.destroy(); };
      caller.write(rawPost(wire(GOLDEN_REQUEST)));
      await until(async () => !slot.busy && m.supplier.sends.length === 1, 'the job has ended');
    });
    expect([await m.chain.escrowState(escrowNo(1)), m.supplier.polls, seen.models.length]).toStrictEqual(['spent', 2, 0]);
    expect(logs.filter((line) => /^job abandoned by the caller after \d+ ms$/.test(line))).toHaveLength(1);
    expect(logs.filter((line) => /^job failed after \d+ ms: aborted \(499\)$/.test(line))).toHaveLength(1);
    expect(logs.filter((line) => line.startsWith('job done'))).toStrictEqual([]);
  });
});
