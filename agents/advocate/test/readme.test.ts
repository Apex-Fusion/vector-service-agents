// agents/advocate/test/readme.test.ts
// The README names every environment variable the service reads and every error code it answers with, and these tests keep the page and the code from
// parting: a variable read in src/ that the table does not name fails, so does a name in the table that no code reads, and so does a code with the wrong
// status or one that no source file knows.
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { HEARTBEAT_MS, MAX_BODY, SHUTDOWN_WAIT_MS, STOPPING_TEXT, TOKEN_SEARCH_MIN, WireError, operatorsText } from '@vsa/service-kit';
import { blake2b224Hex } from '@vsa/vector-read';
import { FETCH_CONCURRENCY, FETCH_PHASE_MAX_MS, FETCH_RESERVE_MS, JOB_DEADLINE_MS, MODEL_MAX_MS, MODEL_MIN_MS, PAGE_TIMEOUT_MS, RESULT_RESERVE_MS, SEARCH_MAX_MS, SEARCH_QUERY_TIMEOUT_MS } from '../src/budget.ts';
import { AdvocateError, JOB_STATUS } from '../src/errors.ts';
import type { JobCode } from '../src/errors.ts';
import { EXCERPT_CHARS, MIN_PAGE_CHARS } from '../src/html.ts';
import { DEFAULT_MODEL, callModel } from '../src/model.ts';
import { PAGE_MAX_BYTES, USER_AGENT } from '../src/pages.ts';
import { DECLARED_BIAS_STATEMENT, OMITTED_BY_DESIGN, QUOTE_MAX_CHARS, QUOTE_MIN_CHARS, SHAPES } from '../src/prompt.ts';
import { RequestError } from '../src/request.ts';
import { MAX_QUERY_CHARS, MAX_QUERY_WORDS, MAX_RESULTS, QUERY_SPACING_MS, RESULTS_PER_QUERY, queriesFor, searchWeb } from '../src/search.ts';
import { JobSlot, MIN_PROCESSING_WINDOW_MS, TEMPLATE_ENV, manifestFromEnv } from '../src/server.ts';
import { PORT_DEFAULT, SETTINGS, loadConfig } from '../src/start.ts';
import { GOLDEN_OUTCOME, GOLDEN_REQUEST } from './golden.ts';
import { baseDeps, serve, wire } from './server-support.ts';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
// The ledger's native unit is named once in the repository, in docs/HIRE.md. Spelled in two parts, so that a search for the name finds only the guide.
const UNIT_NAME = new RegExp('AP' + '3X', 'i');
const read = (dir: URL) => readdirSync(dir).filter((file) => file.endsWith('.ts')).map((file) => ({ file, text: readFileSync(new URL(file, dir), 'utf8') }));
const sources = read(new URL('../src/', import.meta.url));
// The codes the shared server answers with (bad_wire, request_too_large, unauthorized, busy, shutting_down, internal) are in packages/service-kit.
const kitSources = read(new URL('../../../packages/service-kit/src/', import.meta.url));
const section = (heading: string): string => (readme.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const ticks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const row = (name: string): string => section('Manifest').split('\n').find((line) => line.startsWith(`| \`${name}\``)) ?? '';
// The settings of a service that starts, made the way Run it makes them for a run on a machine of one's own: a public key and its blake2b-224.
const PUBLIC_KEY = 'ab'.repeat(32);
const FULL_ENV: Record<string, string> = {
  OPERATOR_CONTACT: 'ops@example.test', SUPPLIER_PKH: blake2b224Hex(PUBLIC_KEY), SUPPLIER_PUB_KEY_HEX: PUBLIC_KEY, SERVICE_AUTH_HEADER: `Bearer ${'cd'.repeat(32)}`,
  BRAVE_SEARCH_API_KEY: 'BSAtestkey0123456789abcdefghij', OPENROUTER_API_KEY: `sk-or-v1-${'0123456789abcdef'.repeat(4)}`,
};

/**
 * The names the code reads from the environment itself: `env.NAME`, `process.env.NAME`, the names given to envInt and requiredEnv, and the name of each API
 * key, which the start reads as `env[key.name]` from a constant `{ name, what, why }`.
 */
function namesRead(): string[] {
  const found = new Set<string>();
  for (const { text } of sources) {
    for (const m of text.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)\b/g)) found.add(m[1]);
    for (const m of text.matchAll(/\b(?:envInt|requiredEnv)\(\s*'([A-Z][A-Z0-9_]*)'/g)) found.add(m[1]);
    for (const m of text.matchAll(/\{ name: '([A-Z][A-Z0-9_]*)', what: '/g)) found.add(m[1]);
  }
  return [...found].sort();
}

describe('agents/advocate/README.md', () => {
  test('the Manifest table names exactly the variables the service reads, and they are the settings the secrets are looked for in', () => {
    const table = section('Manifest').split('\n').filter((line) => /^\| `[A-Z]/.test(line));
    const documented = table.flatMap((line) => ticks(line.split('|')[1])).sort();
    expect(documented).toStrictEqual(namesRead());
    expect([...SETTINGS].sort()).toStrictEqual(namesRead());
    for (const name of ['BRAVE_SEARCH_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL']) expect(SETTINGS, name).toContain(name);
  });

  test("the defaults the table gives are the code's", () => {
    expect(row('PORT')).toContain(`\`${PORT_DEFAULT}\``);
    expect(row('OPENROUTER_MODEL')).toContain(`| \`${DEFAULT_MODEL}\` |`);
    expect(row('ADVERT_PRICE_LOVELACE')).toContain('`3000000`');
    expect(row('ADVERT_MAX_PROCESSING_MS')).toContain('`300000`');
    expect(row('ADVERT_MAX_PROCESSING_MS')).toContain(`at least ${MIN_PROCESSING_WINDOW_MS}, because the deadline of a job assumes the ${MIN_PROCESSING_WINDOW_MS / 60_000} min window`);
    expect(row('AGENT_STATUS_CHIP')).toContain('`proposed`');
    expect(row('AGENT_STATUS_CHIP')).toContain('`status.chip`, in lower case');
    expect(row('AGENT_STATUS_SINCE')).toContain('`2026-10-13`');
    expect(row('AGENT_VERSION')).toContain('`0.1.0`');
    const manifest = manifestFromEnv({ OPERATOR_CONTACT: 'ops@example.test' });
    expect([manifest.version, manifest.terms.price_lovelace, manifest.terms.max_processing_ms, manifest.status.chip, manifest.status.since]).toStrictEqual(['0.1.0', 3_000_000, 300_000, 'proposed', '2026-10-13']);
    const config = loadConfig(FULL_ENV);
    expect([config.port, config.host, config.model]).toStrictEqual([PORT_DEFAULT, '0.0.0.0', DEFAULT_MODEL]);
    expect(row('PORT')).toContain(`| \`${config.port}\`, \`${config.host}\` |`);
  });

  test('the Errors table gives each code its status, and every code it names is one the sources know', () => {
    const rows = section('Errors').split('\n').filter((line) => /^\| \d{3}, /.test(line));
    expect(rows).toHaveLength(8);
    // The eight rows with their explanations, word for word: the codes and statuses are held to the sources below, and the words to this list.
    expect(rows).toStrictEqual([
      `| 400, the message | \`bad_wire\` (not the one-element message array), \`request_too_large\` (over ${MAX_BODY} bytes) |`,
      '| 400, the request | `bad_shape` (a request JSON that does not parse, or one that breaks a rule of the request) |',
      '| 401, the caller | `unauthorized` (the call has no authorization header, or one that is not the token of the service) |',
      '| 422, the job | `deadline` (the job ran out of its time, or too little of it was left to call the model) |',
      '| 499, the caller hung up | `aborted` (the job was stopped when its caller hung up; nobody reads this answer, and the log keeps its code and the time the job took, not its words) |',
      '| 502, a third party or the check | `search_failed` (both queries failed, or the Brave Search API refused the key), `search_empty` (no usable result), `no_sources` (no page kept), `model_failed` (the call to OpenRouter failed), `model_output_invalid` (the answer is not the JSON of a brief), `no_supported_claims` (the check dropped every argument) |',
      '| 503, the service cannot take a job now | `shutting_down` (the service is stopping) |',
      '| 500, the service | `internal` |',
    ]);
    const all = [...sources, ...kitSources].map(({ text }) => text).join('\n');
    const job = Object.keys(JOB_STATUS) as JobCode[];
    const documented = new Set<string>();
    for (const r of rows) {
      const status = Number(/^\| (\d{3}), /.exec(r)?.[1]);
      for (const code of ticks(r.split('|')[2])) {
        documented.add(code);
        expect(all, code).toContain(`'${code}'`);
        if (code === 'bad_shape') expect(new RequestError('x').status, code).toBe(status);
        if ((job as string[]).includes(code)) expect(new AdvocateError(code as JobCode, 'x').status, code).toBe(status);
      }
    }
    for (const code of ['bad_shape', ...job, 'bad_wire', 'request_too_large', 'unauthorized', 'shutting_down', 'internal']) expect(documented.has(code), code).toBe(true);
  });

  test('it explains the token, the two API keys, the 102 Processing line, the fixed text of a failed job, the stop, the checks at start and the window', () => {
    expect(readme).toContain('`POST /` requires the `authorization` header to be exactly the value of `SERVICE_AUTH_HEADER`');
    expect(readme).toContain('401 `{"error":"unauthorized"}`, with no detail, before the body is read and before the job slot is taken');
    expect(readme).toContain('102 Processing');
    expect(readme).toMatch(/runtime's fetch gives up after 300 s of silence/);
    expect(section('Routes')).toContain('A job whose caller hangs up, as the runtime does when its own budget for the job runs out, is stopped: its fetches and its call to the model are aborted, nothing of the job is kept, and the slot is free for the next one.');
    expect(section('Stopping')).toContain('The wait is on the job itself: it ends when the job has its answer, or when the job has been stopped because its caller hung up.');
    expect(readme).toContain("The service could not do this job (<code>). The operator's log has the detail.");
    expect(section('Stopping')).toContain('On SIGTERM (`docker stop` sends it) or SIGINT the service takes no new job and no new connection, and waits up to 300 s for the job that is running to end.');
    expect(section('Stopping')).toContain('so `stop_grace_period` in the compose file is 330 s');
    expect(section('Stopping')).toContain('so the wait is that long at most in practice');
    // The outcomes of a stop: the exit code 0 when the job ended in time, 1 when it was abandoned after the wait, as the kit exits.
    expect(section('Stopping')).toContain(`One still running after ${SHUTDOWN_WAIT_MS / 1000} s is abandoned: its connection is closed, the log says so, and the service exits 1.`);
    expect(section('Stopping')).toContain('A job that ends in time is answered, if its caller is still there, and the service exits 0.');
    expect(kitSources.find(({ file }) => file === 'lifecycle.ts')?.text).toContain("exit(outcome === 'abandoned' ? 1 : 0)");
    expect(readme).toContain(`${SHUTDOWN_WAIT_MS / 1000} s`);
    expect(readme).toMatch(/at least 300000/);
    expect(section('Run it')).toContain('export SERVICE_AUTH_HEADER="Bearer $(openssl rand -hex 32)"');
    for (const name of ['BRAVE_SEARCH_API_KEY', 'OPENROUTER_API_KEY']) expect(section('Run it')).toContain(`read -rs ${name} && export ${name}`);
    expect(section('Run it')).toContain('It calls neither the Brave Search API nor OpenRouter at start: the first job is the first use of the two keys.');
    expect(readme).not.toMatch(/SERVICE_AUTH_HEADER=["']?Bearer [0-9a-f]/);
    expect(readme).not.toMatch(/(BRAVE_SEARCH|OPENROUTER)_API_KEY=\S/);
  });

  test('it says the status the manifest and the code give, and nothing in it is a dash, a unit name or a key', () => {
    const STATUS = 'Status: PROPOSED (built, not deployed). Since 2026-10-13.';
    expect(readme).toContain(`${STATUS} The service is built and its tests run the search, the pages, the model and the check`);
    // The first line is the description of the manifest, and the sentence that follows names the capability.
    expect(readme.split('\n')[2]).toBe(`${manifestFromEnv({ OPERATOR_CONTACT: 'ops@example.test' }).description} Capability \`research.advocate.onesided.v1\`.`);
    expect(readme).toContain('against stand-ins for the Brave Search API, the result pages and OpenRouter, with no network');
    expect(readme).not.toMatch(/[\u{2013}\u{2014}]/u);
    expect(readme).not.toMatch(UNIT_NAME);
    expect(readme).not.toMatch(/[0-9a-f]{64}/);
    expect(readme.match(/\b(LIVE|DEPLOYED)\b/g)).toBeNull();
  });
});

// ---- Pins beyond the brief ----
// The numbers, files and settings the README states that the five tests above do not hold, held to the code, the compose file and the Dockerfile that own them.
const here = (file: string): URL => new URL(`../${file}`, import.meta.url);
const textOf = (file: string): string => readFileSync(here(file), 'utf8');

describe('agents/advocate/README.md, pinned further', () => {
  test('the six settings the service cannot start without are the ones the README names, each is refused naming it, and a public key that is not the key of the hash stops the start', () => {
    const required = ['OPERATOR_CONTACT', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'SERVICE_AUTH_HEADER', 'BRAVE_SEARCH_API_KEY', 'OPENROUTER_API_KEY'];
    const run = section('Run it');
    expect(run).toContain('when `OPERATOR_CONTACT`, `SUPPLIER_PKH`, `SUPPLIER_PUB_KEY_HEX`, `SERVICE_AUTH_HEADER`, `BRAVE_SEARCH_API_KEY` or `OPENROUTER_API_KEY` is not set');
    expect(run).toContain('when `SUPPLIER_PUB_KEY_HEX` is not the public key of `SUPPLIER_PKH`');
    for (const name of required) {
      const env: Record<string, string> = { ...FULL_ENV };
      delete env[name];
      expect(() => loadConfig(env), name).toThrow(new RegExp(`^environment variable ${name} is required`));
      expect(row(name), name).toMatch(/ \| none\. Required/);
    }
    expect(() => loadConfig({ ...FULL_ENV, SUPPLIER_PUB_KEY_HEX: 'ef'.repeat(32) })).toThrow(/^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/);
    // The lengths the table gives: the key hash is 56 hex characters and the public key 64. The word of the status is one of three, in any case.
    expect(() => loadConfig({ ...FULL_ENV, SUPPLIER_PKH: 'ab' })).toThrow(/^environment variable SUPPLIER_PKH must be 56 hex characters/);
    expect(() => loadConfig({ ...FULL_ENV, SUPPLIER_PUB_KEY_HEX: 'ab' })).toThrow(/^environment variable SUPPLIER_PUB_KEY_HEX must be 64 hex characters/);
    expect(row('SUPPLIER_PKH')).toContain('56 hex characters');
    expect(run).toContain('a key of the Brave Search API and a key of OpenRouter');
    expect(run).toContain('# paste the key of the Brave Search API; it is not shown');
    expect(run).toContain('# paste the key of OpenRouter; it is not shown');
    expect(row('BRAVE_SEARCH_API_KEY')).toContain('the key of the Brave Search API, sent as `X-Subscription-Token` with each of the two queries');
    expect(textOf('src/search.ts')).toContain("'X-Subscription-Token': opts.apiKey");
    expect(row('OPENROUTER_API_KEY')).toContain('the key of OpenRouter, sent as `Authorization: Bearer <key>` with the call to the model');
    expect(textOf('src/model.ts')).toContain('Authorization: `Bearer ${opts.apiKey}`');
    expect(readme).toContain('Never published, never logged');
    expect(row('SERVICE_AUTH_HEADER')).toContain('`Bearer ` and 64 hex characters, made with `openssl rand -hex 32`');
    expect(row('SUPPLIER_PUB_KEY_HEX')).toContain('64 hex characters');
    expect(readme).toContain('`AGENT_STATUS_CHIP` must be live, deployed or proposed, in any case.');
    expect(loadConfig({ ...FULL_ENV, AGENT_STATUS_CHIP: 'Proposed' }).manifest.status.chip).toBe('proposed');
    expect(() => loadConfig({ ...FULL_ENV, AGENT_STATUS_CHIP: 'bogus' })).toThrow(/^environment variable AGENT_STATUS_CHIP must be one of /);
    expect(() => loadConfig({ ...FULL_ENV, ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS - 1) })).toThrow(/ADVERT_MAX_PROCESSING_MS/);
    expect(MIN_PROCESSING_WINDOW_MS / 60_000).toBe(5);
    expect(run).toContain('is below 5 min');
    // A secret in another line stops the start, naming that line and not showing the secret.
    for (const name of ['BRAVE_SEARCH_API_KEY', 'OPENROUTER_API_KEY']) {
      let message = '';
      try { loadConfig({ ...FULL_ENV, AGENT_DID: `did:${FULL_ENV[name]}` }); } catch (e) { message = e instanceof Error ? e.message : String(e); }
      expect(message, name).toMatch(/\bAGENT_DID\b/);
      expect(message.toLowerCase().includes(FULL_ENV[name].toLowerCase()), name).toBe(false);
    }
  });

  test('Run it: the recipe of a key pair for a run on a machine of one\'s own makes settings the service takes, and Run it says where a pair comes from on the host', () => {
    const run = section('Run it');
    expect(run).toContain('export SUPPLIER_PUB_KEY_HEX=$(openssl rand -hex 32)');
    expect(run).toContain('The service needs Node 22 or later');
    expect(run).toContain('On a machine with the repository:\n\n```bash\n');
    expect(JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).engines.node).toBe('>=22');
    expect(run).toContain('a public key and its blake2b-224');
    expect(run).toContain("export SUPPLIER_PKH=$(node --import tsx --input-type=module -e \"import { blake2b224Hex } from '@vsa/vector-read'; console.log(blake2b224Hex(process.env.SUPPLIER_PUB_KEY_HEX))\")");
    expect(loadConfig(FULL_ENV).manifest.keys).toStrictEqual({ supplier_pkh: blake2b224Hex(PUBLIC_KEY), pub_key_hex: PUBLIC_KEY });
    expect(run).toContain('on the host, step 4 of `deploy/host/RUNBOOK-advocate.md` makes the pair with `gen-keypair`');
    const runbook = textOf('../../deploy/host/RUNBOOK-advocate.md');
    expect((runbook.split('\n## 4. ')[1] ?? '').split('\n## ')[0]).toContain('agent/src/cli/gen-keypair.ts');
    expect(TOKEN_SEARCH_MIN).toBe(16);
    expect(run).toContain(`each when it is ${TOKEN_SEARCH_MIN} characters or more`);
  });

  test('Routes states the numbers of the code: the 1000000 bytes of a message, the deadline 30 s inside the timeout, the budgets of the search, the pages and the model, the line every 60 s', () => {
    const routes = section('Routes');
    expect(routes).toContain(`It is read up to ${MAX_BODY} bytes.`);
    expect(routes).toContain(`A job has its own deadline, ${JOB_DEADLINE_MS} ms after its request arrives, 30 s inside the runtime's \`SERVICE_TIMEOUT_MS\` of ${JOB_DEADLINE_MS + 30_000}.`);
    expect(routes).toContain(`The search gets at most ${SEARCH_MAX_MS} ms of it, for two queries one after the other, each at most ${SEARCH_QUERY_TIMEOUT_MS} ms;`);
    expect(routes).toContain(`the fetch of the pages ends ${FETCH_PHASE_MAX_MS} ms after it begins, or ${FETCH_RESERVE_MS} ms before the deadline when that comes first;`);
    expect(routes).toContain(`the model gets the smaller of ${MODEL_MAX_MS} ms and the time the job has left less ${RESULT_RESERVE_MS} ms, and is not called when that comes to under ${MODEL_MIN_MS} ms.`);
    expect(HEARTBEAT_MS).toBe(60_000);
    expect(routes).toContain('Without it, 401 `{"error":"unauthorized"}`');
    expect(routes).toContain('the server writes an interim `102 Processing` line every 60 s');
    // The line goes to an HTTP/1.1 client only, the answer after it is the same 200, and a job of this service ends well inside the 300 s of silence.
    expect(routes).toContain('to a client that speaks HTTP/1.1, ahead of the answer, which is the same 200 with the same body as it would be without them');
    expect(kitSources.find(({ file }) => file === 'server.ts')?.text).toContain('req.httpVersionMajor === 1 && req.httpVersionMinor >= 1');
    expect(routes).toContain(`A job of this service ends within ${JOB_DEADLINE_MS / 1000} s, well inside that`);
    expect(routes).toContain('| `GET /healthz` | `{"ok":true}` while the service runs: it has no check of its own beyond answering |');
  });

  test('the search, the pages, the model and the check are described with the numbers and the words of the code', () => {
    const text = section('The search, the pages and the model');
    expect([RESULTS_PER_QUERY, MAX_RESULTS]).toStrictEqual([10, 12]);
    expect(text).toContain(`${RESULTS_PER_QUERY} results each`);
    expect(text).toContain('The search makes two queries to the Brave Search API, one after the other');
    expect(text).toContain('since a plan of the Brave Search API may take about one query a second');
    expect(readme).toContain(`fetches up to ${MAX_RESULTS} of the result pages itself`);
    expect(text).toContain(`at most ${MAX_RESULTS} are kept`);
    expect(text).toContain('The results of the second query come first; a result is kept once, by its scheme, host and path, and only with an https URL');
    expect([QUERY_SPACING_MS, MAX_QUERY_CHARS, MAX_QUERY_WORDS]).toStrictEqual([1_100, 400, 50]);
    expect(text).toContain(`one after the other, the second at least ${QUERY_SPACING_MS} ms after the first`);
    expect(text).toContain(`each cut at a word boundary to at most ${MAX_QUERY_CHARS} characters and ${MAX_QUERY_WORDS} words`);
    expect(text).toContain(`A query that answers 429 is asked once more, ${QUERY_SPACING_MS} ms later.`);
    expect(text).toContain('The language of the request is not sent: it is the language the model is asked to write the brief in.');
    expect(text).toContain('The queries are made from the subject and the side, with no language parameter and no country.');
    expect(readme).toContain('sends two queries to the Brave Search API, made from the subject and the side, with no language parameter');
    expect(text).toContain(`four at a time`);
    expect(text).toContain("through the same safe fetch as the MCP server's (https only, no redirect followed, private and reserved addresses refused)");
    expect(FETCH_CONCURRENCY).toBe(4);
    expect(text).toContain(`at most ${PAGE_MAX_BYTES} bytes and ${PAGE_TIMEOUT_MS} ms a page, with the user agent \`${USER_AGENT}\``);
    expect(text).toContain(`has at least ${MIN_PAGE_CHARS} characters; its first ${EXCERPT_CHARS} characters are what the model reads and what the check searches`);
    expect(text).toContain(`at most ${SHAPES.short.maxTokens} tokens for \`short\` and ${SHAPES.standard.maxTokens} for \`standard\``);
    expect(text).toContain(`a thesis and ${SHAPES.short.maxArguments} arguments for \`short\` or ${SHAPES.standard.minArguments} to ${SHAPES.standard.maxArguments} for \`standard\``);
    expect(text).toContain(`each with a quote of ${QUOTE_MIN_CHARS} to ${QUOTE_MAX_CHARS} characters copied from that page`);
    expect(text).toContain('a fixed prompt that asks for the strongest brief for the side');
    expect(text).toContain('The result names the model `<model> via OpenRouter`; the receipt names `advocate-v1`.');
    expect(text).toContain('with `temperature` 0, a JSON answer');
    expect(textOf('src/model.ts')).toContain('temperature: 0,');
    expect(textOf('src/model.ts')).toContain("response_format: { type: 'json_object' }");
    expect(text).toContain('The check can leave fewer arguments than were asked for, and a job that keeps none fails.');
    expect(text).toContain(`\`OPENROUTER_MODEL\`, \`${DEFAULT_MODEL}\` unless the setting names another`);
    const check = section('The check');
    expect(check).toContain(`is ${QUOTE_MIN_CHARS} to ${QUOTE_MAX_CHARS} characters long and is found in the normalised excerpt of that page`);
    expect(check).toContain(`the statement \`${DECLARED_BIAS_STATEMENT}\`, and \`omitted_by_design\`, \`${OMITTED_BY_DESIGN}\``);
    expect(check).toContain('A job whose every argument is dropped fails with `no_supported_claims` (502).');
    expect(check).toContain('A quote that fails is dropped, an argument left with no quote is dropped, and the thesis stays.');
    expect(check).toContain('(Unicode NFKC, lower case, the curly apostrophes and quotes made straight, the dashes U+2013 and U+2014 made hyphens, whitespace collapsed)');
    expect(check).toContain('with the side as the intake keeps it (`for` and `against` in lower case, a position as given)');
  });

  test('Errors names the fixed message of a job that fails at a third party or in the check, and the server answers every code of a job as the README says', async () => {
    const errors = section('Errors');
    expect(errors).toContain('A job that fails at a third party or in the check (the 502 row) gets a fixed message');
    expect(errors).toContain('A job cut at its deadline (`deadline`, 422) keeps its words');
    expect(errors).toContain('`aborted` (499) is the answer to a caller that has hung up, which nobody reads.');
    expect(errors).toContain('because the runtime copies the first 200 characters of a failure to the buyer');
    for (const code of Object.keys(JOB_STATUS) as JobCode[]) expect(new AdvocateError(code, 'x').message, code).toBe(`The service could not do this job (${code}). The operator's log has the detail.`);
    // What the real server answers for each code of a job: the fixed message for the 502 row, and the words the job was given for the 422 and the 499.
    const manifest = manifestFromEnv({ OPERATOR_CONTACT: 'ops@example.test' });
    const answerTo = (error: Error) => serve({ manifest, deps: baseDeps(), log: () => undefined, runAdvocate: async () => { throw error; } }, async (api) => {
      const r = await api.post(wire(GOLDEN_REQUEST));
      return { status: r.status, json: r.json };
    });
    for (const code of Object.keys(JOB_STATUS) as JobCode[]) {
      const answer = await answerTo(new AdvocateError(code, `the words of ${code}`));
      expect([answer.status, answer.json], code).toStrictEqual([JOB_STATUS[code], { error: code, message: JOB_STATUS[code] === 502 ? operatorsText(code) : `the words of ${code}` }]);
    }
    // What the log keeps of each: the whole detail for the 502 row, and for the 422 and the 499 the code, the status and the time, not the words (the 499 row says so).
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
    expect(errors).toContain('`shutting_down` says in words that the service is stopping.');
    expect(errors).toContain('Anything else is 500 `{"error":"internal"}` with no detail');
    expect(errors).toContain('The 401 has no message at all.');
    // The 500 and the 401 have the code and no message; the 503 says in words that the service is stopping; the 400s and the 401 come before anything is searched or fetched.
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
    expect(errors).toContain('The 400s and the 401 come before anything is searched or fetched.');
    // The two open routes are matched on their path, whatever the query string; a HEAD gets the headers, the content-length included, and no body; a POST with a query string is not found.
    await serve({ manifest, deps: baseDeps(), log: () => undefined }, async (api) => {
      expect([(await api.get('/healthz?x=1')).status, (await api.get('/agent.json?x=1')).status]).toStrictEqual([200, 200]);
      const head = await api.request('HEAD', '/healthz');
      expect([head.status, head.text, head.headers.get('content-length')]).toStrictEqual([200, '', String(Buffer.byteLength('{"ok":true}'))]);
      expect((await api.request('POST', '/?x=1', wire(GOLDEN_REQUEST))).status).toBe(404);
    });
    expect(section('Routes')).toContain('are matched on their path, whatever the query string, and a `HEAD` of either gets the headers of the `GET`, its `content-length` included, and no body');
    expect(await serve({ manifest, deps: baseDeps(), log: () => undefined }, async (api) => (await api.post(wire({ subject: '', side: 'for' }))).status)).toBe(400);
  });

  test('Stopping and Image say what the compose file and the Dockerfile say', () => {
    const compose = textOf('../../deploy/host/docker-compose.advocate.yml');
    const dockerfile = textOf('Dockerfile');
    expect(compose).toContain('stop_grace_period: 330s');
    expect(SHUTDOWN_WAIT_MS / 1000 + 30).toBe(330);
    expect(section('Stopping')).toContain('`stop_grace_period` in the compose file is 330 s: the 300 s of the wait and 30 s more');
    expect(section('Stopping')).toContain(`A job ends within ${JOB_DEADLINE_MS / 1000} s of its arrival`);
    expect(compose).toContain('mem_limit: 1024m');
    expect(section('Image')).toContain('the compose file gives it 1024m');
    expect(dockerfile).toMatch(/^FROM node:22-bookworm-slim\b/m);
    expect(section('Image')).toContain('builds the service image on `node:22-bookworm-slim`');
    expect(dockerfile).toContain(`EXPOSE ${PORT_DEFAULT}`);
    expect(section('Image')).toContain(`listens on ${PORT_DEFAULT}`);
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).not.toMatch(/^VOLUME /m);
    expect(dockerfile).toMatch(/^HEALTHCHECK .*\/healthz/m);
    expect(section('Image')).toContain('answers `/healthz` for its health check');
    const instructions = dockerfile.split('\n').filter((line) => !line.startsWith('#')).join('\n');
    expect(instructions, 'its comments say what it has not; its instructions name none of it').not.toMatch(/python|whisper/i);
    expect(section('Image')).toContain('runs as the `node` user under `tini`');
    expect(section('Image')).toContain('It has no volume, no Python and no model');
  });

  test("the statuses of the codes the kit answers with are the kit's, read from packages/service-kit", () => {
    const kitServer = kitSources.find(({ file }) => file === 'server.ts')?.text ?? '';
    const sent = (code: string): number => Number(new RegExp(`send\\((\\d{3}), \\{ error: '${code}'`).exec(kitServer)?.[1]);
    const statuses: Record<string, number> = {
      bad_wire: new WireError('bad_wire', 'x').status, request_too_large: new WireError('request_too_large', 'x').status, unauthorized: sent('unauthorized'),
      shutting_down: sent('shutting_down'), internal: sent('internal'), busy: sent('busy'), not_found: sent('not_found'),
    };
    expect(statuses).toStrictEqual({ bad_wire: 400, request_too_large: 400, unauthorized: 401, shutting_down: 503, internal: 500, busy: 409, not_found: 404 });
    const rows = section('Errors').split('\n').filter((line) => /^\| \d{3}, /.test(line));
    for (const code of ['bad_wire', 'request_too_large', 'unauthorized', 'shutting_down', 'internal']) {
      expect(rows.find((line) => ticks(line.split('|')[2]).includes(code)), code).toMatch(new RegExp(`^\\| ${statuses[code]}, `));
    }
    expect(section('Routes')).toContain(`gets ${statuses.busy} \`{"error":"busy"}\``);
    expect(section('Routes')).toContain(`| any other route | ${statuses.not_found} \`{"error":"not_found"}\` |`);
    expect(section('Routes')).toContain(`gets ${statuses.unauthorized} \`{"error":"unauthorized"}\``);
    expect(kitServer).toContain('timingSafeEqual(digest(given), expectedAuth)');
    expect(kitServer).toContain('const REFUSAL_LOG_MS = 60_000;');
    expect(section('Routes')).toContain('The two values are compared in constant time (`crypto.timingSafeEqual` on their sha256 digests), and a refusal is logged once a minute at most');
  });

  test('the Manifest section names the four placeholders of the template and the script that renders it, and Tests names files that exist', () => {
    expect(Object.values(TEMPLATE_ENV)).toStrictEqual(['<OPERATOR_CONTACT>', '<AGENT_DID>', '<SUPPLIER_PKH>', '<SUPPLIER_PUB_KEY_HEX>']);
    for (const placeholder of Object.values(TEMPLATE_ENV)) expect(readme, placeholder).toContain(`\`${placeholder}\``);
    expect(JSON.parse(textOf('package.json')).scripts.template).toBe('node --import tsx scripts/render-template.mjs');
    expect(section('Manifest')).toContain('`pnpm --filter @vsa/advocate template`');
    expect(section('Manifest')).toContain('The advert `detail_uri` points at `GET /agent.json` and its `detail_hash` is the sha256 of the bytes served there.');
    expect(existsSync(here('scripts/render-template.mjs'))).toBe(true);
    expect(section('Manifest')).toContain('with the four placeholders');
    expect(section('Tests')).toContain('The Brave Search API, the result pages and OpenRouter are stand-ins');
    for (const path of ['test/fake-fetch.ts', 'test/fixtures']) {
      expect(section('Tests'), path).toContain(path);
      expect(existsSync(here(path)), path).toBe(true);
    }
  });

  test('the other sentences of the README that state a claim are held word for word, and to the code or the file that has the claim where there is one', async () => {
    const holds = (text: string, sentences: readonly string[]): void => { for (const sentence of sentences) expect(text, sentence).toContain(sentence); };
    const manifest = manifestFromEnv({ OPERATOR_CONTACT: 'ops@example.test' });
    const quiet = { manifest, deps: baseDeps(), log: () => undefined };
    // The head: what is built and what is not, who holds the key, which keys the service holds, and what the template is for.
    holds(readme, [
      'It has no registry record and no advert yet, and no job has run.',
      '`specs/advocate.md` at the repository root is the specification; this page and the manifest describe the code.',
      'The service sits behind the template runtime (`vector-agent-template`, `CAPABILITY_KIND=custom`).',
      'The runtime holds the supplier key, claims the escrow of the hirer and posts the job to this service as the body of `POST /`.',
      'The service holds no chain key and posts nothing. It holds two API keys of third parties, `BRAVE_SEARCH_API_KEY` and `OPENROUTER_API_KEY`.',
      '`agent.json.template` is the manifest with placeholders. The service renders the real manifest from its environment when it starts and serves those bytes at `GET /agent.json`. It never serves the template itself.',
    ]);
    expect(existsSync(here('../../specs/advocate.md'))).toBe(true);
    expect(textOf('../../deploy/host/docker-compose.advocate.yml')).toContain('CAPABILITY_KIND: custom');
    expect(SETTINGS.filter((name) => /PRIV|SEED|SECRET|SKEY/.test(name))).toStrictEqual([]);
    const served = await serve(quiet, async (api) => (await api.request('GET', '/agent.json', undefined, { authorization: null })).text);
    expect(served).toBe(JSON.stringify(manifest));
    expect(served).not.toMatch(/<[A-Z_]+>/);
    // Run it: no other program and no model of its own, and the guards against a secret in the wrong place, to the line of the log of a key that was refused.
    holds(section('Run it'), [
      'It needs no other program and no model of its own.',
      'A secret in the wrong line of an env file is the mistake the start guards against.',
      'Each of the two API keys is looked for in every other setting the same way.',
      'So none of the three is in a message, a log line or an answer, and the manifest is searched for all three once more before the service listens.',
      'No message of the service shows a setting that is hex-shaped or long, only its length, and a line of the log about a key that a third party refused gives its HTTP status and never the key.',
      '`SUPPLIER_PUB_KEY_HEX` must be the public key of `SUPPLIER_PKH`, which catches a private key put in its line.',
    ]);
    const lines: string[] = [];
    const braveKey = FULL_ENV.BRAVE_SEARCH_API_KEY;
    const routerKey = FULL_ENV.OPENROUTER_API_KEY;
    const refused = (async () => new Response(null, { status: 401 })) as typeof fetch;
    await expect(searchWeb(queriesFor('Cars in the centre', 'for'), {
      fetchImpl: refused, apiKey: braveKey, clock: Date.now, timeoutMs: 1000, phaseEndMs: Date.now() + 60_000, wait: async () => undefined, log: (line) => { lines.push(line); },
    })).rejects.toMatchObject({ code: 'search_failed' });
    const echoing = (async () => new Response(JSON.stringify({ error: { message: `No auth credentials found for ${routerKey}` } }), { status: 401 })) as typeof fetch;
    await expect(callModel([], { fetchImpl: echoing, apiKey: routerKey, model: DEFAULT_MODEL, maxTokens: 2000, timeoutMs: 1000, log: (line) => { lines.push(line); } })).rejects.toMatchObject({ code: 'model_failed' });
    expect(lines.filter((line) => line.includes('HTTP 401'))).toHaveLength(2);
    for (const key of [braveKey, routerKey]) expect(lines.join('\n').toLowerCase().includes(key.toLowerCase()), 'a key in the log').toBe(false);
    // Routes: the manifest, the wire message, the request JSON and its schema, the answer as the bytes the runtime hashes, the one job at a time, the lines that stop.
    holds(section('Routes'), [
      '| `GET /agent.json` | the manifest, the bytes `JSON.stringify` gives |',
      '| `POST /` | the wire message and nothing else, with the `authorization` header of the runtime. Without it, 401 `{"error":"unauthorized"}` |',
      'The body of `POST /` is the wire message: a one-element array whose `content` is the request JSON as a string, and whose `role` is `user`.',
      'The request JSON is `{ "subject": "...", "side": "for", "audience": "...", "length": "standard", "language": "en" }`, with `subject` and `side` required; the manifest publishes its schema under `interface.request_schema`, and what a schema cannot say under `interface.notes`.',
      'The answer to a job is `JSON.stringify(result)`, serialised once, exactly the bytes the runtime hashes.',
      'The runtime and the service read it from the same env file, and neither blanks it.',
      "`GET /healthz` and `GET /agent.json` need no header: the image's health check sends none, and the manifest is public.",
      'One job runs at a time.',
      'The lines stop when the job ends.',
    ]);
    expect(manifest.interface.request_schema.required).toStrictEqual(['subject', 'side']);
    expect(manifest.interface.notes.length).toBeGreaterThan(0);
    const slot = new JobSlot();
    expect([slot.take(), slot.take()]).toStrictEqual(['taken', 'busy']);
    expect(await serve({ ...quiet, runAdvocate: async () => GOLDEN_OUTCOME }, async (api) => (await api.post(wire(GOLDEN_REQUEST))).text)).toBe(JSON.stringify(GOLDEN_OUTCOME.result));
    // Errors: the form of a refusal, and what a refusal leaves of the service's.
    holds(section('Errors'), [
      'A refusal is `{"error": "<code>", "message": "<words>"}` with the status in the table.',
      "Every refusal locks nothing of the service's: it holds no chain key and posts nothing. The runtime fails the job, and the hirer reclaims the escrow after its `deliver_by`.",
    ]);
    // The check, the stop, the manifest settings, the tests and the image.
    holds(section('The check'), ['The sources of the result are the surviving ones, once for each page and quote, in the order they are first cited.']);
    holds(section('Stopping'), ['A second signal ends the process at once.']);
    holds(section('Manifest'), [
      'Numbers (and `PORT`) must be non-negative integers.',
      'A value that breaks a rule stops the service at start, and the error names the variable.',
      'Adverts are immutable, so a changed manifest means a retired advert and a new one: `OPENROUTER_MODEL` is in it, through the gap that names the model.',
    ]);
    expect(() => loadConfig({ ...FULL_ENV, ADVERT_PRICE_LOVELACE: '-1' })).toThrow(/^environment variable ADVERT_PRICE_LOVELACE must be a non-negative integer/);
    expect(() => loadConfig({ ...FULL_ENV, PORT: 'x' })).toThrow(/^environment variable PORT must be a non-negative integer/);
    const other = manifestFromEnv({ OPERATOR_CONTACT: 'ops@example.test', OPENROUTER_MODEL: 'example/another-model' });
    expect(other.gaps[4]).toContain('example/another-model');
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(manifest));
    holds(section('Tests'), ['The tests need no network and no key.', 'The pages of the fixtures are written by hand, and nothing is downloaded.']);
    holds(section('Image'), ['The build context is the repository root, because the image installs the workspace from the lockfile: `docker build -f agents/advocate/Dockerfile -t vsa/advocate:dev .`.']);
    expect(textOf('Dockerfile')).toContain('build context is the repo root');
    expect(existsSync(here('../../pnpm-lock.yaml'))).toBe(true);
    // The claims about the check, the receipt, the signing and the log, whole where a clause of them was held only in part.
    holds(readme, [
      'drops each quote it does not find in the text of its page and each argument left with none, and answers with the brief, which the runtime hashes into the one receipt it signs.',
      'which is all the service checks, since it signs nothing.',
      'with a count and nothing the caller sent.',
      'the whole message is in the log.',
      'A job cut at its deadline (`deadline`, 422) keeps its words, which are about the time the job had and hold nothing of the request.',
      'Anything else is 500 `{"error":"internal"}` with no detail; the cause is in the log, by message only.',
    ]);
    const internal: string[] = [];
    await serve({ ...quiet, log: (line) => { internal.push(line); }, runAdvocate: async () => { throw new Error('a fault of the code'); } }, async (api) => { await api.post(wire(GOLDEN_REQUEST)); });
    expect(internal.filter((line) => line.startsWith('job failed after ')).map((line) => line.replace(/after \d+ ms/, 'after N ms'))).toStrictEqual(['job failed after N ms: internal error: a fault of the code']);
    // The structure: the header row of every table.
    const readmeLines = readme.split('\n');
    expect(readmeLines.filter((l, i) => l.startsWith('| ') && /^[|][-| ]+[|]$/.test(readmeLines[i + 1] ?? ''))).toStrictEqual(['| Route | Answer |', '| Status | Codes |', '| Variable | Use | Default |']);
  });
});
