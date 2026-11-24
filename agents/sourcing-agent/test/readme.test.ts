// agents/sourcing-agent/test/readme.test.ts
// The README names every setting that the service reads, every code that it answers with, the members of its request and of its results, and the numbers of its routes, its jobs, its state and its stop. These
// tests keep the page and the code from parting: a setting that the code reads and the table does not name fails, so does a name in the table that no code reads, a code with the wrong status, a member that the
// schema does not list, and a number that is not the code's. A few tests run the real server and the real start over the scripted ports of the package, to hold the sentences that say what they do. No test here
// uses the network.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { READ_BUDGET_MS, VAULT_PAYER_IDENTITY_SETTINGS } from '@vsa/buyer-core';
import { RUNTIME_BODY_LIMIT_BYTES } from '@vsa/hire-kit';
import { BUSY_TEXT, CONTEXT_HEADERS, HEARTBEAT_MS, JobSlot, MAX_BODY, RESERVATION_MS, SHUTDOWN_WAIT_MS, STOPPING_TEXT, TOKEN_SEARCH_MIN, operatorsText } from '@vsa/service-kit';
import { BID_CAPABILITIES, MAX_ITEM_QUANTITY, MAX_RFQ_ITEMS, SOURCING_CLAIM, WEIGHT_NAMES } from '@vsa/usecase-kit/bids';
import { COSIGN_STATUS, DEFAULT_LIMITS } from '@vsa/usecase-kit/cosign';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import { ERROR_STATUS, MAX_REQUEST_BYTES, checkRequestSize, refusedExit, refused } from '@vsa/usecase-kit/protocol';
import { EXECUTE_DEADLINE_MS, EXECUTE_FAILURES } from '../src/execute/index.ts';
import { MAX_INVITED, ACCEPT_QUOTE_DECISION, RANKING_DECISION, SCORE_DECISION, SHORTLIST_DECISION } from '../src/model/index.ts';
import { PROPOSE_DEADLINE_MS, PROPOSE_FAILURES, RANKING_RESERVE_MS, SCORING_RESERVE_MS, TENANT_RULE } from '../src/propose/index.ts';
import { QUOTE_CODES, QUOTE_HIRE_RESERVE_MS } from '../src/quotes/index.ts';
import { SCORER_JOB_TIMEOUT_MS, SCORER_NEED_MS, SCORERS_NEED_MS, SCORING_FAILURES, SUB_DELEGATION_VALID_MS } from '../src/scoring/index.ts';
import { reversedOf, scoreFaultOf } from '../src/scoring/fault.ts';
import { BIDDER_FETCH_TIMEOUT_MS, BIDDER_READ_BUDGET_MS, FACT_READ_TIMEOUT_MS, MAX_CANDIDATES } from '../src/bidders/index.ts';
import { DESCRIPTION, ID_CHARS, REQUEST_SCHEMA, TENANT_CHARS } from '../src/serve/manifest.ts';
import { RequestRefusal, parseJob } from '../src/serve/server.ts';
import {
  BUYER_BOND_LOVELACE, GATEWAY_DEFAULT, HOST_DEFAULT, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, PRICE_DEFAULT_LOVELACE, STATE_DIR_DEFAULT, SUPPLIER_BOND_LOVELACE,
} from '../src/serve/settings.ts';
import { JANITOR_INTERVAL_MS, JANITOR_STOP_WAIT_MS, SETTINGS, loadConfig } from '../src/serve/start.ts';
import { CATALOG_TIMEOUT_MS, LEDGER_BUDGET_MS, STATE_FILES, TIP_TIMEOUT_MS } from '../src/serve/wiring.ts';
import { world as executeWorld } from './execute/world.ts';
import { readGolden, REQUEST as PROPOSE_REQUEST, RFQ, WEIGHTS, world as proposeWorld } from './propose/support.ts';
import { closeAll, gate, hangingCall, post, serve, start, until } from './serve/serve.ts';
import { KEY_VARIABLES, PKH_VARIABLES, PRINCIPAL, SCORER_DIDS, SUPPLIER, TOKEN, cleanDirs, completeEnv, messageOf, module1ManifestText, rawKey, tempDir, KEY_NUMBERS } from './serve/support.ts';

afterEach(async () => {
  cleanDirs();
  await closeAll();
});

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
// The ledger's native unit is named once in the repository, in docs/HIRE.md. Spelled in two parts, so that a search for the name finds only the guide.
const UNIT_NAME = new RegExp('AP' + '3X', 'i');
const SECTIONS = ['What it is', 'Routes', 'The request', 'The result', 'Settings', 'Keys', 'The fault switch', 'Errors', 'Reasons', 'Times', 'State files', 'Stopping', 'Run it', 'Deploy'];
const sourceDir = new URL('../src/', import.meta.url);
const sources = (readdirSync(sourceDir, { recursive: true }) as string[]).filter((file) => String(file).endsWith('.ts')).map((file) => ({ file: String(file), text: readFileSync(new URL(String(file), sourceDir), 'utf8') }));
const textOf = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const section = (heading: string): string => (readme.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const ticks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
const cells = (line: string): string[] => line.split('|').slice(1, -1).map((part) => part.trim());
/** The rows of the tables of a section whose first cell starts with a code span. */
const rows = (heading: string, text: string = section(heading)): string[][] => text.split('\n').filter((line) => /^\| `/.test(line)).map(cells);
/** The rows of the table of a section whose first cell is a name in words: each row but the header and the line under it. */
const wordRows = (text: string, header: string): string[][] => text.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith(`| ${header} |`) && !line.startsWith('| ---')).map(cells);
/** The row of the Settings table that names a variable, and one cell of it (1 is the use, 2 is the default). */
const settingsRow = (name: string): string[] => rows('Settings').find(([names]) => ticks(names).includes(name)) ?? [];
const cell = (name: string, at: 1 | 2): string => settingsRow(name)[at] ?? '';
const template = JSON.parse(textOf('../agent.json.template')) as { version: string; status: { chip: string; since: string }; interface: { routes: Record<string, string> }; behaviour: { claim: { statements: Array<{ text: string }> }; fault_modes: string[] } };
const config = loadConfig(completeEnv());
const sha256 = (data: string): string => createHash('sha256').update(data).digest('hex');

/** The names that the code reads from the environment itself: `env.NAME`, `process.env.NAME`, and the names given to envInt and requiredEnv. */
function namesRead(): string[] {
  const found = new Set<string>();
  for (const { text } of sources) {
    for (const match of text.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)\b/g)) found.add(match[1]);
    for (const match of text.matchAll(/\b(?:envInt|requiredEnv)\(\s*'([A-Z][A-Z0-9_]*)'/g)) found.add(match[1]);
  }
  return [...found].sort();
}
/** The names that the code reads through a table or a helper, so that no `env.NAME` stands in a source: the three scorer DIDs, the six key hashes of the scorers and the three limits of the co-sign route. */
const TABLE_READ = [
  'SCORER_1_DID', 'SCORER_2_DID', 'SCORER_3_DID', 'SCORER_1_AUTH_PKH', 'SCORER_1_DELEGATION_PKH', 'SCORER_2_AUTH_PKH', 'SCORER_2_DELEGATION_PKH', 'SCORER_3_AUTH_PKH', 'SCORER_3_DELEGATION_PKH',
  'COSIGN_MAX_CONCURRENT', 'COSIGN_MAX_FUTURE_MS', 'COSIGN_LEDGER_TIMEOUT_MS',
];

describe('agents/sourcing-agent/README.md: the page', () => {
  test('the third line is the description of the manifest and the capability, and the sections are the sections of the design, in their order', () => {
    const lines = readme.split('\n');
    expect(lines[0]).toBe('# Sourcing Agent');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe(`${DESCRIPTION} Capability \`${BID_CAPABILITIES.evaluate}\`.`);
    expect(BID_CAPABILITIES.evaluate).toBe('supplychain.rfq.evaluate.v1');
    expect(readme).toContain('use case 3 (supplier bid evaluation)');
    expect([...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1])).toStrictEqual(SECTIONS);
  });

  test('the page holds no dash, no unit name, no run of 56 hex characters or more, and none of the keys of the tests', () => {
    expect(readme).not.toMatch(/[\u{2013}\u{2014}]/u);
    expect(readme).not.toMatch(UNIT_NAME);
    expect(readme).not.toMatch(/[0-9a-f]{56}/i);
    for (const number of Object.values(KEY_NUMBERS)) expect(readme).not.toContain(rawKey(number));
  });
});

describe('agents/sourcing-agent/README.md: what it is', () => {
  const intro = section('What it is');

  test('names the steps of propose in their order with the numbers of the code, and the four decisions in the order that the result gives them', async () => {
    expect(intro).toContain('The model chooses the bidders to invite, at most 3.');
    expect(MAX_INVITED).toBe(3);
    expect(intro).toContain('It reads the candidates: the Bid Desks that the indexer lists and the chain shows, at most 8.');
    expect(MAX_CANDIDATES).toBe(8);
    expect(intro).toContain('The agent hires the invited bidders one after the other');
    expect(intro).toContain('The three scorers are used one for each accepted quote, in the order of the quotes.');
    expect(SCORER_DIDS).toHaveLength(3);
    expect([SHORTLIST_DECISION, ACCEPT_QUOTE_DECISION, SCORE_DECISION, RANKING_DECISION].map((decision) => decision.name)).toStrictEqual(['shortlist', 'accept_quote', 'score', 'ranking']);
    const w = proposeWorld();
    const { origin } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.ms });
    const answered = await post(origin, PROPOSE_REQUEST);
    expect((answered.body.decisions as Array<{ name: string }>).map((decision) => decision.name)).toStrictEqual(['shortlist', 'accept_quote', 'accept_quote', 'accept_quote', 'score', 'score', 'score', 'ranking']);
    expect(w.trace.indexOf('shortlist')).toBeLessThan(w.trace.indexOf('quotes'));
    expect(w.trace.indexOf('quotes')).toBeLessThan(w.trace.indexOf('scoring'));
    expect(w.trace.indexOf('scoring')).toBeLessThan(w.trace.indexOf('rank'));
    expect(intro).toContain('The job answers with the ranking, its salt and its digest. It writes nothing to the sourcing record.');
    expect(answered.body.document).toBeTruthy();
  });

  test('execute makes one token and one call, no model call, no hire and no payment, and it never repeats the call', async () => {
    expect(intro).toContain('It makes no model call, no hire and no payment.');
    expect(intro).toContain('asks the identity gateway for one token for the route `sourcing.rankings`, and makes one call to the sourcing record');
    const w = executeWorld();
    const { origin } = await serve({ executeDeps: () => w.deps, clock: () => w.gateway.now() });
    const answered = await post(origin, w.request());
    expect([answered.status, answered.body.outcome, answered.body.decisions, answered.body.handoff]).toStrictEqual([200, 'completed', [], null]);
    expect(w.tokens).toHaveLength(1);
    expect(w.record.written).toHaveLength(1);
    expect(intro).toContain('The call to the sourcing record is made one time. The service never repeats it, also after a failure, because a failed call can have written the ranking.');
    expect(textOf('../src/execute/execute.ts')).toContain('a call that failed may have written the ranking');
    expect(intro).toContain('The sourcing record has no rule of one ranking for each request.');
    expect(intro).toContain('Read the sourcing record before you send `execute` again.');
  });

  test('the claim is the manifest claim, only an operator command stakes it, and the only dispute call of the service is the challenge of a quote that the model did not accept', () => {
    expect(template.behaviour.claim.statements.map((statement) => statement.text)).toStrictEqual(SOURCING_CLAIM.statements.map((statement) => statement.text));
    expect(SOURCING_CLAIM.statements).toHaveLength(3);
    expect(intro).toContain('The claim of the agent is the three statements in `behaviour.claim` of its manifest. An operator command stakes that claim, and this service never does.');
    expect(sources.filter(({ text }) => /\b(?:stakeRunClaim|withdrawClaim|submitClaim|challengeApproval)\b/.test(text))).toStrictEqual([]);
    expect(sources.filter(({ text }) => /\bchallengeDelivery\b/.test(text)).map(({ file }) => file).sort()).toStrictEqual(['quotes/evidence.ts', 'quotes/ports.ts']);
    expect(intro).toContain('only after a decision of the model that did not accept a quote, and only for a unit price');
    expect(textOf('../src/quotes/evidence.ts')).toContain('the evidence is one line whose unit price is not the listed price');
    expect(textOf('../src/quotes/quotes.ts')).toContain('not_accepted, declined_by_model    a challenge against the open claim of THAT bidder');
  });

  test('the escrow and the vault payment stay locked up to the window of the advert, and the jobs are in memory', () => {
    expect(MIN_PROCESSING_WINDOW_MS).toBe(5_400_000);
    expect(intro).toContain(`stay locked up to the window of the advert, ${MIN_PROCESSING_WINDOW_MS} ms (${MIN_PROCESSING_WINDOW_MS / 60_000} minutes)`);
    expect(template.interface.routes.status).toBe('/status');
    expect(intro).toContain('A restart waits until the runtime says `free` at its `/status` route.');
    expect(intro).toContain('The jobs are in memory, so a restart ends the job that runs.');
    expect(JSON.parse(textOf('../package.json')).name).toBe('@vsa/sourcing-agent');
    expect(intro).toContain('`pnpm --filter @vsa/sourcing-agent template`');
    expect(textOf('../package.json')).toContain('"template": "node --import tsx scripts/render-template.mjs"');
    const placeholders = [...new Set([...textOf('../agent.json.template').matchAll(/<([A-Z0-9_]+)>/g)].map((match) => match[1]))].sort();
    expect(placeholders).toHaveLength(8);
    for (const name of placeholders) {
      expect(intro, name).toContain(`\`<${name}>\``);
      expect(SETTINGS as readonly string[], name).toContain(name);
    }
  });
});

describe('agents/sourcing-agent/README.md: the routes', () => {
  const routes = section('Routes');
  const wireOf = (request: unknown): string => JSON.stringify([{ content: JSON.stringify(request), role: 'user' }]);
  const contextOf = (escrow: string): Record<string, string> => ({
    'x-vector-escrow-ref': `${escrow.repeat(32)}#0`, 'x-vector-advert-ref': `${'11'.repeat(32)}#0`, 'x-vector-advert-model': 'sourcing-agent-v1',
    'x-vector-buyer-pkh': PRINCIPAL.keyHash, 'x-vector-payment-lovelace': '3000000', 'x-vector-deliver-by-ms': String(Date.now() + 3_600_000),
  });

  test('the table names the five routes, and a running service answers each as the table says', async () => {
    expect(rows('Routes').map(([route]) => ticks(route)[0])).toStrictEqual(['GET /healthz', 'GET /agent.json', 'POST /', 'POST /precheck', 'POST /cosign/delegate']);
    expect(routes).toContain('| any other route | 404 `{"error":"not_found"}` |');
    const w = proposeWorld();
    const { origin } = await serve({ manifestText: config.manifest.text, proposeDeps: () => w.deps, clock: () => w.clock.ms });
    expect(await (await fetch(`${origin}/healthz`)).json()).toStrictEqual({ ok: true });
    const manifest = await fetch(`${origin}/agent.json`);
    const bytes = await manifest.text();
    expect([manifest.status, bytes, sha256(bytes)]).toStrictEqual([200, config.manifest.text, config.manifest.sha256]);
    for (const path of ['/healthz', '/agent.json']) {
      expect((await fetch(`${origin}${path}?x=1`)).status, path).toBe(200);
      const head = await fetch(`${origin}${path}`, { method: 'HEAD' });
      expect([head.status, await head.text()], path).toStrictEqual([200, '']);
    }
    for (const [method, path] of [['GET', '/other'], ['POST', '/other'], ['GET', '/cosign/delegate'], ['POST', '/?x=1'], ['POST', '/precheck?x=1']] as const) {
      const answer = await fetch(`${origin}${path}`, { method, ...(method === 'POST' ? { body: wireOf(PROPOSE_REQUEST), headers: { authorization: TOKEN } } : {}) });
      expect([answer.status, await answer.text()], `${method} ${path}`).toStrictEqual([404, '{"error":"not_found"}']);
    }
    for (const path of ['/', '/precheck']) {
      const refused = await fetch(`${origin}${path}`, { method: 'POST', body: wireOf(PROPOSE_REQUEST), headers: { ...contextOf('aa'), authorization: 'Bearer nothing' } });
      expect([refused.status, await refused.text()], path).toStrictEqual([401, '{"error":"unauthorized"}']);
    }
    expect(routes).toContain('Without it, 401 `{"error":"unauthorized"}`');
    expect(routes).toContain('The co-sign route takes `POST` only.');
    expect(routes).toContain('before the body is read and before the job slot is looked at');
  });

  test('the body limits, the six headers of the context and the numbers of the slot and of the heartbeat are the code', () => {
    expect(routes).toContain(`The service reads the body up to ${MAX_BODY} bytes. It reads the request JSON up to ${MAX_REQUEST_BYTES} bytes.`);
    expect(checkRequestSize('x'.repeat(MAX_REQUEST_BYTES)).ok).toBe(true);
    expect(checkRequestSize('x'.repeat(MAX_REQUEST_BYTES + 1)).ok).toBe(false);
    expect(JSON.parse(textOf('../agent.json.template')).terms.input_limits.request_bytes).toBe(MAX_REQUEST_BYTES);
    expect(routes).toContain('`terms.input_limits.request_bytes`');
    expect(RUNTIME_BODY_LIMIT_BYTES).toBe(1_048_576);
    expect(routes).toContain(`The limit of ${MAX_REQUEST_BYTES} bytes is safe only below the limit of the runtime, ${RUNTIME_BODY_LIMIT_BYTES} bytes, on the escaped body.`);
    expect(Object.values(CONTEXT_HEADERS)).toHaveLength(6);
    for (const header of Object.values(CONTEXT_HEADERS)) expect(routes, header).toContain(`\`${header}\``);
    expect(routes).toContain(`\`{"go":true,"reserved_ms":${RESERVATION_MS}}\``);
    expect(routes).toContain(`it reserves the slot for the escrow of the call for ${RESERVATION_MS} ms`);
    expect(HEARTBEAT_MS).toBe(60_000);
    expect(routes).toContain(`writes an interim \`102 Processing\` line every ${HEARTBEAT_MS / 1000} s`);
    expect(textOf('../../../packages/service-kit/src/server.ts')).toContain('req.httpVersionMajor === 1 && req.httpVersionMinor >= 1');
  });

  test('POST /precheck has no check of its own: it answers with the state of the slot, and the body and the context are read as for a job', async () => {
    const w = proposeWorld();
    const held = gate();
    const discover = w.script.discover;
    w.script.discover = async () => { await held.pass(); return discover(); };
    const { origin } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.ms });
    const precheck = async (escrow: string, body: unknown = PROPOSE_REQUEST, headers: Record<string, string> = contextOf(escrow)): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fetch(`${origin}/precheck`, { method: 'POST', body: wireOf(body), headers: { authorization: TOKEN, ...headers } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect(routes).toContain('`POST /precheck` has no check of its own.');
    expect(await precheck('aa')).toStrictEqual({ status: 200, body: { go: true, reserved_ms: RESERVATION_MS } });
    expect(await precheck('bb')).toMatchObject({ status: 409, body: { error: 'busy', message: BUSY_TEXT } });
    expect(await post(origin, PROPOSE_REQUEST)).toStrictEqual({ status: 409, body: { error: 'busy' } });
    const running = post(origin, PROPOSE_REQUEST, TOKEN, undefined, contextOf('aa'));
    await until(() => held.reached());
    for (const escrow of ['aa', 'bb']) expect(await precheck(escrow), escrow).toMatchObject({ status: 409, body: { error: 'busy' } });
    held.open();
    expect((await running).status).toBe(200);
    expect(await precheck('bb')).toStrictEqual({ status: 200, body: { go: true, reserved_ms: RESERVATION_MS } });
    // The body is parsed before the slot is looked at, so a request that breaks a rule of the intake gets no go, and a call with no context headers is refused.
    expect(await precheck('cc', { ...PROPOSE_REQUEST, extra: 1 })).toMatchObject({ status: 400, body: { error: 'bad_shape' } });
    expect(await precheck('dd', PROPOSE_REQUEST, {})).toMatchObject({ status: 400, body: { error: 'bad_context' } });
    expect(await precheck('ee', PROPOSE_REQUEST, { 'x-vector-escrow-ref': contextOf('ee')['x-vector-escrow-ref'] })).toMatchObject({ status: 400, body: { error: 'bad_context' } });
    expect(routes).toContain('`POST /precheck` needs all six. A call with none of them, with some of them, or with a bad one gets 400 `bad_context`.');
    expect(routes).toContain('`POST /` takes a call with none of the six; a call with some of them, or with a bad one, gets 400 `bad_context`.');
    expect(routes).toContain('a request that breaks a rule of the intake gets its 400 before the slot is looked at');
    // POST / takes a call with no context, and a call with a partial context is refused.
    const partial = await post(origin, PROPOSE_REQUEST, TOKEN, undefined, { 'x-vector-escrow-ref': contextOf('ff')['x-vector-escrow-ref'] });
    expect([partial.status, partial.body.error]).toStrictEqual([400, 'bad_context']);
    expect((await post(origin, PROPOSE_REQUEST, TOKEN, undefined, contextOf('bb'))).status).toBe(200);
  });

  test('one job runs at a time, and the busy answers and the reservation are the ones of the slot', () => {
    expect(routes).toContain('One job runs at a time. A job that arrives while a job runs, or while the slot is reserved for another escrow, gets 409 `{"error":"busy"}`, and nothing starts.');
    expect(routes).toContain('`POST /precheck` answers 409 `busy` with a message while a job runs, whatever its escrow, and while the slot is reserved for another escrow.');
    expect(routes).toContain('A new go for the escrow that holds the reservation reserves the slot again. The job of that escrow takes the reservation.');
    const slot = new JobSlot();
    expect(slot.take('escrow-a', 1_000)).toBe('taken');
    expect([slot.canTake('escrow-a', 1_000), slot.canTake('escrow-b', 1_000)]).toStrictEqual(['busy', 'busy']);
    slot.release();
    expect(slot.reserve('escrow-a', 1_000)).toBe('reserved');
    expect([slot.canTake('escrow-a', 2_000), slot.canTake('escrow-b', 2_000)]).toStrictEqual(['free', 'held']);
    expect(slot.reserve('escrow-a', 2_000)).toBe('reserved');
    expect(slot.take('escrow-b', 2_000)).toBe('held');
    expect(routes).toContain('A service that stops answers 503 `shutting_down` to both routes.');
  });

  test('a caller that hangs up before the first Pay gets no Pay, and what the page says of the signal is what the job reads', async () => {
    expect(routes).toContain('A job whose caller hangs up is stopped. `propose` reads the signal before each step');
    expect(routes).toContain('`execute` reads the signal before the token and before the call, and never gives it to the call: a call that was sent runs to its end.');
    const w = proposeWorld();
    const held = gate();
    const discover = w.script.discover;
    w.script.discover = async () => { await held.pass(); return discover(); };
    const { origin, log } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.ms });
    const call = hangingCall(origin, PROPOSE_REQUEST);
    await until(() => held.reached());
    call.hangUp();
    await until(() => log.some((line) => line.startsWith('job abandoned by the caller')));
    held.open();
    await until(() => log.some((line) => line.startsWith('propose done in ')));
    expect(log.find((line) => line.startsWith('propose done in '))).toMatch(/: outcome failed, reason aborted, exit Failed, decisions 0, bidders \d+, quotes 0$/);
    expect(w.calls.quotes).toHaveLength(0);
    expect(routes).toContain('The log has one line for each job');
  });
});

describe('agents/sourcing-agent/README.md: the request', () => {
  const request = section('The request');
  /** What the intake says of a request: `accepted`, or the code of its refusal. */
  const verdict = (value: unknown): string => {
    try {
      parseJob(JSON.stringify(value));
      return 'accepted';
    } catch (error) {
      return error instanceof RequestRefusal ? error.code : 'not a refusal of the request';
    }
  };
  interface Node { readonly properties?: Readonly<Record<string, Node>>; readonly items?: Node; readonly oneOf?: readonly Node[] }
  /** The names of the members of a schema, each parent before its members: `rfq`, `rfq.rfq_id`, `rfq.items`, `rfq.items[].sku`. */
  const pathsOf = (node: Node, prefix = ''): string[] => [
    ...Object.entries(node.properties ?? {}).flatMap(([name, child]) => {
      const path = prefix === '' ? name : `${prefix}.${name}`;
      return [path, ...pathsOf(child, path)];
    }),
    ...(node.items === undefined ? [] : pathsOf(node.items, `${prefix}[]`)),
    ...(node.oneOf ?? []).flatMap((option) => pathsOf(option, prefix)),
  ];
  const [proposeText, executeText] = request.split('`execute` has these members:');
  const namesIn = (text: string): string[] => rows('The request', text).flatMap(([names]) => ticks(names));

  test('the tables name the members of the schema of the manifest, in its order', () => {
    const [proposeSchema, executeSchema] = REQUEST_SCHEMA.oneOf as unknown as Node[];
    expect(namesIn(proposeText)).toStrictEqual(pathsOf(proposeSchema));
    expect(namesIn(executeText)).toStrictEqual(pathsOf(executeSchema));
    expect(namesIn(proposeText).slice(0, 5)).toStrictEqual(['op', 'authority', 'authority.principal_did', 'authority.delegation', 'tenant']);
    expect(WEIGHT_NAMES).toStrictEqual(['price', 'lead_time', 'reliability', 'compliance']);
    expect(request).toContain('A request that breaks a rule is refused with 400 `bad_shape` before any job runs, on `POST /` and on `POST /precheck`.');
  });

  test('the rules of the tables are the rules of the intake: the limit is accepted, and one step outside it is bad_shape', () => {
    const rfq = (over: Record<string, unknown>): unknown => ({ ...PROPOSE_REQUEST, rfq: { ...RFQ, ...over } });
    const items = (count: number): unknown => Array.from({ length: count }, (_, at) => ({ sku: `S${at}`, quantity: 1 }));
    expect(verdict(PROPOSE_REQUEST)).toBe('accepted');
    expect(request).toContain(`1 to ${MAX_RFQ_ITEMS} items, each with a \`sku\` and a \`quantity\`, and each SKU one time`);
    expect([MAX_RFQ_ITEMS, MAX_RFQ_ITEMS + 1, 0].map((count) => verdict(rfq({ items: items(count) })))).toStrictEqual(['accepted', 'bad_shape', 'bad_shape']);
    expect(verdict(rfq({ items: [{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 2 }] }))).toBe('bad_shape');
    expect(request).toContain(`a whole number from 1 to ${MAX_ITEM_QUANTITY}`);
    expect([MAX_ITEM_QUANTITY, MAX_ITEM_QUANTITY + 1, 0].map((quantity) => verdict(rfq({ items: [{ sku: 'A', quantity }] })))).toStrictEqual(['accepted', 'bad_shape', 'bad_shape']);
    expect(request).toContain(`1 to ${ID_CHARS} characters: letters, digits, dots, hyphens and underscores, starting with a letter or a digit.`);
    expect(['a'.repeat(ID_CHARS), 'a'.repeat(ID_CHARS + 1), '-a', 'a b', '', 'RFQ-7', 'rfq-7'].map((id) => verdict(rfq({ rfq_id: id })))).toStrictEqual(['accepted', 'bad_shape', 'bad_shape', 'bad_shape', 'bad_shape', 'accepted', 'accepted']);
    expect(['a'.repeat(ID_CHARS), 'a'.repeat(ID_CHARS + 1), 'a b'].map((sku) => verdict(rfq({ items: [{ sku, quantity: 1 }] })))).toStrictEqual(['accepted', 'bad_shape', 'bad_shape']);
    expect(request).toContain('a date as `YYYY-MM-DD` that exists, in the year 0100 or later');
    expect(['2026-02-30', '0099-12-31', '0100-01-01', '2026-12-20'].map((day) => verdict(rfq({ needed_by: day })))).toStrictEqual(['bad_shape', 'bad_shape', 'accepted', 'accepted']);
    expect(request).toContain('Each is a number from 0 to 1 with at most 4 decimal places, and the four sum to 1.');
    const weights = (over: Record<string, unknown>): unknown => ({ ...PROPOSE_REQUEST, weights: { ...WEIGHTS, ...over } });
    expect([verdict(weights({})), verdict(weights({ price: 0.5 })), verdict(weights({ price: 0.12345, compliance: 0.27655 })), verdict(weights({ price: -0.1, compliance: 0.7 })), verdict(weights({ price: 1.1, compliance: -0.7 }))]).toStrictEqual(['accepted', 'bad_shape', 'bad_shape', 'bad_shape', 'bad_shape']);
    expect(verdict({ ...PROPOSE_REQUEST, weights: { price: 1 } })).toBe('bad_shape');
    expect(request).toContain(`1 to ${TENANT_CHARS} characters, lower-case letters, digits and hyphens, starting with a letter or a digit`);
    expect(TENANT_RULE).toBe('request.tenant must be 1 to 48 characters: lower-case letters, digits and hyphens, and it starts with a letter or a digit');
    expect(['a', 'a'.repeat(TENANT_CHARS), 'run-1', 'a'.repeat(TENANT_CHARS + 1), 'Acme', 'run_1', '-run', ''].map((tenant) => verdict({ ...PROPOSE_REQUEST, tenant }))).toStrictEqual(['accepted', 'accepted', 'accepted', 'bad_shape', 'bad_shape', 'bad_shape', 'bad_shape', 'bad_shape']);
    expect([verdict({ ...PROPOSE_REQUEST, extra: 1 }), verdict({ ...PROPOSE_REQUEST, authority: { ...PROPOSE_REQUEST.authority, vault: 'x' } }), verdict({ ...PROPOSE_REQUEST, op: 'cancel' })]).toStrictEqual(['bad_shape', 'bad_shape', 'bad_shape']);
    expect(request).toContain('The agent does not send the weights to the bidders.');
    expect(verdict('x'.repeat(MAX_REQUEST_BYTES + 1))).toBe('request_too_large');
  });

  test('an execute request holds the proposal as propose gave it, and the member approval, which is a reference or null', () => {
    const base = executeWorld().request() as unknown as Record<string, unknown>;
    const { approval: _approval, ...withoutApproval } = base;
    expect(verdict(base)).toBe('accepted');
    expect(verdict({ ...base, approval: null })).toBe('accepted');
    expect(verdict(withoutApproval)).toBe('bad_shape');
    expect(verdict({ ...base, approval: { attestation: 'ab'.repeat(32) } })).toBe('bad_shape');
    expect(verdict({ ...base, proposal: { ...(base.proposal as object), proposal_digest: 'ab'.repeat(32) } })).toBe('bad_shape');
    expect(verdict({ ...base, rfq: RFQ })).toBe('bad_shape');
    expect(executeText).toContain('The digest must be the digest of the salt and the document.');
    expect(executeText).toContain('The member must be there.');
  });
});

describe('agents/sourcing-agent/README.md: the result', () => {
  const result = section('The result');
  const [proposeText, afterPropose] = result.split('The result of `execute`, in the order of its members:');
  const [executeText, rankingText] = (afterPropose ?? '').split('The ranking document has these members:');
  const memberRows = (text: string): string[] => rows('The result', text).map(([member]) => ticks(member)[0]);

  test('the members of the result of propose are the members of a real answer, in its order, and fault_mode is the last', async () => {
    const w = proposeWorld();
    const { origin } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.ms });
    const proposed = await post(origin, PROPOSE_REQUEST);
    expect(proposed.body.outcome).toBe('proposed');
    expect(memberRows(proposeText)).toStrictEqual(Object.keys(proposed.body));
    expect(Object.keys(proposed.body).at(-1)).toBe('fault_mode');
    const failing = proposeWorld();
    failing.script.discover = async () => refused('no_bidders', 'no bidder quotes');
    const failed = await post((await serve({ proposeDeps: () => failing.deps, clock: () => failing.clock.ms })).origin, PROPOSE_REQUEST);
    expect(failed.body).toMatchObject({ outcome: 'failed', exit_state: 'Failed', reason: 'no_bidders', document: null, salt: null, proposal_digest: null });
    expect(Object.keys(failed.body)).toStrictEqual(Object.keys(proposed.body));
    expect(proposeText).toContain('`vector.usecase.proposal.v1`');
    expect(proposeText).toContain('A failed `propose` keeps what the job paid for and read');
  });

  test('the file of a bidder, the record of a quote and the ranking document have the members that the page names', () => {
    const golden = readGolden('proposal') as { bidders: Array<Record<string, unknown>>; quotes: Array<Record<string, unknown>> };
    const lineAfter = (text: string, start: string): string => (text.split(start)[1] ?? '').split(/\.(?:\s|$)/)[0] ?? '';
    expect(ticks(lineAfter(proposeText, 'The file of a bidder has these members: '))).toStrictEqual(Object.keys(golden.bidders[0]));
    expect(ticks(lineAfter(proposeText, 'The record of a quote has these members: '))).toStrictEqual(Object.keys(golden.quotes[0]));
    const ranking = readGolden('ranking') as Record<string, unknown> & { ranked: Array<Record<string, unknown>> };
    expect(rows('The result', rankingText).map(([member]) => ticks(member)[0])).toStrictEqual(Object.keys(ranking));
    expect(ticks(lineAfter(rankingText, 'Each entry of `ranked` has these members: '))).toStrictEqual(Object.keys(ranking.ranked[0]));
    expect(rankingText).toContain('`vector.usecase.ranking.v1`');
  });

  test('the members of the result of execute are the members of a real answer, in its order, and the one write is the write that the page names', async () => {
    const w = executeWorld();
    const { origin } = await serve({ executeDeps: () => w.deps, clock: () => w.gateway.now() });
    const completed = await post(origin, w.request());
    expect(memberRows(executeText)).toStrictEqual(Object.keys(completed.body));
    expect(Object.keys(completed.body).at(-1)).toBe('fault_mode');
    expect(completed.body.writes).toStrictEqual([{ system: 'sourcing-record', route: 'POST /sourcing/rankings', status: 201, ref: 'RK-run1-0001' }]);
    expect(executeText).toContain('`{"system":"sourcing-record","route":"POST /sourcing/rankings","status":201,"ref":<the id of the ranking or null>}`');
    expect(executeText).toContain('`vector.usecase.result.v1`');
    expect(result).toContain('`fault_mode` is the last member of every result');
  });
});

describe('agents/sourcing-agent/README.md: the settings', () => {
  test('the Settings table names exactly the settings of SETTINGS, each one time, and SETTINGS are the names that the code reads', () => {
    const documented = rows('Settings').flatMap(([names]) => ticks(names)).sort();
    expect(new Set(documented).size, 'a name stands in two rows').toBe(documented.length);
    expect(documented).toStrictEqual([...SETTINGS].sort());
    expect([...SETTINGS].sort()).toStrictEqual([...new Set([...namesRead(), ...VAULT_PAYER_IDENTITY_SETTINGS, ...TABLE_READ])].sort());
    // No source of the service writes an identity name: it takes them from buyer-core. The service never reads the private key of the supplier.
    for (const name of VAULT_PAYER_IDENTITY_SETTINGS) expect(namesRead().includes(name), name).toBe(false);
    expect(SETTINGS as readonly string[]).not.toContain('SUPPLIER_PRIV_KEY_HEX');
    expect(readme).toContain('under the names that the MCP server reads');
  });

  test('each name that the code reads through a table has a reader: a wrong value of it changes the configuration or stops the start', () => {
    const wrong = (name: string): string => (name.endsWith('_DID') ? 'not-a-did' : name.endsWith('_PKH') ? '00'.repeat(28) : '1');
    for (const name of TABLE_READ.filter((entry) => !entry.startsWith('COSIGN_'))) expect(() => loadConfig(completeEnv({ [name]: wrong(name) })), name).toThrow();
    expect(loadConfig(completeEnv({ COSIGN_MAX_CONCURRENT: '7' })).cosign.maxConcurrent).toBe(7);
    expect(loadConfig(completeEnv({ COSIGN_MAX_FUTURE_MS: '120000' })).cosign.maxFutureMs).toBe(120_000);
    expect(loadConfig(completeEnv({ COSIGN_LEDGER_TIMEOUT_MS: '9000' })).cosign.ledgerTimeoutMs).toBe(9_000);
  });

  test('a required setting is one that the service refuses to start without, and the table says "none. Required" for those and for no other', () => {
    const keys = Object.values(KEY_VARIABLES) as string[];
    const required = Object.keys(completeEnv()).filter((name) => name !== 'PORT' && name !== 'HOST' && !keys.includes(name));
    expect(required.length).toBeGreaterThan(25);
    for (const name of required) {
      expect(() => loadConfig(completeEnv({ [name]: undefined })), name).toThrow();
      expect(cell(name, 2), name).toBe('none. Required');
    }
    for (const name of keys) {
      expect(() => loadConfig(completeEnv({ [name]: undefined })), name).toThrow();
      expect(cell(name, 2), name).toMatch(/^none\. The key is required/);
    }
    for (const name of SETTINGS.filter((setting) => !required.includes(setting) && !keys.includes(setting))) {
      expect(() => loadConfig(completeEnv({ [name]: undefined })), name).not.toThrow();
      expect(cell(name, 2), name).not.toMatch(/^none\. Required/);
    }
    for (const name of ['LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE', 'QUOTE_MAX_PRICE_LOVELACE', 'QUOTE_MAX_SUPPLIER_BOND_LOVELACE', 'QUOTE_MAX_BUYER_BOND_LOVELACE']) expect(cell(name, 2), name).toBe('none. Required');
  });

  test("the defaults that the table gives are the code's and the manifest's", () => {
    const manifest = JSON.parse(config.manifest.text) as { version: string; status: { chip: string; since: string }; terms: { max_processing_ms: number; price_lovelace: number } };
    expect(cell('PORT', 2)).toBe(`\`${PORT_DEFAULT}\`, \`${HOST_DEFAULT}\``);
    expect(cell('HOST', 2)).toBe(cell('PORT', 2));
    expect(loadConfig(completeEnv({ PORT: undefined, HOST: undefined }))).toMatchObject({ port: PORT_DEFAULT, host: HOST_DEFAULT });
    expect([PORT_DEFAULT, HOST_DEFAULT, STATE_DIR_DEFAULT]).toStrictEqual([9105, '0.0.0.0', '/data']);
    expect(cell('SOURCING_STATE_DIR', 2)).toBe(`\`${STATE_DIR_DEFAULT}\``);
    expect(loadConfig(completeEnv({ SOURCING_STATE_DIR: undefined })).stateDir).toBe(STATE_DIR_DEFAULT);
    expect(cell('IDENTITY_GATEWAY_URL', 2)).toBe(`\`${GATEWAY_DEFAULT}\``);
    expect(loadConfig(completeEnv()).endpoints.gatewayUrl).toBe(GATEWAY_DEFAULT);
    expect([cell('AGENT_VERSION', 2), cell('AGENT_STATUS_CHIP', 2), cell('AGENT_STATUS_SINCE', 2)]).toStrictEqual([`\`${manifest.version}\``, `\`${manifest.status.chip}\``, `\`${manifest.status.since}\``]);
    expect([manifest.version, manifest.status.chip, manifest.status.since]).toStrictEqual(['0.1.0', 'proposed', '2026-11-24']);
    expect([template.version, template.status.chip, template.status.since]).toStrictEqual([manifest.version, manifest.status.chip, manifest.status.since]);
    expect(cell('ADVERT_PRICE_LOVELACE', 2)).toBe(`\`${PRICE_DEFAULT_LOVELACE}\``);
    expect(manifest.terms.price_lovelace).toBe(PRICE_DEFAULT_LOVELACE);
    expect(cell('ADVERT_MAX_PROCESSING_MS', 2)).toBe(`\`${MIN_PROCESSING_WINDOW_MS}\``);
    expect(manifest.terms.max_processing_ms).toBe(MIN_PROCESSING_WINDOW_MS);
    expect(cell('ADVERT_MAX_PROCESSING_MS', 1)).toContain(`At least ${MIN_PROCESSING_WINDOW_MS}, because the deadline of a job assumes the ${MIN_PROCESSING_WINDOW_MS / 60_000} min window.`);
    expect(cell('ADVERT_EXPLORER_URL', 2)).toBe('empty');
    expect(cell('FAULT_MODE', 2)).toBe('empty');
    expect(cell('IDENTITY_ADDRESS', 2)).toBe('derived from the policy');
    for (const name of ['VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL']) expect(cell(name, 2), name).toBe('the default of `packages/buyer-core`');
    expect(cell('VECTOR_OGMIOS_URL', 1)).toContain('It must be an `https://` address');
    // The three limits of the co-sign route: the default of the kit, and the number is the number of the code.
    expect([DEFAULT_LIMITS.maxConcurrent, DEFAULT_LIMITS.maxFutureMs, DEFAULT_LIMITS.ledgerTimeoutMs]).toStrictEqual([4, 3_600_000, 5_000]);
    expect([cell('COSIGN_MAX_CONCURRENT', 2), cell('COSIGN_MAX_FUTURE_MS', 2), cell('COSIGN_LEDGER_TIMEOUT_MS', 2)]).toStrictEqual(['`4`', '`3600000`', '`5000`']);
    expect(loadConfig(completeEnv()).cosign).toMatchObject(DEFAULT_LIMITS);
    // The two dispute settings that have no default of their own: the dispute code decides the lease and the deadline.
    expect(cell('DISPUTE_STARTED_LEASE_MS', 2)).toBe('10 min, or twice `DISPUTE_READ_TIMEOUT_MS` when that is more');
    expect(cell('DISPUTE_RESOLUTION_DEADLINE_MS', 2)).toBe('the deadline of the deployment');
    expect(textOf('../../../packages/usecase-kit/src/dispute/dispute.ts')).toContain('const STARTED_LEASE_MS = 600_000;');
    expect(config.dispute).not.toHaveProperty('started_lease_ms');
    expect(config.dispute).not.toHaveProperty('resolution_deadline_ms');
    // The bond of the advert is fixed: the lock of an escrow is the price and both bonds.
    expect([SUPPLIER_BOND_LOVELACE, BUYER_BOND_LOVELACE]).toStrictEqual([1_000_000, 1_000_000]);
    expect(section('Settings')).toContain(`each bond is ${SUPPLIER_BOND_LOVELACE} lovelace, and the lock is ${PRICE_DEFAULT_LOVELACE + SUPPLIER_BOND_LOVELACE + BUYER_BOND_LOVELACE} lovelace`);
  });

  test('the ranges that the table names are the ranges that the readers keep, one step outside each is refused and the limit is accepted', () => {
    const refusal = (over: Record<string, string>): string => messageOf(() => loadConfig(completeEnv(over)));
    expect(cell('ADVERT_MAX_PROCESSING_MS', 1)).toContain('At least');
    expect(refusal({ ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS - 1) })).toMatch(/^environment variable ADVERT_MAX_PROCESSING_MS must be at least 5400000/);
    expect(() => loadConfig(completeEnv({ ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS) }))).not.toThrow();
    expect(cell('DISPUTE_READ_TIMEOUT_MS', 1)).toContain(`at most ${READ_BUDGET_MS}`);
    expect(refusal({ DISPUTE_READ_TIMEOUT_MS: String(READ_BUDGET_MS + 1) })).toMatch(/^environment variable DISPUTE_READ_TIMEOUT_MS must be a whole number of milliseconds of at most 30000/);
    expect(() => loadConfig(completeEnv({ DISPUTE_READ_TIMEOUT_MS: String(READ_BUDGET_MS) }))).not.toThrow();
    expect(cell('DISPUTE_MIN_WINDOW_LEFT_MS', 1)).toContain('of at least 2000');
    expect(refusal({ DISPUTE_MIN_WINDOW_LEFT_MS: '1999' })).toMatch(/^environment variable DISPUTE_MIN_WINDOW_LEFT_MS must be a whole number of milliseconds of at least 2000/);
    expect(() => loadConfig(completeEnv({ DISPUTE_MIN_WINDOW_LEFT_MS: '2000' }))).not.toThrow();
    for (const name of ['ADVERT_PRICE_LOVELACE', 'DISPUTE_CHALLENGE_STAKE_LOVELACE', 'LLM_MAX_PRICE_LOVELACE', 'LLM_MAX_SUPPLIER_BOND_LOVELACE', 'QUOTE_MAX_PRICE_LOVELACE', 'QUOTE_MAX_BUYER_BOND_LOVELACE']) {
      expect(refusal({ [name]: '0' }), name).toMatch(new RegExp(`^environment variable ${name} must be a whole number of lovelace of more than 0`));
      expect(() => loadConfig(completeEnv({ [name]: '1' })), name).not.toThrow();
    }
    expect(section('Settings')).toContain('A number of lovelace is a whole number of digits, more than 0.');
  });

  test('a public key must hash to the key hash beside it, and IDENTITY_POLICY_ID must be the policy that the identity values give', () => {
    expect(cell('SUPPLIER_PUB_KEY_HEX', 1)).toContain('The service stops at start unless its key hash is `SUPPLIER_PKH`');
    expect(messageOf(() => loadConfig(completeEnv({ SUPPLIER_PUB_KEY_HEX: '11'.repeat(32) })))).toMatch(/^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/);
    expect(cell('IDENTITY_POLICY_ID', 1)).toContain('It must be the identity policy that `VECTOR_IDENTITY_LEGACY_ROOT` and `VECTOR_IDENTITY_CONFIG_SEED` give, or the service stops at start');
    expect(messageOf(() => loadConfig(completeEnv({ IDENTITY_POLICY_ID: 'ab'.repeat(28) })))).toMatch(/^environment variable IDENTITY_POLICY_ID is not the identity policy that VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED give/);
    expect(cell('SCORER_1_DID', 1)).toContain('Each scorer is an agent of its own');
    expect(messageOf(() => loadConfig(completeEnv({ SCORER_2_DID: SCORER_DIDS[0] })))).toMatch(/^environment variable SCORER_2_DID holds the same DID as SCORER_1_DID/);
    expect(messageOf(() => loadConfig(completeEnv({ SCORER_3_DID: completeEnv().AGENT_DID })))).toMatch(/^environment variable SCORER_3_DID holds the DID of AGENT_DID/);
    expect(cell('MOCK_MTLS_BASE', 1)).toContain('They must be two hosts.');
    expect(messageOf(() => loadConfig(completeEnv({ MOCK_MTLS_BASE: 'https://mock.example' })))).toMatch(/^environment variable MOCK_MTLS_BASE must name another host than MOCK_PUBLIC_BASE/);
  });
});

describe('agents/sourcing-agent/README.md: the keys and the fault switch', () => {
  const keys = section('Keys');
  const ROLES = Object.keys(KEY_VARIABLES) as Array<keyof typeof KEY_VARIABLES>;

  test('the table gives the nine keys, each with its variable, its key hash variable and its job, in the order of the code', () => {
    expect(rows('Keys').map(([variable, pkh]) => [ticks(variable)[0], ticks(pkh)[0]])).toStrictEqual(ROLES.map((role) => [KEY_VARIABLES[role], PKH_VARIABLES[role]]));
    expect(ROLES).toHaveLength(9);
    expect(SETTINGS.filter((name) => name.endsWith('_PRIV_KEY_HEX'))).toStrictEqual(ROLES.map((role) => KEY_VARIABLES[role]));
    expect(keys).toContain('The service holds nine keys.');
    expect(keys).toContain('A key is 64 hex characters, read from the env file and from nowhere else.');
    // Only start.ts names a key variable, and the code never holds the private key of the supplier.
    expect(sources.filter(({ text }) => text.includes('_PRIV_KEY_HEX')).map(({ file }) => file)).toStrictEqual(['serve/start.ts']);
    expect(sources.some(({ text }) => text.includes('SUPPLIER_PRIV_KEY'))).toBe(false);
    expect(keys).toContain('The supplier key is the key of the runtime. This service never holds it.');
    expect(keys).toContain('It holds the key hash and the public key of the supplier key (`SUPPLIER_PKH` and `SUPPLIER_PUB_KEY_HEX`), which the manifest publishes.');
    expect(keys).toContain('The service stops at start when one of the nine keys is the supplier key, and when two keys are one key');
    expect(messageOf(() => loadConfig(completeEnv({ [KEY_VARIABLES.service]: rawKey(23) })))).toMatch(/^environment variable SOURCING_SERVICE_PRIV_KEY_HEX holds the key of SUPPLIER_PKH/);
    expect(SUPPLIER.keyHash).toBe(completeEnv().SUPPLIER_PKH);
    expect(messageOf(() => loadConfig(completeEnv({ [KEY_VARIABLES.delegation2]: rawKey(KEY_NUMBERS.delegation1) })))).toMatch(/^environment variable SOURCING_DELEGATION_2_PRIV_KEY_HEX holds the same key as SOURCING_DELEGATION_1_PRIV_KEY_HEX/);
    expect(messageOf(() => loadConfig(completeEnv({ [PKH_VARIABLES.service]: '00'.repeat(28) })))).toMatch(/^environment variable SOURCING_SERVICE_PKH .* is not the key hash of the key in SOURCING_SERVICE_PRIV_KEY_HEX/);
    expect(() => loadConfig(completeEnv())).not.toThrow();
  });

  test('three keys pay, each with a wallet and a lane of its own, and a start makes the folder of each of them', async () => {
    expect(keys).toContain('Three of the keys pay: the service key and the two delegation keys.');
    expect(keys).toContain('The six keys of the scorers own no wallet and no lane.');
    const { dir } = await start();
    expect(readdirSync(join(dir, 'keys')).sort()).toStrictEqual([config.keys.service.pkh, config.keys.delegation1.pkh, config.keys.delegation2.pkh].sort());
    for (const role of ['scorer1Authentication', 'scorer1Delegation', 'scorer3Delegation'] as const) expect(existsSync(join(dir, 'keys', config.keys[role].pkh))).toBe(false);
  });

  test('FAULT_MODE is empty or invert_scores, the scorer of the first quote returns 100 minus each score, the other scorers and the manifest are the same, and the setting is the last member of each result', async () => {
    const text = section('The fault switch');
    expect(text).toContain('`FAULT_MODE` is empty or `invert_scores`. Any other value stops the start.');
    expect(cell('FAULT_MODE', 1)).toContain('empty, or `invert_scores`. Any other value stops the start');
    expect(loadConfig(completeEnv({ FAULT_MODE: 'invert_scores' })).fault.mode).toBe('invert_scores');
    for (const value of ['confirm_wrong_lot', 'INVERT_SCORES', 'nonsense']) expect(messageOf(() => loadConfig(completeEnv({ FAULT_MODE: value }))), value).toMatch(/^environment variable FAULT_MODE must be empty or "invert_scores"/);
    expect(text).toContain('the scorer of the first accepted quote returns each of its four component scores and its score as 100 minus the value');
    const choice = { components: { price: 80.2, lead_time: 70, reliability: 0.1, compliance: 100 }, score: 75 };
    const fault = scoreFaultOf(readFaultSwitch('sourcing-agent', 'invert_scores'));
    expect(fault(0, choice)).toStrictEqual({ components: { price: 19.8, lead_time: 30, reliability: 99.9, compliance: 0 }, score: 25 });
    expect([fault(1, choice), fault(2, choice)]).toStrictEqual([choice, choice]);
    expect(scoreFaultOf(readFaultSwitch('sourcing-agent', ''))(0, choice)).toBe(choice);
    expect(reversedOf(80.2)).toBe(19.8);
    expect(text).toContain('so 80.2 gives 19.8');
    expect(text).toContain('The other scorers are not changed.');
    expect(text).toContain('The decision that the model made stays on record as the model gave it');
    expect(template.behaviour.fault_modes).toStrictEqual(['invert_scores']);
    expect(text).toContain('it lists `invert_scores` in `behaviour.fault_modes`');
    const [off, on] = ['', 'invert_scores'].map((mode) => loadConfig(completeEnv({ FAULT_MODE: mode })).manifest.text);
    expect(on).toBe(off);
    expect(text).toContain('Each result holds the setting in its last member, `fault_mode`.');
    const w = proposeWorld();
    const { origin } = await serve({ proposeDeps: () => w.deps, fault: readFaultSwitch('sourcing-agent', 'invert_scores'), clock: () => w.clock.ms });
    const answered = await post(origin, PROPOSE_REQUEST);
    expect([answered.body.fault_mode, Object.keys(answered.body).at(-1)]).toStrictEqual(['invert_scores', 'fault_mode']);
  });
});

describe('agents/sourcing-agent/README.md: the errors and the reasons', () => {
  const errors = section('Errors');
  const [httpText, cosignText] = errors.split('The co-sign route has its own codes:');
  /** The rows of a table of the Errors section: the status of the row, and the codes in backticks of its second cell. */
  const codeRows = (text: string): Array<{ status: number; codes: string[] }> =>
    text.split('\n').filter((line) => /^\| \d/.test(line)).map(cells).map(([status, cell2]) => ({ status: Number(status), codes: ticks(cell2).filter((code) => /^[a-z_]+$/.test(code)) }));

  test('the first table gives each code its status, as the kit and the service have it, and it holds the codes that the service answers and no other', () => {
    // The two codes that the shared server answers with and the protocol does not list: a bad context, and a path that is no route.
    const serverOwn: Record<string, number> = { bad_context: 400, not_found: 404 };
    const table = codeRows(httpText);
    expect(table.flatMap((row) => row.codes)).toStrictEqual(['bad_wire', 'request_too_large', 'bad_shape', 'bad_context', 'delegation_not_mine', 'unauthorized', 'not_found', 'busy', 'internal', 'shutting_down']);
    for (const { status, codes } of table) for (const code of codes) expect([code, status], code).toStrictEqual([code, (ERROR_STATUS as Record<string, number>)[code] ?? serverOwn[code]]);
    expect(table.map((row) => row.status)).toStrictEqual([400, 401, 404, 409, 500, 503]);
    expect(errors).toContain('{"error": "<code>", "message": "<words>"}');
    expect(errors).toContain('Four answers carry the code only, with no `message`: the 401, the 404, the 409 of a job and a 500 for an error that the service does not name.');
    expect(errors).toContain(`\`${operatorsText('<code>')}\``);
    expect(errors).toContain(`\`shutting_down\` has the fixed message \`${STOPPING_TEXT}\`, and the 409 \`busy\` of \`POST /precheck\` has the fixed message \`${BUSY_TEXT}\`.`);
  });

  test('a running service gives each status of the table: 400 for the faults of the request, 401, 404, 409, 500 with no message, and 503 with the fixed message', async () => {
    const w = proposeWorld();
    const slot = new JobSlot();
    const { origin } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.ms, slot });
    const seen = (answer: { status: number; body: Record<string, unknown> }): [number, unknown] => [answer.status, answer.body.error];
    const raw = await fetch(`${origin}/`, { method: 'POST', body: 'not json', headers: { authorization: TOKEN } });
    expect([raw.status, ((await raw.json()) as Record<string, unknown>).error]).toStrictEqual([400, 'bad_wire']);
    expect(seen(await post(origin, undefined, TOKEN, 'x'.repeat(MAX_REQUEST_BYTES + 1)))).toStrictEqual([400, 'request_too_large']);
    expect(seen(await post(origin, { ...PROPOSE_REQUEST, extra: 1 }))).toStrictEqual([400, 'bad_shape']);
    expect(seen(await post(origin, { ...PROPOSE_REQUEST, tenant: 'Acme' }))).toStrictEqual([400, 'bad_shape']);
    expect(seen(await post(origin, PROPOSE_REQUEST, null))).toStrictEqual([401, 'unauthorized']);
    w.script.delegation = async () => ({ delegate: 'ee'.repeat(32), chain_whole: true });
    expect(seen(await post(origin, PROPOSE_REQUEST))).toStrictEqual([400, 'delegation_not_mine']);
    const broken = await serve({ proposeDeps: () => { throw new Error('boom'); } });
    expect(await post(broken.origin, PROPOSE_REQUEST)).toStrictEqual({ status: 500, body: { error: 'internal' } });
    const failing = await serve({ executeDeps: () => { throw new Error('boom'); } });
    expect((await post(failing.origin, executeWorld().request())).status).toBe(500);
    slot.drain();
    const stopping = await post(origin, PROPOSE_REQUEST);
    expect(stopping).toStrictEqual({ status: 503, body: { error: 'shutting_down', message: STOPPING_TEXT } });
    expect(Object.keys(ERROR_STATUS)).toContain('shutting_down');
    expect(ERROR_STATUS.busy).toBe(409);
  });

  test('the co-sign table gives the codes of the route with the status of each, the route takes POST only, and the page holds no 405', () => {
    expect(COSIGN_STATUS.method_not_allowed).toBe(405);
    const table = codeRows(cosignText);
    expect(table.flatMap((row) => row.codes).sort()).toStrictEqual(Object.keys(COSIGN_STATUS).filter((code) => code !== 'method_not_allowed').sort());
    for (const { status, codes } of table) for (const code of codes) expect([code, status], code).toStrictEqual([code, (COSIGN_STATUS as Record<string, number>)[code]]);
    expect(cosignText).toContain('The route takes `POST` only. Any other method gets the 404 `not_found` of the service, as an unknown path does.');
    expect(table.some((row) => row.status === 405)).toBe(false);
  });

  test('a job that fails is a reason code of a 200 result and never an HTTP status, and the page of the agent has the table of the reasons', () => {
    expect(errors).toContain('A job that fails is no HTTP error. It is a 200 result with a `reason` code, as the section Reasons says.');
    expect(errors.split('\n').filter((line) => /^\| `/.test(line))).toStrictEqual([]);
    expect(errors).toContain('The table of the reasons is on the page `specs/sourcing-agent.md`, with the step that writes each reason.');
    const reasons = section('Reasons');
    const [outcomeText, listText] = reasons.split('The codes come from these closed lists of the code:');
    expect(reasons).toContain('The page `specs/sourcing-agent.md` has the table of the codes');
    expect(reasons).toContain('A text that is no code is the reason `internal`.');
    // The lists that the page holds its table to: the closed lists of the code.
    expect(rows('Reasons', listText).map(([list]) => ticks(list)[0])).toStrictEqual(['PROPOSE_FAILURES', 'QUOTE_CODES', 'SCORING_FAILURES', 'EXECUTE_FAILURES']);
    for (const list of [PROPOSE_FAILURES, QUOTE_CODES, SCORING_FAILURES, EXECUTE_FAILURES]) {
      expect(Object.isFrozen(list)).toBe(true);
      expect(list.every((code) => /^[a-z0-9_]{1,64}$/.test(code))).toBe(true);
    }
    expect(PROPOSE_FAILURES).toContain('no_quotes');
    expect(QUOTE_CODES).toContain('deadline');
    expect(EXECUTE_FAILURES).toContain('mock_system_failed');
    // The outcome of each result, and the exit state that goes with it.
    const outcomes = rows('Reasons', outcomeText).map(([job, outcome, exit]) => [ticks(job)[0], ticks(outcome)[0], ticks(exit)[0]]);
    expect(outcomes).toStrictEqual([['propose', 'proposed', 'null'], ['propose', 'failed', 'Failed'], ['execute', 'completed', 'Completed'], ['execute', 'refused_by_system', 'Rejected'], ['execute', 'failed', 'Failed']]);
    expect(refusedExit('refused_by_system', 'approval_not_found').exit_state).toBe('Rejected');
    expect(refusedExit('refused_by_system', 'approval_expired').exit_state).toBe('Expired');
    expect(refusedExit('refused_by_system', 'delegation_ended').exit_state).toBe('Cancelled');
    expect(reasons).toContain('`approval_expired` gives `Expired` and `delegation_ended` gives `Cancelled`');
    expect(reasons).toContain('A `mock_system_failed` can leave the ranking written: read the sourcing record before you send `execute` again.');
  });
});

describe('agents/sourcing-agent/README.md: the times, the state and the stop', () => {
  test('the Times table gives the numbers of the code', () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ['Deadline of `propose`', `${PROPOSE_DEADLINE_MS} ms`],
      ['Deadline of `execute`', `${EXECUTE_DEADLINE_MS} ms`],
      ['Timeout of the runtime for a job', `${JOB_DEADLINE_MS + 60_000} ms`],
      ['Window of the advert', `${MIN_PROCESSING_WINDOW_MS} ms`],
      ['Reserve of a quote hire', `${QUOTE_HIRE_RESERVE_MS} ms`],
      ['Reserve of the scoring', `${SCORING_RESERVE_MS} ms`],
      ['Time left for a hire', `${QUOTE_HIRE_RESERVE_MS + SCORING_RESERVE_MS} ms`],
      ['Need of one scorer', `${SCORER_NEED_MS} ms`],
      ['Need of the three scorers', `${SCORERS_NEED_MS} ms`],
      ['Reserve of the ranking', `${RANKING_RESERVE_MS} ms`],
      ['Job of a scorer', `${SCORER_JOB_TIMEOUT_MS} ms`],
      ['Validity of a sub-delegation', `${SUB_DELEGATION_VALID_MS} ms`],
      ['Read of the bidders', `${BIDDER_READ_BUDGET_MS} ms`],
      ['Call of a fact reader', `${FACT_READ_TIMEOUT_MS} ms`],
      ['Fetch of a bidder file', `${BIDDER_FETCH_TIMEOUT_MS} ms`],
      ['Read of the ledger', `${LEDGER_BUDGET_MS} ms`],
      ['Reservation of the job slot', `${RESERVATION_MS} ms`],
      ['Interim line', `${HEARTBEAT_MS} ms`],
      ['Pass of the janitors', `${JANITOR_INTERVAL_MS} ms`],
      ['Wait of a stop', `${SHUTDOWN_WAIT_MS} ms`],
    ];
    const times = section('Times');
    expect(wordRows(times, 'Time').map(([time, value]) => [time, value])).toStrictEqual(expected.map(([time, value]) => [time, value]));
    expect([PROPOSE_DEADLINE_MS, EXECUTE_DEADLINE_MS, QUOTE_HIRE_RESERVE_MS, SCORING_RESERVE_MS, SCORER_NEED_MS, SCORERS_NEED_MS, RANKING_RESERVE_MS]).toStrictEqual([5_220_000, 120_000, 1_830_000, 1_080_000, 720_000, 960_000, 120_000]);
    // The deadline of a job, the timeout of the runtime and the window of the advert nest: 60 s and then 120 s. The window is the one source of the number.
    expect(JOB_DEADLINE_MS).toBe(PROPOSE_DEADLINE_MS);
    expect(JOB_DEADLINE_MS + 60_000 + 120_000).toBe(MIN_PROCESSING_WINDOW_MS);
    expect(SCORING_RESERVE_MS).toBe(SCORERS_NEED_MS + RANKING_RESERVE_MS);
    expect(times).toContain(`A quote hire starts only when the deadline of the job is at least ${QUOTE_HIRE_RESERVE_MS + SCORING_RESERVE_MS} ms away, so it starts in the first ${PROPOSE_DEADLINE_MS - QUOTE_HIRE_RESERVE_MS - SCORING_RESERVE_MS} ms of the job.`);
    expect(times).toContain('The scoring starts only with `SCORING_RESERVE_MS` left, and the ranking decision only with `RANKING_RESERVE_MS` left. The job ends `failed` with `deadline` when it has not.');
    expect(textOf('../src/quotes/quotes.ts')).toContain('input.deadline_ms - deps.clock() >= QUOTE_HIRE_RESERVE_MS + input.keep_ms');
    expect(textOf('../src/propose/propose.ts')).toContain('keep_ms: SCORING_RESERVE_MS');
    expect(times).toContain(`The job reads at most ${MAX_CANDIDATES} candidates`);
    expect([CATALOG_TIMEOUT_MS, TIP_TIMEOUT_MS]).toStrictEqual([10_000, 10_000]);
    expect(times).toContain(`A pass of a janitor that is still in flight at a stop is abandoned after ${JANITOR_STOP_WAIT_MS} ms.`);
    expect(times).toContain('The window is not a promise that a job takes that long.');
  });

  test('State files names the files and folders that the wiring keeps and the number of the janitor, and the start proves that the directory can be written', async () => {
    const state = section('State files');
    expect(rows('State files').map(([path]) => ticks(path)[0])).toStrictEqual(['keys/<key hash>/stranded.json', `${STATE_FILES.dispute}/`, `${STATE_FILES.left}/`, STATE_FILES.register]);
    expect(state).toContain(`Every ${JANITOR_INTERVAL_MS / 1000} s the janitor of a paying key looks at its stranded file`);
    expect(state).toContain('The log carries job outcomes, counts and codes, never a request, a quote, a price list, a vendor entry or a key.');
    expect(textOf('../src/serve/wiring.ts')).toContain("join(settings.stateDir, STATE_FILES.dispute)");
    expect(textOf('../../../packages/hire-kit/src/janitor.ts')).toContain("STRANDED_FILE = 'stranded.json'");
    expect(state).toContain('The start proves that the directory can be written: it makes a file and removes it, and it stops when it cannot.');
    const { dir } = await start();
    expect(existsSync(join(dir, '.write-probe'))).toBe(false);
    const failed = await start({ SOURCING_STATE_DIR: join(tempDir(), 'missing', 'state') }).catch((error: unknown) => error);
    expect((failed as Error).message).toMatch(/^environment variable SOURCING_STATE_DIR names /);
  });

  test('Stopping states the numbers of the stop, and the exit codes are the ones that the kit exits with', () => {
    const stopping = section('Stopping');
    expect(stopping).toContain(`waits up to ${SHUTDOWN_WAIT_MS / 1000} s for the job that is running to end`);
    expect(stopping).toContain(`A pass of a janitor that is still in flight after ${JANITOR_STOP_WAIT_MS / 1000} s is abandoned, with a log line.`);
    expect(stopping).toContain(`must be ${(SHUTDOWN_WAIT_MS + 30_000) / 1000} s: the ${SHUTDOWN_WAIT_MS / 1000} s of the wait and 30 s more`);
    expect(stopping).toContain('the service exits 0.');
    expect(stopping).toContain(`A job still running after ${SHUTDOWN_WAIT_MS / 1000} s is abandoned`);
    expect(stopping).toContain('the service exits 1.');
    expect(textOf('../../../packages/service-kit/src/lifecycle.ts')).toContain("exit(outcome === 'abandoned' ? 1 : 0)");
    expect(textOf('../src/serve/wiring.ts')).toContain('the state directory holds');
    expect(stopping).toContain('A job is in memory only.');
    expect(stopping).toContain('Wait until the runtime says `free` before a restart.');
  });
});

describe('agents/sourcing-agent/README.md: Run it and Deploy', () => {
  const run = section('Run it');
  const MODULE1 = 'VECTOR_MODULE1_MANIFEST';
  const refusals: ReadonlyArray<readonly [what: string, over: Record<string, string>, error: RegExp, good: Record<string, string>]> = [
    ['a required setting that is not set', { OPERATOR_CONTACT: '' }, /^environment variable OPERATOR_CONTACT is required/, { OPERATOR_CONTACT: 'ops@example.test' }],
    ['a setting that is not well formed', { PORT: 'abc' }, /^environment variable PORT must be a non-negative integer/, { PORT: '9105' }],
    ['SOURCING_SERVICE_PKH that is not the key hash of the service key', { SOURCING_SERVICE_PKH: SUPPLIER.keyHash }, /^environment variable SOURCING_SERVICE_PKH .* is not the key hash of the key in SOURCING_SERVICE_PRIV_KEY_HEX/, { SOURCING_SERVICE_PKH: config.keys.service.pkh }],
    ['a key that is the supplier key', { SOURCING_DELEGATION_1_PRIV_KEY_HEX: rawKey(23) }, /^environment variable SOURCING_DELEGATION_1_PRIV_KEY_HEX holds the key of SUPPLIER_PKH/, { SOURCING_DELEGATION_1_PRIV_KEY_HEX: rawKey(KEY_NUMBERS.delegation1) }],
    ['two keys that are one key', { SCORER_2_AUTH_PRIV_KEY_HEX: rawKey(KEY_NUMBERS.scorer1Authentication) }, /^environment variable SCORER_2_AUTH_PRIV_KEY_HEX holds the same key as SCORER_1_AUTH_PRIV_KEY_HEX/, { SCORER_2_AUTH_PRIV_KEY_HEX: rawKey(KEY_NUMBERS.scorer2Authentication) }],
    ['FAULT_MODE with a value that the Sourcing Agent does not list', { FAULT_MODE: 'confirm_wrong_lot' }, /^environment variable FAULT_MODE must be empty or "invert_scores"/, { FAULT_MODE: 'invert_scores' }],
    ['VECTOR_OGMIOS_URL that is an http address', { VECTOR_OGMIOS_URL: 'http://node.example.test' }, /^environment variable VECTOR_OGMIOS_URL must be an https address/, { VECTOR_OGMIOS_URL: 'https://node.example.test' }],
    ['ADVERT_MAX_PROCESSING_MS below the window', { ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS - 1) }, /^environment variable ADVERT_MAX_PROCESSING_MS must be at least 5400000/, { ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS) }],
    ['VECTOR_MODULE1_MANIFEST that is a file path', { [MODULE1]: '/etc/sourcing/module1.json' }, /^environment variable VECTOR_MODULE1_MANIFEST must be an https address/, { [MODULE1]: completeEnv()[MODULE1] as string }],
    ['VECTOR_MODULE1_MANIFEST that names a branch', { [MODULE1]: 'https://raw.example.test/branch/manifest.json' }, /^environment variable VECTOR_MODULE1_MANIFEST must be pinned to a commit/, { [MODULE1]: completeEnv()[MODULE1] as string }],
  ];

  test('it names the command, the secrets that the operator makes, and the refusals of the start, and each refusal is one that the start makes', async () => {
    expect(run).toContain('The service needs Node 22 or later');
    expect(JSON.parse(textOf('../../../package.json')).engines.node).toBe('>=22');
    expect(run).toContain('export SERVICE_AUTH_HEADER="Bearer $(openssl rand -hex 32)"');
    const names = (/for prefix in ([A-Z0-9_ ]+); do/.exec(run)?.[1] ?? '').split(' ');
    expect(names.map((prefix) => `${prefix}_PRIV_KEY_HEX`)).toStrictEqual(Object.values(KEY_VARIABLES));
    expect(run).toContain('SOURCING_STATE_DIR=/tmp/sourcing-state PORT=9105 pnpm start');
    const scripts = JSON.parse(textOf('../package.json')).scripts as Record<string, string>;
    expect([scripts.start, scripts.template, scripts.test]).toStrictEqual(['tsx src/index.ts', 'node --import tsx scripts/render-template.mjs', 'vitest run']);
    expect(run).toContain('`pnpm --filter @vsa/sourcing-agent test`');
    for (const [what, over, error, good] of refusals) {
      expect(messageOf(() => loadConfig(completeEnv(over))), what).toMatch(error);
      expect(() => loadConfig(completeEnv(good)), `the twin of ${what}`).not.toThrow();
    }
    expect(run).toContain('when a required setting of the table is not set, when a setting is not well formed, when a `..._PKH` is not the key hash of its key,');
    expect(run).toContain('when two keys are one key, when a key is the supplier key, when `SUPPLIER_PUB_KEY_HEX` is not the public key of `SUPPLIER_PKH`,');
    expect(run).toContain('when `IDENTITY_POLICY_ID` is not the identity policy that `VECTOR_IDENTITY_LEGACY_ROOT` and `VECTOR_IDENTITY_CONFIG_SEED` give,');
    expect(run).toContain('when a scorer DID is the DID of the agent or of another scorer,');
    expect(run).toContain('when `MOCK_MTLS_BASE` names the host of `MOCK_PUBLIC_BASE`,');
    expect(run).toContain('when `FAULT_MODE` names a value that the Sourcing Agent does not list,');
    expect(run).toContain('when `VECTOR_OGMIOS_URL` is an http address,');
    expect(run).toContain('when `ADVERT_MAX_PROCESSING_MS` is below 5400000,');
    expect(run).toContain('when `VECTOR_MODULE1_MANIFEST` is not an https address pinned to a commit,');
    expect(run).toContain('when the Module-1 manifest cannot be fetched or names another identity registry than `IDENTITY_POLICY_ID`,');
    expect(run).toContain('when the node gives no start time of the chain, or when it cannot write to its state directory.');
    expect(run).toContain('A file path, an `http://` address, an address with a user, a query or a fragment, and an address with no commit stop the start.');
  });

  test('the three calls of the start are the ones that the page names, and a manifest of another registry or a node with no start time stops it', async () => {
    expect(run).toContain('At start the service makes three kinds of call: it fetches the Module-1 manifest from its pinned address, it asks the node for the start time of the chain, and it reads the wallet of each of its three paying keys.');
    const lines: string[] = [];
    const serving = (text: string) => (async () => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const other = await start({}, { fetchImpl: serving(module1ManifestText('ab'.repeat(28))), log: (line) => { lines.push(line); } }).catch((error: unknown) => error);
    expect((other as Error).message).toMatch(/^the Module-1 manifest \(VECTOR_MODULE1_MANIFEST\) names another identity registry than IDENTITY_POLICY_ID/);
    expect(lines.some((line) => line.startsWith('listening on '))).toBe(false);
    expect(run).toContain('The manifest must name the identity registry of `IDENTITY_POLICY_ID`.');
    expect(TOKEN_SEARCH_MIN).toBe(16);
    expect(run).toContain(`when it has ${TOKEN_SEARCH_MIN} characters or more`);
    expect(run).toContain('in its raw form and its bech32 form, in any case, and inside a longer value too');
    for (const [name, secret] of [[KEY_VARIABLES.service, completeEnv()[KEY_VARIABLES.service]], ['SERVICE_AUTH_HEADER', TOKEN]] as const) {
      const text = messageOf(() => loadConfig(completeEnv({ AGENT_DID: `did:${secret}` })));
      expect(text, name).toMatch(/\bAGENT_DID\b/);
      expect(text.toLowerCase().includes(String(secret).toLowerCase()), name).toBe(false);
    }
    expect(readme).not.toMatch(/SERVICE_AUTH_HEADER=["']?Bearer [0-9a-f]{8}/);
    expect(readme).not.toMatch(/PRIV_KEY_HEX=["']?[0-9a-f]{16}/);
  });

  test('the image paragraph gives the build command, the port and the volume that the Dockerfile has, and the manifest hash command exists', () => {
    const dockerfile = textOf('../Dockerfile');
    expect(run).toContain('`docker build -f agents/sourcing-agent/Dockerfile -t vsa/sourcing-agent:dev .`');
    expect(run).toContain(`listens on ${PORT_DEFAULT}`);
    expect(dockerfile).toContain(`EXPOSE ${PORT_DEFAULT}`);
    expect(run).toContain('`/data` is a volume that `node` owns');
    expect(dockerfile).toContain(`VOLUME ${STATE_DIR_DEFAULT}`);
    expect(run).toContain('builds the service image on `node:22-bookworm-slim`');
    expect(dockerfile).toContain('FROM node:22-bookworm-slim AS builder');
    expect(run).toContain('its manifest, its `tsconfig.json` and its `src` folder');
    expect(dockerfile).toContain('COPY agents/sourcing-agent/src ./agents/sourcing-agent/src');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(existsSync(new URL('../../../scripts/manifest-hash.mjs', import.meta.url))).toBe(true);
    expect(run).toContain('`node scripts/manifest-hash.mjs <https origin>`');
  });

  test('Deploy is three lines: it names the compose file, the env example and the runbook of the pack, and says that the host builds no image', () => {
    const lines = section('Deploy').split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('`deploy/server/docker-compose.sourcing-agent.yml`');
    expect(lines[1]).toBe('The env example is `deploy/server/.env.sourcing-agent.example`, and the steps are in `deploy/server/RUNBOOK-sourcing-agent.md`.');
    expect(lines[2]).toBe('The host builds no image: the compose file names each image by its digest.');
  });
});
