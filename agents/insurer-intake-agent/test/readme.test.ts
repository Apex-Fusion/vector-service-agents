// agents/insurer-intake-agent/test/readme.test.ts
// The README names every setting that the service reads, every code that it answers with, and the numbers of its routes, its state, its stop and its image. These tests keep the page and the code from parting:
// a name that the code reads and the table does not name fails, so does a name in the table that no code reads, a code with the wrong status, a code that the sources do not know, and a number that is not the
// code's. Where the README says that the start refuses a value or that a route answers, the test makes the call and checks the answer. No test here uses the network, and no key is real.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { VAULT_PAYER_IDENTITY_SETTINGS, VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, rawHexToBech32 } from '@vsa/buyer-core';
import { STRANDED_FILE } from '@vsa/hire-kit';
import { BUSY_TEXT, CONTEXT_HEADERS, HEARTBEAT_MS, MAX_BODY, RESERVATION_MS, SHUTDOWN_WAIT_MS, STOPPING_TEXT, TOKEN_SEARCH_MIN, operatorsText } from '@vsa/service-kit';
import { SHARED_CHECK_NAMES } from '@vsa/usecase-kit/checks';
import { ATTESTATION_STATES, INTAKE_CHECKS, PRIORAUTH_CAPABILITIES, PRIORAUTH_REQUEST_SCHEMA, parseIntakeRecord } from '@vsa/usecase-kit/priorauth';
import { COUNTERPARTY_REFUSALS, ERROR_STATUS, FAULT_MODES, HANDOFF_SCHEMA, MAX_REQUEST_BYTES, RUNTIME_BODY_LIMIT_BYTES } from '@vsa/usecase-kit/protocol';
import { identityRegistryOf } from '@vsa/vector-read';
import { REPORT_BUDGET_MS as JOB_REPORT_BUDGET_MS } from '../src/job/attest.ts';
import { RUNTIME_MARGIN_MS } from '../src/job/filing.ts';
import { INTAKE_REFUSAL_STATUS } from '../src/job/index.ts';
import { READ_BUDGET_MS, REPORT_BUDGET_MS } from '../src/report/index.ts';
import { BINDING_GAP, COMPLETENESS_GAP, COVERAGE_GAP, LEDGER_GAP, NOT_SHOWN_GAP, REFUSED_GAP, REPORTED_GAP, SYNTHETIC_GAP, UNREADABLE_GAP } from '../src/serve/gaps.ts';
import { KEY_ROLES } from '../src/serve/keys.ts';
import { STATUS_SINCE_DEFAULT, TEMPLATE_ENV, manifestFromEnv, renderTemplate } from '../src/serve/manifest.ts';
import { RequestRefusal } from '../src/serve/server.ts';
import {
  BUYER_BOND_LOVELACE, CALL_TIMEOUT_MS, CHECKS_READ_BUDGET_DEFAULT_MS, CHECKS_READ_BUDGET_MAX_MS, CHECKS_READ_BUDGET_MIN_MS, GATEWAY_DEFAULT, HOOK_READS, HOOK_READS_LIMIT_MS, HOST_DEFAULT, JOB_DEADLINE_MS,
  MAX_PRICE_LOVELACE, MAX_PROCESSING_WINDOW_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, PRICE_DEFAULT_LOVELACE, RUNTIME_PRECHECK_WAIT_MS, STATE_DIR_DEFAULT, SUPPLIER_BOND_LOVELACE,
} from '../src/serve/settings.ts';
import { JANITOR_INTERVAL_MS, JANITOR_STOP_WAIT_MS, SETTINGS, loadConfig, startService, stopOnSignals } from '../src/serve/start.ts';
import type { StartOptions } from '../src/serve/start.ts';
import { wireService } from '../src/serve/wiring.ts';
import { FileIntakeBook, INTAKE_BOOK_LIMIT, MemoryIntakeBook, PASSED_CHECKS_LIMIT, PASSED_CHECKS_TTL_MS } from '../src/store/index.ts';
import { serve, until } from './serve/serve.ts';
import { AGENT_DID, DEPLOYMENT_POLICY, KEY_VARIABLES, MODULE1_COMMIT, MODULE1_URL, SERVICE, SERVICE_ADDRESS, SUPPLIER, TOKEN, cleanDirs, message, module1ManifestText, secretsOf, startEnvWith, tempDir, withModule1 } from './serve/support.ts';
import { INCOMPLETE, headersOf, makeWorld, proposalOf, wire } from './serve/world.ts';
import type { World } from './serve/world.ts';

afterEach(() => { cleanDirs(); });

const root = new URL('../../../', import.meta.url);
const textOf = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const readme = textOf('../README.md');
const template = textOf('../agent.json.template');
const manifest = manifestFromEnv(TEMPLATE_ENV);
const sourceDir = new URL('../src/', import.meta.url);
const sourceFiles: string[] = readdirSync(sourceDir, { recursive: true, encoding: 'utf8' });
const sources = sourceFiles.filter((file) => file.endsWith('.ts')).map((file) => readFileSync(new URL(file, sourceDir), 'utf8'));
const section = (heading: string): string => (readme.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const ticks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
const cellsOf = (line: string): string[] => line.split('|').slice(1, -1).map((cell) => cell.trim());
const settingsRows = (): string[][] => section('Settings').split('\n').filter((line) => /^\| `/.test(line)).map(cellsOf);
/** The cell of the Settings table for one name: 1 is the use, 2 is the default. */
const cell = (name: string, at: 1 | 2): string => settingsRows().find(([names]) => ticks(names).includes(name))?.[at] ?? '';
const throws = (work: () => unknown): boolean => { try { work(); return false; } catch { return true; } };
const errorText = (value: unknown): string => (value instanceof Error ? value.message : String(value));
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const STATUS: Readonly<Record<string, number>> = ERROR_STATUS;
/** The two codes that the shared server answers itself and that `ERROR_STATUS` does not hold: a call with a bad context, and a path or a method that no route takes. */
const SERVER_OWN: Readonly<Record<string, number>> = { bad_context: 400, not_found: 404 };
/** The codes of a request that the service answers besides the refusals of the hook and of the job: the shared server and `RequestRefusal` give them. */
const REQUEST_CODES = ['bad_wire', 'request_too_large', 'bad_shape', 'bad_context', 'unauthorized', 'not_found', 'busy', 'shutting_down', 'check_unavailable', 'internal'] as const;
const KEY_ROW = 'none. The key is required; the key hash is derived when it is not set';
const FAULT_REFUSAL = /^environment variable FAULT_MODE must be empty \(insurer-intake-agent has no fault value\)/;
type Over = Readonly<Record<string, string | undefined>>;

/** The names that the code reads from the environment itself: `env.NAME`, `process.env.NAME`, and the names given to envInt and requiredEnv. */
function namesRead(): string[] {
  const found = new Set<string>();
  for (const text of sources) {
    for (const match of text.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)\b/g)) found.add(match[1]);
    for (const match of text.matchAll(/\b(?:envInt|requiredEnv)\(\s*'([A-Z][A-Z0-9_]*)'/g)) found.add(match[1]);
  }
  return [...found].sort();
}

describe('agents/insurer-intake-agent/README.md: the page and its settings', () => {
  test('line 3 is the description of the manifest and the capability, and line 5 is the status of the manifest', () => {
    const lines = readme.split('\n');
    expect(lines.slice(0, 2)).toStrictEqual([`# ${manifest.name}`, '']);
    expect(lines[2]).toBe(`${manifest.description} Capability \`${PRIORAUTH_CAPABILITIES.intake}\`.`);
    expect(manifest.status).toStrictEqual({ chip: 'proposed', since: STATUS_SINCE_DEFAULT });
    expect(lines[4]).toContain(`Status: \`${manifest.status.chip}\` since ${manifest.status.since}. The service is built.`);
    expect(lines[4]).toContain('It is not deployed, and no job of it has settled.');
    expect(lines[4]).toContain(SYNTHETIC_GAP);
    expect(readme).toContain('use case 2 (prior authorization)');
    // The gap sentences that the page repeats are the sentences of the manifest, word for word.
    for (const gap of [COVERAGE_GAP, COMPLETENESS_GAP, LEDGER_GAP, REPORTED_GAP, REFUSED_GAP, BINDING_GAP, UNREADABLE_GAP]) {
      expect(manifest.gaps, gap).toContain(gap);
      expect(readme, gap).toContain(gap);
    }
    expect(readme).toContain(`It makes ${INTAKE_CHECKS.length} checks, one after the other.`);
    expect([manifest.links.spec, manifest.links.source].every((link) => link.startsWith('https://'))).toBe(true);
    expect(readme).toContain(`the hook keeps the record of the checks for ${PASSED_CHECKS_TTL_MS / 1000} s and reserves the job slot for that escrow for ${RESERVATION_MS / 1000} s`);
  });

  test('the Settings table names each setting of SETTINGS once, and SETTINGS are the names that the code reads and the four identity names that buyer-core reads', () => {
    const documented = settingsRows().flatMap(([names]) => ticks(names)).sort();
    expect(new Set(documented).size, 'a name stands in two rows').toBe(documented.length);
    expect(documented).toStrictEqual([...SETTINGS].sort());
    expect(SETTINGS).toHaveLength(41);
    const read = namesRead();
    expect([...SETTINGS].sort()).toStrictEqual([...new Set([...read, ...VAULT_PAYER_IDENTITY_SETTINGS])].sort());
    // No source of the service writes an identity name: the buyer code takes the four names from its own list, and a value that no reader takes stops the start.
    for (const name of VAULT_PAYER_IDENTITY_SETTINGS) {
      expect(read.includes(name), `${name} stands in no env.NAME`).toBe(false);
      expect(throws(() => loadConfig(startEnvWith({ [name]: undefined }))), name).toBe(true);
      expect(throws(() => loadConfig(startEnvWith({ [name]: 'a\u0001b' }))), name).toBe(true);
    }
  });

  test('the defaults of the table are the code and the manifest', () => {
    const config = loadConfig(startEnvWith());
    const published = JSON.parse(config.manifest.text) as {
      version: string; status: unknown; terms: { price_lovelace: number; max_processing_ms: number }; links: { explorer_advert: string }; identity: { registry_address: string }; behaviour: { fault_modes: unknown };
    };
    expect(cell('PORT', 2)).toBe(`\`${PORT_DEFAULT}\`, \`${HOST_DEFAULT}\``);
    expect(cell('HOST', 2)).toBe(cell('PORT', 2));
    expect([config.port, config.host, config.stateDir]).toStrictEqual([PORT_DEFAULT, HOST_DEFAULT, STATE_DIR_DEFAULT]);
    expect([PORT_DEFAULT, HOST_DEFAULT, STATE_DIR_DEFAULT]).toStrictEqual([9104, '0.0.0.0', '/data']);
    expect(cell('INTAKE_STATE_DIR', 2)).toBe(`\`${STATE_DIR_DEFAULT}\``);
    expect(cell('IDENTITY_GATEWAY_URL', 2)).toBe(`\`${GATEWAY_DEFAULT}\``);
    expect(config.endpoints.gatewayUrl).toBe(GATEWAY_DEFAULT);
    expect(cell('ADVERT_PRICE_LOVELACE', 2)).toBe(`\`${PRICE_DEFAULT_LOVELACE}\``);
    expect(cell('ADVERT_MAX_PROCESSING_MS', 2)).toBe(`\`${MIN_PROCESSING_WINDOW_MS}\``);
    expect([published.terms.price_lovelace, published.terms.max_processing_ms]).toStrictEqual([PRICE_DEFAULT_LOVELACE, MIN_PROCESSING_WINDOW_MS]);
    expect(cell('CHECKS_READ_BUDGET_MS', 2)).toBe(`\`${CHECKS_READ_BUDGET_DEFAULT_MS}\``);
    expect(config.checksBudgetMs).toBe(CHECKS_READ_BUDGET_DEFAULT_MS);
    expect([cell('AGENT_VERSION', 2), cell('AGENT_STATUS_CHIP', 2), cell('AGENT_STATUS_SINCE', 2)]).toStrictEqual([`\`${manifest.version}\``, `\`${manifest.status.chip}\``, `\`${manifest.status.since}\``]);
    expect([published.version, published.status]).toStrictEqual([manifest.version, manifest.status]);
    expect(JSON.parse(template)).toMatchObject({ version: manifest.version, status: manifest.status });
    expect([cell('ADVERT_EXPLORER_URL', 2), cell('FAULT_MODE', 2)]).toStrictEqual(['empty', 'empty']);
    expect(published.links.explorer_advert).toBe('');
    expect(cell('IDENTITY_ADDRESS', 2)).toBe('derived from the policy');
    expect(published.identity.registry_address).toBe(identityRegistryOf(DEPLOYMENT_POLICY, undefined)?.address);
    for (const name of ['VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL']) expect(cell(name, 2), name).toBe('the default of `packages/buyer-core`');
    expect([config.endpoints.ogmiosUrl, config.endpoints.koiosUrl, config.endpoints.submitUrl, config.endpoints.indexerUrl]).toStrictEqual([VECTOR_OGMIOS_URL, VECTOR_KOIOS_URL, VECTOR_SUBMIT_URL, undefined]);
    // The two optional settings of the dispute code are left to the dispute code: its lease is 10 min, or twice the read timeout when that is more, and its deadline is the one of the deployment.
    expect(cell('DISPUTE_STARTED_LEASE_MS', 2)).toBe('10 min, or twice `DISPUTE_READ_TIMEOUT_MS` when that is more');
    expect(cell('DISPUTE_RESOLUTION_DEADLINE_MS', 2)).toBe('the deadline of the deployment');
    expect(textOf('../../../packages/usecase-kit/src/dispute/dispute.ts')).toContain('const STARTED_LEASE_MS = 600_000;');
    expect(Object.keys(config.dispute)).toStrictEqual(['challenge_stake_lovelace', 'min_window_left_ms', 'read_timeout_ms']);
    // The advert holds the hash of the bytes that the service serves, and the manifest lists no fault value.
    expect(config.manifest.sha256).toBe(sha256(config.manifest.text));
    expect(published.behaviour.fault_modes).toStrictEqual([]);
    expect(template).toBe(renderTemplate());
    // Each member of the manifest that the page names is in the manifest that the service serves. The fenced blocks are left out first: their three backticks would mispair the others.
    const prose = readme.replaceAll(/```[\s\S]*?```/g, '');
    const named = [...new Set(ticks(prose).filter((word) => /^(operator|identity|keys|terms|links|status|interface|behaviour)(\.[a-z_]+)+$|^version$/.test(word)))];
    expect(named.length).toBeGreaterThan(10);
    for (const path of named) {
      const found = path.split('.').reduce<unknown>((value, step) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[step] : undefined), published);
      expect(found, path).toBeDefined();
    }
  });

  test('a setting that the table calls required stops the start when it is missing, and no other setting does', () => {
    expect(() => loadConfig(startEnvWith())).not.toThrow();
    const rows = settingsRows();
    const required = rows.filter(([, , standard]) => standard === 'none. Required').flatMap(([names]) => ticks(names));
    const keys = rows.filter(([, , standard]) => standard === KEY_ROW).map(([names]) => ticks(names)[0]);
    expect(required).toHaveLength(20);
    expect(keys).toStrictEqual([KEY_VARIABLES.service]);
    // The settings that stop the start when they are missing are the settings that the table calls required and the key: each other setting has a default or does without.
    const stops = SETTINGS.filter((name) => throws(() => loadConfig(startEnvWith({ [name]: undefined }))));
    expect([...stops].sort()).toStrictEqual([...required, ...keys].sort());
    expect(stops).toHaveLength(21);
  });

  test('a key hash is optional and checked when it is set, and the manifest publishes the key hash of the service key', () => {
    const [names] = settingsRows().find(([, , standard]) => standard === KEY_ROW) ?? [''];
    expect(ticks(names)).toStrictEqual([KEY_VARIABLES.service, 'INTAKE_SERVICE_PKH']);
    expect(KEY_ROLES).toStrictEqual(['service']);
    expect(readme).toContain('The service holds one key: the service key.');
    expect(() => loadConfig(startEnvWith({ INTAKE_SERVICE_PKH: undefined }))).not.toThrow();
    expect(() => loadConfig(startEnvWith({ INTAKE_SERVICE_PKH: SERVICE.pkh }))).not.toThrow();
    expect(() => loadConfig(startEnvWith({ INTAKE_SERVICE_PKH: '0'.repeat(56) }))).toThrow();
    const published = JSON.parse(loadConfig(startEnvWith({ INTAKE_SERVICE_PKH: undefined })).manifest.text) as { keys: { buyer_pkh: string; supplier_pkh: string } };
    expect([published.keys.buyer_pkh, published.keys.supplier_pkh]).toStrictEqual([SERVICE.pkh, SUPPLIER.pkh]);
    expect(cell(KEY_VARIABLES.service, 1)).toContain('Its key hash is `keys.buyer_pkh`');
    expect(section('Settings')).toContain('`INTAKE_SERVICE_PKH` is optional. When it is set, it must be the key hash of the service key, and the service stops at start when it is not.');
  });

  test('the ranges, the forms and the one fault value of the table are the code, each with the value beside it that the start takes', () => {
    expect(cell('OPERATOR_CONTACT', 1)).toContain('at most 200 characters');
    expect(cell('PORT', 1)).toContain('a whole number from 0 to 65535');
    expect(cell('ADVERT_PRICE_LOVELACE', 1)).toContain(`at most ${MAX_PRICE_LOVELACE}`);
    expect(cell('ADVERT_MAX_PROCESSING_MS', 1)).toContain(`From ${MIN_PROCESSING_WINDOW_MS} to ${MAX_PROCESSING_WINDOW_MS}`);
    expect(cell('CHECKS_READ_BUDGET_MS', 1)).toContain(`A whole number from ${CHECKS_READ_BUDGET_MIN_MS} to ${CHECKS_READ_BUDGET_MAX_MS}: six reads must stay under ${HOOK_READS_LIMIT_MS} ms`);
    expect(cell('DISPUTE_MIN_WINDOW_LEFT_MS', 1)).toContain('At least 2000');
    expect(cell('DISPUTE_STARTED_LEASE_MS', 1)).toContain('At least twice `DISPUTE_READ_TIMEOUT_MS`');
    expect(cell('AGENT_STATUS_CHIP', 1)).toContain('in lower case. It must be live, deployed or proposed, in any case');
    expect(cell('ADVERT_EXPLORER_URL', 1)).toContain('an https address with no user and no password');
    expect(cell('LLM_MAX_PRICE_LOVELACE', 1)).toContain('a whole number of more than 0');
    // The lengths that the rows give are the lengths of the values that the start takes.
    expect(cell('IDENTITY_POLICY_ID', 1)).toContain(`${DEPLOYMENT_POLICY.length} lowercase hex characters`);
    expect(cell('AGENT_DID', 1)).toContain(`\`did:vector:\` and ${AGENT_DID.length - 'did:vector:'.length} lowercase hex characters`);
    expect(cell(KEY_VARIABLES.service, 1)).toContain(`${SERVICE.privateKeyHex.length} lowercase hex characters`);
    const credentialChars = TOKEN.length - 'Bearer '.length;
    expect(cell('SERVICE_AUTH_HEADER', 1)).toContain(`\`Bearer \` and ${credentialChars} hex characters, made with \`openssl rand -hex ${credentialChars / 2}\``);
    const holds: Array<[Over, boolean]> = [
      [{ OPERATOR_CONTACT: 'x'.repeat(200) }, true], [{ OPERATOR_CONTACT: 'x'.repeat(201) }, false],
      [{ PORT: '65535' }, true], [{ PORT: '65536' }, false],
      [{ ADVERT_PRICE_LOVELACE: String(MAX_PRICE_LOVELACE) }, true], [{ ADVERT_PRICE_LOVELACE: String(MAX_PRICE_LOVELACE + 1) }, false], [{ ADVERT_PRICE_LOVELACE: '0' }, false],
      [{ ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS) }, true], [{ ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS - 1) }, false],
      [{ ADVERT_MAX_PROCESSING_MS: String(MAX_PROCESSING_WINDOW_MS) }, true], [{ ADVERT_MAX_PROCESSING_MS: String(MAX_PROCESSING_WINDOW_MS + 1) }, false],
      [{ CHECKS_READ_BUDGET_MS: String(CHECKS_READ_BUDGET_MIN_MS) }, true], [{ CHECKS_READ_BUDGET_MS: String(CHECKS_READ_BUDGET_MIN_MS - 1) }, false],
      [{ CHECKS_READ_BUDGET_MS: String(CHECKS_READ_BUDGET_MAX_MS) }, true], [{ CHECKS_READ_BUDGET_MS: String(CHECKS_READ_BUDGET_MAX_MS + 1) }, false],
      [{ DISPUTE_MIN_WINDOW_LEFT_MS: '2000' }, true], [{ DISPUTE_MIN_WINDOW_LEFT_MS: '1999' }, false],
      [{ DISPUTE_STARTED_LEASE_MS: '40000' }, true], [{ DISPUTE_STARTED_LEASE_MS: '39999' }, false],
      [{ AGENT_STATUS_CHIP: 'LIVE' }, true], [{ AGENT_STATUS_CHIP: 'retired' }, false],
      [{ AGENT_STATUS_SINCE: '2026-12-01' }, true], [{ AGENT_STATUS_SINCE: '2026-11-31' }, false], [{ AGENT_STATUS_SINCE: '1 Dec 2026' }, false],
      [{ ADVERT_EXPLORER_URL: 'https://explorer.example.test/advert/1' }, true], [{ ADVERT_EXPLORER_URL: 'http://explorer.example.test/advert/1' }, false],
      [{ IDENTITY_ADDRESS: identityRegistryOf(DEPLOYMENT_POLICY, undefined)?.address }, true], [{ IDENTITY_ADDRESS: SERVICE_ADDRESS }, false],
      [{ LLM_MAX_PRICE_LOVELACE: '1' }, true], [{ LLM_MAX_PRICE_LOVELACE: '0' }, false],
      [{ LLM_MAX_SUPPLIER_BOND_LOVELACE: '1' }, true], [{ LLM_MAX_SUPPLIER_BOND_LOVELACE: '0' }, false], [{ LLM_MAX_BUYER_BOND_LOVELACE: '0' }, false],
      [{ AGENT_DID: 'did:vector:abc' }, false], [{ IDENTITY_POLICY_ID: DEPLOYMENT_POLICY.slice(1) }, false],
      [{ SERVICE_AUTH_HEADER: `Bearer ${'ab'.repeat(32)}` }, true], [{ SERVICE_AUTH_HEADER: `Bearer ${'\u00e9'.repeat(32)}` }, false],
      [{ MOCK_MTLS_BASE: 'https://mock.example.test' }, false], [{ MOCK_PUBLIC_BASE: 'http://mock.example.test' }, false],
      [{ IDENTITY_GATEWAY_URL: 'https://gateway.example.test' }, true], [{ IDENTITY_GATEWAY_URL: 'http://gateway.example.test' }, false],
      [{ INTAKE_STATE_DIR: '/var/lib/intake' }, true], [{ INTAKE_STATE_DIR: 'relative/dir' }, false],
    ];
    for (const [over, accepted] of holds) expect(throws(() => loadConfig(startEnvWith(over))), JSON.stringify(over)).toBe(!accepted);
    expect(cell('LLM_MODEL_ALLOWLIST', 1)).toContain('each of letters, digits, dots, underscores, colons, slashes and hyphens');
    expect(throws(() => loadConfig(startEnvWith({ LLM_MODEL_ALLOWLIST: 'a model with spaces' })))).toBe(true);
    expect(throws(() => loadConfig(startEnvWith({ LLM_MODEL_ALLOWLIST: 'vendor/model-1.5:free, other_model' })))).toBe(false);
    // The terms are fixed: the lock of an escrow is the price and both bonds.
    expect(PRICE_DEFAULT_LOVELACE + SUPPLIER_BOND_LOVELACE + BUYER_BOND_LOVELACE).toBe(4_000_000);
    expect(section('Settings')).toContain(`each bond is ${SUPPLIER_BOND_LOVELACE} lovelace, and the lock is 4000000 lovelace for the default price`);
    // The one fault value is none: the setting is empty or not set, and any value of any kind of agent, or a value that no kind has, stops the start.
    expect(cell('FAULT_MODE', 1)).toContain('so the setting must be empty. Any other value stops the start');
    expect(FAULT_MODES['insurer-intake-agent']).toStrictEqual([]);
    for (const value of ['alter_after_approval', 'confirm_wrong_lot', 'quote_off_price_list', 'invert_scores', 'yes', ' ']) expect(message(() => loadConfig(startEnvWith({ FAULT_MODE: value }))), value).toMatch(FAULT_REFUSAL);
    for (const value of [undefined, '']) expect(() => loadConfig(startEnvWith({ FAULT_MODE: value }))).not.toThrow();
  });

  test('the placeholders of the template are named in the README and are settings', () => {
    const placeholders = [...new Set([...template.matchAll(/<([A-Z0-9_]+)>/g)].map((match) => match[1]))].sort();
    expect(placeholders).toStrictEqual(['AGENT_DID', 'INTAKE_SERVICE_PKH', 'OPERATOR_CONTACT', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX']);
    for (const name of placeholders) {
      expect(readme, name).toContain(`\`<${name}>\``);
      expect(SETTINGS as readonly string[], name).toContain(name);
    }
  });
});

describe('agents/insurer-intake-agent/README.md: Run it', () => {
  const run = section('Run it');

  /** Starts the service on a world, with `over` on its environment and `options` over its parts, and gives the error it stops with, or the word `accepted` when it starts (and stops it again). */
  const started = async (over: Over, options: (world: World) => StartOptions = () => ({})): Promise<{ result: string; world: World }> => {
    const world = makeWorld();
    const result = await startService({ ...world.env, ...over }, { ...world.options, ...options(world) }).then(async (service) => { await service.stop(); return 'accepted'; }, (reason: unknown) => errorText(reason));
    return { result, world };
  };

  test('it names the commands of the package, the two secrets that the operator makes, and the refusals of the start that come from a setting, each with its accepted twin', () => {
    expect(run).toContain('The service needs Node 22 or later');
    expect(JSON.parse(textOf('../../../package.json')).engines.node).toBe('>=22');
    const pack = JSON.parse(textOf('../package.json')) as { name: string; scripts: Record<string, string> };
    expect(pack.name).toBe('@vsa/insurer-intake-agent');
    expect([pack.scripts.start, pack.scripts.template, pack.scripts.test]).toStrictEqual(['tsx src/index.ts', 'node --import tsx scripts/render-template.mjs', 'vitest run']);
    expect(existsSync(new URL('../scripts/render-template.mjs', import.meta.url))).toBe(true);
    for (const command of ['start', 'template']) expect(run).toContain(`pnpm --filter @vsa/insurer-intake-agent ${command}`);
    expect(run).toContain('read -rs INTAKE_SERVICE_PRIV_KEY_HEX && export INTAKE_SERVICE_PRIV_KEY_HEX');
    expect(run).toContain('export SERVICE_AUTH_HEADER="Bearer $(openssl rand -hex 32)"');
    expect(run).toContain(`INTAKE_STATE_DIR=/tmp/insurer-intake-state PORT=${PORT_DEFAULT} pnpm --filter @vsa/insurer-intake-agent start`);
    expect(run).toContain('The service reads the settings of the table below and no others. It listens on `PORT` (default 9104).');
    expect(run).toContain('It keeps `requests.json`, `dispute/` and `keys/<key hash>/` in `INTAKE_STATE_DIR` (default `/data`, the volume of the image).');
    expect(run).toContain('`FAULT_MODE` must be empty: the agent has no fault value.');
    expect(run).toContain(`\`CHECKS_READ_BUDGET_MS\` is from ${CHECKS_READ_BUDGET_MIN_MS} to ${CHECKS_READ_BUDGET_MAX_MS} (default ${CHECKS_READ_BUDGET_DEFAULT_MS}).`);
    const refusals: ReadonlyArray<readonly [says: string, over: Over, error: RegExp, twin: Over]> = [
      ['when a required setting is not set', { OPERATOR_CONTACT: undefined }, /^environment variable OPERATOR_CONTACT is required/, { OPERATOR_CONTACT: 'ops@example.test' }],
      ['when a setting is not well formed', { PORT: '70000' }, /^environment variable PORT must be a port/, { PORT: '9104' }],
      [
        'when `INTAKE_SERVICE_PKH` is not the key hash of the service key', { INTAKE_SERVICE_PKH: 'ab'.repeat(28) },
        /^environment variable INTAKE_SERVICE_PKH \(56 characters\) is not the key hash of the key in INTAKE_SERVICE_PRIV_KEY_HEX/, { INTAKE_SERVICE_PKH: SERVICE.pkh },
      ],
      [
        'when the service key is the supplier key', { SUPPLIER_PKH: SERVICE.pkh, SUPPLIER_PUB_KEY_HEX: SERVICE.pubKeyHex },
        /^environment variable INTAKE_SERVICE_PRIV_KEY_HEX holds the key of SUPPLIER_PKH/, { SUPPLIER_PKH: SUPPLIER.pkh, SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex },
      ],
      [
        'when `SUPPLIER_PUB_KEY_HEX` is not the public key of `SUPPLIER_PKH`', { SUPPLIER_PUB_KEY_HEX: SERVICE.pubKeyHex }, /^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/,
        { SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex },
      ],
      ['when `FAULT_MODE` is not empty', { FAULT_MODE: 'alter_after_approval' }, FAULT_REFUSAL, { FAULT_MODE: '' }],
      [
        `when \`CHECKS_READ_BUDGET_MS\` is not from ${CHECKS_READ_BUDGET_MIN_MS} to ${CHECKS_READ_BUDGET_MAX_MS}`, { CHECKS_READ_BUDGET_MS: String(CHECKS_READ_BUDGET_MAX_MS + 1) },
        new RegExp(`^environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from ${CHECKS_READ_BUDGET_MIN_MS} to ${CHECKS_READ_BUDGET_MAX_MS}`), { CHECKS_READ_BUDGET_MS: String(CHECKS_READ_BUDGET_MAX_MS) },
      ],
      [
        `when \`ADVERT_MAX_PROCESSING_MS\` is below ${MIN_PROCESSING_WINDOW_MS}`, { ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS - 1) },
        new RegExp(`^environment variable ADVERT_MAX_PROCESSING_MS must be at least ${MIN_PROCESSING_WINDOW_MS}`), { ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS) },
      ],
      [
        'when the key or the token stands in the wrong line', { OPERATOR_CONTACT: SERVICE.privateKeyHex },
        /^environment variable OPERATOR_CONTACT holds the service key, which belongs in INTAKE_SERVICE_PRIV_KEY_HEX alone/, {},
      ],
      ['when `VECTOR_OGMIOS_URL` is not an https address', { VECTOR_OGMIOS_URL: 'http://node.example.test' }, /^environment variable VECTOR_OGMIOS_URL must be an https address/, { VECTOR_OGMIOS_URL: 'https://node.example.test' }],
      [
        'when `VECTOR_MODULE1_MANIFEST` is not an https address pinned to a commit', { VECTOR_MODULE1_MANIFEST: MODULE1_URL.split(MODULE1_COMMIT).join('main') },
        /^environment variable VECTOR_MODULE1_MANIFEST must be pinned to a commit/, { VECTOR_MODULE1_MANIFEST: MODULE1_URL },
      ],
      ['when `IDENTITY_POLICY_ID` is not the policy that `VECTOR_IDENTITY_LEGACY_ROOT` and `VECTOR_IDENTITY_CONFIG_SEED` give', { IDENTITY_POLICY_ID: 'ab'.repeat(28) }, /^environment variable IDENTITY_POLICY_ID is not the identity policy that VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED give/, {}],
    ];
    for (const [says, over, error, twin] of refusals) {
      expect(run, says).toContain(says);
      expect(message(() => loadConfig(startEnvWith(over))), says).toMatch(error);
      expect(() => loadConfig(startEnvWith(twin)), `the twin of ${says}`).not.toThrow();
    }
    // The forms of the address of the Module-1 manifest that the start refuses, and the form that it takes.
    const forms: Array<[string, string]> = [
      ['a file path', '/etc/module1/manifest.json'], ['an http address', `http://203.0.113.9/modules/${MODULE1_COMMIT}/manifest.json`], ['an address with a user', `https://user@203.0.113.9/modules/${MODULE1_COMMIT}/manifest.json`],
      ['an address with a query', `${MODULE1_URL}?x=1`], ['an address with a fragment', `${MODULE1_URL}#x`], ['an address with no commit', 'https://203.0.113.9/modules/main/Module-1/manifest.json'],
    ];
    for (const [what, value] of forms) expect(throws(() => loadConfig(startEnvWith({ VECTOR_MODULE1_MANIFEST: value }))), what).toBe(true);
    expect(() => loadConfig(startEnvWith({ VECTOR_MODULE1_MANIFEST: `https://203.0.113.9/modules/${'ab'.repeat(20)}/manifest.json` }))).not.toThrow();
    expect(run).toContain('`VECTOR_MODULE1_MANIFEST` must be an `https://` address with a path segment of 40 lowercase hex characters, the commit that the manifest was published at.');
    expect(run).toContain('A file path, an `http://` address, an address with a user, a query or a fragment, and an address with no commit stop the start.');
    expect(MODULE1_COMMIT).toHaveLength(40);
  });

  test('it names the refusals that the start makes once it has read the settings, the line that a good start logs, and the one fetch of the start', async () => {
    const lines = [
      'when the Module-1 manifest cannot be fetched', 'when the Module-1 manifest names another identity registry', 'when `DISPUTE_RESOLUTION_DEADLINE_MS` is not the deadline of the deployment', 'when the state directory cannot be written',
    ];
    for (const says of lines) expect(run, says).toContain(says);
    const file = join(tempDir(), 'a-file');
    writeFileSync(file, 'not a directory', 'utf8');
    const refusals: ReadonlyArray<readonly [Over, (world: World) => StartOptions, RegExp]> = [
      [{}, (world) => ({ fetchImpl: withModule1(world.options.fetchImpl!, { status: 404 }), module1Port: undefined }), new RegExp(`^The Module-1 manifest \\(VECTOR_MODULE1_MANIFEST\\) ${MODULE1_URL.replaceAll('.', '\\.')} cannot be fetched: the host answered HTTP 404\\.$`)],
      [{}, (world) => ({ fetchImpl: withModule1(world.options.fetchImpl!, module1ManifestText('ab'.repeat(28))), module1Port: undefined }), /^the Module-1 manifest names the identity registry (ab){28}, but the identity deployment of this service is [0-9a-f]{56}/],
      [{ DISPUTE_RESOLUTION_DEADLINE_MS: '259200001' }, () => ({}), /the Module-1 deployment has 259200000 ms/],
      [{ INTAKE_STATE_DIR: join(file, 'state') }, () => ({}), /^environment variable INTAKE_STATE_DIR names .* which cannot be written/],
    ];
    for (const [over, options, error] of refusals) {
      const { result, world } = await started(over, options);
      expect(result, JSON.stringify(over)).toMatch(error);
      expect(world.logs.filter((line) => line.startsWith('listening on')), 'no listening line').toStrictEqual([]);
    }
    // The twins: the manifest at its address, and the deadline of the deployment.
    expect((await started({}, () => ({ module1Port: undefined }))).result).toBe('accepted');
    expect((await started({ DISPUTE_RESOLUTION_DEADLINE_MS: '259200000' })).result).toBe('accepted');
    const world = makeWorld();
    const service = await startService(world.env, world.options);
    try {
      const listening = world.logs.filter((line) => line.startsWith('listening on '));
      expect(listening).toStrictEqual([`listening on 127.0.0.1:${service.port}; service address ${SERVICE_ADDRESS}; state directory ${world.stateDir}`]);
    } finally {
      await service.stop();
    }
    expect(run).toContain('The service logs one `listening` line. It holds the address and the port, the address of the service key and the state directory.');
    expect(run).toContain('At start the service makes one fetch: the Module-1 manifest, from its pinned address. The fetch has a limit of 20 s.');
    expect(textOf('../../../packages/buyer-core/src/vendored/mcp/jury-deployment.ts')).toContain('maxResponseBytes: MANIFEST_MAX_BYTES, timeoutMs: 20_000');
    // The one fetch of the start is the Module-1 manifest at its pinned address, and the start reads no wallet: a chain that gives none does not stop it.
    const quiet = makeWorld();
    quiet.m.chain.wallet = async () => { throw new Error('the node does not answer'); };
    const fetched: string[] = [];
    const counting: typeof fetch = async (input, init) => {
      fetched.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).href);
      return quiet.options.fetchImpl!(input, init);
    };
    await (await startService(quiet.env, { ...quiet.options, fetchImpl: counting, module1Port: undefined })).stop();
    expect(fetched).toStrictEqual([new URL(MODULE1_URL).href]);
    expect(run).toContain('The service reads no wallet at start: it derives the key hash of the paying key from the key.');
  });

  test('it says where the secrets are looked for, as the start does it, and shows no secret', () => {
    expect(run).toContain('The service key is looked for in every other setting that the service reads, in its hex form and in its bech32 form, in any case, and inside a longer value too.');
    expect(run).toContain(`The token (\`SERVICE_AUTH_HEADER\`) is looked for in the same way, whole and by its credential (the part after \`Bearer \`), when it has ${TOKEN_SEARCH_MIN} characters or more.`);
    const key = SERVICE.privateKeyHex;
    for (const form of [key, key.toUpperCase(), rawHexToBech32(key), `x${key}y`]) {
      const text = message(() => loadConfig(startEnvWith({ OPERATOR_CONTACT: form })));
      expect(text).toMatch(/^environment variable OPERATOR_CONTACT holds the service key, which belongs in INTAKE_SERVICE_PRIV_KEY_HEX alone/);
      expect(text.toLowerCase()).not.toContain(key);
    }
    const credential = TOKEN.slice('Bearer '.length);
    for (const form of [TOKEN, credential, `x${credential}y`]) {
      const text = message(() => loadConfig(startEnvWith({ OPERATOR_CONTACT: form })));
      expect(text).toMatch(/^environment variable OPERATOR_CONTACT holds the service token, which belongs in SERVICE_AUTH_HEADER alone/);
      expect(text).not.toContain(credential);
    }
    // A token shorter than the search is not looked for, and the manifest is searched for both secrets last.
    expect(() => loadConfig(startEnvWith({ SERVICE_AUTH_HEADER: 'Bearer abc', OPERATOR_CONTACT: 'abc' }))).not.toThrow();
    expect(message(() => loadConfig(startEnvWith(), (published) => ({ ...manifestFromEnv(published), description: `leak ${key}` })))).toMatch(/^the manifest would publish the service key/);
    expect(message(() => loadConfig(startEnvWith(), (published) => ({ ...manifestFromEnv(published), description: `leak ${TOKEN}` })))).toMatch(/^the manifest would publish the service token/);
    expect(run).toContain('A hit stops the start. The message names the variable and never shows the value. The manifest is searched for both secrets once more before the service listens.');
  });

  test('a start that fails prints one line on stderr and exits 1, and prints no secret', async () => {
    const cwd = fileURLToPath(new URL('../', import.meta.url));
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    for (const name of SETTINGS) delete inherited[name];
    const env: NodeJS.ProcessEnv = { ...inherited, ...startEnvWith({ SUPPLIER_PKH: undefined }) };
    // The package compiles for es2022, whose library has no Promise.withResolvers, so the executor form is the one that types here.
    const child = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const entry = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      entry.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
      entry.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
      entry.on('exit', (code) => resolve({ code, out, err }));
    });
    expect(child.code).toBe(1);
    expect(child.err).toMatch(/^\[insurer-intake-agent\] cannot start: environment variable SUPPLIER_PKH is required/);
    expect(child.err.trim().split('\n')).toHaveLength(1);
    expect(child.out).toBe('');
    for (const secret of secretsOf()) expect((child.out + child.err).toLowerCase()).not.toContain(secret.toLowerCase());
    expect(textOf('../src/index.ts')).toContain('console.error(`[insurer-intake-agent] cannot start: ${error instanceof Error ? error.message : String(error)}`);');
    expect(run).toContain('A start that stops prints `[insurer-intake-agent] cannot start: <message>` on stderr and exits 1. Nothing keeps running then.');
    expect(section('Stopping')).toContain('A start that fails prints `[insurer-intake-agent] cannot start: <message>` on stderr and exits 1.');
  }, 90_000);
});

describe('agents/insurer-intake-agent/README.md: the routes, the checks and the errors', () => {
  const routes = section('Routes');
  const errors = section('Errors');
  const table = errors.split('\n').filter((line) => /^\| \d{3}, /.test(line));
  /** The status of each code that the Errors table gives, in the order of the table. A code in two rows has both statuses. */
  const documented = new Map<string, number[]>();
  for (const line of table) {
    const status = Number(/^\| (\d{3}), /.exec(line)?.[1]);
    for (const code of ticks(cellsOf(line)[1]).filter((text) => /^[a-z_]+$/.test(text))) documented.set(code, [...(documented.get(code) ?? []), status]);
  }
  const statusOf = (code: string): number => documented.get(code)?.[0] ?? 0;

  test('Routes states the numbers of the code: the body, the request, the limit of the runtime, the six headers, the reservation, the heartbeat, the budgets of the hook, the deadline of a job and the budget of the report', () => {
    expect(routes).toContain(`It is read up to ${MAX_BODY} bytes.`);
    expect([MAX_BODY, MAX_REQUEST_BYTES, RUNTIME_BODY_LIMIT_BYTES]).toStrictEqual([1_000_000, 900_000, 1_048_576]);
    const published = JSON.parse(loadConfig(startEnvWith()).manifest.text) as { terms: { input_limits: { request_bytes: number } }; interface: { request_schema: { properties: Record<string, unknown> } } };
    expect(published.terms.input_limits.request_bytes).toBe(MAX_REQUEST_BYTES);
    expect(routes).toContain(`\`terms.input_limits.request_bytes\`: ${MAX_REQUEST_BYTES} bytes of request JSON.`);
    expect(Object.keys(published.interface.request_schema.properties)).toStrictEqual(['schema', 'use_case', 'sender_did', 'delegation', 'document', 'salt', 'approval']);
    expect(routes).toContain('The manifest publishes this schema under `interface.request_schema`.');
    expect(routes).toContain(`{ "schema": "${HANDOFF_SCHEMA}", "use_case": "prior-authorization", "sender_did": "..."`);
    expect(routes).toContain(`The \`document\` is an authorization request (\`${PRIORAUTH_REQUEST_SCHEMA}\`).`);
    // The wire message holds the request JSON as a string: each quote mark and each backslash of the request gets one more byte there, so the request limit counts less than the body.
    const request = JSON.stringify({ a: 'say "hi" \\ twice' });
    const wrapper = JSON.stringify([{ content: '', role: 'user' }]);
    const marks = [...request].filter((char) => char === '"' || char === '\\').length;
    expect(marks).toBeGreaterThan(4);
    expect(wire(request)).toHaveLength(wrapper.length + request.length + marks);
    expect(routes).toContain('each quote mark and each backslash of the request gets one more byte there');
    expect(routes).toContain(`The runtime takes at most ${RUNTIME_BODY_LIMIT_BYTES} bytes of body.`);
    expect(routes).toContain(`safe only while the escaped body stays below ${RUNTIME_BODY_LIMIT_BYTES} bytes`);
    expect(Object.values(CONTEXT_HEADERS)).toHaveLength(6);
    for (const header of Object.values(CONTEXT_HEADERS)) expect(routes, header).toContain(`\`${header}\``);
    expect(routes).toContain(`\`{"go":true,"reserved_ms":${RESERVATION_MS}}\``);
    expect(routes).toContain(`A go of the hook reserves the slot for its escrow for ${RESERVATION_MS} ms`);
    expect(HEARTBEAT_MS).toBe(60_000);
    expect(routes).toContain(`writes an interim \`102 Processing\` line every ${HEARTBEAT_MS / 1000} s`);
    expect(routes).toContain(`The runtime waits ${RUNTIME_PRECHECK_WAIT_MS} ms for the hook`);
    expect(routes).toContain(`The hook makes ${HOOK_READS} timed reads, one after the other: the identity gateway once and the ledger five times.`);
    expect(CHECKS_READ_BUDGET_MAX_MS * HOOK_READS).toBeLessThan(HOOK_READS_LIMIT_MS);
    expect(HOOK_READS_LIMIT_MS).toBeLessThan(RUNTIME_PRECHECK_WAIT_MS);
    expect(routes).toContain(`Six times the largest budget that the service accepts is under ${HOOK_READS_LIMIT_MS} ms`);
    expect(routes).toContain(`A job has its own deadline, ${JOB_DEADLINE_MS} ms after its request arrives.`);
    expect(routes).toContain(`(its \`SERVICE_TIMEOUT_MS\` is ${JOB_DEADLINE_MS + 60_000}), and the window of the advert is ${MIN_PROCESSING_WINDOW_MS} ms at least`);
    expect(routes).toContain(`One call to the insurer portal takes ${CALL_TIMEOUT_MS} ms at most.`);
    expect(routes).toContain(`The job files no entry when that call could end less than ${RUNTIME_MARGIN_MS / 1000} s before \`deliver_by\``);
    expect(textOf('../src/serve/wiring.ts')).toContain('Math.min(arrivedAt + JOB_DEADLINE_MS, context.deliverByMs - RUNTIME_MARGIN_MS - CALL_TIMEOUT_MS - GATEWAY_DEFAULT_TIMEOUT_MS)');
    expect(routes).toContain(`The report of the attestations has ${REPORT_BUDGET_MS} ms at most for the whole report and ${READ_BUDGET_MS} ms for one read.`);
    expect([JOB_REPORT_BUDGET_MS, REPORT_BUDGET_MS, READ_BUDGET_MS]).toStrictEqual([45_000, 45_000, 15_000]);
    // The hang-up: the job stops before the decision and before the filing call, and it goes on during the filing call and after it.
    expect(textOf('../src/serve/server.ts')).toContain('abortOnClose: true');
    expect(routes).toContain('A job whose caller hangs up before the decision, or before the filing call, is stopped there with `deadline`');
    expect(routes).toContain('A hang-up during the filing call, or after it, does not stop the job: it books the entry, and its log says that the caller hung up.');
    expect(textOf('../../../packages/service-kit/src/server.ts')).toContain('req.httpVersionMajor === 1 && req.httpVersionMinor >= 1');
    expect(textOf('../../../packages/service-kit/src/server.ts')).toContain('timingSafeEqual(digest(given), expectedAuth)');
    expect(routes).toContain('The values are compared in constant time.');
    expect(routes).toContain('gives up after 300 s of silence');
    expect(textOf('../../../packages/service-kit/src/server.ts')).toContain("fetch gives up after 300 s of silence");
    expect(textOf('../src/job/filing.ts')).toContain('the caller hung up while the request was filed: the entry ${intakeId} exists and is booked');
  });

  test('the routes answer as the table says: the health check and the manifest with no token, the token on POST / and POST /precheck, the wire message, the request, the context and 404', async () => {
    const world = makeWorld();
    const manifestText = loadConfig(world.env).manifest.text;
    const noToken = { authorization: null };
    await serve(world, async (api) => {
      const health = await api.request('GET', '/healthz', { headers: noToken });
      expect([health.status, health.json]).toStrictEqual([200, { ok: true }]);
      const served = await api.request('GET', '/agent.json', { headers: noToken });
      expect([served.status, served.text]).toStrictEqual([200, manifestText]);
      expect(manifestText).not.toBe(template);
      for (const path of ['/healthz', '/agent.json?x=1']) {
        const head = await api.request('HEAD', path, { headers: noToken });
        expect([head.status, head.text], `HEAD ${path}`).toStrictEqual([200, '']);
      }
      expect((await api.request('GET', '/healthz?x=1', { headers: noToken })).status).toBe(200);
      for (const path of ['/', '/precheck']) {
        const refused = await api.request('POST', path, { body: wire(world.handoff), headers: { ...headersOf(world.context), authorization: null } });
        expect([refused.status, refused.json], path).toStrictEqual([statusOf('unauthorized'), { error: 'unauthorized' }]);
      }
      for (const [method, path] of [['GET', '/'], ['GET', '/precheck'], ['GET', '/other'], ['POST', '/other'], ['POST', '/cosign/delegate']]) {
        const refused = await api.request(method, path);
        expect([refused.status, refused.json], `${method} ${path}`).toStrictEqual([statusOf('not_found'), { error: 'not_found' }]);
      }
      // The wire message: a body that is not a one-element array with the role user, and a body over the limit.
      const send = (body: string, path = '/') => api.request('POST', path, { body, headers: headersOf(world.context) });
      for (const body of ['not the wire message', '[]', JSON.stringify([{ content: '{}', role: 'system' }])]) {
        const reply = await send(body);
        expect([reply.status, reply.json?.error], body).toStrictEqual([statusOf('bad_wire'), 'bad_wire']);
      }
      const big = await send('x'.repeat(MAX_BODY + 1));
      expect([big.status, big.json?.error]).toStrictEqual([statusOf('request_too_large'), 'request_too_large']);
      // The request: another use case, a member that the schema does not list, a document that is no authorization request, and no JSON. The same handoff for use case 2 is taken.
      for (const bad of [{ ...world.handoff, use_case: 'inventory-reorder' }, { ...world.handoff, extra: 1 }, { ...world.handoff, document: { schema: 'vector.usecase.po.v1' } }, 'not json']) {
        for (const path of ['/', '/precheck']) {
          const reply = await send(wire(bad), path);
          expect([reply.status, reply.json?.error], `${path} ${JSON.stringify(bad).slice(0, 30)}`).toStrictEqual([statusOf('bad_shape'), 'bad_shape']);
        }
      }
      expect(new RequestRefusal('bad_shape', 'x').status).toBe(statusOf('bad_shape'));
      // The six headers of the context: the hook needs all six, and the job needs them too. One missing, all missing and a bad one are 400 bad_context, and the call with all six is answered.
      for (const name of Object.keys(headersOf(world.context))) {
        const reply = await api.precheck(world.handoff, world.context, { [name]: null });
        expect([reply.status, reply.json?.error], name).toStrictEqual([statusOf('bad_context'), 'bad_context']);
      }
      const none = Object.fromEntries(Object.keys(headersOf(world.context)).map((name) => [name, null]));
      for (const reply of [await api.job(world.handoff, world.context, none), await api.job(world.handoff, world.context, { [CONTEXT_HEADERS.deliverByMs]: 'soon' })]) {
        expect([reply.status, reply.json?.error]).toStrictEqual([statusOf('bad_context'), 'bad_context']);
      }
      expect(new RequestRefusal('bad_context', 'x').status).toBe(statusOf('bad_context'));
      expect((await api.precheck()).status).toBe(200);
    });
  });

  test('the hook and the job answer as the README says: a go reserves the slot, the stranger gets 401 first, the job takes the reservation, files the request and answers the intake record', async () => {
    const world = makeWorld();
    const other = { ...world.context, escrowRef: `${'aa'.repeat(32)}#0` };
    const { tenant, request_number: requestNumber } = world.proposal.document;
    await serve(world, async (api) => {
      const go = await api.precheck();
      expect([go.status, go.json]).toStrictEqual([200, { go: true, reserved_ms: RESERVATION_MS }]);
      // The slot is held for this escrow: the hook of another escrow is busy with a message, the job of another escrow is busy with no message, and a call with no token is 401 and not busy.
      const busyHook = await api.precheck(world.handoff, other);
      expect([busyHook.status, busyHook.json]).toStrictEqual([statusOf('busy'), { error: 'busy', message: BUSY_TEXT }]);
      const busyJob = await api.job(world.handoff, other);
      expect([busyJob.status, busyJob.json]).toStrictEqual([statusOf('busy'), { error: 'busy' }]);
      const stranger = await api.request('POST', '/', { body: wire(world.handoff), headers: { ...headersOf(other), authorization: null } });
      expect([stranger.status, stranger.json]).toStrictEqual([statusOf('unauthorized'), { error: 'unauthorized' }]);
      // A new go for the escrow that holds the reservation reserves the slot again, and the job for that escrow takes the reservation.
      expect((await api.precheck()).json).toStrictEqual({ go: true, reserved_ms: RESERVATION_MS });
      const job = await api.job();
      const record = job.json as { attestations: Record<string, string>; decisions: Array<{ name: string }> };
      expect(job.status).toBe(200);
      expect(parseIntakeRecord(job.json).ok).toBe(true);
      expect([job.json?.status, job.json?.fault_mode, Object.keys(record).at(-1)]).toStrictEqual(['complete', '', 'fault_mode']);
      // The job reads the requirements and files the request, each with a JWT-SVID, reports the three attestations in four words, takes one decision, and books the entry.
      expect(world.events).toStrictEqual(['requirements', 'filing']);
      expect(world.portal.calls.every((call) => /^Bearer \S+$/.test(call.headers.authorization ?? ''))).toBe(true);
      expect(Object.keys(record.attestations)).toStrictEqual(['provenance', 'software', 'principal_binding']);
      expect(Object.values(record.attestations)).toStrictEqual(['valid', 'valid', 'valid']);
      const words = ATTESTATION_STATES.map((word) => `\`${word}\``);
      expect(readme).toContain(`Each is ${words.slice(0, -1).join(', ')} or ${words.at(-1)}.`);
      expect(record.decisions.map((decision) => decision.name)).toStrictEqual(['completeness']);
      expect(await new FileIntakeBook(join(world.stateDir, 'requests.json')).has(String(tenant), String(requestNumber))).toBe(true);
    });
    // While a job runs, the hook and the job of another escrow are busy, the hook with a message and the job with none.
    const running = makeWorld();
    const hold = running.holdModel();
    await serve(running, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const first = api.job();
      await hold.reached;
      const busyHook = await api.precheck(running.handoff, other);
      expect([busyHook.status, busyHook.json]).toStrictEqual([statusOf('busy'), { error: 'busy', message: BUSY_TEXT }]);
      const busyJob = await api.job(running.handoff, other);
      expect([busyJob.status, busyJob.json]).toStrictEqual([statusOf('busy'), { error: 'busy' }]);
      hold.release();
      expect((await first).status).toBe(200);
    });
  });

  test('the hook refuses with the code of the check that failed, before the Claim: the three checks of this agent, a source that cannot be read, and an intake book that is missing or damaged', async () => {
    const { tenant, request_number: requestNumber } = makeWorld().proposal.document;
    // Each refusal has the request that passes in the world above as its accepted twin. The refused request has no record of passed checks: its job is refused, and nothing is filed.
    const defects: ReadonlyArray<readonly [code: string, make: () => World, before?: (world: World) => Promise<void>]> = [
      ['not_for_this_insurer', () => makeWorld({ request: { insurer_did: `did:vector:${'f2'.repeat(32)}` } })],
      ['advert_mismatch', () => makeWorld({ request: { advert_ref: `${'d5'.repeat(32)}#1` } })],
      ['duplicate_request', () => makeWorld(), (made) => new FileIntakeBook(join(made.stateDir, 'requests.json')).record(String(tenant), String(requestNumber), 'IN-run1-0000')],
    ];
    for (const [code, make, before] of defects) {
      const made = make();
      if (before !== undefined) await before(made);
      await serve(made, async (api) => {
        const reply = await api.precheck(made.handoff, made.context);
        expect([reply.status, reply.json?.error], code).toStrictEqual([statusOf(code), code]);
        expect(typeof reply.json?.message).toBe('string');
        const job = await api.job(made.handoff, made.context);
        expect([job.status, job.json?.error, job.json?.message]).toStrictEqual([statusOf('precheck_missing'), 'precheck_missing', operatorsText('precheck_missing')]);
        expect(made.portal.calls).toStrictEqual([]);
      });
    }
    // A source that cannot be read is never a go: the gateway, and the file of the intake book that is missing or damaged.
    const down = makeWorld();
    down.gateway.fault(`/1.0/identifiers/${down.sender.did}`, 'network');
    await serve(down, async (api) => {
      const reply = await api.precheck();
      expect([reply.status, reply.json?.error]).toStrictEqual([statusOf('check_unavailable'), 'check_unavailable']);
    });
    const damaged = makeWorld();
    await serve(damaged, async (api) => {
      const file = join(damaged.stateDir, 'requests.json');
      for (const damage of [() => { rmSync(file); }, () => { writeFileSync(file, 'not json', 'utf8'); }]) {
        damage();
        const reply = await api.precheck();
        expect([reply.status, reply.json?.error]).toStrictEqual([statusOf('check_unavailable'), 'check_unavailable']);
      }
    });
  });

  test('a digest mismatch is refused first, and the challenge starts after the answer, which holds no reference, and the journal of the dispute code has a file for the escrow', async () => {
    const world = makeWorld({ attestation: { digest: proposalOf({ request_number: 'run1-9' }).proposal_digest } });
    world.armChallenge();
    const publish = world.port.holdPublish();
    await serve(world, async (api) => {
      const reply = await api.precheck();
      expect([reply.status, reply.json?.error]).toStrictEqual([statusOf('approval_digest_mismatch'), 'approval_digest_mismatch']);
      await until(() => world.port.events.some((event) => event.startsWith('publish')), 'the challenge has started');
      expect(world.port.challenged).toStrictEqual([]);
      expect(reply.text).not.toContain(world.context.escrowRef);
      publish();
      await until(() => world.port.challenged.length === 1, 'the challenge is filed');
      expect(world.port.published[0]?.type).toBe('evidence');
      await until(() => existsSync(join(world.stateDir, 'dispute', world.context.escrowRef.split('#').join('_'))), 'the journal holds the job of the escrow');
    });
  });

  test('the job answers as the README says: the status that the model gives, a request that the portal holds already, a body that the hook did not check, and no hook at all', async () => {
    const incomplete = makeWorld();
    incomplete.m.llm.answer = INCOMPLETE;
    await serve(incomplete, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const job = await api.job();
      expect([job.status, job.json?.status, job.json?.missing]).toStrictEqual([200, 'incomplete', ['R4']]);
      expect(incomplete.events).toStrictEqual(['requirements', 'filing']);
    });
    const held = makeWorld();
    held.portal.prefile(String(held.proposal.document.request_number));
    await serve(held, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const job = await api.job();
      expect([job.status, job.json?.error]).toStrictEqual([statusOf('duplicate_request'), 'duplicate_request']);
    });
    // The hook checked one body. The job for another body of the same escrow has no record, and it files nothing.
    const swapped = makeWorld();
    await serve(swapped, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const job = await api.job({ ...swapped.handoff, salt: 'ee'.repeat(32) });
      expect([job.status, job.json?.error]).toStrictEqual([statusOf('precheck_missing'), 'precheck_missing']);
      expect(swapped.portal.calls).toStrictEqual([]);
    });
    const unchecked = makeWorld();
    await serve(unchecked, async (api) => {
      const job = await api.job();
      expect([job.status, job.json]).toStrictEqual([statusOf('precheck_missing'), { error: 'precheck_missing', message: operatorsText('precheck_missing') }]);
    });
  });

  test('the checks: the 15 names in their order, the 12 shared checks, and the three of this agent with their codes', () => {
    const names = INTAKE_CHECKS.map((name) => `\`${name}\``);
    expect(INTAKE_CHECKS).toHaveLength(15);
    expect(routes).toContain(`The hook makes the ${INTAKE_CHECKS.length} checks of the intake record in this order: ${names.slice(0, -1).join(', ')} and ${names.at(-1)}.`);
    expect(INTAKE_CHECKS.slice(0, 12)).toStrictEqual([...SHARED_CHECK_NAMES['insurer-intake-agent']]);
    expect(routes).toContain('The first 12 are the shared checks of use case 2');
    const own = INTAKE_CHECKS.slice(-3);
    const codes = COUNTERPARTY_REFUSALS['insurer-intake-agent'].slice(-3);
    expect(own).toStrictEqual(['for_this_insurer', 'advert', 'not_duplicate']);
    expect(codes).toStrictEqual(['not_for_this_insurer', 'advert_mismatch', 'duplicate_request']);
    expect(routes.split('\n').filter((line) => /^\| `[a-z_]+` \| `[a-z_]+` \|/.test(line)).map((line) => ticks(line).slice(0, 2))).toStrictEqual(own.map((name, at) => [name, codes[at]]));
    expect(routes).toContain('A source that the hook cannot read (the identity gateway, the ledger or the intake book) is never a pass: the hook answers 503 `check_unavailable`.');
  });

  test('the Errors table gives each code its status as the kit has it, and every code of it is a code that the refusals, the job or the server know, with none missing', () => {
    expect(table).toHaveLength(11);
    for (const [code, statuses] of documented) for (const status of statuses) expect([code, status], code).toStrictEqual([code, STATUS[code] ?? SERVER_OWN[code]]);
    // The 403 row before the Claim holds the 17 refusal codes of the Insurer Intake Agent, in the order that the hook makes its checks.
    const before = table.find((line) => line.startsWith('| 403, the hook, before the Claim'));
    expect(ticks(cellsOf(before ?? '')[1])).toStrictEqual([...COUNTERPARTY_REFUSALS['insurer-intake-agent']]);
    expect(COUNTERPARTY_REFUSALS['insurer-intake-agent']).toHaveLength(17);
    const after = table.find((line) => line.startsWith('| 403, the job, after the Claim'));
    expect(ticks(cellsOf(after ?? '')[1])).toStrictEqual(['duplicate_request']);
    // The set of the table is the set of the sources: the refusals of the hook, the codes of the job, and the codes of the request that the shared server and the service give.
    const known = new Set<string>([...COUNTERPARTY_REFUSALS['insurer-intake-agent'], ...Object.keys(INTAKE_REFUSAL_STATUS), ...REQUEST_CODES]);
    expect([...documented.keys()].sort()).toStrictEqual([...known].sort());
    for (const [code, status] of Object.entries(INTAKE_REFUSAL_STATUS)) expect(documented.get(code), code).toContain(status);
    expect(Object.keys(INTAKE_REFUSAL_STATUS).sort()).toStrictEqual(['deadline', 'duplicate_request', 'inference_failed', 'internal', 'mock_system_failed', 'model_output_invalid', 'precheck_missing', 'store_write_failed', 'svid_failed']);
    expect([...documented.entries()].filter(([, statuses]) => statuses.length > 1)).toStrictEqual([['duplicate_request', [403, 403]]]);
    // The words around the table.
    expect(errors).toContain(`\`${operatorsText('<code>')}\``);
    expect(errors).toContain('A refusal of status 500 or more gets a fixed message');
    expect(errors).toContain(`\`request_too_large\` (over ${MAX_BODY} bytes)`);
    expect(errors).toContain('because the runtime copies the first 200 characters of a failure to the buyer');
    expect(textOf('../../../packages/service-kit/src/server.ts')).toContain('the runtime copies the first 200 characters of a failure to the buyer');
    // The statuses that the prose of the page gives to a code are the statuses of the table.
    for (const code of ['check_unavailable', 'bad_context', 'duplicate_request', 'busy']) expect(readme, code).toContain(`${statusOf(code)} \`${code}\``);
    expect(routes).toContain(`\`bad_shape\` (${statusOf('bad_shape')})`);
    expect(errors).toContain(`\`duplicate_request\` (${statusOf('duplicate_request')}) after the Claim`);
    expect(errors).toContain('The 401, the 404, the 409 of a job and a plain 500 have the code and no message: `{"error":"unauthorized"}`, `{"error":"not_found"}`, `{"error":"busy"}` and `{"error":"internal"}`.');
    expect(errors).toContain(`\`shutting_down\` has the fixed message \`${STOPPING_TEXT}\`, and the 409 \`busy\` of the hook has the fixed message \`${BUSY_TEXT}\`.`);
    expect(errors).toContain('A counterparty answers 200 only when it did the work: the 200 answer is the intake record.');
    expect(errors).toContain('turns a refusal or a failure into its own `reason`, and answers its hirer with a 200 result.');
    expect(errors).toContain('A refusal of the hook leaves the escrow open, and nothing is paid. A job that fails after the Claim leaves the escrow claimed.');
    expect(textOf('../src/job/filing.ts')).toContain('; the entry may exist at the portal');
    expect(textOf('../src/job/filing.ts')).toContain('and the portal holds the entry');
  });
});

describe('agents/insurer-intake-agent/README.md: the stop, the state and what the tests do not show', () => {
  test('Stopping states the numbers of the stop, the exit codes of the stop on a signal, and the rule for a restart', async () => {
    const stopping = section('Stopping');
    expect(stopping).toContain(`waits up to ${SHUTDOWN_WAIT_MS / 1000} s for the job that is running to end`);
    expect(stopping).toContain(`A job still running after ${SHUTDOWN_WAIT_MS / 1000} s is abandoned`);
    expect(stopping).toContain('the service exits 0.');
    expect(stopping).toContain('the service exits 1.');
    expect(stopping).toContain(`The janitor of the service key runs every ${JANITOR_INTERVAL_MS / 1000} s. A stop waits at most ${JANITOR_STOP_WAIT_MS / 1000} s for a pass of the janitor that is in flight`);
    expect(stopping).toContain(`must be ${(SHUTDOWN_WAIT_MS + 30_000) / 1000} s: the ${SHUTDOWN_WAIT_MS / 1000} s of the wait and 30 s more`);
    const start = textOf('../src/serve/start.ts');
    expect(start).toContain('options.janitorIntervalMs ?? JANITOR_INTERVAL_MS');
    expect(start).toContain('options.janitorStopWaitMs ?? JANITOR_STOP_WAIT_MS');
    expect(start).toContain('abandonedLine: (waitMs) => abandonedLine(wired.key.stranded, waitMs)');
    // The package compiles for es2022, whose library has no Promise.withResolvers, so the executor form is the one that types here.
    const exitOf = (outcome: 'finished' | 'abandoned', signal: string): Promise<number> => new Promise((resolve) => {
      const target = new EventEmitter();
      stopOnSignals({ shutdown: async () => outcome }, { target, exit: resolve, log: () => undefined });
      target.emit(signal);
    });
    expect([await exitOf('finished', 'SIGTERM'), await exitOf('abandoned', 'SIGINT')]).toStrictEqual([0, 1]);
    expect(stopping).toContain('Stop or restart the service only when the runtime in front of it says `free` at its `/status`.');
  });

  test('State names the files and folders that the wiring keeps, the limit of the book, the life of the record of passed checks and the one queue of the service key', async () => {
    const state = section('State');
    const paths = state.split('\n').filter((line) => /^\| `/.test(line)).map((line) => ticks(cellsOf(line)[0])[0]);
    expect(paths).toStrictEqual([`keys/<key hash>/${STRANDED_FILE}`, 'dispute/', 'requests.json']);
    expect(state).toContain(`every ${JANITOR_INTERVAL_MS / 1000} s`);
    // The wiring makes exactly these on a new state directory: the stranded store of the service key in its own folder, the journal folder and the intake book.
    const world = makeWorld();
    const wired = await wireService(loadConfig(world.env), world.options);
    expect(readdirSync(world.stateDir).sort()).toStrictEqual(['dispute', 'keys', 'requests.json']);
    expect(readdirSync(join(world.stateDir, 'keys'))).toStrictEqual([SERVICE.pkh]);
    expect(relative(world.stateDir, wired.key.stranded.file)).toBe(join('keys', SERVICE.pkh, STRANDED_FILE));
    expect(STRANDED_FILE).toBe('stranded.json');
    // The one queue: the lane of the paying key runs the dispute code, and the model hire takes the same key.
    expect(state).toContain('The service key has one queue. The model hire, and the claims and the challenges of the dispute code, run one after the other in it');
    expect(textOf('../src/serve/wiring.ts')).toContain('queue: key.lane');
    // The book holds at most INTAKE_BOOK_LIMIT entries, never drops one, and a number that it lacks is not read as new when it is full. A number that it holds is still true.
    expect(state).toContain(`It holds at most ${INTAKE_BOOK_LIMIT} entries and never drops one`);
    expect(state).toContain(`A book that holds ${INTAKE_BOOK_LIMIT} entries cannot take a new entry. For a request number that the book does not hold, the hook answers 503 \`check_unavailable\` and the escrow stays open.`);
    expect(state).toContain('For a number that the book holds, the hook still answers 403 `duplicate_request`.');
    const book = new MemoryIntakeBook();
    for (let at = 0; at < INTAKE_BOOK_LIMIT; at += 1) await book.record('run1', `run1-${at}`, `IN-run1-${at}`);
    await expect(book.has('run1', 'run1-0')).resolves.toBe(true);
    await expect(book.has('run1', 'run1-new')).rejects.toThrow(RangeError);
    expect(state).toContain('A file that is missing or damaged after the start makes the hook answer 503 `check_unavailable`, and it never reads as an empty book.');
    // A stranded file that is not a list stops the start and is left as it is.
    const broken = makeWorld();
    const file = join(broken.stateDir, 'keys', SERVICE.pkh, STRANDED_FILE);
    mkdirSync(join(broken.stateDir, 'keys', SERVICE.pkh), { recursive: true });
    writeFileSync(file, 'not a list', 'utf8');
    await expect(startService(broken.env, broken.options)).rejects.toThrow(/is not a list of stranded escrows/);
    expect(readFileSync(file, 'utf8')).toBe('not a list');
    expect(state).toContain('A stranded file that is not a list stops the start and is left as it is');
    // The record of passed checks is in memory: it lives PASSED_CHECKS_TTL_MS and the store holds PASSED_CHECKS_LIMIT.
    expect(state).toContain(`It lives ${PASSED_CHECKS_TTL_MS / 1000} s, and the store holds ${PASSED_CHECKS_LIMIT} of them at most. A restart forgets them, and a job that arrives after a restart fails closed with \`precheck_missing\`.`);
  });

  test('What this does not show has the words of the gap of the manifest, and the Tests section names files that exist', () => {
    const lead = 'What this does not show: ';
    expect(NOT_SHOWN_GAP.startsWith(lead)).toBe(true);
    expect(manifest.gaps).toContain(NOT_SHOWN_GAP);
    expect(section('What this does not show')).toContain(NOT_SHOWN_GAP.slice(lead.length));
    expect(section('Tests')).toContain('pnpm --filter @vsa/insurer-intake-agent test');
    for (const path of ['test/store', 'test/checks', 'test/report', 'test/job', 'test/serve', 'test/serve/module1-preload.mjs', 'test/dockerfile.test.ts', 'test/readme.test.ts']) {
      expect(section('Tests'), path).toContain(`\`${path}\``);
      expect(existsSync(new URL(`../${path}`, import.meta.url)), path).toBe(true);
    }
  });
});

describe('agents/insurer-intake-agent/README.md: the image, the pack and the secrets', () => {
  test('the Image section says what the Dockerfile and the build context say', () => {
    const image = section('Image');
    const dockerfile = textOf('../Dockerfile');
    const ignored = readFileSync(new URL('.dockerignore', root), 'utf8').split('\n');
    expect(image).toContain('`docker build -f agents/insurer-intake-agent/Dockerfile -t vsa/insurer-intake-agent:dev .`');
    expect(dockerfile.split('\n').filter((line) => line.startsWith('FROM '))).toHaveLength(2);
    expect(image).toContain('two stages');
    for (const word of ['tini', 'node:22-bookworm-slim', '/data', '/healthz']) expect([word, image.includes(word), dockerfile.includes(word)]).toStrictEqual([word, true, true]);
    expect(image).toContain(`listens on ${PORT_DEFAULT}`);
    expect(dockerfile).toContain(`EXPOSE ${PORT_DEFAULT}`);
    expect(dockerfile).toContain(`PORT=${PORT_DEFAULT}`);
    expect(image).toContain('answers `/healthz` every 20 s');
    expect(dockerfile).toContain('HEALTHCHECK --interval=20s');
    expect(image).toContain('runs as the `node` user');
    expect(dockerfile).toContain('USER node');
    expect(image).toContain('`/data` is a volume that `node` owns');
    expect(dockerfile).toContain(`VOLUME ${STATE_DIR_DEFAULT}`);
    expect(dockerfile).toContain('chown node:node /data');
    // No test file: the service folder is copied in parts, and the build context leaves out each folder named test, each env file and each node_modules.
    expect(image).toContain('its manifest, its `tsconfig.json` and its `src` folder');
    for (const part of ['package.json', 'tsconfig.json', 'src']) expect(dockerfile).toContain(`COPY agents/insurer-intake-agent/${part} ./agents/insurer-intake-agent/${part}`);
    expect(dockerfile).not.toMatch(/^COPY agents\/insurer-intake-agent \S/m);
    for (const entry of ['**/test', '**/.env', '**/.env.*', 'node_modules', '**/node_modules']) expect(ignored, entry).toContain(entry);
    expect(image).toContain('leaves out every folder named `test`, every env file and every `node_modules`');
    expect(image).toContain('The image has no Python, no model and no env file.');
    // No Python, no model and no env file: the instructions of the Dockerfile (its comments say "no Python" too) add tini and nothing else, and copy no env file.
    const instructions = dockerfile.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
    expect(instructions.join('\n')).not.toMatch(/python|pip3? |venv|\.env/i);
    expect(instructions.filter((line) => /apt-get|apk /.test(line))).toStrictEqual(['RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*']);
  });

  test('the Deploy section is three lines that name the three files of the pack', () => {
    const lines = section('Deploy').split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(3);
    for (const [at, file] of ['docker-compose.insurer-intake-agent.yml', '.env.insurer-intake-agent.example', 'RUNBOOK-insurer-intake-agent.md'].entries()) expect(lines[at], file).toContain(`\`deploy/server/${file}\``);
  });

  test('the page holds no run of 64 hex characters and no key in any form, and no secret of the tests', () => {
    expect(readme).not.toMatch(/[0-9a-f]{64}/i);
    expect(readme).not.toMatch(/PRIV_KEY_HEX=["']?[0-9a-f]{16}/i);
    expect(readme).not.toMatch(/SERVICE_AUTH_HEADER=["']?Bearer [0-9a-f]{8}/);
    for (const secret of secretsOf()) expect(readme.toLowerCase(), 'a key or the token of the tests').not.toContain(secret.toLowerCase());
  });
});
