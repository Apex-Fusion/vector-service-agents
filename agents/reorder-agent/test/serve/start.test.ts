// agents/reorder-agent/test/serve/start.test.ts
// How the Reorder Agent starts and stops. The settings: every name the service reads, and a table of every start refusal with its accepted twin. The secrets: each of the five keys and the token is kept out of
// every other line, out of the manifest, out of the log and out of a message. The fault switch: any value stops the start. The start itself, with the parts that a test replaces: the line it logs, the manifest it
// serves and the hash that the script of the repository prints for it, the state directory, a node that gives no start time, and the stop. Then `src/index.ts` as a process, against a stand-in node.
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { VAULT_PAYER_IDENTITY_SETTINGS, rawHexToBech32 } from '@vsa/buyer-core';
import { INDEXER, marketplace, vaultChainWith } from '@vsa/hire-kit/testing';
import { renderManifest } from '@vsa/usecase-kit/manifest';
import { world } from '../../../../packages/usecase-kit/test/cosign/support.ts';
import { keyOf } from '../../src/serve/keys.ts';
import { manifestFromEnv } from '../../src/serve/manifest.ts';
import { SETTINGS, loadConfig, startService, stopOnSignals } from '../../src/serve/start.ts';
import type { StartOptions } from '../../src/serve/start.ts';
import {
  KEY_NUMBERS, KEY_VARIABLES, MODULE1_COMMIT, MODULE1_FIXTURE, MODULE1_URL, PKH_VARIABLES, PRINCIPAL, ROLES, SUPPLIER, TOKEN, cleanDirs, completeEnv, messageOf, rawKey, secretsOf, tempDir, withModule1,
} from './support.ts';
import type { Role } from './support.ts';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const agentDir = fileURLToPath(new URL('../../', import.meta.url));
/** The preload that a child process loads before the service: it answers the fetch of the Module-1 manifest, the one fetch of the start that is not a call to the node. */
const childFetch = fileURLToPath(new URL('./child-fetch.mjs', import.meta.url));
const SERVICE_HEX = rawKey(KEY_NUMBERS.service);

afterEach(async () => {
  cleanDirs();
  await Promise.all(open.splice(0).map((close) => close()));
});
const open: Array<() => Promise<void>> = [];

describe('the settings', () => {
  const COMMON = [
    'OPERATOR_CONTACT', 'AGENT_DID', 'IDENTITY_POLICY_ID', 'IDENTITY_ADDRESS', 'AGENT_VERSION', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL', 'SERVICE_AUTH_HEADER', 'FAULT_MODE', 'PORT', 'HOST',
    'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL', 'VECTOR_IDENTITY_LEGACY_ROOT', 'VECTOR_IDENTITY_CONFIG_SEED', 'VECTOR_IDENTITY_ESCROW_REF_UTXO',
    'VECTOR_IDENTITY_VAULT_REF_UTXO', 'VECTOR_MODULE1_MANIFEST', 'IDENTITY_GATEWAY_URL', 'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE', 'LLM_MAX_SUPPLIER_BOND_LOVELACE',
    'LLM_MAX_BUYER_BOND_LOVELACE', 'DISPUTE_CHALLENGE_STAKE_LOVELACE', 'DISPUTE_MIN_WINDOW_LEFT_MS', 'DISPUTE_READ_TIMEOUT_MS', 'DISPUTE_RESOLUTION_DEADLINE_MS', 'DISPUTE_STARTED_LEASE_MS',
  ];
  const OWN = [
    'REORDER_STATE_DIR', 'ADVERT_PRICE_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'STOCK_READER_DID', 'HANDOFF_MAX_PRICE_LOVELACE', 'HANDOFF_MAX_SUPPLIER_BOND_LOVELACE',
    'HANDOFF_MAX_BUYER_BOND_LOVELACE', 'COSIGN_ALLOWLIST', 'COSIGN_MAX_CONCURRENT', 'COSIGN_MAX_FUTURE_MS', 'COSIGN_LEDGER_TIMEOUT_MS',
    'REORDER_SERVICE_PRIV_KEY_HEX', 'REORDER_SERVICE_PKH', 'REORDER_DELEGATION_1_PRIV_KEY_HEX', 'REORDER_DELEGATION_1_PKH', 'REORDER_DELEGATION_2_PRIV_KEY_HEX', 'REORDER_DELEGATION_2_PKH',
    'STOCK_READER_AUTH_PRIV_KEY_HEX', 'STOCK_READER_AUTH_PKH', 'STOCK_READER_DELEGATION_PRIV_KEY_HEX', 'STOCK_READER_DELEGATION_PKH',
  ];

  test('SETTINGS is exactly the settings of the service: the settings of both use-case services, the settings of the Reorder Agent and its five keys, each name once', () => {
    expect([...SETTINGS].sort()).toStrictEqual([...COMMON, ...OWN].sort());
    expect(new Set(SETTINGS).size).toBe(SETTINGS.length);
    expect(SETTINGS).toHaveLength(56);
    for (const name of VAULT_PAYER_IDENTITY_SETTINGS) expect(SETTINGS).toContain(name);
    expect(SETTINGS.filter((name) => name.endsWith('_PRIV_KEY_HEX'))).toStrictEqual(Object.values(KEY_VARIABLES));
    expect(SETTINGS.filter((name) => name.endsWith('_PKH') && name !== 'SUPPLIER_PKH')).toStrictEqual(Object.values(PKH_VARIABLES));
    // The supplier key is the runtime's: its private variable is no setting of the service.
    expect(SETTINGS as readonly string[]).not.toContain('SUPPLIER_PRIV_KEY_HEX');
  });

  test('the complete environment of the tests loads, with every setting as the readers give it', () => {
    const env = completeEnv({ REORDER_STATE_DIR: '/var/state', PORT: '9300' });
    const config = loadConfig(env);
    expect(config).toMatchObject({ host: '127.0.0.1', port: 9300, stateDir: '/var/state', authHeader: TOKEN, module1Manifest: env.VECTOR_MODULE1_MANIFEST, supplier: { pkh: SUPPLIER.keyHash } });
    expect(config.fault.mode).toBe('');
    expect(config.agentDid).toBe(env.AGENT_DID);
    expect(config.stockReaderDid).toBe(env.STOCK_READER_DID);
    expect(config.modelLimits.maxBuyerBondLovelace).toBe(2_000_000n);
    expect(config.handoffLimits.maxPriceLovelace).toBe(10_000_000n);
    expect(config.dispute.challenge_stake_lovelace).toBe(50_000_000n);
    expect(config.cosign.allowlist.has(PRINCIPAL.keyHash)).toBe(true);
    for (const role of ROLES) expect(config.keys[role].pkh).toBe(keyOf(rawKey(KEY_NUMBERS[role])).pkh);
    // The manifest is the render of the manifest environment, with the key hashes that the service derived from its keys.
    const published = renderManifest('reorder-agent', () => manifestFromEnv({ ...env, REORDER_SERVICE_PKH: config.keys.service.pkh, REORDER_DELEGATION_1_PKH: config.keys.delegation1.pkh, REORDER_DELEGATION_2_PKH: config.keys.delegation2.pkh }));
    expect(published.ok && published.value).toStrictEqual(config.manifest);
  });

  test('the defaults: the listener, the state directory, and the settings that the service leaves to the chain code', () => {
    const config = loadConfig(completeEnv({ PORT: undefined, HOST: undefined, REORDER_STATE_DIR: undefined }));
    expect([config.port, config.host, config.stateDir]).toStrictEqual([9101, '0.0.0.0', '/data']);
    expect(config.endpoints.gatewayUrl).toBe('https://id.vector.apexfusion.org');
    expect(config.endpoints.indexerUrl).toBeUndefined();
  });
});

/** One refusal of the start and its accepted twin: the variable with a value that breaks a rule, and the same variable with a value that the rule takes. */
interface Row {
  readonly variable: string;
  readonly what: string;
  readonly bad: string | undefined;
  readonly message: RegExp;
  readonly good: string | undefined;
}

describe('every refusal of the start has its accepted twin', () => {
  const required = (variable: string, good: string): Row => ({ variable, what: 'is not set', bad: undefined, message: new RegExp(`^environment variable ${variable} is required`), good });
  const REQUIRED: Row[] = [
    required('OPERATOR_CONTACT', 'ops@example.test'),
    ...ROLES.map((role) => required(KEY_VARIABLES[role], rawKey(KEY_NUMBERS[role]))),
    required('SERVICE_AUTH_HEADER', TOKEN),
    required('AGENT_DID', completeEnv().AGENT_DID as string),
    required('STOCK_READER_DID', completeEnv().STOCK_READER_DID as string),
    required('SUPPLIER_PKH', SUPPLIER.keyHash),
    required('SUPPLIER_PUB_KEY_HEX', SUPPLIER.publicKey),
    required('MOCK_PUBLIC_BASE', 'https://mock.example'),
    required('MOCK_MTLS_BASE', 'https://mock-mtls.example'),
    required('LLM_MODEL_ALLOWLIST', 'a/b'),
    required('LLM_MAX_PRICE_LOVELACE', '1000000'),
    required('LLM_MAX_SUPPLIER_BOND_LOVELACE', '1000000'),
    required('LLM_MAX_BUYER_BOND_LOVELACE', '1000000'),
    required('HANDOFF_MAX_PRICE_LOVELACE', '1000000'),
    required('HANDOFF_MAX_SUPPLIER_BOND_LOVELACE', '1000000'),
    required('HANDOFF_MAX_BUYER_BOND_LOVELACE', '1000000'),
    required('DISPUTE_CHALLENGE_STAKE_LOVELACE', '1000000'),
    required('DISPUTE_MIN_WINDOW_LEFT_MS', '60000'),
    required('DISPUTE_READ_TIMEOUT_MS', '20000'),
    required('VECTOR_MODULE1_MANIFEST', completeEnv().VECTOR_MODULE1_MANIFEST as string),
    { variable: 'COSIGN_ALLOWLIST', what: 'is not set: an empty list holds nobody, and a setting that is not set is refused', bad: undefined, message: /COSIGN_ALLOWLIST is not set/, good: '' },
    { variable: 'IDENTITY_POLICY_ID', what: 'is not set', bad: undefined, message: /^environment variable IDENTITY_POLICY_ID is not set/, good: completeEnv().IDENTITY_POLICY_ID as string },
    { variable: 'VECTOR_IDENTITY_VAULT_REF_UTXO', what: 'is not set', bad: undefined, message: /^environment variable VECTOR_IDENTITY_VAULT_REF_UTXO is not set/, good: `${'e0'.repeat(32)}#3` },
    { variable: 'VECTOR_IDENTITY_ESCROW_REF_UTXO', what: 'is not set', bad: undefined, message: /^environment variable VECTOR_IDENTITY_ESCROW_REF_UTXO is not set/, good: `${'e0'.repeat(32)}#4` },
  ];
  const WRONG: Row[] = [
    ...ROLES.map((role): Row => ({ variable: KEY_VARIABLES[role], what: 'is not 64 lowercase hex characters', bad: 'zz'.repeat(32), message: new RegExp(`^environment variable ${KEY_VARIABLES[role]} must be 64 lowercase hex characters`), good: rawKey(KEY_NUMBERS[role]) })),
    // The key of the number 42 has the letter a in its hex text, so its upper-case form is another text than its lower-case form.
    { variable: 'STOCK_READER_DELEGATION_PRIV_KEY_HEX', what: 'is in upper case', bad: rawKey(42).toUpperCase(), message: /^environment variable STOCK_READER_DELEGATION_PRIV_KEY_HEX must be 64 lowercase hex/, good: rawKey(42) },
    { variable: 'SERVICE_AUTH_HEADER', what: 'is not printable ASCII', bad: 'Bearer \u00e9\u00e9\u00e9', message: /^environment variable SERVICE_AUTH_HEADER must be printable ASCII/, good: 'Bearer abc' },
    { variable: 'FAULT_MODE', what: 'is a fault value, and the agent has none', bad: 'confirm_wrong_lot', message: /^environment variable FAULT_MODE must be empty/, good: '' },
    { variable: 'FAULT_MODE', what: 'is any other value', bad: 'nonsense', message: /^environment variable FAULT_MODE must be empty/, good: undefined },
    { variable: 'PORT', what: 'is no port', bad: '70000', message: /^environment variable PORT must be a port/, good: '9101' },
    { variable: 'HOST', what: 'is no host', bad: 'a b', message: /^environment variable HOST must be/, good: '127.0.0.1' },
    { variable: 'AGENT_DID', what: 'is no DID', bad: 'did:vector:nope', message: /^environment variable AGENT_DID must be did:vector:/, good: completeEnv().AGENT_DID as string },
    { variable: 'STOCK_READER_DID', what: 'is no DID', bad: 'nope', message: /^environment variable STOCK_READER_DID must be did:vector:/, good: completeEnv().STOCK_READER_DID as string },
    { variable: 'ADVERT_MAX_PROCESSING_MS', what: 'is below the window that the deadline assumes', bad: '1799999', message: /^environment variable ADVERT_MAX_PROCESSING_MS must be at least 1800000/, good: '1800000' },
    { variable: 'ADVERT_PRICE_LOVELACE', what: 'is 0', bad: '0', message: /^environment variable ADVERT_PRICE_LOVELACE must be a whole number of lovelace of more than 0/, good: '3000000' },
    { variable: 'SUPPLIER_PUB_KEY_HEX', what: 'is not the public key of SUPPLIER_PKH', bad: keyOf(rawKey(5)).publicKeyHex, message: /^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/, good: SUPPLIER.publicKey },
    { variable: 'MOCK_PUBLIC_BASE', what: 'is not https', bad: 'http://mock.example', message: /^environment variable MOCK_PUBLIC_BASE must be an https origin/, good: 'https://mock.example' },
    { variable: 'MOCK_MTLS_BASE', what: 'is the host of MOCK_PUBLIC_BASE', bad: 'https://mock.example', message: /^environment variable MOCK_MTLS_BASE must name another host/, good: 'https://other.example' },
    { variable: 'IDENTITY_GATEWAY_URL', what: 'is not an https origin', bad: 'http://gateway.example', message: /^environment variable IDENTITY_GATEWAY_URL must be an https origin/, good: 'https://gateway.example' },
    { variable: 'VECTOR_OGMIOS_URL', what: 'has a user', bad: 'https://u:p@node.example', message: /^environment variable VECTOR_OGMIOS_URL must be an http or https address with no user/, good: 'https://node.example' },
    { variable: 'LLM_MODEL_ALLOWLIST', what: 'has a model of a wrong form', bad: 'a/b, c d', message: /^environment variable LLM_MODEL_ALLOWLIST entry 2/, good: 'a/b' },
    { variable: 'LLM_MAX_PRICE_LOVELACE', what: 'is no number', bad: 'free', message: /^environment variable LLM_MAX_PRICE_LOVELACE must be a whole number/, good: '1000000' },
    { variable: 'LLM_MAX_SUPPLIER_BOND_LOVELACE', what: 'is 0', bad: '0', message: /^environment variable LLM_MAX_SUPPLIER_BOND_LOVELACE must be a whole number of lovelace of more than 0/, good: '1' },
    { variable: 'LLM_MAX_BUYER_BOND_LOVELACE', what: 'has a fraction', bad: '1.5', message: /^environment variable LLM_MAX_BUYER_BOND_LOVELACE must be a whole number/, good: '15' },
    { variable: 'HANDOFF_MAX_PRICE_LOVELACE', what: 'is no number', bad: 'free', message: /^environment variable HANDOFF_MAX_PRICE_LOVELACE must be a whole number/, good: '1000000' },
    { variable: 'HANDOFF_MAX_SUPPLIER_BOND_LOVELACE', what: 'is 0', bad: '0', message: /^environment variable HANDOFF_MAX_SUPPLIER_BOND_LOVELACE must be a whole number/, good: '1' },
    { variable: 'HANDOFF_MAX_BUYER_BOND_LOVELACE', what: 'is negative', bad: '-1', message: /^environment variable HANDOFF_MAX_BUYER_BOND_LOVELACE must be a whole number/, good: '1' },
    { variable: 'DISPUTE_MIN_WINDOW_LEFT_MS', what: 'is below 2000', bad: '1999', message: /^environment variable DISPUTE_MIN_WINDOW_LEFT_MS must be a whole number of milliseconds of at least 2000/, good: '2000' },
    { variable: 'DISPUTE_STARTED_LEASE_MS', what: 'is below twice the read bound', bad: '39999', message: /^environment variable DISPUTE_STARTED_LEASE_MS must be a whole number of milliseconds of at least 40000/, good: '40000' },
    { variable: 'COSIGN_ALLOWLIST', what: 'has an entry that is no key hash', bad: 'not-a-key-hash', message: /^the settings of the co-sign route are refused: the allowlist has an entry on line 1/, good: PRINCIPAL.keyHash },
    { variable: 'COSIGN_MAX_CONCURRENT', what: 'is above 64', bad: '65', message: /^the settings of the co-sign route are refused: COSIGN_MAX_CONCURRENT must be a whole number from 1 to 64/, good: '64' },
    { variable: 'VECTOR_IDENTITY_VAULT_REF_UTXO', what: 'is no output reference', bad: 'nope', message: /^environment variable VECTOR_IDENTITY_VAULT_REF_UTXO must be <64 hex characters>#<output index>/, good: `${'e0'.repeat(32)}#3` },
    { variable: 'IDENTITY_POLICY_ID', what: 'is not the policy that the deployment gives', bad: 'ab'.repeat(28), message: /^environment variable IDENTITY_POLICY_ID is not the identity policy that/, good: completeEnv().IDENTITY_POLICY_ID as string },
    ...ROLES.map((role): Row => ({
      variable: PKH_VARIABLES[role], what: 'is not the key hash of its key', bad: 'ab'.repeat(28), message: new RegExp(`^environment variable ${PKH_VARIABLES[role]} \\(56 characters\\) is not the key hash of the key in ${KEY_VARIABLES[role]}`),
      good: keyOf(rawKey(KEY_NUMBERS[role])).pkh,
    })),
  ];

  const env = (row: Row, value: string | undefined): NodeJS.ProcessEnv => completeEnv({ [row.variable]: value, REORDER_STATE_DIR: '/var/state' });

  test.each([...REQUIRED, ...WRONG])('$variable $what: the start stops and names it, and shows no secret; the twin loads', (row) => {
    const message = messageOf(() => loadConfig(env(row, row.bad)));
    expect(message).toMatch(row.message);
    for (const secret of secretsOf()) expect(message.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(() => loadConfig(env(row, row.good))).not.toThrow();
  });

  test('two keys that are one key stop the start, naming the two variables, for each pair; five keys of their own are the twin', () => {
    for (const [index, first] of ROLES.entries()) {
      for (const second of ROLES.slice(index + 1)) {
        const message = messageOf(() => loadConfig(completeEnv({ [KEY_VARIABLES[second]]: rawKey(KEY_NUMBERS[first]) })));
        expect(message).toBe(`environment variable ${KEY_VARIABLES[second]} holds the same key as ${KEY_VARIABLES[first]}: each key of the service must be a key of its own`);
      }
    }
    expect(() => loadConfig(completeEnv())).not.toThrow();
  });

  test('a key that is the supplier key stops the start, naming its variable, for each key; a supplier key of its own is the twin', () => {
    for (const role of ROLES) {
      const supplier = keyOf(rawKey(KEY_NUMBERS[role]));
      const message = messageOf(() => loadConfig(completeEnv({ SUPPLIER_PKH: supplier.pkh, SUPPLIER_PUB_KEY_HEX: supplier.publicKeyHex })));
      expect(message).toMatch(new RegExp(`^environment variable ${KEY_VARIABLES[role]} holds the key of SUPPLIER_PKH: the supplier key is the runtime's`));
    }
    expect(() => loadConfig(completeEnv())).not.toThrow();
  });

  test('VECTOR_MODULE1_MANIFEST must be an https address pinned to a commit: a file path, an http address, an address with no commit, and an address with a user, a query or a fragment stop the start by name and never show the value', () => {
    const pinned = (host = 'https://198.51.100.7', commit = MODULE1_COMMIT): string => `${host}/Apex-Fusion/vector-agent-modules/${commit}/Module-1/manifest.json`;
    const wrong: Array<[string, string, RegExp]> = [
      ['a file path', MODULE1_FIXTURE, /must be an https address/],
      ['a relative path', 'module1.json', /must be an https address/],
      ['an http address', pinned('http://198.51.100.7'), /must be an https address/],
      ['no address after the scheme', 'https://', /must be an https address/],
      ['an address with no commit', 'https://198.51.100.7/Apex-Fusion/vector-agent-modules/main/Module-1/manifest.json', /must be pinned to a commit/],
      ['a commit of 39 characters', pinned('https://198.51.100.7', MODULE1_COMMIT.slice(1)), /must be pinned to a commit/],
      ['a commit of 41 characters', pinned('https://198.51.100.7', `${MODULE1_COMMIT}0`), /must be pinned to a commit/],
      ['a commit in upper case', pinned('https://198.51.100.7', MODULE1_COMMIT.toUpperCase()), /must be pinned to a commit/],
      ['a commit that is a part of a longer segment', pinned('https://198.51.100.7', `x${MODULE1_COMMIT}`), /must be pinned to a commit/],
      ['an address with a user and a password', pinned('https://user:secret-text@198.51.100.7'), /no user, no password, no query and no fragment/],
      ['an address with a query', `${pinned()}?token=secret-text`, /no user, no password, no query and no fragment/],
      ['an address with a fragment', `${pinned()}#secret-text`, /no user, no password, no query and no fragment/],
    ];
    for (const [what, value, expected] of wrong) {
      const message = messageOf(() => loadConfig(completeEnv({ VECTOR_MODULE1_MANIFEST: value })));
      expect(message, what).toMatch(/^environment variable VECTOR_MODULE1_MANIFEST /);
      expect(message, what).toMatch(expected);
      expect(message, what).not.toContain(value);
      expect(message, what).not.toContain('secret-text');
    }
    expect(() => loadConfig(completeEnv({ VECTOR_MODULE1_MANIFEST: pinned() }))).not.toThrow();
    expect(() => loadConfig(completeEnv({ VECTOR_MODULE1_MANIFEST: `https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/${MODULE1_COMMIT}/Module-1/deploy/identity/mainnet/manifest.json` }))).not.toThrow();
    expect(MODULE1_URL).toContain(MODULE1_COMMIT);
  });
});

describe('the secrets stay in their own lines', () => {
  const SECRETS = [
    ...ROLES.map((role) => ({ name: KEY_VARIABLES[role], hex: rawKey(KEY_NUMBERS[role]) })),
  ];
  /** The lines that a secret could be written in by mistake: a line that the manifest publishes, a line of an address and a line of another secret. */
  const LINES = ['OPERATOR_CONTACT', 'AGENT_VERSION', 'ADVERT_EXPLORER_URL', 'AGENT_STATUS_CHIP', 'LLM_MODEL_ALLOWLIST', 'COSIGN_ALLOWLIST', 'REORDER_STATE_DIR', 'SERVICE_AUTH_HEADER'];

  test.each(SECRETS)('the key of $name found in another line stops the start naming that line, in each form, and never shows the key', ({ name, hex }) => {
    for (const line of LINES.filter((candidate) => candidate !== name)) {
      for (const form of [hex, hex.toUpperCase(), rawHexToBech32(hex), `x${hex}y`, `prefix ${rawHexToBech32(hex).toUpperCase()}`]) {
        const message = messageOf(() => loadConfig(completeEnv({ [line]: form })));
        expect(message, `${name} in ${line}`).toMatch(new RegExp(`^environment variable ${line} holds .*, which belongs in ${name} alone: it would be printed or published\\. Take it out of ${line}$`));
        expect(message.toLowerCase()).not.toContain(hex);
      }
    }
    // The key in the line of another key, and in the public line of its own key hash.
    const other = ROLES.find((role) => KEY_VARIABLES[role] !== name) as Role;
    expect(messageOf(() => loadConfig(completeEnv({ [PKH_VARIABLES[other]]: hex })))).toMatch(new RegExp(`^environment variable ${PKH_VARIABLES[other]} holds .*, which belongs in ${name} alone`));
  });

  test('the token found in another line stops the start naming that line, whole and by its credential, and never shows the token', () => {
    const credential = TOKEN.slice('Bearer '.length);
    for (const line of LINES.filter((candidate) => candidate !== 'SERVICE_AUTH_HEADER')) {
      for (const form of [TOKEN, credential, credential.toUpperCase(), `x${credential}y`]) {
        const message = messageOf(() => loadConfig(completeEnv({ [line]: form })));
        expect(message, `the token in ${line}`).toMatch(new RegExp(`^environment variable ${line} holds the service token, which belongs in SERVICE_AUTH_HEADER alone`));
        expect(message).not.toContain(credential);
      }
    }
  });

  test('the manifest is searched for every secret last: a manifest that holds a key in either form, or the token, stops the start, and the manifest of the service is the twin', () => {
    const leaks: Array<[string, string]> = [
      ...ROLES.flatMap((role): Array<[string, string]> => [[rawKey(KEY_NUMBERS[role]), role], [rawHexToBech32(rawKey(KEY_NUMBERS[role])).toUpperCase(), role]]),
      [TOKEN, 'token'],
    ];
    for (const [secret, who] of leaks) {
      const message = messageOf(() => loadConfig(completeEnv(), (published) => ({ ...manifestFromEnv(published), description: `leak ${secret}` })));
      expect(message, who).toMatch(/^the manifest would publish /);
      expect(message).not.toContain(secret);
    }
    expect(() => loadConfig(completeEnv(), manifestFromEnv)).not.toThrow();
  });

  test('a manifest that the kit refuses stops the start with its code', () => {
    const message = messageOf(() => loadConfig(completeEnv(), (published) => ({ ...manifestFromEnv(published), schema: 'vector.agent-manifest.v1' })));
    expect(message).toMatch(/^the manifest is refused \(manifest_schema\)/);
  });

  test('the manifest is built with the setting that the kit gives it and never with the live environment, and a build that differs between two renders is refused', () => {
    const seen: Array<string | undefined> = [];
    loadConfig(completeEnv({ FAULT_MODE: undefined }), (published) => { seen.push(published.FAULT_MODE); return manifestFromEnv(published); });
    // The kit renders twice for the empty setting, and the live environment holds no FAULT_MODE at all: the text is the setting of the kit.
    expect(seen).toStrictEqual(['', '']);
    let calls = 0;
    const unstable = messageOf(() => loadConfig(completeEnv(), (published) => ({ ...manifestFromEnv(published), description: `render ${(calls += 1)}` })));
    expect(unstable).toMatch(/^the manifest is refused \(manifest_not_stable\)/);
  });
});

/** A start of the whole service in this process, with the parts of the tests: the offline node of the fixture world, a chain for each key, and no network. */
async function start(env: NodeJS.ProcessEnv = {}, options: StartOptions = {}) {
  const dir = tempDir();
  const m = marketplace();
  const log: string[] = [];
  const service = await startService(completeEnv({ REORDER_STATE_DIR: dir, VECTOR_MARKETPLACE_INDEXER_URL: INDEXER, ...env }), {
    fetchImpl: withModule1(m.fetchImpl), log: (line) => { log.push(line); }, provider: world(), tipSlot: async () => 0, janitorIntervalMs: 3_600_000,
    createChain: async (chainOptions) => vaultChainWith(m, { wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: keyOf(chainOptions.privateKeyHex).pkh }) }),
    ...options,
  });
  open.push(() => service.stop());
  return { service, dir, log, origin: `http://127.0.0.1:${service.port}` };
}

describe('the start of the service', () => {
  test('listens, logs one line with the manifest hash and the three wallets, serves the manifest, and prints no secret in the log, in the manifest or in an answer', async () => {
    const { service, dir, log, origin } = await start();
    const config = loadConfig(completeEnv({ REORDER_STATE_DIR: dir }));
    const line = log.find((entry) => entry.startsWith('listening on '));
    expect(line).toBe(
      `listening on 127.0.0.1:${service.port}; manifest ${config.manifest.sha256}; wallets (service, delegation 1, delegation 2) ${[config.keys.service, config.keys.delegation1, config.keys.delegation2].map((key) => key.address).join(', ')}; state directory ${dir}`,
    );
    expect(await (await fetch(`${origin}/healthz`)).json()).toStrictEqual({ ok: true });
    const served = await (await fetch(`${origin}/agent.json`)).text();
    expect(served).toBe(config.manifest.text);
    const unauthorized = await fetch(`${origin}/`, { method: 'POST', body: '[]' });
    expect(unauthorized.status).toBe(401);
    const texts = [...log, served, await unauthorized.text()];
    for (const secret of secretsOf()) for (const text of texts) expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
  });

  test('serves the bytes whose SHA-256 the script of the repository prints for the advert', async () => {
    const { origin } = await start();
    const printed = JSON.parse((await run(process.execPath, [`${root}scripts/manifest-hash.mjs`, origin])).stdout) as { detail_uri: string; detail_hash: string; bytes: number };
    const config = loadConfig(completeEnv({ REORDER_STATE_DIR: '/var/state' }));
    expect(printed).toStrictEqual({ detail_uri: `${origin}/agent.json`, detail_hash: config.manifest.sha256, bytes: Buffer.byteLength(config.manifest.text, 'utf8') });
  });

  test('keeps its records in the state directory: a stranded store for each of the three keys, the journal, and nothing that holds a key', async () => {
    const { dir } = await start();
    const config = loadConfig(completeEnv({ REORDER_STATE_DIR: dir }));
    for (const key of [config.keys.service, config.keys.delegation1, config.keys.delegation2]) expect(existsSync(join(dir, 'keys', key.pkh))).toBe(true);
    expect(existsSync(join(dir, 'dispute'))).toBe(true);
    expect(existsSync(join(dir, '.write-probe'))).toBe(false);
  });

  test('stops with REORDER_STATE_DIR named when the directory cannot be written, and makes nothing for an environment that is refused', async () => {
    const dir = tempDir();
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    const unwritable = await start({ REORDER_STATE_DIR: file }).catch((error: unknown) => error);
    expect((unwritable as Error).message).toMatch(/^environment variable REORDER_STATE_DIR names .* which cannot be written/);
    const fresh = join(dir, 'fresh');
    const refused = await start({ REORDER_STATE_DIR: fresh, COSIGN_ALLOWLIST: undefined }).catch((error: unknown) => error);
    expect((refused as Error).message).toMatch(/COSIGN_ALLOWLIST is not set/);
    expect(existsSync(fresh)).toBe(false);
    mkdirSync(join(dir, 'twin'));
    await expect(start({ REORDER_STATE_DIR: join(dir, 'twin') })).resolves.toBeDefined();
  });

  test('a value of FAULT_MODE does not start the service, and an empty value does', async () => {
    const dir = tempDir();
    const failed = await start({ REORDER_STATE_DIR: join(dir, 'a'), FAULT_MODE: 'confirm_wrong_lot' }).catch((error: unknown) => error);
    expect((failed as Error).message).toMatch(/^environment variable FAULT_MODE must be empty/);
    expect(existsSync(join(dir, 'a'))).toBe(false);
    await expect(start({ FAULT_MODE: '' })).resolves.toBeDefined();
  });

  test('stops when the node gives no start time of the chain, before it listens, and the node of the fixture world is the twin', async () => {
    const none = world();
    none.getSystemStartMs = async () => { throw new Error('the node does not answer'); };
    const failed = await start({}, { provider: none }).catch((error: unknown) => error);
    expect((failed as Error).message).toMatch(/^the node gave no start time of the chain/);
    await expect(start()).resolves.toBeDefined();
  });

  test('stops at once and then stops again with no harm: shutdown ends the janitors and the server, and a second call is the same call', async () => {
    const { service, origin } = await start();
    expect(await service.shutdown(1_000)).toBe('finished');
    expect(await service.shutdown(1_000)).toBe('finished');
    await service.stop();
    await expect(fetch(`${origin}/healthz`)).rejects.toThrow();
  });
});

describe('the stop on a signal', () => {
  test('SIGTERM and SIGINT stop the service the kit way: the shutdown with the wait, exit 0 when it ended, exit 1 when it abandoned the job, the handlers off after the first signal', async () => {
    for (const [outcome, code] of [['finished', 0], ['abandoned', 1]] as const) {
      const target = new EventEmitter();
      const calls: Array<number | undefined> = [];
      const exits: number[] = [];
      stopOnSignals({ shutdown: async (waitMs) => { calls.push(waitMs); return outcome; } }, { target, exit: (exitCode) => { exits.push(exitCode); }, log: () => undefined, waitMs: 1234 });
      expect(target.listenerCount('SIGTERM')).toBe(1);
      expect(target.listenerCount('SIGINT')).toBe(1);
      target.emit('SIGTERM');
      await until(() => exits.length > 0);
      expect(calls).toStrictEqual([1234]);
      expect(exits).toStrictEqual([code]);
      expect(target.listenerCount('SIGTERM') + target.listenerCount('SIGINT')).toBe(0);
    }
  });
});

/** Polls until `condition` holds, for seconds at most. The child process and the sockets of these tests run in real time, and no fake clock drives them. */
async function until(condition: () => boolean, ms = 20_000): Promise<void> {
  for (const end = Date.now() + ms; !condition(); await new Promise<void>((resolve) => { setTimeout(resolve, 25); })) {
    if (Date.now() > end) throw new Error('the condition did not hold in time');
  }
}

describe('src/index.ts as a process', () => {
  /**
   * The environment of the child: the complete environment, and no setting of this process. The addresses that the child could use point at a port that nothing holds. The two fetches of the start that are not made
   * to such a port, the Module-1 manifest at its pinned address and the calls to the node at its https address, are answered by `child-fetch.mjs`, which a child loads before the service: no child reaches a network.
   */
  const run1 = (env: NodeJS.ProcessEnv) => {
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    for (const name of SETTINGS) delete inherited[name];
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', childFetch, 'src/index.ts'], { cwd: agentDir, env: { ...inherited, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, exited, out: () => out, err: () => err };
  };
  const OFF_CHAIN: NodeJS.ProcessEnv = { VECTOR_OGMIOS_URL: 'https://198.51.100.8:1337', VECTOR_KOIOS_URL: 'http://127.0.0.1:9', VECTOR_SUBMIT_URL: 'http://127.0.0.1:9', IDENTITY_GATEWAY_URL: 'https://127.0.0.1:9' };

  test('exits 1 at start with the variable named, and listens on nothing, when a setting is missing, a key is in the wrong line or the fault switch is set', async () => {
    const dir = tempDir();
    const cases: Array<[NodeJS.ProcessEnv, RegExp]> = [
      [{ COSIGN_ALLOWLIST: undefined }, /^\[reorder-agent\] cannot start: .*COSIGN_ALLOWLIST is not set/],
      [{ REORDER_DELEGATION_2_PRIV_KEY_HEX: '' }, /^\[reorder-agent\] cannot start: environment variable REORDER_DELEGATION_2_PRIV_KEY_HEX is required/],
      [{ OPERATOR_CONTACT: SERVICE_HEX }, /^\[reorder-agent\] cannot start: environment variable OPERATOR_CONTACT holds the service key/],
      [{ FAULT_MODE: 'confirm_wrong_lot' }, /^\[reorder-agent\] cannot start: environment variable FAULT_MODE must be empty/],
      [{ VECTOR_MODULE1_MANIFEST: MODULE1_FIXTURE }, /^\[reorder-agent\] cannot start: environment variable VECTOR_MODULE1_MANIFEST must be an https address/],
    ];
    const results = await Promise.all(cases.map(async ([env]) => {
      const p = run1({ ...completeEnv({ REORDER_STATE_DIR: dir, ...env }), ...OFF_CHAIN });
      return { code: await p.exited, out: p.out(), err: p.err() };
    }));
    cases.forEach(([, refusal], index) => {
      expect(results[index].code).toBe(1);
      expect(results[index].err).toMatch(refusal);
      expect(results[index].out).not.toContain('listening on');
      for (const secret of secretsOf()) expect((results[index].out + results[index].err).toLowerCase()).not.toContain(secret.toLowerCase());
    });
  }, 90_000);

  test('started for real: it logs its line, answers /healthz and /agent.json, refuses a job without the token, prints no secret, and stops on SIGTERM with exit 0', async () => {
    const dir = tempDir();
    const p = run1({ ...completeEnv({ REORDER_STATE_DIR: dir, VECTOR_MARKETPLACE_INDEXER_URL: undefined }), ...OFF_CHAIN });
    try {
      await until(() => /listening on 127\.0\.0\.1:\d+/.test(p.out()) || p.child.exitCode !== null);
      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(p.out())?.[1];
      expect(port, p.err()).toBeDefined();
      const base = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${base}/healthz`)).json()).toStrictEqual({ ok: true });
      const manifest = (await (await fetch(`${base}/agent.json`)).json()) as { name: string; status: unknown; keys: { buyer_pkh: string } };
      expect([manifest.name, manifest.status, manifest.keys.buyer_pkh]).toStrictEqual(['Reorder Agent', { chip: 'proposed', since: '2026-11-23' }, keyOf(SERVICE_HEX).pkh]);
      expect((await fetch(`${base}/`, { method: 'POST', body: '[]' })).status).toBe(401);
      expect(p.out()).toMatch(/^\[reorder-agent\] listening on 127\.0\.0\.1:\d+; manifest [0-9a-f]{64}; wallets \(service, delegation 1, delegation 2\) addr1/m);
      for (const secret of secretsOf()) expect((p.out() + p.err()).toLowerCase()).not.toContain(secret.toLowerCase());
      p.child.kill('SIGTERM');
      expect(await p.exited).toBe(0);
      expect(p.out()).toContain('SIGTERM: stopping');
    } finally {
      p.child.kill('SIGKILL');
    }
  }, 90_000);
});
