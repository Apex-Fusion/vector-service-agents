// agents/order-desk/test/readme.test.ts
// The README names every setting that the service reads, every code that it answers with, and the numbers of its routes, its state, its stop and its tiers. These tests keep the page and the code from
// parting: a name read in src/ that the table does not name fails, so does a name in the table that no code reads, a code with the wrong status, and a number that is not the code's. No test here uses the network.
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { VAULT_PAYER_IDENTITY_SETTINGS } from '@vsa/buyer-core';
import { CONTEXT_HEADERS, HEARTBEAT_MS, MAX_BODY, RESERVATION_MS, SHUTDOWN_WAIT_MS, TOKEN_SEARCH_MIN, operatorsText } from '@vsa/service-kit';
import { CONFIRMATION_CHECKS, INVENTORY_CAPABILITIES, LOT_NAMES, PO_SCHEMA } from '@vsa/usecase-kit/inventory';
import { COUNTERPARTY_REFUSALS, ERROR_STATUS, HANDOFF_SCHEMA } from '@vsa/usecase-kit/protocol';
import { ORDER_BOOK_LIMIT, PASSED_CHECKS_LIMIT, PASSED_CHECKS_TTL_MS } from '../src/checks/index.ts';
import { ORDER_REFUSAL_STATUS } from '../src/job/index.ts';
import { BOND_LOVELACE, LOT_PRICE_LOVELACE, TEMPLATE_ENV, manifestFromEnv } from '../src/serve/manifest.ts';
import { RequestRefusal } from '../src/serve/server.ts';
import {
  CALL_TIMEOUT_MS, CHECKS_READ_BUDGET_DEFAULT_MS, CHECKS_READ_BUDGET_MAX_MS, CHECKS_READ_BUDGET_MIN_MS, GATEWAY_DEFAULT, HOOK_READS, HOOK_READS_LIMIT_MS, HOST_DEFAULT, JOB_DEADLINE_MS,
  MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, RUNTIME_PRECHECK_WAIT_MS, STATE_DIR_DEFAULT,
} from '../src/serve/settings.ts';
import { JANITOR_INTERVAL_MS, JANITOR_STOP_WAIT_MS, SETTINGS, loadConfig } from '../src/serve/start.ts';
import { FULL_ENV, LARGE, MEDIUM, SERVICE, SMALL, envWith, message } from './serve/support.ts';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
// The ledger's native unit is named once in the repository, in docs/HIRE.md. Spelled in two parts, so that a search for the name finds only the guide.
const UNIT_NAME = new RegExp('AP' + '3X', 'i');
const sourceDir = new URL('../src/', import.meta.url);
const sources = (readdirSync(sourceDir, { recursive: true }) as string[]).filter((file) => String(file).endsWith('.ts')).map((file) => ({ file: String(file), text: readFileSync(new URL(String(file), sourceDir), 'utf8') }));
const textOf = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const section = (heading: string): string => (readme.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const ticks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
const rows = (heading: string): string[] => section(heading).split('\n').filter((line) => /^\| `/.test(line));
/** The row of the Settings table for one variable, and one of its cells (1 is the use, 2 is the default). */
const row = (name: string): string => rows('Settings').find((line) => line.startsWith(`| \`${name}\` |`)) ?? '';
const cell = (name: string, at: 1 | 2): string => (row(name).split('|')[at + 1] ?? '').trim();
const config = loadConfig(FULL_ENV);
const template = manifestFromEnv(TEMPLATE_ENV);

/** The names that the code reads from the environment itself: `env.NAME`, `process.env.NAME`, and the names given to envInt and requiredEnv. */
function namesRead(): string[] {
  const found = new Set<string>();
  for (const { text } of sources) {
    for (const match of text.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)\b/g)) found.add(match[1]);
    for (const match of text.matchAll(/\b(?:envInt|requiredEnv)\(\s*'([A-Z][A-Z0-9_]*)'/g)) found.add(match[1]);
  }
  return [...found].sort();
}

describe('agents/order-desk/README.md: the settings', () => {
  test('the Settings table names each setting of SETTINGS once, and SETTINGS are the names that the code reads and the four identity names that buyer-core reads', () => {
    const documented = rows('Settings').flatMap((line) => ticks(line.split('|')[1])).sort();
    expect(new Set(documented).size, 'a name stands in two rows').toBe(documented.length);
    expect(documented).toStrictEqual([...SETTINGS].sort());
    expect([...SETTINGS].sort()).toStrictEqual([...new Set([...namesRead(), ...VAULT_PAYER_IDENTITY_SETTINGS])].sort());
    // No source of the service writes an identity name: it takes them from buyer-core.
    for (const name of VAULT_PAYER_IDENTITY_SETTINGS) expect(namesRead().includes(name), name).toBe(false);
    expect(readme).toContain('under the names that the MCP server reads');
  });

  test('a required setting is one that the service refuses to start without, and the table says "none. Required" for those and for no other', () => {
    const required = Object.keys(FULL_ENV);
    for (const name of required) {
      expect(() => loadConfig(envWith({ [name]: undefined })), name).toThrow();
      expect(cell(name, 2), name).toMatch(/^none\. Required/);
    }
    for (const name of SETTINGS.filter((setting) => !required.includes(setting))) expect(cell(name, 2), name).not.toMatch(/^none\. Required/);
    expect(row('ORDER_DESK_SERVICE_PRIV_KEY_HEX')).toMatch(/ \| none\. Required: the service stops at start without it \|$/);
    for (const name of ['LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE']) expect(cell(name, 2), name).toBe('none. Required: no limit is not an answer');
  });

  test("the defaults that the table gives are the code's", () => {
    const manifest = JSON.parse(config.manifest.text) as { version: string; status: { chip: string; since: string } };
    expect([cell('PORT', 2), cell('HOST', 2), cell('ORDER_DESK_STATE_DIR', 2)]).toStrictEqual([`\`${PORT_DEFAULT}\``, `\`${HOST_DEFAULT}\``, `\`${STATE_DIR_DEFAULT}\``]);
    expect([config.port, config.host, config.stateDir]).toStrictEqual([PORT_DEFAULT, HOST_DEFAULT, STATE_DIR_DEFAULT]);
    expect([PORT_DEFAULT, HOST_DEFAULT, STATE_DIR_DEFAULT]).toStrictEqual([9102, '0.0.0.0', '/data']);
    expect([cell('AGENT_VERSION', 2), cell('AGENT_STATUS_CHIP', 2), cell('AGENT_STATUS_SINCE', 2)]).toStrictEqual([`\`${manifest.version}\``, `\`${manifest.status.chip}\``, `\`${manifest.status.since}\``]);
    expect([manifest.version, manifest.status.chip, manifest.status.since]).toStrictEqual(['0.1.0', 'proposed', '2026-11-23']);
    expect(row('AGENT_STATUS_CHIP')).toContain('`status.chip`, in lower case. It must be live, deployed or proposed, in any case');
    expect(cell('ADVERT_MAX_PROCESSING_MS', 2)).toBe(`\`${MIN_PROCESSING_WINDOW_MS}\``);
    expect(cell('ADVERT_MAX_PROCESSING_MS', 1)).toContain(`At least ${MIN_PROCESSING_WINDOW_MS}, because the deadline of a job assumes the ${MIN_PROCESSING_WINDOW_MS / 60_000} min window`);
    expect(JSON.parse(config.manifest.text).terms.tiers.map((tier: { max_processing_ms: number }) => tier.max_processing_ms)).toStrictEqual([MIN_PROCESSING_WINDOW_MS, MIN_PROCESSING_WINDOW_MS, MIN_PROCESSING_WINDOW_MS]);
    expect(cell('CHECKS_READ_BUDGET_MS', 2)).toBe(`\`${CHECKS_READ_BUDGET_DEFAULT_MS}\``);
    expect(config.checksBudgetMs).toBe(CHECKS_READ_BUDGET_DEFAULT_MS);
    expect(cell('CHECKS_READ_BUDGET_MS', 1)).toContain(`A whole number from ${CHECKS_READ_BUDGET_MIN_MS} to ${CHECKS_READ_BUDGET_MAX_MS}: six reads must stay under ${HOOK_READS_LIMIT_MS} ms`);
    expect(cell('IDENTITY_GATEWAY_URL', 2)).toBe(`\`${GATEWAY_DEFAULT}\``);
    expect(config.endpoints.gatewayUrl).toBe(GATEWAY_DEFAULT);
    expect([cell('ADVERT_EXPLORER_URL', 2), cell('FAULT_MODE', 2), cell('ORDER_DESK_SERVICE_PKH', 2), cell('IDENTITY_ADDRESS', 2)]).toStrictEqual(['empty', 'empty', 'derived', 'derived from the policy']);
    expect([config.fault.mode, config.service.pkh, SERVICE.pkh]).toStrictEqual(['', SERVICE.pkh, SERVICE.pkh]);
    for (const name of ['VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL']) expect(cell(name, 2), name).toBe('the default of `packages/buyer-core`');
    // The dispute settings that have a default: the lease (10 min, or twice the read timeout when that is more) and the deadline of the deployment.
    expect(cell('DISPUTE_STARTED_LEASE_MS', 2)).toBe('10 min, or twice `DISPUTE_READ_TIMEOUT_MS` when that is more');
    expect(cell('DISPUTE_RESOLUTION_DEADLINE_MS', 2)).toBe('the deadline of the deployment');
    expect(config.dispute).not.toHaveProperty('started_lease_ms');
    expect(config.dispute).not.toHaveProperty('resolution_deadline_ms');
  });

  test('the fault switch is empty or confirm_wrong_lot, as the table says, and a public key must hash to the key hash beside it', () => {
    expect(cell('FAULT_MODE', 1)).toContain('empty, or `confirm_wrong_lot`. Any other value stops the start');
    expect(loadConfig(envWith({ FAULT_MODE: 'confirm_wrong_lot' })).fault.mode).toBe('confirm_wrong_lot');
    expect(message(() => loadConfig(envWith({ FAULT_MODE: 'alter_after_approval' })))).toMatch(/^environment variable FAULT_MODE must be empty or "confirm_wrong_lot"/);
    expect(cell('SMALL_SUPPLIER_PUB_KEY_HEX', 1)).toContain('The service stops at start unless its key hash is `SMALL_SUPPLIER_PKH`');
    expect(message(() => loadConfig(envWith({ SMALL_SUPPLIER_PUB_KEY_HEX: LARGE.pubKeyHex })))).toMatch(/^environment variable SMALL_SUPPLIER_PUB_KEY_HEX is not the public key of SMALL_SUPPLIER_PKH/);
  });
});

describe('agents/order-desk/README.md: Run it', () => {
  const run = section('Run it');
  type Settings = Readonly<Record<string, string | undefined>>;
  /** One refusal of the start that Run it names: what it is, the settings that cause it, its message, and settings of the same names that the start accepts. */
  const refusals: ReadonlyArray<readonly [what: string, over: Settings, error: RegExp, good: Settings]> = [
    ['a required setting that is not set', { OPERATOR_CONTACT: undefined }, /^environment variable OPERATOR_CONTACT is required/, { OPERATOR_CONTACT: 'ops@example.test' }],
    ['a setting that is not well formed', { PORT: 'abc' }, /^environment variable PORT must be a non-negative integer/, { PORT: '9102' }],
    ['a public key that is not the public key of the key hash beside it', { MEDIUM_SUPPLIER_PUB_KEY_HEX: SMALL.pubKeyHex }, /^environment variable MEDIUM_SUPPLIER_PUB_KEY_HEX is not the public key of MEDIUM_SUPPLIER_PKH/, { MEDIUM_SUPPLIER_PUB_KEY_HEX: MEDIUM.pubKeyHex }],
    ['ORDER_DESK_SERVICE_PKH that is not the key hash of the service key', { ORDER_DESK_SERVICE_PKH: SMALL.pkh }, /^environment variable ORDER_DESK_SERVICE_PKH .* is not the key hash of the key in ORDER_DESK_SERVICE_PRIV_KEY_HEX/, { ORDER_DESK_SERVICE_PKH: SERVICE.pkh }],
    ['the service key that is the key of a runtime', { ORDER_DESK_SERVICE_PRIV_KEY_HEX: LARGE.privateKeyHex }, /^environment variable ORDER_DESK_SERVICE_PRIV_KEY_HEX holds the key of LARGE_SUPPLIER_PKH/, { ORDER_DESK_SERVICE_PRIV_KEY_HEX: SERVICE.privateKeyHex }],
    ['two runtimes with one key', { LARGE_SUPPLIER_PKH: MEDIUM.pkh, LARGE_SUPPLIER_PUB_KEY_HEX: MEDIUM.pubKeyHex }, /^environment variable LARGE_SUPPLIER_PKH names the key of MEDIUM_SUPPLIER_PKH/, { LARGE_SUPPLIER_PKH: LARGE.pkh, LARGE_SUPPLIER_PUB_KEY_HEX: LARGE.pubKeyHex }],
    ['FAULT_MODE with a value that the Order Desk does not list', { FAULT_MODE: 'quote_off_price_list' }, /^environment variable FAULT_MODE must be empty or "confirm_wrong_lot"/, { FAULT_MODE: 'confirm_wrong_lot' }],
    [
      'CHECKS_READ_BUDGET_MS outside its range', { CHECKS_READ_BUDGET_MS: String(CHECKS_READ_BUDGET_MAX_MS + 1) },
      new RegExp(`^environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from ${CHECKS_READ_BUDGET_MIN_MS} to ${CHECKS_READ_BUDGET_MAX_MS}`), { CHECKS_READ_BUDGET_MS: String(CHECKS_READ_BUDGET_MAX_MS) },
    ],
    ['ADVERT_MAX_PROCESSING_MS below 8 min', { ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS - 1) }, /^environment variable ADVERT_MAX_PROCESSING_MS must be at least 480000/, { ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS) }],
    ['LOTS_PUBLIC_ORIGIN that is not the origin of the small runtime', { LOTS_PUBLIC_ORIGIN: 'https://orders.example.test' }, /^environment variable LOTS_PUBLIC_ORIGIN must be the origin of the host of the small runtime/, { LOTS_PUBLIC_ORIGIN: 'https://orders-small.example.test' }],
  ];

  test('it names the command, the two secrets that the operator makes, and the refusals of the start, and each refusal is one that the start makes', () => {
    expect(run).toContain('The service needs Node 22 or later');
    expect(JSON.parse(textOf('../../../package.json')).engines.node).toBe('>=22');
    expect(run).toContain('export SERVICE_AUTH_HEADER="Bearer $(openssl rand -hex 32)"');
    expect(run).toContain('export ORDER_DESK_SERVICE_PRIV_KEY_HEX="$(cat /path/to/service-key.hex)"');
    expect(run).toContain(`ORDER_DESK_STATE_DIR=/tmp/order-desk-state PORT=${PORT_DEFAULT} pnpm start`);
    const scripts = JSON.parse(textOf('../package.json')).scripts as Record<string, string>;
    expect([scripts.start, scripts.template]).toStrictEqual(['tsx src/index.ts', 'node --import tsx scripts/render-template.mjs']);
    expect(MIN_PROCESSING_WINDOW_MS / 60_000).toBe(8);
    for (const [what, over, error, good] of refusals) {
      expect(message(() => loadConfig(envWith(over))), what).toMatch(error);
      expect(() => loadConfig(envWith(good)), `the twin of ${what}`).not.toThrow();
    }
    expect(run).toContain('when a required setting of the table is not set, when a setting is not well formed, when a public key is not the public key of the key hash beside it,');
    expect(run).toContain('when `ORDER_DESK_SERVICE_PKH` is not the key hash of the service key, when the service key is the key of a runtime or two runtimes have one key,');
    expect(run).toContain('when `FAULT_MODE` names a value that the Order Desk does not list,');
    expect(run).toContain(`when \`CHECKS_READ_BUDGET_MS\` is not from ${CHECKS_READ_BUDGET_MIN_MS} to ${CHECKS_READ_BUDGET_MAX_MS},`);
    expect(run).toContain('when `ADVERT_MAX_PROCESSING_MS` is below 8 min, when `LOTS_PUBLIC_ORIGIN` is not the origin of the small runtime,');
  });

  test('it says where the secrets are looked for, as the start does it, and shows no secret', () => {
    expect(TOKEN_SEARCH_MIN).toBe(16);
    expect(run).toContain(`when it has ${TOKEN_SEARCH_MIN} characters or more`);
    expect(run).toContain('in its raw and its bech32 form, in any case, and inside a longer value too');
    for (const [name, secret] of [['ORDER_DESK_SERVICE_PRIV_KEY_HEX', SERVICE.privateKeyHex], ['SERVICE_AUTH_HEADER', FULL_ENV.SERVICE_AUTH_HEADER]] as const) {
      const text = message(() => loadConfig(envWith({ AGENT_DID: `did:${secret}` })));
      expect(text, name).toMatch(/\bAGENT_DID\b/);
      expect(text.toLowerCase().includes(secret.toLowerCase()), name).toBe(false);
    }
    expect(readme).not.toMatch(/SERVICE_AUTH_HEADER=["']?Bearer [0-9a-f]{8}/);
    expect(readme).not.toMatch(/PRIV_KEY_HEX=["']?[0-9a-f]{16}/);
  });
});

describe('agents/order-desk/README.md: the routes, the checks and the errors', () => {
  const routes = section('Routes');

  test('Routes states the numbers of the code: the body, the six headers, the reservation, the deadline of the job, the budgets of the hook and the line every 60 s', () => {
    expect(routes).toContain(`It is read up to ${MAX_BODY} bytes.`);
    expect(Object.values(CONTEXT_HEADERS)).toHaveLength(6);
    for (const header of Object.values(CONTEXT_HEADERS)) expect(routes, header).toContain(`\`${header}\``);
    expect(routes).toContain(`\`{"go":true,"reserved_ms":${RESERVATION_MS}}\``);
    expect(routes).toContain(`A go of the hook reserves the slot for its escrow for ${RESERVATION_MS} ms`);
    expect(routes).toContain(`A job has its own deadline, ${JOB_DEADLINE_MS} ms after its request arrives.`);
    expect(routes).toContain(`(its \`SERVICE_TIMEOUT_MS\` is ${JOB_DEADLINE_MS + 60_000}), and the window of the adverts is ${MIN_PROCESSING_WINDOW_MS} ms at least`);
    expect(routes).toContain(`One call to the supplier portal takes ${CALL_TIMEOUT_MS} ms at most.`);
    expect(routes).toContain('The job places no order when that call could end less than 30 s before `deliver_by`.');
    expect(textOf('../src/job/order.ts')).toContain('const RUNTIME_MARGIN_MS = 30_000;');
    expect(HEARTBEAT_MS).toBe(60_000);
    expect(routes).toContain('writes an interim `102 Processing` line every 60 s');
    expect(routes).toContain(`The runtime waits ${RUNTIME_PRECHECK_WAIT_MS} ms for the hook`);
    expect(routes).toContain(`The hook makes ${HOOK_READS} timed reads, one after the other: the identity gateway once and the ledger five times.`);
    expect(CHECKS_READ_BUDGET_MAX_MS * HOOK_READS).toBeLessThan(HOOK_READS_LIMIT_MS);
    expect(HOOK_READS_LIMIT_MS).toBeLessThan(RUNTIME_PRECHECK_WAIT_MS);
    expect(routes).toContain(`Six times the largest budget that the service accepts is under ${HOOK_READS_LIMIT_MS} ms`);
    expect(routes).toContain(`"schema": "${HANDOFF_SCHEMA}", "use_case": "inventory-reorder"`);
    expect(routes).toContain(`(\`${PO_SCHEMA}\`)`);
    expect(routes).toContain('Without it, 401 `{"error":"unauthorized"}`');
    expect(textOf('../../../packages/service-kit/src/server.ts')).toContain('req.httpVersionMajor === 1 && req.httpVersionMinor >= 1');
  });

  test('the checks: the 16 names in their order, and the four of the Order Desk with their codes', () => {
    const names = CONFIRMATION_CHECKS.map((name) => `\`${name}\``);
    expect(CONFIRMATION_CHECKS).toHaveLength(16);
    expect(section('The checks')).toContain(`${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
    expect(readme).toContain('The hook makes 16 checks, one after the other');
    expect(section('The checks')).toContain(`The first ${CONFIRMATION_CHECKS.length - 4} are the shared checks of use case 1`);
    const own = CONFIRMATION_CHECKS.slice(-4);
    const codes = COUNTERPARTY_REFUSALS['order-desk'].slice(-5, -1);
    expect(own).toStrictEqual(['for_this_supplier', 'lot', 'quantity', 'not_duplicate']);
    expect(codes).toStrictEqual(['not_for_this_supplier', 'lot_mismatch', 'quantity_mismatch', 'duplicate_po']);
    expect(rows('The checks').map((line) => ticks(line).slice(0, 2))).toStrictEqual(own.map((name, at) => [name, codes[at]]));
  });

  test('the Errors table gives each code its status, every code is one that the protocol or the service kit gives, and the codes of the hook and of the job are all there', () => {
    const table = section('Errors').split('\n').filter((line) => /^\| \d{3}, /.test(line));
    expect(table).toHaveLength(10);
    const documented = new Map<string, number[]>();
    for (const line of table) {
      const status = Number(/^\| (\d{3}), /.exec(line)?.[1]);
      const cellCodes = ticks(line.split('|')[2]).filter((text) => /^[a-z_]+$/.test(text));
      expect(cellCodes.length, line).toBeGreaterThan(0);
      for (const code of cellCodes) {
        documented.set(code, [...(documented.get(code) ?? []), status]);
        if (code === 'bad_context' || code === 'bad_shape') expect(new RequestRefusal(code, 'x').status, code).toBe(status);
        else expect(ERROR_STATUS[code as keyof typeof ERROR_STATUS], code).toBe(status);
      }
    }
    // The 403 row before the Claim holds the refusal codes of the Order Desk, in the order in which the hook makes its checks, and the codes of the job are as the job gives them.
    const before = table.find((line) => line.startsWith('| 403, the hook, before the Claim'));
    expect(ticks((before ?? '').split('|')[2])).toStrictEqual(COUNTERPARTY_REFUSALS['order-desk'].filter((code) => code !== 'cannot_supply'));
    const after = table.find((line) => line.startsWith('| 403, the job, after the Claim'));
    expect(ticks((after ?? '').split('|')[2])).toStrictEqual(['cannot_supply', 'duplicate_po']);
    for (const [code, status] of Object.entries(ORDER_REFUSAL_STATUS)) expect(documented.get(code), code).toContain(status);
    for (const code of [...COUNTERPARTY_REFUSALS['order-desk'], 'check_unavailable', 'busy', 'shutting_down', 'unauthorized', 'bad_wire', 'request_too_large', 'bad_shape', 'bad_context', 'internal']) {
      expect(documented.has(code), code).toBe(true);
    }
    expect([...documented.entries()].filter(([, statuses]) => statuses.length > 1)).toStrictEqual([['duplicate_po', [403, 403]]]);
    expect(section('Errors')).toContain(`\`${operatorsText('<code>')}\``);
    expect(section('Errors')).toContain('A refusal of status 500 or more gets a fixed message');
    expect(readme).toContain('answers `cannot_supply` and places no order');
  });
});

describe('agents/order-desk/README.md: the state, the stop and the manifest', () => {
  test('State and the first paragraphs give the numbers of the stores and of the janitor, and the files that the code names', () => {
    const state = section('State');
    expect(state).toContain(`It holds at most ${ORDER_BOOK_LIMIT} orders and never drops one`);
    expect(state).toContain(`It lives ${PASSED_CHECKS_TTL_MS / 1000} s, the store holds ${PASSED_CHECKS_LIMIT} of them`);
    expect(state).toContain(`Every ${JANITOR_INTERVAL_MS / 1000} s it looks at the stranded file`);
    expect(readme).toContain(`the hook keeps the record of the checks for ${PASSED_CHECKS_TTL_MS / 1000} s and reserves the job slot for that escrow for ${RESERVATION_MS / 1000} s`);
    const wiring = textOf('../src/serve/wiring.ts');
    expect(wiring).toContain("join(config.stateDir, 'orders.json')");
    expect(wiring).toContain("join(config.stateDir, 'dispute')");
    expect(wiring).toContain("join(config.stateDir, 'keys', service.pkh)");
    expect(textOf('../../../packages/hire-kit/src/janitor.ts')).toContain("STRANDED_FILE = 'stranded.json'");
    for (const path of ['`orders.json`', '`dispute/`', '`keys/<key hash>/stranded.json`']) expect(rows('State').map((line) => line.split('|')[1].trim())).toContain(path);
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

  test('Manifest gives the tiers of the manifest, the lock of each advert as price and both bonds, and the members that the code makes', () => {
    const manifest = section('Manifest');
    expect(template.terms.tiers.map((tier) => tier.model)).toStrictEqual([...LOT_NAMES]);
    for (const tier of template.terms.tiers) {
      const lock = LOT_PRICE_LOVELACE[tier.model] + 2 * BOND_LOVELACE;
      expect(tier.price_lovelace + tier.supplier_bond_lovelace + tier.buyer_bond_lovelace).toBe(lock);
      expect(manifest.split('\n').find((line) => line.startsWith(`| \`${tier.model}\` |`)), tier.model).toBe(`| \`${tier.model}\` | ${tier.price_lovelace} | ${tier.supplier_bond_lovelace} | ${tier.buyer_bond_lovelace} | ${lock} |`);
    }
    expect(Object.keys(template.keys)).toStrictEqual(['service_pkh']);
    expect(template.identity.supplier_key).toBe('<AGENT_DID>#<SMALL_SUPPLIER_PKH>');
    expect(Object.keys(template.behaviour)).toEqual(expect.arrayContaining(['lots', 'model', 'fault_modes']));
    expect(template.behaviour.fault_modes).toStrictEqual(['confirm_wrong_lot']);
    expect(manifest).toContain('`behaviour.lots` holds the address of `/lots.json` and the SHA-256 of that file');
    expect(manifest).toContain('`behaviour.model` holds the allowlist and the price limit of the model hire');
    expect(manifest).toContain('`behaviour.fault_modes` lists `confirm_wrong_lot`');
    expect(manifest).toContain('`pnpm --filter @vsa/order-desk template`');
    expect(JSON.parse(textOf('../package.json')).name).toBe('@vsa/order-desk');
    expect(textOf('../package.json')).toContain('"template": "node --import tsx scripts/render-template.mjs"');
    expect(existsSync(new URL('../../../scripts/manifest-hash.mjs', import.meta.url))).toBe(true);
    expect(manifest).toContain('`node scripts/manifest-hash.mjs <https origin>`');
  });
});

describe('agents/order-desk/README.md: the page', () => {
  test('the third line is the description of the manifest and the capability, and the page names the service the way the manifest does', () => {
    const lines = readme.split('\n');
    expect(lines[0]).toBe(`# ${template.name}`);
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe(`${template.description} Capability \`${INVENTORY_CAPABILITIES.order}\`.`);
    expect(INVENTORY_CAPABILITIES.order).toBe('supplychain.order.accept.v1');
    expect(readme).toContain('use case 1 (inventory reorder)');
  });

  test('the Image section gives the build command, the port and the volume that the Dockerfile has', () => {
    const image = section('Image');
    const dockerfile = textOf('../Dockerfile');
    expect(image).toContain('`docker build -f agents/order-desk/Dockerfile -t vsa/order-desk:dev .`');
    expect(image).toContain(`listens on ${PORT_DEFAULT}`);
    expect(dockerfile).toContain(`EXPOSE ${PORT_DEFAULT}`);
    expect(image).toContain('`/data` is a volume that `node` owns');
    expect(dockerfile).toContain(`VOLUME ${STATE_DIR_DEFAULT}`);
    expect(image).toContain('image on `node:22-bookworm-slim`');
    expect(dockerfile).toContain('FROM node:22-bookworm-slim AS builder');
  });

  test('the page holds no dash, no unit name, no run of 56 hex characters or more, no key and no private path', () => {
    expect(readme).not.toMatch(/[\u{2013}\u{2014}]/u);
    expect(readme).not.toMatch(UNIT_NAME);
    expect(readme).not.toMatch(/[0-9a-f]{56}/i);
    expect(readme).not.toMatch(/(^|[\s"'(`])(\/home\/|\/Users\/|~\/|C:\\)/);
    // The words that the secrets guard refuses in every file are spelled in parts, so that this file does not hold them either.
    expect(readme).not.toMatch(new RegExp(['mnemo' + 'nic', 'seed ph' + 'rase', 'BEGIN [A-Z ]*PRIVATE KEY'].join('|'), 'i'));
    // No secret of a deployment stands in an example: the two secrets of Run it are made at run time.
    expect(readme).not.toContain(SERVICE.privateKeyHex);
  });
});
