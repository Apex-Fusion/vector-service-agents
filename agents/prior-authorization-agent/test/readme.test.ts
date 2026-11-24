// agents/prior-authorization-agent/test/readme.test.ts
// The README names every setting that the service reads, every code that it answers with, and the numbers of its routes, its state, its stop and its image. These tests keep the page and the code from parting:
// a name that the code reads and the table does not name fails, so does a name in the table that no code reads, a code with the wrong status, a reason code in the Errors section, and a number that is not the
// code's. Where the README says that the start refuses a value or that a route answers, the test makes the call and checks the answer. No test here uses the network, and no key is real.
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { VAULT_PAYER_IDENTITY_SETTINGS, VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, rawHexToBech32 } from '@vsa/buyer-core';
import { STRANDED_FILE } from '@vsa/hire-kit';
import { CONTEXT_HEADERS, HEARTBEAT_MS, MAX_BODY, RESERVATION_MS, SHUTDOWN_WAIT_MS, TOKEN_SEARCH_MIN } from '@vsa/service-kit';
import { COSIGN_SETTINGS, COSIGN_STATUS, DEFAULT_LIMITS } from '@vsa/usecase-kit/cosign';
import { PRIORAUTH_CAPABILITIES, PRIORAUTH_MODELS } from '@vsa/usecase-kit/priorauth';
import { ERROR_STATUS, FAULT_MODES, MAX_REQUEST_BYTES, RUNTIME_BODY_LIMIT_BYTES, checkRequestSize } from '@vsa/usecase-kit/protocol';
import { identityRegistryOf } from '@vsa/vector-read';
import { world as ledgerWorld } from '../../../packages/usecase-kit/test/cosign/support.ts';
import { EVIDENCE_FAILURES } from '../src/evidence/index.ts';
import { EXECUTE_REASONS, JOB_DEADLINE_MS as EXECUTE_DEADLINE_MS } from '../src/execute/index.ts';
import { INSURER_FAILURES } from '../src/insurer/index.ts';
import { PROPOSE_DEADLINE_MS, PROPOSE_FAILURES } from '../src/propose/index.ts';
import { NOT_SHOWN_GAP, SIGN_OFF_GAP, SYNTHETIC_GAP } from '../src/serve/gaps.ts';
import { KEY_ROLES, keyOf } from '../src/serve/keys.ts';
import { STATUS_SINCE_DEFAULT, TEMPLATE_ENV, manifestFromEnv } from '../src/serve/manifest.ts';
import { RequestError, parseJob } from '../src/serve/server.ts';
import {
  BUYER_BOND_LOVELACE, GATEWAY_DEFAULT, HOST_DEFAULT, JOB_DEADLINE_MS, MAX_PRICE_LOVELACE, MAX_PROCESSING_WINDOW_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, PRICE_DEFAULT_LOVELACE, STATE_DIR_DEFAULT,
  SUPPLIER_BOND_LOVELACE,
} from '../src/serve/settings.ts';
import { JANITOR_INTERVAL_MS, JANITOR_STOP_WAIT_MS, SETTINGS, loadConfig, stopOnSignals } from '../src/serve/start.ts';
import type { StartOptions } from '../src/serve/start.ts';
import { STATE_FILES } from '../src/serve/wiring.ts';
import { closeAll, serve, start } from './serve/serve.ts';
import { KEY_NUMBERS, KEY_VARIABLES, MODULE1_URL, PKH_VARIABLES, TOKEN, cleanDirs, messageOf, module1ManifestText, rawKey, secretsOf, startEnv, tempDir } from './serve/support.ts';

afterEach(async () => {
  cleanDirs();
  await closeAll();
});

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
/** The rows of a table of the Errors section: the status of the row, and the codes in backticks of its second cell. */
const codeRows = (text: string): Array<{ status: number; codes: string[] }> =>
  text.split('\n').filter((line) => /^\| \d/.test(line)).map(cellsOf).map(([status, codes]) => ({ status: Number(status), codes: ticks(codes).filter((code) => /^[a-z_]+$/.test(code)) }));
const throws = (work: () => unknown): boolean => { try { work(); return false; } catch { return true; } };
const errorText = (value: unknown): string => (value instanceof Error ? value.message : String(value));
/** The members of the JSON body of an answer. A body that is no object has none. */
const bodyOf = async (response: Response): Promise<Record<string, unknown>> => {
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null ? { ...body } : {};
};
const STATUS: Readonly<Record<string, number>> = ERROR_STATUS;
const COSIGN: Readonly<Record<string, number>> = COSIGN_STATUS;

/** The two codes that the shared server answers itself and that `ERROR_STATUS` does not hold: a call with a bad context, and a path or a method that no route takes. */
const SERVER_OWN: Readonly<Record<string, number>> = { bad_context: 400, not_found: 404 };
const KEY_ROW = 'none. The key is required; the key hash is derived when it is not set';
/** The names that the code reads through a table of names, so that no `env.NAME` finds them: the three limits of the co-sign route, and the key hash of each of the seven keys. */
const READ_BY_TABLE: readonly string[] = [COSIGN_SETTINGS.maxConcurrent, COSIGN_SETTINGS.maxFutureMs, COSIGN_SETTINGS.ledgerTimeoutMs, ...KEY_ROLES.map((role) => PKH_VARIABLES[role])];
const PROPOSE = { op: 'propose', authority: { principal_did: `did:vector:${'1f'.repeat(32)}`, delegation: '77'.repeat(32) }, tenant: 'run1', order_id: 'ORD-1001', insurer_did: `did:vector:${'2e'.repeat(32)}` };

/** The names that the code reads from the environment itself: `env.NAME`, `process.env.NAME`, and the names given to envInt and requiredEnv. */
function namesRead(): string[] {
  const found = new Set<string>();
  for (const text of sources) {
    for (const match of text.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)\b/g)) found.add(match[1]);
    for (const match of text.matchAll(/\b(?:envInt|requiredEnv)\(\s*'([A-Z][A-Z0-9_]*)'/g)) found.add(match[1]);
  }
  return [...found].sort();
}

describe('agents/prior-authorization-agent/README.md: the page and its settings', () => {
  test('line 3 is the description of the manifest and the capability, and the status line is the status of the manifest', () => {
    const lines = readme.split('\n');
    expect(lines[0]).toBe(`# ${manifest.name}`);
    expect(lines[2]).toBe(`${manifest.description} Capability \`${PRIORAUTH_CAPABILITIES.draft}\`.`);
    expect(manifest.status).toStrictEqual({ chip: 'proposed', since: STATUS_SINCE_DEFAULT });
    expect(lines[4]).toContain(`Status: \`${manifest.status.chip}\` since ${manifest.status.since}. The service is built.`);
    expect(lines[4]).toContain('It is not deployed, and no job of it has settled.');
    expect(lines[4]).toContain(SYNTHETIC_GAP);
    expect(readme).toContain(SIGN_OFF_GAP);
    expect(readme).toContain('use case 2 (prior authorization)');
  });

  test('the Settings table names each setting of SETTINGS once, and SETTINGS are the names that the code reads', () => {
    const documented = settingsRows().flatMap(([names]) => ticks(names)).sort();
    expect(new Set(documented).size, 'a name stands in two rows').toBe(documented.length);
    expect(documented).toStrictEqual([...SETTINGS].sort());
    expect(SETTINGS).toHaveLength(61);
    // The code reads each name that the scan finds, and the table names it. The names that no scan finds are the four of buyer-core and the ten of a table of names: a value that no reader takes stops the start.
    const read = namesRead();
    const elsewhere = [...VAULT_PAYER_IDENTITY_SETTINGS, ...READ_BY_TABLE];
    expect([...SETTINGS].sort()).toStrictEqual([...new Set([...read, ...elsewhere])].sort());
    for (const name of elsewhere) {
      expect(read.includes(name), `${name} stands in no env.NAME`).toBe(false);
      expect(messageOf(() => loadConfig(startEnv({ [name]: 'a\u0001b' }))), name).toContain(name);
    }
  });

  test('the defaults of the table are the code and the manifest', () => {
    const config = loadConfig(startEnv({ PORT: undefined, HOST: undefined, PRIORAUTH_STATE_DIR: undefined }));
    // The members of the served manifest that the table speaks of.
    const published = JSON.parse(config.manifest.text) as { version: string; status: unknown; terms: { price_lovelace: number; max_processing_ms: number }; links: { explorer_advert: string }; identity: { registry_address: string } };
    expect(cell('PORT', 2)).toBe(`\`${PORT_DEFAULT}\`, \`${HOST_DEFAULT}\``);
    expect(cell('HOST', 2)).toBe(cell('PORT', 2));
    expect([config.port, config.host, config.stateDir]).toStrictEqual([PORT_DEFAULT, HOST_DEFAULT, STATE_DIR_DEFAULT]);
    expect(cell('PRIORAUTH_STATE_DIR', 2)).toBe(`\`${STATE_DIR_DEFAULT}\``);
    expect(cell('IDENTITY_GATEWAY_URL', 2)).toBe(`\`${GATEWAY_DEFAULT}\``);
    expect(config.endpoints.gatewayUrl).toBe(GATEWAY_DEFAULT);
    expect(cell('ADVERT_PRICE_LOVELACE', 2)).toBe(`\`${PRICE_DEFAULT_LOVELACE}\``);
    expect(cell('ADVERT_MAX_PROCESSING_MS', 2)).toBe(`\`${MIN_PROCESSING_WINDOW_MS}\``);
    expect([published.terms.price_lovelace, published.terms.max_processing_ms]).toStrictEqual([PRICE_DEFAULT_LOVELACE, MIN_PROCESSING_WINDOW_MS]);
    expect([cell('AGENT_VERSION', 2), cell('AGENT_STATUS_CHIP', 2), cell('AGENT_STATUS_SINCE', 2)]).toStrictEqual([`\`${manifest.version}\``, `\`${manifest.status.chip}\``, `\`${manifest.status.since}\``]);
    expect([published.version, published.status]).toStrictEqual([manifest.version, manifest.status]);
    expect(JSON.parse(template)).toMatchObject({ version: manifest.version, status: manifest.status });
    expect([cell('ADVERT_EXPLORER_URL', 2), cell('FAULT_MODE', 2)]).toStrictEqual(['empty', 'empty']);
    expect([published.links.explorer_advert, config.fault.mode]).toStrictEqual(['', '']);
    expect(cell('IDENTITY_ADDRESS', 2)).toBe('derived from the policy');
    expect(published.identity.registry_address).toBe(identityRegistryOf(String(startEnv().IDENTITY_POLICY_ID), undefined)?.address);
    expect([cell('VECTOR_OGMIOS_URL', 2), cell('VECTOR_KOIOS_URL', 2), cell('VECTOR_MARKETPLACE_INDEXER_URL', 2)]).toStrictEqual(Array(3).fill('the default of `packages/buyer-core`'));
    expect([config.endpoints.ogmiosUrl, config.endpoints.koiosUrl, config.endpoints.submitUrl, config.endpoints.indexerUrl]).toStrictEqual([VECTOR_OGMIOS_URL, VECTOR_KOIOS_URL, VECTOR_SUBMIT_URL, undefined]);
    // The three limits of the co-sign route take the defaults of the kit, and the two optional settings of the dispute code are left to the code of the dispute.
    expect(cell('COSIGN_MAX_CONCURRENT', 2)).toBe(`\`${DEFAULT_LIMITS.maxConcurrent}\`, \`${DEFAULT_LIMITS.maxFutureMs}\`, \`${DEFAULT_LIMITS.ledgerTimeoutMs}\``);
    expect(cell('COSIGN_LEDGER_TIMEOUT_MS', 2)).toBe(cell('COSIGN_MAX_CONCURRENT', 2));
    expect([config.cosign.maxConcurrent, config.cosign.maxFutureMs, config.cosign.ledgerTimeoutMs]).toStrictEqual([DEFAULT_LIMITS.maxConcurrent, DEFAULT_LIMITS.maxFutureMs, DEFAULT_LIMITS.ledgerTimeoutMs]);
    expect([cell('DISPUTE_STARTED_LEASE_MS', 2), cell('DISPUTE_RESOLUTION_DEADLINE_MS', 2)]).toStrictEqual(Array(2).fill('the dispute code decides'));
    expect(Object.keys(config.dispute)).toStrictEqual(['challenge_stake_lovelace', 'min_window_left_ms', 'read_timeout_ms']);
  });

  test('a setting that the table calls required stops the start when it is missing, and no other setting does', () => {
    expect(() => loadConfig(startEnv())).not.toThrow();
    const rows = settingsRows();
    const required = rows.filter(([, , standard]) => standard === 'none. Required').flatMap(([names]) => ticks(names));
    const keys = rows.filter(([, , standard]) => standard === KEY_ROW).map(([names]) => ticks(names)[0]);
    expect(required).toHaveLength(26);
    expect(keys).toStrictEqual(KEY_ROLES.map((role) => KEY_VARIABLES[role]));
    // The settings that stop the start when they are missing are the settings that the table calls required and the seven keys: each other setting has a default or does without.
    const stops = SETTINGS.filter((name) => throws(() => loadConfig(startEnv({ [name]: undefined }))));
    expect([...stops].sort()).toStrictEqual([...required, ...keys].sort());
    // An empty allowlist is a list that holds nobody, and the setting must be there.
    expect(loadConfig(startEnv({ COSIGN_ALLOWLIST: '' })).cosign.allowlist.size).toBe(0);
  });

  test('a key hash is optional and checked when it is set, and the manifest publishes the key hash of the service key and of the two delegation keys', () => {
    const rows = settingsRows().filter(([, , standard]) => standard === KEY_ROW);
    expect(rows.map(([names]) => ticks(names))).toStrictEqual(KEY_ROLES.map((role) => [KEY_VARIABLES[role], PKH_VARIABLES[role]]));
    expect(KEY_ROLES).toHaveLength(7);
    for (const role of KEY_ROLES) {
      expect(() => loadConfig(startEnv({ [PKH_VARIABLES[role]]: undefined })), PKH_VARIABLES[role]).not.toThrow();
      expect(() => loadConfig(startEnv({ [PKH_VARIABLES[role]]: keyOf(rawKey(KEY_NUMBERS[role])).pkh })), PKH_VARIABLES[role]).not.toThrow();
      expect(() => loadConfig(startEnv({ [PKH_VARIABLES[role]]: '0'.repeat(56) })), PKH_VARIABLES[role]).toThrow();
    }
    // The keys of the served manifest.
    const published = JSON.parse(loadConfig(startEnv()).manifest.text) as { keys: { buyer_pkh: string; delegation_pkhs: string[] } };
    const [service, first, second] = (['service', 'delegation1', 'delegation2'] as const).map((role) => keyOf(rawKey(KEY_NUMBERS[role])).pkh);
    expect([published.keys.buyer_pkh, ...published.keys.delegation_pkhs]).toStrictEqual([service, first, second]);
    expect(cell(KEY_VARIABLES.service, 1)).toContain('key hash is `keys.buyer_pkh`');
    expect(cell(KEY_VARIABLES.delegation1, 1)).toContain('key hash is in `keys.delegation_pkhs`');
    expect(cell(KEY_VARIABLES.delegation2, 1)).toContain('key hash is in `keys.delegation_pkhs`');
    expect(section('Settings')).toContain('A `..._PKH` is optional. When it is set, it must be the key hash of the key before it, and the service stops at start when it is not.');
  });

  test('the ranges and the fault value of the table are the code: the price, the window, the limits of a hire, the dispute settings, and the one fault value', async () => {
    expect(cell('ADVERT_PRICE_LOVELACE', 1)).toContain(`at most ${MAX_PRICE_LOVELACE}`);
    expect(cell('ADVERT_MAX_PROCESSING_MS', 1)).toContain(`From ${MIN_PROCESSING_WINDOW_MS} to ${MAX_PROCESSING_WINDOW_MS}`);
    const hire = (prefix: string, price: string): NodeJS.ProcessEnv => ({ [`${prefix}_MAX_PRICE_LOVELACE`]: price, [`${prefix}_MAX_SUPPLIER_BOND_LOVELACE`]: '1000000', [`${prefix}_MAX_BUYER_BOND_LOVELACE`]: '1000000' });
    const holds: Array<[NodeJS.ProcessEnv, boolean]> = [
      [{ ADVERT_PRICE_LOVELACE: String(MAX_PRICE_LOVELACE) }, true], [{ ADVERT_PRICE_LOVELACE: String(MAX_PRICE_LOVELACE + 1) }, false],
      [{ ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS) }, true], [{ ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS - 1) }, false],
      [{ ADVERT_MAX_PROCESSING_MS: String(MAX_PROCESSING_WINDOW_MS) }, true], [{ ADVERT_MAX_PROCESSING_MS: String(MAX_PROCESSING_WINDOW_MS + 1) }, false],
      [hire('LLM', '9998000000'), true], [hire('LLM', '9998000001'), false], [hire('HANDOFF', '9998000000'), true], [hire('HANDOFF', '9998000001'), false],
      [{ DISPUTE_MIN_WINDOW_LEFT_MS: '2000' }, true], [{ DISPUTE_MIN_WINDOW_LEFT_MS: '1999' }, false],
      [{ DISPUTE_STARTED_LEASE_MS: '40000' }, true], [{ DISPUTE_STARTED_LEASE_MS: '39999' }, false],
    ];
    for (const [env, accepted] of holds) expect(throws(() => loadConfig(startEnv(env))), JSON.stringify(env)).toBe(!accepted);
    expect(PRICE_DEFAULT_LOVELACE + SUPPLIER_BOND_LOVELACE + BUYER_BOND_LOVELACE).toBe(5_000_000);
    expect(BUYER_BOND_LOVELACE).toBe(SUPPLIER_BOND_LOVELACE);
    expect(section('Settings')).toContain(`each bond is ${SUPPLIER_BOND_LOVELACE} lovelace, and the lock is 5000000 lovelace for the default price`);
    for (const name of ['LLM_MAX_PRICE_LOVELACE', 'HANDOFF_MAX_PRICE_LOVELACE']) expect(cell(name, 1)).toContain('add up to at most 10000000000 lovelace');
    expect(cell('DISPUTE_MIN_WINDOW_LEFT_MS', 1)).toContain('At least 2000');
    expect(cell('DISPUTE_STARTED_LEASE_MS', 1)).toContain('At least twice `DISPUTE_READ_TIMEOUT_MS`');
    // The resolution deadline must be the deadline of the Module-1 deployment: another value stops the start, and the value of the deployment (259200000 in the fixture) is the twin.
    expect(cell('DISPUTE_RESOLUTION_DEADLINE_MS', 1)).toContain('A value that is not the deadline of the deployment stops the start');
    const other = await start({ DISPUTE_RESOLUTION_DEADLINE_MS: '259200001' }).catch((error: unknown) => error);
    expect(errorText(other)).toMatch(/the Module-1 deployment has 259200000 ms/);
    await expect(start({ DISPUTE_RESOLUTION_DEADLINE_MS: '259200000' })).resolves.toBeDefined();
    // The one fault value: any other value stops the start, and the manifest lists the value without saying which one is active.
    expect(cell('FAULT_MODE', 1)).toContain('empty, or `alter_after_approval`. Any other value stops the start');
    expect(FAULT_MODES['prior-authorization-agent']).toStrictEqual(['alter_after_approval']);
    expect(throws(() => loadConfig(startEnv({ FAULT_MODE: 'confirm_wrong_lot' })))).toBe(true);
    const faulty = loadConfig(startEnv({ FAULT_MODE: 'alter_after_approval' }));
    expect(faulty.fault.mode).toBe('alter_after_approval');
    expect(faulty.manifest.text).toBe(loadConfig(startEnv()).manifest.text);
    expect(manifest.behaviour.fault_modes).toStrictEqual(['alter_after_approval']);
  });

  test('the placeholders of the template are named in the README and are settings', () => {
    const placeholders = [...new Set([...template.matchAll(/<([A-Z0-9_]+)>/g)].map((match) => match[1]))].sort();
    expect(placeholders).toHaveLength(7);
    for (const name of placeholders) {
      expect(readme, name).toContain(`\`<${name}>\``);
      expect(SETTINGS as readonly string[], name).toContain(name);
    }
  });
});

describe('agents/prior-authorization-agent/README.md: Run it', () => {
  const run = section('Run it');

  test('it names the commands of the package, and the refusals of the start that come from a setting, each with its accepted twin', () => {
    expect(run).toContain('The service needs Node 22 or later');
    expect(JSON.parse(textOf('../../../package.json')).engines.node).toBe('>=22');
    const scripts = JSON.parse(textOf('../package.json')).scripts as Record<string, string>;
    expect([scripts.start, scripts.template, scripts.test]).toStrictEqual(['tsx src/index.ts', 'node --import tsx scripts/render-template.mjs', 'vitest run']);
    expect(JSON.parse(textOf('../package.json')).name).toBe('@vsa/prior-authorization-agent');
    for (const command of ['start', 'template']) expect(run).toContain(`pnpm --filter @vsa/prior-authorization-agent ${command}`);
    const service = keyOf(rawKey(KEY_NUMBERS.service));
    const refusals: ReadonlyArray<readonly [says: string, over: NodeJS.ProcessEnv, error: RegExp, twin: NodeJS.ProcessEnv]> = [
      ['when a required setting is not set', { OPERATOR_CONTACT: undefined }, /^environment variable OPERATOR_CONTACT is required/, { OPERATOR_CONTACT: 'ops@example.test' }],
      ['when a setting is not well formed', { PORT: '70000' }, /^environment variable PORT must be a port/, { PORT: '9103' }],
      ['when a `..._PKH` is not the key hash of its key', { PRIORAUTH_SERVICE_PKH: 'ab'.repeat(28) }, /^environment variable PRIORAUTH_SERVICE_PKH \(56 characters\) is not the key hash of the key in PRIORAUTH_SERVICE_PRIV_KEY_HEX/, { PRIORAUTH_SERVICE_PKH: service.pkh }],
      ['when two keys are one key', { PRIORAUTH_DELEGATION_2_PRIV_KEY_HEX: rawKey(KEY_NUMBERS.delegation1) }, /^environment variable PRIORAUTH_DELEGATION_2_PRIV_KEY_HEX holds the same key as PRIORAUTH_DELEGATION_1_PRIV_KEY_HEX/, {}],
      ['when a key is the supplier key', { SUPPLIER_PKH: service.pkh, SUPPLIER_PUB_KEY_HEX: service.publicKeyHex }, /^environment variable PRIORAUTH_SERVICE_PRIV_KEY_HEX holds the key of SUPPLIER_PKH/, {}],
      ['when `FAULT_MODE` is not empty and is not `alter_after_approval`', { FAULT_MODE: 'confirm_wrong_lot' }, /^environment variable FAULT_MODE must be empty or "alter_after_approval"/, { FAULT_MODE: 'alter_after_approval' }],
      ['when a key or the token stands in the wrong line', { OPERATOR_CONTACT: rawKey(KEY_NUMBERS.service) }, /^environment variable OPERATOR_CONTACT holds the service key, which belongs in PRIORAUTH_SERVICE_PRIV_KEY_HEX alone/, {}],
      ['when `VECTOR_OGMIOS_URL` is not an https address', { VECTOR_OGMIOS_URL: 'http://node.example' }, /^environment variable VECTOR_OGMIOS_URL must be an https address/, { VECTOR_OGMIOS_URL: 'https://node.example' }],
      [
        'when `VECTOR_MODULE1_MANIFEST` is not an https address pinned to a commit', { VECTOR_MODULE1_MANIFEST: 'https://198.51.100.7/modules/main/Module-1/manifest.json' },
        /^environment variable VECTOR_MODULE1_MANIFEST must be pinned to a commit/, { VECTOR_MODULE1_MANIFEST: MODULE1_URL },
      ],
      ['when `IDENTITY_POLICY_ID` is not the policy that the four identity values give', { IDENTITY_POLICY_ID: 'ab'.repeat(28) }, /^environment variable IDENTITY_POLICY_ID is not the identity policy that/, {}],
    ];
    for (const [says, over, error, twin] of refusals) {
      expect(run, says).toContain(says);
      expect(messageOf(() => loadConfig(startEnv(over))), says).toMatch(error);
      expect(() => loadConfig(startEnv(twin)), `the twin of ${says}`).not.toThrow();
    }
    // The forms of the address of the Module-1 manifest that the start refuses, and the form that it takes.
    const COMMIT = '1234567890abcdef1234567890abcdef12345678';
    const forms: Array<[string, string]> = [
      ['a file path', '/etc/module1/manifest.json'], ['an http address', `http://198.51.100.7/modules/${COMMIT}/manifest.json`], ['an address with a user', `https://user@198.51.100.7/modules/${COMMIT}/manifest.json`],
      ['an address with a query', `${MODULE1_URL}?x=1`], ['an address with a fragment', `${MODULE1_URL}#x`], ['an address with no commit', 'https://198.51.100.7/modules/main/Module-1/manifest.json'],
    ];
    for (const [what, value] of forms) expect(throws(() => loadConfig(startEnv({ VECTOR_MODULE1_MANIFEST: value }))), what).toBe(true);
    expect(() => loadConfig(startEnv({ VECTOR_MODULE1_MANIFEST: `https://198.51.100.7/modules/${COMMIT}/manifest.json` }))).not.toThrow();
  });

  test('it names the refusals that the start makes once it has read the settings, and the line that a good start logs', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a-file'), 'x');
    const none = ledgerWorld();
    none.getSystemStartMs = async () => { throw new Error('the node does not answer'); };
    const other = (async () => new Response(module1ManifestText('ab'.repeat(28)), { status: 200 })) as typeof fetch;
    const down = (async () => { throw new Error('the network is down'); }) as typeof fetch;
    const refused = async (says: string, env: NodeJS.ProcessEnv, options: StartOptions, error: RegExp, hidden: string[] = []): Promise<void> => {
      expect(run, says).toContain(says);
      const lines: string[] = [];
      const failed = await start(env, { ...options, log: (line) => { lines.push(line); } }).catch((reason: unknown) => reason);
      expect(errorText(failed), says).toMatch(error);
      for (const value of hidden) expect(errorText(failed), `${says}: shows no value`).not.toContain(value);
      expect(lines.some((line) => line.startsWith('listening on ')), `${says}: no listening line`).toBe(false);
    };
    await refused('when the Module-1 manifest cannot be fetched', {}, { fetchImpl: down }, /^The Module-1 manifest \(VECTOR_MODULE1_MANIFEST\) .* cannot be fetched/);
    await refused('when the Module-1 manifest names another identity registry', {}, { fetchImpl: other }, /^the Module-1 manifest \(VECTOR_MODULE1_MANIFEST\) names another identity registry than IDENTITY_POLICY_ID/, ['ab'.repeat(28)]);
    await refused('when the node gives no start time of the chain', {}, { provider: none }, /^the node gave no start time of the chain/);
    await refused('when the state directory cannot be written', { PRIORAUTH_STATE_DIR: join(dir, 'a-file') }, {}, /^environment variable PRIORAUTH_STATE_DIR names .* which cannot be written/);
    const good = await start();
    const config = loadConfig(startEnv({ PRIORAUTH_STATE_DIR: good.dir }));
    const listening = good.log.filter((line) => line.startsWith('listening on '));
    expect(listening).toHaveLength(1);
    expect(listening[0]).toContain(`manifest ${config.manifest.sha256}`);
    for (const role of ['service', 'delegation1', 'delegation2'] as const) expect(listening[0]).toContain(config.keys[role].address);
    expect(listening[0]).toContain(`state directory ${good.dir}`);
    expect(run).toContain('The service logs one `listening` line. It holds the hash of the manifest, the three addresses of the paying wallets and the state directory.');
    // The one file that the start fetches: the Module-1 manifest at an https address that holds the 40 hex characters of a commit.
    expect(run).toContain('`VECTOR_MODULE1_MANIFEST` must be an `https://` address with a path segment of 40 lowercase hex characters');
    expect(run).toContain('it asks the node for the start time of the chain');
  });

  test('it says where the secrets are looked for, as the start does it, and shows no secret', () => {
    expect(run).toContain('Each of the seven keys is looked for in every other setting, in its hex form and in its bech32 form, in any case, and inside a longer value too.');
    expect(run).toContain(`The token is looked for in the same way, whole and by its credential, when it has ${TOKEN_SEARCH_MIN} characters or more.`);
    const key = rawKey(KEY_NUMBERS.service);
    for (const form of [key, key.toUpperCase(), rawHexToBech32(key), `x${key}y`]) {
      const message = messageOf(() => loadConfig(startEnv({ OPERATOR_CONTACT: form })));
      expect(message).toMatch(/^environment variable OPERATOR_CONTACT holds the service key, which belongs in PRIORAUTH_SERVICE_PRIV_KEY_HEX alone/);
      expect(message.toLowerCase()).not.toContain(key);
    }
    const credential = TOKEN.slice('Bearer '.length);
    for (const form of [TOKEN, credential, `x${credential}y`]) {
      const message = messageOf(() => loadConfig(startEnv({ OPERATOR_CONTACT: form })));
      expect(message).toMatch(/^environment variable OPERATOR_CONTACT holds the service token, which belongs in SERVICE_AUTH_HEADER alone/);
      expect(message).not.toContain(credential);
    }
    // A token shorter than the search is not looked for, and the manifest is searched for each secret last.
    expect(() => loadConfig(startEnv({ SERVICE_AUTH_HEADER: 'Bearer abc', OPERATOR_CONTACT: 'abc' }))).not.toThrow();
    expect(messageOf(() => loadConfig(startEnv(), (published) => ({ ...manifestFromEnv(published), description: `leak ${key}` })))).toMatch(/^the manifest would publish /);
    expect(run).toContain('The manifest is searched for each secret too.');
  });
});

describe('agents/prior-authorization-agent/README.md: the routes and the errors', () => {
  const routes = section('Routes');
  const errors = section('Errors');
  const [job, cosign] = errors.split('The co-sign route has its own codes:');
  const jobRows = codeRows(job);
  const cosignRows = codeRows(cosign);
  const documented = [...jobRows, ...cosignRows].flatMap((row) => row.codes);

  test('Routes states the numbers of the code: the body, the request, the limit of the runtime, the reservation, the heartbeat and the deadline of a job', () => {
    expect(routes).toContain(`It is read up to ${MAX_BODY} bytes.`);
    expect(routes).toContain(`The request JSON is read up to ${MAX_REQUEST_BYTES} bytes`);
    expect(checkRequestSize('x'.repeat(MAX_REQUEST_BYTES)).ok).toBe(true);
    expect(checkRequestSize('x'.repeat(MAX_REQUEST_BYTES + 1)).ok).toBe(false);
    const codeOf = (text: string): string | null => {
      try {
        parseJob(text);
        return null;
      } catch (error) {
        return error instanceof RequestError ? error.code : 'other';
      }
    };
    expect([codeOf('x'.repeat(MAX_REQUEST_BYTES + 1)), codeOf(JSON.stringify({ ...PROPOSE, extra: 1 })), codeOf(JSON.stringify(PROPOSE))]).toStrictEqual(['request_too_large', 'bad_shape', null]);
    expect([MAX_BODY, MAX_REQUEST_BYTES, RUNTIME_BODY_LIMIT_BYTES]).toStrictEqual([1_000_000, 900_000, 1_048_576]);
    expect(routes).toContain(`safe only while the escaped body stays below ${RUNTIME_BODY_LIMIT_BYTES} bytes`);
    expect(routes).toContain(`for ${RESERVATION_MS / 1000} s`);
    expect(routes).toContain(`every ${HEARTBEAT_MS / 1000} s`);
    expect([PROPOSE_DEADLINE_MS, EXECUTE_DEADLINE_MS]).toStrictEqual([JOB_DEADLINE_MS, JOB_DEADLINE_MS]);
    expect(routes).toContain(`${JOB_DEADLINE_MS} ms after its request arrives`);
    expect(routes).toContain(`${JOB_DEADLINE_MS + 60_000} ms`);
    expect(routes).toContain(`${MIN_PROCESSING_WINDOW_MS} ms at least`);
    expect(textOf('../src/serve/server.ts')).toContain('abortOnClose: true');
    expect(routes).toContain('A job whose caller hangs up is stopped.');
    // The line of a job and what the log never holds: the manifest says the same of its data handling.
    expect(textOf('../src/serve/server.ts')).toContain("outcome ${result.outcome}, reason ${reason}, exit ${result.exit_state ?? 'none'}, decisions ${result.decisions.length}");
    expect(routes).toContain('The log has one line for each job: the operation, the time it took, the outcome, the reason, the exit and the number of decisions.');
    expect(routes).toContain('The log carries job outcomes, counts and codes, never a record, a justification, a request or a key.');
    expect(manifest.behaviour.data_handling).toContain('The log carries job outcomes, counts and codes, never a record, a justification, a request or a key.');
  });

  test('the routes answer as the table says: the health check, the manifest, the token on POST / and POST /precheck, the go of the shared server, the co-sign route with no token, and 404', async () => {
    const { origin } = await serve({ manifestText: '{"name":"Prior Authorization Agent"}' });
    expect(await (await fetch(`${origin}/healthz`)).json()).toStrictEqual({ ok: true });
    expect(await (await fetch(`${origin}/agent.json`)).text()).toBe('{"name":"Prior Authorization Agent"}');
    for (const path of ['/', '/precheck']) {
      const unauthorized = await fetch(`${origin}${path}`, { method: 'POST', body: '[]' });
      expect([unauthorized.status, await unauthorized.json()]).toStrictEqual([STATUS.unauthorized, { error: 'unauthorized' }]);
    }
    const headers = (escrow: string): Record<string, string> => ({
      authorization: TOKEN, [CONTEXT_HEADERS.escrowRef]: `${escrow.repeat(32)}#0`, [CONTEXT_HEADERS.advertRef]: `${'11'.repeat(32)}#0`, [CONTEXT_HEADERS.advertModel]: PRIORAUTH_MODELS.draft,
      [CONTEXT_HEADERS.buyerPkh]: keyOf(rawKey(KEY_NUMBERS.delegation1)).pkh, [CONTEXT_HEADERS.paymentLovelace]: '5000000', [CONTEXT_HEADERS.deliverByMs]: String(Date.now() + 3_600_000),
    });
    const body = JSON.stringify([{ content: JSON.stringify(PROPOSE), role: 'user' }]);
    const go = await fetch(`${origin}/precheck`, { method: 'POST', body, headers: headers('aa') });
    expect([go.status, await go.json()]).toStrictEqual([200, { go: true, reserved_ms: RESERVATION_MS }]);
    // The slot is reserved for the first escrow: the check and the job of another escrow are busy, and the job gets the code only.
    const busy = await fetch(`${origin}/precheck`, { method: 'POST', body, headers: headers('bb') });
    const busyBody = await bodyOf(busy);
    expect([busy.status, busyBody.error, typeof busyBody.message]).toStrictEqual([STATUS.busy, 'busy', 'string']);
    const held = await fetch(`${origin}/`, { method: 'POST', body, headers: headers('bb') });
    expect([held.status, await held.json()]).toStrictEqual([STATUS.busy, { error: 'busy' }]);
    // A check with no context header, and a job with some of the six, are refused as a bad context.
    const noContext = await fetch(`${origin}/precheck`, { method: 'POST', body, headers: { authorization: TOKEN } });
    expect([noContext.status, (await bodyOf(noContext)).error]).toStrictEqual([SERVER_OWN.bad_context, 'bad_context']);
    // The body is read as a job first: a request that breaks a rule of the intake gets no go and reserves nothing.
    const notARequest = await fetch(`${origin}/precheck`, { method: 'POST', body: JSON.stringify([{ content: JSON.stringify({ ...PROPOSE, op: 'cancel' }), role: 'user' }]), headers: headers('dd') });
    expect([notARequest.status, (await bodyOf(notARequest)).error]).toStrictEqual([STATUS.bad_shape, 'bad_shape']);
    const partial = await fetch(`${origin}/`, { method: 'POST', body, headers: { authorization: TOKEN, [CONTEXT_HEADERS.escrowRef]: `${'cc'.repeat(32)}#0` } });
    expect([partial.status, (await bodyOf(partial)).error]).toStrictEqual([SERVER_OWN.bad_context, 'bad_context']);
    // The co-sign route needs no token: its own answer for a body that is not JSON text is 415. It takes POST only.
    const signed = await fetch(`${origin}/cosign/delegate`, { method: 'POST', body: '{}' });
    expect([signed.status, (await bodyOf(signed)).error]).toStrictEqual([COSIGN.unsupported_media_type, 'unsupported_media_type']);
    for (const [method, path] of [['GET', '/cosign/delegate'], ['GET', '/other'], ['POST', '/other']]) {
      const refused = await fetch(`${origin}${path}`, { method });
      expect([refused.status, await refused.json()], `${method} ${path}`).toStrictEqual([SERVER_OWN.not_found, { error: 'not_found' }]);
    }
  });

  test('the first Errors table gives each code its status as the kit has it, and the co-sign table gives the codes of the co-sign route', () => {
    expect(jobRows.flatMap((row) => row.codes)).toStrictEqual(['bad_wire', 'request_too_large', 'bad_shape', 'bad_context', 'delegation_not_mine', 'unauthorized', 'not_found', 'busy', 'shutting_down', 'internal']);
    for (const { status, codes } of jobRows) for (const code of codes) expect([code, status], code).toStrictEqual([code, STATUS[code] ?? SERVER_OWN[code]]);
    // The handler of the kit answers 405 to a method that is not POST. The service registers the route for POST only, so any other method gets the 404 of the service, and no table has a 405.
    expect(COSIGN.method_not_allowed).toBe(405);
    expect(cosignRows.flatMap((row) => row.codes).sort()).toStrictEqual(Object.keys(COSIGN).filter((code) => code !== 'method_not_allowed').sort());
    for (const { status, codes } of cosignRows) for (const code of codes) expect([code, status], code).toStrictEqual([code, COSIGN[code]]);
    expect(cosign).toContain('The route takes `POST` only. Any other method gets the 404 `not_found` of the service, as an unknown path does.');
  });

  test('a job that does not end well is a 200 result with a reason: the README lists no reason code, and the Errors section holds no code that its two tables do not give', () => {
    expect(errors).toContain('is no HTTP error');
    expect(errors).toContain('It is a 200 result with an `outcome` and a `reason` code.');
    expect(errors).toContain('The table of the reasons is in the page of the agent');
    expect(errors.split('\n').filter((line) => /^\| `/.test(line))).toStrictEqual([]);
    const reasons = [...PROPOSE_FAILURES, ...EVIDENCE_FAILURES, ...EXECUTE_REASONS, ...INSURER_FAILURES].filter((code) => !documented.includes(code));
    expect(reasons.length).toBeGreaterThan(30);
    for (const code of reasons) expect(ticks(readme), `the reason ${code}`).not.toContain(code);
    const words = ticks(errors).filter((word) => /^[a-z_]+$/.test(word));
    expect(words.filter((word) => !documented.includes(word) && word !== 'outcome' && word !== 'reason'), 'a code of the Errors section that no table gives').toStrictEqual([]);
    // A reason that has two or more words in its name stands in the Errors section as no word at all, in backticks or not.
    const plain = new Set(errors.split(/[^a-z_]+/));
    for (const code of reasons.filter((candidate) => candidate.includes('_'))) expect(plain.has(code), `the reason ${code} stands in the Errors section`).toBe(false);
  });
});

describe('agents/prior-authorization-agent/README.md: the stop, the state and what the tests do not show', () => {
  test('Stopping states the numbers of the stop, the exit codes of the stop on a signal, and the rule for a restart', async () => {
    const stopping = section('Stopping');
    expect(stopping).toContain(`waits up to ${SHUTDOWN_WAIT_MS / 1000} s for the job that is running`);
    expect(stopping).toContain(`still in flight after ${JANITOR_STOP_WAIT_MS / 1000} s is abandoned`);
    expect(stopping).toContain(`must be ${(SHUTDOWN_WAIT_MS + 30_000) / 1000} s: the ${SHUTDOWN_WAIT_MS / 1000} s of the wait and 30 s more`);
    expect(stopping).toContain('the service exits 0.');
    expect(stopping).toContain('the service exits 1.');
    // The package compiles for es2022, whose library has no Promise.withResolvers, so the executor form is the one that types here.
    const exitOf = (outcome: 'finished' | 'abandoned', signal: string): Promise<number> => new Promise((resolve) => {
      const target = new EventEmitter();
      stopOnSignals({ shutdown: async () => outcome }, { target, exit: resolve, log: () => undefined });
      target.emit(signal);
    });
    expect([await exitOf('finished', 'SIGTERM'), await exitOf('abandoned', 'SIGINT')]).toStrictEqual([0, 1]);
    expect(stopping).toContain('Stop or restart the service only when the runtime in front of it says `free` at its `/status`.');
  });

  test('State names the files and folders that the wiring keeps, a stranded file for each of the three paying keys, and the interval of the janitors', async () => {
    const state = section('State');
    const paths = state.split('\n').filter((line) => /^\| `/.test(line)).map((line) => ticks(cellsOf(line)[0])[0]);
    expect(paths).toStrictEqual([`keys/<key hash>/${STRANDED_FILE}`, `${STATE_FILES.dispute}/`, `${STATE_FILES.left}/`, STATE_FILES.register, STATE_FILES.counter]);
    expect(state).toContain(`every ${JANITOR_INTERVAL_MS / 1000} s`);
    expect(state).toContain('one file for each of the service key and the two delegation keys');
    const { dir } = await start();
    const config = loadConfig(startEnv({ PRIORAUTH_STATE_DIR: dir }));
    const paying: readonly string[] = ['service', 'delegation1', 'delegation2'];
    for (const role of KEY_ROLES) expect(existsSync(join(dir, 'keys', config.keys[role].pkh)), role).toBe(paying.includes(role));
  });

  test('What this does not show has the words of the gap of the manifest, and the Tests section names files that exist', () => {
    const lead = 'What this does not show: ';
    expect(NOT_SHOWN_GAP.startsWith(lead)).toBe(true);
    expect(manifest.gaps).toContain(NOT_SHOWN_GAP);
    expect(section('What this does not show')).toContain(NOT_SHOWN_GAP.slice(lead.length));
    expect(section('Tests')).toContain('pnpm --filter @vsa/prior-authorization-agent test');
    for (const path of ['test/model', 'test/insurer', 'test/counter', 'test/evidence', 'test/propose', 'test/execute', 'test/serve', 'test/serve/child-fetch.mjs', 'test/dockerfile.test.ts', 'test/readme.test.ts']) {
      expect(section('Tests'), path).toContain(`\`${path}\``);
      expect(existsSync(new URL(`../${path}`, import.meta.url)), path).toBe(true);
    }
  });
});

describe('agents/prior-authorization-agent/README.md: the image, the pack and the secrets', () => {
  test('the Image section says what the Dockerfile and the build context say', () => {
    const image = section('Image');
    const dockerfile = textOf('../Dockerfile');
    const ignored = readFileSync(new URL('.dockerignore', root), 'utf8').split('\n');
    expect(image).toContain('`docker build -f agents/prior-authorization-agent/Dockerfile -t vsa/prior-authorization-agent:dev .`');
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
    for (const part of ['package.json', 'tsconfig.json', 'src']) expect(dockerfile).toContain(`COPY agents/prior-authorization-agent/${part} ./agents/prior-authorization-agent/${part}`);
    expect(dockerfile).not.toMatch(/^COPY agents\/prior-authorization-agent \S/m);
    for (const entry of ['**/test', '**/.env', '**/.env.*', 'node_modules']) expect(ignored, entry).toContain(entry);
    expect(image).toContain('leaves out every folder named `test`, every env file and every `node_modules`');
  });

  test('the Deploy section is three lines that name the three files of the pack', () => {
    const lines = section('Deploy').split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(3);
    for (const [at, file] of ['docker-compose.prior-authorization-agent.yml', '.env.prior-authorization-agent.example', 'RUNBOOK-prior-authorization-agent.md'].entries()) expect(lines[at], file).toContain(`\`deploy/server/${file}\``);
  });

  test('the page holds no run of 64 hex characters and no key in any form, and no secret of the tests', () => {
    expect(readme).not.toMatch(/[0-9a-f]{64}/i);
    expect(readme).not.toMatch(/PRIV_KEY_HEX=["']?[0-9a-f]{16}/i);
    for (const secret of secretsOf()) expect(readme.toLowerCase(), 'a key or the token of the tests').not.toContain(secret.toLowerCase());
  });
});
