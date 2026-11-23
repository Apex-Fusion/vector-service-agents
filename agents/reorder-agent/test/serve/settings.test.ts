// agents/reorder-agent/test/serve/settings.test.ts
// The settings of the Reorder Agent that name no key. Each reader refuses a value that is missing or wrong, names the variable, and never repeats the value; each refusal has an accepted twin, the same variable with
// a value that the rule takes. The limits of the two kinds of hire are bigints of more than 0, and a limit that is not set is never "no limit". The numbers of the service agree with the numbers of the two jobs.
import { describe, expect, test } from 'vitest';
import { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from '@vsa/buyer-core';
import { JOB_DEADLINE_MS as EXECUTE_DEADLINE_MS } from '../../src/execute/index.ts';
import { PROPOSE_DEADLINE_MS } from '../../src/propose/index.ts';
import {
  GATEWAY_DEFAULT, HOST_DEFAULT, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, PRICE_DEFAULT_LOVELACE, STATE_DIR_DEFAULT, agentDidOf, cosignSettingsOf, disputeOf, endpointsFromEnv,
  faultOf, handoffLimitsOf, hostOf, httpsOriginOf, limitsOf, mockBasesOf, modelOf, module1SourceOf, portOf, priceOf, processingWindowOf, stateDirOf, stockReaderDidOf, supplierKeyOf,
} from '../../src/serve/settings.ts';
import { AGENT_DID, MODULE1_COMMIT, MODULE1_URL, PRINCIPAL, READER_DID, SUPPLIER, completeEnv, messageOf } from './support.ts';

/** A value that no setting takes. A message must name the variable and never repeat this value. */
const MARKER = 'zq9-marker-value-7f3';

/** One refusal and its accepted twin: the variable with a value that breaks the rule, and the same variable with a value that the rule takes. */
interface Row {
  readonly what: string;
  readonly read: (env: NodeJS.ProcessEnv) => unknown;
  readonly variable: string;
  readonly bad: string | undefined;
  readonly good: string;
}

describe('the numbers of the service agree with the numbers of the two jobs', () => {
  test('the job deadline of the service is the deadline of propose and of execute, and the window of the advert holds the timeout of the runtime inside it', () => {
    expect(JOB_DEADLINE_MS).toBe(1_620_000);
    expect(JOB_DEADLINE_MS).toBe(PROPOSE_DEADLINE_MS);
    expect(JOB_DEADLINE_MS).toBe(EXECUTE_DEADLINE_MS);
    // The runtime waits 60 s longer than the job and the window holds 120 s more: 1,680,000 and 1,800,000.
    expect(MIN_PROCESSING_WINDOW_MS).toBe(JOB_DEADLINE_MS + 60_000 + 120_000);
    expect(PORT_DEFAULT).toBe(9101);
    expect(HOST_DEFAULT).toBe('0.0.0.0');
    expect(STATE_DIR_DEFAULT).toBe('/data');
    expect(PRICE_DEFAULT_LOVELACE).toBe(3_000_000);
  });
});

describe('the identities, the fault switch, the listener and the state', () => {
  test('the two DIDs are required, in the form did:vector: and 64 hex characters, and a message gives the length and never the value', () => {
    expect(agentDidOf(completeEnv())).toBe(AGENT_DID);
    expect(stockReaderDidOf(completeEnv())).toBe(READER_DID);
    expect(messageOf(() => agentDidOf(completeEnv({ AGENT_DID: undefined })))).toMatch(/^environment variable AGENT_DID is required/);
    expect(messageOf(() => stockReaderDidOf(completeEnv({ STOCK_READER_DID: '  ' })))).toMatch(/^environment variable STOCK_READER_DID is required/);
    const wrong = messageOf(() => agentDidOf(completeEnv({ AGENT_DID: `did:vector:${MARKER}` })));
    expect(wrong).toMatch(/^environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters/);
    expect(wrong).not.toContain(MARKER);
    expect(messageOf(() => stockReaderDidOf(completeEnv({ STOCK_READER_DID: 'nope' })))).toMatch(/^environment variable STOCK_READER_DID must be did:vector:/);
  });

  test('FAULT_MODE must be empty: the Reorder Agent has no fault value, so any value stops the start', () => {
    expect(faultOf(completeEnv()).mode).toBe('');
    expect(faultOf(completeEnv({ FAULT_MODE: '' })).mode).toBe('');
    for (const value of ['confirm_wrong_lot', 'alter_after_approval', 'anything']) {
      const message = messageOf(() => faultOf(completeEnv({ FAULT_MODE: value })));
      expect(message).toMatch(/^environment variable FAULT_MODE must be empty/);
    }
  });

  test('the port, the host and the state directory have their defaults, and a wrong port or host stops the start', () => {
    expect(portOf({})).toBe(9101);
    expect(portOf({ PORT: '9200' })).toBe(9200);
    expect(messageOf(() => portOf({ PORT: '70000' }))).toMatch(/^environment variable PORT must be a port from 0 to 65535/);
    expect(messageOf(() => portOf({ PORT: 'x' }))).toMatch(/^environment variable PORT must be a non-negative integer/);
    expect(hostOf({})).toBe('0.0.0.0');
    expect(hostOf({ HOST: '127.0.0.1' })).toBe('127.0.0.1');
    expect(messageOf(() => hostOf({ HOST: 'a b' }))).toMatch(/^environment variable HOST must be an address or a host name/);
    expect(stateDirOf({})).toBe('/data');
    expect(stateDirOf({ REORDER_STATE_DIR: ' /var/state ' })).toBe('/var/state');
  });
});

describe('the numbers of the advert', () => {
  test('the window is at least 1,800,000 ms and the price is more than 0, with their defaults', () => {
    expect(processingWindowOf({})).toBe(1_800_000);
    expect(processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '1800000' })).toBe(1_800_000);
    expect(processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '2400000' })).toBe(2_400_000);
    expect(messageOf(() => processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '1799999' }))).toMatch(/^environment variable ADVERT_MAX_PROCESSING_MS must be at least 1800000/);
    expect(priceOf({})).toBe(3_000_000);
    expect(priceOf({ ADVERT_PRICE_LOVELACE: '4000000' })).toBe(4_000_000);
    expect(messageOf(() => priceOf({ ADVERT_PRICE_LOVELACE: '0' }))).toMatch(/^environment variable ADVERT_PRICE_LOVELACE must be a whole number of lovelace of more than 0/);
  });

  test('the supplier key is a key hash and the public key of that hash: a public key of another key, and a value that is no key, stop the start', () => {
    expect(supplierKeyOf(completeEnv())).toStrictEqual({ pkh: SUPPLIER.keyHash, pubKeyHex: SUPPLIER.publicKey });
    expect(supplierKeyOf(completeEnv({ SUPPLIER_PKH: SUPPLIER.keyHash.toUpperCase(), SUPPLIER_PUB_KEY_HEX: SUPPLIER.publicKey.toUpperCase() })).pkh).toBe(SUPPLIER.keyHash);
    expect(messageOf(() => supplierKeyOf(completeEnv({ SUPPLIER_PKH: undefined })))).toMatch(/^environment variable SUPPLIER_PKH is required/);
    expect(messageOf(() => supplierKeyOf(completeEnv({ SUPPLIER_PUB_KEY_HEX: undefined })))).toMatch(/^environment variable SUPPLIER_PUB_KEY_HEX is required/);
    expect(messageOf(() => supplierKeyOf(completeEnv({ SUPPLIER_PKH: 'ab'.repeat(28) })))).toMatch(/^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/);
    expect(messageOf(() => supplierKeyOf(completeEnv({ SUPPLIER_PKH: MARKER })))).not.toContain(MARKER);
  });
});

describe('the endpoints, the mock service and the Module-1 manifest', () => {
  test('the defaults are the endpoints of Vector mainnet, and an address with a user, a wrong scheme or no address form stops the start without repeating it', () => {
    expect(endpointsFromEnv({})).toStrictEqual({ gatewayUrl: GATEWAY_DEFAULT, ogmiosUrl: VECTOR_OGMIOS_URL, koiosUrl: VECTOR_KOIOS_URL, submitUrl: VECTOR_SUBMIT_URL, indexerUrl: undefined });
    const set = endpointsFromEnv({ IDENTITY_GATEWAY_URL: 'https://gateway.example', VECTOR_OGMIOS_URL: 'http://127.0.0.1:1337', VECTOR_MARKETPLACE_INDEXER_URL: 'https://indexer.example/api' });
    expect(set).toMatchObject({ gatewayUrl: 'https://gateway.example', ogmiosUrl: 'http://127.0.0.1:1337', indexerUrl: 'https://indexer.example/api' });
    const withUser = messageOf(() => endpointsFromEnv({ VECTOR_KOIOS_URL: `https://user:${MARKER}@koios.example` }));
    expect(withUser).toMatch(/^environment variable VECTOR_KOIOS_URL must be an http or https address with no user and no password/);
    expect(withUser).not.toContain(MARKER);
    expect(messageOf(() => endpointsFromEnv({ VECTOR_SUBMIT_URL: 'ftp://submit.example' }))).toMatch(/^environment variable VECTOR_SUBMIT_URL must be an http or https address/);
    expect(messageOf(() => endpointsFromEnv({ VECTOR_OGMIOS_URL: MARKER }))).not.toContain(MARKER);
    expect(messageOf(() => endpointsFromEnv({ IDENTITY_GATEWAY_URL: 'http://gateway.example' }))).toMatch(/^environment variable IDENTITY_GATEWAY_URL must be an https origin/);
  });

  test('the two bases of the mock service are https origins on two hosts', () => {
    expect(mockBasesOf(completeEnv())).toStrictEqual({ publicBase: 'https://mock.example', mtlsBase: 'https://mock-mtls.example' });
    expect(messageOf(() => mockBasesOf(completeEnv({ MOCK_PUBLIC_BASE: undefined })))).toMatch(/^environment variable MOCK_PUBLIC_BASE is required/);
    expect(messageOf(() => mockBasesOf(completeEnv({ MOCK_MTLS_BASE: undefined })))).toMatch(/^environment variable MOCK_MTLS_BASE is required/);
    expect(messageOf(() => mockBasesOf(completeEnv({ MOCK_PUBLIC_BASE: 'http://mock.example' })))).toMatch(/^environment variable MOCK_PUBLIC_BASE must be an https origin/);
    expect(messageOf(() => mockBasesOf(completeEnv({ MOCK_MTLS_BASE: 'https://mock.example' })))).toMatch(/^environment variable MOCK_MTLS_BASE must name another host than MOCK_PUBLIC_BASE/);
    expect(httpsOriginOf('X', 'https://host.example:8443').host).toBe('host.example:8443');
    for (const wrong of ['https://host.example/path', 'https://host.example?q=1', 'https://user@host.example', 'https://host.example//']) {
      expect(messageOf(() => httpsOriginOf('MOCK_PUBLIC_BASE', wrong))).toMatch(/^environment variable MOCK_PUBLIC_BASE must be an https origin/);
    }
  });

  test('the Module-1 manifest is required, as an https address pinned to a commit: a file path, an http address and an address with no commit are refused by name, and the value is never repeated', () => {
    expect(module1SourceOf(completeEnv())).toBe(MODULE1_URL);
    expect(module1SourceOf(completeEnv({ VECTOR_MODULE1_MANIFEST: ` ${MODULE1_URL} ` }))).toBe(MODULE1_URL);
    expect(messageOf(() => module1SourceOf(completeEnv({ VECTOR_MODULE1_MANIFEST: undefined })))).toMatch(/^environment variable VECTOR_MODULE1_MANIFEST is required/);
    for (const wrong of ['/srv/module1.json', 'http://198.51.100.7/a/' + MODULE1_COMMIT + '/m.json', 'https://198.51.100.7/a/main/m.json', `https://198.51.100.7/a/${MODULE1_COMMIT.toUpperCase()}/m.json`, `${MODULE1_URL}?x=${MARKER}`]) {
      const message = messageOf(() => module1SourceOf(completeEnv({ VECTOR_MODULE1_MANIFEST: wrong })));
      expect(message).toMatch(/^environment variable VECTOR_MODULE1_MANIFEST must be /);
      expect(message).not.toContain(wrong);
      expect(message).not.toContain(MARKER);
    }
  });
});

describe('the limits of the two kinds of hire', () => {
  const MODEL: Row[] = [
    { what: 'the models', read: limitsOf, variable: 'LLM_MODEL_ALLOWLIST', bad: undefined, good: 'a/b, c/d' },
    { what: 'a model name of a wrong form', read: limitsOf, variable: 'LLM_MODEL_ALLOWLIST', bad: 'a/b, c d', good: 'a/b,c:d' },
    { what: 'the price ceiling', read: limitsOf, variable: 'LLM_MAX_PRICE_LOVELACE', bad: undefined, good: '1' },
    { what: 'a price ceiling that is no number', read: limitsOf, variable: 'LLM_MAX_PRICE_LOVELACE', bad: MARKER, good: '250000' },
    { what: 'a price ceiling of 0', read: limitsOf, variable: 'LLM_MAX_PRICE_LOVELACE', bad: '0', good: '1' },
    { what: 'the supplier bond limit', read: limitsOf, variable: 'LLM_MAX_SUPPLIER_BOND_LOVELACE', bad: undefined, good: '1000000' },
    { what: 'a supplier bond limit with a fraction', read: limitsOf, variable: 'LLM_MAX_SUPPLIER_BOND_LOVELACE', bad: '1.5', good: '15' },
    { what: 'a supplier bond limit of 0', read: limitsOf, variable: 'LLM_MAX_SUPPLIER_BOND_LOVELACE', bad: '0', good: '1' },
    { what: 'the buyer bond limit', read: limitsOf, variable: 'LLM_MAX_BUYER_BOND_LOVELACE', bad: '  ', good: '1000000' },
    { what: 'a buyer bond limit that is negative', read: limitsOf, variable: 'LLM_MAX_BUYER_BOND_LOVELACE', bad: '-1', good: '0001' },
  ];
  const HANDOFF: Row[] = ['HANDOFF_MAX_PRICE_LOVELACE', 'HANDOFF_MAX_SUPPLIER_BOND_LOVELACE', 'HANDOFF_MAX_BUYER_BOND_LOVELACE'].flatMap((variable) => [
    { what: `${variable} that is not set`, read: handoffLimitsOf, variable, bad: undefined, good: '5000000' },
    { what: `${variable} that is no number`, read: handoffLimitsOf, variable, bad: MARKER, good: '5000000' },
    { what: `${variable} of 0`, read: handoffLimitsOf, variable, bad: '0', good: '5000000' },
  ]);

  test.each([...MODEL, ...HANDOFF])('$variable: $what stops the start by its name, and the twin passes', (row) => {
    const message = messageOf(() => row.read(completeEnv({ [row.variable]: row.bad })));
    expect(message).toContain(row.variable);
    expect(message).not.toContain(MARKER);
    expect(() => row.read(completeEnv({ [row.variable]: row.good }))).not.toThrow();
  });

  test('the limits come out as bigints, and the manifest ceiling of the model hire is the price limit', () => {
    expect(limitsOf(completeEnv())).toStrictEqual({ allowlist: ['deepseek/deepseek-v4-flash'], maxPriceLovelace: 1_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(modelOf(completeEnv({ LLM_MODEL_ALLOWLIST: 'a/b, c/d' }))).toStrictEqual({ allowlist: ['a/b', 'c/d'], maxPriceLovelace: 1_000_000n });
    expect(handoffLimitsOf(completeEnv())).toStrictEqual({ maxPriceLovelace: 10_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(typeof limitsOf(completeEnv()).maxBuyerBondLovelace).toBe('bigint');
    expect(typeof handoffLimitsOf(completeEnv()).maxSupplierBondLovelace).toBe('bigint');
  });
});

describe('the settings of the dispute code', () => {
  test('the stake, the least window left and the bound of a read are required, and each has a least value', () => {
    expect(disputeOf(completeEnv())).toStrictEqual({ challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 60_000, read_timeout_ms: 20_000 });
    for (const variable of ['DISPUTE_CHALLENGE_STAKE_LOVELACE', 'DISPUTE_MIN_WINDOW_LEFT_MS', 'DISPUTE_READ_TIMEOUT_MS']) {
      expect(messageOf(() => disputeOf(completeEnv({ [variable]: undefined })))).toMatch(new RegExp(`^environment variable ${variable} is required`));
    }
    expect(messageOf(() => disputeOf(completeEnv({ DISPUTE_CHALLENGE_STAKE_LOVELACE: '0' })))).toMatch(/^environment variable DISPUTE_CHALLENGE_STAKE_LOVELACE must be a whole number of lovelace of more than 0/);
    expect(messageOf(() => disputeOf(completeEnv({ DISPUTE_MIN_WINDOW_LEFT_MS: '1999' })))).toMatch(/^environment variable DISPUTE_MIN_WINDOW_LEFT_MS must be a whole number of milliseconds of at least 2000/);
    expect(disputeOf(completeEnv({ DISPUTE_MIN_WINDOW_LEFT_MS: '2000' })).min_window_left_ms).toBe(2_000);
    expect(messageOf(() => disputeOf(completeEnv({ DISPUTE_READ_TIMEOUT_MS: '0' })))).toMatch(/^environment variable DISPUTE_READ_TIMEOUT_MS must be a whole number of milliseconds of at least 1/);
  });

  test('the lease and the resolution deadline are optional, and a value below their least stops the start', () => {
    const both = disputeOf(completeEnv({ DISPUTE_STARTED_LEASE_MS: '600000', DISPUTE_RESOLUTION_DEADLINE_MS: '24000000' }));
    expect(both).toMatchObject({ started_lease_ms: 600_000, resolution_deadline_ms: 24_000_000 });
    expect(messageOf(() => disputeOf(completeEnv({ DISPUTE_STARTED_LEASE_MS: '39999' })))).toMatch(/^environment variable DISPUTE_STARTED_LEASE_MS must be a whole number of milliseconds of at least 40000/);
    expect(disputeOf(completeEnv({ DISPUTE_STARTED_LEASE_MS: '40000' })).started_lease_ms).toBe(40_000);
    expect(messageOf(() => disputeOf(completeEnv({ DISPUTE_RESOLUTION_DEADLINE_MS: '1000' })))).toMatch(/^environment variable DISPUTE_RESOLUTION_DEADLINE_MS must be a whole number of milliseconds of at least 24000000/);
    expect(disputeOf(completeEnv({ DISPUTE_RESOLUTION_DEADLINE_MS: '24000000' })).resolution_deadline_ms).toBe(24_000_000);
  });
});

describe('the settings of the co-sign route', () => {
  test('the allowlist is required: the empty text holds nobody and is allowed, a setting that is not set is refused, and an entry that is no key hash is refused', () => {
    const settings = cosignSettingsOf(completeEnv());
    expect(settings.allowlist.has(PRINCIPAL.keyHash)).toBe(true);
    expect(settings).toMatchObject({ maxConcurrent: 4, maxFutureMs: 3_600_000, ledgerTimeoutMs: 5_000 });
    expect(cosignSettingsOf(completeEnv({ COSIGN_ALLOWLIST: '' })).allowlist.size).toBe(0);
    expect(messageOf(() => cosignSettingsOf(completeEnv({ COSIGN_ALLOWLIST: undefined })))).toMatch(/COSIGN_ALLOWLIST is not set/);
    const wrong = messageOf(() => cosignSettingsOf(completeEnv({ COSIGN_ALLOWLIST: `${PRINCIPAL.keyHash}, ${MARKER}` })));
    expect(wrong).toMatch(/^the settings of the co-sign route are refused: the allowlist has an entry on line 1 that is not a key hash/);
    expect(wrong).not.toContain(MARKER);
    expect(cosignSettingsOf(completeEnv({ COSIGN_ALLOWLIST: `${PRINCIPAL.keyHash}\n# a note\n${SUPPLIER.keyHash}` })).allowlist.size).toBe(2);
  });

  test('each limit takes its range, a blank limit takes the default, and the refusal names the setting', () => {
    expect(cosignSettingsOf(completeEnv({ COSIGN_MAX_CONCURRENT: '8', COSIGN_MAX_FUTURE_MS: '120000', COSIGN_LEDGER_TIMEOUT_MS: '1000' }))).toMatchObject({ maxConcurrent: 8, maxFutureMs: 120_000, ledgerTimeoutMs: 1_000 });
    expect(cosignSettingsOf(completeEnv({ COSIGN_MAX_CONCURRENT: ' ', COSIGN_MAX_FUTURE_MS: '', COSIGN_LEDGER_TIMEOUT_MS: ' ' }))).toMatchObject({ maxConcurrent: 4, maxFutureMs: 3_600_000, ledgerTimeoutMs: 5_000 });
    for (const [variable, bad, good] of [['COSIGN_MAX_CONCURRENT', '65', '64'], ['COSIGN_MAX_CONCURRENT', '0', '1'], ['COSIGN_MAX_FUTURE_MS', '59999', '60000'], ['COSIGN_MAX_FUTURE_MS', '3600001', '3600000'],
      ['COSIGN_LEDGER_TIMEOUT_MS', '49', '50'], ['COSIGN_LEDGER_TIMEOUT_MS', '30001', '30000'], ['COSIGN_MAX_CONCURRENT', 'x', '2']] as const) {
      expect(messageOf(() => cosignSettingsOf(completeEnv({ [variable]: bad })))).toContain(variable);
      expect(() => cosignSettingsOf(completeEnv({ [variable]: good }))).not.toThrow();
    }
  });
});
