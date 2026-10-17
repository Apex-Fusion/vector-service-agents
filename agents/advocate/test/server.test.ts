// agents/advocate/test/server.test.ts
// The manifest the service publishes and what is the service's own on the HTTP surface of packages/service-kit: the fields of the manifest, its limits read
// from the code, its gaps, notes and behaviour, the request schema held to the intake on a table, the template file; the three routes and the token; the
// golden job over HTTP with its one line in the log; the refusals of the intake and of a job with their statuses; the deadline and the signal set on
// arrival; the interim lines of the kit while a job runs; and a caller that hangs up, whose job is stopped and whose slot is freed. The generic behaviour of
// the surface (the slot, the body cap, the refusal log) is tested in packages/service-kit.
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import Ajv from 'ajv';
import { afterEach, describe, test, expect, vi } from 'vitest';
import { operatorsText } from '@vsa/service-kit';
import { REGISTRY_ADDRESS } from '@vsa/vector-read';
import { JOB_DEADLINE_MS, PAGE_TIMEOUT_MS } from '../src/budget.ts';
import { AdvocateError, JOB_STATUS } from '../src/errors.ts';
import type { JobCode } from '../src/errors.ts';
import { DEADLINE_GAP, ONE_SIDED_GAP, PAGES_GAP, QUOTE_GAP, SEARCH_GAP, gapsFor, modelGap } from '../src/gaps.ts';
import { EXCERPT_CHARS, MIN_PAGE_CHARS } from '../src/html.ts';
import { DEFAULT_MODEL } from '../src/model.ts';
import { PAGE_MAX_BYTES } from '../src/pages.ts';
import { DECLARED_BIAS_STATEMENT, OMITTED_BY_DESIGN, QUOTE_MAX_CHARS, QUOTE_MIN_CHARS } from '../src/prompt.ts';
import { DEFAULT_LANGUAGE, DEFAULT_LENGTH, MAX_AUDIENCE_CHARS, MAX_SIDE_CHARS, MAX_SUBJECT_CHARS, RequestError, parseRequest } from '../src/request.ts';
import type { RunDeps } from '../src/run.ts';
import { MAX_RESULTS } from '../src/search.ts';
import { JobSlot, MIN_PROCESSING_WINDOW_MS, TEMPLATE_ENV, manifestFromEnv, renderTemplate } from '../src/server.ts';
import type { ServerOptions } from '../src/server.ts';
import { never } from './fake-fetch.ts';
import { GOLDEN_OUTCOME, GOLDEN_REQUEST, GOLDEN_RESULT, GOLDEN_T0, TEST_BRAVE_KEY, TEST_OPENROUTER_KEY, goldenAnswer, goldenFetch } from './golden.ts';
import { FULL_ENV, SUPPLIER, T0, TEST_AUTH, TEST_CONTACT, baseDeps, serve, until, wire } from './server-support.ts';

afterEach(() => { vi.restoreAllMocks(); });

// The ledger's native unit is named once in the repository, in docs/HIRE.md. Spelled in two parts, so that a search for the name finds only the guide.
const UNIT_NAME = new RegExp('AP' + '3X', 'i');
const MANIFEST = manifestFromEnv(FULL_ENV);
const SPEC_URL = 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/advocate.md';
const logs: string[] = [];
const log = (line: string): void => { logs.push(line); };
afterEach(() => { logs.length = 0; });
type Run = NonNullable<ServerOptions['runAdvocate']>;
const options = (over: Partial<ServerOptions> = {}): Omit<ServerOptions, 'authHeader'> => ({ manifest: MANIFEST, deps: baseDeps({ log }), log, ...over });
/** The deps of the golden job: its fetch, its clock that does not move, and the log of the test. */
const goldenDeps = (fetchImpl: typeof fetch): Omit<RunDeps, 'deadlineMs' | 'signal'> => baseDeps({ fetchImpl, clock: () => GOLDEN_T0, log });
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
      keys: { supplier_pkh: SUPPLIER.pkh, pub_key_hex: SUPPLIER.pubKeyHex },
      interface: {
        request_schema: MANIFEST.interface.request_schema, // held against the intake below
        response_schema: { $ref: `${SPEC_URL}#response` },
        routes: { job: '/v1/job', status: '/status', capability: '/capability' },
        notes: MANIFEST.interface.notes, // held against the code below
      },
      terms: {
        price_lovelace: 3_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 300_000,
        input_limits: { request_bytes: 900_000, subject_chars: 300, side_chars: 120, audience_chars: 200, results: 12, page_bytes: 1_048_576, excerpt_chars: 12_000, quote_chars_min: 20, quote_chars_max: 300 },
      },
      behaviour: {
        declared_bias: { statement: 'This brief argues one side only, by design, and omits counter-arguments.', omitted: 'counter-arguments and rebuttals' },
        data_handling: 'The subject, the side, the audience, the length and the language are held in memory while a job runs, with the pages the service fetches; nothing is written to disk and nothing is kept after the job. '
          + 'The two search queries go to the Brave Search API, each page fetch to the host of that page, and the subject, the side, the audience and the page excerpts to OpenRouter and the model provider behind it. '
          + 'On the ledger the escrow carries only the sha256 of the wire payload, and the request stays off the ledger. '
          + 'The log carries job outcomes and counts, never a request, a page, a quote or a key.',
        third_parties: [
          'Brave Search API (the two search queries)',
          'the hosts of the result pages (the fetch of each page)',
          'OpenRouter and the model provider behind it (the subject, the side, the audience and the excerpts of the fetched pages)',
        ],
      },
      status: { chip: 'proposed', since: '2026-10-13' },
      gaps: [...gapsFor('deepseek/deepseek-v4-flash')],
      links: { spec: SPEC_URL, source: 'https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/advocate', explorer_advert: '' },
    });
    expect(Object.keys(MANIFEST.behaviour)).toStrictEqual(['declared_bias', 'data_handling', 'third_parties']);
  });

  test('the declared bias of the manifest is the one every brief carries, read from the code that writes it', () => {
    expect(MANIFEST.behaviour.declared_bias).toStrictEqual({ statement: DECLARED_BIAS_STATEMENT, omitted: OMITTED_BY_DESIGN });
    expect(GOLDEN_RESULT.declared_bias.statement).toBe(MANIFEST.behaviour.declared_bias.statement);
    expect(GOLDEN_RESULT.omitted_by_design).toBe(MANIFEST.behaviour.declared_bias.omitted);
  });

  test('the limits are the numbers the code enforces, read from it, and the window holds the deadline and the runtime timeout', () => {
    expect(MANIFEST.terms.input_limits).toStrictEqual({
      request_bytes: 900_000, subject_chars: MAX_SUBJECT_CHARS, side_chars: MAX_SIDE_CHARS, audience_chars: MAX_AUDIENCE_CHARS, results: MAX_RESULTS,
      page_bytes: PAGE_MAX_BYTES, excerpt_chars: EXCERPT_CHARS, quote_chars_min: QUOTE_MIN_CHARS, quote_chars_max: QUOTE_MAX_CHARS,
    });
    expect(MIN_PROCESSING_WINDOW_MS).toBe(300_000);
    // The runtime's SERVICE_TIMEOUT_MS, 180000, is 30 s after the deadline of a job, and the runtime boots only with it at least 60 s inside the window.
    expect(JOB_DEADLINE_MS + 30_000).toBe(180_000);
    expect(180_000).toBeLessThanOrEqual(MIN_PROCESSING_WINDOW_MS - 60_000);
  });

  test('without the identity the keys are empty strings, and the supplier key hash is both controller and supplier', () => {
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT }).keys).toStrictEqual({ supplier_pkh: '', pub_key_hex: '' });
    const m = manifestFromEnv({ ...FULL_ENV, SUPPLIER_PKH: 'ab'.repeat(28), AGENT_DID: 'did:vector:agent:x:y' });
    expect([m.identity.did, m.identity.controller_pkh, m.keys.supplier_pkh]).toStrictEqual(['did:vector:agent:x:y', 'ab'.repeat(28), 'ab'.repeat(28)]);
  });

  test('agent.json.template is the manifest with a placeholder for each of the four fields the operator supplies, byte for byte what renderTemplate prints', () => {
    const file = readFileSync(new URL('../agent.json.template', import.meta.url), 'utf8');
    expect(JSON.parse(file)).toStrictEqual(manifestFromEnv(TEMPLATE_ENV));
    expect(file).toBe(renderTemplate());
    expect(file.endsWith('}\n')).toBe(true);
    expect(file).not.toContain('\r');
    expect(file.match(/<[A-Z_]+>/g)?.sort()).toStrictEqual(['<AGENT_DID>', '<OPERATOR_CONTACT>', '<SUPPLIER_PKH>', '<SUPPLIER_PKH>', '<SUPPLIER_PUB_KEY_HEX>']);
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
    for (const file of ['server.ts', 'start.ts', 'gaps.ts', 'index.ts', 'model.ts', 'prompt.ts', 'check.ts', 'result.ts', 'run.ts']) {
      expect(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), file).not.toMatch(/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]/);
    }
  });

  test('defaults: proposed since 2026-10-13, price 3 units, both bonds 1 unit, a 5 min window; a smaller window is refused, a larger one is used', () => {
    const m = manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT });
    expect([m.status, m.terms.price_lovelace, m.terms.max_processing_ms]).toStrictEqual([{ chip: 'proposed', since: '2026-10-13' }, 3_000_000, 300_000]);
    for (const bad of ['0', '150000', '299999']) {
      expect(() => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, ADVERT_MAX_PROCESSING_MS: bad }), bad).toThrow(/^environment variable ADVERT_MAX_PROCESSING_MS must be at least 300000 \(the window of 5 min that the deadline of a job, 150000 ms, assumes\), got \d+$/);
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

  test('the gaps: six sentences in order, word for word, each one line of plain text whose numbers are the code\'s, the fifth naming the model of OPENROUTER_MODEL', () => {
    expect(gapsFor(DEFAULT_MODEL)).toStrictEqual([ONE_SIDED_GAP, QUOTE_GAP, PAGES_GAP, SEARCH_GAP, modelGap(DEFAULT_MODEL), DEADLINE_GAP]);
    expect(ONE_SIDED_GAP).toBe('The brief argues one side only, by design: it leaves out counter-arguments and rebuttals, says so in declared_bias and omitted_by_design, and gives no balanced answer and no fairness guarantee.');
    expect(QUOTE_GAP).toBe('A quote in the brief was found in the text the service fetched from the source it names, which shows that the source says it, not that it is right; the receipt commits to the brief, not to the page text.');
    expect(PAGES_GAP).toBe('Only pages the service could fetch can be cited: a page that redirects, is not HTML or plain text, is over 1 MB, has under 200 characters of text, or does not answer within 15 s is dropped, and only the first 12000 characters of a page are read.');
    expect(SEARCH_GAP).toBe('The sources are what two Brave Search queries return, at most 12 pages: a subject the search covers thinly gives a thin brief, and a job that gets no usable page or no claim that survives the check fails with no_sources or no_supported_claims and returns no brief.');
    expect(modelGap(DEFAULT_MODEL)).toBe('The model is deepseek/deepseek-v4-flash through OpenRouter: its claims can be wrong even when their quotes are real, and the check reads quotes, not reasoning.');
    expect(DEADLINE_GAP).toBe('A job has a deadline of its own, 150000 ms after its request arrives: a job cut at the deadline fails with the code deadline and returns no result.');
    expect(PAGES_GAP).toContain(`is over ${PAGE_MAX_BYTES / 1_048_576} MB, has under ${MIN_PAGE_CHARS} characters of text, or does not answer within ${PAGE_TIMEOUT_MS / 1000} s`);
    expect(PAGES_GAP).toContain(`only the first ${EXCERPT_CHARS} characters`);
    expect(SEARCH_GAP).toContain(`at most ${MAX_RESULTS} pages`);
    expect(DEADLINE_GAP).toContain(`${JOB_DEADLINE_MS} ms after its request arrives`);
    expect(manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, OPENROUTER_MODEL: 'openai/gpt-4o-mini' }).gaps[4]).toBe(modelGap('openai/gpt-4o-mini'));
    expect(() => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, OPENROUTER_MODEL: 'gpt' })).toThrow(/^environment variable OPENROUTER_MODEL must be the id of a model of OpenRouter/);
    for (const gap of gapsFor('openai/gpt-4o-mini')) {
      expect(gap).toMatch(/^[A-Za-z0-9].*\.$/);
      expect(gap).not.toMatch(/[\r\n\u{2013}\u{2014}]/u);
      expect(gap).not.toMatch(UNIT_NAME);
    }
  });

  test('the notes say what the schema cannot: the side, a letter or digit in the subject and the side, the language rule, and the pages the service fetches itself', () => {
    expect(MANIFEST.interface.notes).toStrictEqual([
      'The side is for, against, or a position in words of at most 120 characters, and the brief argues that side alone; the subject and the side must each hold at least one letter or digit, and a request that breaks a rule of the intake is refused with bad_shape (400).',
      'The language is a code such as en or en-GB, 2 to 8 letters and optional hyphen-separated subtags of up to 8 letters or digits, at most 16 characters, en by default: the model is asked to write the brief in it, and the search asks for results in it when its first part has two letters.',
      'The service runs the search and fetches the result pages itself, at most 12 pages of at most 1048576 bytes each, and cites only what it could fetch: a quote that is not in the text of the page it names is dropped, and so is an argument left without one.',
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
    ['an audience that is a number', req({ audience: 5 })],
    ['an audience that is null', req({ audience: null })],
    // the length
    ...['long', 'Short', 'STANDARD', '', 3, null].map((l): [string, unknown] => [`length ${JSON.stringify(l)}`, req({ length: l })]),
    // the language
    ...['en', 'EN', 'de', 'hr', 'en-GB', 'zh-Hant-TW', 'es-419', 'yue', 'haw', 'abcdefgh', 'zh-Hant-TW-abcde'].map((l): [string, unknown] => [`language ${l}`, req({ language: l })]),
    ...['', 'e', 'abcdefghi', 'en_GB', '1en', 'en-', 'en-abcdefghi', 'zh-Hant-TW-abcdef', 5, null].map((l): [string, unknown] => [`language ${JSON.stringify(l)}`, req({ language: l })]),
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

  test('the space a hand leaves around a value: the intake reads the value trimmed, and the schema, which gives the language in its plain form, refuses it there and bounds free text by its length alone', () => {
    for (const value of [req({ language: ' en' }), req({ language: 'en\n' })]) {
      expect(validate(value), JSON.stringify(value)).toBe(false);
      expect(intake(value), JSON.stringify(value)).toBe(true);
    }
    // A side and an audience are free text, which the schema bounds by its length alone, as the table holds for a side of '  for  ' and the notes test for a
    // side of spaces: the schema takes the space around them, and the intake reads them trimmed.
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
  test('the golden job over HTTP: 200 with JSON.stringify of the brief, byte for byte, and one line in the log with its counts and no word of the job', async () => {
    const { fetchImpl } = goldenFetch();
    await serve(options({ deps: goldenDeps(fetchImpl) }), async (api) => {
      const r = await api.post(wire(GOLDEN_REQUEST));
      expect([r.status, r.headers.get('content-type')]).toStrictEqual([200, 'application/json']);
      expect(r.text).toBe(JSON.stringify(GOLDEN_RESULT));
    });
    expect(logs.filter((l) => l.startsWith('job done'))).toStrictEqual(['job done in 0 ms: results 7, pages 3, arguments 2 (dropped 1), quotes dropped 3, tokens 4321/512']);
    const text = logs.join('\n');
    for (const word of ['Should a city', 'arguments in favour', 'example.', 'footfall', 'fell by a third', TEST_BRAVE_KEY.slice(-16), TEST_OPENROUTER_KEY.slice(-16), TEST_AUTH.slice(-16)]) {
      expect(text, word).not.toContain(word);
    }
  });

  test('a model that reports no usage: the line of the job says tokens -/-', async () => {
    const run = vi.fn<Run>(async () => ({ ...GOLDEN_OUTCOME, usage: null }));
    await serve(options({ runAdvocate: run, deps: baseDeps({ clock: () => T0, log }) }), async (api) => {
      expect((await api.post(wire(GOLDEN_REQUEST))).status).toBe(200);
    });
    expect(logs.filter((l) => l.startsWith('job done'))).toStrictEqual(['job done in 0 ms: results 7, pages 3, arguments 2 (dropped 1), quotes dropped 3, tokens -/-']);
  });

  test('the deadline is set on the arrival of each request, JOB_DEADLINE_MS after it, and the job is given the signal of its caller and the deps of the service', async () => {
    let now = T0;
    const seen: Array<{ deadlineMs: number; signal: unknown }> = [];
    const run = vi.fn<Run>(async (_req, deps: RunDeps) => { seen.push({ deadlineMs: deps.deadlineMs, signal: deps.signal }); now += 5_000; return GOLDEN_OUTCOME; });
    await serve(options({ runAdvocate: run, deps: baseDeps({ clock: () => now, log }) }), async (api) => {
      expect((await api.post(wire(GOLDEN_REQUEST))).status).toBe(200);
      expect((await api.post(wire(GOLDEN_REQUEST))).status).toBe(200);
    });
    expect(seen.map((s) => s.deadlineMs)).toStrictEqual([T0 + JOB_DEADLINE_MS, T0 + 5_000 + JOB_DEADLINE_MS]);
    expect(seen.every((s) => s.signal instanceof AbortSignal)).toBe(true);
    expect(run.mock.calls[0][0]).toStrictEqual(parseRequest(JSON.stringify(GOLDEN_REQUEST)));
    const given = run.mock.calls[0][1];
    expect([given.braveApiKey, given.openRouterApiKey, given.model]).toStrictEqual([TEST_BRAVE_KEY, TEST_OPENROUTER_KEY, DEFAULT_MODEL]);
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

  test('a job cut at its deadline is a 422 that keeps its words; each other failure of a job is a 502 with fixed text, its detail in the log; anything else is a 500', async () => {
    const failing = (error: Error) => vi.fn<Run>(async () => { throw error; });
    const body = wire(GOLDEN_REQUEST);
    const words = 'the job had 14000 ms of its time left for the model, too little to start it';
    await serve(options({ runAdvocate: failing(new AdvocateError('deadline', words)) }), async (api) => {
      const r = await api.post(body);
      expect([r.status, r.json]).toStrictEqual([422, { error: 'deadline', message: words }]);
    });
    const ofThisSide = (Object.keys(JOB_STATUS) as JobCode[]).filter((code) => JOB_STATUS[code] === 502);
    expect([...ofThisSide].sort()).toStrictEqual(['model_failed', 'model_output_invalid', 'no_sources', 'no_supported_claims', 'search_empty', 'search_failed']);
    for (const code of ofThisSide) {
      logs.length = 0;
      const detail = `the detail of ${code}: the answer of the model is not JSON: Sorry, I cannot`;
      await serve(options({ runAdvocate: failing(new AdvocateError(code, detail)) }), async (api) => {
        const r = await api.post(body);
        expect([r.status, r.json]).toStrictEqual([502, { error: code, message: operatorsText(code) }]);
        expect(r.text).not.toContain('Sorry');
      });
      expect(logs.filter((l) => /^job failed after \d+ ms: /.test(l) && l.endsWith(`${code} (502): ${detail}`)), code).toHaveLength(1);
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

  test('a caller that hangs up stops the job: the call of the model is cut, the slot is free at once, the next job runs, and the log says why', async () => {
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
      expect([next.status, next.text]).toStrictEqual([200, JSON.stringify(GOLDEN_RESULT)]);
    });
    expect(logs.filter((line) => /^job abandoned by the caller after \d+ ms$/.test(line))).toHaveLength(1);
    expect(logs.filter((line) => /^job failed after \d+ ms: aborted \(499\)$/.test(line))).toHaveLength(1);
    expect(logs.filter((line) => line.startsWith('job done'))).toHaveLength(1);
  });
});
