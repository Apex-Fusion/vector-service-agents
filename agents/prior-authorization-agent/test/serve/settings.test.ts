// agents/prior-authorization-agent/test/serve/settings.test.ts
// The settings of the Prior Authorization Agent that name no key. Each reader refuses a value that is missing or wrong, names the setting, and never shows the value: a wrong value gives its length only. Each
// refusal has an accepted twin, the same setting with a value that the rule takes. The three DIDs are three agents. The fault switch takes the empty text and the one value of this agent. A limit has no default.
// No test here starts a service or uses the network.
import { describe, expect, test } from 'vitest';
import { MAX_ESCROW_LOVELACE, VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from '@vsa/buyer-core';
import { LEAST_RESOLUTION_DEADLINE_MS } from '@vsa/usecase-kit/dispute';
import { AGENT_KINDS, FAULT_MODES } from '@vsa/usecase-kit/protocol';
import { REGISTRY_POLICY, legacyVectorDid } from '@vsa/vector-read';
import {
  BUYER_BOND_LOVELACE, GATEWAY_DEFAULT, HOST_DEFAULT, JOB_DEADLINE_MS, MAX_PROCESSING_WINDOW_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, PRICE_DEFAULT_LOVELACE, STATE_DIR_DEFAULT, SUPPLIER_BOND_LOVELACE,
  MAX_PRICE_LOVELACE, agentDidOf,
  cosignSettingsOf, disputeOf, drafterDidOf, endpointsFromEnv, faultOf, handoffLimitsOf, hostOf, httpsOriginOf, limitsOf, mockBasesOf, modelOf, module1SourceOf, portOf, priceOf, processingWindowOf,
  recordReaderDidOf, stateDirOf, supplierKeyOf,
} from '../../src/serve/settings.ts';
import { AGENT_DID, DRAFTER_DID, KEY_NUMBERS, MODULE1_COMMIT, MODULE1_URL, PRINCIPAL, READER_DID, SUPPLIER, completeEnv, messageOf, rawKey, shows } from './support.ts';
import { testKey } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';

/** A value that no setting takes. A message must name the setting and never show it. */
const MARKER = 'zq9-marker-value-7f3';
const ID_OF = (did: string): string => did.slice('did:vector:'.length);
const FOURTH_DID = `did:vector:${'d4'.repeat(32)}`;

type Reader = (env: NodeJS.ProcessEnv) => unknown;
/**
 * One refusal of the start: the setting, the function that reads it, the value that is refused (undefined: not set), the start of the message, the same setting with a value that is accepted (the twin), and a
 * value that breaks the same rule and that no message could show by chance (the marker with a space and a mark, unless the row gives another).
 */
type Row = readonly [setting: string, read: Reader, bad: string | undefined, refusal: RegExp, good: string | undefined, probe?: string];

const required = (name: string): RegExp => new RegExp(`^environment variable ${name} is required \\(.+\\) and is not set$`);
const didRule = (name: string): RegExp => new RegExp(`^environment variable ${name} must be did:vector: and 64 lowercase hex characters, and it has \\d+ characters$`);
const sameAgent = (name: string, other: string): RegExp => new RegExp(`^environment variable ${name} names the same agent as ${other}: the agent and its two subagents are three agents$`);
const originRule = (name: string): RegExp => new RegExp(`^environment variable ${name} must be an https origin with no user, path, query or fragment, and it has \\d+ characters$`);
const addressForm = (name: string): RegExp => new RegExp(`^environment variable ${name} must be an http or https address, and it has \\d+ characters$`);
const addressUser = (name: string): RegExp => new RegExp(`^environment variable ${name} must be an http or https address with no user and no password, and it has \\d+ characters$`);
const lovelaceRule = (name: string): RegExp => new RegExp(`^environment variable ${name} must be a whole number of lovelace of more than 0, written in digits, and it has \\d+ characters$`);
const digitsRule = (name: string): RegExp => new RegExp(`^environment variable ${name} must be a non-negative whole number written in digits, and it has \\d+ characters$`);
const millisecondsRule = (name: string, least: number): RegExp => new RegExp(`^environment variable ${name} must be a whole number of milliseconds of at least ${least}, and it has \\d+ characters$`);
const cosignRule = (detail: string): RegExp => new RegExp(`^the settings of the co-sign route are refused: ${detail}$`);

const FAULT_REFUSAL = /^environment variable FAULT_MODE must be empty or "alter_after_approval" for prior-authorization-agent, and it has \d+ characters$/;
const NOT_THE_KEY = /^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH: the key hash of the one is not the other\. Both are published, so they must come from the same key pair, and the public key line must not hold a private key$/;
const WINDOW_RULE = /^environment variable ADVERT_MAX_PROCESSING_MS must be at least 1800000 \(the window of 30 min that the deadline of a job, 1620000 ms, assumes\)$/;
const WINDOW_MAX_RULE = /^environment variable ADVERT_MAX_PROCESSING_MS must be at most 86400000 \(24 h, the longest window that a Post accepts\)$/;
const PRICE_CAP = /^environment variable ADVERT_PRICE_LOVELACE must be at most 9998000000 \(with both bonds, the lock of an escrow stays inside its value cap of 10000000000 lovelace\)$/;
const LLM_CAP = /^environment variable LLM_MAX_PRICE_LOVELACE, LLM_MAX_SUPPLIER_BOND_LOVELACE and LLM_MAX_BUYER_BOND_LOVELACE must add up to at most 10000000000 lovelace \(the price and both bonds of a hire make the lock of an escrow, and a Post refuses a lock above its value cap\)$/;
const HANDOFF_CAP = /^environment variable HANDOFF_MAX_PRICE_LOVELACE, HANDOFF_MAX_SUPPLIER_BOND_LOVELACE and HANDOFF_MAX_BUYER_BOND_LOVELACE must add up to at most 10000000000 lovelace \(the price and both bonds of a hire make the lock of an escrow, and a Post refuses a lock above its value cap\)$/;
const SAME_HOST = /^environment variable MOCK_MTLS_BASE must name another host than MOCK_PUBLIC_BASE: the mock service tells the two hosts apart by the Host header$/;
const OGMIOS_HTTPS = /^environment variable VECTOR_OGMIOS_URL must be an https address: the tip reader of the janitor takes https only, and it has \d+ characters$/;
const MODULE1_FORM = /^environment variable VECTOR_MODULE1_MANIFEST must be an https URL with no user, query or fragment, and it has \d+ characters$/;
const MODULE1_PIN = /^environment variable VECTOR_MODULE1_MANIFEST must be pinned to a commit: one segment of its path must be the 40 lowercase hex characters of the commit, .* It has \d+ characters$/;
const MODEL_NAME = /^environment variable LLM_MODEL_ALLOWLIST entry 1 must be a model name \(letters, digits, dots, underscores, colons, slashes and hyphens\)$/;
const NO_MODEL = /^environment variable LLM_MODEL_ALLOWLIST must name at least one model, as a comma-separated list$/;
const LLM_PRICE = /^environment variable LLM_MAX_PRICE_LOVELACE must be a whole number of lovelace of at least 0, written in digits$/;
const LLM_PRICE_ZERO = /^environment variable LLM_MAX_PRICE_LOVELACE must be a whole number of lovelace of more than 0$/;
const ALLOWLIST_ENTRY = cosignRule('the allowlist has an entry on line 1 that is not a key hash \\(56 lower-case hex characters\\)\\. The setting is COSIGN_ALLOWLIST');

const ROWS: readonly Row[] = [
  ['AGENT_DID', agentDidOf, undefined, required('AGENT_DID'), FOURTH_DID],
  ['AGENT_DID', agentDidOf, 'did:vector:xyz', /^environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters, and it has 14 characters$/, FOURTH_DID],
  ['AGENT_DID', agentDidOf, 'someone', /^environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters, and it has 7 characters$/, FOURTH_DID],
  ['AGENT_DID', agentDidOf, `did:vector:${'zz'.repeat(32)}`, /^environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters, and it has 75 characters$/, FOURTH_DID],
  ['AGENT_DID', agentDidOf, `did:vector:${'A1'.repeat(32)}`, didRule('AGENT_DID'), FOURTH_DID],
  ['RECORD_READER_DID', recordReaderDidOf, undefined, required('RECORD_READER_DID'), FOURTH_DID],
  ['RECORD_READER_DID', recordReaderDidOf, 'did:vector:xyz', didRule('RECORD_READER_DID'), FOURTH_DID],
  ['RECORD_READER_DID', recordReaderDidOf, AGENT_DID, sameAgent('RECORD_READER_DID', 'AGENT_DID'), FOURTH_DID],
  ['RECORD_READER_DID', recordReaderDidOf, legacyVectorDid(REGISTRY_POLICY, ID_OF(AGENT_DID)), sameAgent('RECORD_READER_DID', 'AGENT_DID'), legacyVectorDid(REGISTRY_POLICY, ID_OF(FOURTH_DID))],
  ['DRAFTER_DID', drafterDidOf, undefined, required('DRAFTER_DID'), FOURTH_DID],
  ['DRAFTER_DID', drafterDidOf, 'someone', didRule('DRAFTER_DID'), FOURTH_DID],
  ['DRAFTER_DID', drafterDidOf, AGENT_DID, sameAgent('DRAFTER_DID', 'AGENT_DID'), FOURTH_DID],
  ['DRAFTER_DID', drafterDidOf, READER_DID, sameAgent('DRAFTER_DID', 'RECORD_READER_DID'), FOURTH_DID],
  ['DRAFTER_DID', drafterDidOf, legacyVectorDid(REGISTRY_POLICY, ID_OF(READER_DID)), sameAgent('DRAFTER_DID', 'RECORD_READER_DID'), legacyVectorDid(REGISTRY_POLICY, ID_OF(FOURTH_DID))],
  ['FAULT_MODE', faultOf, 'confirm_wrong_lot', FAULT_REFUSAL, 'alter_after_approval'],
  ['FAULT_MODE', faultOf, 'invert_scores', FAULT_REFUSAL, ''],
  ['FAULT_MODE', faultOf, 'quote_off_price_list', FAULT_REFUSAL, undefined],
  ['FAULT_MODE', faultOf, 'yes', FAULT_REFUSAL, ''],
  ['PORT', portOf, '70000', /^environment variable PORT must be a port from 0 to 65535, and it has 5 characters$/, '0', '7123456'],
  ['PORT', portOf, 'abc', digitsRule('PORT'), '9103'],
  ['PORT', portOf, '-1', digitsRule('PORT'), '9103'],
  ['HOST', hostOf, 'bad host!', /^environment variable HOST must be an address or a host name, and it has 9 characters$/, '127.0.0.1'],
  ['PRIORAUTH_STATE_DIR', stateDirOf, 'relative/state', /^environment variable PRIORAUTH_STATE_DIR must be an absolute path, and it has 14 characters$/, '/var/state'],
  ['PRIORAUTH_STATE_DIR', stateDirOf, './state', /^environment variable PRIORAUTH_STATE_DIR must be an absolute path, and it has 7 characters$/, '/data'],
  ['ADVERT_MAX_PROCESSING_MS', processingWindowOf, '1799999', WINDOW_RULE, '1800000', '1799731'],
  ['ADVERT_MAX_PROCESSING_MS', processingWindowOf, '86400001', WINDOW_MAX_RULE, '86400000', '86400731'],
  ['ADVERT_MAX_PROCESSING_MS', processingWindowOf, 'long', digitsRule('ADVERT_MAX_PROCESSING_MS'), '2400000'],
  ['ADVERT_MAX_PROCESSING_MS', processingWindowOf, '1.8e6', digitsRule('ADVERT_MAX_PROCESSING_MS'), '1800000'],
  ['ADVERT_MAX_PROCESSING_MS', processingWindowOf, '99999999999999999999', digitsRule('ADVERT_MAX_PROCESSING_MS'), '86400000'],
  ['ADVERT_PRICE_LOVELACE', priceOf, '0', lovelaceRule('ADVERT_PRICE_LOVELACE'), '1'],
  ['ADVERT_PRICE_LOVELACE', priceOf, '1.5', lovelaceRule('ADVERT_PRICE_LOVELACE'), '3000000', '2.7731'],
  ['ADVERT_PRICE_LOVELACE', priceOf, 'free', lovelaceRule('ADVERT_PRICE_LOVELACE'), '3000000'],
  ['ADVERT_PRICE_LOVELACE', priceOf, '9998000001', PRICE_CAP, '9998000000', '9998000731'],
  ['ADVERT_PRICE_LOVELACE', priceOf, '10000000731', PRICE_CAP, '9998000000'],
  ['ADVERT_PRICE_LOVELACE', priceOf, '9007199254740993', lovelaceRule('ADVERT_PRICE_LOVELACE'), '9998000000'],
  ['SUPPLIER_PKH', supplierKeyOf, undefined, required('SUPPLIER_PKH'), SUPPLIER.keyHash],
  ['SUPPLIER_PKH', supplierKeyOf, 'ab', /^environment variable SUPPLIER_PKH must be 56 hex characters, and it has 2 characters$/, SUPPLIER.keyHash],
  ['SUPPLIER_PKH', supplierKeyOf, 'ab'.repeat(27), /^environment variable SUPPLIER_PKH must be 56 hex characters, and it has 54 characters$/, SUPPLIER.keyHash],
  ['SUPPLIER_PKH', supplierKeyOf, 'zz'.repeat(28), /^environment variable SUPPLIER_PKH must be 56 hex characters, and some of its 56 characters are not hex$/, SUPPLIER.keyHash],
  ['SUPPLIER_PKH', supplierKeyOf, 'ab'.repeat(28), NOT_THE_KEY, SUPPLIER.keyHash],
  ['SUPPLIER_PUB_KEY_HEX', supplierKeyOf, undefined, required('SUPPLIER_PUB_KEY_HEX'), SUPPLIER.publicKey],
  ['SUPPLIER_PUB_KEY_HEX', supplierKeyOf, 'ab', /^environment variable SUPPLIER_PUB_KEY_HEX must be 64 hex characters, and it has 2 characters$/, SUPPLIER.publicKey],
  ['SUPPLIER_PUB_KEY_HEX', supplierKeyOf, testKey(KEY_NUMBERS.service).publicKey, NOT_THE_KEY, SUPPLIER.publicKey],
  ['SUPPLIER_PUB_KEY_HEX', supplierKeyOf, rawKey(KEY_NUMBERS.service), NOT_THE_KEY, SUPPLIER.publicKey],
  ['MOCK_PUBLIC_BASE', mockBasesOf, undefined, required('MOCK_PUBLIC_BASE'), 'https://mock.example.test'],
  ['MOCK_PUBLIC_BASE', mockBasesOf, 'http://mock.example.test', originRule('MOCK_PUBLIC_BASE'), 'https://mock.example.test'],
  ['MOCK_PUBLIC_BASE', mockBasesOf, 'https://user@mock.example.test', originRule('MOCK_PUBLIC_BASE'), 'https://mock.example.test'],
  ['MOCK_PUBLIC_BASE', mockBasesOf, 'mock.example', /^environment variable MOCK_PUBLIC_BASE must be an https origin such as https:\/\/host\.example, and it has 12 characters$/, 'https://mock.example.test'],
  ['MOCK_PUBLIC_BASE', mockBasesOf, 'https://mock-mtls.example', SAME_HOST, 'https://mock.example.test'],
  ['MOCK_MTLS_BASE', mockBasesOf, undefined, required('MOCK_MTLS_BASE'), 'https://mock-mtls.example.test'],
  ['MOCK_MTLS_BASE', mockBasesOf, 'https://mock-mtls.example.test/x', originRule('MOCK_MTLS_BASE'), 'https://mock-mtls.example.test'],
  ['MOCK_MTLS_BASE', mockBasesOf, 'https://mock.example', SAME_HOST, 'https://mock-mtls.example.test'],
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
  ['VECTOR_MODULE1_MANIFEST', module1SourceOf, '/etc/priorauth/module1.json', MODULE1_FORM, MODULE1_URL],
  ['VECTOR_MODULE1_MANIFEST', module1SourceOf, `http://raw.example.test/${MODULE1_COMMIT}/manifest.json`, MODULE1_FORM, MODULE1_URL],
  ['VECTOR_MODULE1_MANIFEST', module1SourceOf, 'https://raw.example.test/Apex-Fusion/modules/main/manifest.json', MODULE1_PIN, MODULE1_URL],
  ['LLM_MODEL_ALLOWLIST', limitsOf, undefined, required('LLM_MODEL_ALLOWLIST'), 'a/one, b/two'],
  ['LLM_MODEL_ALLOWLIST', limitsOf, 'deepseek/deepseek-v4-flash free', MODEL_NAME, 'deepseek/deepseek-v4-flash:free'],
  ['LLM_MODEL_ALLOWLIST', limitsOf, ' , ', NO_MODEL, 'a/one'],
  ['LLM_MAX_PRICE_LOVELACE', limitsOf, undefined, required('LLM_MAX_PRICE_LOVELACE'), '250000'],
  ['LLM_MAX_PRICE_LOVELACE', limitsOf, '1.5', LLM_PRICE, '250000'],
  ['LLM_MAX_PRICE_LOVELACE', limitsOf, '0', LLM_PRICE_ZERO, '1'],
  ['LLM_MAX_PRICE_LOVELACE', limitsOf, '9996000001', LLM_CAP, '9996000000', '9996000731'],
  ['LLM_MAX_SUPPLIER_BOND_LOVELACE', limitsOf, undefined, required('LLM_MAX_SUPPLIER_BOND_LOVELACE'), '1000000'],
  ['LLM_MAX_SUPPLIER_BOND_LOVELACE', limitsOf, '0', lovelaceRule('LLM_MAX_SUPPLIER_BOND_LOVELACE'), '1000000'],
  ['LLM_MAX_SUPPLIER_BOND_LOVELACE', limitsOf, '1.5', lovelaceRule('LLM_MAX_SUPPLIER_BOND_LOVELACE'), '15', '2.7731'],
  ['LLM_MAX_SUPPLIER_BOND_LOVELACE', limitsOf, '-1', lovelaceRule('LLM_MAX_SUPPLIER_BOND_LOVELACE'), '0001'],
  ['LLM_MAX_SUPPLIER_BOND_LOVELACE', limitsOf, '9997000001', LLM_CAP, '9997000000', '9997000731'],
  ['LLM_MAX_BUYER_BOND_LOVELACE', limitsOf, '  ', required('LLM_MAX_BUYER_BOND_LOVELACE'), '1000000'],
  ['LLM_MAX_BUYER_BOND_LOVELACE', limitsOf, 'none', lovelaceRule('LLM_MAX_BUYER_BOND_LOVELACE'), '1000000'],
  ['LLM_MAX_BUYER_BOND_LOVELACE', limitsOf, '1e6', lovelaceRule('LLM_MAX_BUYER_BOND_LOVELACE'), '1000000'],
  ['LLM_MAX_BUYER_BOND_LOVELACE', limitsOf, '9997000001', LLM_CAP, '9997000000', '9997000731'],
  ...['HANDOFF_MAX_PRICE_LOVELACE', 'HANDOFF_MAX_SUPPLIER_BOND_LOVELACE', 'HANDOFF_MAX_BUYER_BOND_LOVELACE'].flatMap((name): readonly Row[] => [
    [name, handoffLimitsOf, undefined, required(name), '5000000'],
    [name, handoffLimitsOf, '  ', required(name), '5000000'],
    [name, handoffLimitsOf, '0', lovelaceRule(name), '5000000'],
    [name, handoffLimitsOf, '1.5', lovelaceRule(name), '5000000', '2.7731'],
    [name, handoffLimitsOf, 'none', lovelaceRule(name), '5000000'],
    [name, handoffLimitsOf, '-2000000', lovelaceRule(name), '5000000'],
    [name, handoffLimitsOf, '9007199254740993', lovelaceRule(name), '9996000000'],
    [name, handoffLimitsOf, '9996000001', HANDOFF_CAP, '9996000000', '9996000731'],
  ]),
  ['DISPUTE_CHALLENGE_STAKE_LOVELACE', disputeOf, undefined, required('DISPUTE_CHALLENGE_STAKE_LOVELACE'), '50000000'],
  ['DISPUTE_CHALLENGE_STAKE_LOVELACE', disputeOf, '0', lovelaceRule('DISPUTE_CHALLENGE_STAKE_LOVELACE'), '50000000'],
  ['DISPUTE_CHALLENGE_STAKE_LOVELACE', disputeOf, '9007199254740993', lovelaceRule('DISPUTE_CHALLENGE_STAKE_LOVELACE'), '9007199254740991'],
  ['DISPUTE_MIN_WINDOW_LEFT_MS', disputeOf, undefined, required('DISPUTE_MIN_WINDOW_LEFT_MS'), '2000'],
  ['DISPUTE_MIN_WINDOW_LEFT_MS', disputeOf, '1999', millisecondsRule('DISPUTE_MIN_WINDOW_LEFT_MS', 2_000), '2000', '1731'],
  ['DISPUTE_MIN_WINDOW_LEFT_MS', disputeOf, 'soon', digitsRule('DISPUTE_MIN_WINDOW_LEFT_MS'), '2000'],
  ['DISPUTE_READ_TIMEOUT_MS', disputeOf, undefined, required('DISPUTE_READ_TIMEOUT_MS'), '20000'],
  ['DISPUTE_READ_TIMEOUT_MS', disputeOf, '0', millisecondsRule('DISPUTE_READ_TIMEOUT_MS', 1), '1'],
  ['DISPUTE_READ_TIMEOUT_MS', disputeOf, 'later', digitsRule('DISPUTE_READ_TIMEOUT_MS'), '20000'],
  ['DISPUTE_STARTED_LEASE_MS', disputeOf, '39999', millisecondsRule('DISPUTE_STARTED_LEASE_MS', 40_000), '40000', '31731'],
  ['DISPUTE_STARTED_LEASE_MS', disputeOf, 'long', digitsRule('DISPUTE_STARTED_LEASE_MS'), ''],
  ['DISPUTE_RESOLUTION_DEADLINE_MS', disputeOf, '1000', millisecondsRule('DISPUTE_RESOLUTION_DEADLINE_MS', LEAST_RESOLUTION_DEADLINE_MS), '259200000', '1731'],
  ['DISPUTE_RESOLUTION_DEADLINE_MS', disputeOf, 'never', digitsRule('DISPUTE_RESOLUTION_DEADLINE_MS'), ''],
  ['COSIGN_ALLOWLIST', cosignSettingsOf, undefined, cosignRule('COSIGN_ALLOWLIST is not set'), ''],
  ['COSIGN_ALLOWLIST', cosignSettingsOf, `${PRINCIPAL.keyHash}, ${testKey(41).keyHash.slice(1)}`, ALLOWLIST_ENTRY, `${PRINCIPAL.keyHash}, ${testKey(41).keyHash}`],
  ['COSIGN_ALLOWLIST', cosignSettingsOf, PRINCIPAL.keyHash.toUpperCase(), ALLOWLIST_ENTRY, PRINCIPAL.keyHash],
  ['COSIGN_MAX_CONCURRENT', cosignSettingsOf, '65', cosignRule('COSIGN_MAX_CONCURRENT must be a whole number from 1 to 64'), '64'],
  ['COSIGN_MAX_CONCURRENT', cosignSettingsOf, '0', cosignRule('COSIGN_MAX_CONCURRENT must be a whole number from 1 to 64'), '1'],
  ['COSIGN_MAX_CONCURRENT', cosignSettingsOf, 'many', cosignRule('COSIGN_MAX_CONCURRENT must be whole decimal digits'), '2'],
  ['COSIGN_MAX_FUTURE_MS', cosignSettingsOf, '59999', cosignRule('COSIGN_MAX_FUTURE_MS must be a whole number from 60000 to 3600000'), '60000'],
  ['COSIGN_MAX_FUTURE_MS', cosignSettingsOf, '3600001', cosignRule('COSIGN_MAX_FUTURE_MS must be a whole number from 60000 to 3600000'), '3600000'],
  ['COSIGN_MAX_FUTURE_MS', cosignSettingsOf, '1h', cosignRule('COSIGN_MAX_FUTURE_MS must be whole decimal digits'), ''],
  ['COSIGN_LEDGER_TIMEOUT_MS', cosignSettingsOf, '49', cosignRule('COSIGN_LEDGER_TIMEOUT_MS must be a whole number from 50 to 30000'), '50'],
  ['COSIGN_LEDGER_TIMEOUT_MS', cosignSettingsOf, '30001', cosignRule('COSIGN_LEDGER_TIMEOUT_MS must be a whole number from 50 to 30000'), '30000'],
  ['COSIGN_LEDGER_TIMEOUT_MS', cosignSettingsOf, 'slow', cosignRule('COSIGN_LEDGER_TIMEOUT_MS must be whole decimal digits'), ''],
];

const TABLE = ROWS.map(([setting, read, bad, refusal, good, probe]) => ({ setting, read, bad, refusal, good, probe }));

describe('every refusal of the start, with its accepted twin', () => {
  test.each(TABLE)('$setting = $bad is refused by its name, the message shows no value, and $good is accepted', ({ setting, read, bad, refusal, good, probe }) => {
    const text = messageOf(() => read(completeEnv({ [setting]: bad })));
    expect(text).toMatch(refusal);
    expect(text).toContain(setting);
    if (bad !== undefined) expect(shows(text, bad), 'the message shows the value').toBe(false);
    expect(() => read(completeEnv({ [setting]: good })), `${setting} = ${String(good)}`).not.toThrow();
    if (bad === undefined) return;
    // The same rule with a value that no message could show by chance.
    const odd = probe ?? `${MARKER} !`;
    const probed = messageOf(() => read(completeEnv({ [setting]: odd })));
    expect(probed).toContain(setting);
    expect(shows(probed, odd), `the message shows ${odd}`).toBe(false);
  });

  test('the complete environment is accepted by every reader, so a row above refuses one setting and nothing else', () => {
    for (const read of new Set(ROWS.map(([, reader]) => reader))) expect(() => read(completeEnv()), String(read.name)).not.toThrow();
  });

  test('a required setting has a row for the missing value, and a setting with a rule has a row for a value that breaks it', () => {
    const requiredSettings = [
      'AGENT_DID', 'RECORD_READER_DID', 'DRAFTER_DID', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'VECTOR_MODULE1_MANIFEST', 'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE',
      'LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE', 'HANDOFF_MAX_PRICE_LOVELACE', 'HANDOFF_MAX_SUPPLIER_BOND_LOVELACE', 'HANDOFF_MAX_BUYER_BOND_LOVELACE',
      'DISPUTE_CHALLENGE_STAKE_LOVELACE', 'DISPUTE_MIN_WINDOW_LEFT_MS', 'DISPUTE_READ_TIMEOUT_MS', 'COSIGN_ALLOWLIST',
    ];
    for (const name of requiredSettings) {
      expect(ROWS.some(([setting, , bad]) => setting === name && (bad === undefined || bad.trim() === '')), name).toBe(true);
    }
    const ruledSettings = [
      'FAULT_MODE', 'PORT', 'HOST', 'PRIORAUTH_STATE_DIR', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_PRICE_LOVELACE', 'IDENTITY_GATEWAY_URL', 'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL',
      'VECTOR_MARKETPLACE_INDEXER_URL', 'DISPUTE_STARTED_LEASE_MS', 'DISPUTE_RESOLUTION_DEADLINE_MS', 'COSIGN_MAX_CONCURRENT', 'COSIGN_MAX_FUTURE_MS', 'COSIGN_LEDGER_TIMEOUT_MS', ...requiredSettings,
    ];
    for (const name of ruledSettings) expect(ROWS.some(([setting, , bad]) => setting === name && bad !== undefined && bad.trim() !== ''), name).toBe(true);
  });
});

describe('the numbers of the service', () => {
  test('are those of the advert and of the job: port 9103, a deadline of 1,620 s, a window of 1,800 s that holds the timeout of the runtime, the price 3 and the two bonds 1', () => {
    expect([PORT_DEFAULT, HOST_DEFAULT, STATE_DIR_DEFAULT, GATEWAY_DEFAULT]).toStrictEqual([9103, '0.0.0.0', '/data', 'https://id.vector.apexfusion.org']);
    expect([JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS]).toStrictEqual([1_620_000, 1_800_000]);
    // The runtime waits 60 s longer than the job (SERVICE_TIMEOUT_MS is 1680000), and the window of the advert holds 120 s more than that.
    expect(MIN_PROCESSING_WINDOW_MS).toBe(JOB_DEADLINE_MS + 60_000 + 120_000);
    expect([PRICE_DEFAULT_LOVELACE, SUPPLIER_BOND_LOVELACE, BUYER_BOND_LOVELACE]).toStrictEqual([3_000_000, 1_000_000, 1_000_000]);
    // The escrow locks the price and both bonds: 5 units.
    expect(PRICE_DEFAULT_LOVELACE + SUPPLIER_BOND_LOVELACE + BUYER_BOND_LOVELACE).toBe(5_000_000);
    // A Post holds the lock of a buyer for the window of the advert, 24 hours at most, and it refuses a lock above the cap of an escrow, 10,000 units.
    expect([MAX_PROCESSING_WINDOW_MS, MAX_ESCROW_LOVELACE]).toStrictEqual([86_400_000, 10_000_000_000n]);
  });

  test('the window takes 1,800,000 ms to 86,400,000 ms, and the price takes 1 to the cap of an escrow less the two bonds', () => {
    for (const ms of [1_800_000, 86_400_000]) expect(processingWindowOf({ ADVERT_MAX_PROCESSING_MS: String(ms) })).toBe(ms);
    expect(MAX_PRICE_LOVELACE).toBe(Number(MAX_ESCROW_LOVELACE) - SUPPLIER_BOND_LOVELACE - BUYER_BOND_LOVELACE);
    expect(MAX_PRICE_LOVELACE).toBe(9_998_000_000);
    for (const price of [1, MAX_PRICE_LOVELACE]) expect(priceOf({ ADVERT_PRICE_LOVELACE: String(price) })).toBe(price);
  });

  test('are the defaults of the readers, and a blank setting is a setting that is not set', () => {
    expect([portOf({}), hostOf({}), stateDirOf({}), processingWindowOf({}), priceOf({})]).toStrictEqual([9103, '0.0.0.0', '/data', 1_800_000, 3_000_000]);
    expect([portOf({ PORT: '' }), hostOf({ HOST: ' ' }), stateDirOf({ PRIORAUTH_STATE_DIR: ' ' }), processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '' }), priceOf({ ADVERT_PRICE_LOVELACE: ' ' })])
      .toStrictEqual([9103, '0.0.0.0', '/data', 1_800_000, 3_000_000]);
    expect([portOf({ PORT: '9200' }), hostOf({ HOST: '127.0.0.1' }), stateDirOf({ PRIORAUTH_STATE_DIR: ' /var/state ' }), processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '2400000' }), priceOf({ ADVERT_PRICE_LOVELACE: '4000000' })])
      .toStrictEqual([9200, '127.0.0.1', '/var/state', 2_400_000, 4_000_000]);
  });
});

describe('the three DIDs', () => {
  test('are read in their canonical form: the agent, record-reader and drafter, three different agents', () => {
    expect([agentDidOf(completeEnv()), recordReaderDidOf(completeEnv()), drafterDidOf(completeEnv())]).toStrictEqual([AGENT_DID, READER_DID, DRAFTER_DID]);
    expect(new Set([AGENT_DID, READER_DID, DRAFTER_DID]).size).toBe(3);
    expect(agentDidOf(completeEnv({ AGENT_DID: ` ${AGENT_DID}\n` }))).toBe(AGENT_DID);
  });

  test('a DID in its legacy form is the canonical DID of the same identifier: it is read as that DID, and it is the same agent as that DID', () => {
    const legacy = legacyVectorDid(REGISTRY_POLICY, ID_OF(READER_DID));
    expect(recordReaderDidOf(completeEnv({ RECORD_READER_DID: legacy }))).toBe(READER_DID);
    expect(() => drafterDidOf(completeEnv({ RECORD_READER_DID: legacy, DRAFTER_DID: READER_DID }))).toThrow(/^environment variable DRAFTER_DID names the same agent as RECORD_READER_DID/);
  });

  test('a reader checks its DID against the DIDs that are set and are DIDs, and leaves a missing or a wrong one to the reader of that DID', () => {
    // The record-reader does not name the drafter, so it passes while the drafter is wrong or missing, and the drafter reader refuses by its own name.
    expect(recordReaderDidOf(completeEnv({ DRAFTER_DID: undefined }))).toBe(READER_DID);
    expect(recordReaderDidOf(completeEnv({ DRAFTER_DID: 'someone' }))).toBe(READER_DID);
    // With no DID for the agent, or a wrong one, the subagent DID is not compared with it.
    expect(recordReaderDidOf(completeEnv({ AGENT_DID: undefined }))).toBe(READER_DID);
    expect(drafterDidOf(completeEnv({ AGENT_DID: 'someone', RECORD_READER_DID: undefined }))).toBe(DRAFTER_DID);
    expect(messageOf(() => drafterDidOf(completeEnv({ AGENT_DID: DRAFTER_DID, RECORD_READER_DID: 'someone' })))).toMatch(sameAgent('DRAFTER_DID', 'AGENT_DID'));
  });
});

describe('the fault switch', () => {
  test('is empty or not set: both start, and the switch is the one of this kind', () => {
    for (const env of [{}, { FAULT_MODE: '' }, completeEnv()]) {
      const fault = faultOf(env);
      expect([fault.kind, fault.mode]).toStrictEqual(['prior-authorization-agent', '']);
    }
  });

  test('takes the one value of this agent, alter_after_approval, and the table of the kit lists no other', () => {
    const fault = faultOf(completeEnv({ FAULT_MODE: 'alter_after_approval' }));
    expect([fault.kind, fault.mode]).toStrictEqual(['prior-authorization-agent', 'alter_after_approval']);
    expect(FAULT_MODES['prior-authorization-agent']).toStrictEqual(['alter_after_approval']);
  });

  test('stops the start for every other value: the fault value of each other kind of agent, and each stray text, and the message is the rule and the length of the value', () => {
    const others = AGENT_KINDS.filter((kind) => kind !== 'prior-authorization-agent').flatMap((kind) => [...FAULT_MODES[kind]]);
    expect(others.length).toBeGreaterThan(0);
    for (const value of [...others, 'true', '1', 'on', ' ', 'none', MARKER, 'alter_after_approval ', ' alter_after_approval', 'ALTER_AFTER_APPROVAL', 'Alter_after_approval', 'alter_after_approval\n']) {
      // The table above leaves out the copies of the value of the rule: the message holds that value as part of the rule, so a search for the copy finds it. For them the whole message is checked: the rule and a length.
      expect(messageOf(() => faultOf({ FAULT_MODE: value })), JSON.stringify(value))
        .toBe(`environment variable FAULT_MODE must be empty or "alter_after_approval" for prior-authorization-agent, and it has ${value.length} characters`);
    }
  });
});

describe('the supplier key', () => {
  test('is a key hash and the public key of that hash, in any case, and the public values come out in lower case', () => {
    expect(supplierKeyOf(completeEnv())).toStrictEqual({ pkh: SUPPLIER.keyHash, pubKeyHex: SUPPLIER.publicKey });
    expect(supplierKeyOf(completeEnv({ SUPPLIER_PKH: ` ${SUPPLIER.keyHash.toUpperCase()}\n`, SUPPLIER_PUB_KEY_HEX: SUPPLIER.publicKey.toUpperCase() }))).toStrictEqual({ pkh: SUPPLIER.keyHash, pubKeyHex: SUPPLIER.publicKey });
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
      expect(messageOf(() => httpsOriginOf('MOCK_PUBLIC_BASE', wrong)), wrong).toMatch(originRule('MOCK_PUBLIC_BASE'));
    }
  });

  test('the two bases of the mock service are origins, and the settings come out as the origins', () => {
    expect(mockBasesOf(completeEnv())).toStrictEqual({ publicBase: 'https://mock.example', mtlsBase: 'https://mock-mtls.example' });
    expect(mockBasesOf(completeEnv({ MOCK_PUBLIC_BASE: ' https://mock.example.test:8443 ' })).publicBase).toBe('https://mock.example.test:8443');
  });
});

describe('VECTOR_MODULE1_MANIFEST is an https URL pinned to a commit', () => {
  const PINNED = `https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/${MODULE1_COMMIT}/Module-1/deploy/identity/mainnet/manifest.json`;
  const manifestAt = (value: string): string => messageOf(() => module1SourceOf(completeEnv({ VECTOR_MODULE1_MANIFEST: value })));

  test('the address of a raw file at a commit is accepted as it stands: the commit is one whole segment of the path, wherever it is, and a port is allowed', () => {
    for (const url of [PINNED, MODULE1_URL, `https://raw.example.test:8443/${MODULE1_COMMIT}`, `https://raw.example.test/a/b/${MODULE1_COMMIT}/c/manifest.json`, `https://raw.example.test/${MODULE1_COMMIT}/`]) {
      expect(module1SourceOf(completeEnv({ VECTOR_MODULE1_MANIFEST: url })), url).toBe(url);
    }
    expect(module1SourceOf(completeEnv({ VECTOR_MODULE1_MANIFEST: ` ${PINNED}\n` }))).toBe(PINNED);
  });

  test('a file path, a relative path, an http address, a text that is no address, and an address with a user, a query or a fragment are refused by name', () => {
    for (const value of [
      '/etc/priorauth/module1.json', 'module1.json', './module1.json', 'file:///etc/priorauth/module1.json', `http://raw.example.test/${MODULE1_COMMIT}/manifest.json`, `HTTPS://raw.example.test/${MODULE1_COMMIT}/manifest.json`,
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
      for (const part of [secret, secret.slice(1), 'someone', 'raw.example.test', MODULE1_COMMIT]) expect(text, `${part} in the message for ${value}`).not.toContain(part);
      expect(text).toContain(`${value.length} characters`);
    }
  });
});

describe('the limits of the model hire and of the hire of the Insurer Intake Agent', () => {
  test('the limits of the model hire come out as the kit takes them: the models, the price ceiling and each bond limit as bigints', () => {
    expect(limitsOf(completeEnv())).toStrictEqual({ allowlist: ['deepseek/deepseek-v4-flash'], maxPriceLovelace: 1_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(typeof limitsOf(completeEnv()).maxSupplierBondLovelace).toBe('bigint');
    expect(typeof limitsOf(completeEnv()).maxBuyerBondLovelace).toBe('bigint');
    expect(modelOf(completeEnv({ LLM_MODEL_ALLOWLIST: 'a/one, b/two', LLM_MAX_PRICE_LOVELACE: '250000' }))).toStrictEqual({ allowlist: ['a/one', 'b/two'], maxPriceLovelace: 250_000n });
    expect(limitsOf(completeEnv({ LLM_MAX_SUPPLIER_BOND_LOVELACE: ' 1000000 ', LLM_MAX_BUYER_BOND_LOVELACE: '0001' }))).toMatchObject({ maxSupplierBondLovelace: 1_000_000n, maxBuyerBondLovelace: 1n });
  });

  test('the three limits of the hire of the Insurer Intake Agent come out as bigints, and each can be a different number', () => {
    expect(handoffLimitsOf(completeEnv())).toStrictEqual({ maxPriceLovelace: 2_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(handoffLimitsOf(completeEnv({ HANDOFF_MAX_PRICE_LOVELACE: ' 3000000 ', HANDOFF_MAX_SUPPLIER_BOND_LOVELACE: '1', HANDOFF_MAX_BUYER_BOND_LOVELACE: '0002' })))
      .toStrictEqual({ maxPriceLovelace: 3_000_000n, maxSupplierBondLovelace: 1n, maxBuyerBondLovelace: 2n });
    expect(typeof handoffLimitsOf(completeEnv()).maxPriceLovelace).toBe('bigint');
  });

  test('no limit has a default: a limit that is not set, or blank, stops the start by its name, and no limit is null', () => {
    for (const name of ['LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE', 'LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE']) {
      for (const empty of [undefined, '', '   ']) expect(messageOf(() => limitsOf(completeEnv({ [name]: empty }))), `${name} = ${JSON.stringify(empty)}`).toMatch(required(name));
    }
    for (const name of ['HANDOFF_MAX_PRICE_LOVELACE', 'HANDOFF_MAX_SUPPLIER_BOND_LOVELACE', 'HANDOFF_MAX_BUYER_BOND_LOVELACE']) {
      for (const empty of [undefined, '', '   ']) expect(messageOf(() => handoffLimitsOf(completeEnv({ [name]: empty }))), `${name} = ${JSON.stringify(empty)}`).toMatch(required(name));
    }
    // With no setting at all, the first limit that is missing is named, and nothing is made.
    expect(messageOf(() => limitsOf({}))).toMatch(required('LLM_MODEL_ALLOWLIST'));
    expect(messageOf(() => handoffLimitsOf({}))).toMatch(required('HANDOFF_MAX_PRICE_LOVELACE'));
    for (const value of [...Object.values(limitsOf(completeEnv())), ...Object.values(handoffLimitsOf(completeEnv()))]) expect(value).not.toBeNull();
  });

  test('the price and the two bond limits of a hire add up to at most the value cap of an escrow, for both kinds of hire: a limit that takes the sum to the cap is taken, one more is refused, and three limits that are each below the cap but add up to more are refused', () => {
    const LLM = ['LLM_MAX_PRICE_LOVELACE', 'LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE'] as const;
    const HANDOFF = ['HANDOFF_MAX_PRICE_LOVELACE', 'HANDOFF_MAX_SUPPLIER_BOND_LOVELACE', 'HANDOFF_MAX_BUYER_BOND_LOVELACE'] as const;
    const limits = (names: readonly string[], values: readonly number[]): NodeJS.ProcessEnv => completeEnv(Object.fromEntries(names.map((name, index) => [name, String(values[index])])));
    const capMessage = (names: readonly string[]): string =>
      `environment variable ${names[0]}, ${names[1]} and ${names[2]} must add up to at most ${MAX_ESCROW_LOVELACE} lovelace (the price and both bonds of a hire make the lock of an escrow, and a Post refuses a lock above its value cap)`;
    for (const [read, names] of [[limitsOf, LLM], [handoffLimitsOf, HANDOFF]] as const) {
      for (const big of [0, 1, 2]) {
        const at = [1, 1, 1].map((one, index) => (index === big ? 9_999_999_998 : one));
        const over = [1, 1, 1].map((one, index) => (index === big ? 9_999_999_999 : one));
        expect(() => read(limits(names, at)), `${names[big]} takes the sum to the cap`).not.toThrow();
        expect(messageOf(() => read(limits(names, over))), `${names[big]} takes the sum above the cap`).toBe(capMessage(names));
      }
      expect(messageOf(() => read(limits(names, [4_000_000_000, 4_000_000_000, 4_000_000_000]))), names[0]).toBe(capMessage(names));
      expect(() => read(limits(names, [8_000_000_000, 1_000_000_000, 1_000_000_000])), names[0]).not.toThrow();
    }
  });
});

describe('the settings of the dispute code', () => {
  test('come out as the kit takes them, and the lease and the deadline are optional', () => {
    expect(disputeOf(completeEnv())).toStrictEqual({ challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 600_000, read_timeout_ms: 20_000 });
    expect(disputeOf(completeEnv({ DISPUTE_STARTED_LEASE_MS: '1200000', DISPUTE_RESOLUTION_DEADLINE_MS: '259200000' }))).toStrictEqual({
      challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 600_000, read_timeout_ms: 20_000, started_lease_ms: 1_200_000, resolution_deadline_ms: 259_200_000,
    });
    expect(disputeOf(completeEnv({ DISPUTE_STARTED_LEASE_MS: ' ', DISPUTE_RESOLUTION_DEADLINE_MS: '' }))).toStrictEqual(disputeOf(completeEnv()));
  });

  test('a setting that is required stops the start by its name when it is not set, empty or blank', () => {
    for (const name of ['DISPUTE_CHALLENGE_STAKE_LOVELACE', 'DISPUTE_MIN_WINDOW_LEFT_MS', 'DISPUTE_READ_TIMEOUT_MS']) {
      for (const empty of [undefined, '', '   ']) expect(messageOf(() => disputeOf(completeEnv({ [name]: empty }))), `${name} = ${JSON.stringify(empty)}`).toMatch(required(name));
    }
  });
});

describe('the settings of the co-sign route', () => {
  test('the allowlist is required: the empty text holds nobody and is allowed, a setting that is not set is refused, notes and lines are read', () => {
    const settings = cosignSettingsOf(completeEnv());
    expect(settings.allowlist.has(PRINCIPAL.keyHash)).toBe(true);
    expect(settings).toMatchObject({ maxConcurrent: 4, maxFutureMs: 3_600_000, ledgerTimeoutMs: 5_000 });
    expect(cosignSettingsOf(completeEnv({ COSIGN_ALLOWLIST: '' })).allowlist.size).toBe(0);
    expect(cosignSettingsOf(completeEnv({ COSIGN_ALLOWLIST: `${PRINCIPAL.keyHash}\n# a note\n${SUPPLIER.keyHash}` })).allowlist.size).toBe(2);
    expect(messageOf(() => cosignSettingsOf(completeEnv({ COSIGN_ALLOWLIST: undefined })))).toMatch(cosignRule('COSIGN_ALLOWLIST is not set'));
  });

  test('each limit takes its range, a blank limit takes the default, and the refusal names the setting', () => {
    expect(cosignSettingsOf(completeEnv({ COSIGN_MAX_CONCURRENT: '8', COSIGN_MAX_FUTURE_MS: '120000', COSIGN_LEDGER_TIMEOUT_MS: '1000' }))).toMatchObject({ maxConcurrent: 8, maxFutureMs: 120_000, ledgerTimeoutMs: 1_000 });
    expect(cosignSettingsOf(completeEnv({ COSIGN_MAX_CONCURRENT: ' ', COSIGN_MAX_FUTURE_MS: '', COSIGN_LEDGER_TIMEOUT_MS: ' ' }))).toMatchObject({ maxConcurrent: 4, maxFutureMs: 3_600_000, ledgerTimeoutMs: 5_000 });
  });
});
