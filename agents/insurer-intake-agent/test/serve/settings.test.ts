// agents/insurer-intake-agent/test/serve/settings.test.ts
// The settings of the Insurer Intake Agent that name no key. Each reader refuses a value that is missing or wrong, names the setting, and never repeats the value. Each refusal has an accepted twin: the same setting
// with a value that the rule takes. The agent has no fault value, so any value of the switch stops the start. A limit has no default, and the time of the hook has the range that keeps its six reads inside the
// wait of the runtime. No test here starts a service or uses the network.
import { describe, expect, test } from 'vitest';
import { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from '@vsa/buyer-core';
import { LEAST_RESOLUTION_DEADLINE_MS } from '@vsa/usecase-kit/dispute';
import { AGENT_KINDS, FAULT_MODES } from '@vsa/usecase-kit/protocol';
import {
  BUYER_BOND_LOVELACE, CALL_TIMEOUT_MS, CHECKS_READ_BUDGET_DEFAULT_MS, CHECKS_READ_BUDGET_MAX_MS, CHECKS_READ_BUDGET_MIN_MS, GATEWAY_DEFAULT, HOOK_READS, HOOK_READS_LIMIT_MS, HOST_DEFAULT, JOB_DEADLINE_MS,
  MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, PRICE_DEFAULT_LOVELACE, RUNTIME_PRECHECK_WAIT_MS, STATE_DIR_DEFAULT, SUPPLIER_BOND_LOVELACE, agentDidOf, checksReadBudgetOf, disputeOf, endpointsFromEnv, faultOf,
  hostOf, httpsOriginOf, limitsOf, mockBasesOf, modelOf, module1SourceOf, portOf, priceOf, processingWindowOf, stateDirOf, supplierKeyOf,
} from '../../src/serve/settings.ts';
import { AGENT_DID, FULL_ENV, MODULE1_COMMIT, MODULE1_URL, OTHER, SERVICE, SUPPLIER, envWith, message, shows } from './support.ts';

/** A value that no setting takes. A message must name the setting and never repeat it. */
const MARKER = 'zq9-marker-value-7f3';
const ANOTHER_DID = `did:vector:${'ab'.repeat(32)}`;

type Reader = (env: NodeJS.ProcessEnv) => unknown;
/**
 * One refusal of the start: the setting, the function that reads it, the value that is refused (undefined: not set), the start of the message, the same setting with a value that is accepted (the twin), and a
 * value that breaks the same rule and that no message could repeat by chance (the marker with a space and a mark, unless the row gives another).
 */
type Row = readonly [setting: string, read: Reader, bad: string | undefined, refusal: RegExp, good: string | undefined, probe?: string];

const required = (name: string): RegExp => new RegExp(`^environment variable ${name} is required \\(.+\\) and is not set$`);
const originRule = (name: string): RegExp => new RegExp(`^environment variable ${name} must be an https origin with no user, path, query or fragment, and it has \\d+ characters$`);
const addressForm = (name: string): RegExp => new RegExp(`^environment variable ${name} must be an http or https address, and it has \\d+ characters$`);
const addressUser = (name: string): RegExp => new RegExp(`^environment variable ${name} must be an http or https address with no user and no password, and it has \\d+ characters$`);
const lovelaceRule = (name: string): RegExp => new RegExp(`^environment variable ${name} must be a whole number of lovelace of more than 0, written in digits, and it has \\d+ characters$`);
const digitsRule = (name: string): RegExp => new RegExp(`^environment variable ${name} must be a non-negative whole number written in digits, and it has \\d+ characters$`);
const millisecondsRule = (name: string, least: number): RegExp => new RegExp(`^environment variable ${name} must be a whole number of milliseconds of at least ${least}, and it has \\d+ characters$`);

const FAULT_REFUSAL = /^environment variable FAULT_MODE must be empty \(insurer-intake-agent has no fault value\) for insurer-intake-agent, and it has \d+ characters$/;
const NOT_THE_KEY = /^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH: the key hash of the one is not the other\. Both are published, so they must come from the same key pair, and the public key line must not hold a private key$/;
const BUDGET_RANGE = /^environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 1499$/;
const BUDGET_TOO_WIDE = /^environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 1499: the hook makes 6 timed reads one after the other, and the runtime waits 10000 ms for it, so 6 times the budget must be under 9000 ms$/;
const WINDOW_RULE = /^environment variable ADVERT_MAX_PROCESSING_MS must be at least 480000 \(the window of 8 min that the deadline of a job, 300000 ms, assumes\)$/;
const PRICE_RULE = lovelaceRule('ADVERT_PRICE_LOVELACE');
const SAME_HOST = /^environment variable MOCK_MTLS_BASE must name another host than MOCK_PUBLIC_BASE: the mock service tells the two hosts apart by the Host header$/;
const OGMIOS_HTTPS = /^environment variable VECTOR_OGMIOS_URL must be an https address: the tip reader of the janitor takes https only, and it has \d+ characters$/;
const MODULE1_FORM = /^environment variable VECTOR_MODULE1_MANIFEST must be an https URL with no user, query or fragment, and it has \d+ characters$/;
const MODULE1_PIN = /^environment variable VECTOR_MODULE1_MANIFEST must be pinned to a commit: one segment of its path must be the 40 lowercase hex characters of the commit, .* It has \d+ characters$/;
const MODEL_NAME = /^environment variable LLM_MODEL_ALLOWLIST entry 1 must be a model name \(letters, digits, dots, underscores, colons, slashes and hyphens\)$/;

const ROWS: readonly Row[] = [
  ['AGENT_DID', agentDidOf, undefined, required('AGENT_DID'), ANOTHER_DID],
  ['AGENT_DID', agentDidOf, 'did:vector:xyz', /^environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters, and it has 14 characters$/, ANOTHER_DID],
  ['AGENT_DID', agentDidOf, 'someone', /^environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters, and it has 7 characters$/, ANOTHER_DID],
  ['AGENT_DID', agentDidOf, `did:vector:${'zz'.repeat(32)}`, /^environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters, and it has 75 characters$/, ANOTHER_DID],
  ['FAULT_MODE', faultOf, 'alter_after_approval', FAULT_REFUSAL, ''],
  ['FAULT_MODE', faultOf, 'yes', FAULT_REFUSAL, undefined],
  ['FAULT_MODE', faultOf, ' ', FAULT_REFUSAL, ''],
  ['PORT', portOf, '70000', /^environment variable PORT must be a port from 0 to 65535, and it has 5 characters$/, '0', '7123456'],
  ['PORT', portOf, 'abc', digitsRule('PORT'), '9104'],
  ['PORT', portOf, '-1', digitsRule('PORT'), '9104'],
  ['HOST', hostOf, 'bad host!', /^environment variable HOST must be an address or a host name, and it has 9 characters$/, '127.0.0.1'],
  ['INTAKE_STATE_DIR', stateDirOf, 'relative/state', /^environment variable INTAKE_STATE_DIR must be an absolute path, and it has 14 characters$/, '/var/state'],
  ['INTAKE_STATE_DIR', stateDirOf, './state', /^environment variable INTAKE_STATE_DIR must be an absolute path, and it has 7 characters$/, '/data'],
  ['CHECKS_READ_BUDGET_MS', checksReadBudgetOf, '499', BUDGET_RANGE, '500', '431'],
  ['CHECKS_READ_BUDGET_MS', checksReadBudgetOf, '1500', BUDGET_TOO_WIDE, '1499', '7391'],
  ['CHECKS_READ_BUDGET_MS', checksReadBudgetOf, '4001', BUDGET_TOO_WIDE, '1200'],
  ['CHECKS_READ_BUDGET_MS', checksReadBudgetOf, 'fast', digitsRule('CHECKS_READ_BUDGET_MS'), '1200'],
  ['ADVERT_MAX_PROCESSING_MS', processingWindowOf, '479999', WINDOW_RULE, '480000', '479731'],
  ['ADVERT_MAX_PROCESSING_MS', processingWindowOf, 'long', digitsRule('ADVERT_MAX_PROCESSING_MS'), '900000'],
  ['ADVERT_PRICE_LOVELACE', priceOf, '0', PRICE_RULE, '1'],
  ['ADVERT_PRICE_LOVELACE', priceOf, '1.5', PRICE_RULE, '2000000', '2.7731'],
  ['ADVERT_PRICE_LOVELACE', priceOf, 'free', PRICE_RULE, '2000000'],
  ['SUPPLIER_PKH', supplierKeyOf, undefined, required('SUPPLIER_PKH'), SUPPLIER.pkh],
  ['SUPPLIER_PKH', supplierKeyOf, 'ab', /^environment variable SUPPLIER_PKH must be 56 hex characters, and it has 2 characters$/, SUPPLIER.pkh],
  ['SUPPLIER_PKH', supplierKeyOf, 'zz'.repeat(28), /^environment variable SUPPLIER_PKH must be 56 hex characters, and some of its 56 characters are not hex$/, SUPPLIER.pkh],
  ['SUPPLIER_PKH', supplierKeyOf, 'ab'.repeat(28), NOT_THE_KEY, SUPPLIER.pkh],
  ['SUPPLIER_PUB_KEY_HEX', supplierKeyOf, undefined, required('SUPPLIER_PUB_KEY_HEX'), SUPPLIER.pubKeyHex],
  ['SUPPLIER_PUB_KEY_HEX', supplierKeyOf, 'ab', /^environment variable SUPPLIER_PUB_KEY_HEX must be 64 hex characters, and it has 2 characters$/, SUPPLIER.pubKeyHex],
  ['SUPPLIER_PUB_KEY_HEX', supplierKeyOf, OTHER.pubKeyHex, NOT_THE_KEY, SUPPLIER.pubKeyHex],
  ['SUPPLIER_PUB_KEY_HEX', supplierKeyOf, SERVICE.privateKeyHex, NOT_THE_KEY, SUPPLIER.pubKeyHex],
  ['MOCK_PUBLIC_BASE', mockBasesOf, undefined, required('MOCK_PUBLIC_BASE'), 'https://mock.example.test'],
  ['MOCK_PUBLIC_BASE', mockBasesOf, 'http://mock.example.test', originRule('MOCK_PUBLIC_BASE'), 'https://mock.example.test'],
  ['MOCK_PUBLIC_BASE', mockBasesOf, 'https://user@mock.example.test', originRule('MOCK_PUBLIC_BASE'), 'https://mock.example.test'],
  ['MOCK_PUBLIC_BASE', mockBasesOf, 'mock.example', /^environment variable MOCK_PUBLIC_BASE must be an https origin such as https:\/\/host\.example, and it has 12 characters$/, 'https://mock.example.test'],
  ['MOCK_PUBLIC_BASE', mockBasesOf, 'https://mock-mtls.example.test', SAME_HOST, 'https://mock.example.test'],
  ['MOCK_MTLS_BASE', mockBasesOf, undefined, required('MOCK_MTLS_BASE'), 'https://mock-mtls.example.test'],
  ['MOCK_MTLS_BASE', mockBasesOf, 'https://mock-mtls.example.test/x', originRule('MOCK_MTLS_BASE'), 'https://mock-mtls.example.test'],
  ['MOCK_MTLS_BASE', mockBasesOf, 'https://mock.example.test', SAME_HOST, 'https://mock-mtls.example.test'],
  ['IDENTITY_GATEWAY_URL', endpointsFromEnv, 'http://gateway.example.test', originRule('IDENTITY_GATEWAY_URL'), 'https://gateway.example.test'],
  ['IDENTITY_GATEWAY_URL', endpointsFromEnv, 'https://gateway.example.test/path', originRule('IDENTITY_GATEWAY_URL'), 'https://gateway.example.test'],
  ['VECTOR_OGMIOS_URL', endpointsFromEnv, 'http://127.0.0.1:1337', OGMIOS_HTTPS, 'https://127.0.0.1:1337', 'http://127.0.0.1:1337/7731'],
  ['VECTOR_OGMIOS_URL', endpointsFromEnv, 'ftp://node.example.test', addressUser('VECTOR_OGMIOS_URL'), 'https://ogmios.example.test'],
  ['VECTOR_OGMIOS_URL', endpointsFromEnv, 'not an address', addressForm('VECTOR_OGMIOS_URL'), 'https://ogmios.example.test'],
  ['VECTOR_OGMIOS_URL', endpointsFromEnv, 'https://user:password@ogmios.example.test', addressUser('VECTOR_OGMIOS_URL'), 'https://ogmios.example.test'],
  ['VECTOR_KOIOS_URL', endpointsFromEnv, 'https://user:password@koios.example.test', addressUser('VECTOR_KOIOS_URL'), 'http://koios.example.test/'],
  ['VECTOR_SUBMIT_URL', endpointsFromEnv, 'submit.example.test', addressForm('VECTOR_SUBMIT_URL'), 'https://submit.example.test/api/submit/tx'],
  ['VECTOR_MARKETPLACE_INDEXER_URL', endpointsFromEnv, 'mailto:ops@example.test', addressUser('VECTOR_MARKETPLACE_INDEXER_URL'), 'https://indexer.example.test'],
  ['VECTOR_MODULE1_MANIFEST', module1SourceOf, undefined, required('VECTOR_MODULE1_MANIFEST'), MODULE1_URL],
  ['VECTOR_MODULE1_MANIFEST', module1SourceOf, '/etc/insurer/module1.json', MODULE1_FORM, MODULE1_URL],
  ['VECTOR_MODULE1_MANIFEST', module1SourceOf, `http://raw.example.test/${MODULE1_COMMIT}/manifest.json`, MODULE1_FORM, MODULE1_URL],
  ['VECTOR_MODULE1_MANIFEST', module1SourceOf, 'https://raw.example.test/Apex-Fusion/modules/main/manifest.json', MODULE1_PIN, MODULE1_URL],
  ['LLM_MODEL_ALLOWLIST', limitsOf, undefined, required('LLM_MODEL_ALLOWLIST'), 'a/one, b/two'],
  ['LLM_MODEL_ALLOWLIST', limitsOf, 'deepseek/deepseek-v4-flash free', MODEL_NAME, 'deepseek/deepseek-v4-flash:free'],
  ['LLM_MODEL_ALLOWLIST', limitsOf, ' , ', /^environment variable LLM_MODEL_ALLOWLIST must name at least one model, as a comma-separated list$/, 'a/one'],
  ['LLM_MAX_PRICE_LOVELACE', limitsOf, undefined, required('LLM_MAX_PRICE_LOVELACE'), '250000'],
  ['LLM_MAX_PRICE_LOVELACE', limitsOf, '1.5', /^environment variable LLM_MAX_PRICE_LOVELACE must be a whole number of lovelace/, '250000'],
  ['LLM_MAX_PRICE_LOVELACE', limitsOf, '0', /^environment variable LLM_MAX_PRICE_LOVELACE must be a whole number of lovelace of more than 0$/, '1'],
  ['LLM_MAX_SUPPLIER_BOND_LOVELACE', limitsOf, undefined, required('LLM_MAX_SUPPLIER_BOND_LOVELACE'), '1000000'],
  ['LLM_MAX_SUPPLIER_BOND_LOVELACE', limitsOf, '0', lovelaceRule('LLM_MAX_SUPPLIER_BOND_LOVELACE'), '1000000'],
  ['LLM_MAX_SUPPLIER_BOND_LOVELACE', limitsOf, '1.5', lovelaceRule('LLM_MAX_SUPPLIER_BOND_LOVELACE'), '15', '2.7731'],
  ['LLM_MAX_SUPPLIER_BOND_LOVELACE', limitsOf, '-1', lovelaceRule('LLM_MAX_SUPPLIER_BOND_LOVELACE'), '0001'],
  ['LLM_MAX_BUYER_BOND_LOVELACE', limitsOf, '  ', required('LLM_MAX_BUYER_BOND_LOVELACE'), '1000000'],
  ['LLM_MAX_BUYER_BOND_LOVELACE', limitsOf, 'none', lovelaceRule('LLM_MAX_BUYER_BOND_LOVELACE'), '1000000'],
  ['LLM_MAX_BUYER_BOND_LOVELACE', limitsOf, '1e6', lovelaceRule('LLM_MAX_BUYER_BOND_LOVELACE'), '1000000'],
  ['DISPUTE_CHALLENGE_STAKE_LOVELACE', disputeOf, undefined, required('DISPUTE_CHALLENGE_STAKE_LOVELACE'), '50000000'],
  ['DISPUTE_CHALLENGE_STAKE_LOVELACE', disputeOf, '0', lovelaceRule('DISPUTE_CHALLENGE_STAKE_LOVELACE'), '50000000'],
  ['DISPUTE_MIN_WINDOW_LEFT_MS', disputeOf, undefined, required('DISPUTE_MIN_WINDOW_LEFT_MS'), '2000'],
  ['DISPUTE_MIN_WINDOW_LEFT_MS', disputeOf, '1999', millisecondsRule('DISPUTE_MIN_WINDOW_LEFT_MS', 2_000), '2000', '1731'],
  ['DISPUTE_MIN_WINDOW_LEFT_MS', disputeOf, 'soon', digitsRule('DISPUTE_MIN_WINDOW_LEFT_MS'), '2000'],
  ['DISPUTE_READ_TIMEOUT_MS', disputeOf, undefined, required('DISPUTE_READ_TIMEOUT_MS'), '20000'],
  ['DISPUTE_READ_TIMEOUT_MS', disputeOf, '0', millisecondsRule('DISPUTE_READ_TIMEOUT_MS', 1), '1'],
  ['DISPUTE_STARTED_LEASE_MS', disputeOf, '39999', millisecondsRule('DISPUTE_STARTED_LEASE_MS', 40_000), '40000', '31731'],
  ['DISPUTE_RESOLUTION_DEADLINE_MS', disputeOf, '1000', millisecondsRule('DISPUTE_RESOLUTION_DEADLINE_MS', LEAST_RESOLUTION_DEADLINE_MS), '259200000', '1731'],
];

const TABLE = ROWS.map(([setting, read, bad, refusal, good, probe]) => ({ setting, read, bad, refusal, good, probe }));

describe('every refusal of the start, with its accepted twin', () => {
  test.each(TABLE)('$setting = $bad is refused by its name, the message shows no value, and $good is accepted', ({ setting, read, bad, refusal, good, probe }) => {
    const text = message(() => read(envWith({ [setting]: bad })));
    expect(text).toMatch(refusal);
    expect(text).toContain(setting);
    if (bad !== undefined) expect(shows(text, bad), 'the message repeats the value').toBe(false);
    expect(() => read(envWith({ [setting]: good })), `${setting} = ${String(good)}`).not.toThrow();
    if (bad === undefined) return;
    // The same rule with a value that no message could repeat by chance.
    const odd = probe ?? `${MARKER} !`;
    const probed = message(() => read(envWith({ [setting]: odd })));
    expect(probed).toContain(setting);
    expect(shows(probed, odd), `the message repeats ${odd}`).toBe(false);
  });

  test('the full environment is accepted by every reader, so a row above refuses one setting and nothing else', () => {
    for (const read of new Set(ROWS.map(([, reader]) => reader))) expect(() => read(FULL_ENV), String(read.name)).not.toThrow();
  });

  test('a required setting has a row for the missing value, and a setting with a rule has a row for a value that breaks it', () => {
    const requiredSettings = [
      'AGENT_DID', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'VECTOR_MODULE1_MANIFEST', 'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE', 'LLM_MAX_SUPPLIER_BOND_LOVELACE',
      'LLM_MAX_BUYER_BOND_LOVELACE', 'DISPUTE_CHALLENGE_STAKE_LOVELACE', 'DISPUTE_MIN_WINDOW_LEFT_MS', 'DISPUTE_READ_TIMEOUT_MS',
    ];
    for (const name of requiredSettings) {
      expect(ROWS.some(([setting, , bad]) => setting === name && (bad === undefined || bad.trim() === '')), name).toBe(true);
    }
    const ruledSettings = [
      'FAULT_MODE', 'PORT', 'HOST', 'INTAKE_STATE_DIR', 'CHECKS_READ_BUDGET_MS', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_PRICE_LOVELACE', 'IDENTITY_GATEWAY_URL', 'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL',
      'VECTOR_MARKETPLACE_INDEXER_URL', 'DISPUTE_STARTED_LEASE_MS', 'DISPUTE_RESOLUTION_DEADLINE_MS', ...requiredSettings,
    ];
    for (const name of ruledSettings) expect(ROWS.some(([setting, , bad]) => setting === name && bad !== undefined && bad.trim() !== ''), name).toBe(true);
  });
});

describe('the numbers of the service', () => {
  test('are those of the advert and of the job: port 9104, a deadline of 300 s, a window of 480 s that holds the timeout of the runtime, the price 2 and the two bonds 1', () => {
    expect([PORT_DEFAULT, HOST_DEFAULT, STATE_DIR_DEFAULT, GATEWAY_DEFAULT]).toStrictEqual([9104, '0.0.0.0', '/data', 'https://id.vector.apexfusion.org']);
    expect([JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS]).toStrictEqual([300_000, 480_000]);
    // The runtime waits 60 s longer than the job (SERVICE_TIMEOUT_MS is 360000), and the window of the advert holds 120 s more than that.
    expect(MIN_PROCESSING_WINDOW_MS).toBe(JOB_DEADLINE_MS + 60_000 + 120_000);
    expect([PRICE_DEFAULT_LOVELACE, SUPPLIER_BOND_LOVELACE, BUYER_BOND_LOVELACE]).toStrictEqual([2_000_000, 1_000_000, 1_000_000]);
    expect(CALL_TIMEOUT_MS).toBe(20_000);
  });

  test('are the defaults of the readers, and a blank setting is a setting that is not set', () => {
    expect([portOf({}), hostOf({}), stateDirOf({}), processingWindowOf({}), priceOf({}), checksReadBudgetOf({})]).toStrictEqual([9104, '0.0.0.0', '/data', 480_000, 2_000_000, 1_200]);
    expect([portOf({ PORT: '' }), hostOf({ HOST: ' ' }), stateDirOf({ INTAKE_STATE_DIR: ' ' }), processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '' }), priceOf({ ADVERT_PRICE_LOVELACE: ' ' })]).toStrictEqual([9104, '0.0.0.0', '/data', 480_000, 2_000_000]);
    expect([portOf({ PORT: '9200' }), hostOf({ HOST: '127.0.0.1' }), stateDirOf({ INTAKE_STATE_DIR: ' /var/state ' }), processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '600000' }), priceOf({ ADVERT_PRICE_LOVELACE: '3000000' })])
      .toStrictEqual([9200, '127.0.0.1', '/var/state', 600_000, 3_000_000]);
  });
});

describe('the identity and the fault switch', () => {
  test('the DID is read in its canonical form, and its value is the one that the manifest publishes', () => {
    expect(agentDidOf(FULL_ENV)).toBe(AGENT_DID);
    expect(agentDidOf(envWith({ AGENT_DID: ` ${AGENT_DID}\n` }))).toBe(AGENT_DID);
  });

  test('the switch is empty or not set: both start, and the switch is the one of this kind', () => {
    for (const env of [{}, { FAULT_MODE: '' }, FULL_ENV]) {
      const fault = faultOf(env);
      expect([fault.kind, fault.mode]).toStrictEqual(['insurer-intake-agent', '']);
    }
  });

  test('every other value stops the start: the fault value of each kind of agent, and each stray text', () => {
    const values = AGENT_KINDS.flatMap((kind) => [...FAULT_MODES[kind]]);
    expect(values.length).toBeGreaterThan(0);
    for (const value of [...values, 'true', '1', 'on', ' ', 'none', MARKER, values[0].toUpperCase(), `${values[0]} `]) {
      expect(() => faultOf({ FAULT_MODE: value }), JSON.stringify(value)).toThrow(FAULT_REFUSAL);
    }
    // This agent has no fault value in the table of the kit, and so no value can start it.
    expect(FAULT_MODES['insurer-intake-agent']).toStrictEqual([]);
  });
});

describe('the time of the hook', () => {
  test('the six timed reads stay under 9 seconds: the budget is from 500 to 1499, and 1499 is accepted where 1500 is not', () => {
    expect([HOOK_READS, HOOK_READS_LIMIT_MS, RUNTIME_PRECHECK_WAIT_MS, CHECKS_READ_BUDGET_MIN_MS, CHECKS_READ_BUDGET_MAX_MS]).toStrictEqual([6, 9_000, 10_000, 500, 1_499]);
    for (const accepted of [500, 1_200, 1_499]) expect(checksReadBudgetOf({ CHECKS_READ_BUDGET_MS: String(accepted) }), String(accepted)).toBe(accepted);
    for (const refused of [0, 499, 1_500, 2_500, 9_000]) expect(() => checksReadBudgetOf({ CHECKS_READ_BUDGET_MS: String(refused) }), String(refused)).toThrow(/^environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 1499/);
    expect(checksReadBudgetOf({})).toBe(CHECKS_READ_BUDGET_DEFAULT_MS);
    expect(CHECKS_READ_BUDGET_DEFAULT_MS).toBe(1_200);
  });

  test('the range that the message names is the range that the start accepts, and it is the widest range whose six reads stay under 9 seconds', () => {
    const [, from, to] = /from (\d+) to (\d+)/.exec(message(() => checksReadBudgetOf({ CHECKS_READ_BUDGET_MS: '1' }))) ?? [];
    const [least, most] = [Number(from), Number(to)];
    expect([least, most]).toStrictEqual([CHECKS_READ_BUDGET_MIN_MS, CHECKS_READ_BUDGET_MAX_MS]);
    for (const ms of [least, most]) expect(checksReadBudgetOf({ CHECKS_READ_BUDGET_MS: String(ms) }), String(ms)).toBe(ms);
    for (const ms of [least - 1, most + 1]) expect(() => checksReadBudgetOf({ CHECKS_READ_BUDGET_MS: String(ms) }), String(ms)).toThrow(`from ${least} to ${most}`);
    expect(most * HOOK_READS).toBeLessThan(HOOK_READS_LIMIT_MS);
    expect((most + 1) * HOOK_READS).toBeGreaterThanOrEqual(HOOK_READS_LIMIT_MS);
    // The wait of the runtime is longer than the six reads, with a second to spare for the rest of the hook.
    expect(RUNTIME_PRECHECK_WAIT_MS - most * HOOK_READS).toBeGreaterThanOrEqual(1_000);
    expect(least).toBeLessThanOrEqual(CHECKS_READ_BUDGET_DEFAULT_MS);
    expect(CHECKS_READ_BUDGET_DEFAULT_MS).toBeLessThanOrEqual(most);
  });
});

describe('the supplier key', () => {
  test('is a key hash and the public key of that hash, in any case, and the public values come out in lower case', () => {
    expect(supplierKeyOf(FULL_ENV)).toStrictEqual({ pkh: SUPPLIER.pkh, pubKeyHex: SUPPLIER.pubKeyHex });
    expect(supplierKeyOf(envWith({ SUPPLIER_PKH: ` ${SUPPLIER.pkh.toUpperCase()}\n`, SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex.toUpperCase() }))).toStrictEqual({ pkh: SUPPLIER.pkh, pubKeyHex: SUPPLIER.pubKeyHex });
  });
});

describe('the endpoints and the mock service', () => {
  test('the defaults are the endpoints of Vector mainnet, and a blank setting is not set', () => {
    expect(endpointsFromEnv({})).toStrictEqual({ gatewayUrl: GATEWAY_DEFAULT, ogmiosUrl: VECTOR_OGMIOS_URL, koiosUrl: VECTOR_KOIOS_URL, submitUrl: VECTOR_SUBMIT_URL, indexerUrl: undefined });
    expect(endpointsFromEnv({ IDENTITY_GATEWAY_URL: ' ', VECTOR_OGMIOS_URL: '', VECTOR_KOIOS_URL: ' ', VECTOR_SUBMIT_URL: '', VECTOR_MARKETPLACE_INDEXER_URL: ' ' }).indexerUrl).toBeUndefined();
    expect(new URL(VECTOR_OGMIOS_URL).protocol).toBe('https:');
  });

  test('every setting is read: the gateway is an origin, the node is an https address, and the other three take http or https', () => {
    expect(endpointsFromEnv({
      IDENTITY_GATEWAY_URL: 'https://gateway.example.test', VECTOR_OGMIOS_URL: 'https://127.0.0.1:1337', VECTOR_KOIOS_URL: 'http://koios.example.test/', VECTOR_SUBMIT_URL: 'https://submit.example.test/api/submit/tx',
      VECTOR_MARKETPLACE_INDEXER_URL: ' https://indexer.example.test/ ',
    })).toStrictEqual({
      gatewayUrl: 'https://gateway.example.test', ogmiosUrl: 'https://127.0.0.1:1337', koiosUrl: 'http://koios.example.test/', submitUrl: 'https://submit.example.test/api/submit/tx', indexerUrl: 'https://indexer.example.test/',
    });
  });

  test('an address of the node with the scheme http is refused by name, with its https twin accepted: the tip reader of the janitor takes https only', () => {
    for (const http of ['http://node.example.test:1337', 'http://127.0.0.1', 'HTTP://node.example.test']) {
      expect(() => endpointsFromEnv({ VECTOR_OGMIOS_URL: http }), http).toThrow(OGMIOS_HTTPS);
      expect(endpointsFromEnv({ VECTOR_OGMIOS_URL: http.replace(/^http:/i, 'https:') }).ogmiosUrl.startsWith('https://')).toBe(true);
    }
  });

  test('an origin has a host and a port and nothing after them', () => {
    expect(httpsOriginOf('X', 'https://host.example:8443')).toStrictEqual({ origin: 'https://host.example:8443', host: 'host.example:8443' });
    for (const wrong of ['https://host.example/path', 'https://host.example?q=1', 'https://host.example#top', 'https://user@host.example', 'https://host.example//', 'http://host.example']) {
      expect(message(() => httpsOriginOf('MOCK_PUBLIC_BASE', wrong)), wrong).toMatch(originRule('MOCK_PUBLIC_BASE'));
    }
  });

  test('the two bases of the mock service are origins, and the settings come out as the origins', () => {
    expect(mockBasesOf(FULL_ENV)).toStrictEqual({ publicBase: 'https://mock.example.test', mtlsBase: 'https://mock-mtls.example.test' });
    expect(mockBasesOf(envWith({ MOCK_PUBLIC_BASE: ' https://mock.example.test:8443 ' })).publicBase).toBe('https://mock.example.test:8443');
  });
});

describe('VECTOR_MODULE1_MANIFEST is an https URL pinned to a commit', () => {
  const PINNED = `https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/${MODULE1_COMMIT}/Module-1/deploy/identity/mainnet/manifest.json`;
  const manifestAt = (value: string): string => message(() => module1SourceOf(envWith({ VECTOR_MODULE1_MANIFEST: value })));

  test('the address of a raw file at a commit is accepted as it stands: the commit is one whole segment of the path, wherever it is, and a port is allowed', () => {
    for (const url of [PINNED, MODULE1_URL, `https://raw.example.test:8443/${MODULE1_COMMIT}`, `https://raw.example.test/a/b/${MODULE1_COMMIT}/c/manifest.json`, `https://raw.example.test/${MODULE1_COMMIT}/`]) {
      expect(module1SourceOf(envWith({ VECTOR_MODULE1_MANIFEST: url })), url).toBe(url);
    }
    expect(module1SourceOf(envWith({ VECTOR_MODULE1_MANIFEST: ` ${PINNED}\n` }))).toBe(PINNED);
  });

  test('a file path, a relative path, an http address, a text that is no address, and an address with a user, a query or a fragment are refused by name', () => {
    for (const value of [
      '/etc/insurer/module1.json', 'module1.json', './module1.json', 'file:///etc/insurer/module1.json', `http://raw.example.test/${MODULE1_COMMIT}/manifest.json`, `HTTPS://raw.example.test/${MODULE1_COMMIT}/manifest.json`,
      'https://', 'not an address', `https://someone:a-password@raw.example.test/${MODULE1_COMMIT}/manifest.json`, `https://someone@raw.example.test/${MODULE1_COMMIT}/manifest.json`,
      `https://raw.example.test/${MODULE1_COMMIT}/manifest.json?ref=main`, `https://raw.example.test/${MODULE1_COMMIT}/manifest.json#top`, `https://raw.example.test/${MODULE1_COMMIT}/manifest.json?`,
    ]) {
      expect(manifestAt(value), value).toMatch(MODULE1_FORM);
    }
  });

  test('an address that names no commit is refused as unpinned: a branch, a tag, a commit that is too short or too long, in capitals, in a longer segment, in the host, or removed by a dot segment', () => {
    for (const value of [
      'https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/main/Module-1/deploy/identity/mainnet/manifest.json', 'https://raw.example.test/refs/tags/v1.0.0/manifest.json',
      `https://raw.example.test/${MODULE1_COMMIT.slice(1)}/manifest.json`, `https://raw.example.test/${MODULE1_COMMIT}0/manifest.json`, `https://raw.example.test/${MODULE1_COMMIT.toUpperCase()}/manifest.json`,
      `https://raw.example.test/x${MODULE1_COMMIT}/manifest.json`, `https://raw.example.test/${MODULE1_COMMIT}.json`, `https://${MODULE1_COMMIT}.example.test/manifest.json`, 'https://raw.example.test/manifest.json',
      `https://raw.example.test/${MODULE1_COMMIT.slice(0, 20)}/${MODULE1_COMMIT.slice(20)}/manifest.json`, `https://raw.example.test/%61${MODULE1_COMMIT.slice(1)}/manifest.json`,
      `https://raw.example.test/${MODULE1_COMMIT}/../main/manifest.json`,
    ]) {
      expect(manifestAt(value), value).toMatch(MODULE1_PIN);
    }
  });

  test('the message names the setting and the length of the value and shows nothing else of it: not a user, a password, a key in a query, or a host', () => {
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

describe('the limits of the model hire and the settings of the dispute code', () => {
  test('the limits come out as the kit takes them: the models, the price ceiling and each bond limit as bigints', () => {
    expect(limitsOf(FULL_ENV)).toStrictEqual({ allowlist: ['deepseek/deepseek-v4-flash'], maxPriceLovelace: 1_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(typeof limitsOf(FULL_ENV).maxSupplierBondLovelace).toBe('bigint');
    expect(typeof limitsOf(FULL_ENV).maxBuyerBondLovelace).toBe('bigint');
    expect(modelOf(envWith({ LLM_MODEL_ALLOWLIST: 'a/one, b/two', LLM_MAX_PRICE_LOVELACE: '250000' }))).toStrictEqual({ allowlist: ['a/one', 'b/two'], maxPriceLovelace: 250_000n });
    expect(limitsOf(envWith({ LLM_MAX_SUPPLIER_BOND_LOVELACE: ' 1000000 ', LLM_MAX_BUYER_BOND_LOVELACE: '0001' })))
      .toMatchObject({ maxSupplierBondLovelace: 1_000_000n, maxBuyerBondLovelace: 1n });
  });

  test('no limit has a default: a limit that is not set, or blank, stops the start by its name', () => {
    for (const name of ['LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE', 'LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE']) {
      for (const empty of [undefined, '', '   ']) {
        expect(message(() => limitsOf(envWith({ [name]: empty }))), `${name} = ${JSON.stringify(empty)}`).toMatch(required(name));
      }
    }
    for (const name of ['DISPUTE_CHALLENGE_STAKE_LOVELACE', 'DISPUTE_MIN_WINDOW_LEFT_MS', 'DISPUTE_READ_TIMEOUT_MS']) {
      for (const empty of [undefined, '', '   ']) expect(message(() => disputeOf(envWith({ [name]: empty }))), `${name} = ${JSON.stringify(empty)}`).toMatch(required(name));
    }
  });

  test('the dispute settings come out as the kit takes them, and the lease and the deadline are optional', () => {
    expect(disputeOf(FULL_ENV)).toStrictEqual({ challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 600_000, read_timeout_ms: 20_000 });
    expect(disputeOf(envWith({ DISPUTE_STARTED_LEASE_MS: '1200000', DISPUTE_RESOLUTION_DEADLINE_MS: '259200000' }))).toStrictEqual({
      challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 600_000, read_timeout_ms: 20_000, started_lease_ms: 1_200_000, resolution_deadline_ms: 259_200_000,
    });
    expect(disputeOf(envWith({ DISPUTE_STARTED_LEASE_MS: ' ', DISPUTE_RESOLUTION_DEADLINE_MS: '' }))).toStrictEqual(disputeOf(FULL_ENV));
  });
});
