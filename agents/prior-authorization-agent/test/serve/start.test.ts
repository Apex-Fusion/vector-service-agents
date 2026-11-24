// agents/prior-authorization-agent/test/serve/start.test.ts
// How the Prior Authorization Agent starts and stops. The settings: every name the service reads, and a table of every start refusal with its accepted twin. The secrets: each of the seven keys and the token is
// kept out of every other line, out of the manifest, out of the log and out of a message. The fault switch: the empty text and the one value of the agent start it, and any other value stops the start. The start
// itself, with the parts that a test replaces: the line it logs, the manifest it serves and the hash that the script of the repository prints for it, the state directory, the node, the co-sign register, and the stop.
// Then `src/index.ts` as a process, against a stand-in node.
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { VAULT_PAYER_IDENTITY_SETTINGS, rawHexToBech32 } from '@vsa/buyer-core';
import { renderManifest } from '@vsa/usecase-kit/manifest';
import { AGENT_DID as KIT_AGENT_DID, DELEG_A, liveDelegation, world as ledgerWorld } from '../../../../packages/usecase-kit/test/cosign/support.ts';
import { KEY_ROLES, keyOf } from '../../src/serve/keys.ts';
import { STATUS_SINCE_DEFAULT, manifestFromEnv } from '../../src/serve/manifest.ts';
import { SETTINGS, loadConfig, stopOnSignals } from '../../src/serve/start.ts';
import { INSURER_DID } from '../propose/support.ts';
import { closeAll, post, start, until } from './serve.ts';
import {
  KEY_NUMBERS, KEY_VARIABLES, MODULE1_COMMIT, MODULE1_FIXTURE, MODULE1_URL, PKH_VARIABLES, PRINCIPAL, SUPPLIER, TOKEN, cleanDirs, messageOf, module1ManifestText, rawKey, secretsOf, startEnv, tempDir,
} from './support.ts';
import { settingsOf } from './world.ts';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const agentDir = fileURLToPath(new URL('../../', import.meta.url));
/** The preload that a child process loads before the service: it answers the fetch of the Module-1 manifest, the one fetch of the start that is not a call to the node. */
const childFetch = fileURLToPath(new URL('./child-fetch.mjs', import.meta.url));
const SERVICE_HEX = rawKey(KEY_NUMBERS.service);

afterEach(async () => {
  cleanDirs();
  await closeAll();
});

describe('the settings', () => {
  const COMMON = [
    'OPERATOR_CONTACT', 'AGENT_DID', 'IDENTITY_POLICY_ID', 'IDENTITY_ADDRESS', 'AGENT_VERSION', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL', 'SERVICE_AUTH_HEADER', 'FAULT_MODE', 'PORT', 'HOST',
    'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL', 'VECTOR_IDENTITY_LEGACY_ROOT', 'VECTOR_IDENTITY_CONFIG_SEED', 'VECTOR_IDENTITY_ESCROW_REF_UTXO',
    'VECTOR_IDENTITY_VAULT_REF_UTXO', 'VECTOR_MODULE1_MANIFEST', 'IDENTITY_GATEWAY_URL', 'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE', 'LLM_MAX_SUPPLIER_BOND_LOVELACE',
    'LLM_MAX_BUYER_BOND_LOVELACE', 'DISPUTE_CHALLENGE_STAKE_LOVELACE', 'DISPUTE_MIN_WINDOW_LEFT_MS', 'DISPUTE_READ_TIMEOUT_MS', 'DISPUTE_RESOLUTION_DEADLINE_MS', 'DISPUTE_STARTED_LEASE_MS',
  ];
  const OWN = [
    'PRIORAUTH_STATE_DIR', 'ADVERT_PRICE_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'RECORD_READER_DID', 'DRAFTER_DID', 'HANDOFF_MAX_PRICE_LOVELACE',
    'HANDOFF_MAX_SUPPLIER_BOND_LOVELACE', 'HANDOFF_MAX_BUYER_BOND_LOVELACE', 'COSIGN_ALLOWLIST', 'COSIGN_MAX_CONCURRENT', 'COSIGN_MAX_FUTURE_MS', 'COSIGN_LEDGER_TIMEOUT_MS',
    'PRIORAUTH_SERVICE_PRIV_KEY_HEX', 'PRIORAUTH_SERVICE_PKH', 'PRIORAUTH_DELEGATION_1_PRIV_KEY_HEX', 'PRIORAUTH_DELEGATION_1_PKH', 'PRIORAUTH_DELEGATION_2_PRIV_KEY_HEX', 'PRIORAUTH_DELEGATION_2_PKH',
    'RECORD_READER_AUTH_PRIV_KEY_HEX', 'RECORD_READER_AUTH_PKH', 'RECORD_READER_DELEGATION_PRIV_KEY_HEX', 'RECORD_READER_DELEGATION_PKH',
    'DRAFTER_AUTH_PRIV_KEY_HEX', 'DRAFTER_AUTH_PKH', 'DRAFTER_DELEGATION_PRIV_KEY_HEX', 'DRAFTER_DELEGATION_PKH',
  ];

  test('SETTINGS is exactly the settings of the service: the settings of both use-case services, the settings of the Prior Authorization Agent and its seven keys, each name once', () => {
    expect([...SETTINGS].sort()).toStrictEqual([...COMMON, ...OWN].sort());
    expect(new Set(SETTINGS).size).toBe(SETTINGS.length);
    expect(SETTINGS).toHaveLength(61);
    for (const name of VAULT_PAYER_IDENTITY_SETTINGS) expect(SETTINGS).toContain(name);
    expect(SETTINGS.filter((name) => name.endsWith('_PRIV_KEY_HEX'))).toStrictEqual(KEY_ROLES.map((role) => KEY_VARIABLES[role]));
    expect(SETTINGS.filter((name) => name.endsWith('_PKH') && name !== 'SUPPLIER_PKH')).toStrictEqual(KEY_ROLES.map((role) => PKH_VARIABLES[role]));
    // The supplier key is the runtime's: its private variable is no setting of the service.
    expect(SETTINGS as readonly string[]).not.toContain('SUPPLIER_PRIV_KEY_HEX');
  });

  test('the complete environment of the tests loads, with every setting as the readers give it, and the settings that the wiring gets are the settings that the tests of the wiring make', () => {
    const env = startEnv({ PRIORAUTH_STATE_DIR: '/var/state', PORT: '9300' });
    const config = loadConfig(env);
    expect(config).toMatchObject({ host: '127.0.0.1', port: 9300, stateDir: '/var/state', authHeader: TOKEN, module1Manifest: env.VECTOR_MODULE1_MANIFEST, supplier: { pkh: SUPPLIER.keyHash } });
    expect(config.fault.mode).toBe('');
    expect(config.agentDid).toBe(env.AGENT_DID);
    expect(config.recordReaderDid).toBe(env.RECORD_READER_DID);
    expect(config.drafterDid).toBe(env.DRAFTER_DID);
    expect(config.modelLimits.maxBuyerBondLovelace).toBe(2_000_000n);
    expect(config.handoffLimits.maxPriceLovelace).toBe(2_000_000n);
    expect(config.dispute.challenge_stake_lovelace).toBe(50_000_000n);
    expect(config.cosign.allowlist.has(PRINCIPAL.keyHash)).toBe(true);
    for (const role of KEY_ROLES) expect(config.keys[role].pkh).toBe(keyOf(rawKey(KEY_NUMBERS[role])).pkh);
    // The world of the tests of the wiring assembles the settings with the same readers: no member differs.
    const settings = settingsOf(env);
    expect(config.stateDir).toBe(settings.stateDir);
    for (const name of ['agentDid', 'recordReaderDid', 'drafterDid', 'supplier', 'endpoints', 'mock', 'modelLimits', 'handoffLimits', 'dispute', 'module1Manifest'] as const) expect(config[name], name).toStrictEqual(settings[name]);
    expect(config.identityDeployment.identity.hash).toBe(settings.identityDeployment.identity.hash);
    expect([config.fault.kind, config.fault.mode]).toStrictEqual([settings.fault.kind, settings.fault.mode]);
    // The manifest is the render of the manifest environment, with the key hashes that the service derived from its keys.
    const published = renderManifest('prior-authorization-agent', () => manifestFromEnv({
      ...env, PRIORAUTH_SERVICE_PKH: config.keys.service.pkh, PRIORAUTH_DELEGATION_1_PKH: config.keys.delegation1.pkh, PRIORAUTH_DELEGATION_2_PKH: config.keys.delegation2.pkh,
    }));
    expect(published.ok && published.value).toStrictEqual(config.manifest);
  });

  test('the defaults: the listener, the state directory, and the settings that the service leaves to the chain code', () => {
    const config = loadConfig(startEnv({ PORT: undefined, HOST: undefined, PRIORAUTH_STATE_DIR: undefined }));
    expect([config.port, config.host, config.stateDir]).toStrictEqual([9103, '0.0.0.0', '/data']);
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
  const READER = startEnv().RECORD_READER_DID as string;
  const REQUIRED: Row[] = [
    required('OPERATOR_CONTACT', 'ops@example.test'),
    ...KEY_ROLES.map((role) => required(KEY_VARIABLES[role], rawKey(KEY_NUMBERS[role]))),
    required('SERVICE_AUTH_HEADER', TOKEN),
    required('AGENT_DID', startEnv().AGENT_DID as string),
    required('RECORD_READER_DID', READER),
    required('DRAFTER_DID', startEnv().DRAFTER_DID as string),
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
    required('VECTOR_MODULE1_MANIFEST', startEnv().VECTOR_MODULE1_MANIFEST as string),
    { variable: 'COSIGN_ALLOWLIST', what: 'is not set: an empty list holds nobody, and a setting that is not set is refused', bad: undefined, message: /COSIGN_ALLOWLIST is not set/, good: '' },
    { variable: 'IDENTITY_POLICY_ID', what: 'is not set', bad: undefined, message: /^environment variable IDENTITY_POLICY_ID is not set/, good: startEnv().IDENTITY_POLICY_ID as string },
    { variable: 'VECTOR_IDENTITY_VAULT_REF_UTXO', what: 'is not set', bad: undefined, message: /^environment variable VECTOR_IDENTITY_VAULT_REF_UTXO is not set/, good: `${'e0'.repeat(32)}#3` },
    { variable: 'VECTOR_IDENTITY_ESCROW_REF_UTXO', what: 'is not set', bad: undefined, message: /^environment variable VECTOR_IDENTITY_ESCROW_REF_UTXO is not set/, good: `${'e0'.repeat(32)}#4` },
  ];
  const PINNED = `https://198.51.100.7/Apex-Fusion/vector-agent-modules/${MODULE1_COMMIT}/Module-1/manifest.json`;
  const WRONG: Row[] = [
    ...KEY_ROLES.map((role): Row => ({
      variable: KEY_VARIABLES[role], what: 'is not 64 lowercase hex characters', bad: 'zz'.repeat(32), message: new RegExp(`^environment variable ${KEY_VARIABLES[role]} must be 64 lowercase hex characters`), good: rawKey(KEY_NUMBERS[role]),
    })),
    // The key of the number 42 has the letter a in its hex text, so its upper-case form is another text than its lower-case form.
    { variable: 'RECORD_READER_DELEGATION_PRIV_KEY_HEX', what: 'is in upper case', bad: rawKey(42).toUpperCase(), message: /^environment variable RECORD_READER_DELEGATION_PRIV_KEY_HEX must be 64 lowercase hex/, good: rawKey(42) },
    { variable: 'SERVICE_AUTH_HEADER', what: 'is not printable ASCII', bad: 'Bearer \u00e9\u00e9\u00e9', message: /^environment variable SERVICE_AUTH_HEADER must be printable ASCII/, good: 'Bearer abc' },
    { variable: 'FAULT_MODE', what: 'is a fault value of another agent', bad: 'confirm_wrong_lot', message: /^environment variable FAULT_MODE must be empty or "alter_after_approval" for prior-authorization-agent/, good: 'alter_after_approval' },
    { variable: 'FAULT_MODE', what: 'is any other value', bad: 'nonsense', message: /^environment variable FAULT_MODE must be empty or "alter_after_approval"/, good: undefined },
    { variable: 'FAULT_MODE', what: 'has a space around the value of the agent', bad: ' alter_after_approval', message: /^environment variable FAULT_MODE must be empty or "alter_after_approval"/, good: '' },
    { variable: 'PORT', what: 'is no port', bad: '70000', message: /^environment variable PORT must be a port/, good: '9103' },
    { variable: 'HOST', what: 'is no host', bad: 'a b', message: /^environment variable HOST must be/, good: '127.0.0.1' },
    { variable: 'AGENT_DID', what: 'is no DID', bad: 'did:vector:nope', message: /^environment variable AGENT_DID must be did:vector:/, good: startEnv().AGENT_DID as string },
    { variable: 'RECORD_READER_DID', what: 'is no DID', bad: 'nope', message: /^environment variable RECORD_READER_DID must be did:vector:/, good: READER },
    { variable: 'RECORD_READER_DID', what: 'is the agent', bad: startEnv().AGENT_DID as string, message: /^environment variable RECORD_READER_DID names the same agent as AGENT_DID/, good: READER },
    { variable: 'DRAFTER_DID', what: 'is no DID', bad: 'nope', message: /^environment variable DRAFTER_DID must be did:vector:/, good: startEnv().DRAFTER_DID as string },
    { variable: 'DRAFTER_DID', what: 'is the subagent record-reader', bad: READER, message: /^environment variable DRAFTER_DID names the same agent as RECORD_READER_DID/, good: startEnv().DRAFTER_DID as string },
    { variable: 'ADVERT_MAX_PROCESSING_MS', what: 'is below the window that the deadline assumes', bad: '1799999', message: /^environment variable ADVERT_MAX_PROCESSING_MS must be at least 1800000/, good: '1800000' },
    { variable: 'ADVERT_PRICE_LOVELACE', what: 'is 0', bad: '0', message: /^environment variable ADVERT_PRICE_LOVELACE must be a whole number of lovelace of more than 0/, good: '3000000' },
    { variable: 'SUPPLIER_PUB_KEY_HEX', what: 'is not the public key of SUPPLIER_PKH', bad: keyOf(rawKey(5)).publicKeyHex, message: /^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/, good: SUPPLIER.publicKey },
    { variable: 'MOCK_PUBLIC_BASE', what: 'is not https', bad: 'http://mock.example', message: /^environment variable MOCK_PUBLIC_BASE must be an https origin/, good: 'https://mock.example' },
    { variable: 'MOCK_MTLS_BASE', what: 'is the host of MOCK_PUBLIC_BASE', bad: 'https://mock.example', message: /^environment variable MOCK_MTLS_BASE must name another host/, good: 'https://other.example' },
    { variable: 'IDENTITY_GATEWAY_URL', what: 'is not an https origin', bad: 'http://gateway.example', message: /^environment variable IDENTITY_GATEWAY_URL must be an https origin/, good: 'https://gateway.example' },
    { variable: 'VECTOR_OGMIOS_URL', what: 'has a user', bad: 'https://u:p@node.example', message: /^environment variable VECTOR_OGMIOS_URL must be an http or https address with no user/, good: 'https://node.example' },
    { variable: 'VECTOR_OGMIOS_URL', what: 'is not https: the tip reader of the janitor takes https only', bad: 'http://node.example', message: /^environment variable VECTOR_OGMIOS_URL must be an https address/, good: 'https://node.example' },
    { variable: 'VECTOR_MODULE1_MANIFEST', what: 'is a file path', bad: MODULE1_FIXTURE, message: /^environment variable VECTOR_MODULE1_MANIFEST must be an https URL with no user, query or fragment/, good: PINNED },
    { variable: 'VECTOR_MODULE1_MANIFEST', what: 'is an http address', bad: `http://${PINNED.slice('https://'.length)}`, message: /^environment variable VECTOR_MODULE1_MANIFEST must be an https URL/, good: PINNED },
    { variable: 'VECTOR_MODULE1_MANIFEST', what: 'is pinned to no commit', bad: 'https://198.51.100.7/Apex-Fusion/vector-agent-modules/main/Module-1/manifest.json', message: /^environment variable VECTOR_MODULE1_MANIFEST must be pinned to a commit/, good: PINNED },
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
    { variable: 'IDENTITY_POLICY_ID', what: 'is not the policy that the deployment gives', bad: 'ab'.repeat(28), message: /^environment variable IDENTITY_POLICY_ID is not the identity policy that/, good: startEnv().IDENTITY_POLICY_ID as string },
    ...KEY_ROLES.map((role): Row => ({
      variable: PKH_VARIABLES[role], what: 'is not the key hash of its key', bad: 'ab'.repeat(28), message: new RegExp(`^environment variable ${PKH_VARIABLES[role]} \\(56 characters\\) is not the key hash of the key in ${KEY_VARIABLES[role]}`),
      good: keyOf(rawKey(KEY_NUMBERS[role])).pkh,
    })),
  ];

  const env = (row: Row, value: string | undefined): NodeJS.ProcessEnv => startEnv({ [row.variable]: value, PRIORAUTH_STATE_DIR: '/var/state' });

  test.each([...REQUIRED, ...WRONG])('$variable $what: the start stops and names it, and shows no secret; the twin loads', (row) => {
    const message = messageOf(() => loadConfig(env(row, row.bad)));
    expect(message).toMatch(row.message);
    for (const secret of secretsOf()) expect(message.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(() => loadConfig(env(row, row.good))).not.toThrow();
  });

  test('two keys that are one key stop the start, naming the two variables, for each pair; seven keys of their own are the twin', () => {
    for (const [index, first] of KEY_ROLES.entries()) {
      for (const second of KEY_ROLES.slice(index + 1)) {
        const message = messageOf(() => loadConfig(startEnv({ [KEY_VARIABLES[second]]: rawKey(KEY_NUMBERS[first]) })));
        expect(message).toBe(`environment variable ${KEY_VARIABLES[second]} holds the same key as ${KEY_VARIABLES[first]}: each key of the service must be a key of its own`);
      }
    }
    expect(() => loadConfig(startEnv())).not.toThrow();
  });

  test('a key that is the supplier key stops the start, naming its variable, for each key; a supplier key of its own is the twin', () => {
    for (const role of KEY_ROLES) {
      const supplier = keyOf(rawKey(KEY_NUMBERS[role]));
      const message = messageOf(() => loadConfig(startEnv({ SUPPLIER_PKH: supplier.pkh, SUPPLIER_PUB_KEY_HEX: supplier.publicKeyHex })));
      expect(message).toMatch(new RegExp(`^environment variable ${KEY_VARIABLES[role]} holds the key of SUPPLIER_PKH: the supplier key is the runtime's`));
    }
    expect(() => loadConfig(startEnv())).not.toThrow();
  });
});

describe('the secrets stay in their own lines', () => {
  const SECRETS = KEY_ROLES.map((role) => ({ name: KEY_VARIABLES[role], hex: rawKey(KEY_NUMBERS[role]) }));
  /** The four lines that the manifest publishes: a secret in one of them would be published, and the advert holds the hash of the manifest. */
  const PUBLISHED = ['OPERATOR_CONTACT', 'LLM_MODEL_ALLOWLIST', 'AGENT_VERSION', 'ADVERT_EXPLORER_URL'];
  /** The lines that a secret could be written in by mistake: the four published lines, a line of an address, a line of a list and a line of another secret. */
  const LINES = [...PUBLISHED, 'AGENT_STATUS_CHIP', 'COSIGN_ALLOWLIST', 'PRIORAUTH_STATE_DIR', 'SERVICE_AUTH_HEADER'];

  test.each(SECRETS)('the key of $name found in another line stops the start naming that line, in each form, and never shows the key', ({ name, hex }) => {
    for (const line of LINES.filter((candidate) => candidate !== name)) {
      for (const form of [hex, hex.toUpperCase(), rawHexToBech32(hex), `x${hex}y`, `prefix ${rawHexToBech32(hex).toUpperCase()}`]) {
        const message = messageOf(() => loadConfig(startEnv({ [line]: form })));
        expect(message, `${name} in ${line}`).toMatch(new RegExp(`^environment variable ${line} holds .*, which belongs in ${name} alone: it would be printed or published\\. Take it out of ${line}$`));
        expect(message.toLowerCase()).not.toContain(hex);
      }
    }
    // The key in the line of another key, and in the public line of its own key hash.
    const other = KEY_ROLES.find((role) => KEY_VARIABLES[role] !== name) ?? 'service';
    expect(messageOf(() => loadConfig(startEnv({ [PKH_VARIABLES[other]]: hex })))).toMatch(new RegExp(`^environment variable ${PKH_VARIABLES[other]} holds .*, which belongs in ${name} alone`));
  });

  test('a hex key and a bech32 key in each of the four published lines stop the start, for each of the seven keys, and the message names the line and shows no key', () => {
    let refused = 0;
    for (const { name, hex } of SECRETS) {
      for (const line of PUBLISHED) {
        for (const form of [hex, rawHexToBech32(hex)]) {
          const message = messageOf(() => loadConfig(startEnv({ [line]: form })));
          expect(message, `${name} in ${line}`).toContain(`environment variable ${line} holds`);
          expect(message, `${name} in ${line}`).toContain(`belongs in ${name} alone`);
          expect(message.toLowerCase()).not.toContain(hex);
          expect(message).not.toContain(rawHexToBech32(hex));
          refused += 1;
        }
      }
    }
    expect(refused).toBe(7 * 4 * 2);
    // The same four lines with a value that holds no key are the twin.
    expect(() => loadConfig(startEnv({ OPERATOR_CONTACT: 'ops@example.test', LLM_MODEL_ALLOWLIST: 'a/b', AGENT_VERSION: '0.1.1', ADVERT_EXPLORER_URL: 'https://explorer.example.test/advert' }))).not.toThrow();
  });

  test('the token found in another line stops the start naming that line, whole and by its credential, and never shows the token', () => {
    const credential = TOKEN.slice('Bearer '.length);
    for (const line of LINES.filter((candidate) => candidate !== 'SERVICE_AUTH_HEADER')) {
      for (const form of [TOKEN, credential, credential.toUpperCase(), `x${credential}y`]) {
        const message = messageOf(() => loadConfig(startEnv({ [line]: form })));
        expect(message, `the token in ${line}`).toMatch(new RegExp(`^environment variable ${line} holds the service token, which belongs in SERVICE_AUTH_HEADER alone`));
        expect(message).not.toContain(credential);
      }
    }
  });

  test('the manifest is searched for every secret last: a manifest that holds a key in either form, or the token, stops the start, and the manifest of the service is the twin', () => {
    const leaks: Array<[string, string]> = [
      ...KEY_ROLES.flatMap((role): Array<[string, string]> => [[rawKey(KEY_NUMBERS[role]), role], [rawHexToBech32(rawKey(KEY_NUMBERS[role])).toUpperCase(), role]]),
      [TOKEN, 'token'],
    ];
    for (const [secret, who] of leaks) {
      const message = messageOf(() => loadConfig(startEnv(), (published) => ({ ...manifestFromEnv(published), description: `leak ${secret}` })));
      expect(message, who).toMatch(/^the manifest would publish /);
      expect(message).not.toContain(secret);
    }
    expect(() => loadConfig(startEnv(), manifestFromEnv)).not.toThrow();
  });

  test('a manifest that the kit refuses stops the start with its code', () => {
    const message = messageOf(() => loadConfig(startEnv(), (published) => ({ ...manifestFromEnv(published), schema: 'vector.agent-manifest.v1' })));
    expect(message).toMatch(/^the manifest is refused \(manifest_schema\)/);
  });

  test('the manifest is built with each setting that the kit gives it and never with the live environment, and a build that differs between two renders is refused', () => {
    const seen: Array<string | undefined> = [];
    loadConfig(startEnv({ FAULT_MODE: 'alter_after_approval' }), (published) => { seen.push(published.FAULT_MODE); return manifestFromEnv(published); });
    // The kit renders twice for the empty setting and one time for the one fault value of the agent, whatever the live environment holds: the text is the setting of the kit.
    expect(seen).toStrictEqual(['', '', 'alter_after_approval']);
    const clean: Array<string | undefined> = [];
    loadConfig(startEnv({ FAULT_MODE: undefined }), (published) => { clean.push(published.FAULT_MODE); return manifestFromEnv(published); });
    expect(clean).toStrictEqual(['', '', 'alter_after_approval']);
    let calls = 0;
    const unstable = messageOf(() => loadConfig(startEnv(), (published) => ({ ...manifestFromEnv(published), description: `render ${(calls += 1)}` })));
    expect(unstable).toMatch(/^the manifest is refused \(manifest_not_stable\)/);
    const changing = messageOf(() => loadConfig(startEnv(), (published) => ({ ...manifestFromEnv(published), version: published.FAULT_MODE === '' ? '0.1.0' : '0.1.1' })));
    expect(changing).toMatch(/^the manifest is refused \(manifest_changes_with_fault\)/);
  });
});

describe('the start of the service', () => {
  /** The job of the tests of the whole service: a `propose` for the delegation of the fixture node, which stops at the insurer when the indexer lists none. */
  const JOB = { op: 'propose', authority: { principal_did: `did:vector:${'1f'.repeat(32)}`, delegation: '77'.repeat(32) }, tenant: 'run1', order_id: 'ORD-1001', insurer_did: INSURER_DID };
  const fixtureNode = () => ledgerWorld([liveDelegation(DELEG_A.keyHash)]);

  test('listens, logs one line with the manifest hash and the three wallets, serves the manifest, and prints no secret in the log, in the manifest or in an answer', async () => {
    const { service, dir, log, origin } = await start();
    const config = loadConfig(startEnv({ PRIORAUTH_STATE_DIR: dir }));
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

  test('serves the bytes whose SHA-256 the script of the repository prints for the advert, and the same bytes for each fault setting', async () => {
    const clean = await start();
    const faulty = await start({ FAULT_MODE: 'alter_after_approval' });
    const printed = JSON.parse((await run(process.execPath, [`${root}scripts/manifest-hash.mjs`, clean.origin])).stdout) as { detail_uri: string; detail_hash: string; bytes: number };
    const config = loadConfig(startEnv({ PRIORAUTH_STATE_DIR: '/var/state' }));
    expect(printed).toStrictEqual({ detail_uri: `${clean.origin}/agent.json`, detail_hash: config.manifest.sha256, bytes: Buffer.byteLength(config.manifest.text, 'utf8') });
    expect(await (await fetch(`${faulty.origin}/agent.json`)).text()).toBe(await (await fetch(`${clean.origin}/agent.json`)).text());
  });

  test('keeps its records in the state directory: a stranded store for each of the three paying keys, the journal, and nothing that holds a key, and none for a subagent key', async () => {
    const { dir } = await start();
    const config = loadConfig(startEnv({ PRIORAUTH_STATE_DIR: dir }));
    for (const key of [config.keys.service, config.keys.delegation1, config.keys.delegation2]) expect(existsSync(join(dir, 'keys', key.pkh))).toBe(true);
    for (const role of ['recordReaderAuthentication', 'recordReaderDelegation', 'drafterAuthentication', 'drafterDelegation'] as const) expect(existsSync(join(dir, 'keys', config.keys[role].pkh))).toBe(false);
    expect(existsSync(join(dir, 'dispute'))).toBe(true);
    expect(existsSync(join(dir, '.write-probe'))).toBe(false);
  });

  test('stops with PRIORAUTH_STATE_DIR named when the directory cannot be written, and makes nothing for an environment that is refused', async () => {
    const dir = tempDir();
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    const unwritable = await start({ PRIORAUTH_STATE_DIR: file }).catch((error: unknown) => error);
    expect((unwritable as Error).message).toMatch(/^environment variable PRIORAUTH_STATE_DIR names .* which cannot be written/);
    const fresh = join(dir, 'fresh');
    const refused = await start({ PRIORAUTH_STATE_DIR: fresh, COSIGN_ALLOWLIST: undefined }).catch((error: unknown) => error);
    expect((refused as Error).message).toMatch(/COSIGN_ALLOWLIST is not set/);
    expect(existsSync(fresh)).toBe(false);
    mkdirSync(join(dir, 'twin'));
    await expect(start({ PRIORAUTH_STATE_DIR: join(dir, 'twin') })).resolves.toBeDefined();
  });

  test('a fault value of another agent, and any value that the agent does not list, do not start the service, and the empty setting and the value of the agent do', async () => {
    const dir = tempDir();
    for (const value of ['confirm_wrong_lot', 'nonsense', 'ALTER_AFTER_APPROVAL']) {
      const failed = await start({ PRIORAUTH_STATE_DIR: join(dir, value), FAULT_MODE: value }).catch((error: unknown) => error);
      expect((failed as Error).message, value).toMatch(/^environment variable FAULT_MODE must be empty or "alter_after_approval"/);
      expect(existsSync(join(dir, value)), value).toBe(false);
    }
    await expect(start({ FAULT_MODE: '' })).resolves.toBeDefined();
    await expect(start({ FAULT_MODE: 'alter_after_approval' })).resolves.toBeDefined();
  });

  test('each result shows the setting as fault_mode: the empty text for the empty setting, and the value of the agent for the fault setting, and both serve one manifest', async () => {
    const options = { provider: fixtureNode(), sources: { fetchSuppliers: async () => [] } };
    const clean = await start({ AGENT_DID: KIT_AGENT_DID, FAULT_MODE: '' }, options);
    const faulty = await start({ AGENT_DID: KIT_AGENT_DID, FAULT_MODE: 'alter_after_approval' }, options);
    const answers = [await post(clean.origin, JOB), await post(faulty.origin, JOB)];
    expect(answers[0]).toMatchObject({ status: 200, body: { outcome: 'failed', reason: 'insurer_not_listed', exit_state: 'Failed', fault_mode: '' } });
    expect(answers[1]).toMatchObject({ status: 200, body: { outcome: 'failed', reason: 'insurer_not_listed', exit_state: 'Failed', fault_mode: 'alter_after_approval' } });
    for (const answer of answers) expect(Object.keys(answer.body).at(-1)).toBe('fault_mode');
    expect(clean.log.some((line) => /^propose done in \d+ ms: outcome failed, reason insurer_not_listed, exit Failed, decisions 0$/.test(line))).toBe(true);
    // The token is the one of the runtime: the same job with none is refused before it runs.
    expect((await post(clean.origin, JOB, null)).status).toBe(401);
  });

  test('stops when the node gives no start time of the chain, before it listens, and the node of the fixture world is the twin', async () => {
    const none = ledgerWorld();
    none.getSystemStartMs = async () => { throw new Error('the node does not answer'); };
    const lines: string[] = [];
    const failed = await start({}, { provider: none, log: (line) => { lines.push(line); } }).catch((error: unknown) => error);
    expect((failed as Error).message).toMatch(/^the node gave no start time of the chain/);
    expect(lines.some((line) => line.startsWith('listening on '))).toBe(false);
    await expect(start()).resolves.toBeDefined();
  });

  test('stops when the manifest of Module-1 names another identity registry than IDENTITY_POLICY_ID, before it listens, and the manifest of the deployment is the twin', async () => {
    const lines: string[] = [];
    const serving = (text: string) => async () => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
    const failed = await start({}, { fetchImpl: serving(module1ManifestText('ab'.repeat(28))) as typeof fetch, log: (line) => { lines.push(line); } }).catch((error: unknown) => error);
    expect((failed as Error).message).toMatch(/^the Module-1 manifest \(VECTOR_MODULE1_MANIFEST\) names another identity registry than IDENTITY_POLICY_ID/);
    expect(lines.some((line) => line.startsWith('listening on '))).toBe(false);
    await expect(start({}, { fetchImpl: serving(module1ManifestText()) as typeof fetch })).resolves.toBeDefined();
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
      await until(() => exits.length > 0, 20_000);
      expect(calls).toStrictEqual([1234]);
      expect(exits).toStrictEqual([code]);
      expect(target.listenerCount('SIGTERM') + target.listenerCount('SIGINT')).toBe(0);
    }
  });
});

describe('src/index.ts as a process', () => {
  /**
   * The environment of the child: the complete environment, and no setting of this process. The addresses that the child could use point at a port that nothing holds. The two fetches of the start that are not made
   * to such a port, the Module-1 manifest at its pinned address and the calls to the node at its https address, are answered by `child-fetch.mjs`, which a child loads before the service: no child reaches a network.
   */
  const spawnService = (env: NodeJS.ProcessEnv) => {
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

  test('exits 1 at start with the variable named, and listens on nothing, when a setting is missing, a key is in the wrong line, the node address is http, or the fault setting is not the value of the agent', async () => {
    const dir = tempDir();
    const cases: Array<[NodeJS.ProcessEnv, RegExp]> = [
      [{ COSIGN_ALLOWLIST: undefined }, /^\[prior-authorization-agent\] cannot start: .*COSIGN_ALLOWLIST is not set/],
      [{ PRIORAUTH_DELEGATION_2_PRIV_KEY_HEX: '' }, /^\[prior-authorization-agent\] cannot start: environment variable PRIORAUTH_DELEGATION_2_PRIV_KEY_HEX is required/],
      [{ OPERATOR_CONTACT: SERVICE_HEX }, /^\[prior-authorization-agent\] cannot start: environment variable OPERATOR_CONTACT holds the service key/],
      [{ FAULT_MODE: 'confirm_wrong_lot' }, /^\[prior-authorization-agent\] cannot start: environment variable FAULT_MODE must be empty or "alter_after_approval"/],
      [{ VECTOR_MODULE1_MANIFEST: MODULE1_FIXTURE }, /^\[prior-authorization-agent\] cannot start: environment variable VECTOR_MODULE1_MANIFEST must be an https URL/],
      [{ VECTOR_OGMIOS_URL: 'http://198.51.100.8:1337' }, /^\[prior-authorization-agent\] cannot start: environment variable VECTOR_OGMIOS_URL must be an https address/],
    ];
    const results = await Promise.all(cases.map(async ([env]) => {
      const p = spawnService({ ...startEnv({ PRIORAUTH_STATE_DIR: dir }), ...OFF_CHAIN, ...env });
      return { code: await p.exited, out: p.out(), err: p.err() };
    }));
    cases.forEach(([, refusal], index) => {
      expect(results[index].code).toBe(1);
      expect(results[index].err).toMatch(refusal);
      expect(results[index].out).not.toContain('listening on');
      for (const secret of secretsOf()) expect((results[index].out + results[index].err).toLowerCase()).not.toContain(secret.toLowerCase());
    });
  }, 90_000);

  test('started for real with a complete environment: it logs its line, answers /healthz and /agent.json, refuses a job without the token, prints no secret, and stops on SIGTERM with exit 0', async () => {
    const dir = tempDir();
    const p = spawnService({ ...startEnv({ PRIORAUTH_STATE_DIR: dir, VECTOR_MARKETPLACE_INDEXER_URL: undefined }), ...OFF_CHAIN });
    try {
      await until(() => /listening on 127\.0\.0\.1:\d+/.test(p.out()) || p.child.exitCode !== null, 20_000);
      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(p.out())?.[1];
      expect(port, p.err()).toBeDefined();
      const base = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${base}/healthz`)).json()).toStrictEqual({ ok: true });
      const manifest = (await (await fetch(`${base}/agent.json`)).json()) as { name: string; status: unknown; keys: { buyer_pkh: string } };
      expect([manifest.name, manifest.status, manifest.keys.buyer_pkh]).toStrictEqual(['Prior Authorization Agent', { chip: 'proposed', since: STATUS_SINCE_DEFAULT }, keyOf(SERVICE_HEX).pkh]);
      expect((await fetch(`${base}/`, { method: 'POST', body: '[]' })).status).toBe(401);
      expect(p.out()).toMatch(/^\[prior-authorization-agent\] listening on 127\.0\.0\.1:\d+; manifest [0-9a-f]{64}; wallets \(service, delegation 1, delegation 2\) addr1/m);
      for (const secret of secretsOf()) expect((p.out() + p.err()).toLowerCase()).not.toContain(secret.toLowerCase());
      p.child.kill('SIGTERM');
      expect(await p.exited).toBe(0);
      expect(p.out()).toContain('SIGTERM: stopping');
    } finally {
      p.child.kill('SIGKILL');
    }
  }, 90_000);
});
