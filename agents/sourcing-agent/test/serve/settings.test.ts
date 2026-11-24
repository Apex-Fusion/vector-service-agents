// agents/sourcing-agent/test/serve/settings.test.ts
// The settings of the Sourcing Agent that name no key. Each reader refuses a value that is missing or wrong, names the variable, and never repeats the value; each refusal has an accepted twin, the same variable
// with a value that the rule takes. The limits of the two kinds of hire are bigints of more than 0, and a limit that is not set is never "no limit". The three scorers are three agents, and none is the agent.
// The numbers of the service agree with each other: the deadline of a job, the timeout of the runtime and the window of the advert.
import { describe, expect, test } from 'vitest';
import { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from '@vsa/buyer-core';
import { REGISTRY_POLICY } from '@vsa/vector-read';
import {
  BUYER_BOND_LOVELACE, GATEWAY_DEFAULT, HOST_DEFAULT, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, PRICE_DEFAULT_LOVELACE, STATE_DIR_DEFAULT, SUPPLIER_BOND_LOVELACE, agentDidOf,
  complianceIssuerOf, cosignSettingsOf, disputeOf, endpointsFromEnv, faultOf, hostOf, httpsOriginOf, limitsOf, mockBasesOf, modelOf, module1SourceOf, portOf, priceOf, processingWindowOf, quoteLimitsOf,
  scorerDidsOf, stateDirOf, supplierKeyOf,
} from '../../src/serve/settings.ts';
import { AGENT_DID, ISSUER, MODULE1_COMMIT, MODULE1_URL, PRINCIPAL, SCORER_DIDS, SUPPLIER, completeEnv, messageOf } from './support.ts';

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

/** Runs each row: the refusal names the variable and never repeats the marker, and the twin passes. */
function checkRow(row: Row): void {
  const message = messageOf(() => row.read(completeEnv({ [row.variable]: row.bad })));
  expect(message).toContain(row.variable);
  expect(message).not.toContain(MARKER);
  expect(() => row.read(completeEnv({ [row.variable]: row.good }))).not.toThrow();
}

describe('the numbers of the service agree with each other', () => {
  test('the window of the advert is 3,600,000 ms: the deadline of a job is 3,420,000 ms, and the timeout of the runtime, 3,480,000 ms, stands between the two', () => {
    expect(JOB_DEADLINE_MS).toBe(3_420_000);
    expect(MIN_PROCESSING_WINDOW_MS).toBe(3_600_000);
    // The runtime waits 60 s longer than the job, and the window holds 120 s more than the runtime.
    const runtimeTimeoutMs = 3_480_000;
    expect(runtimeTimeoutMs).toBe(JOB_DEADLINE_MS + 60_000);
    expect(MIN_PROCESSING_WINDOW_MS).toBe(runtimeTimeoutMs + 120_000);
    expect(MIN_PROCESSING_WINDOW_MS).toBe(JOB_DEADLINE_MS + 180_000);
  });

  test('the defaults are the port 9105, every address, the folder /data and the price 3 units, and the two bonds are 1 unit each, so the lock of the escrow is 5 units', () => {
    expect(PORT_DEFAULT).toBe(9105);
    expect(HOST_DEFAULT).toBe('0.0.0.0');
    expect(STATE_DIR_DEFAULT).toBe('/data');
    expect(PRICE_DEFAULT_LOVELACE).toBe(3_000_000);
    expect(SUPPLIER_BOND_LOVELACE).toBe(1_000_000);
    expect(BUYER_BOND_LOVELACE).toBe(1_000_000);
    expect(PRICE_DEFAULT_LOVELACE + SUPPLIER_BOND_LOVELACE + BUYER_BOND_LOVELACE).toBe(5_000_000);
  });
});

describe('the DID of the agent and the DIDs of the three scorers', () => {
  const DID_ROWS: Row[] = [
    { variable: 'AGENT_DID', read: agentDidOf },
    { variable: 'SCORER_1_DID', read: scorerDidsOf },
    { variable: 'SCORER_2_DID', read: scorerDidsOf },
    { variable: 'SCORER_3_DID', read: scorerDidsOf },
  ].flatMap(({ variable, read }) => [
    { what: 'a DID that is not set', read, variable, bad: undefined, good: `did:vector:${'c3'.repeat(32)}` },
    { what: 'a DID that is blank', read, variable, bad: '  ', good: `did:vector:${'c3'.repeat(32)}` },
    { what: 'a DID with a marker in place of the identifier', read, variable, bad: `did:vector:${MARKER}`, good: `did:vector:${'c4'.repeat(32)}` },
    { what: 'a DID with 63 hex characters', read, variable, bad: `did:vector:${'c3'.repeat(31)}c`, good: `did:vector:${'c5'.repeat(32)}` },
    { what: 'a DID with upper-case hex', read, variable, bad: `did:vector:${'C3'.repeat(32)}`, good: `did:vector:${'c3'.repeat(32)}` },
    { what: 'the DID of another method', read, variable, bad: 'did:web:agent.example', good: `did:vector:${'c6'.repeat(32)}` },
    { what: 'a text that is no DID', read, variable, bad: MARKER, good: `did:vector:${'c7'.repeat(32)}` },
  ]);

  test.each(DID_ROWS)('$variable: $what stops the start by its name, and the twin passes', checkRow);

  test('a message gives the length of the value and never the value', () => {
    const wrong = messageOf(() => agentDidOf(completeEnv({ AGENT_DID: `did:vector:${MARKER}` })));
    expect(wrong).toMatch(/^environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters/);
    expect(wrong).toContain(`${`did:vector:${MARKER}`.length} characters`);
    expect(messageOf(() => agentDidOf(completeEnv({ AGENT_DID: undefined })))).toMatch(/^environment variable AGENT_DID is required/);
    expect(messageOf(() => scorerDidsOf(completeEnv({ SCORER_2_DID: '  ' })))).toMatch(/^environment variable SCORER_2_DID is required/);
    expect(messageOf(() => scorerDidsOf(completeEnv({ SCORER_3_DID: 'nope' })))).toMatch(/^environment variable SCORER_3_DID must be did:vector:/);
  });

  test('the DID of the agent and the three DIDs of the scorers come out in canonical form, in the order of the variables, and the legacy form is read as the DID of the same identifier', () => {
    expect(agentDidOf(completeEnv())).toBe(AGENT_DID);
    expect(scorerDidsOf(completeEnv())).toStrictEqual([...SCORER_DIDS]);
    expect(agentDidOf(completeEnv({ AGENT_DID: ` ${AGENT_DID} ` }))).toBe(AGENT_DID);
    const legacy = `did:vector:agent:${REGISTRY_POLICY}:${'b3'.repeat(32)}`;
    expect(scorerDidsOf(completeEnv({ SCORER_2_DID: legacy }))).toStrictEqual([...SCORER_DIDS]);
    // A legacy form of an identifier that this agent or a sibling holds is that DID: the check below holds after the form is made canonical.
    expect(messageOf(() => scorerDidsOf(completeEnv({ SCORER_3_DID: legacy })))).toMatch(/SCORER_3_DID/);
  });

  test('two scorers with one DID are refused for every pair, and the message names the two variables and shows no DID', () => {
    const pairs = [[1, 2], [1, 3], [2, 3]] as const;
    for (const [first, second] of pairs) {
      const env = completeEnv({ [`SCORER_${second}_DID`]: SCORER_DIDS[first - 1] });
      const message = messageOf(() => scorerDidsOf(env));
      expect(message).toContain(`SCORER_${second}_DID`);
      expect(message).toContain(`SCORER_${first}_DID`);
      for (const did of [...SCORER_DIDS, AGENT_DID]) expect(message).not.toContain(did);
    }
    // The twin: the same three variables with three DIDs that differ.
    expect(() => scorerDidsOf(completeEnv({ SCORER_1_DID: `did:vector:${'d1'.repeat(32)}`, SCORER_2_DID: `did:vector:${'d2'.repeat(32)}`, SCORER_3_DID: `did:vector:${'d3'.repeat(32)}` }))).not.toThrow();
  });

  test('a scorer with the DID of the agent is refused for every scorer, and the message names the scorer and AGENT_DID and shows no DID', () => {
    for (const number of [1, 2, 3]) {
      const message = messageOf(() => scorerDidsOf(completeEnv({ [`SCORER_${number}_DID`]: AGENT_DID })));
      expect(message).toContain(`SCORER_${number}_DID`);
      expect(message).toContain('AGENT_DID');
      for (const did of [...SCORER_DIDS, AGENT_DID]) expect(message).not.toContain(did);
    }
    expect(messageOf(() => scorerDidsOf(completeEnv({ SCORER_1_DID: `did:vector:agent:${REGISTRY_POLICY}:${'a1'.repeat(32)}` })))).toContain('AGENT_DID');
    // The check needs the agent: with no AGENT_DID the start stops by that name.
    expect(messageOf(() => scorerDidsOf(completeEnv({ AGENT_DID: undefined })))).toMatch(/^environment variable AGENT_DID is required/);
  });
});

describe('the fault switch', () => {
  test('is empty or invert_scores, and the mode is the value that was read', () => {
    expect(faultOf(completeEnv()).mode).toBe('');
    expect(faultOf(completeEnv({ FAULT_MODE: '' })).mode).toBe('');
    expect(faultOf(completeEnv({ FAULT_MODE: 'invert_scores' })).mode).toBe('invert_scores');
    expect(faultOf(completeEnv({ FAULT_MODE: 'invert_scores' })).kind).toBe('sourcing-agent');
  });

  test('any other value stops the start by the name FAULT_MODE: the fault values of the other agents, a changed case, a space, and a long value that is never repeated', () => {
    for (const value of ['confirm_wrong_lot', 'alter_after_approval', 'quote_off_price_list', 'INVERT_SCORES', ' invert_scores', 'invert_scores ', 'anything', 'zq9'.repeat(20)]) {
      const message = messageOf(() => faultOf(completeEnv({ FAULT_MODE: value })));
      expect(message).toMatch(/^environment variable FAULT_MODE must be empty or "invert_scores" for sourcing-agent/);
      expect(message).not.toContain('zq9'.repeat(20));
    }
  });
});

describe('the listener and the state', () => {
  test('the port, the host and the state directory have their defaults, and a wrong port or host stops the start', () => {
    expect(portOf({})).toBe(9105);
    expect(portOf({ PORT: '9200' })).toBe(9200);
    expect(portOf({ PORT: '0' })).toBe(0);
    expect(messageOf(() => portOf({ PORT: '70000' }))).toMatch(/^environment variable PORT must be a port from 0 to 65535/);
    expect(portOf({ PORT: '65535' })).toBe(65_535);
    expect(messageOf(() => portOf({ PORT: 'x' }))).toMatch(/^environment variable PORT must be a non-negative integer/);
    expect(hostOf({})).toBe('0.0.0.0');
    expect(hostOf({ HOST: '127.0.0.1' })).toBe('127.0.0.1');
    expect(messageOf(() => hostOf({ HOST: 'a b' }))).toMatch(/^environment variable HOST must be an address or a host name/);
  });

  test('the state directory is SOURCING_STATE_DIR, trimmed, and no other variable names it', () => {
    expect(stateDirOf({})).toBe('/data');
    expect(stateDirOf({ SOURCING_STATE_DIR: ' /var/state ' })).toBe('/var/state');
    expect(stateDirOf({ SOURCING_STATE_DIR: '  ' })).toBe('/data');
    expect(stateDirOf({ REORDER_STATE_DIR: '/var/state', STATE_DIR: '/var/state' })).toBe('/data');
  });
});

describe('the numbers of the advert', () => {
  test('the window is at least 3,600,000 ms, and a window below it, the old one of 1,800,000 ms included, stops the start by its name', () => {
    expect(processingWindowOf({})).toBe(3_600_000);
    expect(processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '3600000' })).toBe(3_600_000);
    expect(processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '4200000' })).toBe(4_200_000);
    expect(processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '' })).toBe(3_600_000);
    for (const bad of ['3599999', '1800000', '0']) {
      expect(messageOf(() => processingWindowOf({ ADVERT_MAX_PROCESSING_MS: bad }))).toMatch(/^environment variable ADVERT_MAX_PROCESSING_MS must be at least 3600000/);
    }
    expect(messageOf(() => processingWindowOf({ ADVERT_MAX_PROCESSING_MS: MARKER }))).toMatch(/^environment variable ADVERT_MAX_PROCESSING_MS must be a non-negative integer/);
    expect(messageOf(() => processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '3600000.5' }))).toContain('ADVERT_MAX_PROCESSING_MS');
  });

  test('the price is a whole number of lovelace of more than 0, with the default 3,000,000', () => {
    expect(priceOf({})).toBe(3_000_000);
    expect(priceOf({ ADVERT_PRICE_LOVELACE: '4000000' })).toBe(4_000_000);
    expect(priceOf({ ADVERT_PRICE_LOVELACE: '1' })).toBe(1);
    expect(messageOf(() => priceOf({ ADVERT_PRICE_LOVELACE: '0' }))).toMatch(/^environment variable ADVERT_PRICE_LOVELACE must be a whole number of lovelace of more than 0/);
    expect(messageOf(() => priceOf({ ADVERT_PRICE_LOVELACE: '-1' }))).toMatch(/^environment variable ADVERT_PRICE_LOVELACE must be a non-negative integer/);
    expect(messageOf(() => priceOf({ ADVERT_PRICE_LOVELACE: '3.5' }))).toContain('ADVERT_PRICE_LOVELACE');
  });
});

describe('the supplier key', () => {
  test('is a key hash and the public key of that hash, and a public key of another key stops the start', () => {
    expect(supplierKeyOf(completeEnv())).toStrictEqual({ pkh: SUPPLIER.keyHash, pubKeyHex: SUPPLIER.publicKey });
    expect(supplierKeyOf(completeEnv({ SUPPLIER_PKH: SUPPLIER.keyHash.toUpperCase(), SUPPLIER_PUB_KEY_HEX: SUPPLIER.publicKey.toUpperCase() })).pkh).toBe(SUPPLIER.keyHash);
    expect(messageOf(() => supplierKeyOf(completeEnv({ SUPPLIER_PKH: 'ab'.repeat(28) })))).toMatch(/^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/);
    expect(messageOf(() => supplierKeyOf(completeEnv({ SUPPLIER_PUB_KEY_HEX: PRINCIPAL.publicKey })))).toMatch(/^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/);
    expect(messageOf(() => supplierKeyOf(completeEnv({ SUPPLIER_PKH: PRINCIPAL.keyHash })))).toMatch(/^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/);
  });

  const SUPPLIER_ROWS: Row[] = [
    { what: 'the key hash that is not set', read: supplierKeyOf, variable: 'SUPPLIER_PKH', bad: undefined, good: SUPPLIER.keyHash },
    { what: 'a key hash that is blank', read: supplierKeyOf, variable: 'SUPPLIER_PKH', bad: ' ', good: SUPPLIER.keyHash },
    { what: 'a key hash that is no hex', read: supplierKeyOf, variable: 'SUPPLIER_PKH', bad: MARKER, good: SUPPLIER.keyHash },
    { what: 'a key hash of 55 characters', read: supplierKeyOf, variable: 'SUPPLIER_PKH', bad: SUPPLIER.keyHash.slice(1), good: SUPPLIER.keyHash },
    { what: 'the public key that is not set', read: supplierKeyOf, variable: 'SUPPLIER_PUB_KEY_HEX', bad: undefined, good: SUPPLIER.publicKey },
    { what: 'a public key that is no hex', read: supplierKeyOf, variable: 'SUPPLIER_PUB_KEY_HEX', bad: MARKER, good: SUPPLIER.publicKey },
    { what: 'a public key of 63 characters', read: supplierKeyOf, variable: 'SUPPLIER_PUB_KEY_HEX', bad: SUPPLIER.publicKey.slice(1), good: SUPPLIER.publicKey },
  ];
  test.each(SUPPLIER_ROWS)('$variable: $what stops the start by its name, and the twin passes', checkRow);
});

describe('the issuer of the compliance attestations', () => {
  const ISSUER_ROWS: Row[] = [
    { what: 'the key hash that is not set', read: complianceIssuerOf, variable: 'COMPLIANCE_ISSUER_PKH', bad: undefined, good: ISSUER.keyHash },
    { what: 'a key hash that is blank', read: complianceIssuerOf, variable: 'COMPLIANCE_ISSUER_PKH', bad: '   ', good: ISSUER.keyHash },
    { what: 'a key hash that is no hex', read: complianceIssuerOf, variable: 'COMPLIANCE_ISSUER_PKH', bad: MARKER, good: ISSUER.keyHash },
    { what: 'a key hash of 55 characters', read: complianceIssuerOf, variable: 'COMPLIANCE_ISSUER_PKH', bad: ISSUER.keyHash.slice(1), good: ISSUER.keyHash },
    { what: 'a key hash of 57 characters', read: complianceIssuerOf, variable: 'COMPLIANCE_ISSUER_PKH', bad: `${ISSUER.keyHash}a`, good: ISSUER.keyHash },
    { what: 'a public key of 64 characters in place of the key hash', read: complianceIssuerOf, variable: 'COMPLIANCE_ISSUER_PKH', bad: ISSUER.publicKey, good: ISSUER.keyHash },
  ];
  test.each(ISSUER_ROWS)('$variable: $what stops the start by its name, and the twin passes', checkRow);

  test('is 56 hex characters in lower case, and a value that holds a key of 64 hex characters in the wrong line is never repeated', () => {
    expect(complianceIssuerOf(completeEnv())).toBe(ISSUER.keyHash);
    expect(complianceIssuerOf(completeEnv({ COMPLIANCE_ISSUER_PKH: ` ${ISSUER.keyHash.toUpperCase()} ` }))).toBe(ISSUER.keyHash);
    const message = messageOf(() => complianceIssuerOf(completeEnv({ COMPLIANCE_ISSUER_PKH: ISSUER.publicKey })));
    expect(message).toBe('environment variable COMPLIANCE_ISSUER_PKH must be 56 hex characters, and it has 64 characters');
    expect(message).not.toContain(ISSUER.publicKey);
  });
});

describe('the endpoints, the mock service and the Module-1 manifest', () => {
  test('the defaults are the endpoints of Vector mainnet, and an address with a user, a wrong scheme or no address form stops the start without repeating it', () => {
    expect(endpointsFromEnv({})).toStrictEqual({ gatewayUrl: GATEWAY_DEFAULT, ogmiosUrl: VECTOR_OGMIOS_URL, koiosUrl: VECTOR_KOIOS_URL, submitUrl: VECTOR_SUBMIT_URL, indexerUrl: undefined });
    const set = endpointsFromEnv({ IDENTITY_GATEWAY_URL: 'https://gateway.example', VECTOR_OGMIOS_URL: 'https://127.0.0.1:1337', VECTOR_MARKETPLACE_INDEXER_URL: 'https://indexer.example/api' });
    expect(set).toMatchObject({ gatewayUrl: 'https://gateway.example', ogmiosUrl: 'https://127.0.0.1:1337', indexerUrl: 'https://indexer.example/api' });
    const withUser = messageOf(() => endpointsFromEnv({ VECTOR_KOIOS_URL: `https://user:${MARKER}@koios.example` }));
    expect(withUser).toMatch(/^environment variable VECTOR_KOIOS_URL must be an http or https address with no user and no password/);
    expect(withUser).not.toContain(MARKER);
    // The tip reader of the janitor takes https only and is made at the first pass of the janitor, so an http address of the node stops the start by name, and its https twin is accepted.
    const http = messageOf(() => endpointsFromEnv({ VECTOR_OGMIOS_URL: `http://node.example:1337/${MARKER}` }));
    expect(http).toMatch(/^environment variable VECTOR_OGMIOS_URL must be an https address/);
    expect(http).not.toContain(MARKER);
    expect(endpointsFromEnv({ VECTOR_OGMIOS_URL: 'https://node.example:1337' }).ogmiosUrl).toBe('https://node.example:1337');
    expect(messageOf(() => endpointsFromEnv({ VECTOR_SUBMIT_URL: 'ftp://submit.example' }))).toMatch(/^environment variable VECTOR_SUBMIT_URL must be an http or https address/);
    expect(endpointsFromEnv({ VECTOR_SUBMIT_URL: 'http://submit.example' }).submitUrl).toBe('http://submit.example');
    expect(messageOf(() => endpointsFromEnv({ VECTOR_OGMIOS_URL: MARKER }))).not.toContain(MARKER);
    expect(messageOf(() => endpointsFromEnv({ VECTOR_MARKETPLACE_INDEXER_URL: MARKER }))).toMatch(/^environment variable VECTOR_MARKETPLACE_INDEXER_URL must be an http or https address/);
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
    for (const wrong of ['/srv/module1.json', `http://198.51.100.7/a/${MODULE1_COMMIT}/m.json`, 'https://198.51.100.7/a/main/m.json', `https://198.51.100.7/a/${MODULE1_COMMIT.toUpperCase()}/m.json`, `${MODULE1_URL}?x=${MARKER}`]) {
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
    { what: 'a buyer bond limit that is the word null', read: limitsOf, variable: 'LLM_MAX_BUYER_BOND_LOVELACE', bad: 'null', good: '2000000' },
  ];

  /** The three limits of the hire of a quote, each with every wrong form of a limit: not set, blank, a word, null, zero, negative, a fraction, an exponent, hex, a sign, and a number that a number cannot hold. */
  const QUOTE: Row[] = ['QUOTE_MAX_PRICE_LOVELACE', 'QUOTE_MAX_SUPPLIER_BOND_LOVELACE', 'QUOTE_MAX_BUYER_BOND_LOVELACE'].flatMap((variable) => [
    { what: 'a limit that is not set', bad: undefined },
    { what: 'a limit that is blank', bad: '   ' },
    { what: 'a limit that is empty', bad: '' },
    { what: 'a limit that is a marker', bad: MARKER },
    { what: 'a limit that is the word null', bad: 'null' },
    { what: 'a limit that is the word undefined', bad: 'undefined' },
    { what: 'a limit of 0', bad: '0' },
    { what: 'a limit that is negative', bad: '-1' },
    { what: 'a limit with a fraction', bad: '1.5' },
    { what: 'a limit in exponent form', bad: '1e6' },
    { what: 'a limit in hex form', bad: '0x10' },
    { what: 'a limit with a sign', bad: '+5' },
    { what: 'a limit that is infinity', bad: 'Infinity' },
    { what: 'a limit that no number holds exactly', bad: '9007199254740993' },
  ].map(({ what, bad }): Row => ({ what, bad, read: quoteLimitsOf, variable, good: '5000000' })));

  test.each([...MODEL, ...QUOTE])('$variable: $what stops the start by its name, and the twin passes', checkRow);

  test('the limits come out as bigints, and the manifest ceiling of the model hire is the price limit', () => {
    expect(limitsOf(completeEnv())).toStrictEqual({ allowlist: ['deepseek/deepseek-v4-flash'], maxPriceLovelace: 1_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(modelOf(completeEnv({ LLM_MODEL_ALLOWLIST: 'a/b, c/d' }))).toStrictEqual({ allowlist: ['a/b', 'c/d'], maxPriceLovelace: 1_000_000n });
    expect(quoteLimitsOf(completeEnv())).toStrictEqual({ maxPriceLovelace: 2_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(quoteLimitsOf(completeEnv({ QUOTE_MAX_PRICE_LOVELACE: '3000000', QUOTE_MAX_SUPPLIER_BOND_LOVELACE: '4000000', QUOTE_MAX_BUYER_BOND_LOVELACE: '5000000' }))).toStrictEqual({
      maxPriceLovelace: 3_000_000n, maxSupplierBondLovelace: 4_000_000n, maxBuyerBondLovelace: 5_000_000n,
    });
    for (const limits of [limitsOf(completeEnv()), quoteLimitsOf(completeEnv())]) {
      expect(typeof limits.maxPriceLovelace).toBe('bigint');
      expect(typeof limits.maxSupplierBondLovelace).toBe('bigint');
      expect(typeof limits.maxBuyerBondLovelace).toBe('bigint');
    }
  });

  test('a limit of the quote hire is no limit of the model hire: each kind reads its own three or four variables and no other', () => {
    expect(messageOf(() => quoteLimitsOf(completeEnv({ QUOTE_MAX_BUYER_BOND_LOVELACE: undefined, LLM_MAX_BUYER_BOND_LOVELACE: '2000000' })))).toContain('QUOTE_MAX_BUYER_BOND_LOVELACE');
    expect(messageOf(() => limitsOf(completeEnv({ LLM_MAX_BUYER_BOND_LOVELACE: undefined, QUOTE_MAX_BUYER_BOND_LOVELACE: '2000000' })))).toContain('LLM_MAX_BUYER_BOND_LOVELACE');
  });
});

describe('the settings of the dispute code', () => {
  test('the stake, the least window left and the bound of a read are required, and each has a least value', () => {
    expect(disputeOf(completeEnv())).toStrictEqual({ challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 600_000, read_timeout_ms: 20_000 });
    for (const variable of ['DISPUTE_CHALLENGE_STAKE_LOVELACE', 'DISPUTE_MIN_WINDOW_LEFT_MS', 'DISPUTE_READ_TIMEOUT_MS']) {
      expect(messageOf(() => disputeOf(completeEnv({ [variable]: undefined })))).toMatch(new RegExp(`^environment variable ${variable} is required`));
    }
    expect(messageOf(() => disputeOf(completeEnv({ DISPUTE_CHALLENGE_STAKE_LOVELACE: '0' })))).toMatch(/^environment variable DISPUTE_CHALLENGE_STAKE_LOVELACE must be a whole number of lovelace of more than 0/);
    expect(messageOf(() => disputeOf(completeEnv({ DISPUTE_MIN_WINDOW_LEFT_MS: '1999' })))).toMatch(/^environment variable DISPUTE_MIN_WINDOW_LEFT_MS must be a whole number of milliseconds of at least 2000/);
    expect(disputeOf(completeEnv({ DISPUTE_MIN_WINDOW_LEFT_MS: '2000' })).min_window_left_ms).toBe(2_000);
    expect(messageOf(() => disputeOf(completeEnv({ DISPUTE_READ_TIMEOUT_MS: '0' })))).toMatch(/^environment variable DISPUTE_READ_TIMEOUT_MS must be a whole number of milliseconds of at least 1/);
    expect(disputeOf(completeEnv({ DISPUTE_READ_TIMEOUT_MS: '1' })).read_timeout_ms).toBe(1);
    const marker = messageOf(() => disputeOf(completeEnv({ DISPUTE_CHALLENGE_STAKE_LOVELACE: MARKER })));
    expect(marker).toContain('DISPUTE_CHALLENGE_STAKE_LOVELACE');
    expect(marker).not.toContain(MARKER);
  });

  test('the lease and the resolution deadline are optional, and a value below their least stops the start', () => {
    const both = disputeOf(completeEnv({ DISPUTE_STARTED_LEASE_MS: '600000', DISPUTE_RESOLUTION_DEADLINE_MS: '24000000' }));
    expect(both).toMatchObject({ started_lease_ms: 600_000, resolution_deadline_ms: 24_000_000 });
    expect(messageOf(() => disputeOf(completeEnv({ DISPUTE_STARTED_LEASE_MS: '39999' })))).toMatch(/^environment variable DISPUTE_STARTED_LEASE_MS must be a whole number of milliseconds of at least 40000/);
    expect(disputeOf(completeEnv({ DISPUTE_STARTED_LEASE_MS: '40000' })).started_lease_ms).toBe(40_000);
    expect(messageOf(() => disputeOf(completeEnv({ DISPUTE_RESOLUTION_DEADLINE_MS: '1000' })))).toMatch(/^environment variable DISPUTE_RESOLUTION_DEADLINE_MS must be a whole number of milliseconds of at least 24000000/);
    expect(disputeOf(completeEnv({ DISPUTE_RESOLUTION_DEADLINE_MS: '24000000' })).resolution_deadline_ms).toBe(24_000_000);
    expect(disputeOf(completeEnv({ DISPUTE_STARTED_LEASE_MS: ' ', DISPUTE_RESOLUTION_DEADLINE_MS: '' }))).toStrictEqual({ challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 600_000, read_timeout_ms: 20_000 });
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
