// agents/advocate/test/spec.test.ts
// specs/advocate.md is the public page of the agent and the manifest links to its Response section. These tests hold the page to the code: the numbers of the
// terms and the limits, the status, the identity, the request fields of the schema the manifest publishes, the example result (made here by the check and the
// result of the service from the three pages of the fixtures), the declared bias, the gap sentences word for word, the error codes with their statuses, and the
// third parties.
import { afterEach, describe, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACCEPT_WINDOW_MS, DELIVER_BY_BUFFER_MS, TX_FEE_BUDGET_LOVELACE, buyerIdentityOf, responsesPromptHash } from '@vsa/buyer-core';
import { BUSY_RETRY_MS, JANITOR_GRACE_MS, POLL_INTERVAL_MS, RECEIPT_HASH_WAIT_MS, SEND_CUTOFF_MS, STRANDED_FILE, chatJob } from '@vsa/hire-kit';
import type { HireRecord } from '@vsa/hire-kit';
import { HEARTBEAT_MS, MAX_BODY, STOPPING_TEXT, WireError, operatorsText } from '@vsa/service-kit';
import { REGISTRY_ADDRESS, blake2b224Hex, safeFetch } from '@vsa/vector-read';
import {
  CHOICE_BUDGET_MS, CHOICE_MAX_CANDIDATES, CHOICE_WITHIN_MS, FALLBACK_RESERVE_MS, FETCH_CONCURRENCY, FETCH_PHASE_MAX_MS, FETCH_RESERVE_MS, HOP_MIN_MS, JOB_DEADLINE_MS, MODEL_MAX_MS,
  MODEL_MIN_MS, PAGE_TIMEOUT_MS, RESULT_RESERVE_MS, SEARCH_MAX_MS, SEARCH_QUERY_TIMEOUT_MS, WALLET_READ_MS, fetchDeadlineMs, hopDeadlineMs, modelBudgetMs, receiptByMs,
} from '../src/budget.ts';
import { checkCitations, quoteFound } from '../src/check.ts';
import { AdvocateError, JOB_STATUS } from '../src/errors.ts';
import type { JobCode } from '../src/errors.ts';
import { gapsFor } from '../src/gaps.ts';
import { EXCERPT_CHARS, MIN_PAGE_CHARS, collapseWhitespace, extractText } from '../src/html.ts';
import { DEFAULT_MODEL, callModel, modelLabel } from '../src/model.ts';
import type { ModelBrief } from '../src/model.ts';
import { marketplaceInput } from '../src/inference.ts';
import type { Inference } from '../src/inference.ts';
import { normalizeText } from '../src/normalize.ts';
import { ACCEPTED_TYPES, PAGE_MAX_BYTES, USER_AGENT, fetchPages } from '../src/pages.ts';
import type { Page } from '../src/pages.ts';
import { DECLARED_BIAS_STATEMENT, OMITTED_BY_DESIGN, QUOTE_MAX_CHARS, QUOTE_MIN_CHARS, SHAPES, systemPrompt, userMessage } from '../src/prompt.ts';
import { LANGUAGE_PATTERN, MAX_AUDIENCE_CHARS, MAX_SIDE_CHARS, MAX_SUBJECT_CHARS, RequestError, parseRequest } from '../src/request.ts';
import { SCHEMA, SEARCH_NAME, buildResult, serializeResult } from '../src/result.ts';
import { MAX_QUERY_CHARS, MAX_QUERY_WORDS, MAX_RESULTS, QUERY_SPACING_MS, RESULTS_PER_QUERY, dedupeResults, queriesFor, searchWeb } from '../src/search.ts';
import type { SearchResult } from '../src/search.ts';
import { JobSlot, MIN_PROCESSING_WINDOW_MS, manifestFromEnv } from '../src/server.ts';
import { SETTINGS, loadConfig } from '../src/start.ts';
import { at, publicLookup, reply, routedFetch } from './fake-fetch.ts';
import { GOLDEN_OUTCOME, GOLDEN_REQUEST } from './golden.ts';
import { baseDeps, cleanDirs, serve, wire } from './server-support.ts';

// baseDeps makes a chain and a stranded store in a temporary directory of its own; the directories of a test go after it.
afterEach(() => { cleanDirs(); });

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

// The seven checks of a sub-receipt, in the order of verifyFleetReceipt (packages/buyer-core/src/fleet-verify.ts), which the verification object of a sub-job keeps.
const fleetVerify = readFileSync(new URL('../../../packages/buyer-core/src/fleet-verify.ts', import.meta.url), 'utf8');
const CHECKS = [...(/const checks: FleetVerification\['checks'\] = \{([\s\S]*?)\};/.exec(fleetVerify)?.[1] ?? '').matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
// The inference of the example: the marketplace path, with a sub-job made up for the page in the shape the service gives it (HireRecord of @vsa/hire-kit). Its
// references, hashes, key hash and signature are made from labels, so that none is of an escrow, a supplier or a key; the receipt names the model of the advert,
// and every check passed, as for any sub-job the service accepts.
const made = (label: string, algorithm = 'sha256'): string => createHash(algorithm).update(`advocate example: ${label}`).digest('hex');
const EXAMPLE_ESCROW = `${made('the escrow')}#0`;
const EXAMPLE_SUPPLIER = made('the supplier key').slice(0, 56);
const EXAMPLE_SUB_JOB: HireRecord = {
  capability_id: 'llm.text.generate.v1', advert_ref: `${made('the advert')}#0`, escrow_ref: EXAMPLE_ESCROW, supplier_pkh: EXAMPLE_SUPPLIER,
  receipt: {
    escrow_ref: EXAMPLE_ESCROW, supplier_pkh: EXAMPLE_SUPPLIER, prompt_hash: made('the prompt'), response_hash: made('the answer'), model: DEFAULT_MODEL,
    prompt_tokens: 4321, completion_tokens: 512, wallclock_ms: 3005,
  },
  receipt_signature: made('the signature', 'sha512'),
  verification: Object.fromEntries(CHECKS.map((check) => [check, true])),
};
const EXAMPLE_INFERENCE: Inference = {
  brief: BRIEF, usage: { prompt_tokens: 4321, completion_tokens: 512 }, path: 'marketplace', model: DEFAULT_MODEL, subJob: EXAMPLE_SUB_JOB, accepted: 'confirmed', fallbackFrom: null,
};

describe('specs/advocate.md', () => {
  test('the Terms tables carry the numbers of the manifest and of the code', () => {
    const terms = section('Terms');
    expect(row(terms, 'Price')).toBe(`| Price | ${manifest.terms.price_lovelace} | 3.000000 |`);
    expect(row(terms, 'Supplier bond')).toBe(`| Supplier bond | ${manifest.terms.supplier_bond_lovelace} | 1.000000 |`);
    expect(row(terms, 'Buyer bond')).toBe(`| Buyer bond | ${manifest.terms.buyer_bond_lovelace} | 1.000000 |`);
    const locked = manifest.terms.price_lovelace + manifest.terms.supplier_bond_lovelace + manifest.terms.buyer_bond_lovelace;
    expect(row(terms, 'Locked by the buyer (price and both bonds)')).toBe(`| Locked by the buyer (price and both bonds) | ${locked} | ${(locked / 1_000_000).toFixed(6)} |`);
    expect(row(terms, 'Processing window, advert `max_processing_ms`')).toBe(`| Processing window, advert \`max_processing_ms\` | ${manifest.terms.max_processing_ms} ms |`);
    expect(row(terms, 'Job deadline, set by the service when a request arrives')).toBe(`| Job deadline, set by the service when a request arrives | ${JOB_DEADLINE_MS} ms (60 s inside the service timeout) |`);
    const limits = manifest.terms.input_limits;
    expect([limits.request_bytes, limits.subject_chars, limits.side_chars, limits.audience_chars, limits.results, limits.page_bytes, limits.excerpt_chars, limits.quote_chars_min, limits.quote_chars_max])
      .toStrictEqual([900_000, MAX_SUBJECT_CHARS, MAX_SIDE_CHARS, MAX_AUDIENCE_CHARS, MAX_RESULTS, PAGE_MAX_BYTES, EXCERPT_CHARS, QUOTE_MIN_CHARS, QUOTE_MAX_CHARS]);
    expect(row(terms, 'Request')).toBe(`| Request | at most ${limits.request_bytes} bytes of wire payload; \`subject\` 1 to ${limits.subject_chars} characters, \`side\` 1 to ${limits.side_chars}, \`audience\` 1 to ${limits.audience_chars} |`);
    expect(row(terms, 'Search results')).toBe(`| Search results | at most ${limits.results}, https only |`);
    expect(row(terms, 'Page')).toBe(`| Page | at most 1 MB (${limits.page_bytes} bytes) fetched and at least ${MIN_PAGE_CHARS} characters of text; the first ${limits.excerpt_chars} characters are read |`);
    expect(row(terms, 'Quote')).toBe(`| Quote | ${limits.quote_chars_min} to ${limits.quote_chars_max} characters, once normalised (see Check) |`);
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
    expect(manifest.status).toStrictEqual({ chip: 'deployed', since: '2026-10-20' });
    // The status line of the page opens with the word the manifest carries and ends with its date: DEPLOYED since the flip of 2026-10-20, never LIVE.
    expect(section('Status').trimStart().startsWith(`${manifest.status.chip.toUpperCase()} (`)).toBe(true);
    expect(section('Status')).toContain(`). Since ${manifest.status.since}.\n`);
    expect(section('Status').split('\n')).toContain('DEPLOYED (registered and staked 2026-10-19, advertised 2026-10-19, re-advertised 2026-10-20 at the status flip, one first-party job settled 2026-10-20). Since 2026-10-20.');
    expect(row(section('Identity'), 'Registry address')).toBe(`| Registry address | \`${REGISTRY_ADDRESS}\` |`);
    // The public URL is the one the advert carries, in service as of 2026-10-19: the runbook and the example file of the host name the same URL.
    expect(row(section('Identity'), 'Public URL')).toBe('| Public URL | `https://mp-suppliers-advocate.hal8.ai` (in service as of 2026-10-19) |');
    expect(readFileSync(new URL('../../../deploy/host/RUNBOOK-advocate.md', import.meta.url), 'utf8')).toContain('| Public name | `mp-suppliers-advocate.hal8.ai` |');
    expect(readFileSync(new URL('../../../deploy/host/.env.advocate.example', import.meta.url), 'utf8')).toContain('ADVERT_ENDPOINT_URL=https://mp-suppliers-advocate.hal8.ai\n');
    // The runtime holds the supplier key and signs the receipt; the service holds the buyer key and no other chain key, and the one private key its settings name is that one.
    expect(section('Capability id')).toContain('The runtime claims the escrow, calls this service, signs the receipt and submits the receipt hash. The service holds the buyer key, which posts the escrow of the chat sub-job of a job, and no other chain key.');
    expect(SETTINGS.filter((name) => /PRIV|SEED|SECRET|SKEY/.test(name))).toStrictEqual(['ADVOCATE_BUYER_PRIV_KEY_HEX']);
    expect(Object.keys(manifest.keys)).toStrictEqual(['supplier_pkh', 'pub_key_hex', 'buyer_pkh']);
    // The buyer key exists since step 4 ran again on the host, on 2026-10-19: the row gives the key hash the manifest serves under keys.buyer_pkh, a key hash of its own.
    expect(row(section('Identity'), 'Second key')).toBe("| Second key | the buyer key, a separate key that posts the escrow of the chat sub-job of a job, so its Posts and the supplier key's Claims never contend for the same UTxOs. It was made on the host on 2026-10-19, in step 4 of the runbook. The manifest publishes its key hash, `ee450a88d8344f18dd2baf266100aec3b1375b5870b2fe50f34de123`, as `keys.buyer_pkh`, which the service derives from the key |");
    expect(row(section('Identity'), 'Second key, planned')).toBe('');
    // Two keys: the key hash of the buyer key is not the supplier key hash, the controller of the registry record.
    const controller = /; controller key hash `([0-9a-f]{56})` \(the supplier key hash\)/.exec(row(section('Identity'), 'Registry record'))?.[1];
    expect(controller).toMatch(/^[0-9a-f]{56}$/);
    expect(controller).not.toBe('ee450a88d8344f18dd2baf266100aec3b1375b5870b2fe50f34de123');
    // The stake is the 10 units the runbook of the host names: 10000000 lovelace, printed with six decimals, made on 2026-10-19.
    expect(row(section('Identity'), 'Reputation stake')).toContain('| Reputation stake | a Module-3 self-stake of 10000000 lovelace (10.000000) on the capability, made on 2026-10-19 in transaction ');
    expect(readFileSync(new URL('../../../deploy/host/RUNBOOK-advocate.md', import.meta.url), 'utf8')).toContain('the stake (10)');
    // The receipt table and the two sentences under it, held in words.
    const receipt = section('What the receipt commits to');
    expect(row(receipt, '`prompt_hash`')).toContain('sha256 of the UTF-8 bytes of the wire payload');
    expect(row(receipt, '`response_hash`')).toContain('sha256 of the UTF-8 bytes of the brief exactly as the service returned them');
    expect(row(receipt, '`prompt_tokens`, `completion_tokens`')).toContain('0 and 0, the runtime counts none. The service writes the tokens of its model call in its log; on the marketplace path the receipt of the chat supplier, under `inference.sub_job`, carries the counts of that supplier');
    // What the receipt commits to and what it does not, in the words of the page: the brief is the committed output; the page text, the truth of the claims and the balance of the brief are not.
    expect(receipt).toContain('The brief is the committed output, so the receipt commits the declared-bias block, the thesis, every argument and its sources with their quotes and the times the pages were fetched, and the path of the model call with the sub-receipt of the chat supplier, its signature and the checks the service ran on it. The sub-receipt is signed by the chat supplier the service hired, an agent under its own key, and accountability for the brief stays on the key of Advocate. A quote in the brief was found in the text the service fetched from the page it names. The receipt does not commit to the page text itself, to the claims being true, or to the brief being balanced: it omits the other side by design.');
    expect(receipt).toContain('The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.');
  });

  test('the request: the page shows every field of the schema the manifest publishes, and its examples are requests the intake accepts', () => {
    const request = sub('Request');
    for (const field of Object.keys(manifest.interface.request_schema.properties)) expect(request, field).toContain(`\`${field}\``);
    expect(parseRequest(exampleRequest())).toStrictEqual(THE_REQUEST);
    const inline = /The request JSON is, for example, `([^`]+)`/.exec(section('How to hire it'))?.[1] ?? '';
    expect(parseRequest(inline)).toStrictEqual(THE_REQUEST);
    // The manifest says of the length what the page says (ruling R-E28): the prompt asks for 3 arguments (short) or 5 to 7 (standard), and the check can leave fewer.
    const lengthDescription = manifest.interface.request_schema.properties.length.description;
    expect(lengthDescription).toBe(`The prompt asks for a thesis and ${SHAPES.short.minArguments} arguments (short) or ${SHAPES.standard.minArguments} to ${SHAPES.standard.maxArguments} arguments (standard), and the check can leave fewer`);
    expect(lengthDescription).not.toMatch(/exactly/);
  });

  test('the response: one Response heading, the anchor the manifest links to, and its example is what the check and the result of the service make of the pages of the fixtures and the brief of the example', () => {
    expect(page.match(/^### Response$/gm)).toHaveLength(1);
    expect(manifest.interface.response_schema.$ref.endsWith('/specs/advocate.md#response')).toBe(true);
    const shown = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(sub('Response'))?.[1] ?? '');
    const checked = checkCitations(BRIEF, PAGES);
    expect([checked.droppedQuotes, checked.droppedArguments]).toStrictEqual([0, 0]);
    const built = buildResult(parseRequest(exampleRequest()), BRIEF.thesis, checked, EXAMPLE_INFERENCE);
    // The example is what the code makes of the brief and the inference of the example, key for key: the marketplace path, with its sub-job.
    expect(shown).toStrictEqual(built);
    expect(Object.keys(shown)).toStrictEqual(['schema', 'declared_bias', 'thesis', 'arguments', 'sources', 'omitted_by_design', 'search', 'model', 'inference']);
    expect(Object.keys(built)).toStrictEqual(Object.keys(shown));
    expect(shown.model).toBe(modelLabel(DEFAULT_MODEL, 'marketplace'));
    expect(shown.inference).toStrictEqual({ path: 'marketplace', fallback_from: null, sub_job: EXAMPLE_SUB_JOB, accepted: 'confirmed' });
    expect(Object.keys(shown.inference)).toStrictEqual(['path', 'fallback_from', 'sub_job', 'accepted']);
    expect(Object.keys(shown.inference.sub_job)).toStrictEqual(['capability_id', 'advert_ref', 'escrow_ref', 'supplier_pkh', 'receipt', 'receipt_signature', 'verification']);
    expect(CHECKS).toStrictEqual(['escrow_ref_matches', 'response_hash_matches', 'supplier_key_matches', 'signature_valid', 'on_chain_hash_matches', 'prompt_hash_matches', 'model_matches']);
    expect(Object.keys(shown.inference.sub_job.verification)).toStrictEqual(CHECKS);
    expect(sub('Response')).toContain('the time the service fetched it (ISO 8601, UTC)');
    expect(new Date(RETRIEVED_AT).toISOString()).toBe(RETRIEVED_AT);
    expect(sub('Response')).toContain(`"search": "${SEARCH_NAME}", "model": "${modelLabel(DEFAULT_MODEL, 'marketplace')}",\n  "inference": { "path": "marketplace | openrouter", "fallback_from": "<code> | null",`);
    expect(sub('Response')).toContain(`The \`model\` field reads as the service names its default model on the marketplace path, \`${modelLabel(DEFAULT_MODEL, 'marketplace')}\`, and the sub-job under \`inference\` is made up for the illustration in the shape the service gives it: its references, hashes, key hash and signature are of no escrow and no supplier.`);
    expect(sub('Response')).toContain('It is an illustration and not a recorded run: its sources are the three pages of the test fixtures of the service');
    for (const a of shown.arguments as Array<{ sources: Array<{ quote: string }> }>) for (const s of a.sources) expect(normalizeText(s.quote).length).toBeGreaterThanOrEqual(QUOTE_MIN_CHARS);
    // A short brief has the arguments of its shape.
    expect(shown.arguments).toHaveLength(SHAPES.short.maxArguments);
  });

  test('the Response example is the result as it is serialised, the keys of it and of the Shape come in the order of the result at every level, and the rows of the fields say what the check does', () => {
    const checked = checkCitations(BRIEF, PAGES);
    const built = buildResult(parseRequest(exampleRequest()), BRIEF.thesis, checked, EXAMPLE_INFERENCE);
    const result = built;
    const response = sub('Response');
    // The example is JSON.stringify(result, null, 2) byte for byte, so the keys of every object stand in the order the result has them (toStrictEqual does not see the order).
    expect(/```json\n([\s\S]*?)\n```/.exec(response)?.[1]).toBe(JSON.stringify(result, null, 2));
    // The Shape names the keys in the same order: the names in it, read as they stand, are the keys of the result depth first, the first element of a list standing for the list.
    // The Shape names the receipt and the checks of a sub-job and not their fields, which How it buys gives: the walk names them and does not go into them.
    const LEAVES = ['receipt', 'verification'];
    const walk = (value: unknown): string[] => {
      if (Array.isArray(value)) return walk(value[0]);
      if (value === null || typeof value !== 'object') return [];
      return Object.entries(value).flatMap(([key, inner]) => [key, ...(LEAVES.includes(key) ? [] : walk(inner))]);
    };
    const shape = /```text\n([\s\S]*?)\n```/.exec(response)?.[1] ?? '';
    const names = (shape.match(/"[a-z_]+"/g) ?? []).map((name) => name.slice(1, -1));
    expect(names).toStrictEqual(walk(result));
    expect(names).toHaveLength(33);
    // The receipt hashes this body: it holds the declared-bias block, the thesis, every argument and its sources with their quotes and the times the pages were fetched, and no text of a page.
    for (const key of ['declared_bias', 'thesis', 'arguments', 'sources', 'quote', 'retrieved_at']) expect(names, key).toContain(key);
    expect(names).not.toContain('excerpt');
    // The rows of the fields: the thesis as the model wrote it; the arguments the check kept, in the order the model gave them, each source with the title the search gave; the sources of the kept arguments, once for each page and quote, in the order they are first cited.
    expect(row(response, '`thesis`')).toBe('| `thesis` | the thesis of the brief, as the model wrote it |');
    expect(row(response, '`arguments[]`')).toBe('| `arguments[]` | the arguments the check kept, in the order the model gave them, each with its `claim`, its `support` and its `sources`: for each source the `title` the search gave for the page, its `url`, `retrieved_at`, the time the service fetched it (ISO 8601, UTC), and the `quote` that was found in its text, in the words of the page (see Check) |');
    expect(row(response, '`sources[]`')).toBe('| `sources[]` | every source that the kept arguments cite, once for each page and quote, in the order they are first cited |');
    expect(built.thesis).toBe(BRIEF.thesis);
    expect(built.arguments.map((a) => a.claim)).toStrictEqual(BRIEF.arguments.map((a) => a.claim));
    expect(built.arguments[0].sources[0].title).toBe(PAGES[0].title);
    const [first, second] = BRIEF.arguments;
    const swapped = checkCitations({ thesis: BRIEF.thesis, arguments: [second, first] }, PAGES);
    expect(swapped.arguments.map((a) => a.claim)).toStrictEqual([second.claim, first.claim]);
    expect(swapped.sources.map((s) => s.url)).toStrictEqual([PAGES[1].url, PAGES[0].url]);
    // Only the sources of the kept arguments are listed, not every page that was fetched; two quotes of one page are two sources.
    const lost = checkCitations({ thesis: 't', arguments: [{ claim: 'a', support: 's', sources: [{ n: 2, quote: 'fell by a third in the first year' }] }, { claim: 'b', support: 's', sources: [{ n: 1, quote: 'a quote that is nowhere in the page it names' }] }] }, PAGES);
    expect([lost.arguments.length, lost.sources.map((s) => s.url)]).toStrictEqual([1, [PAGES[1].url]]);
    const quotes = ['retail footfall rise by eleven percent within two years', 'customers stayed longer once the traffic had gone'];
    const both = checkCitations({ thesis: 't', arguments: [{ claim: 'a', support: 's', sources: quotes.map((quote) => ({ n: 1, quote })) }] }, PAGES);
    expect(both.sources.map((s) => s.quote)).toStrictEqual(quotes);
    // The bias is declared in the manifest too, and the registry record of 2026-10-19 carries the manifest's description, which declares it.
    expect(response).toContain("The manifest carries the same declaration in `behaviour.declared_bias`, and the description of the registry record, which is the manifest's, declares the bias too.");
    expect(section('Identity')).toContain('This agent has had a registry record since 2026-10-19.');
    expect(row(section('Identity'), 'Registry record')).toContain('description as in the manifest, which declares the bias');
    expect(manifest.description).toContain('argues one side only, by design');
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
    expect(row(fields, '`model`')).toBe(`| \`model\` | the model the service asked and the path it took: \`${modelLabel('<model>', 'marketplace')}\` when a chat supplier gave the brief, \`${modelLabel('<model>', 'openrouter')}\` when OpenRouter gave it after a hire that failed. \`<model>\` is the model of the advert hired, a model of \`LLM_MODEL_ALLOWLIST\`, on the marketplace path, and the model of \`OPENROUTER_MODEL\` on the OpenRouter path; both are \`${DEFAULT_MODEL}\` by default |`);
    // The model of each path is the code's: the model of the advert hired on the marketplace path, which the choice holds to the allowlist (packages/hire-kit/src/select.ts),
    // and OPENROUTER_MODEL on the OpenRouter path (src/inference.ts). The result names it with its path, so the hire of another model of the list names that model.
    const inference = readFileSync(new URL('../src/inference.ts', import.meta.url), 'utf8');
    expect(inference).toContain("path: 'marketplace', model: supplier.model,");
    expect(inference).toContain("path: 'openrouter', model: deps.openRouterModel,");
    expect(readFileSync(new URL('../../../packages/hire-kit/src/select.ts', import.meta.url), 'utf8')).toContain('|| !query.allowlist.includes(advert.model)) {');
    const hired = buildResult(parseRequest(exampleRequest()), BRIEF.thesis, checkCitations(BRIEF, PAGES), { ...EXAMPLE_INFERENCE, model: 'example/second-model' });
    expect(hired.model).toBe('example/second-model via the Vector marketplace');
    expect(row(fields, '`inference`')).toContain('how the model call was made: `path`, `marketplace` or `openrouter`; `fallback_from`, on the OpenRouter path the code that sent the job there, the code of the failed hire or `marketplace_off` (see How it buys), and `null` on the marketplace path; `sub_job`, the hire of the chat supplier whose answer the service verified and accepted');
    expect(row(fields, '`inference`')).toContain('`accepted`, `confirmed` when its Accept was seen confirmed, `pending` when it was sent and not yet seen, or `null` |');
  });

  test('every gap sentence of the manifest is on the page word for word, one to a line and in its order, with the default model, and the page adds none of its own', () => {
    const lines = section('Known gaps').split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toStrictEqual(gapsFor(DEFAULT_MODEL, DEFAULT_MODEL).map((gap) => `- ${gap}`));
    expect(manifest.gaps).toStrictEqual([...gapsFor(DEFAULT_MODEL, DEFAULT_MODEL)]);
    expect(lines).toHaveLength(8);
    expect(section('Known gaps')).toContain(`with the default model of the service on both paths, \`${DEFAULT_MODEL}\`.`);
    // The fifth gap names the model the service asks: another model is another manifest, and so another advert. When the first model of the allowlist is not
    // the model of OPENROUTER_MODEL, the gap names both (ruling R-F19), as the head of the section says.
    const other = manifestFromEnv({ OPERATOR_CONTACT: 'ops@example.test', OPENROUTER_MODEL: 'example/another-model' });
    expect(other.gaps[4]).toContain('example/another-model');
    expect(other.gaps[4]).not.toContain(DEFAULT_MODEL);
    const both = manifestFromEnv({ OPERATOR_CONTACT: 'ops@example.test', LLM_MODEL_ALLOWLIST: 'example/market-model, example/second-model' });
    expect(both.gaps[4]).toContain(`The model is example/market-model, bought from a chat supplier on the Vector marketplace, or ${DEFAULT_MODEL} through OpenRouter when that hire fails:`);
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
      'a chat supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it (the prompt: the subject, the side, the audience, the language and the length, and the titles, URLs and excerpts of the fetched pages)',
      'OpenRouter and the model provider behind it (the same prompt), only when that hire fails',
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
    expect(row(terms, 'Model')).toBe(`| Model | through OpenRouter, when the hire fails: the smaller of ${MODEL_MAX_MS} ms and the time the job has left less ${RESULT_RESERVE_MS} ms, and not called when that is under ${MODEL_MIN_MS} ms |`);
    expect(row(terms, 'Chat hire')).toBe(`| Chat hire | the choice of the supplier within ${CHOICE_WITHIN_MS} ms, its probes within ${CHOICE_BUDGET_MS} ms and of at most ${CHOICE_MAX_CANDIDATES} candidates; the buyer wallet read within ${WALLET_READ_MS} ms; no escrow posted with under ${HOP_MIN_MS} ms left to the end of the hire, which is ${FALLBACK_RESERVE_MS} ms before the job deadline; the receipt read until ${JOB_DEADLINE_MS - receiptByMs(JOB_DEADLINE_MS)} ms before the job deadline |`);
    expect([hopDeadlineMs(JOB_DEADLINE_MS), receiptByMs(JOB_DEADLINE_MS)]).toStrictEqual([JOB_DEADLINE_MS - FALLBACK_RESERVE_MS, JOB_DEADLINE_MS - MODEL_MIN_MS - RESULT_RESERVE_MS]);
    expect(FALLBACK_RESERVE_MS).toBe(MODEL_MAX_MS + RESULT_RESERVE_MS);
    expect(row(terms, 'Service timeout, `SERVICE_TIMEOUT_MS`')).toBe(`| Service timeout, \`SERVICE_TIMEOUT_MS\` | ${JOB_DEADLINE_MS + 60_000} ms |`);
    // The rows say what the two functions of the budget do.
    expect(fetchDeadlineMs(0, JOB_DEADLINE_MS)).toBe(FETCH_PHASE_MAX_MS);
    expect(fetchDeadlineMs(250_000, JOB_DEADLINE_MS)).toBe(JOB_DEADLINE_MS - FETCH_RESERVE_MS);
    expect([modelBudgetMs(JOB_DEADLINE_MS), modelBudgetMs(50_000), modelBudgetMs(MODEL_MIN_MS + RESULT_RESERVE_MS), modelBudgetMs(MODEL_MIN_MS + RESULT_RESERVE_MS - 1)]).toStrictEqual([MODEL_MAX_MS, 50_000 - RESULT_RESERVE_MS, MODEL_MIN_MS, null]);
    expect([manifest.terms.max_processing_ms, MIN_PROCESSING_WINDOW_MS]).toStrictEqual([480_000, 480_000]);
    expect(section('How to hire it')).toContain('Allow for the 8 min processing window.');
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
    expect(rows['`language`']).toContain('The model is asked to write the brief in it; a quote stays in the words of its page.');
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
    expect(systemPrompt(parseRequest(asked({ language: 'de' })))).toContain('A quote stays in the words of its source.');
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
    expect(text).toContain('No argument left is `no_supported_claims` (502).');
    expect(text).toContain(`is at most ${PAGE_MAX_BYTES / 1_048_576} MB and has at least ${MIN_PAGE_CHARS} characters of text`);
    expect(text).toContain(`at most ${PAGE_MAX_BYTES / 1_048_576} MB a page`);
    expect(text).toContain(`the kept pages are numbered from ${PAGES[0].n} in the order of the results`);
    expect(text).toContain('The sha256 of its UTF-8 bytes is the `prompt_hash` of the escrow.');
    // The wire payload is the payload field of the body that the runtime takes at POST /v1/job, as the raw steps of the page of Agent History have it.
    expect(text).toContain('The wire payload is also the `payload` field of `POST /v1/job`, and the runtime claims the escrow and posts it unchanged to the service as the HTTP body.');
    expect(manifest.interface.routes.job).toBe('/v1/job');
    expect(readFileSync(new URL('../../../specs/agent-history.md', import.meta.url), 'utf8')).toContain('`POST /v1/job` with `{ "escrow_ref": "<txid>#<index>", "payload": "<the wire payload>" }`');
    expect(text).toContain('(on the hosted mainnet server since 2026-10-14)');
    expect(text).toContain('the service finds the pages with the Brave Search API and fetches them itself');
    expect(text).toContain('Both failing is `search_failed` (502), and so is a key that the Brave Search API refuses.');
    expect(text).toContain('one call with a fixed prompt');
    expect(text).toContain("The model call is bought first from a chat supplier on the Vector marketplace: the service posts a bonded escrow with its own buyer key, sends the prompt, verifies the supplier's signed receipt and accepts; only when that hire fails is the call made through OpenRouter, and the result says which path it took (How it buys, below).");
    expect(text).toContain(`The waits of the hire stop ${FALLBACK_RESERVE_MS / 1000} s before the deadline, so that the call through OpenRouter still has its ${MODEL_MAX_MS / 1000} s when the hire fails by then.`);
    // The numbers of the pages and of the model that the bullets state are the code's.
    expect(FETCH_CONCURRENCY).toBe(4);
    expect(text).toContain('four at a time');
    expect(text).toContain(`answers within ${PAGE_TIMEOUT_MS / 1000} s`);
    expect(text).toContain(`has at least ${MIN_PAGE_CHARS} characters of text`);
    // The model gets the smaller of 90 s and the time the job has left less 5 s, and is not called when that is under 15 s, which is with under 20 s of the job left. The fetch of the pages ends 20 s before the deadline at the latest, which is the 15 s of the model and the 5 s of the check and the result.
    expect(FETCH_RESERVE_MS).toBe(MODEL_MIN_MS + RESULT_RESERVE_MS);
    expect([modelBudgetMs(FETCH_RESERVE_MS - 1), modelBudgetMs(FETCH_RESERVE_MS)]).toStrictEqual([null, MODEL_MIN_MS]);
    expect(text).toContain(`The call through OpenRouter gets the smaller of ${MODEL_MAX_MS / 1000} s and the time the job has left less ${RESULT_RESERVE_MS / 1000} s, and is not made when that is under ${MODEL_MIN_MS / 1000} s, which is with under ${FETCH_RESERVE_MS / 1000} s of the job left: the job then fails with ${tick('deadline')} (422).`);
    expect(text).toContain(`The fetch of the pages ends ${FETCH_RESERVE_MS / 1000} s before the deadline at the latest, so that the model has its ${MODEL_MIN_MS / 1000} s and the check and the result ${RESULT_RESERVE_MS / 1000} s.`);
    // The code of a call that runs out of its time (ruling R-E19): deadline (422) when the time was cut under the whole of it, model_failed (502) when it had the whole of it.
    expect(text).toContain(`A call that runs out of a time that the deadline of the job cut under ${MODEL_MAX_MS / 1000} s is ${tick('deadline')} (422); any other call that fails, a call that runs out of the whole ${MODEL_MAX_MS / 1000} s among them, is ${tick('model_failed')} (502). An answer of OpenRouter that is not the JSON of a brief is ${tick('model_output_invalid')} (502); one of the chat supplier sends the job to OpenRouter.`);
    const timedOut = async (timeoutMs: number): Promise<AdvocateError> => {
      const fetchImpl = (async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as typeof fetch;
      try { await callModel([], { fetchImpl, apiKey: 'a-key-for-this-test', model: DEFAULT_MODEL, maxTokens: 2000, timeoutMs, log: () => undefined }); } catch (e) { return e as AdvocateError; }
      throw new Error('the call returned');
    };
    const [cut, whole] = [await timedOut(MODEL_MAX_MS - 1), await timedOut(MODEL_MAX_MS)];
    expect([cut.code, cut.status, whole.code, whole.status]).toStrictEqual(['deadline', 422, 'model_failed', 502]);
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
    // A result is kept once by its scheme, host and path, in lower case: its query and its fragment are not part of it, and an http one is not kept.
    expect(text).toContain('a result is kept once, by its scheme, host and path, and only when its URL is https');
    const hit = (url: string): SearchResult => ({ title: 'T', url, description: 'D' });
    expect(dedupeResults([hit('https://Example.org/Page?a=1'), hit('https://example.org/page?b=2#top'), hit('http://example.org/other'), hit('https://example.org/other')]).map((result) => result.url))
      .toStrictEqual(['https://Example.org/Page?a=1', 'https://example.org/other']);
    // When one query fails, the search goes on with the results of the other; both failing is search_failed (502).
    expect(text).toContain('When one query fails, the search goes on with the results of the other.');
    const searchAnswering = (answers: Array<number | 'ok'>) => {
      let call = 0;
      const fetchImpl = (async () => {
        const answer = answers[call];
        call += 1;
        return answer === 'ok' ? new Response(JSON.stringify({ web: { results: [{ title: 'T', url: `https://example.org/answer-${call}`, description: 'D' }] } }), { status: 200 }) : new Response(null, { status: answer });
      }) as typeof fetch;
      return searchWeb(queriesFor('Should a city ban cars from its centre?', 'for'), { fetchImpl, apiKey: 'a-key-for-this-test', clock: Date.now, timeoutMs: 1000, phaseEndMs: Date.now() + 60_000, wait: async () => undefined, log: () => undefined });
    };
    expect((await searchAnswering([500, 'ok'])).map((result) => result.url)).toStrictEqual(['https://example.org/answer-2']);
    expect((await searchAnswering(['ok', 500])).map((result) => result.url)).toStrictEqual(['https://example.org/answer-1']);
    await expect(searchAnswering([500, 500])).rejects.toMatchObject({ code: 'search_failed', status: 502 });
  });

  test('How it buys states the choice, the float, the hire, the checks, the time, the fallback and what a job leaves behind with the numbers of the code', () => {
    const how = sub('How it buys');
    // The choice: the allowlist the start makes (the model of OPENROUTER_MODEL unless LLM_MODEL_ALLOWLIST says otherwise), the candidates and the time of their probes,
    // the time of the choice and of the advert read, and the ceiling of the start.
    const pub = 'ab'.repeat(32);
    const env = {
      OPERATOR_CONTACT: 'ops@example.test', SUPPLIER_PKH: blake2b224Hex(pub), SUPPLIER_PUB_KEY_HEX: pub, SERVICE_AUTH_HEADER: `Bearer ${'cd'.repeat(32)}`,
      BRAVE_SEARCH_API_KEY: 'BSAtestkey0123456789abcdefghij', OPENROUTER_API_KEY: `sk-or-v1-${'0123456789abcdef'.repeat(4)}`, ADVOCATE_BUYER_PRIV_KEY_HEX: '01'.repeat(32),
    };
    const config = loadConfig(env);
    expect([config.allowlist, config.maxPriceLovelace]).toStrictEqual([[DEFAULT_MODEL], 1_000_000n]);
    expect(loadConfig({ ...env, OPENROUTER_MODEL: 'example/another-model' }).allowlist).toStrictEqual(['example/another-model']);
    expect(how).toContain(`The allowlist is \`LLM_MODEL_ALLOWLIST\`, by default the one model of \`OPENROUTER_MODEL\`, \`${DEFAULT_MODEL}\`, so that the chat supplier and OpenRouter are asked the same model.`);
    expect(how).toContain(`The first ${CHOICE_MAX_CANDIDATES} are asked in turn, within ${CHOICE_BUDGET_MS / 1000} s.`);
    expect(how).toContain(`the choice and that read within ${CHOICE_WITHIN_MS / 1000} s in all.`);
    expect(how).toContain(`No advert is hired at a price above \`LLM_MAX_PRICE_LOVELACE\` (${config.maxPriceLovelace} lovelace by default), on the indexer or on the ledger.`);
    // The float: the read of the wallet, the collateral, the fee budget of a Post and of an Accept, and the least time left to post.
    expect(how).toContain(`Then the buyer wallet is read, within ${WALLET_READ_MS / 1000} s: it must hold a pure output of at least 5000000 lovelace as collateral`);
    expect(how).toContain(`the fee of a Post and of an Accept, ${TX_FEE_BUDGET_LOVELACE} lovelace each, about 3.2 at today's fleet price of 0.2.`);
    expect(how).toContain(`No escrow is posted with under ${HOP_MIN_MS / 1000} s left to the end of the hire, and none for a caller who has gone.`);
    // The hire: the body, the input that holds the two messages in one, the waits of the kit, the Accept before the brief is read.
    expect(how).toContain('sends `POST /v1/responses` with the escrow in `X-Escrow-Ref` and the body `{ "input": "<text>" }` and nothing else');
    expect(marketplaceInput([{ role: 'system', content: 'the system prompt' }, { role: 'user', content: 'the message' }])).toBe('the system prompt\n\nthe message');
    expect(how).toContain('The input is the fixed prompt of the model call, a blank line, then the message with the subject, the side, the audience when there is one, and the numbered pages');
    expect(how).toContain(`the send is made again every ${BUSY_RETRY_MS / 1000} s while it answers that it is busy. The service polls every ${POLL_INTERVAL_MS / 1000} s`);
    expect(how).toContain(`so the service reads it again every ${POLL_INTERVAL_MS / 1000} s, for up to ${RECEIPT_HASH_WAIT_MS / 1000} s and until ${(JOB_DEADLINE_MS - receiptByMs(JOB_DEADLINE_MS)) / 1000} s before the deadline of the job`);
    expect(how).toContain(`is made again every ${BUSY_RETRY_MS / 1000} s, until the accept window has closed or ${ACCEPT_WINDOW_MS / 1000} s have passed since the supplier's answer.`);
    expect(how).toContain('Only then does it read the answer as a brief');
    // The rule of the fallback names every failure of the hire the code falls back on: the busy and the timeout of the kit too, which a hire reaches on an advert
    // whose window is short enough that the limits of its escrow come before the end of the hire.
    expect(how).toContain('| `llm_out_of_time`, `llm_busy`, `llm_refused`, `llm_send_lost` |');
    expect(how).toContain('| `llm_out_of_time`, `llm_timeout` |');
    expect(how).toContain(`the sends stop ${SEND_CUTOFF_MS / 1000} s before its ` + '`deliver_by`, and the polls at it.');
    expect(how).toContain('or no Post can be planned on it |');
    // An Accept sent and not seen confirmed may land to the end of the accept window, which is its validity (the vendored planAccept): the janitor follows it while it
    // may land, and the operator accepts the escrow again by hand while it reads Submitted, within the window, whether the mark was written or not, as the detail
    // of the log says when it was not.
    expect(how).toContain(`the janitor follows it while it may land, and while it still reads Submitted with time left in the window, the operator accepts it again by hand within ${ACCEPT_WINDOW_MS / 1000} s of its Submit; an escrow is accepted once, so a second Accept fails if the first lands, and after the ${ACCEPT_WINDOW_MS / 1000} s its supplier may Release it.`);
    expect(how).not.toContain('if it is still Submitted then');
    expect(how).toContain('Only a mark that cannot be written fails the job, with `store_write_failed`: the escrow then stays recorded as Submitted, its Accept may still land, and the operator reads it on chain at once and, while it is still Submitted, accepts it again by hand the same way.');
    expect(readFileSync(new URL('../../../packages/buyer-core/src/vendored/mcp/marketplace-build.ts', import.meta.url), 'utf8')).toContain('const validTo = datum.submitted_at + ACCEPT_WINDOW_MS;');
    expect(how).not.toContain('can no longer land');
    expect(readFileSync(new URL('../src/inference.ts', import.meta.url), 'utf8')).toContain(`accept it again by hand at once, within ${ACCEPT_WINDOW_MS / 1000} s of its Submit`);
    // The seven checks of the table are those of buyer-core, in their order.
    expect(how.split('\n').filter((l) => /^\| `[a-z_]+` \|/.test(l)).map((l) => l.split(' | ')[0].slice(3, -1))).toStrictEqual(CHECKS);
    // Time: the end of the hire and its reserve, and the confirmations the deadline does not cut.
    expect(how).toContain(`The end of the hire is ${FALLBACK_RESERVE_MS / 1000} s before the deadline of the job, the ${MODEL_MAX_MS / 1000} s of the call through OpenRouter and the ${RESULT_RESERVE_MS / 1000} s of the result, so that a hire that fails by then leaves the fallback its whole time.`);
    // A call under way at the end of the hire is not cut: a send waits up to 75 s for the Claim and a poll up to 20 s (packages/buyer-core/src/fleet-clients.ts), so a
    // send made at the end of the hire can end it 280 s after the arrival, which leaves the call through OpenRouter its least time; with less, the job answers deadline.
    const fleetClients = readFileSync(new URL('../../../packages/buyer-core/src/fleet-clients.ts', import.meta.url), 'utf8');
    expect([fleetClients.includes('const SEND_TIMEOUT_MS = 75_000;'), fleetClients.includes('const POLL_CALL: Call = { maxResponseBytes: ANSWER_BYTES, timeoutMs: 20_000 };')]).toStrictEqual([true, true]);
    const latestEnd = hopDeadlineMs(JOB_DEADLINE_MS) + 75_000;
    expect([latestEnd, modelBudgetMs(JOB_DEADLINE_MS - latestEnd), modelBudgetMs(MODEL_MIN_MS + RESULT_RESERVE_MS - 1)]).toStrictEqual([280_000, MODEL_MIN_MS, null]);
    // The latest end is that of a hire that fails: one that is verified ends in its Accept, which the deadline does not cut.
    expect(how).toContain(`A send, a poll or a read of the chain under way at the end of the hire is not cut (a send waits up to 75 s for the supplier's Claim, a poll up to 20 s), so a hire that fails can end as late as about ${latestEnd / 1000} s; the call through OpenRouter then has what is left, and with under ${(MODEL_MIN_MS + RESULT_RESERVE_MS) / 1000} s left the job answers \`deadline\` (422).`);
    expect(how).toContain(`the chain waits for each of them, up to ${DELIVER_BY_BUFFER_MS / 1000} s, whatever the time`);
    expect(how).toContain(`its whole ${MODEL_MAX_MS / 1000} s after a hire that failed when its waits stopped, ${FALLBACK_RESERVE_MS / 1000} s before the deadline, at least ${MODEL_MIN_MS / 1000} s after a receipt that failed its check by ${(JOB_DEADLINE_MS - receiptByMs(JOB_DEADLINE_MS)) / 1000} s before the deadline, and what is left after a call that ran on past either (Time, above).`);
    expect(modelBudgetMs(JOB_DEADLINE_MS - receiptByMs(JOB_DEADLINE_MS))).toBe(MODEL_MIN_MS);
    expect(modelBudgetMs(JOB_DEADLINE_MS - hopDeadlineMs(JOB_DEADLINE_MS))).toBe(MODEL_MAX_MS);
    // What a job leaves behind: the file of the kit, the grace of its janitor, and the time to reclaim an escrow of an advert of 60 minutes.
    expect(how).toContain(`written to a record in its state directory, \`${STRANDED_FILE}\``);
    expect(how).toContain(`From ${JANITOR_GRACE_MS / 1000} s after an escrow's \`deliver_by\` it reclaims an Open or Claimed escrow`);
    expect((3_600_000 + DELIVER_BY_BUFFER_MS) / 60_000).toBe(63);
    expect(how).toContain('for a chat advert with a window of 3600000 ms that is 63 minutes after the Post');
    const kitText = (file: string): string => readFileSync(new URL(`../../../packages/hire-kit/src/${file}`, import.meta.url), 'utf8');
    expect(how).toContain('A process exit between signing a Post and its confirmation leaves an escrow that is in no record, so the janitor never sees it: it can be reclaimed by hand after its `deliver_by`, and it holds the lock of one sub-job.');
    expect(kitText('janitor.ts')).toContain('Known gap (ruling R39): an escrow is written here once its Post is confirmed or has failed after its signature, so a');
    expect(how).toContain('| a write of the record fails after a Post, all but the removal of an entry once its Accept is confirmed, which is logged and leaves an entry the janitor drops once it reads spent | `store_write_failed` |');
    expect(kitText('hire.ts')).toContain('// The one write of the store that does not fail the run (ruling R62)');
    expect(kitText('hire.ts')).toContain('and could not be removed from the stranded store (${errorText(err)}); the janitor drops it once it reads it spent`);');
    expect(how).toContain('The hire is `packages/hire-kit` in this repository');
    expect(existsSync(fileURLToPath(new URL('../../../packages/hire-kit/src/index.ts', import.meta.url)))).toBe(true);
  });

  test('the Check section states the normalisation of the code, the bounds of a quote, and what is dropped', () => {
    const check = sub('Check');
    expect(check).toContain('the service takes its Unicode NFKC form in lower case');
    expect(normalizeText(String.fromCharCode(0xfb01))).toBe('fi');
    expect(check).toContain(`is ${QUOTE_MIN_CHARS} to ${QUOTE_MAX_CHARS} characters long and is found in the normalised excerpt of that page`);
    expect(normalizeText('\u2018Don\u2019t \u201cstop\u201d \u2013 now\u2014then    it\u02bcs OK ')).toBe('\'don\'t "stop" - now-then it\'s ok');
    expect(check).toContain('makes the left single quote U+2018 and the apostrophes U+2019 and U+02BC into U+0027, the double quotes U+201C and U+201D into U+0022 and the dashes U+2013 and U+2014 into U+002D');
    // A kept quote is given in the words of its page (R-E36), and an argument lists a page and a quote once (R-E35).
    expect(check).toContain('A quote that is kept is given in the words of its page: the part of the excerpt that the normalised quote was found in, with the case, the marks and the characters of the page, whatever form the model wrote it in, so a brief shows only text its page holds.');
    const upper = checkCitations({ thesis: 't', arguments: [{ claim: 'a', support: 's', sources: [{ n: 1, quote: 'CITIES THAT CLOSED THEIR CENTRES TO CARS' }, { n: 1, quote: 'cities that closed their centres to cars' }] }] }, PAGES);
    expect(upper.arguments[0].sources.map((s) => s.quote)).toStrictEqual(['Cities that closed their centres to cars']);
    expect(check).toContain('An argument lists a page and a quote once, however often the model cites them in it.');
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
    expect(errors).toContain("A job that fails with a code of the 502 row, or with `store_write_failed` (500), answers with a fixed message: `The service could not do this job (<code>). The operator's log has the detail.`");
    expect(errors).toContain('`deadline` (422) keeps its words');
    // What the real server answers for each code of a job: the fixed message for the 502 row, and the words the job was given for the 422 and the 499.
    const answerTo = (error: Error) => serve({ manifest, deps: baseDeps(), log: () => undefined, runAdvocate: async () => { throw error; } }, async (api) => {
      const r = await api.post(wire(GOLDEN_REQUEST));
      return { status: r.status, json: r.json };
    });
    for (const code of Object.keys(JOB_STATUS) as JobCode[]) {
      const answer = await answerTo(new AdvocateError(code, `the words of ${code}`));
      expect([answer.status, answer.json], code).toStrictEqual([JOB_STATUS[code], { error: code, message: JOB_STATUS[code] >= 500 ? operatorsText(code) : `the words of ${code}` }]);
    }
    expect([JOB_STATUS.inference_failed, JOB_STATUS.store_write_failed]).toStrictEqual([502, 500]);
    // What the log keeps of each: the whole detail for the 502 row and the 500, and for the 422 and the 499 the code, the status and the time, not the words (the answer carries those).
    const logOf = (error: Error): Promise<string[]> => {
      const lines: string[] = [];
      return serve({ manifest, deps: baseDeps(), log: (line) => { lines.push(line); }, runAdvocate: async () => { throw error; } }, async (api) => {
        await api.post(wire(GOLDEN_REQUEST));
        return lines.filter((line) => line.startsWith('job failed after '));
      });
    };
    for (const code of Object.keys(JOB_STATUS) as JobCode[]) {
      const status = JOB_STATUS[code];
      const logged = await logOf(new AdvocateError(code, `the words of ${code}`));
      expect(logged, code).toHaveLength(1);
      expect(logged[0].replace(/after \d+ ms/, 'after N ms'), code).toBe(`job failed after N ms: ${code} (${status})${status >= 500 ? `: the words of ${code}` : ''}`);
    }
    expect(row(errors, '499, the caller hung up')).toBe('| 499, the caller hung up | `aborted` (the job was stopped when its caller hung up; nobody reads this answer, and the log keeps its code and the time the job took, not its words) |');
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
    // The runtime fails the job on any answer that is not 2xx, and the buyer reclaims after deliver_by, as the guide says.
    expect(errors).toContain('The runtime fails the job on any non-2xx answer and copies the first 200 characters of the failure to the buyer. The buyer reclaims after `deliver_by`.');
    expect(readFileSync(new URL('../../../docs/HIRE.md', import.meta.url), 'utf8')).toContain('If the job fails, you reclaim after `deliver_by`, which is your Post time plus 8 min plus 180 s.');
    expect(errors).toContain('The codes of the 502 row are failures at a third party, of the hire or of the check.');
    expect(errors).toContain('`aborted` (499) is the answer to a caller that has hung up, which nobody reads.');
    expect(errors).toContain('`shutting_down` says that the service is stopping.');
    expect(MAX_BODY).toBe(1_000_000);
    expect(errors).toContain('`request_too_large` (over 1000000 bytes)');
    const statuses: Record<string, number> = {
      bad_wire: new WireError('bad_wire', 'x').status, request_too_large: new WireError('request_too_large', 'x').status, unauthorized: sent('unauthorized'),
      shutting_down: sent('shutting_down'), internal: sent('internal'), busy: sent('busy'), not_found: sent('not_found'),
    };
    expect(statuses).toStrictEqual({ bad_wire: 400, request_too_large: 400, unauthorized: 401, shutting_down: 503, internal: 500, busy: 409, not_found: 404 });
    // Every refusal has a status of 400 or more, so the runtime fails the job on each.
    expect([...Object.values(JOB_STATUS), ...Object.values(statuses)].every((status) => status >= 400)).toBe(true);
    for (const code of ['bad_wire', 'request_too_large', 'unauthorized', 'shutting_down', 'internal']) {
      expect(rows.find((l) => l.split('|')[2].includes(tick(code))), code).toMatch(new RegExp(`^\\| ${statuses[code]}, `));
    }
    expect(errors).toContain(`gets ${statuses.busy} \`{"error":"busy"}\``);
    expect(errors).toContain(`gets ${statuses.not_found} \`{"error":"not_found"}\``);
    expect(HEARTBEAT_MS).toBe(60_000);
    expect(errors).toContain('While a job runs the service writes an interim `102 Processing` line every 60 s');
    expect(errors).toContain("because the runtime's fetch gives up on a response that has not begun after 300 s of silence");
    expect(errors).toContain(`a job can take its whole deadline, ${JOB_DEADLINE_MS / 1000} s, and longer when a hire is in its Accept`);
    expect(errors).toContain('the 400s and the 401 come before anything is searched or fetched, and the search, the pages and the choice of the supplier lock nothing.');
  });

  test('Operator and data handling says what the manifest says the service holds, sends and logs, and names the user agent of the code', async () => {
    const handling = section('Operator and data handling');
    for (const part of ['held in memory while a job runs', 'writes only the bookkeeping of the escrows it posts (references, times, the hop, a transaction hash) to its state directory', 'never a request, a page, a quote or a key']) {
      expect(handling, part).toContain(part);
      expect(manifest.behaviour.data_handling, part).toContain(part);
    }
    expect(handling).toContain('and nothing else to disk');
    expect(handling).toContain(tick(USER_AGENT));
    // What the service sees: the five fields of the request, and the pages it fetches.
    expect(handling).toContain('What the service sees: the subject, the side, the audience, the length and the language, and the pages it fetches.');
    expect(Object.keys(parseRequest(exampleRequest()))).toStrictEqual(['subject', 'side', 'audience', 'length', 'language']);
    expect(handling).toContain('the language of the request is not sent');
    expect(handling).toContain('with no language parameter');
    // The sentences of the manifest that the page repeats are repeated word for word: what the ledger holds, and what the log carries.
    const sentences = manifest.behaviour.data_handling.split(/(?<=[.]) /);
    const [held, ledger, logged] = ['The subject, the side, the audience, the length and the language are held in memory while a job runs', 'On the ledger', 'The log carries'].map((start) => sentences.find((s) => s.startsWith(start)) ?? '');
    expect([held, ledger, logged].every((s) => s !== '')).toBe(true);
    expect(handling).toContain(ledger);
    expect(handling).toContain(logged);
    expect(ledger).toContain('only a sha256 commitment to its input');
    // A commitment, and not the sha256 of the input: the prompt hash of the chat job is the hash of the canonical request {input}, which the escrow commits to.
    const input = marketplaceInput([{ role: 'system', content: 'the system prompt' }, { role: 'user', content: 'the message' }]);
    const promptHash = chatJob('https://203.0.113.31', input, 'the brief', (async () => { throw new Error('nothing is sent'); }) as typeof fetch).promptHash;
    expect(promptHash).toBe(responsesPromptHash({ input }));
    expect(promptHash).not.toBe(createHash('sha256').update(input, 'utf8').digest('hex'));
    // The prompt holds the language code and the shape of the length, and the message the titles and the URLs of the pages, as the third-parties entries say.
    expect(row(handling, manifest.behaviour.third_parties[2])).toContain('the fixed prompt (which holds the language code and the shape of the length asked for)');
    expect(row(handling, manifest.behaviour.third_parties[3])).toContain('the fixed prompt, which holds the language code and the shape of the length asked for');
    // The data handling of the manifest names what reaches the chat supplier and, when that hire fails, OpenRouter, with the list of the third parties (R-E32, R-F12).
    const toTheModel = /[(]the prompt: (.+)[)]$/.exec(manifest.behaviour.third_parties[2])?.[1] ?? '';
    expect(toTheModel).toBe('the subject, the side, the audience, the language and the length, and the titles, URLs and excerpts of the fetched pages');
    for (const part of [toTheModel, 'Vector marketplace', 'OpenRouter and the model provider behind it']) expect(manifest.behaviour.data_handling, part).toContain(part);
    expect(handling).toContain('| OpenRouter and the model provider behind it (the same prompt), only when that hire fails | one chat completion:');
    expect(handling).toContain('To post and settle the escrow of the chat sub-job the service reads the ledger through Ogmios and Koios of Vector mainnet, submits its transactions through the submit API, and finds the chat supplier on the marketplace indexer: they see the references and the transactions of that escrow, and nothing of the request.');
    expect(handling).toContain("Datalab is not used, and no model runs on the operator's host.");
    // The hosts of the result pages are sent a GET of the page and nothing of the request: the one call of a page carries the URL of the result, the user agent and the accept type, no body, and not a word of the subject.
    expect(row(handling, manifest.behaviour.third_parties[1])).toBe(`| ${manifest.behaviour.third_parties[1]} | a GET of the page, with the user agent ${tick(USER_AGENT)}; nothing of the hirer's request is sent to them |`);
    const pageRoutes = routedFetch([{ match: at('https://example.org/car-free-centres'), respond: () => reply(200, fixture('page-1.html'), { 'content-type': 'text/html' }) }]);
    const fetchedAt = Date.parse(RETRIEVED_AT);
    const [kept] = await fetchPages([{ title: 'A title that only the search gave', url: 'https://example.org/car-free-centres', description: 'D' }], {
      fetchImpl: pageRoutes, clock: () => fetchedAt, deadlineMs: fetchedAt + 45_000, log: () => undefined, lookup: publicLookup,
    });
    expect(pageRoutes.calls).toHaveLength(1);
    const [call] = pageRoutes.calls;
    const headers = new Headers(call.init?.headers);
    expect([call.url, [...headers.keys()].sort(), call.init?.method ?? 'GET', call.init?.body ?? null]).toStrictEqual(['https://example.org/car-free-centres', ['accept', 'user-agent'], 'GET', null]);
    expect(headers.get('user-agent')).toBe(USER_AGENT);
    expect(JSON.stringify([call.url, [...headers.values()]])).not.toMatch(/city ban/i);
    // The title of a source is the one the search gave for the page, not the page's own (the fixture page is titled otherwise).
    expect(kept.title).toBe('A title that only the search gave');
    // The model is sent the subject, the side, the audience when there is one, and the numbered pages, each with the title the search gave it, its URL and its excerpt:
    // by the chat supplier as one input, by OpenRouter as two messages.
    expect(row(handling, manifest.behaviour.third_parties[2])).toBe(`| ${manifest.behaviour.third_parties[2]} | one chat job: the input, made of the fixed prompt (which holds the language code and the shape of the length asked for), a blank line and the message with the subject, the side, the audience when there is one, and the numbered pages, each with the title the search gave it, its URL and its excerpt; and the reference of the escrow |`);
    expect(row(handling, manifest.behaviour.third_parties[3])).toBe(`| ${manifest.behaviour.third_parties[3]} | one chat completion: the fixed prompt, which holds the language code and the shape of the length asked for, and a message with the subject, the side, the audience when there is one, and the numbered pages, each with the title the search gave it, its URL and its excerpt |`);
    const withAudience = userMessage(parseRequest(JSON.stringify({ subject: 'Cars in the centre', side: 'against', audience: 'the council' })), PAGES);
    expect(withAudience.split('\n\n')[0]).toBe('Subject: Cars in the centre\nSide: against\nAudience: the council');
    expect(userMessage(parseRequest(exampleRequest()), PAGES).split('\n\n')[0]).toBe('Subject: Should a city ban cars from its centre?\nSide: for');
    expect(withAudience).toContain(`[1] ${PAGES[0].title} ${PAGES[0].url}\n${PAGES[0].excerpt}`);
  });

  test('the Controller row names the three fields of the manifest and the check at start, and the code does it', () => {
    const controller = row(section('Identity'), 'Controller');
    for (const field of ['identity.controller_pkh', 'keys.supplier_pkh', 'keys.pub_key_hex']) expect(controller, field).toContain(tick(field));
    expect(controller).toContain('the service does not start unless the public key hashes to the key hash');
    const pub = 'ab'.repeat(32);
    const env = {
      OPERATOR_CONTACT: 'ops@example.test', SUPPLIER_PKH: blake2b224Hex(pub), SUPPLIER_PUB_KEY_HEX: pub, SERVICE_AUTH_HEADER: `Bearer ${'cd'.repeat(32)}`,
      BRAVE_SEARCH_API_KEY: 'BSAtestkey0123456789abcdefghij', OPENROUTER_API_KEY: `sk-or-v1-${'0123456789abcdef'.repeat(4)}`, ADVOCATE_BUYER_PRIV_KEY_HEX: '01'.repeat(32),
    };
    const config = loadConfig(env);
    // Neither API key nor the buyer key reaches the manifest (the page says so); each API key is sent to its own party alone.
    for (const key of [env.BRAVE_SEARCH_API_KEY, env.OPENROUTER_API_KEY, env.ADVOCATE_BUYER_PRIV_KEY_HEX]) expect(JSON.stringify(config.manifest).toLowerCase().includes(key.toLowerCase()), 'a key in the manifest').toBe(false);
    const buyer = buyerIdentityOf(env.ADVOCATE_BUYER_PRIV_KEY_HEX);
    expect([config.manifest.identity.controller_pkh, config.manifest.keys]).toStrictEqual([env.SUPPLIER_PKH, { supplier_pkh: env.SUPPLIER_PKH, pub_key_hex: pub, buyer_pkh: buyer.buyerPkh }]);
    expect([config.buyer.pkh, config.buyer.address]).toStrictEqual([buyer.buyerPkh, buyer.address]);
    expect(() => loadConfig({ ...env, SUPPLIER_PUB_KEY_HEX: 'ef'.repeat(32) })).toThrow(/is not the public key of SUPPLIER_PKH/);
    expect(row(section('What the receipt commits to'), '`supplier_pkh`')).toContain('which is also the controller key');
    expect(section('Capability id')).toContain('It holds the two API keys of its third parties, `BRAVE_SEARCH_API_KEY` and `OPENROUTER_API_KEY`. Each is sent only to its own party, and neither reaches an answer, a log line or the manifest.');
  });

  test('the other sentences of the page that state a claim are held word for word, and to the code or the file that has the claim where there is one', async () => {
    const holds = (text: string, sentences: readonly string[]): void => { for (const sentence of sentences) expect(text, sentence).toContain(sentence); };
    const deploy = (file: string): string => readFileSync(new URL(`../../../deploy/host/${file}`, import.meta.url), 'utf8');
    const identity = section('Identity');
    const interfaceText = section('Interface');
    const built = buildResult(parseRequest(exampleRequest()), BRIEF.thesis, checkCitations(BRIEF, PAGES), EXAMPLE_INFERENCE);
    // Identity: the DID is the registry policy of the three agents that have one, then the name of the asset; the supplier key is the one that signs the receipts.
    const policy = /did:vector:agent:([0-9a-f]{56}):/.exec(identity)?.[1] ?? '';
    expect(row(identity, 'DID')).toBe(`| DID | ${tick(`did:vector:agent:${policy}:c5e44677dadefc8a194d15293cad889b85e1ce5c839177f1955778ac4c63d01c`)} |`);
    for (const other of ['agent-history', 'audio-snippets', 'document-pipeline']) expect(readFileSync(new URL(`../../../specs/${other}.md`, import.meta.url), 'utf8'), other).toContain(`did:vector:agent:${policy}:`);
    holds(row(identity, 'Controller'), ["the supplier key, the key that signs this agent's receipts."]);
    // Capability id: the runtime, its pinned commit and its kind are the compose file's; the model string is the one of the example file of the host.
    holds(section('Capability id'), [
      'The result names the model the service asked, and how it asked it, separately, under `model` and `inference`.',
      'The agent runs behind the template runtime (`vector-agent-template`, pinned commit `c4c378a`, `CAPABILITY_KIND=custom`).',
    ]);
    expect(deploy('docker-compose.advocate.yml')).toContain('c4c378a');
    expect(deploy('docker-compose.advocate.yml')).toContain('CAPABILITY_KIND: custom');
    expect(deploy('.env.advocate.example')).toContain('ADVERT_MODEL=advocate-v1');
    holds(section('Terms'), ['Amounts are `lovelace` fields. The last column is the same amount divided by 1,000,000, with six decimals.']);
    // Interface: the two names, the answer and what the runtime hashes, the keys of a request, the order of a job, the check and the refusal.
    holds(interfaceText, [
      'Two things are named apart on this page. The **request JSON** is what you write: the object under Request below.',
      'The service answers with the brief as the response body, and the runtime hashes that body into the receipt.',
      'On the raw routes you wrap it yourself, and the hash you put in the escrow is the hash of the wire payload.',
      'The request is a JSON object with these keys and no other.',
      'Then the job runs in this order, under its deadline:',
      '- The check: see Check below. No argument left is `no_supported_claims` (502).',
      'A refusal is `{ "error": "<code>", "message": "<words>" }` with the status in the table.',
    ]);
    expect(() => parseRequest(JSON.stringify({ subject: 'Cars in the centre', side: 'for', extra: 1 }))).toThrow(RequestError);
    // Response: the body of the answer is the result serialised once, in the order of the spec; every quote of the example is in the excerpt of its page.
    holds(interfaceText, [
      `${tick('schema')} is ${tick(SCHEMA)}. A job that succeeds returns this result as the body of the answer, serialised once, with its keys in this order. A job that fails returns an error (see Errors) and no result. Shape:`,
    ]);
    const body = await serve({ manifest, deps: baseDeps(), log: () => undefined, runAdvocate: async () => GOLDEN_OUTCOME }, async (api) => (await api.post(wire(GOLDEN_REQUEST))).text);
    expect([body, serializeResult(GOLDEN_OUTCOME.result)]).toStrictEqual([JSON.stringify(GOLDEN_OUTCOME.result), JSON.stringify(GOLDEN_OUTCOME.result)]);
    for (const source of built.sources) expect(quoteFound(source.quote, PAGES.find((p) => p.url === source.url)?.excerpt ?? ''), source.url).toBe(true);
    expect(row(interfaceText, '`declared_bias`')).toBe('| `declared_bias` | `side`, the side the request gave, as the intake keeps it, and `statement`, the fixed sentence above |');
    expect(buildResult(parseRequest(JSON.stringify({ subject: 'Cars in the centre', side: ' FOR ' })), BRIEF.thesis, checkCitations(BRIEF, PAGES), EXAMPLE_INFERENCE).declared_bias).toStrictEqual({ side: 'for', statement: DECLARED_BIAS_STATEMENT });
    // The receipt: the service signs no receipt, the runtime does, and the buyer key of the service signs only the transactions of its chat sub-job; the rows of the
    // escrow, the model string and the time.
    const receipt = section('What the receipt commits to');
    holds(receipt, ['The service signs no receipt: its buyer key signs only the transactions of its chat sub-job. The runtime builds and signs the receipt, and submits its hash in the Submit transaction.']);
    expect(row(receipt, '`escrow_ref`')).toBe('| `escrow_ref` | the escrow UTxO, `<txid>#<index>` |');
    expect(row(receipt, '`model`')).toBe('| `model` | `advocate-v1` |');
    expect(row(receipt, '`wallclock_ms`')).toBe('| `wallclock_ms` | how long the service call took |');
    // The operator, the third parties lead-in, the guide that exists, the design link.
    holds(section('Operator and data handling'), ['Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest.', 'The log carries job outcomes, counts and codes, never a request, a page, a quote or a key. What leaves to third parties:']);
    expect([manifest.operator.name, Object.keys(manifest.operator)]).toStrictEqual(['Apex Fusion Foundation', ['name', 'contact']]);
    expect(existsSync(fileURLToPath(new URL('../../../docs/HIRE.md', import.meta.url)))).toBe(true);
    expect(section('Links').split('\n')).toContain('- Design: [docs/superpowers/specs/2026-10-13-vector-service-agents-design.md](../docs/superpowers/specs/2026-10-13-vector-service-agents-design.md)');
    // The structure: the header row of every table, and the label before each of the two shapes.
    const lines = page.split('\n');
    expect(lines.filter((l, i) => l.startsWith('| ') && /^[|][-| ]+[|]$/.test(lines[i + 1] ?? ''))).toStrictEqual([
      '| Field | Value |', '| Term | `lovelace` | Printed |', '| Limit | Value |', '| Field | Rule |', '| Field | Content |', '| Check | Passes when |', '| The hire ends | Code | The escrow then | Falls back |',
      '| Status | Codes |', '| Receipt field | Value for this agent |', '| Party | What it receives |',
    ]);
    for (const heading of ['Request', 'Response']) expect(sub(heading)).toContain('Shape:\n\n```text\n');
  });

  test('the bullets, rows and paragraphs of the page that the tests above hold in part are held whole, with the numbers of the code, and the claims about the prompt and the registry record are held to the code and the runbook', () => {
    const lineOf = (text: string, start: string): string => text.split('\n').find((l) => l.startsWith(start)) ?? '';
    const interfaceText = section('Interface');
    const identity = section('Identity');
    const request = sub('Request');
    const deploy = (file: string): string => readFileSync(new URL(`../../../deploy/host/${file}`, import.meta.url), 'utf8');
    const sibling = (name: string): string => readFileSync(new URL(`../../../specs/${name}.md`, import.meta.url), 'utf8');
    // The registry record: its name, capability and description are the manifest's and the runbook's, its framework is the one of the other three pages, and its endpoint is the public URL.
    expect(row(identity, 'Registry record')).toContain(`| Registry record | name ${tick(manifest.name)}; description as in the manifest, which declares the bias; capabilities ${tick(manifest.capability_id)}; framework ${tick('vector-service-agents')}; endpoint the agent's public URL, ${tick('https://mp-suppliers-advocate.hal8.ai')}; controller key hash `);
    expect(sibling('audio-snippets')).toContain("framework `vector-service-agents`; endpoint the agent's public URL");
    expect(deploy('RUNBOOK-advocate.md')).toContain(`DESC="${manifest.description}"`);
    expect(deploy('RUNBOOK-advocate.md')).toContain('"name":"Advocate"');
    // The Interface: the wire payload and what is done with it, the page-less request, and the fetch rules of the MCP server.
    expect(interfaceText).toContain('The **wire payload** is `canonicalize([{ content: <request JSON as a string>, role: "user" }])`, the canonical JSON (sorted keys, NFC strings, no whitespace) of a one-element message array that carries the request JSON as a string. The sha256 of its UTF-8 bytes is the `prompt_hash` of the escrow. The wire payload is also the `payload` field of `POST /v1/job`, and the runtime claims the escrow and posts it unchanged to the service as the HTTP body.');
    expect(interfaceText).toContain("The marketplace MCP tools (on the hosted mainnet server since 2026-10-14) and the template's buyer, `try-it/src/buy-once.ts`, wrap the request JSON into the wire payload for you.");
    expect(interfaceText).toContain('A request names no page: the service finds the pages with the Brave Search API and fetches them itself, with the same rules as the MCP server (https only, no credentials in the URL, private and reserved addresses refused, redirects refused), at most 1 MB a page, so the brief can cite only what the service could fetch.');
    // The rows of the fields of a request.
    expect(row(request, '`subject`, required')).toBe(`| ${tick('subject')}, required | 1 to ${MAX_SUBJECT_CHARS} characters, with at least one letter or digit: the question or the position the brief is about. |`);
    expect(row(request, '`side`, required')).toBe(`| ${tick('side')}, required | ${tick('for')} or ${tick('against')}, in any case, or a position in words of 1 to ${MAX_SIDE_CHARS} characters with at least one letter or digit. ${tick('for')} and ${tick('against')} are kept in lower case and a position as given, without the spaces around it; the side is returned in ${tick('declared_bias.side')}. |`);
    expect(row(request, '`audience`')).toBe(`| ${tick('audience')} | 1 to ${MAX_AUDIENCE_CHARS} characters: who the brief is for. The model is told it. |`);
    expect(row(request, '`language`')).toBe(`| ${tick('language')} | Default ${tick('en')}. A language code of 2 to ${manifest.interface.request_schema.properties.language.maxLength} characters: 2 to 8 letters, then any number of hyphen-separated subtags of 1 to 8 letters or digits, such as ${tick('en')}, ${tick('en-GB')} or ${tick('zh-Hant-TW')}. The model is asked to write the brief in it; a quote stays in the words of its page. The search is not told it. ${tick('auto')} is refused, for it names no language. |`);
    // The three bullets of the job, whole. The model is asked for the brief the prompt describes.
    expect(lineOf(interfaceText, '- The search:')).toBe(`- The search: two queries to the Brave Search API, made from the subject and the side, with no language parameter and no country, one after the other, the second at least ${QUERY_SPACING_MS} ms after the first: the subject alone, and the subject followed by the words of the side (${tick('arguments in favour')} for ${tick('for')}, ${tick('arguments against')} for ${tick('against')}, the position itself for a position in words), each cut at a word boundary to at most ${MAX_QUERY_CHARS} characters and ${MAX_QUERY_WORDS} words, ${RESULTS_PER_QUERY} results each. A query that answers 429 is asked once more, ${QUERY_SPACING_MS} ms later. The results of the second query come first; a result is kept once, by its scheme, host and path, and only when its URL is https; at most ${MAX_RESULTS} are kept. When one query fails, the search goes on with the results of the other. Both failing is ${tick('search_failed')} (502), and so is a key that the Brave Search API refuses. No usable result is ${tick('search_empty')} (502).`);
    expect(lineOf(interfaceText, '- The pages:')).toBe(`- The pages: each result is fetched by the service, four at a time. A page is kept only when it answers within ${PAGE_TIMEOUT_MS / 1000} s with no redirect and no error, is HTML or plain text, is at most ${PAGE_MAX_BYTES / 1_048_576} MB and has at least ${MIN_PAGE_CHARS} characters of text; its first ${EXCERPT_CHARS} characters are its excerpt, and the kept pages are numbered from ${PAGES[0].n} in the order of the results. No page kept is ${tick('no_sources')} (502).`);
    expect(lineOf(interfaceText, '- The model:')).toBe(`- The model: one call with a fixed prompt, which asks for the strongest brief for the side, with no counter-argument, no rebuttal and no concession, every claim citing the numbered pages, each with a quote of ${QUOTE_MIN_CHARS} to ${QUOTE_MAX_CHARS} characters copied from that page. The model call is bought first from a chat supplier on the Vector marketplace: the service posts a bonded escrow with its own buyer key, sends the prompt, verifies the supplier's signed receipt and accepts; only when that hire fails is the call made through OpenRouter, and the result says which path it took (How it buys, below). The waits of the hire stop ${FALLBACK_RESERVE_MS / 1000} s before the deadline, so that the call through OpenRouter still has its ${MODEL_MAX_MS / 1000} s when the hire fails by then. The call through OpenRouter gets the smaller of ${MODEL_MAX_MS / 1000} s and the time the job has left less ${RESULT_RESERVE_MS / 1000} s, and is not made when that is under ${MODEL_MIN_MS / 1000} s, which is with under ${FETCH_RESERVE_MS / 1000} s of the job left: the job then fails with ${tick('deadline')} (422). The fetch of the pages ends ${FETCH_RESERVE_MS / 1000} s before the deadline at the latest, so that the model has its ${MODEL_MIN_MS / 1000} s and the check and the result ${RESULT_RESERVE_MS / 1000} s. A call that runs out of a time that the deadline of the job cut under ${MODEL_MAX_MS / 1000} s is ${tick('deadline')} (422); any other call that fails, a call that runs out of the whole ${MODEL_MAX_MS / 1000} s among them, is ${tick('model_failed')} (502). An answer of OpenRouter that is not the JSON of a brief is ${tick('model_output_invalid')} (502); one of the chat supplier sends the job to OpenRouter.`);
    const prompt = systemPrompt(parseRequest(exampleRequest()));
    for (const part of ['You write the strongest one-sided brief for a position', 'Give no counter-argument, no rebuttal and no concession', 'Every claim cites one or more of them by number']) expect(prompt, part).toContain(part);
    expect(ACCEPTED_TYPES).toStrictEqual(['text/html', 'application/xhtml+xml', 'text/plain']);
    // The example and the check, whole.
    expect(lineOf(interfaceText, 'Example, for the request above.')).toBe(`Example, for the request above. It is an illustration and not a recorded run: its sources are the three pages of the test fixtures of the service, the thesis, the claims and the support are written for it, and no model wrote them. Every quote in it is found in the text of its page, as the check requires. The ${tick('model')} field reads as the service names its default model on the marketplace path, ${tick(modelLabel(DEFAULT_MODEL, 'marketplace'))}, and the sub-job under ${tick('inference')} is made up for the illustration in the shape the service gives it: its references, hashes, key hash and signature are of no escrow and no supplier.`);
    expect(sub('Check').trim()).toBe(`A source the model cites is a page number and a quote. The quote is kept when the number names a page the service kept, and the quote, normalised, is ${QUOTE_MIN_CHARS} to ${QUOTE_MAX_CHARS} characters long and is found in the normalised excerpt of that page. To normalise a text, the service takes its Unicode NFKC form in lower case, makes the left single quote U+2018 and the apostrophes U+2019 and U+02BC into U+0027, the double quotes U+201C and U+201D into U+0022 and the dashes U+2013 and U+2014 into U+002D, and makes every run of whitespace one space, without the spaces at either end. A quote that is kept is given in the words of its page: the part of the excerpt that the normalised quote was found in, with the case, the marks and the characters of the page, whatever form the model wrote it in, so a brief shows only text its page holds. A quote that fails is dropped. An argument left with no quote is dropped, and the thesis stays. A job whose every argument is dropped fails with ${tick('no_supported_claims')} (502): the thesis never answers alone. An argument lists a page and a quote once, however often the model cites them in it. A quote may be cited by more than one argument.`);
    // The Errors: the bullets, whole, and the two paragraphs under the table.
    const errors = sub('Errors');
    expect(lineOf(errors, '- A job that fails with a code of the 502 row')).toBe(`- A job that fails with a code of the 502 row, or with ${tick('store_write_failed')} (500), answers with a fixed message: ${tick("The service could not do this job (<code>). The operator's log has the detail.")} The codes of the 502 row are failures at a third party, of the hire or of the check. ${tick('deadline')} (422) keeps its words, which are about the time the job had and hold nothing of the request. ${tick('aborted')} (499) is the answer to a caller that has hung up, which nobody reads.`);
    expect(lineOf(errors, '- The runtime fails the job')).toBe(`- The runtime fails the job on any non-2xx answer and copies the first 200 characters of the failure to the buyer. The buyer reclaims after ${tick('deliver_by')}.`);
    expect(lineOf(errors, '- `GET /healthz`')).toBe(`- ${tick('GET /healthz')} and ${tick('GET /agent.json')} are matched on their path, whatever the query string, and a ${tick('HEAD')} of either gets the headers of the ${tick('GET')} and no body. Any other route gets 404 ${tick('{"error":"not_found"}')}, a ${tick('POST /')} with a query string among them.`);
    expect(lineOf(errors, '- One job runs at a time.')).toBe(`- One job runs at a time. A second request while one runs gets 409 ${tick('{"error":"busy"}')}, and nothing is started.`);
    expect(lineOf(errors, 'No refusal locks anything')).toBe("No refusal locks anything of the service's before the Post of its chat sub-job: the 400s and the 401 come before anything is searched or fetched, and the search, the pages and the choice of the supplier lock nothing. A job that fails after that Post leaves its escrow to the janitor (How it buys).");
    expect(lineOf(errors, 'While a job runs')).toBe(`While a job runs the service writes an interim ${tick('102 Processing')} line every ${HEARTBEAT_MS / 1000} s, ahead of the answer, because the runtime's fetch gives up on a response that has not begun after 300 s of silence, and a job can take its whole deadline, ${JOB_DEADLINE_MS / 1000} s, and longer when a hire is in its Accept. A job whose caller hangs up is stopped: its fetches and its call to OpenRouter are aborted and nothing of it is kept, but a hire that has begun first ends on its own terms, its escrow accepted or recorded for the janitor.`);
    // The receipt rows the escrow and the brief give, whole.
    const receipt = section('What the receipt commits to');
    expect(row(receipt, '`supplier_pkh`')).toBe(`| ${tick('supplier_pkh')} | the key hash of the supplier key, which is also the controller key |`);
    expect(row(receipt, '`prompt_hash`')).toBe(`| ${tick('prompt_hash')} | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |`);
    expect(row(receipt, '`response_hash`')).toBe(`| ${tick('response_hash')} | sha256 of the UTF-8 bytes of the brief exactly as the service returned them |`);
    expect(row(receipt, '`prompt_tokens`, `completion_tokens`')).toBe(`| ${tick('prompt_tokens')}, ${tick('completion_tokens')} | 0 and 0, the runtime counts none. The service writes the tokens of its model call in its log; on the marketplace path the receipt of the chat supplier, under ${tick('inference.sub_job')}, carries the counts of that supplier |`);
    expect(receipt).toContain('and the path of the model call with the sub-receipt of the chat supplier, its signature and the checks the service ran on it. The sub-receipt is signed by the chat supplier the service hired, an agent under its own key, and accountability for the brief stays on the key of Advocate.');
    // The row of the Brave Search API, whole; the gaps lead-in; the three ways to hire it.
    expect(row(section('Operator and data handling'), manifest.behaviour.third_parties[0])).toBe(`| ${manifest.behaviour.third_parties[0]} | the two queries the service makes from the subject and the side, with no language parameter, and the API key of the service; the language of the request is not sent |`);
    expect(section('Known gaps')).toContain(`The manifest states these eight, in this order, word for word. A test keeps them equal to ${tick('gapsFor')} in ${tick('agents/advocate/src/gaps.ts')}, with the default model of the service on both paths, ${tick(DEFAULT_MODEL)}. When the first model of ${tick('LLM_MODEL_ALLOWLIST')} is not the model of ${tick('OPENROUTER_MODEL')}, the fifth names both.`);
    expect(existsSync(fileURLToPath(new URL('../src/gaps.ts', import.meta.url)))).toBe(true);
    const how = section('How to hire it');
    for (const part of [
      'Advertised on 2026-10-19 and again on 2026-10-20, at the status flip: the marketplace indexer lists the current advert as Active and free (checked on 2026-10-20). One first-party job has settled, on 2026-10-20; it is not demand. The three ways below apply. The step-by-step guide is [docs/HIRE.md](../docs/HIRE.md).',
      '1. **Chat client via MCP.** Same tools and same steps as for [Agent History](agent-history.md): list suppliers for `research.advocate.onesided.v1`, post an escrow, send the job, poll, verify the receipt, accept. You give the assistant the request JSON, and the tools wrap it into the wire payload. The marketplace tools are on the hosted mainnet server as of 2026-10-14.',
      "2. **Terminal via the template's buyer.** `try-it/src/buy-once.ts` in `vector-agent-template` (pinned commit `c4c378a`), with your own key. The file named by `--payload-file` holds the request JSON, and the buyer wraps it into the wire payload. Allow for the 8 min processing window.",
      "3. **Developers, the raw routes.** You wrap the request JSON yourself and hash the wire payload, as described under Interface. Then the six steps in [Agent History](agent-history.md#how-to-hire-it), with this request JSON and this agent's public URL: its step 2 posts the escrow with the sha256 of the wire payload as `prompt_hash`.",
    ]) expect(how, part).toContain(part);
    expect(((sibling('agent-history').split('\n## How to hire it\n')[1] ?? '').split('\n')).filter((l) => /^ {3}[1-6][.] /.test(l))).toHaveLength(6);
  });
});
