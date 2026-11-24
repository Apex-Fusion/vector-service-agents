// agents/bid-desk/test/readme.test.ts
// The README names every setting that the service reads, every code that it answers with, and the numbers of its routes, its hook, its state, its stop and its times. These tests keep the page and the code from
// parting: a name read in src/ that the table does not name fails, so does a name in the table that no code reads, a code with the wrong status, and a number that is not the code's. A few tests run the real hook,
// the real job and the real service over the stubs of the package, to hold the sentences that say what they do. No test here uses the network.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { VAULT_PAYER_IDENTITY_SETTINGS } from '@vsa/buyer-core';
import type { WireError } from '@vsa/service-kit';
import { BUSY_TEXT, CONTEXT_HEADERS, HEARTBEAT_MS, JobSlot, MAX_BODY, RESERVATION_MS, SHUTDOWN_WAIT_MS, STOPPING_TEXT, TOKEN_SEARCH_MIN, operatorsText, parseWire } from '@vsa/service-kit';
import { BID_CAPABILITIES, BID_DESK_CLAIM, MAX_ITEM_QUANTITY, MAX_RFQ_ITEMS, QUOTE_CHECKS, parsePriceList, parseQuote } from '@vsa/usecase-kit/bids';
import type { PriceList } from '@vsa/usecase-kit/bids';
import { SHARED_CHECK_NAMES, checkSenderActive } from '@vsa/usecase-kit/checks';
import type { ChecksPorts } from '@vsa/usecase-kit/checks';
import { HIRE_MIN_MS } from '@vsa/usecase-kit/decision';
import { COUNTERPARTY_REFUSALS, ERROR_STATUS, MAX_REQUEST_BYTES, RFQ_SCHEMA, canonicalSha256 } from '@vsa/usecase-kit/protocol';
import { HOOK_READS as READS_OF_THE_HOOK, MemoryRfqBook, PASSED_CHECKS_LIMIT, PASSED_CHECKS_TTL_MS, PassedChecks, RFQ_BOOK_LIMIT, createPrecheck } from '../src/checks/index.ts';
import { QUOTE_DECISION, QUOTE_REFUSAL_STATUS, RUNTIME_MARGIN_MS, faultyPriceOf, quoteInput, runQuote } from '../src/job/index.ts';
import type { QuoteDeps } from '../src/job/index.ts';
import { QUOTE_TEXT } from '../src/job/refusal.ts';
import { TEMPLATE_ENV, TEMPLATE_PRICE_LIST, manifestFromEnv } from '../src/serve/manifest.ts';
import { RequestRefusal, parseRfqRequest } from '../src/serve/server.ts';
import {
  BOND_LOVELACE, CALL_TIMEOUT_MS, CHECKS_READ_BUDGET_DEFAULT_MS, CHECKS_READ_BUDGET_MAX_MS, CHECKS_READ_BUDGET_MIN_MS, GATEWAY_DEFAULT, HOOK_READS, HOOK_READS_LIMIT_MS, HOST_DEFAULT, INSTANCES,
  INSTANCE_NAMES, JOB_DEADLINE_MS, MAX_PROCESSING_WINDOW_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, PRICE_LIST_ROUTE, PRICE_LOVELACE, RUNTIME_PRECHECK_WAIT_MS, STATE_DIR_DEFAULT, priceListFileOf,
} from '../src/serve/settings.ts';
import { JANITOR_INTERVAL_MS, JANITOR_STOP_WAIT_MS, SETTINGS, loadConfig, startService } from '../src/serve/start.ts';
import { T, makeWorld as makeHookWorld } from './checks/support.ts';
import { choosing, expectNothingRecorded, gatewayFailure, makeRig, refusalOf } from './job/rig.ts';
import type { Rig } from './job/rig.ts';
import { RFQ_VALUE, T0, choiceOf, failureOf, messageOf, recordFor, rfqOf } from './job/samples.ts';
import { serve } from './serve/serve.ts';
import type { Reply } from './serve/serve.ts';
import { FULL_ENV, IDENTITY_SETTINGS, SERVICE, SUPPLIER, envOf, envWith, keyOf, message, priceListOf } from './serve/support.ts';
import { cleanDirs, headersOf, makeWorld, tempDir, wire } from './serve/world.ts';

afterEach(() => {
  cleanDirs();
});

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
// The ledger's native unit is named once in the repository, in docs/HIRE.md. Spelled in two parts, so that a search for the name finds only the guide.
const UNIT_NAME = new RegExp('AP' + '3X', 'i');
const SECTIONS = [
  'What it is', 'Routes', 'The three instances', 'The request', 'The result', 'The hook', 'Settings', 'Keys', 'The fault switch', 'Errors', 'Times', 'State files', 'Stopping', 'Run it', 'Deploy',
];
const sourceDir = new URL('../src/', import.meta.url);
const sources = (readdirSync(sourceDir, { recursive: true }) as string[]).filter((file) => String(file).endsWith('.ts')).map((file) => ({ file: String(file), text: readFileSync(new URL(String(file), sourceDir), 'utf8') }));
const textOf = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const section = (heading: string): string => (readme.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const ticks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
const cells = (line: string): string[] => line.split('|').slice(1, -1).map((part) => part.trim());
/** The rows of the tables of a section whose first cell starts with a code span. */
const rows = (heading: string): string[] => section(heading).split('\n').filter((line) => /^\| `/.test(line));
/** The rows of the table of a section whose first cell is a name in words: each row but the header and the line under it. */
const wordRows = (heading: string, header: string): string[][] => section(heading).split('\n').filter((line) => line.startsWith('| ') && !line.startsWith(`| ${header} |`)).map(cells);
/** The row of the Settings table for one variable, and one of its cells (1 is the use, 2 is the default). */
const row = (name: string): string => rows('Settings').find((line) => line.startsWith(`| \`${name}\` |`)) ?? '';
const cell = (name: string, at: 1 | 2): string => cells(row(name))[at] ?? '';
/** The environment of a full deployment of the first instance: what FULL_ENV holds and the four settings that name the identity deployment, with the changes of the test. */
const full = (over: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv => envWith({ ...IDENTITY_SETTINGS, ...over });
const config = loadConfig(full());
const template = manifestFromEnv(TEMPLATE_ENV, TEMPLATE_PRICE_LIST);

/** The members of a served manifest that the page speaks of. */
interface Served {
  readonly name: string;
  readonly version: string;
  readonly status: { readonly chip: string; readonly since: string };
  readonly terms: { readonly price_lovelace: number; readonly supplier_bond_lovelace: number; readonly buyer_bond_lovelace: number; readonly max_processing_ms: number; readonly input_limits: { readonly request_bytes: number } };
  readonly behaviour: {
    readonly claim: { readonly statements: ReadonlyArray<{ readonly id: string; readonly text: string }> };
    readonly price_list: { readonly uri: string; readonly sha256: string };
    readonly fault_modes: readonly string[];
    readonly relying_on: { readonly mock_systems: readonly string[]; readonly gateway_routes: readonly string[] };
    readonly data_handling: string;
  };
  readonly gaps: readonly string[];
}
const served = (text: string): Served => JSON.parse(text) as Served;
/** What a decision of the job is given: the JSON object that `quoteInput` builds, with the entries of the price list under `price_list`. */
interface ModelInput {
  readonly price_list: ReadonlyArray<{ readonly sku: string }>;
}
/** The rfq book file as the service writes it: the entries of the answered requests. */
interface BookFile {
  readonly quotes: ReadonlyArray<Record<string, string>>;
}
const bookOf = (file: string): BookFile => JSON.parse(readFileSync(file, 'utf8')) as BookFile;

/** The names that the code reads from the environment itself: `env.NAME`, `process.env.NAME`, and the names given to envInt and requiredEnv. */
function namesRead(): string[] {
  const found = new Set<string>();
  for (const { text } of sources) {
    for (const match of text.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)\b/g)) found.add(match[1]);
    for (const match of text.matchAll(/\b(?:envInt|requiredEnv)\(\s*'([A-Z][A-Z0-9_]*)'/g)) found.add(match[1]);
  }
  return [...found].sort();
}

describe('agents/bid-desk/README.md: the page', () => {
  test('the third line is the description of the manifest and the capability, and the sections are the sections of the design, in their order', () => {
    const lines = readme.split('\n');
    expect(lines[0]).toBe('# Bid Desk');
    for (const instance of INSTANCES) expect(INSTANCE_NAMES[instance].startsWith(lines[0].slice('# '.length)), instance).toBe(true);
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe(`${template.description} Capability \`${BID_CAPABILITIES.quote}\`.`);
    expect(BID_CAPABILITIES.quote).toBe('supplychain.rfq.quote.v1');
    expect(readme).toContain('use case 3 (supplier bid evaluation)');
    expect([...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1])).toStrictEqual(SECTIONS);
  });

  test('the page holds no dash, no unit name, no run of 56 hex characters or more, and no key', () => {
    expect(readme).not.toMatch(/[\u{2013}\u{2014}]/u);
    expect(readme).not.toMatch(UNIT_NAME);
    expect(readme).not.toMatch(/[0-9a-f]{56}/i);
    expect(readme).not.toContain(SERVICE.privateKeyHex);
  });
});

describe('agents/bid-desk/README.md: what it is', () => {
  const intro = section('What it is');

  test('names the checks of the hook, the record that it keeps and the slot that it reserves, the fail closed of the job, and what the service does not do', () => {
    expect(intro).toContain(`The hook makes ${QUOTE_CHECKS.length} checks, one after the other`);
    expect(intro).toContain(`the hook keeps the record of the checks for ${PASSED_CHECKS_TTL_MS / 1000} s and reserves the job slot for that escrow for ${RESERVATION_MS / 1000} s`);
    expect(intro).toContain('A job with no record of passed checks for its own body fails closed: it makes no quote.');
    expect(intro).toContain('`BID_DESK_INSTANCE` selects the price list file and the name of the desk.');
    // The claim is in the manifest. This service files no claim and no challenge, takes no approval and calls no mock system: it has no code for any of them.
    const manifest = served(config.manifest.text);
    expect(manifest.behaviour.claim.statements.map((statement) => statement.text)).toStrictEqual(BID_DESK_CLAIM.statements.map((statement) => statement.text));
    expect(intro).toContain('The claim of the desk is the three statements in `behaviour.claim` of its manifest. No command in this repository stakes that claim yet.');
    expect(intro).toContain('It files no claim and no challenge: it has no dispute code and no dispute setting.');
    expect(SETTINGS.filter((name) => /^DISPUTE_|MODULE1/.test(name))).toStrictEqual([]);
    expect(sources.filter(({ text }) => /usecase-kit\/(?:dispute|cosign)/.test(text)).map(({ file }) => file)).toStrictEqual([]);
    expect(intro).toContain('The Bid Desk takes no approval and calls no mock system.');
    expect(COUNTERPARTY_REFUSALS['bid-desk'].filter((code) => code.startsWith('approval_'))).toStrictEqual([]);
    expect(manifest.behaviour.relying_on.mock_systems).toStrictEqual([]);
    expect(intro).toContain('`pnpm --filter @vsa/bid-desk template`');
    expect(JSON.parse(textOf('../package.json')).name).toBe('@vsa/bid-desk');
    expect(textOf('../package.json')).toContain('"template": "node --import tsx scripts/render-template.mjs"');
  });

  test('the model gets the entries of the price list for the SKUs of the request and no other price, and no code checks its unit prices against the list', async () => {
    expect(intro).toContain('The only price data that the service gives the model is the entries of that file for the SKUs of the request.');
    expect(intro).toContain('The service does not check the unit prices of the model against the list.');
    const input = quoteInput(rfqOf(), config.priceList.list, '2026-11-24') as unknown as ModelInput; // the JSON object that quoteInput builds
    expect(Object.keys(input)).toStrictEqual(['today', 'request', 'price_list']);
    expect(input.price_list.map((entry) => entry.sku)).toStrictEqual(rfqOf().items.map((item) => item.sku));
    const empty = quoteInput(rfqOf({ items: [{ sku: 'NOT-ON-THE-LIST', quantity: 1 }] }), config.priceList.list, '2026-11-24') as unknown as ModelInput; // the same, for a SKU that the list lacks
    expect(empty.price_list).toStrictEqual([]);
    // A price of the model that is not on the list is in the quote as the model gave it: the job reads the list only for the fault.
    const rig = makeRig();
    const [first, ...rest] = choiceOf().lines;
    choosing(rig, choiceOf({ lines: [{ ...first, unit_price: 1 }, ...rest] }));
    const quote = await rig.run();
    expect([quote.lines[0].unit_price, quote.fault_mode]).toStrictEqual([1, '']);
  });
});

describe('agents/bid-desk/README.md: the routes', () => {
  const routes = section('Routes');

  test('Routes states the numbers of the code: the body, the six headers, the reservation, and the line every 60 s', () => {
    expect(routes).toContain(`It is read up to ${MAX_BODY} bytes.`);
    expect(Object.values(CONTEXT_HEADERS)).toHaveLength(6);
    for (const header of Object.values(CONTEXT_HEADERS)) expect(routes, header).toContain(`\`${header}\``);
    expect(routes).toContain(`\`{"go":true,"reserved_ms":${RESERVATION_MS}}\``);
    expect(routes).toContain(`A go of the hook reserves the slot for its escrow for ${RESERVATION_MS} ms`);
    expect(HEARTBEAT_MS).toBe(60_000);
    expect(routes).toContain('writes an interim `102 Processing` line every 60 s');
    expect(textOf('../../../packages/service-kit/src/server.ts')).toContain('req.httpVersionMajor === 1 && req.httpVersionMinor >= 1');
    expect(routes).toContain('Without it, 401 `{"error":"unauthorized"}`');
    expect(routes).toContain(`\`GET ${PRICE_LIST_ROUTE}\``);
    expect(routes).toContain('`GET /healthz`, `GET /agent.json` and `GET /price-list.json` need no token.');
    // The busy answers: a job that finds the slot taken gets 409 with no message, the hook gets 409 with a message, and the slot gives them as the page says.
    expect(routes).toContain('One job runs at a time. A job that arrives while a job runs, or while the slot is reserved for another escrow, gets 409 `{"error":"busy"}`, and nothing starts. A call of the hook gets 409 `busy` with a message while a job runs, whatever its escrow, and while the slot is reserved for another escrow. A new go of the hook for the escrow that holds the reservation reserves the slot again; a refusal of the hook reserves nothing.');
    const slot = new JobSlot();
    expect(slot.take('escrow-a', 1_000)).toBe('taken');
    expect([slot.canTake('escrow-a', 1_000), slot.canTake('escrow-b', 1_000)]).toStrictEqual(['busy', 'busy']);
    slot.release();
    expect(slot.reserve('escrow-a', 1_000)).toBe('reserved');
    expect([slot.canTake('escrow-a', 2_000), slot.canTake('escrow-b', 2_000)]).toStrictEqual(['free', 'held']);
    expect(slot.reserve('escrow-a', 2_000)).toBe('reserved');
    expect(slot.take('escrow-b', 2_000)).toBe('held');
  });

  test('a running service answers each route as the table says: the open routes with no token, the two posts with the token, and any other route with a 404', async () => {
    const world = makeWorld();
    const none = { authorization: null };
    await serve(world, async (api) => {
      const health = await api.request('GET', '/healthz', { headers: none });
      expect([health.status, health.text]).toStrictEqual([200, '{"ok":true}']);
      const agent = await api.request('GET', '/agent.json', { headers: none });
      expect([agent.status, agent.text]).toStrictEqual([200, world.config.manifest.text]);
      const list = await api.request('GET', PRICE_LIST_ROUTE, { headers: none });
      expect([list.status, list.text, list.headers.get('content-type')]).toStrictEqual([200, priceListOf('alfa').text, 'application/json']);
      expect(sha256(list.text)).toBe(served(agent.text).behaviour.price_list.sha256);
      for (const path of ['/healthz', '/agent.json', PRICE_LIST_ROUTE]) {
        expect((await api.request('GET', `${path}?x=1`, { headers: none })).status, `${path} with a query`).toBe(200);
        const head = await api.request('HEAD', path, { headers: none });
        expect([head.status, head.text], `HEAD ${path}`).toStrictEqual([200, '']);
      }
      expect((await api.request('POST', PRICE_LIST_ROUTE, { headers: none })).status).toBe(404);
      for (const path of ['/', '/precheck']) {
        for (const authorization of [null, 'Bearer nothing']) {
          const refused = await api.request('POST', path, { headers: { ...headersOf(world.context), authorization }, body: wire(world.message) });
          expect([refused.status, refused.text], `${path} ${String(authorization)}`).toStrictEqual([401, '{"error":"unauthorized"}']);
        }
      }
      for (const [method, path] of [['GET', '/other'], ['GET', '/v1/job'], ['POST', '/other']] as const) {
        const other = await api.request(method, path, method === 'POST' ? { body: wire(world.message) } : {});
        expect([other.status, other.text], `${method} ${path}`).toStrictEqual([404, '{"error":"not_found"}']);
      }
    });
  });

  test('a job whose caller hangs up is stopped before the hire and before the record, and a hang-up after the record does not stop it', async () => {
    expect(routes).toContain('A job whose caller hangs up is stopped at two points: before the service hires the model, and before the book records the quote. It ends with `deadline`, and it records nothing. A hire that has started is not stopped. A hang-up after the record does not stop the job: the quote is booked, the job gives it, and its log says that the caller hung up.');
    const before = makeRig();
    expect((await refusalOf(before.run({ signal: AbortSignal.abort() }))).code).toBe('deadline');
    expect(before.events).toStrictEqual(['take']);
    // The hang-up comes while the model hire is under way: the hire ends, and the job stops before it records the quote.
    const during = makeRig();
    const controller = new AbortController();
    const decide = during.deps.decide;
    const hung: QuoteDeps = { ...during.deps, decide: async (input) => { const answer = await decide(input); controller.abort(); return answer; } };
    expect((await refusalOf(runQuote(hung, during.request, during.context, T0, controller.signal))).code).toBe('deadline');
    expect(during.events).toStrictEqual(['take', 'decide', 'has', 'credential']);
    expectNothingRecorded(during);
    // The hang-up comes with the record: the quote is booked, the job gives it, and the log says so.
    const after = makeRig();
    const late = new AbortController();
    const record = after.deps.book.record;
    const booked: QuoteDeps = { ...after.deps, book: { has: after.deps.book.has, record: async (...args) => { await record(...args); late.abort(); } } };
    const quote = await runQuote(booked, after.request, after.context, T0, late.signal);
    expect(quote.outcome).toBe('done');
    expect(after.booked).toHaveLength(1);
    expect(after.logs.some((line) => line.includes('the caller hung up while the quote was booked'))).toBe(true);
  });
});

describe('agents/bid-desk/README.md: the three instances', () => {
  const instances = section('The three instances');

  test('the table gives each instance its name, the rule of its organisation and its price list file, and the code takes each from the setting or the file', () => {
    expect(rows('The three instances').map(cells)).toStrictEqual(INSTANCES.map((instance) => [`\`${instance}\``, INSTANCE_NAMES[instance], `\`${instance}.<domain>\``, `\`price-lists/${instance}.json\``]));
    for (const instance of INSTANCES) {
      const own = loadConfig(envOf(instance, IDENTITY_SETTINGS));
      const manifest = served(own.manifest.text);
      expect([own.instance, own.organisation, manifest.name]).toStrictEqual([instance, `${instance}.example.test`, INSTANCE_NAMES[instance]]);
      expect(priceListFileOf(instance).endsWith(`/agents/bid-desk/price-lists/${instance}.json`), instance).toBe(true);
      expect(own.priceList.sha256, instance).toBe(sha256(readFileSync(priceListFileOf(instance))));
      expect(manifest.behaviour.price_list, instance).toStrictEqual({ uri: `https://bids-${instance}.example.test${PRICE_LIST_ROUTE}`, sha256: own.priceList.sha256 });
    }
    // Three manifests, three hashes, and each differs from the others in the name and the price list and in what the settings give.
    expect(new Set(INSTANCES.map((instance) => loadConfig(envOf(instance, IDENTITY_SETTINGS)).manifest.sha256)).size).toBe(3);
    expect(section('What it is')).toContain('`BID_DESK_INSTANCE` selects the price list file and the name of the desk.');
  });

  test('the text names the port, the form that the code checks of the organisation, the files, and the terms that the three share', () => {
    expect(instances).toContain(`The container port is ${PORT_DEFAULT} in all three: the image sets \`PORT\` to ${PORT_DEFAULT} and its health check reads that port, so a deployment changes only the side of the host in the mapping.`);
    expect(textOf('../Dockerfile')).toContain(`ENV NODE_ENV=production PORT=${PORT_DEFAULT} HOST=${HOST_DEFAULT}`);
    expect(textOf('../Dockerfile')).toContain(`127.0.0.1:${PORT_DEFAULT}/healthz`);
    expect(instances).toContain('It checks the form of a domain name (lower case, at least two labels, at most 64 characters) and not the first label.');
    // The code takes the organisation as it is: the first label need not be the instance, and the form is the form of a domain name.
    expect(loadConfig(envOf('alfa', { ...IDENTITY_SETTINGS, BID_DESK_ORGANISATION: 'bravo.example.test' })).organisation).toBe('bravo.example.test');
    expect(() => loadConfig(envOf('alfa', { ...IDENTITY_SETTINGS, BID_DESK_ORGANISATION: 'Alfa' }))).toThrow(/^environment variable BID_DESK_ORGANISATION must be a domain name in lower case/);
    const lists = INSTANCES.map((instance) => parsePriceList(JSON.parse(priceListOf(instance).text)));
    const skus = lists.map((list) => (list.ok ? list.value.items.map((entry) => entry.sku) : []));
    expect(skus.every((names) => names.length === 3 && names.join() === skus[0].join())).toBe(true);
    expect(instances).toContain(`(\`${skus[0].slice(0, -1).join('`, `')}\` and \`${skus[0].at(-1)}\`)`);
    for (const list of lists) expect(list.ok && list.value.items.every((entry) => entry.breaks.map((step) => step.min_quantity).join() === '1,100,500')).toBe(true);
    expect(instances).toContain('from the quantities 1, 100 and 500');
    expect(new Set(INSTANCES.map((instance) => priceListOf(instance).text)).size).toBe(3);
    expect(instances).toContain(`price ${PRICE_LOVELACE} lovelace, supplier bond ${BOND_LOVELACE} and buyer bond ${BOND_LOVELACE}. The buyer locks ${PRICE_LOVELACE + 2 * BOND_LOVELACE}.`);
    const { terms } = served(config.manifest.text);
    expect([terms.price_lovelace, terms.supplier_bond_lovelace, terms.buyer_bond_lovelace]).toStrictEqual([PRICE_LOVELACE, BOND_LOVELACE, BOND_LOVELACE]);
  });
});

describe('agents/bid-desk/README.md: the request', () => {
  const request = section('The request');
  const base = { schema: RFQ_SCHEMA, sender_did: `did:vector:${'a1'.repeat(32)}`, delegation: '5e'.repeat(32), rfq: { rfq_id: 'rfq-1', items: [{ sku: 'GLV-NIT-M', quantity: 1 }], needed_by: '2026-12-20' } };
  /** What the parser of the service says of the request with the members of `rfq` replaced: `accepted`, or the code of its refusal. */
  const verdict = (over: Readonly<Record<string, unknown>>): string => {
    try {
      parseRfqRequest(JSON.stringify({ ...base, rfq: { ...base.rfq, ...over } }));
      return 'accepted';
    } catch (error) {
      return error instanceof RequestRefusal ? error.code : 'not a refusal of the request';
    }
  };
  const twenty = Array.from({ length: MAX_RFQ_ITEMS }, (_, at) => ({ sku: `S${at}`, quantity: 1 }));

  test('the rules of the table are the rules of the parser: the limit is accepted, and one step outside it is bad_shape', () => {
    expect(request).toContain(`"schema": "${RFQ_SCHEMA}"`);
    expect(request).toContain('exactly four members');
    expect(request).toContain('exactly three members');
    expect(verdict({})).toBe('accepted');
    expect(request).toContain(`1 to ${MAX_RFQ_ITEMS} items`);
    expect([verdict({ items: twenty }), verdict({ items: [...twenty, { sku: 'S99', quantity: 1 }] }), verdict({ items: [] })]).toStrictEqual(['accepted', 'bad_shape', 'bad_shape']);
    expect(request).toContain(`a whole number from 1 to ${MAX_ITEM_QUANTITY}`);
    expect([MAX_ITEM_QUANTITY, MAX_ITEM_QUANTITY + 1, 0].map((quantity) => verdict({ items: [{ sku: 'A', quantity }] }))).toStrictEqual(['accepted', 'bad_shape', 'bad_shape']);
    expect(request).toContain('1 to 64 characters: letters, digits, dots, hyphens and underscores, starting with a letter or a digit.');
    expect(['a'.repeat(64), 'a'.repeat(65), '-a', 'a b', '', 'RFQ-7', 'rfq-7'].map((id) => verdict({ rfq_id: id }))).toStrictEqual(['accepted', 'bad_shape', 'bad_shape', 'bad_shape', 'bad_shape', 'accepted', 'accepted']);
    expect(request).toContain('each SKU once');
    expect(verdict({ items: [{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 2 }] })).toBe('bad_shape');
    expect(request).toContain('a date as `YYYY-MM-DD` that exists, in the year 0100 or later');
    expect(['2026-02-30', '0099-12-31', '0100-01-01', '2026-12-20'].map((day) => verdict({ needed_by: day }))).toStrictEqual(['bad_shape', 'bad_shape', 'accepted', 'accepted']);
    expect(verdict({ extra: 1 })).toBe('bad_shape');
    expect(() => parseRfqRequest(JSON.stringify({ ...base, extra: 1 }))).toThrow(RequestRefusal);
    expect(request).toContain('Kelvin sign');
    expect(verdict({ rfq_id: '\u212aRFQ' })).toBe('bad_shape');
    expect(request).toContain('The hook does not check the SKUs against the price list.');
    expect(request).toContain(`at or below ${MAX_REQUEST_BYTES} bytes (\`terms.input_limits.request_bytes\`)`);
    expect(served(config.manifest.text).terms.input_limits.request_bytes).toBe(MAX_REQUEST_BYTES);
  });
});

describe('agents/bid-desk/README.md: the result and the state', () => {
  test('a job after a go gives the quote with the members of the table in that order, the book holds the request, and the state folder is what State files says', async () => {
    const result = section('The result');
    const world = makeWorld();
    await serve(world, async (api) => {
      const book = join(world.stateDir, 'rfq-book.json');
      expect(readdirSync(world.stateDir).filter((name) => !name.startsWith('.')).sort()).toStrictEqual(['keys', 'rfq-book.json']);
      expect(readdirSync(join(world.stateDir, 'keys'))).toStrictEqual([SERVICE.pkh]);
      expect(existsSync(join(world.stateDir, 'keys', SERVICE.pkh, 'stranded.json'))).toBe(false);
      expect(bookOf(book).quotes).toStrictEqual([]);

      expect((await api.precheck()).json).toStrictEqual({ go: true, reserved_ms: RESERVATION_MS });
      const reply = await api.job();
      expect(reply.status, reply.text).toBe(200);
      const parsed = parseQuote(reply.json);
      if (!parsed.ok) throw new Error(parsed.detail);
      const quote = parsed.value;
      // The members, in the order of the page, and the members of the lines, the sender and the checks.
      expect(rows('The result').map((line) => ticks(cells(line)[0])[0])).toStrictEqual(Object.keys(reply.json ?? {}));
      const member = (name: string): string => rows('The result').find((line) => line.startsWith(`| \`${name}\` |`)) ?? '';
      for (const name of Object.keys(quote.lines[0])) expect(member('lines'), name).toContain(`\`${name}\``);
      for (const name of Object.keys(quote.sender)) expect(member('sender'), name).toContain(`\`${name}\``);
      expect(ticks(cells(member('checks'))[1]).slice(1)).toStrictEqual([...QUOTE_CHECKS]);
      expect(Object.keys(quote.checks)).toStrictEqual([...QUOTE_CHECKS]);
      expect([quote.outcome, quote.desk_did, quote.organisation, quote.price_list_sha256, quote.fault_mode]).toStrictEqual(['done', world.config.agentDid, world.config.organisation, world.config.priceList.sha256, '']);
      expect(quote.decisions.map((decision) => decision.name)).toStrictEqual(['quote']);
      expect(Object.keys(reply.json ?? {}).at(-1)).toBe('fault_mode');
      expect(result).toContain('`vector.usecase.quote.v1`');
      expect(quote.total).toBe(quote.lines.reduce((sum, line) => sum + line.line_total, 0));
      expect(quote.lead_time_days).toBe(Math.max(...quote.lines.map((line) => line.lead_time_days)));

      // The book holds the sender, the identifier and the hash of the quote, and the hook refuses the same request from then on.
      const hash = canonicalSha256(reply.json);
      if (!hash.ok) throw new Error(hash.detail);
      const entries = bookOf(book).quotes;
      expect(entries).toStrictEqual([{ sender_did: world.sender.did, rfq_id: quote.rfq_id, quote_sha256: hash.value }]);
      const again = await api.precheck();
      expect([again.status, again.json?.error]).toStrictEqual([403, 'duplicate_rfq']);
      // The model hire posted its escrow and was accepted: the stranded file was made at the Post, and it holds no escrow now.
      const stranded = join(world.stateDir, 'keys', SERVICE.pkh, 'stranded.json');
      expect(existsSync(stranded)).toBe(true);
      expect(JSON.parse(readFileSync(stranded, 'utf8'))).toStrictEqual([]);
      // A book file that is gone after the start is an error and never an empty book.
      rmSync(book);
      const lost = await api.precheck();
      expect([lost.status, lost.json?.error]).toStrictEqual([503, 'check_unavailable']);
    });
    const state = section('State files');
    expect(state).toContain('the rfq book: the sender, the request identifier and the hash of the quote of each request that the service answered.');
    expect(state).toContain('The first start makes `rfq-book.json` with an empty book, and makes the folder of the service key. `stranded.json` is made when a model hire first posts an escrow.');
    expect(state).toContain('A file that is missing or damaged after the start makes the hook answer 503 `check_unavailable`, and it never reads as an empty book.');
  });

  test('a choice with no line is model_output_invalid, and the instruction to the model leaves out an item that the list does not carry', async () => {
    expect(section('The result')).toContain('A choice with no line is `model_output_invalid` (502) after the Claim. The instruction to the model says to leave an item that the price list does not carry out of the lines, so a request that holds no SKU of the list ends that way.');
    expect(QUOTE_DECISION.instruction).toContain('Leave an item that the price list does not carry out of "lines", and name it in "notes".');
    const rig = makeRig({ rfq: { items: [{ sku: 'NOT-ON-THE-LIST', quantity: 1 }] } });
    choosing(rig, choiceOf({ lines: [] }));
    const refusal = await refusalOf(rig.run());
    expect([refusal.code, refusal.status]).toStrictEqual(['model_output_invalid', 502]);
    expectNothingRecorded(rig);
  });
});

describe('agents/bid-desk/README.md: the hook', () => {
  const hook = section('The hook');
  const table = rows('The hook').map(cells);

  test('the table holds the codes of COUNTERPARTY_REFUSALS for the Bid Desk and check_unavailable, each with its status and its check, in the order of the checks', async () => {
    const expected = [...COUNTERPARTY_REFUSALS['bid-desk'], 'check_unavailable'];
    const codes = table.map((cellsOfRow) => ticks(cellsOfRow[0])[0]);
    expect(new Set(codes)).toStrictEqual(new Set(expected));
    expect(codes).toStrictEqual(expected);
    for (const [at, cellsOfRow] of table.entries()) expect(Number(cellsOfRow[1]), codes[at]).toBe(ERROR_STATUS[codes[at] as keyof typeof ERROR_STATUS]);
    expect(table.slice(0, -1).map((cellsOfRow) => ticks(cellsOfRow[2])[0])).toStrictEqual([...QUOTE_CHECKS]);
    expect(table.at(-1)?.[2]).toBe('each check');
    // The first six checks are the shared checks of the kit, and the seventh is the check of the Bid Desk.
    expect([...SHARED_CHECK_NAMES['bid-desk'], 'not_duplicate']).toStrictEqual([...QUOTE_CHECKS]);
    expect(hook).toContain('The first six checks are the shared checks of the kit: the sender, the delegation and the payment from a vault. The seventh is the check of the Bid Desk.');
    expect(hook).toContain(`it waits ${RUNTIME_PRECHECK_WAIT_MS} ms for the answer`);
    expect(hook).toContain('A sender that the identity gateway suspends because no Accountable Party covers its record gets `sender_unaccountable` from the first check, and not `sender_not_active`.');
    const world = makeHookWorld();
    const answer = await world.ports.gateway.resolve(world.sender.did);
    if (!answer.ok || answer.value.kind !== 'resolved') throw new Error('the stub gateway did not resolve the sender');
    const resolved = answer.value;
    expect(checkSenderActive({ ...resolved, effectiveStatus: 'suspended', effectiveReason: 'unaccountable' }, world.sender.did)).toMatchObject({ ok: false, code: 'sender_unaccountable' });
    expect(checkSenderActive({ ...resolved, effectiveStatus: 'suspended', effectiveReason: 'parentSuspended' }, world.sender.did)).toMatchObject({ ok: false, code: 'sender_not_active' });
  });

  test('the hook makes the timed reads that the page names: the gateway once and the ledger three times, and a go keeps the record that the job takes', async () => {
    expect(hook).toContain(`The hook makes ${HOOK_READS} timed reads, one after the other: the identity gateway once and the ledger three times (the delegation, its use and the payment from a vault).`);
    expect([HOOK_READS, READS_OF_THE_HOOK]).toStrictEqual([4, 4]);
    expect(CHECKS_READ_BUDGET_MAX_MS * HOOK_READS).toBeLessThan(HOOK_READS_LIMIT_MS);
    expect(HOOK_READS_LIMIT_MS).toBeLessThan(RUNTIME_PRECHECK_WAIT_MS);
    expect(hook).toContain(`${HOOK_READS} times the largest budget that the service accepts is under ${HOOK_READS_LIMIT_MS} ms`);
    const world = makeHookWorld();
    const calls: string[] = [];
    const { gateway, ledger } = world.ports;
    const ports: ChecksPorts = {
      ...world.ports,
      gateway: { resolve: (did) => { calls.push('gateway'); return gateway.resolve(did); } },
      ledger: {
        ...ledger,
        readDelegation: (id) => { calls.push('delegation'); return ledger.readDelegation(id); },
        delegationUse: (id, atMs) => { calls.push('delegation use'); return ledger.delegationUse(id, atMs); },
        escrowPaid: (escrowRef, delegation) => { calls.push('vault payment'); return ledger.escrowPaid(escrowRef, delegation); },
      },
    };
    const passed = new PassedChecks();
    expect(await createPrecheck({ ports, book: new MemoryRfqBook(), passed, clock: () => T, log: () => undefined })(world.rfq, world.context)).toStrictEqual({ go: true });
    expect(calls).toStrictEqual(['gateway', 'delegation', 'delegation use', 'vault payment']);
    expect(calls).toHaveLength(HOOK_READS);
    const entry = passed.take(world.context.escrowRef, T);
    expect(Object.keys(entry?.record.checks ?? {})).toStrictEqual([...QUOTE_CHECKS]);
    expect(passed.take(world.context.escrowRef, T)).toBeNull();
    expect(hook).toContain(`The record lives ${PASSED_CHECKS_TTL_MS / 1000} s, and the store holds ${PASSED_CHECKS_LIMIT} of them.`);
    expect(hook).toContain('`PassedChecks` removes it when it gives it.');
  });

  test('a job with no usable record of the checks ends precheck_missing (500) before it calls the model, and the same job with its record gives the quote', async () => {
    expect(hook).toContain('A job with no record, a record for another body, a record that lacks one of the 7 checks, and a record with a fact that cannot be read all end `precheck_missing` (500). The job fails closed: it calls no model and writes nothing.');
    const cases: ReadonlyArray<readonly [string, (rig: Rig) => void]> = [
      ['no record', (rig) => { rig.entry = null; }],
      ['the record of another body', (rig) => { rig.entry = recordFor(messageOf({ ...RFQ_VALUE, rfq_id: 'other-rfq' })); }],
      ['a record that lacks one of the checks', (rig) => { rig.entry = recordFor(rig.request, { checks: Object.fromEntries(QUOTE_CHECKS.slice(1).map((name) => [name, true as const])) }); }],
      ['a record with a fact that cannot be read', (rig) => { rig.entry = recordFor(rig.request, { facts: { organisation: 7, organisation_verified: true } }); }],
    ];
    for (const [what, setup] of cases) {
      const rig = makeRig();
      setup(rig);
      const refusal = await refusalOf(rig.run());
      expect([refusal.code, refusal.status], what).toStrictEqual(['precheck_missing', 500]);
      expect(rig.events, what).not.toContain('decide');
      expectNothingRecorded(rig);
    }
    expect((await makeRig().run()).outcome).toBe('done');
  });
});

describe('agents/bid-desk/README.md: the settings', () => {
  test('the Settings table names each setting of SETTINGS once, and SETTINGS are the names that the code reads and the four identity names that buyer-core reads', () => {
    const documented = rows('Settings').flatMap((line) => ticks(cells(line)[0])).sort();
    expect(new Set(documented).size, 'a name stands in two rows').toBe(documented.length);
    expect(documented).toStrictEqual([...SETTINGS].sort());
    expect([...SETTINGS].sort()).toStrictEqual([...new Set([...namesRead(), ...VAULT_PAYER_IDENTITY_SETTINGS])].sort());
    // No source of the service writes an identity name: it takes them from buyer-core.
    for (const name of VAULT_PAYER_IDENTITY_SETTINGS) expect(namesRead().includes(name), name).toBe(false);
    expect(readme).toContain('under the names that the MCP server reads');
    expect(section('Settings')).toContain('The Bid Desk reads no mock base, no Module-1 manifest and no dispute setting.');
  });

  test('a required setting is one that the service refuses to start without, and the table says "none. Required" for those and for no other', () => {
    const required = Object.keys(full());
    for (const name of required) {
      expect(() => loadConfig(full({ [name]: undefined })), name).toThrow();
      expect(cell(name, 2), name).toMatch(/^none\. Required/);
    }
    for (const name of SETTINGS.filter((setting) => !required.includes(setting))) expect(cell(name, 2), name).not.toMatch(/^none\. Required/);
    expect(row('BID_DESK_SERVICE_PRIV_KEY_HEX')).toMatch(/ \| none\. Required: the service stops at start without it \|$/);
    expect(cell('IDENTITY_POLICY_ID', 1)).toContain('It must be the identity policy that `VECTOR_IDENTITY_LEGACY_ROOT` and `VECTOR_IDENTITY_CONFIG_SEED` give, or the service stops at start');
    for (const name of ['LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE']) expect(cell(name, 2), name).toBe('none. Required: no limit is not an answer');
  });

  test("the defaults that the table gives are the code's", () => {
    const manifest = served(config.manifest.text);
    expect([cell('PORT', 2), cell('HOST', 2), cell('BID_DESK_STATE_DIR', 2)]).toStrictEqual([`\`${PORT_DEFAULT}\``, `\`${HOST_DEFAULT}\``, `\`${STATE_DIR_DEFAULT}\``]);
    expect([config.port, config.host, config.stateDir]).toStrictEqual([PORT_DEFAULT, HOST_DEFAULT, STATE_DIR_DEFAULT]);
    expect([PORT_DEFAULT, HOST_DEFAULT, STATE_DIR_DEFAULT]).toStrictEqual([9106, '0.0.0.0', '/data']);
    expect([cell('AGENT_VERSION', 2), cell('AGENT_STATUS_CHIP', 2), cell('AGENT_STATUS_SINCE', 2)]).toStrictEqual([`\`${manifest.version}\``, `\`${manifest.status.chip}\``, `\`${manifest.status.since}\``]);
    expect(row('AGENT_STATUS_CHIP')).toContain('`status.chip`, in lower case. It must be live, deployed or proposed, in any case');
    // The window of the advert: the default is the least, and the most is 24 hours.
    expect(cell('ADVERT_MAX_PROCESSING_MS', 2)).toBe(`\`${MIN_PROCESSING_WINDOW_MS}\``);
    expect(manifest.terms.max_processing_ms).toBe(MIN_PROCESSING_WINDOW_MS);
    expect(cell('ADVERT_MAX_PROCESSING_MS', 1)).toContain(`At least ${MIN_PROCESSING_WINDOW_MS}, because the deadline of a job assumes the ${MIN_PROCESSING_WINDOW_MS / 60_000} min window. At most ${MAX_PROCESSING_WINDOW_MS}, the ${MAX_PROCESSING_WINDOW_MS / 3_600_000} h that a Post accepts`);
    expect(served(loadConfig(full({ ADVERT_MAX_PROCESSING_MS: String(MAX_PROCESSING_WINDOW_MS) })).manifest.text).terms.max_processing_ms).toBe(MAX_PROCESSING_WINDOW_MS);
    // The budget of a read of the hook: the default, and the range that holds the four reads under 9 seconds.
    expect(cell('CHECKS_READ_BUDGET_MS', 2)).toBe(`\`${CHECKS_READ_BUDGET_DEFAULT_MS}\``);
    expect(config.checksBudgetMs).toBe(CHECKS_READ_BUDGET_DEFAULT_MS);
    expect(cell('CHECKS_READ_BUDGET_MS', 1)).toContain(`A whole number from ${CHECKS_READ_BUDGET_MIN_MS} to ${CHECKS_READ_BUDGET_MAX_MS}: ${HOOK_READS} reads must stay under ${HOOK_READS_LIMIT_MS} ms`);
    expect(cell('IDENTITY_GATEWAY_URL', 2)).toBe(`\`${GATEWAY_DEFAULT}\``);
    expect(config.endpoints.gatewayUrl).toBe(GATEWAY_DEFAULT);
    expect([cell('ADVERT_EXPLORER_URL', 2), cell('FAULT_MODE', 2), cell('BID_DESK_SERVICE_PKH', 2), cell('IDENTITY_ADDRESS', 2)]).toStrictEqual(['empty', 'empty', 'derived', 'derived from the policy']);
    expect([config.fault.mode, config.service.pkh, SERVICE.pkh]).toStrictEqual(['', SERVICE.pkh, SERVICE.pkh]);
    for (const name of ['VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL']) expect(cell(name, 2), name).toBe('the default of `packages/buyer-core`');
    expect(cell('VECTOR_OGMIOS_URL', 1)).toContain('It must be an `https://` address');
  });

  test('the fault switch is empty or quote_off_price_list, as the table says, and a public key must hash to the key hash beside it', () => {
    expect(cell('FAULT_MODE', 1)).toContain('empty, or `quote_off_price_list`. Any other value stops the start');
    expect(loadConfig(full({ FAULT_MODE: 'quote_off_price_list' })).fault.mode).toBe('quote_off_price_list');
    expect(message(() => loadConfig(full({ FAULT_MODE: 'confirm_wrong_lot' })))).toMatch(/^environment variable FAULT_MODE must be empty or "quote_off_price_list"/);
    expect(cell('SUPPLIER_PUB_KEY_HEX', 1)).toContain('The service stops at start unless its key hash is `SUPPLIER_PKH`');
    expect(message(() => loadConfig(full({ SUPPLIER_PUB_KEY_HEX: keyOf('bid desk readme test: another key').pubKeyHex })))).toMatch(/^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/);
  });
});

describe('agents/bid-desk/README.md: the keys and the fault switch', () => {
  test('the service holds one key and its cross-check, reads the variable once, and never holds the supplier key', () => {
    const keys = section('Keys');
    expect(SETTINGS.filter((name) => name.endsWith('_PRIV_KEY_HEX'))).toStrictEqual(['BID_DESK_SERVICE_PRIV_KEY_HEX']);
    expect(keys).toContain('The service holds one key: the service key, `BID_DESK_SERVICE`. Its secret is `BID_DESK_SERVICE_PRIV_KEY_HEX`, and `BID_DESK_SERVICE_PKH` is the public cross-check.');
    expect(sources.filter(({ text }) => text.includes('BID_DESK_SERVICE_PRIV_KEY_HEX')).map(({ file }) => file)).toStrictEqual(['serve/start.ts']);
    expect(sources.some(({ text }) => text.includes('SUPPLIER_PRIV_KEY'))).toBe(false);
    // The key pays for the model hire (the chain and the paying key of the wiring), and it signs the transactions of the janitor (the janitor of the paying key).
    expect(keys).toContain('The service key pays for the model hire of the quote decision');
    expect(textOf('../src/serve/wiring.ts')).toContain('privateKeyHex: config.service.privateKeyHex');
    expect(textOf('../src/serve/wiring.ts')).toContain('key, limits: config.limits');
    expect(textOf('../src/serve/start.ts')).toContain('wired.key.startJanitor(');
    expect(keys).toContain('It also signs the transactions of the janitor, which settles the escrows that a hire leaves behind.');
    // The supplier key: the service holds its key hash and its public key, and stops when the service key is the supplier key.
    expect(keys).toContain('The service stops at start when the service key is the supplier key');
    expect(message(() => loadConfig(full({ BID_DESK_SERVICE_PRIV_KEY_HEX: SUPPLIER.privateKeyHex })))).toMatch(/^environment variable BID_DESK_SERVICE_PRIV_KEY_HEX holds the supplier key/);
    expect(() => loadConfig(full())).not.toThrow();
  });

  test('the fault lowers the first priced line by a fifth of its listed price, rounded up, the totals follow, and no check and no manifest changes', async () => {
    const text = section('The fault switch');
    expect(text).toContain('`listed - ceil(listed / 5)`');
    expect(faultyPriceOf(125)).toBe(125 - Math.ceil(125 / 5));
    const clean = await makeRig().run();
    const faulty = await makeRig({ mode: 'quote_off_price_list' }).run();
    expect(faulty.fault_mode).toBe('quote_off_price_list');
    expect(faulty.lines[0].unit_price).toBe(faultyPriceOf(clean.lines[0].unit_price));
    expect(faulty.lines[0].unit_price).toBeLessThan(clean.lines[0].unit_price);
    expect(faulty.lines.slice(1)).toStrictEqual(clean.lines.slice(1));
    expect(faulty.total).toBe(faulty.lines.reduce((sum, line) => sum + line.line_total, 0));
    expect(faulty.checks).toStrictEqual(clean.checks);
    expect(faulty.decisions[0]).toStrictEqual(clean.decisions[0]);
    expect(text).toContain('The decision on record stays what the model said.');
    expect(text).toContain('The totals follow the changed line.');
    // Every price of the three files is 10 or more, so the new price is at least 1.
    for (const instance of INSTANCES) {
      const list = parsePriceList(JSON.parse(priceListOf(instance).text));
      expect(list.ok && Math.min(...list.value.items.flatMap((entry) => entry.breaks.map((step) => step.unit_price)))).toBeGreaterThanOrEqual(10);
    }
    expect(text).toContain('because every price of the three files is 10 or more');
    // No check of the hook reads the fault, and the manifest is the same for both settings of the switch, and lists the value.
    expect(sources.filter(({ file, text: code }) => file.startsWith('checks/') && /quote_off_price_list|FAULT_MODE|fault_mode|FaultSwitch/.test(code))).toStrictEqual([]);
    expect(text).toContain('no check of the hook reads it');
    const [off, on] = ['', 'quote_off_price_list'].map((mode) => loadConfig(full({ FAULT_MODE: mode })).manifest.text);
    expect(on).toBe(off);
    expect(served(on).behaviour.fault_modes).toStrictEqual(['quote_off_price_list']);
    expect(served(on).gaps.filter((gap) => gap.includes('quote_off_price_list'))).toHaveLength(1);
    expect(text).toContain('The manifest lists the value in `behaviour.fault_modes`');
    // A fault that can change no line ends the job `internal`, and never a quote that says the fault was on.
    const nothing = makeRig({ mode: 'quote_off_price_list', list: priceListWith('OTHER-SKU') });
    const refusal = await refusalOf(nothing.run());
    expect([refusal.code, refusal.status]).toStrictEqual(['internal', 500]);
    expect(text).toContain('When no line can take that price, the job ends `internal`');
  });
});

/** A price list that carries one SKU and not the SKUs of the request: no line can take the price of the fault. */
function priceListWith(sku: string): PriceList {
  const parsed = parsePriceList({ schema: 'vector.usecase.price-list.v1', items: [{ sku, lead_time_days: 3, breaks: [{ min_quantity: 1, unit_price: 20 }] }] });
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.value;
}

describe('agents/bid-desk/README.md: the errors', () => {
  const errors = section('Errors');
  const table = errors.split('\n').filter((line) => /^\| \d{3}, /.test(line));
  const documented = new Map<string, number[]>();
  for (const line of table) {
    const status = Number(/^\| (\d{3}), /.exec(line)?.[1]);
    // A word in the explanation of a code, in brackets, is no code.
    for (const code of ticks(cells(line)[1].replace(/\([^)]*\)/g, '')).filter((text) => /^[a-z_]+$/.test(text))) documented.set(code, [...(documented.get(code) ?? []), status]);
  }

  test('the Errors table gives each code its status, and its codes are the codes that the hook, the job and the server write, no more and no less', () => {
    const kit = textOf('../../../packages/service-kit/src/server.ts');
    expect(table).toHaveLength(11);
    for (const [code, statuses] of documented) {
      for (const status of statuses) {
        if (code === 'bad_context' || code === 'bad_shape') expect(new RequestRefusal(code, 'x').status, code).toBe(status);
        else if (code === 'not_found') expect([status, kit.includes("return send(404, { error: 'not_found' });")], code).toStrictEqual([404, true]);
        else expect(ERROR_STATUS[code as keyof typeof ERROR_STATUS], code).toBe(status);
      }
    }
    // The codes of the hook: the 403 row holds the refusal codes of the Bid Desk in the order of the checks, and the job after the Claim gives the one code that it can.
    const before = table.find((line) => line.startsWith('| 403, the hook, before the Claim'));
    expect(ticks(cells(before ?? '')[1])).toStrictEqual([...COUNTERPARTY_REFUSALS['bid-desk']]);
    const after = table.find((line) => line.startsWith('| 403, the job, after the Claim'));
    expect(ticks(cells(after ?? '')[1])).toStrictEqual(['duplicate_rfq']);
    // The set of the codes: the refusals of the job, the refusals of the hook, the faults of the request, and the answers of the kit.
    const written = new Set<string>([
      ...Object.keys(QUOTE_REFUSAL_STATUS), ...COUNTERPARTY_REFUSALS['bid-desk'], 'check_unavailable', 'bad_wire', 'request_too_large', 'bad_shape', 'bad_context', 'unauthorized', 'not_found', 'busy', 'shutting_down',
    ]);
    expect(new Set(documented.keys())).toStrictEqual(written);
    expect([...documented.entries()].filter(([, statuses]) => statuses.length > 1)).toStrictEqual([['duplicate_rfq', [403, 403]]]);
    // The fixed messages: the kit gives them as the page says.
    expect(errors).toContain(`\`${operatorsText('<code>')}\``);
    expect(errors).toContain('A refusal of status 500 or more gets a fixed message');
    expect(errors).toContain('The 401, the 404, the 409 of a job and a plain 500 have the code and no message: `{"error":"unauthorized"}`, `{"error":"not_found"}`, `{"error":"busy"}` and `{"error":"internal"}`.');
    expect(kit).toContain("return send(401, { error: 'unauthorized' });");
    expect(kit.split("send(409, { error: 'busy' })").length - 1).toBe(2);
    expect(kit).toContain("return send(409, { error: 'busy', message: BUSY_TEXT });");
    expect(kit).toContain("return send(500, { error: 'internal' });");
    expect(errors).toContain(`\`shutting_down\` has the fixed message \`${STOPPING_TEXT}\`, and the 409 \`busy\` of the hook has the fixed message \`${BUSY_TEXT}\`.`);
    expect(errors).toContain('A Bid Desk is the hired side. A job that fails answers with its HTTP status, and the runtime turns the error into the answer that the buyer reads.');
    expect(errors).toContain(`\`inference_failed\` (the model hire failed, or it did not start because less than ${HIRE_MIN_MS / 1000} s were left for it)`);
  });

  test('each refusal that the job writes is in the table with its status, with its fixed text, and a refused job books no quote', async () => {
    type Setup = (rig: Rig) => AbortSignal | undefined;
    const cases: ReadonlyArray<readonly [code: string, setup: Setup]> = [
      ['precheck_missing', (rig) => { rig.entry = null; return undefined; }],
      ['duplicate_rfq', (rig) => { rig.hasAnswer = true; return undefined; }],
      ['credential_failed', (rig) => { rig.issued = gatewayFailure('gateway.unavailable', 503); return undefined; }],
      ['inference_failed', (rig) => { rig.decision = failureOf('inference_failed'); return undefined; }],
      ['model_output_invalid', (rig) => { rig.decision = failureOf('model_output_invalid'); return undefined; }],
      ['store_write_failed', (rig) => { rig.bookError = new Error('the disk is full'); return undefined; }],
      ['internal', (rig) => { rig.hasError = new Error('the book is damaged'); return undefined; }],
      ['deadline', () => AbortSignal.abort()],
    ];
    expect(cases.map(([code]) => code).sort()).toStrictEqual(Object.keys(QUOTE_REFUSAL_STATUS).sort());
    for (const [code, setup] of cases) {
      const rig = makeRig();
      const signal = setup(rig);
      const refusal = await refusalOf(rig.run(signal === undefined ? {} : { signal }));
      expect(refusal.code, code).toBe(code);
      expect(documented.get(code), code).toContain(refusal.status);
      expect(refusal.status, code).toBe(ERROR_STATUS[code as keyof typeof ERROR_STATUS]);
      expect(refusal.status, code).toBe(QUOTE_REFUSAL_STATUS[code as keyof typeof QUOTE_REFUSAL_STATUS]);
      expect(rig.booked, code).toHaveLength(0);
    }
    expect(errors).toContain('The messages of `duplicate_rfq` and `deadline` are fixed texts that hold no value of the request.');
    expect(QUOTE_TEXT.duplicate_rfq).not.toContain('run1-rfq-1');
    // The twin of the deadline rule: with 30 s left before deliver_by the job gives the quote, with one millisecond less it ends deadline and records nothing.
    expect((await makeRig({ deliverInMs: 30_000 }).run()).outcome).toBe('done');
    const late = makeRig({ deliverInMs: 29_999 });
    expect((await refusalOf(late.run())).code).toBe('deadline');
    expectNothingRecorded(late);
    expect(textOf('../src/job/quote.ts')).toContain('const RUNTIME_MARGIN_MS = 30_000;');
  });

  test('a running service answers the statuses that the HTTP layer writes: the faults of the request, the refusal of the hook, the busy slot, and the job with no record', async () => {
    const world = makeWorld();
    const seen = (reply: Reply): [number, string | undefined] => [reply.status, reply.json?.error];
    await serve(world, async (api) => {
      const headers = headersOf(world.context);
      expect(seen(await api.request('POST', '/', { body: 'not json', headers }))).toStrictEqual([400, 'bad_wire']);
      expect(seen(await api.job({ schema: RFQ_SCHEMA }))).toStrictEqual([400, 'bad_shape']);
      expect(seen(await api.precheck({ schema: RFQ_SCHEMA }))).toStrictEqual([400, 'bad_shape']);
      expect(seen(await api.request('POST', '/', { body: wire(world.message) }))).toStrictEqual([400, 'bad_context']);
      expect(seen(await api.request('POST', '/precheck', { body: wire(world.message) }))).toStrictEqual([400, 'bad_context']);
      const missing = await api.job();
      expect([missing.status, missing.json]).toStrictEqual([500, { error: 'precheck_missing', message: operatorsText('precheck_missing') }]);
    });
    // A body over the limit is `request_too_large`, with the status of the table.
    let wireError: WireError | undefined;
    try {
      parseWire('x'.repeat(MAX_BODY + 1));
    } catch (error) {
      wireError = error as WireError;
    }
    expect([wireError?.code, wireError?.status]).toStrictEqual(['request_too_large', ERROR_STATUS.request_too_large]);
    const suspended = makeWorld();
    suspended.gateway.setStatus(suspended.sender, 'suspended');
    await serve(suspended, async (api) => {
      const refused = await api.precheck();
      expect(seen(refused)).toStrictEqual([403, 'sender_not_active']);
      expect(typeof refused.json?.message).toBe('string');
    });
    const busy = makeWorld();
    await serve(busy, async (api) => {
      expect((await api.precheck()).json).toStrictEqual({ go: true, reserved_ms: RESERVATION_MS });
      const other = { ...busy.context, escrowRef: `${'aa'.repeat(32)}#0` };
      const hook = await api.precheck(undefined, other);
      expect([hook.status, hook.json]).toStrictEqual([409, { error: 'busy', message: BUSY_TEXT }]);
      const job = await api.job(undefined, other);
      expect([job.status, job.text]).toStrictEqual([409, '{"error":"busy"}']);
    });
  });
});

describe('agents/bid-desk/README.md: the times, the state and the stop', () => {
  test('the Times table gives the numbers of the code', () => {
    const margin = Number(/const RUNTIME_MARGIN_MS = ([\d_]+);/.exec(textOf('../src/job/quote.ts'))?.[1]?.replaceAll('_', ''));
    const expected: ReadonlyArray<readonly [string, string]> = [
      ['Deadline of a job', `${JOB_DEADLINE_MS} ms`],
      ['Timeout of the runtime for a job', `${JOB_DEADLINE_MS + 60_000} ms`],
      ['Window of the advert', `${MIN_PROCESSING_WINDOW_MS} ms to ${MAX_PROCESSING_WINDOW_MS} ms`],
      ['Call for the credential', `${CALL_TIMEOUT_MS} ms`],
      ['Read of the hook', `${CHECKS_READ_BUDGET_DEFAULT_MS} ms, from ${CHECKS_READ_BUDGET_MIN_MS} ms to ${CHECKS_READ_BUDGET_MAX_MS} ms`],
      ['Wait of the runtime for the hook', `${RUNTIME_PRECHECK_WAIT_MS} ms`],
      ['Reservation of the job slot', `${RESERVATION_MS} ms`],
      ['Record of the checks', `${PASSED_CHECKS_TTL_MS} ms`],
      ['Least time left before delivery', `${margin} ms`],
      ['Interim line', `${HEARTBEAT_MS} ms`],
      ['Pass of the janitor', `${JANITOR_INTERVAL_MS} ms`],
      ['Wait of a stop', `${SHUTDOWN_WAIT_MS} ms`],
    ];
    expect(wordRows('Times', 'Time').map(([time, value]) => [time, value])).toStrictEqual(expected.map(([time, value]) => [time, value]));
    expect([JOB_DEADLINE_MS, CALL_TIMEOUT_MS, margin]).toStrictEqual([300_000, 20_000, 30_000]);
    // The deadline of a job, the timeout of the runtime and the window of the advert nest: 60 s and then 120 s.
    expect(JOB_DEADLINE_MS + 60_000 + 120_000).toBe(MIN_PROCESSING_WINDOW_MS);
    expect(section('Times')).toContain(`A pass that is still in flight at a stop is abandoned after ${JANITOR_STOP_WAIT_MS / 1000} s`);
    expect(JANITOR_STOP_WAIT_MS).toBe(30_000);
    // The model hire has the deadline of 300000 ms after the arrival of the job, or the time that the rest of the job needs before deliver_by, and the call for the credential has its own timeout.
    expect(textOf('../src/serve/wiring.ts')).toContain('deadlineMs: Math.min(arrivedAt + JOB_DEADLINE_MS, context.deliverByMs - RUNTIME_MARGIN_MS - CALL_TIMEOUT_MS)');
    expect(section('Times')).toContain(`the hire ends ${JOB_DEADLINE_MS} ms after the request arrives, or ${(RUNTIME_MARGIN_MS + CALL_TIMEOUT_MS) / 1000} s before \`deliver_by\` when that is earlier`);
    expect(section('Times')).toContain(`A hire does not start with less than ${HIRE_MIN_MS / 1000} s left for it`);
    expect(textOf('../src/serve/wiring.ts')).toContain('timeoutMs: CALL_TIMEOUT_MS');
    expect(textOf('../src/serve/wiring.ts')).toContain('timeoutMs: config.checksBudgetMs');
  });

  test('State files gives the limit of the book, the files that the code names, and the numbers of the janitor', () => {
    const state = section('State files');
    expect(state).toContain(`It holds at most ${RFQ_BOOK_LIMIT} entries and never drops one`);
    expect(state).toContain(`A book that holds ${RFQ_BOOK_LIMIT} entries cannot take a new entry. For a request that the book does not hold, the hook answers 503 \`check_unavailable\` and the escrow stays open.`);
    expect(state).toContain(`Every ${JANITOR_INTERVAL_MS / 1000} s it looks at the stranded file`);
    expect(state).toContain('A sender cannot get a second quote for one `rfq_id`');
    const wiring = textOf('../src/serve/wiring.ts');
    expect(wiring).toContain("join(config.stateDir, 'rfq-book.json')");
    expect(wiring).toContain("join(config.stateDir, 'keys', service.pkh)");
    expect(textOf('../../../packages/hire-kit/src/janitor.ts')).toContain("STRANDED_FILE = 'stranded.json'");
    for (const path of ['`rfq-book.json`', '`keys/<key hash>/stranded.json`']) expect(rows('State files').map((line) => cells(line)[0])).toContain(path);
    expect(state).toContain('The log carries job outcomes, counts and codes, never a request, a quote, a credential or a key.');
    expect(served(config.manifest.text).behaviour.data_handling).toContain('The log carries job outcomes, counts and codes, never a request, a quote, a credential or a key.');
  });

  test('Stopping states the numbers of the stop, and the exit codes are the ones that the kit exits with', () => {
    const stopping = section('Stopping');
    expect(stopping).toContain(`waits up to ${SHUTDOWN_WAIT_MS / 1000} s for the job that is running to end`);
    expect(stopping).toContain(`A pass of the janitor that is still in flight after ${JANITOR_STOP_WAIT_MS / 1000} s is abandoned, with a log line.`);
    expect(stopping).toContain(`must be ${(SHUTDOWN_WAIT_MS + 30_000) / 1000} s: the ${SHUTDOWN_WAIT_MS / 1000} s of the wait and 30 s more`);
    expect(stopping).toContain('the service exits 0.');
    expect(stopping).toContain(`A job still running after ${SHUTDOWN_WAIT_MS / 1000} s is abandoned`);
    expect(stopping).toContain('the service exits 1.');
    expect(textOf('../../../packages/service-kit/src/lifecycle.ts')).toContain("exit(outcome === 'abandoned' ? 1 : 0)");
  });
});

describe('agents/bid-desk/README.md: Run it and Deploy', () => {
  const run = section('Run it');
  type Settings = Readonly<Record<string, string | undefined>>;
  const OTHER = keyOf('bid desk readme test: another key');
  /** One refusal of the start that Run it names: what it is, the settings that cause it, its message, and settings of the same names that the start accepts. */
  const refusals: ReadonlyArray<readonly [what: string, over: Settings, error: RegExp, good: Settings]> = [
    ['a required setting that is not set', { OPERATOR_CONTACT: undefined }, /^environment variable OPERATOR_CONTACT is required/, { OPERATOR_CONTACT: 'ops@example.test' }],
    ['a setting that is not well formed', { PORT: 'abc' }, /^environment variable PORT must be a non-negative integer/, { PORT: '9106' }],
    ['SUPPLIER_PUB_KEY_HEX that is not the public key of SUPPLIER_PKH', { SUPPLIER_PUB_KEY_HEX: OTHER.pubKeyHex }, /^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/, { SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex }],
    [
      'BID_DESK_SERVICE_PKH that is not the key hash of the service key', { BID_DESK_SERVICE_PKH: SUPPLIER.pkh },
      /^environment variable BID_DESK_SERVICE_PKH .* is not the key hash of the key in BID_DESK_SERVICE_PRIV_KEY_HEX/, { BID_DESK_SERVICE_PKH: SERVICE.pkh },
    ],
    ['the service key that is the supplier key', { BID_DESK_SERVICE_PRIV_KEY_HEX: SUPPLIER.privateKeyHex }, /^environment variable BID_DESK_SERVICE_PRIV_KEY_HEX holds the supplier key/, { BID_DESK_SERVICE_PRIV_KEY_HEX: SERVICE.privateKeyHex }],
    [
      'IDENTITY_POLICY_ID that is not the identity policy of the identity values', { IDENTITY_POLICY_ID: 'ab'.repeat(28) },
      /^environment variable IDENTITY_POLICY_ID is not the identity policy that VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED give/, { IDENTITY_POLICY_ID: FULL_ENV.IDENTITY_POLICY_ID },
    ],
    ['FAULT_MODE with a value that the Bid Desk does not list', { FAULT_MODE: 'confirm_wrong_lot' }, /^environment variable FAULT_MODE must be empty or "quote_off_price_list"/, { FAULT_MODE: 'quote_off_price_list' }],
    ['BID_DESK_INSTANCE that is not alfa, bravo or charlie', { BID_DESK_INSTANCE: 'delta' }, /^environment variable BID_DESK_INSTANCE must be alfa, bravo or charlie/, { BID_DESK_INSTANCE: 'bravo' }],
    ['BID_DESK_ORGANISATION that is not a domain name in lower case', { BID_DESK_ORGANISATION: 'Alfa' }, /^environment variable BID_DESK_ORGANISATION must be a domain name in lower case/, { BID_DESK_ORGANISATION: 'alfa.example.test' }],
    ['BID_DESK_PUBLIC_ORIGIN that is not an https origin', { BID_DESK_PUBLIC_ORIGIN: 'http://bids.example.test' }, /^environment variable BID_DESK_PUBLIC_ORIGIN must be an https origin/, { BID_DESK_PUBLIC_ORIGIN: 'https://bids.example.test' }],
    ['VECTOR_OGMIOS_URL that is an http address', { VECTOR_OGMIOS_URL: 'http://node.example.test' }, /^environment variable VECTOR_OGMIOS_URL must be an https address/, { VECTOR_OGMIOS_URL: 'https://node.example.test' }],
    [
      'CHECKS_READ_BUDGET_MS outside its range', { CHECKS_READ_BUDGET_MS: String(CHECKS_READ_BUDGET_MAX_MS + 1) },
      new RegExp(`^environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from ${CHECKS_READ_BUDGET_MIN_MS} to ${CHECKS_READ_BUDGET_MAX_MS}`), { CHECKS_READ_BUDGET_MS: String(CHECKS_READ_BUDGET_MAX_MS) },
    ],
    ['ADVERT_MAX_PROCESSING_MS below 8 min', { ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS - 1) }, /^environment variable ADVERT_MAX_PROCESSING_MS must be at least 480000/, { ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS) }],
    ['ADVERT_MAX_PROCESSING_MS above 24 h', { ADVERT_MAX_PROCESSING_MS: String(MAX_PROCESSING_WINDOW_MS + 1) }, /^environment variable ADVERT_MAX_PROCESSING_MS must be at most 86400000/, { ADVERT_MAX_PROCESSING_MS: String(MAX_PROCESSING_WINDOW_MS) }],
  ];

  test('it names the command, the two secrets that the operator makes, and the refusals of the start, and each refusal is one that the start makes', async () => {
    expect(run).toContain('The service needs Node 22 or later');
    expect(JSON.parse(textOf('../../../package.json')).engines.node).toBe('>=22');
    expect(run).toContain('export SERVICE_AUTH_HEADER="Bearer $(openssl rand -hex 32)"');
    expect(run).toContain('export BID_DESK_SERVICE_PRIV_KEY_HEX="$(cat /path/to/service-key.hex)"');
    expect(run).toContain(`BID_DESK_STATE_DIR=/tmp/bid-desk-state PORT=${PORT_DEFAULT} pnpm start`);
    const scripts = JSON.parse(textOf('../package.json')).scripts as Record<string, string>;
    expect([scripts.start, scripts.template, scripts.test]).toStrictEqual(['tsx src/index.ts', 'node --import tsx scripts/render-template.mjs', 'vitest run']);
    expect(run).toContain('`pnpm --filter @vsa/bid-desk test`');
    expect(MIN_PROCESSING_WINDOW_MS / 60_000).toBe(8);
    for (const [what, over, error, good] of refusals) {
      expect(message(() => loadConfig(full(over))), what).toMatch(error);
      expect(() => loadConfig(full(good)), `the twin of ${what}`).not.toThrow();
    }
    expect(run).toContain('when a required setting of the table is not set, when a setting is not well formed, when `SUPPLIER_PUB_KEY_HEX` is not the public key of `SUPPLIER_PKH`,');
    expect(run).toContain('when `BID_DESK_SERVICE_PKH` is not the key hash of the service key, when the service key is the supplier key,');
    expect(run).toContain('when `FAULT_MODE` names a value that the Bid Desk does not list,');
    expect(run).toContain('when `IDENTITY_POLICY_ID` is not the identity policy that `VECTOR_IDENTITY_LEGACY_ROOT` and `VECTOR_IDENTITY_CONFIG_SEED` give,');
    expect(run).toContain('when `BID_DESK_INSTANCE` is not `alfa`, `bravo` or `charlie`, when `BID_DESK_ORGANISATION` is not a domain name in lower case, when `BID_DESK_PUBLIC_ORIGIN` is not an https origin,');
    expect(run).toContain('when `VECTOR_OGMIOS_URL` is an http address,');
    expect(run).toContain(`when \`CHECKS_READ_BUDGET_MS\` is not from ${CHECKS_READ_BUDGET_MIN_MS} to ${CHECKS_READ_BUDGET_MAX_MS},`);
    expect(run).toContain('when `ADVERT_MAX_PROCESSING_MS` is below 8 min or above 24 h, or when it cannot write to its state directory.');
    expect(MAX_PROCESSING_WINDOW_MS / 3_600_000).toBe(24);
    await expect(startService(full({ BID_DESK_STATE_DIR: join(tempDir(), 'missing', 'state') }))).rejects.toThrow(/^environment variable BID_DESK_STATE_DIR names /);
    expect(run).toContain('The start makes no call of its own to a third party.');
  });

  test('it says where the secrets are looked for, as the start does it, and shows no secret', () => {
    expect(TOKEN_SEARCH_MIN).toBe(16);
    expect(run).toContain(`when it has ${TOKEN_SEARCH_MIN} characters or more`);
    expect(run).toContain('in its raw and its bech32 form, in any case, and inside a longer value too');
    for (const [name, secret] of [['BID_DESK_SERVICE_PRIV_KEY_HEX', SERVICE.privateKeyHex], ['SERVICE_AUTH_HEADER', FULL_ENV.SERVICE_AUTH_HEADER]] as const) {
      const text = message(() => loadConfig(full({ AGENT_DID: `did:${secret}` })));
      expect(text, name).toMatch(/\bAGENT_DID\b/);
      expect(text.toLowerCase().includes(secret.toLowerCase()), name).toBe(false);
    }
    expect(readme).not.toMatch(/SERVICE_AUTH_HEADER=["']?Bearer [0-9a-f]{8}/);
    expect(readme).not.toMatch(/PRIV_KEY_HEX=["']?[0-9a-f]{16}/);
  });

  test('the image paragraph gives the build command, the port and the volume that the Dockerfile has, and the manifest hash command exists', () => {
    const dockerfile = textOf('../Dockerfile');
    expect(run).toContain('`docker build -f agents/bid-desk/Dockerfile -t vsa/bid-desk:dev .`');
    expect(run).toContain(`listens on ${PORT_DEFAULT}`);
    expect(dockerfile).toContain(`EXPOSE ${PORT_DEFAULT}`);
    expect(run).toContain('`/data` is a volume that `node` owns');
    expect(dockerfile).toContain(`VOLUME ${STATE_DIR_DEFAULT}`);
    expect(run).toContain('builds the service image on `node:22-bookworm-slim`');
    expect(dockerfile).toContain('FROM node:22-bookworm-slim AS builder');
    expect(run).toContain('its manifest, its `tsconfig.json`, its `src` folder and its `price-lists` folder');
    expect(dockerfile).toContain('COPY agents/bid-desk/price-lists ./agents/bid-desk/price-lists');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(existsSync(new URL('../../../scripts/manifest-hash.mjs', import.meta.url))).toBe(true);
    expect(run).toContain('`node scripts/manifest-hash.mjs <https origin>`');
  });

  test('Deploy names the three compose files, the env example and the runbook of the pack, says that the host builds no image, and names the image by its digest', () => {
    const deploy = section('Deploy');
    for (const instance of INSTANCES) expect(deploy, instance).toContain(`\`deploy/server/docker-compose.bid-desk-${instance}.yml\``);
    expect(deploy).toContain('run one Bid Desk each, with its runtime, from this one image.');
    expect(deploy).toContain('The env example is `deploy/server/.env.bid-desk.example`, and the steps are in `deploy/server/RUNBOOK-bid-desk.md`.');
    expect(deploy).toContain('The host builds no image: each compose file names the image by its digest.');
    expect(deploy.split('\n').filter((line) => line !== '')).toHaveLength(3);
  });
});
