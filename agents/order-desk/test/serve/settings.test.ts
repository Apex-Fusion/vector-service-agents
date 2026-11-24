// agents/order-desk/test/serve/settings.test.ts
// How the service reads its environment: the defaults, every refusal with its accepted twin, the two secrets kept out of every other line and out of the manifest, the time of the hook, the hosts of the three
// runtimes, the fault switch, and the numbers that the settings take. No test here starts a service or uses the network.
import { describe, expect, test } from 'vitest';
import { VAULT_PAYER_IDENTITY_SETTINGS, rawHexToBech32 } from '@vsa/buyer-core';
import { blake2b224Hex } from '@vsa/vector-read';
import { manifestFromEnv } from '../../src/serve/manifest.ts';
import {
  CHECKS_READ_BUDGET_DEFAULT_MS, CHECKS_READ_BUDGET_MAX_MS, CHECKS_READ_BUDGET_MIN_MS, HOOK_READS, HOOK_READS_LIMIT_MS, PORT_DEFAULT, STATE_DIR_DEFAULT, checksBudgetOf, endpointsOf, lotsOriginOf,
} from '../../src/serve/settings.ts';
import { SETTINGS, loadConfig } from '../../src/serve/start.ts';
import { AGENT_DID, FULL_ENV, LARGE, MEDIUM, MODULE1_COMMIT, MODULE1_URL, ORIGIN, POLICY, SERVICE, SERVICE_ADDRESS, SMALL, TOKEN, envWith, keyOf, message, shows } from './support.ts';

const other = keyOf('order desk settings test: another key');
const ANOTHER_DID = `did:vector:${'ab'.repeat(32)}`;

describe('loadConfig on a full environment', () => {
  test('gives the defaults for everything the operator leaves out, and the identity that the service key derives to', () => {
    const config = loadConfig(FULL_ENV);
    expect([config.host, config.port, config.stateDir, config.fault.mode, config.checksBudgetMs]).toStrictEqual(['0.0.0.0', 9102, '/data', '', 1_200]);
    expect([PORT_DEFAULT, STATE_DIR_DEFAULT, CHECKS_READ_BUDGET_DEFAULT_MS]).toStrictEqual([9102, '/data', 1_200]);
    expect(config.service).toStrictEqual({ privateKeyHex: SERVICE.privateKeyHex, pkh: SERVICE.pkh, address: SERVICE_ADDRESS });
    expect(SERVICE_ADDRESS.startsWith('addr1v')).toBe(true);
    expect(config.agentDid).toBe(AGENT_DID);
    expect(config.authHeader).toBe(TOKEN);
    expect(config.suppliers).toStrictEqual({
      'lot-small': { pkh: SMALL.pkh, pubKeyHex: SMALL.pubKeyHex },
      'lot-medium': { pkh: MEDIUM.pkh, pubKeyHex: MEDIUM.pubKeyHex },
      'lot-large': { pkh: LARGE.pkh, pubKeyHex: LARGE.pubKeyHex },
    });
    expect(config.limits).toStrictEqual({ allowlist: ['deepseek/deepseek-v4-flash'], maxPriceLovelace: 1_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(config.dispute).toStrictEqual({ challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 600_000, read_timeout_ms: 20_000 });
    expect(config.mock).toStrictEqual({ publicBase: 'https://mock.example.test', mtlsBase: 'https://mock-mtls.example.test' });
    expect(config.endpoints.indexerUrl).toBeUndefined();
    expect(config.endpoints.gatewayUrl).toBe('https://id.vector.apexfusion.org');
    expect(config.identityDeployment.identity.hash).toBe(POLICY);
  });

  test('reads every optional setting: the listener, the state directory, the hosts, the indexer, the lease and the deadline of the dispute code; a blank one is not set', () => {
    const config = loadConfig(envWith({
      PORT: '9200', HOST: '127.0.0.1', ORDER_DESK_STATE_DIR: '/var/order-desk', CHECKS_READ_BUDGET_MS: '900', ADVERT_MAX_PROCESSING_MS: '600000',
      VECTOR_OGMIOS_URL: 'http://127.0.0.1:1337', VECTOR_KOIOS_URL: 'https://koios.example.test/', VECTOR_SUBMIT_URL: 'https://submit.example.test/api/submit/tx',
      VECTOR_MARKETPLACE_INDEXER_URL: ' https://indexer.example.test/ ', IDENTITY_GATEWAY_URL: 'https://gateway.example.test',
      DISPUTE_STARTED_LEASE_MS: '1200000', DISPUTE_RESOLUTION_DEADLINE_MS: '259200000',
    }));
    expect([config.port, config.host, config.stateDir, config.checksBudgetMs]).toStrictEqual([9200, '127.0.0.1', '/var/order-desk', 900]);
    expect(config.endpoints).toStrictEqual({
      gatewayUrl: 'https://gateway.example.test', ogmiosUrl: 'http://127.0.0.1:1337', koiosUrl: 'https://koios.example.test/', submitUrl: 'https://submit.example.test/api/submit/tx',
      indexerUrl: 'https://indexer.example.test/',
    });
    expect(config.dispute).toStrictEqual({
      challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 600_000, read_timeout_ms: 20_000, started_lease_ms: 1_200_000, resolution_deadline_ms: 259_200_000,
    });
    const blank = loadConfig(envWith({
      PORT: '', HOST: '', ORDER_DESK_STATE_DIR: ' ', CHECKS_READ_BUDGET_MS: '', ADVERT_MAX_PROCESSING_MS: '', VECTOR_MARKETPLACE_INDEXER_URL: '', IDENTITY_GATEWAY_URL: '', DISPUTE_STARTED_LEASE_MS: '', DISPUTE_RESOLUTION_DEADLINE_MS: '',
    }));
    expect(blank.manifest).toStrictEqual(loadConfig(FULL_ENV).manifest);
    expect([blank.port, blank.host, blank.stateDir, blank.checksBudgetMs, blank.endpoints.indexerUrl]).toStrictEqual([9102, '0.0.0.0', '/data', 1_200, undefined]);
  });

  test('a value that a file leaves a line break or a space around is the value without it', () => {
    const config = loadConfig(envWith({
      OPERATOR_CONTACT: ` ${FULL_ENV.OPERATOR_CONTACT}\n`, ORDER_DESK_SERVICE_PRIV_KEY_HEX: `${SERVICE.privateKeyHex}\r\n`, SMALL_SUPPLIER_PKH: ` ${SMALL.pkh.toUpperCase()}\n`, AGENT_DID: ` ${AGENT_DID}\n`,
      LOTS_PUBLIC_ORIGIN: ` ${ORIGIN}\n`, ORDER_DESK_SERVICE_PKH: ` ${SERVICE.pkh.toUpperCase()} `,
    }));
    expect(config.service.privateKeyHex).toBe(SERVICE.privateKeyHex);
    expect(config.suppliers['lot-small'].pkh).toBe(SMALL.pkh);
    expect(config.manifest).toStrictEqual(loadConfig(FULL_ENV).manifest);
  });
});

/** One refusal of the start: the setting, the value that is refused (undefined: not set), the message, and a value of the same setting that is accepted (the twin). */
type Row = readonly [setting: string, bad: string | undefined, refusal: string | RegExp, good: string | undefined];
const BAD_HASH = 'a'.repeat(56);
const REFUSALS: readonly Row[] = [
  ['OPERATOR_CONTACT', undefined, /^environment variable OPERATOR_CONTACT is required \(.*\) and is not set$/, 'ops@example.test'],
  ['OPERATOR_CONTACT', '  ', /^environment variable OPERATOR_CONTACT is required/, 'ops@example.test'],
  ['ORDER_DESK_SERVICE_PRIV_KEY_HEX', undefined, /^environment variable ORDER_DESK_SERVICE_PRIV_KEY_HEX is required/, other.privateKeyHex],
  ['ORDER_DESK_SERVICE_PRIV_KEY_HEX', SERVICE.privateKeyHex.toUpperCase(), 'environment variable ORDER_DESK_SERVICE_PRIV_KEY_HEX must be 64 lowercase hex characters (a raw Ed25519 key)', other.privateKeyHex],
  ['ORDER_DESK_SERVICE_PRIV_KEY_HEX', SERVICE.privateKeyHex.slice(2), 'environment variable ORDER_DESK_SERVICE_PRIV_KEY_HEX must be 64 lowercase hex characters (a raw Ed25519 key)', other.privateKeyHex],
  ['ORDER_DESK_SERVICE_PRIV_KEY_HEX', `0x${SERVICE.privateKeyHex}`, 'environment variable ORDER_DESK_SERVICE_PRIV_KEY_HEX must be 64 lowercase hex characters (a raw Ed25519 key)', other.privateKeyHex],
  ['SERVICE_AUTH_HEADER', undefined, /^environment variable SERVICE_AUTH_HEADER is required/, `Bearer ${'cd'.repeat(32)}`],
  ['SERVICE_AUTH_HEADER', `Bearer ${'ab'.repeat(30)}\u{e9}`, 'environment variable SERVICE_AUTH_HEADER must be printable ASCII (it is sent as an HTTP header), and it has 68 characters', `Bearer ${'cd'.repeat(32)}`],
  ['AGENT_DID', undefined, /^environment variable AGENT_DID is required/, ANOTHER_DID],
  ['AGENT_DID', 'did:vector:xyz', 'environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters, and it has 14 characters', ANOTHER_DID],
  ['AGENT_DID', 'someone', 'environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters, and it has 7 characters', ANOTHER_DID],
  ['FAULT_MODE', 'alter_after_approval', 'environment variable FAULT_MODE must be empty or "confirm_wrong_lot" for order-desk, got "alter_after_approval"', 'confirm_wrong_lot'],
  ['FAULT_MODE', 'confirm_wrong_lot ', /^environment variable FAULT_MODE must be empty or "confirm_wrong_lot" for order-desk, got /, ''],
  ['FAULT_MODE', 'CONFIRM_WRONG_LOT', /^environment variable FAULT_MODE must be empty or "confirm_wrong_lot" for order-desk/, 'confirm_wrong_lot'],
  ['FAULT_MODE', 'yes', 'environment variable FAULT_MODE must be empty or "confirm_wrong_lot" for order-desk, got "yes"', undefined],
  ['PORT', '70000', 'environment variable PORT must be a port from 0 to 65535, got "70000"', '0'],
  ['PORT', 'abc', 'environment variable PORT must be a non-negative integer, got "abc"', '9102'],
  ['HOST', 'bad host!', 'environment variable HOST must be an address or a host name, got "bad host!"', '127.0.0.1'],
  ['CHECKS_READ_BUDGET_MS', '499', 'environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 1499, got 499', '500'],
  ['CHECKS_READ_BUDGET_MS', '1500', 'environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 1499, got 1500: the hook makes 6 timed reads one after the other, so it can take 9000 ms, and the runtime waits 10000 ms for it. 6 times the budget must be under 9000 ms', '1499'],
  ['CHECKS_READ_BUDGET_MS', '2500', /^environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 1499, got 2500: .* it can take 15000 ms, /, '1200'],
  ['CHECKS_READ_BUDGET_MS', '4001', /^environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 1499, got 4001: /, '1499'],
  ['CHECKS_READ_BUDGET_MS', 'fast', 'environment variable CHECKS_READ_BUDGET_MS must be a non-negative integer, got "fast"', '1200'],
  ['ADVERT_MAX_PROCESSING_MS', '479999', /^environment variable ADVERT_MAX_PROCESSING_MS must be at least 480000 .* got 479999$/, '480000'],
  ['ADVERT_MAX_PROCESSING_MS', '86400001', 'environment variable ADVERT_MAX_PROCESSING_MS must be at most 86400000 (24 h, the longest window that a Post accepts), got 86400001', '86400000'],
  ['ADVERT_MAX_PROCESSING_MS', 'long', 'environment variable ADVERT_MAX_PROCESSING_MS must be a non-negative integer, got "long"', '900000'],
  ['LOTS_PUBLIC_ORIGIN', undefined, /^environment variable LOTS_PUBLIC_ORIGIN is required/, 'https://orders-small.example.test'],
  ['LOTS_PUBLIC_ORIGIN', 'http://orders-small.example.test', 'environment variable LOTS_PUBLIC_ORIGIN must be an https origin with no user, path, query or fragment, got 32 characters', ORIGIN],
  ['LOTS_PUBLIC_ORIGIN', 'https://orders-small.example.test/lots', /^environment variable LOTS_PUBLIC_ORIGIN must be an https origin with no user, path/, ORIGIN],
  ['LOTS_PUBLIC_ORIGIN', 'https://orders.example.test', /^environment variable LOTS_PUBLIC_ORIGIN must be the origin of the host of the small runtime: the first label of its host name ends in -small/, ORIGIN],
  ['LOTS_PUBLIC_ORIGIN', 'https://orders-medium.example.test', /^environment variable LOTS_PUBLIC_ORIGIN must be the origin of the host of the small runtime/, 'https://orders-small.example.test'],
  ['LOTS_PUBLIC_ORIGIN', 'https://orders.small.example.test', /^environment variable LOTS_PUBLIC_ORIGIN must be the origin of the host of the small runtime/, ORIGIN],
  ['MOCK_PUBLIC_BASE', undefined, /^environment variable MOCK_PUBLIC_BASE is required/, 'https://mock.example.test'],
  ['MOCK_PUBLIC_BASE', 'http://mock.example.test', /^environment variable MOCK_PUBLIC_BASE must be an https origin/, 'https://mock.example.test'],
  ['MOCK_PUBLIC_BASE', 'https://mock-mtls.example.test', 'environment variable MOCK_MTLS_BASE must name another host than MOCK_PUBLIC_BASE: the mock service tells the two hosts apart by the Host header', 'https://mock.example.test'],
  ['MOCK_MTLS_BASE', undefined, /^environment variable MOCK_MTLS_BASE is required/, 'https://mock-mtls.example.test'],
  ['MOCK_MTLS_BASE', 'https://mock.example.test/x', /^environment variable MOCK_MTLS_BASE must be an https origin/, 'https://mock-mtls.example.test'],
  ['IDENTITY_GATEWAY_URL', 'http://gateway.example.test', /^environment variable IDENTITY_GATEWAY_URL must be an https origin/, 'https://gateway.example.test'],
  ['VECTOR_OGMIOS_URL', 'ftp://node.example.test', /^environment variable VECTOR_OGMIOS_URL must be an http or https address with no user and no password, and it has 23 characters$/, 'http://127.0.0.1:1337'],
  ['VECTOR_OGMIOS_URL', 'not an address', 'environment variable VECTOR_OGMIOS_URL must be an http or https address, and it has 14 characters', 'https://ogmios.example.test'],
  ['VECTOR_KOIOS_URL', 'https://user:password@koios.example.test', /^environment variable VECTOR_KOIOS_URL must be an http or https address with no user and no password/, 'https://koios.example.test'],
  ['VECTOR_SUBMIT_URL', 'submit.example.test', /^environment variable VECTOR_SUBMIT_URL must be an http or https address/, 'https://submit.example.test/api/submit/tx'],
  ['VECTOR_MARKETPLACE_INDEXER_URL', 'mailto:ops@example.test', /^environment variable VECTOR_MARKETPLACE_INDEXER_URL must be an http or https address/, 'https://indexer.example.test'],
  ['VECTOR_MODULE1_MANIFEST', undefined, /^environment variable VECTOR_MODULE1_MANIFEST is required/, MODULE1_URL],
  ['VECTOR_MODULE1_MANIFEST', '/etc/order-desk/module1.json', 'environment variable VECTOR_MODULE1_MANIFEST must be an https URL with no user, query or fragment, and it has 28 characters', MODULE1_URL],
  [
    'VECTOR_MODULE1_MANIFEST', `http://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/${MODULE1_COMMIT}/Module-1/deploy/identity/mainnet/manifest.json`,
    /^environment variable VECTOR_MODULE1_MANIFEST must be an https URL with no user, query or fragment, and it has \d+ characters$/, MODULE1_URL,
  ],
  [
    'VECTOR_MODULE1_MANIFEST', 'https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/main/Module-1/deploy/identity/mainnet/manifest.json',
    /^environment variable VECTOR_MODULE1_MANIFEST must be pinned to a commit: one segment of its path must be the 40 lowercase hex characters of the commit, .* It has \d+ characters$/, MODULE1_URL,
  ],
  ['LLM_MODEL_ALLOWLIST', undefined, /^environment variable LLM_MODEL_ALLOWLIST is required/, 'a/one, b/two'],
  ['LLM_MODEL_ALLOWLIST', 'deepseek/deepseek-v4-flash free', 'environment variable LLM_MODEL_ALLOWLIST entry 1 must be a model name (letters, digits, dots, underscores, colons, slashes and hyphens)', 'deepseek/deepseek-v4-flash:free'],
  ['LLM_MODEL_ALLOWLIST', ' , ', 'environment variable LLM_MODEL_ALLOWLIST must name at least one model, as a comma-separated list', 'a/one'],
  ['LLM_MAX_PRICE_LOVELACE', undefined, /^environment variable LLM_MAX_PRICE_LOVELACE is required/, '250000'],
  ['LLM_MAX_PRICE_LOVELACE', '1.5', 'environment variable LLM_MAX_PRICE_LOVELACE must be a whole number of lovelace of at least 0, written in digits', '250000'],
  ['LLM_MAX_PRICE_LOVELACE', '0', 'environment variable LLM_MAX_PRICE_LOVELACE must be a whole number of lovelace of more than 0', '1'],
  ['LLM_MAX_SUPPLIER_BOND_LOVELACE', undefined, /^environment variable LLM_MAX_SUPPLIER_BOND_LOVELACE is required/, '1000000'],
  ['LLM_MAX_SUPPLIER_BOND_LOVELACE', '0', 'environment variable LLM_MAX_SUPPLIER_BOND_LOVELACE must be a whole number of lovelace of more than 0, written in digits, and it has 1 characters', '1000000'],
  ['LLM_MAX_BUYER_BOND_LOVELACE', undefined, /^environment variable LLM_MAX_BUYER_BOND_LOVELACE is required/, '1000000'],
  ['LLM_MAX_BUYER_BOND_LOVELACE', 'none', /^environment variable LLM_MAX_BUYER_BOND_LOVELACE must be a whole number of lovelace of more than 0/, '1000000'],
  ['DISPUTE_CHALLENGE_STAKE_LOVELACE', undefined, /^environment variable DISPUTE_CHALLENGE_STAKE_LOVELACE is required/, '50000000'],
  ['DISPUTE_CHALLENGE_STAKE_LOVELACE', '0', /^environment variable DISPUTE_CHALLENGE_STAKE_LOVELACE must be a whole number of lovelace of more than 0/, '50000000'],
  ['DISPUTE_MIN_WINDOW_LEFT_MS', undefined, /^environment variable DISPUTE_MIN_WINDOW_LEFT_MS is required/, '2000'],
  ['DISPUTE_MIN_WINDOW_LEFT_MS', '1999', 'environment variable DISPUTE_MIN_WINDOW_LEFT_MS must be a whole number of milliseconds of at least 2000, and it has 4 characters', '2000'],
  ['DISPUTE_READ_TIMEOUT_MS', undefined, /^environment variable DISPUTE_READ_TIMEOUT_MS is required/, '20000'],
  ['DISPUTE_READ_TIMEOUT_MS', '0', 'environment variable DISPUTE_READ_TIMEOUT_MS must be a whole number of milliseconds of at least 1, and it has 1 characters', '1'],
  ['DISPUTE_STARTED_LEASE_MS', '39999', 'environment variable DISPUTE_STARTED_LEASE_MS must be a whole number of milliseconds of at least 40000, and it has 5 characters', '40000'],
  ['DISPUTE_RESOLUTION_DEADLINE_MS', '1000', /^environment variable DISPUTE_RESOLUTION_DEADLINE_MS must be a whole number of milliseconds of at least 24000000, and it has 4 characters$/, '259200000'],
  ['IDENTITY_POLICY_ID', undefined, /^environment variable IDENTITY_POLICY_ID is not set, but VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED are/, POLICY],
  ['IDENTITY_POLICY_ID', BAD_HASH, /^environment variable IDENTITY_POLICY_ID is not the identity policy that VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED give/, POLICY],
  ['VECTOR_IDENTITY_LEGACY_ROOT', undefined, /VECTOR_IDENTITY_/, FULL_ENV.VECTOR_IDENTITY_LEGACY_ROOT],
  ['VECTOR_IDENTITY_CONFIG_SEED', undefined, /VECTOR_IDENTITY_/, FULL_ENV.VECTOR_IDENTITY_CONFIG_SEED],
  ['VECTOR_IDENTITY_ESCROW_REF_UTXO', undefined, /VECTOR_IDENTITY_ESCROW_REF_UTXO/, FULL_ENV.VECTOR_IDENTITY_ESCROW_REF_UTXO],
  ['VECTOR_IDENTITY_VAULT_REF_UTXO', undefined, /VECTOR_IDENTITY_VAULT_REF_UTXO/, FULL_ENV.VECTOR_IDENTITY_VAULT_REF_UTXO],
  ['SMALL_SUPPLIER_PKH', undefined, /^environment variable SMALL_SUPPLIER_PKH is required/, SMALL.pkh],
  ['SMALL_SUPPLIER_PKH', 'ab', 'environment variable SMALL_SUPPLIER_PKH must be 56 hex characters, and it has 2 characters', SMALL.pkh],
  ['SMALL_SUPPLIER_PKH', BAD_HASH, /^environment variable SMALL_SUPPLIER_PUB_KEY_HEX is not the public key of SMALL_SUPPLIER_PKH: the key hash of the one is not the other/, SMALL.pkh],
  ['SMALL_SUPPLIER_PUB_KEY_HEX', 'ab', 'environment variable SMALL_SUPPLIER_PUB_KEY_HEX must be 64 hex characters, and it has 2 characters', SMALL.pubKeyHex],
  ['MEDIUM_SUPPLIER_PKH', undefined, /^environment variable MEDIUM_SUPPLIER_PKH is required/, MEDIUM.pkh],
  ['MEDIUM_SUPPLIER_PUB_KEY_HEX', LARGE.pubKeyHex, /^environment variable MEDIUM_SUPPLIER_PUB_KEY_HEX is not the public key of MEDIUM_SUPPLIER_PKH/, MEDIUM.pubKeyHex],
  ['LARGE_SUPPLIER_PKH', undefined, /^environment variable LARGE_SUPPLIER_PKH is required/, LARGE.pkh],
  ['LARGE_SUPPLIER_PUB_KEY_HEX', undefined, /^environment variable LARGE_SUPPLIER_PUB_KEY_HEX is required/, LARGE.pubKeyHex],
  ['ORDER_DESK_SERVICE_PKH', other.pkh, `environment variable ORDER_DESK_SERVICE_PKH (56 characters) is not the key hash of the key in ORDER_DESK_SERVICE_PRIV_KEY_HEX (the hash of that key is ${SERVICE.pkh}); correct the line or remove it`, SERVICE.pkh],
];

describe('every refusal of the start, with its accepted twin', () => {
  test.each(REFUSALS)('%s = %j is refused, and the same setting with %j is accepted', (setting, bad, refusal, good) => {
    const text = message(() => loadConfig(envWith({ [setting]: bad })));
    if (typeof refusal === 'string') expect(text).toBe(refusal);
    else expect(text).toMatch(refusal);
    expect(() => loadConfig(envWith({ [setting]: good })), `${setting} = ${String(good)}`).not.toThrow();
  });

  test('the table names a setting of the service in each row, and the settings that no row refuses are the ones that cannot be wrong', () => {
    const names = new Set(REFUSALS.map(([setting]) => setting));
    for (const name of names) expect(SETTINGS as readonly string[], name).toContain(name);
    // Each setting that is required and has no default is in the table, and so is each setting with a form.
    for (const name of ['OPERATOR_CONTACT', 'ORDER_DESK_SERVICE_PRIV_KEY_HEX', 'SERVICE_AUTH_HEADER', 'AGENT_DID', 'LOTS_PUBLIC_ORIGIN', 'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'VECTOR_MODULE1_MANIFEST',
      'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE', 'LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE', 'DISPUTE_CHALLENGE_STAKE_LOVELACE', 'DISPUTE_MIN_WINDOW_LEFT_MS',
      'DISPUTE_READ_TIMEOUT_MS', 'IDENTITY_POLICY_ID', 'SMALL_SUPPLIER_PKH', 'MEDIUM_SUPPLIER_PKH', 'LARGE_SUPPLIER_PKH', 'SMALL_SUPPLIER_PUB_KEY_HEX', 'MEDIUM_SUPPLIER_PUB_KEY_HEX',
      'LARGE_SUPPLIER_PUB_KEY_HEX', ...VAULT_PAYER_IDENTITY_SETTINGS]) expect(names.has(name), name).toBe(true);
  });
});

describe('the fault switch', () => {
  test('is empty or the one fault value of the Order Desk: both start, and the value is read one time into the config', () => {
    expect(loadConfig(FULL_ENV).fault.mode).toBe('');
    expect(loadConfig(envWith({ FAULT_MODE: '' })).fault.mode).toBe('');
    expect(loadConfig(envWith({ FAULT_MODE: 'confirm_wrong_lot' })).fault.mode).toBe('confirm_wrong_lot');
  });

  test('any other value stops the start, and no value of another kind of agent starts it', () => {
    for (const value of ['alter_after_approval', 'invert_scores', 'quote_off_price_list', 'confirm_wrong_lot ', ' confirm_wrong_lot', 'true', '1', 'on', 'wrong_lot']) {
      expect(() => loadConfig(envWith({ FAULT_MODE: value })), value).toThrow(/^environment variable FAULT_MODE must be empty or "confirm_wrong_lot" for order-desk, got /);
    }
  });
});

describe('the time of the hook', () => {
  test('the reads of the hook are six, and the six budgets stay under 9 seconds: the budget is from 500 to 1499, and 1499 is accepted where 1500 is not', () => {
    expect([HOOK_READS, HOOK_READS_LIMIT_MS, CHECKS_READ_BUDGET_MIN_MS, CHECKS_READ_BUDGET_MAX_MS]).toStrictEqual([6, 9_000, 500, 1_499]);
    for (const accepted of [500, 1_200, 1_499]) expect(checksBudgetOf({ CHECKS_READ_BUDGET_MS: String(accepted) }), String(accepted)).toBe(accepted);
    for (const refused of [499, 1_500, 2_500, 4_000, 4_001]) expect(() => checksBudgetOf({ CHECKS_READ_BUDGET_MS: String(refused) }), String(refused)).toThrow(/^environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 1499, got /);
    expect(checksBudgetOf({})).toBe(1_200);
  });

  test('the range that the message names is the range that the start accepts, and it is the widest range whose six reads stay under 9 seconds', () => {
    const [, from, to] = /from (\d+) to (\d+)/.exec(message(() => checksBudgetOf({ CHECKS_READ_BUDGET_MS: '1' }))) ?? [];
    const [least, most] = [Number(from), Number(to)];
    expect([least, most]).toStrictEqual([CHECKS_READ_BUDGET_MIN_MS, CHECKS_READ_BUDGET_MAX_MS]);
    for (const ms of [least, most]) expect(checksBudgetOf({ CHECKS_READ_BUDGET_MS: String(ms) }), String(ms)).toBe(ms);
    for (const ms of [least - 1, most + 1]) expect(() => checksBudgetOf({ CHECKS_READ_BUDGET_MS: String(ms) }), String(ms)).toThrow(`from ${least} to ${most}, got ${ms}`);
    expect(most * HOOK_READS).toBeLessThan(HOOK_READS_LIMIT_MS);
    expect((most + 1) * HOOK_READS).toBeGreaterThanOrEqual(HOOK_READS_LIMIT_MS);
    // The default is inside the range.
    expect(CHECKS_READ_BUDGET_DEFAULT_MS).toBeGreaterThanOrEqual(least);
    expect(CHECKS_READ_BUDGET_DEFAULT_MS).toBeLessThanOrEqual(most);
  });
});

describe('the hosts of the three runtimes', () => {
  test('are derived from the host of the small runtime: the same name with -medium and -large in place of -small, and the port stays', () => {
    expect(endpointsOf('https://mp-suppliers-orders-small.vector.example.org')).toStrictEqual({
      'lot-small': 'https://mp-suppliers-orders-small.vector.example.org',
      'lot-medium': 'https://mp-suppliers-orders-medium.vector.example.org',
      'lot-large': 'https://mp-suppliers-orders-large.vector.example.org',
    });
    expect(endpointsOf('https://orders-small:8443')).toStrictEqual({ 'lot-small': 'https://orders-small:8443', 'lot-medium': 'https://orders-medium:8443', 'lot-large': 'https://orders-large:8443' });
    // The first label only: a later label that ends in -small is not the label that the rule reads.
    expect(endpointsOf('https://orders-small.small-small.example.org')['lot-medium']).toBe('https://orders-medium.small-small.example.org');
    expect(lotsOriginOf({ LOTS_PUBLIC_ORIGIN: 'https://orders-small.example.org' })).toBe('https://orders-small.example.org');
  });

  test('a host that does not fit stops the start, naming the setting: no -small, a host of another tier, an address, a label that only contains the word', () => {
    for (const origin of ['https://orders.example.org', 'https://orders-medium.example.org', 'https://orders-large.example.org', 'https://smallorders.example.org', 'https://orders-smallest.example.org', 'https://127.0.0.1', 'https://small.example.org']) {
      expect(() => endpointsOf(origin), origin).toThrow(/^environment variable LOTS_PUBLIC_ORIGIN must be the origin of the host of the small runtime: the first label of its host name ends in -small/);
    }
  });
});

describe('the service key and the token in the lines of other settings', () => {
  const lines = (secret: string): string[] => [secret, secret.toUpperCase(), `prefix-${secret}-suffix`, `did:vector:agent:${secret}`];

  test('the service key in any other setting is refused, naming that setting and not showing the key: raw, in another case, inside a longer value, and as bech32', () => {
    const key = SERVICE.privateKeyHex;
    for (const name of SETTINGS.filter((setting) => setting !== 'ORDER_DESK_SERVICE_PRIV_KEY_HEX')) {
      for (const value of [...lines(key), rawHexToBech32(key)]) {
        const text = message(() => loadConfig(envWith({ [name]: value })));
        expect(text, `${name} = ${value.slice(0, 12)}`).toBe(`environment variable ${name} holds the service key, which belongs in ORDER_DESK_SERVICE_PRIV_KEY_HEX alone: it would be printed or published. Take it out of ${name}`);
        expect(shows(text, key)).toBe(false);
      }
    }
  });

  test('the token in any other setting is refused, naming that setting and not showing it: whole or by its credential, in any case, inside a longer value', () => {
    const credential = TOKEN.slice('Bearer '.length);
    for (const name of SETTINGS.filter((setting) => setting !== 'SERVICE_AUTH_HEADER' && setting !== 'ORDER_DESK_SERVICE_PRIV_KEY_HEX')) {
      for (const value of [TOKEN, credential.toUpperCase(), `x${credential}y`]) {
        const text = message(() => loadConfig(envWith({ [name]: value })));
        expect(text, name).toBe(`environment variable ${name} holds the service token, which belongs in SERVICE_AUTH_HEADER alone: it would be printed or published. Take it out of ${name}`);
        expect(shows(text, credential)).toBe(false);
      }
    }
    // In the line of the key, the token is refused by the form of a key, which shows nothing either.
    expect(message(() => loadConfig(envWith({ ORDER_DESK_SERVICE_PRIV_KEY_HEX: TOKEN })))).toBe('environment variable ORDER_DESK_SERVICE_PRIV_KEY_HEX must be 64 lowercase hex characters (a raw Ed25519 key)');
  });

  test('a short value that is not a secret in a line is accepted: the search is for the whole key and the whole token', () => {
    expect(() => loadConfig(envWith({ OPERATOR_CONTACT: `ops-${SERVICE.privateKeyHex.slice(0, 20)}@example.test` }))).not.toThrow();
    expect(() => loadConfig(envWith({ OPERATOR_CONTACT: `ops-${TOKEN.slice(0, 12)}@example.test` }))).not.toThrow();
  });
});

describe('the keys of the service and of the three runtimes', () => {
  test('the key hash that the operator wrote down is taken in any case, and a key of a runtime is never the service key', () => {
    expect(loadConfig(envWith({ ORDER_DESK_SERVICE_PKH: SERVICE.pkh.toUpperCase() })).manifest).toStrictEqual(loadConfig(FULL_ENV).manifest);
    const asRuntime = { ORDER_DESK_SERVICE_PRIV_KEY_HEX: SMALL.privateKeyHex };
    expect(message(() => loadConfig(envWith(asRuntime)))).toBe("environment variable ORDER_DESK_SERVICE_PRIV_KEY_HEX holds the key of SMALL_SUPPLIER_PKH: the supplier keys are the runtimes', and the service key must be a key of its own");
    expect(message(() => loadConfig(envWith({ ORDER_DESK_SERVICE_PRIV_KEY_HEX: LARGE.privateKeyHex })))).toContain('holds the key of LARGE_SUPPLIER_PKH');
    // The same service key beside the keys of three runtimes of their own starts.
    expect(loadConfig(FULL_ENV).service.pkh).toBe(SERVICE.pkh);
  });

  test('two runtimes with one key are refused, naming the two settings: each runtime has a key of its own', () => {
    const shared = { MEDIUM_SUPPLIER_PKH: SMALL.pkh, MEDIUM_SUPPLIER_PUB_KEY_HEX: SMALL.pubKeyHex };
    expect(message(() => loadConfig(envWith(shared)))).toBe('environment variable MEDIUM_SUPPLIER_PKH names the key of SMALL_SUPPLIER_PKH: each runtime has a key of its own');
    expect(message(() => loadConfig(envWith({ LARGE_SUPPLIER_PKH: MEDIUM.pkh, LARGE_SUPPLIER_PUB_KEY_HEX: MEDIUM.pubKeyHex })))).toBe('environment variable LARGE_SUPPLIER_PKH names the key of MEDIUM_SUPPLIER_PKH: each runtime has a key of its own');
    expect(blake2b224Hex(SMALL.pubKeyHex)).toBe(SMALL.pkh);
  });

  test('a private key in the line of a public key is refused by the key hash that the line must give, and the message shows nothing of it', () => {
    const text = message(() => loadConfig(envWith({ SMALL_SUPPLIER_PUB_KEY_HEX: SMALL.privateKeyHex })));
    expect(text).toMatch(/^environment variable SMALL_SUPPLIER_PUB_KEY_HEX is not the public key of SMALL_SUPPLIER_PKH/);
    expect(shows(text, SMALL.privateKeyHex)).toBe(false);
  });
});

describe('the manifest is looked at last', () => {
  test('for the service key in both its forms and in any case, and for the token: whatever puts either in a value that is published, the start stops, unprinted', () => {
    for (const leaked of [SERVICE.privateKeyHex, SERVICE.privateKeyHex.toUpperCase(), rawHexToBech32(SERVICE.privateKeyHex)]) {
      const text = message(() => loadConfig(FULL_ENV, (env, lots) => ({ ...manifestFromEnv(env, lots), description: `from somewhere else: ${leaked}` })));
      expect(text).toBe('the manifest would publish the service key: a value that goes into it holds the key, and the service does not start with it');
    }
    const token = message(() => loadConfig(FULL_ENV, (env, lots) => ({ ...manifestFromEnv(env, lots), description: `from somewhere else: ${TOKEN}` })));
    expect(token).toBe('the manifest would publish the service token: a value that goes into it holds the token of SERVICE_AUTH_HEADER, and the service does not start with it');
  });

  test('the builder of the manifest is given an environment with no secret in it', () => {
    let seen: NodeJS.ProcessEnv = {};
    loadConfig(FULL_ENV, (env, lots) => { seen = env; return manifestFromEnv(env, lots); });
    expect(Object.keys(seen)).not.toContain('ORDER_DESK_SERVICE_PRIV_KEY_HEX');
    expect(Object.keys(seen)).not.toContain('SERVICE_AUTH_HEADER');
    expect(JSON.stringify(seen)).not.toContain(SERVICE.privateKeyHex);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });

  test('a manifest that the kit refuses stops the start with its code: a placeholder in a served value', () => {
    expect(message(() => loadConfig(envWith({ OPERATOR_CONTACT: '<OPERATOR_CONTACT>' })))).toMatch(/^the manifest is refused \(manifest_has_placeholder\)/);
  });
});

describe('the manifest that the start renders for each setting of the fault switch', () => {
  // A builder that lets the fault setting into the bytes of the manifest. The start gives the builder each setting of the switch, one after the other, in the environment that it passes. The live value of
  // FAULT_MODE is not what the builder reads: a builder that reads the live value gives one text for every setting, and the check would prove nothing.
  const leaking: Parameters<typeof loadConfig>[1] = (env, lots) => ({ ...manifestFromEnv(env, lots), description: `${manifestFromEnv(env, lots).description}${env.FAULT_MODE ?? ''}` });
  const faithful: Parameters<typeof loadConfig>[1] = (env, lots) => manifestFromEnv(env, lots);

  test('a manifest that changes with the fault setting stops the start with manifest_changes_with_fault, whatever the live value is, and the twin that does not change starts', () => {
    for (const live of ['', 'confirm_wrong_lot']) {
      expect(message(() => loadConfig(envWith({ FAULT_MODE: live }), leaking)), `live value ${JSON.stringify(live)}`).toMatch(/^the manifest is refused \(manifest_changes_with_fault\)/);
      expect(() => loadConfig(envWith({ FAULT_MODE: live }), faithful), `the twin, live value ${JSON.stringify(live)}`).not.toThrow();
    }
  });

  test('the builder is given every setting of the switch and nothing else in the member FAULT_MODE: the empty setting, and the fault value, whatever the live value is', () => {
    for (const live of ['', 'confirm_wrong_lot']) {
      const seen: string[] = [];
      loadConfig(envWith({ FAULT_MODE: live }), (env, lots) => { seen.push(env.FAULT_MODE ?? '(none)'); return manifestFromEnv(env, lots); });
      expect(new Set(seen), `live value ${JSON.stringify(live)}`).toStrictEqual(new Set(['', 'confirm_wrong_lot']));
    }
  });
});

describe('VECTOR_MODULE1_MANIFEST is an https URL pinned to a commit', () => {
  const PINNED = `https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/${MODULE1_COMMIT}/Module-1/deploy/identity/mainnet/manifest.json`;
  const FORM = /^environment variable VECTOR_MODULE1_MANIFEST must be an https URL with no user, query or fragment, and it has \d+ characters$/;
  const PIN = /^environment variable VECTOR_MODULE1_MANIFEST must be pinned to a commit: one segment of its path must be the 40 lowercase hex characters of the commit, .* It has \d+ characters$/;
  const manifestAt = (value: string): string => message(() => loadConfig(envWith({ VECTOR_MODULE1_MANIFEST: value })));

  test('the address of a raw file at a commit is accepted, as the start takes it: the commit is one whole segment of the path, wherever it stands in the path, and a port is allowed', () => {
    for (const url of [PINNED, MODULE1_URL, `https://raw.example.test:8443/${MODULE1_COMMIT}`, `https://raw.example.test/a/b/${MODULE1_COMMIT}/c/manifest.json`, `https://raw.example.test/${MODULE1_COMMIT}/`]) {
      expect(loadConfig(envWith({ VECTOR_MODULE1_MANIFEST: url })).module1Manifest, url).toBe(url);
    }
    expect(loadConfig(envWith({ VECTOR_MODULE1_MANIFEST: ` ${PINNED}\n` })).module1Manifest).toBe(PINNED);
  });

  test('a file path, a relative path, an http address, a text that is no address, and an address with a user, a query or a fragment are refused, by the name of the setting', () => {
    for (const value of [
      '/etc/order-desk/module1.json', 'module1.json', './module1.json', 'file:///etc/order-desk/module1.json', `http://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/${MODULE1_COMMIT}/manifest.json`,
      `HTTPS://raw.example.test/${MODULE1_COMMIT}/manifest.json`, 'https://', 'not an address', `https://someone:a-password@raw.example.test/${MODULE1_COMMIT}/manifest.json`,
      `https://someone@raw.example.test/${MODULE1_COMMIT}/manifest.json`, `https://raw.example.test/${MODULE1_COMMIT}/manifest.json?ref=main`, `https://raw.example.test/${MODULE1_COMMIT}/manifest.json#top`,
      `https://raw.example.test/${MODULE1_COMMIT}/manifest.json?`,
    ]) {
      expect(manifestAt(value), value).toMatch(FORM);
    }
  });

  test('an address that names no commit is refused as unpinned: a branch, a tag, a commit that is too short or too long, a commit in capitals, a run inside a longer segment, and a commit that is not in the path', () => {
    for (const value of [
      'https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/main/Module-1/deploy/identity/mainnet/manifest.json', 'https://raw.example.test/refs/tags/v1.0.0/manifest.json',
      `https://raw.example.test/${MODULE1_COMMIT.slice(1)}/manifest.json`, `https://raw.example.test/${MODULE1_COMMIT}0/manifest.json`, `https://raw.example.test/${MODULE1_COMMIT.toUpperCase()}/manifest.json`,
      `https://raw.example.test/x${MODULE1_COMMIT}/manifest.json`, `https://raw.example.test/${MODULE1_COMMIT}.json`, `https://${MODULE1_COMMIT}.example.test/manifest.json`, 'https://raw.example.test/manifest.json',
      `https://raw.example.test/${MODULE1_COMMIT.slice(0, 20)}/${MODULE1_COMMIT.slice(20)}/manifest.json`, `https://raw.example.test/%61${MODULE1_COMMIT.slice(1)}/manifest.json`,
    ]) {
      expect(manifestAt(value), value).toMatch(PIN);
    }
    // The path that the start takes is the path that the fetch takes: a commit that a dot segment removes is not in the path.
    expect(manifestAt(`https://raw.example.test/${MODULE1_COMMIT}/../main/manifest.json`)).toMatch(PIN);
  });

  test('the message names the setting and the length of the value, and shows nothing else of it: not a user, a password, a key in a query, or the host', () => {
    const secret = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12';
    for (const value of [
      `https://someone:${secret}@raw.example.test/${MODULE1_COMMIT}/manifest.json`, `https://raw.example.test/${MODULE1_COMMIT}/manifest.json?key=${secret}`, `https://raw.example.test/${secret.slice(1)}/manifest.json`,
      `/home/someone/${secret}.json`,
    ]) {
      const text = manifestAt(value);
      expect(text, value).toMatch(/^environment variable VECTOR_MODULE1_MANIFEST must be /);
      for (const part of [secret, secret.slice(1), 'someone', 'raw.example.test', MODULE1_COMMIT]) expect(text.includes(part), `${part} in the message for ${value}`).toBe(false);
      expect(text).toContain(`${value.length} characters`);
    }
  });
});
