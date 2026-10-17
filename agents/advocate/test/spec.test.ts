// agents/advocate/test/spec.test.ts
// specs/advocate.md is the public page of the agent and the manifest links to its Response section. These tests hold the page to the code: the numbers of the
// terms and the limits, the status, the identity, the request fields of the schema the manifest publishes, the example result (made here by the check and the
// result of the service from the three pages of the fixtures), the declared bias, the gap sentences word for word, the error codes with their statuses, and the
// third parties.
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HEARTBEAT_MS, MAX_BODY, STOPPING_TEXT, WireError, operatorsText } from '@vsa/service-kit';
import { REGISTRY_ADDRESS, blake2b224Hex, safeFetch } from '@vsa/vector-read';
import {
  FETCH_CONCURRENCY, FETCH_PHASE_MAX_MS, FETCH_RESERVE_MS, JOB_DEADLINE_MS, MODEL_MAX_MS, MODEL_MIN_MS, PAGE_TIMEOUT_MS, RESULT_RESERVE_MS, SEARCH_MAX_MS, SEARCH_QUERY_TIMEOUT_MS,
  fetchDeadlineMs, modelBudgetMs,
} from '../src/budget.ts';
import { checkCitations, quoteFound } from '../src/check.ts';
import { AdvocateError, JOB_STATUS } from '../src/errors.ts';
import type { JobCode } from '../src/errors.ts';
import { gapsFor } from '../src/gaps.ts';
import { EXCERPT_CHARS, MIN_PAGE_CHARS, collapseWhitespace, extractText } from '../src/html.ts';
import { DEFAULT_MODEL, modelLabel } from '../src/model.ts';
import type { ModelBrief } from '../src/model.ts';
import { normalizeText } from '../src/normalize.ts';
import { PAGE_MAX_BYTES, USER_AGENT } from '../src/pages.ts';
import type { Page } from '../src/pages.ts';
import { DECLARED_BIAS_STATEMENT, OMITTED_BY_DESIGN, QUOTE_MAX_CHARS, QUOTE_MIN_CHARS, SHAPES, systemPrompt, userMessage } from '../src/prompt.ts';
import { LANGUAGE_PATTERN, MAX_AUDIENCE_CHARS, MAX_SIDE_CHARS, MAX_SUBJECT_CHARS, RequestError, parseRequest } from '../src/request.ts';
import { SCHEMA, SEARCH_NAME, buildResult } from '../src/result.ts';
import { MAX_QUERY_CHARS, MAX_QUERY_WORDS, MAX_RESULTS, QUERY_SPACING_MS, RESULTS_PER_QUERY, queriesFor, searchWeb } from '../src/search.ts';
import { JobSlot, MIN_PROCESSING_WINDOW_MS, manifestFromEnv } from '../src/server.ts';
import { loadConfig } from '../src/start.ts';
import { GOLDEN_REQUEST } from './golden.ts';
import { baseDeps, serve, wire } from './server-support.ts';

const page = readFileSync(new URL('../../../specs/advocate.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const section = (heading: string): string => (page.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const sub = (heading: string): string => (page.split(`\n### ${heading}\n`)[1] ?? '').split(/\n##+ /)[0];
const manifest = manifestFromEnv({ OPERATOR_CONTACT: 'ops@example.test' });
const row = (text: string, label: string): string => text.split('\n').find((l) => l.startsWith(`| ${label} |`)) ?? '';
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

// The example of the Response section: the request of the page, the three pages of the fixtures as the service keeps them (the title of the search result,
// the excerpt of the text), and a brief written for the example. No model wrote it; its quotes are in the text of its pages, so the check keeps them all.
const RETRIEVED_AT = '2026-10-17T09:00:00.000Z';
const PAGES: Page[] = [
  { n: 1, title: 'Car-free centres: what the evidence says', url: 'https://example.org/car-free-centres', retrieved_at: RETRIEVED_AT, excerpt: extractText(fixture('page-1.html')).slice(0, EXCERPT_CHARS) },
  { n: 2, title: 'Clean air and the school run', url: 'https://example.net/clean-air', retrieved_at: RETRIEVED_AT, excerpt: extractText(fixture('page-2.html')).slice(0, EXCERPT_CHARS) },
  { n: 3, title: 'Notes on urban freight', url: 'https://example.com/freight.txt', retrieved_at: RETRIEVED_AT, excerpt: collapseWhitespace(fixture('page-3.txt')).slice(0, EXCERPT_CHARS) },
];
const BRIEF: ModelBrief = {
  thesis: 'A city should close its centre to cars: the streets that did so drew more shoppers, cleaner air at the school gate and calmer deliveries.',
  arguments: [
    {
      claim: 'Shops in a car-free centre gain customers.',
      support: "Footfall is the measure shops live by, and where centres were closed to cars the council's own count showed it rising within two years. Shopkeepers who had feared the change saw customers stay longer once the traffic had gone.",
      sources: [{ n: 1, quote: 'retail footfall rise by eleven percent within two years' }],
    },
    {
      claim: 'Children breathe cleaner air on the way to school.',
      support: 'Closing a street to through traffic cut nitrogen dioxide at the school gate by a third within a year, on weekdays and at weekends alike, and the gain falls on the youngest first.',
      sources: [{ n: 2, quote: 'fell by a third in the first year' }],
    },
    {
      claim: 'Deliveries keep working when the centre closes to cars.',
      support: 'Freight moved to early-morning windows and the vans in the centre at noon halved, so the streets are freed at their busiest hour and the shops still get their goods, between six and ten in the morning.',
      sources: [{ n: 3, quote: 'the number of vans in the centre at noon halved' }],
    },
  ],
};
const exampleRequest = (): string => /Example:\n\n```json\n([\s\S]*?)\n```/.exec(sub('Request'))?.[1] ?? '';
const THE_REQUEST = { subject: 'Should a city ban cars from its centre?', side: 'for', audience: null, length: 'short', language: 'en' };

describe('specs/advocate.md', () => {
  test('the Terms tables carry the numbers of the manifest and of the code', () => {
    const terms = section('Terms');
    expect(row(terms, 'Price')).toBe(`| Price | ${manifest.terms.price_lovelace} | 3.000000 |`);
    expect(row(terms, 'Supplier bond')).toBe(`| Supplier bond | ${manifest.terms.supplier_bond_lovelace} | 1.000000 |`);
    expect(row(terms, 'Buyer bond')).toBe(`| Buyer bond | ${manifest.terms.buyer_bond_lovelace} | 1.000000 |`);
    const locked = manifest.terms.price_lovelace + manifest.terms.supplier_bond_lovelace + manifest.terms.buyer_bond_lovelace;
    expect(row(terms, 'Locked by the buyer (price and both bonds)')).toBe(`| Locked by the buyer (price and both bonds) | ${locked} | ${(locked / 1_000_000).toFixed(6)} |`);
    expect(row(terms, 'Processing window, advert `max_processing_ms`')).toBe(`| Processing window, advert \`max_processing_ms\` | ${manifest.terms.max_processing_ms} ms |`);
    expect(row(terms, 'Job deadline, set by the service when a request arrives')).toBe(`| Job deadline, set by the service when a request arrives | ${JOB_DEADLINE_MS} ms (30 s inside the service timeout) |`);
    const limits = manifest.terms.input_limits;
    expect([limits.request_bytes, limits.subject_chars, limits.side_chars, limits.audience_chars, limits.results, limits.page_bytes, limits.excerpt_chars, limits.quote_chars_min, limits.quote_chars_max])
      .toStrictEqual([900_000, MAX_SUBJECT_CHARS, MAX_SIDE_CHARS, MAX_AUDIENCE_CHARS, MAX_RESULTS, PAGE_MAX_BYTES, EXCERPT_CHARS, QUOTE_MIN_CHARS, QUOTE_MAX_CHARS]);
    expect(row(terms, 'Request')).toBe(`| Request | at most ${limits.request_bytes} bytes of wire payload; \`subject\` 1 to ${limits.subject_chars} characters, \`side\` 1 to ${limits.side_chars}, \`audience\` 1 to ${limits.audience_chars} |`);
    expect(row(terms, 'Search results')).toBe(`| Search results | at most ${limits.results}, https only |`);
    expect(row(terms, 'Page')).toBe(`| Page | at most 1 MB (${limits.page_bytes} bytes) fetched and at least ${MIN_PAGE_CHARS} characters of text; the first ${limits.excerpt_chars} characters are read |`);
    expect(row(terms, 'Quote')).toBe(`| Quote | ${limits.quote_chars_min} to ${limits.quote_chars_max} characters |`);
    expect(terms).toContain('The last column is the same amount divided by 1,000,000, with six decimals.');
  });

  test("the capability, the model string, the opening line and the status are the manifest's", () => {
    expect(section('Capability id').split('\n')[1]).toBe(`\`${manifest.capability_id}\``);
    expect(section('Capability id')).toContain('The model string in the advert and in every receipt is `advocate-v1`.');
    expect(page.split('\n')[2]).toBe(`Capability \`${manifest.capability_id}\`. ${manifest.description}`);
    expect(manifest.name).toBe('Advocate');
    // The release line: the version of the manifest, and the day it was built.
    expect(section('Changelog').trim()).toBe(`- ${manifest.version}, 2026-10-17: built`);
    expect(manifest.description).toBe('The strongest one-sided brief for a position, with citations: it argues one side only, by design, omits counter-arguments, and says so in every output.');
    expect(manifest.status).toStrictEqual({ chip: 'proposed', since: '2026-10-13' });
    expect(section('Status').split('\n')).toContain('PROPOSED (built, not deployed). Since 2026-10-13.');
    expect(row(section('Identity'), 'Registry address')).toBe(`| Registry address | \`${REGISTRY_ADDRESS}\` |`);
    // The stake the page plans is the 10 units the runbook of the host names: 10000000 lovelace, printed with six decimals.
    expect(row(section('Identity'), 'Reputation stake, planned')).toBe('| Reputation stake, planned | a Module-3 self-stake of 10000000 lovelace (10.000000) on the capability |');
    expect(readFileSync(new URL('../../../deploy/host/RUNBOOK-advocate.md', import.meta.url), 'utf8')).toContain('the stake (10)');
    // The receipt table and the two sentences under it, held in words.
    const receipt = section('What the receipt commits to');
    expect(row(receipt, '`prompt_hash`')).toContain('sha256 of the UTF-8 bytes of the wire payload');
    expect(row(receipt, '`response_hash`')).toContain('sha256 of the UTF-8 bytes of the brief exactly as the service returned them');
    expect(row(receipt, '`prompt_tokens`, `completion_tokens`')).toContain('0 and 0, the runtime counts none. The service writes the tokens of its model call in its log and in no output');
    expect(receipt).toContain('The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.');
  });

  test('the request: the page shows every field of the schema the manifest publishes, and its examples are requests the intake accepts', () => {
    const request = sub('Request');
    for (const field of Object.keys(manifest.interface.request_schema.properties)) expect(request, field).toContain(`\`${field}\``);
    expect(parseRequest(exampleRequest())).toStrictEqual(THE_REQUEST);
    const inline = /The request JSON is, for example, `([^`]+)`/.exec(section('How to hire it'))?.[1] ?? '';
    expect(parseRequest(inline)).toStrictEqual(THE_REQUEST);
  });

  test('the response: one Response heading, the anchor the manifest links to, and its example is what the check and the result of the service make of the pages of the fixtures and the brief of the example', () => {
    expect(page.match(/^### Response$/gm)).toHaveLength(1);
    expect(manifest.interface.response_schema.$ref.endsWith('/specs/advocate.md#response')).toBe(true);
    const shown = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(sub('Response'))?.[1] ?? '');
    const checked = checkCitations(BRIEF, PAGES);
    expect([checked.droppedQuotes, checked.droppedArguments]).toStrictEqual([0, 0]);
    const built = buildResult(parseRequest(exampleRequest()), BRIEF.thesis, checked, DEFAULT_MODEL);
    // The model field is the label of the default model, whichever form of it buildResult is given; the rest is the code's, key for key.
    expect(shown).toStrictEqual({ ...built, model: modelLabel(DEFAULT_MODEL) });
    expect(Object.keys(shown)).toStrictEqual(['schema', 'declared_bias', 'thesis', 'arguments', 'sources', 'omitted_by_design', 'search', 'model']);
    expect(Object.keys(built)).toStrictEqual(Object.keys(shown));
    expect(shown.model).toBe(modelLabel(DEFAULT_MODEL));
    expect(sub('Response')).toContain('the time the service fetched it (ISO 8601, UTC)');
    expect(new Date(RETRIEVED_AT).toISOString()).toBe(RETRIEVED_AT);
    expect(sub('Response')).toContain(`"search": "${SEARCH_NAME}", "model": "${modelLabel(DEFAULT_MODEL)}" }`);
    expect(sub('Response')).toContain(`The \`model\` field reads as the service names its default model, \`${modelLabel(DEFAULT_MODEL)}\`.`);
    expect(sub('Response')).toContain('It is an illustration and not a recorded run: its sources are the three pages of the test fixtures of the service');
    for (const a of shown.arguments as Array<{ sources: Array<{ quote: string }> }>) for (const s of a.sources) expect(normalizeText(s.quote).length).toBeGreaterThanOrEqual(QUOTE_MIN_CHARS);
    // A short brief has the arguments of its shape.
    expect(shown.arguments).toHaveLength(SHAPES.short.maxArguments);
  });

  test('the declared bias is the manifest\'s and the result\'s, word for word, and the page states it three times: the rule, the shape and the example', () => {
    expect(DECLARED_BIAS_STATEMENT).toBe('This brief argues one side only, by design, and omits counter-arguments.');
    expect(manifest.behaviour.declared_bias).toStrictEqual({ statement: DECLARED_BIAS_STATEMENT, omitted: OMITTED_BY_DESIGN });
    expect(page.split(DECLARED_BIAS_STATEMENT).length - 1).toBe(3);
    expect(sub('Response')).toContain(`The declared-bias statement is always present and always reads: "${DECLARED_BIAS_STATEMENT}"`);
    const fields = sub('Response');
    expect(row(fields, '`schema`')).toBe(`| \`schema\` | \`${SCHEMA}\` |`);
    expect(row(fields, '`omitted_by_design`')).toBe(`| \`omitted_by_design\` | always \`${OMITTED_BY_DESIGN}\` |`);
    expect(row(fields, '`search`')).toBe(`| \`search\` | always \`${SEARCH_NAME}\` |`);
    expect(row(fields, '`model`')).toContain(`\`${modelLabel(DEFAULT_MODEL)}\` unless \`OPENROUTER_MODEL\` names another`);
    expect(row(fields, '`model`')).toContain('the model the service asked, `<model> via OpenRouter`');
  });

  test('every gap sentence of the manifest is on the page word for word, one to a line and in its order, with the default model, and the page adds none of its own', () => {
    const lines = section('Known gaps').split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toStrictEqual(gapsFor(DEFAULT_MODEL).map((gap) => `- ${gap}`));
    expect(manifest.gaps).toStrictEqual([...gapsFor(DEFAULT_MODEL)]);
    expect(lines).toHaveLength(6);
    expect(section('Known gaps')).toContain(`with the default model of the service, \`${DEFAULT_MODEL}\`.`);
    // The fifth gap names the model the service asks: another model is another manifest, and so another advert.
    const other = manifestFromEnv({ OPERATOR_CONTACT: 'ops@example.test', OPENROUTER_MODEL: 'example/another-model' });
    expect(other.gaps[4]).toContain('example/another-model');
    expect(other.gaps[4]).not.toContain(DEFAULT_MODEL);
  });

  test("the Errors table of the page is the README's, row for row", () => {
    const rows = (text: string) => text.split('\n').filter((l) => /^\| \d{3}, /.test(l)).map((l) => l.replace(/ \([^)]*\)/g, ''));
    const onPage = rows(sub('Errors'));
    expect(onPage).toHaveLength(8);
    expect(onPage).toStrictEqual(rows(readme));
    // The rows with their explanations are the README's, word for word, but for the one word that names this section of the page.
    const whole = (text: string): string[] => text.split('\n').filter((l) => /^\| \d{3}, /.test(l));
    expect(whole(sub('Errors'))).toStrictEqual(whole(readme).map((l) => l.replace('a rule of the request', 'a rule of Request')));
  });

  test('the third parties of the manifest are the ones the page lists, and the links name files that exist', () => {
    const parties = section('Operator and data handling').split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Party |')).map((l) => l.split(' | ')[0].slice(2));
    expect(parties).toStrictEqual(manifest.behaviour.third_parties);
    expect(parties).toStrictEqual([
      'Brave Search API (the two search queries)', 'the hosts of the result pages (the fetch of each page)',
      'OpenRouter and the model provider behind it (the subject, the side, the audience, the language and the length, and the titles, URLs and excerpts of the fetched pages)',
    ]);
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    for (const [, target] of section('Links').matchAll(/\]\(\.\.\/([^)]+)\)/g)) expect(existsSync(root + target), target).toBe(true);
    for (const [, label, target] of section('Links').matchAll(/\[([^\]]+)\]\(\.\.\/([^)]+)\)/g)) expect(label, target).toBe(target);
    expect(manifest.links.source.endsWith('/agents/advocate')).toBe(true);
  });
});

// ---- Pins beyond the brief ----
// Every number, code and rule the page states that the tests above do not hold is held here to the code that owns it.
const tick = (s: string): string => `\`${s}\``;
const kitServer = readFileSync(new URL('../../../packages/service-kit/src/server.ts', import.meta.url), 'utf8');
const sent = (code: string): number => Number(new RegExp(`send\\((\\d{3}), \\{ error: '${code}'`).exec(kitServer)?.[1]);

describe('specs/advocate.md, pinned further', () => {
  test('the Limits table states the budgets of the code: the search, the pages, the model, the service timeout 30 s over the deadline, the window', () => {
    const terms = section('Terms');
    expect(row(terms, 'Search')).toBe(`| Search | two queries, one after the other, the second at least ${QUERY_SPACING_MS} ms after the first, each at most ${SEARCH_QUERY_TIMEOUT_MS} ms, and ${SEARCH_MAX_MS} ms for both |`);
    expect(FETCH_CONCURRENCY).toBe(4);
    expect(row(terms, 'Pages')).toBe(`| Pages | four fetches at a time, at most ${PAGE_TIMEOUT_MS} ms each; the fetch of the pages ends ${FETCH_PHASE_MAX_MS} ms after it begins, or ${FETCH_RESERVE_MS} ms before the deadline when that comes first |`);
    expect(row(terms, 'Model')).toBe(`| Model | the smaller of ${MODEL_MAX_MS} ms and the time the job has left less ${RESULT_RESERVE_MS} ms, and not called when that is under ${MODEL_MIN_MS} ms |`);
    expect(row(terms, 'Service timeout, `SERVICE_TIMEOUT_MS`')).toBe(`| Service timeout, \`SERVICE_TIMEOUT_MS\` | ${JOB_DEADLINE_MS + 30_000} ms |`);
    // The rows say what the two functions of the budget do.
    expect(fetchDeadlineMs(0, JOB_DEADLINE_MS)).toBe(FETCH_PHASE_MAX_MS);
    expect(fetchDeadlineMs(100_000, JOB_DEADLINE_MS)).toBe(JOB_DEADLINE_MS - FETCH_RESERVE_MS);
    expect([modelBudgetMs(JOB_DEADLINE_MS), modelBudgetMs(50_000), modelBudgetMs(MODEL_MIN_MS + RESULT_RESERVE_MS), modelBudgetMs(MODEL_MIN_MS + RESULT_RESERVE_MS - 1)]).toStrictEqual([MODEL_MAX_MS, 50_000 - RESULT_RESERVE_MS, MODEL_MIN_MS, null]);
    expect([manifest.terms.max_processing_ms, MIN_PROCESSING_WINDOW_MS]).toStrictEqual([300_000, 300_000]);
    expect(section('How to hire it')).toContain('Allow for the 5 min processing window.');
    const how = section('How to hire it');
    expect(how).toContain('Ways 1 and 2 wrap it into the wire payload for you. Way 3 does not.');
    expect(how).toContain('1. **Chat client via MCP.**');
    expect(how).toContain("2. **Terminal via the template's buyer.**");
    expect(how).toContain('its step 2 posts the escrow with the sha256 of the wire payload as `prompt_hash`');
    expect(how).toContain('The marketplace tools are on the hosted mainnet server as of 2026-10-14.');
    expect(SHAPES).toStrictEqual({ short: { minArguments: 3, maxArguments: 3, supportWords: 120, maxTokens: 2000 }, standard: { minArguments: 5, maxArguments: 7, supportWords: 200, maxTokens: 4500 } });
    expect(row(terms, 'Length')).toBe(`| Length | \`short\`, a thesis and ${SHAPES.short.maxArguments} arguments asked for, or \`standard\`, a thesis and ${SHAPES.standard.minArguments} to ${SHAPES.standard.maxArguments} arguments asked for; the check can leave fewer; \`standard\` by default |`);
  });

  test("the rules of the Request table are the intake's: the bounds are taken and the next character refused, the side as it is kept, the defaults, the language codes, no other key", () => {
    const rows = Object.fromEntries(sub('Request').split('\n').filter((l) => l.startsWith('| `')).map((l) => [l.split(' | ')[0].slice(2), l.split(' | ')[1]]));
    expect(rows['`subject`, required']).toContain(`1 to ${MAX_SUBJECT_CHARS} characters, with at least one letter or digit`);
    expect(rows['`side`, required']).toContain(`a position in words of 1 to ${MAX_SIDE_CHARS} characters with at least one letter or digit`);
    expect(rows['`side`, required']).toContain('`for` or `against`, in any case, or a position in words');
    expect(rows['`audience`']).toContain(`1 to ${MAX_AUDIENCE_CHARS} characters`);
    expect(rows['`length`']).toBe('`short` or `standard`, default `standard`. |');
    expect(rows['`language`']).toContain('Default `en`.');
    expect(rows['`language`']).toContain('The search is not told it.');
    expect(rows['`language`']).toContain('`auto` is refused');
    expect(rows['`side`, required']).toContain('`for` and `against` are kept in lower case and a position as given, without the spaces around it; the side is returned in `declared_bias.side`');
    expect(rows['`audience`']).toContain('The model is told it.');
    expect(rows['`language`']).toContain('The brief is written in it.');
    expect(rows['`language`']).toContain('such as `en`, `en-GB` or `zh-Hant-TW`');
    const asked = (fields: Record<string, unknown>): string => JSON.stringify({ subject: 'Should a city ban cars from its centre?', side: 'for', ...fields });
    const refused = (fields: Record<string, unknown>): unknown => { try { parseRequest(asked(fields)); return null; } catch (e) { return e; } };
    expect(parseRequest(asked({ subject: 'a'.repeat(MAX_SUBJECT_CHARS) })).subject).toHaveLength(MAX_SUBJECT_CHARS);
    for (const fields of [{ subject: 'a'.repeat(MAX_SUBJECT_CHARS + 1) }, { subject: '?!' }, { side: 'x'.repeat(MAX_SIDE_CHARS + 1) }, { side: '...' }, { audience: 'x'.repeat(MAX_AUDIENCE_CHARS + 1) }, { length: 'long' }, { language: 'auto' }, { language: 'e' }, { extra: 1 }]) {
      const e = refused(fields);
      expect(e, JSON.stringify(fields)).toBeInstanceOf(RequestError);
      expect([(e as RequestError).code, (e as RequestError).status]).toStrictEqual(['bad_shape', 400]);
    }
    expect(parseRequest(asked({ side: 'FOR' })).side).toBe('for');
    expect(parseRequest(asked({ side: '  a ban on weekends only  ' })).side).toBe('a ban on weekends only');
    expect([parseRequest(asked({})).length, parseRequest(asked({})).language, parseRequest(asked({})).audience]).toStrictEqual(['standard', 'en', null]);
    for (const code of ['en', 'en-GB', 'zh-Hant-TW']) expect(parseRequest(asked({ language: code })).language, code).toBe(code);
    // The language code: the pattern and the 16 characters of the schema the manifest publishes, the words of the page, and the edges of both.
    const languageSchema = manifest.interface.request_schema.properties.language;
    expect([languageSchema.maxLength, languageSchema.pattern]).toStrictEqual([16, LANGUAGE_PATTERN]);
    expect(rows['`language`']).toContain('A language code of 2 to 16 characters: 2 to 8 letters, then any number of hyphen-separated subtags of 1 to 8 letters or digits');
    expect(parseRequest(asked({ language: 'abcdefgh-ijklmno' })).language).toBe('abcdefgh-ijklmno');
    for (const code of ['abcdefgh-ijklmnop', 'abcdefghi', 'en-abcdefghi']) expect(refused({ language: code }), code).toBeInstanceOf(RequestError);
    // The audience and the language are put to the model: the user message carries the audience, the system prompt the code of the language.
    expect(userMessage(parseRequest(asked({ audience: 'the council' })), [])).toContain('Audience: the council');
    expect(systemPrompt(parseRequest(asked({ language: 'de' })))).toContain('in the language with the code de');
    expect(sub('Request')).toContain("A request that breaks a rule is refused with `bad_shape` (400) before anything is searched or fetched, so it locks nothing of the service's.");
  });

  test('the job order of the Interface names the queries of the code, the bounds of a search and of a page, and the codes each phase fails with', async () => {
    const text = section('Interface');
    expect(queriesFor('Should a city ban cars from its centre?', 'for')).toStrictEqual(['Should a city ban cars from its centre?', 'Should a city ban cars from its centre? arguments in favour']);
    expect(queriesFor('Cars in the centre', 'against')[1]).toBe('Cars in the centre arguments against');
    expect(queriesFor('Cars in the centre', 'a ban on weekends only')[1]).toBe('Cars in the centre a ban on weekends only');
    expect(text).toContain('(`arguments in favour` for `for`, `arguments against` for `against`, the position itself for a position in words)');
    expect([RESULTS_PER_QUERY, MAX_RESULTS]).toStrictEqual([10, 12]);
    expect(text).toContain(`${RESULTS_PER_QUERY} results each`);
    expect(text).toContain(`at most ${MAX_RESULTS} are kept`);
    expect([QUERY_SPACING_MS, MAX_QUERY_CHARS, MAX_QUERY_WORDS]).toStrictEqual([1_100, 400, 50]);
    expect(text).toContain(`one after the other, the second at least ${QUERY_SPACING_MS} ms after the first`);
    expect(text).toContain(`each cut at a word boundary to at most ${MAX_QUERY_CHARS} characters and ${MAX_QUERY_WORDS} words`);
    expect(text).toContain(`A query that answers 429 is asked once more, ${QUERY_SPACING_MS} ms later.`);
    expect([PAGE_MAX_BYTES, MIN_PAGE_CHARS, EXCERPT_CHARS]).toStrictEqual([1_048_576, 200, 12_000]);
    expect(text).toContain(`its first ${EXCERPT_CHARS} characters are its excerpt`);
    expect(text).toContain(`each with a quote of ${QUOTE_MIN_CHARS} to ${QUOTE_MAX_CHARS} characters copied from that page`);
    for (const code of ['search_failed', 'search_empty', 'no_sources', 'model_failed', 'model_output_invalid', 'no_supported_claims']) expect(text, code).toContain(`${tick(code)} (502)`);
    expect(text).toContain('`deadline` (422)');
    // The rules of the fetch of a page are safeFetch's: https only, no credentials in the URL, a private or reserved address refused, a redirect refused.
    expect(text).toContain('(https only, no credentials in the URL, private and reserved addresses refused, redirects refused)');
    const fetchRules = { maxResponseBytes: PAGE_MAX_BYTES, timeoutMs: 1000 };
    await expect(safeFetch('http://example.org/a', {}, fetchRules)).rejects.toThrow('only https URLs are allowed');
    await expect(safeFetch('https://user:pw@example.org/a', {}, fetchRules)).rejects.toThrow('credentials in URLs are not allowed');
    await expect(safeFetch('https://example.org/a', {}, { ...fetchRules, lookup: async () => [{ address: '10.0.0.1', family: 4 }] })).rejects.toThrow('private or reserved address');
    const moved = async () => new Response(null, { status: 302, headers: { location: 'https://example.org/b' } });
    await expect(safeFetch('https://example.org/a', {}, { ...fetchRules, lookup: async () => [{ address: '93.184.216.34', family: 4 }], fetchImpl: moved as typeof fetch })).rejects.toThrow('redirects are not followed');
    // What the mutation of the page found unheld: a code that the Errors and the Check text repeat, the megabyte of a page, the numbering, and two sentences the specs share.
    expect(text).toContain('the job fails with `deadline` (422)');
    expect(text).toContain('No argument left is `no_supported_claims` (502).');
    expect(text).toContain(`is at most ${PAGE_MAX_BYTES / 1_048_576} MB and has at least ${MIN_PAGE_CHARS} characters of text`);
    expect(text).toContain(`at most ${PAGE_MAX_BYTES / 1_048_576} MB a page`);
    expect(text).toContain(`the kept pages are numbered from ${PAGES[0].n} in the order of the results`);
    expect(text).toContain('The sha256 of its UTF-8 bytes is the `prompt_hash` of the escrow.');
    expect(text).toContain('(on the hosted mainnet server since 2026-10-14)');
    expect(text).toContain('the service finds the pages with the Brave Search API and fetches them itself');
    expect(text).toContain('Both failing is `search_failed` (502), and so is a key that the Brave Search API refuses.');
    expect(text).toContain('one call through OpenRouter with a fixed prompt');
    // The numbers of the pages and of the model that the bullets state are the code's.
    expect(FETCH_CONCURRENCY).toBe(4);
    expect(text).toContain('four at a time');
    expect(text).toContain(`answers within ${PAGE_TIMEOUT_MS / 1000} s`);
    expect(text).toContain(`has at least ${MIN_PAGE_CHARS} characters of text`);
    expect(text).toContain(`With under ${MODEL_MIN_MS / 1000} s left the model is not called`);
    // The search is not told the language (ruling R-E15): the page says so, and the two requests to the Brave Search API carry a query, a count, the safe search and the plain texts, and nothing else.
    expect(text).toContain('two queries to the Brave Search API, made from the subject and the side, with no language parameter and no country');
    const urls: string[] = [];
    const braveFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ web: { results: [{ title: 'T', url: `https://example.org/answer-${urls.length}`, description: 'D' }] } }), { status: 200 });
    }) as typeof fetch;
    const found = await searchWeb(queriesFor('Should a city ban cars from its centre?', 'for'), {
      fetchImpl: braveFetch, apiKey: 'a-key-for-this-test', clock: Date.now, timeoutMs: 1000, phaseEndMs: Date.now() + 60_000, wait: async () => undefined, log: () => undefined,
    });
    expect(urls.map((url) => [...new URL(url).searchParams.keys()])).toStrictEqual([['q', 'count', 'safesearch', 'text_decorations'], ['q', 'count', 'safesearch', 'text_decorations']]);
    // The results of the second query come first, as the page says.
    expect(text).toContain('The results of the second query come first');
    expect(found.map((result) => result.url)).toStrictEqual(['https://example.org/answer-2', 'https://example.org/answer-1']);
  });

  test('the Check section states the normalisation of the code, the bounds of a quote, and what is dropped', () => {
    const check = sub('Check');
    expect(check).toContain('the service takes its Unicode NFKC form in lower case');
    expect(normalizeText(String.fromCharCode(0xfb01))).toBe('fi');
    expect(check).toContain(`is ${QUOTE_MIN_CHARS} to ${QUOTE_MAX_CHARS} characters long and is found in the normalised excerpt of that page`);
    expect(normalizeText('Don\u2019t \u201cstop\u201d \u2013 now\u2014then    it\u02bcs OK ')).toBe('don\'t "stop" - now-then it\'s ok');
    expect(check).toContain('makes the apostrophes U+2019 and U+02BC into U+0027, the double quotes U+201C and U+201D into U+0022 and the dashes U+2013 and U+2014 into U+002D');
    const excerpt = PAGES[0].excerpt;
    const quote = 'retail footfall rise by eleven percent within two years';
    expect([quoteFound(quote, excerpt), quoteFound(quote.toUpperCase(), excerpt), quoteFound(`  ${quote}  `, excerpt)]).toStrictEqual([true, true, true]);
    expect(['retail footfall rise'.length, quoteFound('retail footfall rise', excerpt), quoteFound('etail footfall rise', excerpt)]).toStrictEqual([QUOTE_MIN_CHARS, true, false]);
    expect([quoteFound('x'.repeat(QUOTE_MAX_CHARS), 'x'.repeat(QUOTE_MAX_CHARS)), quoteFound('x'.repeat(QUOTE_MAX_CHARS + 1), 'x'.repeat(QUOTE_MAX_CHARS + 1))]).toStrictEqual([true, false]);
    expect(quoteFound('the street became a river of bicycles overnight', excerpt)).toBe(false);
    expect(check).toContain('A quote that fails is dropped. An argument left with no quote is dropped, and the thesis stays.');
    // Every argument dropped is no_supported_claims (502), and the thesis never answers alone.
    let thrown: unknown;
    try { checkCitations({ thesis: BRIEF.thesis, arguments: [{ claim: 'c', support: 's', sources: [{ n: 9, quote }] }] }, PAGES); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(AdvocateError);
    expect([(thrown as AdvocateError).code, (thrown as AdvocateError).status]).toStrictEqual(['no_supported_claims', 502]);
    expect(check).toContain('A job whose every argument is dropped fails with `no_supported_claims` (502): the thesis never answers alone.');
    // A quote cited twice is one source of the result.
    const twice = checkCitations({ thesis: 't', arguments: [{ claim: 'a', support: 's', sources: [{ n: 1, quote }] }, { claim: 'b', support: 's', sources: [{ n: 1, quote }] }] }, PAGES);
    expect([twice.arguments.length, twice.sources.length]).toStrictEqual([2, 1]);
    expect(check).toContain('A quote may be cited by more than one argument.');
  });

  test("the Errors text states the statuses of the code, the fixed message of a failed job, and the statuses of the kit's codes, read from packages/service-kit", async () => {
    const errors = sub('Errors');
    const rows = errors.split('\n').filter((l) => /^\| \d{3}, /.test(l));
    for (const code of Object.keys(JOB_STATUS) as JobCode[]) {
      expect(rows.find((l) => l.split('|')[2].includes(tick(code))), code).toMatch(new RegExp(`^\\| ${JOB_STATUS[code]}, `));
      expect(new AdvocateError(code, 'what the log gets').message, code).toBe(operatorsText(code));
    }
    expect(errors).toContain("A job that fails with a code of the 502 row answers with a fixed message: `The service could not do this job (<code>). The operator's log has the detail.`");
    expect(errors).toContain('`deadline` (422) keeps its words');
    // What the real server answers for each code of a job: the fixed message for the 502 row, and the words the job was given for the 422 and the 499.
    const answerTo = (error: Error) => serve({ manifest, deps: baseDeps(), log: () => undefined, runAdvocate: async () => { throw error; } }, async (api) => {
      const r = await api.post(wire(GOLDEN_REQUEST));
      return { status: r.status, json: r.json };
    });
    for (const code of Object.keys(JOB_STATUS) as JobCode[]) {
      const answer = await answerTo(new AdvocateError(code, `the words of ${code}`));
      expect([answer.status, answer.json], code).toStrictEqual([JOB_STATUS[code], { error: code, message: JOB_STATUS[code] === 502 ? operatorsText(code) : `the words of ${code}` }]);
    }
    // The 500 and the 401 have the code and no message; the 503 says in words that the service is stopping.
    expect(await answerTo(new Error('a fault of the code'))).toStrictEqual({ status: 500, json: { error: 'internal' } });
    expect(await serve({ manifest, deps: baseDeps(), log: () => undefined }, async (api) => {
      const r = await api.request('POST', '/', wire(GOLDEN_REQUEST), { authorization: null });
      return { status: r.status, json: r.json };
    })).toStrictEqual({ status: 401, json: { error: 'unauthorized' } });
    const draining = new JobSlot();
    draining.drain();
    expect(await serve({ manifest, deps: baseDeps(), log: () => undefined, slot: draining }, async (api) => {
      const r = await api.post(wire(GOLDEN_REQUEST));
      return { status: r.status, json: r.json };
    })).toStrictEqual({ status: 503, json: { error: 'shutting_down', message: STOPPING_TEXT } });
    expect(STOPPING_TEXT).toContain('stopping');
    expect(errors).toContain('The 401 and `internal` have the code and no message.');
    // The two open routes are matched on their path, whatever the query string; a HEAD gets the headers and no body; a POST with a query string is not found.
    await serve({ manifest, deps: baseDeps(), log: () => undefined }, async (api) => {
      expect([(await api.get('/healthz?x=1')).status, (await api.get('/agent.json?x=1')).status]).toStrictEqual([200, 200]);
      const head = await api.request('HEAD', '/healthz');
      expect([head.status, head.text]).toStrictEqual([200, '']);
      expect((await api.request('POST', '/?x=1', wire(GOLDEN_REQUEST))).status).toBe(404);
    });
    expect(errors).toContain('are matched on their path, whatever the query string, and a `HEAD` of either gets the headers of the `GET` and no body');
    expect(errors).toContain('copies the first 200 characters of the failure to the buyer');
    expect(errors).toContain('The codes of the 502 row are failures at a third party or of the check.');
    expect(errors).toContain('`aborted` (499) is the answer to a caller that has hung up, which nobody reads.');
    expect(errors).toContain('`shutting_down` says that the service is stopping.');
    expect(MAX_BODY).toBe(1_000_000);
    expect(errors).toContain('`request_too_large` (over 1000000 bytes)');
    const statuses: Record<string, number> = {
      bad_wire: new WireError('bad_wire', 'x').status, request_too_large: new WireError('request_too_large', 'x').status, unauthorized: sent('unauthorized'),
      shutting_down: sent('shutting_down'), internal: sent('internal'), busy: sent('busy'), not_found: sent('not_found'),
    };
    expect(statuses).toStrictEqual({ bad_wire: 400, request_too_large: 400, unauthorized: 401, shutting_down: 503, internal: 500, busy: 409, not_found: 404 });
    for (const code of ['bad_wire', 'request_too_large', 'unauthorized', 'shutting_down', 'internal']) {
      expect(rows.find((l) => l.split('|')[2].includes(tick(code))), code).toMatch(new RegExp(`^\\| ${statuses[code]}, `));
    }
    expect(errors).toContain(`gets ${statuses.busy} \`{"error":"busy"}\``);
    expect(errors).toContain(`gets ${statuses.not_found} \`{"error":"not_found"}\``);
    expect(HEARTBEAT_MS).toBe(60_000);
    expect(errors).toContain('While a job runs the service writes an interim `102 Processing` line every 60 s');
    expect(errors).toContain("because the runtime's fetch gives up on a response that has not begun after 300 s of silence");
    expect(errors).toContain(`a job ends within ${JOB_DEADLINE_MS / 1000} s`);
    expect(errors).toContain('The 400s and the 401 come before anything is searched or fetched.');
  });

  test('Operator and data handling says what the manifest says the service holds, sends and logs, and names the user agent of the code', () => {
    const handling = section('Operator and data handling');
    for (const part of ['held in memory while a job runs', 'nothing is written to disk and nothing is kept after the job', 'the escrow carries only the sha256 of the wire payload, and the request stays off the ledger', 'never a request, a page, a quote or a key']) {
      expect(handling, part).toContain(part);
      expect(manifest.behaviour.data_handling, part).toContain(part);
    }
    expect(handling).toContain(tick(USER_AGENT));
    expect(handling).toContain('the language of the request is not sent');
    expect(handling).toContain('with no language parameter');
    // The sentences of the manifest that the page repeats are repeated word for word: what the ledger holds, and what the log carries.
    const [held, , ledger, logged] = manifest.behaviour.data_handling.split(/(?<=[.]) /);
    expect([held.startsWith('The subject, the side, the audience, the length and the language are held in memory while a job runs'), ledger.startsWith('On the ledger'), logged.startsWith('The log carries')]).toStrictEqual([true, true, true]);
    expect(handling).toContain(ledger);
    expect(handling).toContain(logged);
    // The model is sent the language code and the shape of the length in its prompt, and the titles and the URLs of the pages in its message, as the third-parties sentence says.
    expect(row(handling, manifest.behaviour.third_parties[2])).toContain('the fixed prompt, which holds the language code and the shape of the length asked for');
    expect(handling).toContain("Datalab is not used, and no model runs on the operator's host.");
  });

  test('the Controller row names the three fields of the manifest and the check at start, and the code does it', () => {
    const controller = row(section('Identity'), 'Controller');
    for (const field of ['identity.controller_pkh', 'keys.supplier_pkh', 'keys.pub_key_hex']) expect(controller, field).toContain(tick(field));
    expect(controller).toContain('the service does not start unless the public key hashes to the key hash');
    const pub = 'ab'.repeat(32);
    const env = {
      OPERATOR_CONTACT: 'ops@example.test', SUPPLIER_PKH: blake2b224Hex(pub), SUPPLIER_PUB_KEY_HEX: pub, SERVICE_AUTH_HEADER: `Bearer ${'cd'.repeat(32)}`,
      BRAVE_SEARCH_API_KEY: 'BSAtestkey0123456789abcdefghij', OPENROUTER_API_KEY: `sk-or-v1-${'0123456789abcdef'.repeat(4)}`,
    };
    const config = loadConfig(env);
    // Neither API key reaches the manifest (the page says so); each is sent to its own party alone.
    for (const key of [env.BRAVE_SEARCH_API_KEY, env.OPENROUTER_API_KEY]) expect(JSON.stringify(config.manifest).toLowerCase().includes(key.toLowerCase()), 'a key in the manifest').toBe(false);
    expect([config.manifest.identity.controller_pkh, config.manifest.keys]).toStrictEqual([env.SUPPLIER_PKH, { supplier_pkh: env.SUPPLIER_PKH, pub_key_hex: pub }]);
    expect(() => loadConfig({ ...env, SUPPLIER_PUB_KEY_HEX: 'ef'.repeat(32) })).toThrow(/is not the public key of SUPPLIER_PKH/);
    expect(row(section('What the receipt commits to'), '`supplier_pkh`')).toContain('which is also the controller key');
    expect(section('Capability id')).toContain('It holds the two API keys of its third parties, `BRAVE_SEARCH_API_KEY` and `OPENROUTER_API_KEY`. Each is sent only to its own party, and neither reaches an answer, a log line or the manifest.');
  });
});
