// agents/sourcing-agent/test/serve/settings.test.ts
// The settings of the Sourcing Agent that name no key. Every reader has a table of its refusals, and each refusal has an accepted twin, the same variable with a value that the rule takes. A refusal names the
// variable and never repeats a value that could be a secret: a key of 64 hex characters in the wrong line is never in a message. The limits of the two kinds of hire are bigints of more than 0, and a limit that is
// not set is never "no limit". The three scorers are three agents, and none is the agent. The numbers of the service agree with each other: the deadline of a job, the timeout of the runtime and the window of the advert.
import { describe, expect, test } from 'vitest';
import { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from '@vsa/buyer-core';
import { REGISTRY_POLICY } from '@vsa/vector-read';
import {
  BUYER_BOND_LOVELACE, GATEWAY_DEFAULT, HOST_DEFAULT, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, PRICE_DEFAULT_LOVELACE, STATE_DIR_DEFAULT, SUPPLIER_BOND_LOVELACE, agentDidOf,
  complianceIssuerOf, cosignSettingsOf, disputeOf, endpointsFromEnv, faultOf, hostOf, httpsOriginOf, limitsOf, mockBasesOf, modelOf, module1SourceOf, portOf, priceOf, processingWindowOf, quoteLimitsOf,
  scorerDidsOf, stateDirOf, supplierKeyOf,
} from '../../src/serve/settings.ts';
import { AGENT_DID, ISSUER, MODULE1_COMMIT, MODULE1_URL, PRINCIPAL, SCORER_DIDS, SUPPLIER, completeEnv, messageOf, rawKey } from './support.ts';

/** A key in the wrong line: 64 hex characters. No message shows it, whole or in part of a longer value. */
const SECRET = rawKey(77);

/** One refusal and its accepted twin: the variable with a value that breaks the rule, and the same variable with a value that the rule takes. */
interface Row {
  readonly what: string;
  readonly read: (env: NodeJS.ProcessEnv) => unknown;
  readonly variable: string;
  readonly bad: string | undefined;
  readonly good: string;
}

/** The rows of one variable: each wrong value, with what is wrong, and the one twin that the rule takes. */
const rowsOf = (variable: string, read: Row['read'], good: string, wrong: readonly (readonly [what: string, bad: string | undefined])[]): Row[] =>
  wrong.map(([what, bad]) => ({ what, read, variable, bad, good }));

/**
 * Runs one row. The refusal names the variable and never shows the secret. A message may show a short plain value (the rule of `shown` of the service kit), so only a value of more than 24 characters is held
 * to be hidden, whole. Then the twin passes.
 */
function checkRow(row: Row): void {
  const message = messageOf(() => row.read(completeEnv({ [row.variable]: row.bad })));
  expect(message).toContain(row.variable);
  expect(message).not.toContain(SECRET);
  if (row.bad !== undefined && row.bad.length > 24) expect(message).not.toContain(row.bad);
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
  const twin = (hex: string) => `did:vector:${hex.repeat(32)}`;
  const DID_ROWS: Row[] = [
    { variable: 'AGENT_DID', read: agentDidOf },
    { variable: 'SCORER_1_DID', read: scorerDidsOf },
    { variable: 'SCORER_2_DID', read: scorerDidsOf },
    { variable: 'SCORER_3_DID', read: scorerDidsOf },
  ].flatMap(({ variable, read }) => rowsOf(variable, read, twin('c3'), [
    ['a DID that is not set', undefined],
    ['a DID that is blank', '  '],
    ['a DID with 62 hex characters and a key in the line', `did:vector:${SECRET.slice(2)}`],
    ['a DID with 63 hex characters', `did:vector:${'c3'.repeat(31)}c`],
    ['a DID with upper-case hex', `did:vector:${'C3'.repeat(32)}`],
    ['the DID of another method', 'did:web:agent.example'],
    ['a text that is no DID', 'nope'],
    ['a key in the line', SECRET],
  ]));
  test.each(DID_ROWS)('$variable: $what stops the start by its name, and the twin passes', checkRow);

  test('a message gives the length of the value and never the value', () => {
    const wrong = messageOf(() => agentDidOf(completeEnv({ AGENT_DID: `did:vector:${SECRET.slice(2)}` })));
    expect(wrong).toMatch(/^environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters/);
    expect(wrong).toContain(`${`did:vector:${SECRET.slice(2)}`.length} characters`);
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
    // A legacy form of an identifier that a sibling holds is that DID: the check below holds after the form is made canonical.
    expect(messageOf(() => scorerDidsOf(completeEnv({ SCORER_3_DID: legacy })))).toContain('SCORER_3_DID');
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
    expect(() => scorerDidsOf(completeEnv({ SCORER_1_DID: twin('d1'), SCORER_2_DID: twin('d2'), SCORER_3_DID: twin('d3') }))).not.toThrow();
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
  const FAULT_ROWS: Row[] = rowsOf('FAULT_MODE', faultOf, 'invert_scores', [
    ['the fault value of the Order Desk', 'confirm_wrong_lot'],
    ['the fault value of the Prior Authorization Agent', 'alter_after_approval'],
    ['the fault value of the Bid Desk', 'quote_off_price_list'],
    ['the right value in upper case', 'INVERT_SCORES'],
    ['the right value with a space before it', ' invert_scores'],
    ['the right value with a space after it', 'invert_scores '],
    ['a text that is no fault value', 'anything'],
    ['a key in the line', SECRET],
  ]);
  test.each(FAULT_ROWS)('$variable: $what stops the start by its name, and the twin passes', checkRow);

  test('is empty or invert_scores, and the mode is the value that was read', () => {
    expect(faultOf(completeEnv()).mode).toBe('');
    expect(faultOf(completeEnv({ FAULT_MODE: '' })).mode).toBe('');
    expect(faultOf(completeEnv({ FAULT_MODE: 'invert_scores' })).mode).toBe('invert_scores');
    expect(faultOf(completeEnv({ FAULT_MODE: 'invert_scores' })).kind).toBe('sourcing-agent');
  });

  test('a message names the allowed values and the agent, and never shows a long value', () => {
    for (const value of ['confirm_wrong_lot', 'anything', 'zq9'.repeat(20)]) {
      const message = messageOf(() => faultOf(completeEnv({ FAULT_MODE: value })));
      expect(message).toMatch(/^environment variable FAULT_MODE must be empty or "invert_scores" for sourcing-agent/);
      expect(message).not.toContain('zq9'.repeat(20));
    }
  });
});

describe('the listener and the state', () => {
  const LISTENER_ROWS: Row[] = [
    ...rowsOf('PORT', portOf, '9200', [['a port above 65535', '70000'], ['a port that is no number', 'x'], ['a port with a fraction', '92.5'], ['a negative port', '-1'], ['a key in the line', SECRET]]),
    ...rowsOf('HOST', hostOf, '127.0.0.1', [['a host with a space', 'a b'], ['a host with a path', 'host/path'], ['a host of 254 characters', 'a'.repeat(254)]]),
  ];
  test.each(LISTENER_ROWS)('$variable: $what stops the start by its name, and the twin passes', checkRow);

  test('the port, the host and the state directory have their defaults, and the edges of the port are taken', () => {
    expect(portOf({})).toBe(9105);
    expect(portOf({ PORT: '9200' })).toBe(9200);
    expect(portOf({ PORT: '0' })).toBe(0);
    expect(portOf({ PORT: '65535' })).toBe(65_535);
    expect(messageOf(() => portOf({ PORT: '70000' }))).toMatch(/^environment variable PORT must be a port from 0 to 65535/);
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
  const ADVERT_ROWS: Row[] = [
    ...rowsOf('ADVERT_MAX_PROCESSING_MS', processingWindowOf, '3600000', [
      ['a window of 3,599,999 ms', '3599999'], ['the old window of 1,800,000 ms', '1800000'], ['a window of 0', '0'], ['a window that is no number', 'x'], ['a window with a fraction', '3600000.5'],
      ['a negative window', '-3600000'], ['a key in the line', SECRET],
    ]),
    ...rowsOf('ADVERT_PRICE_LOVELACE', priceOf, '4000000', [
      ['a price of 0', '0'], ['a negative price', '-1'], ['a price with a fraction', '3.5'], ['a price that is no number', 'x'], ['a key in the line', SECRET],
    ]),
  ];
  test.each(ADVERT_ROWS)('$variable: $what stops the start by its name, and the twin passes', checkRow);

  test('the window is at least 3,600,000 ms with that default, and the price is a whole number of lovelace of more than 0 with the default 3,000,000', () => {
    expect(processingWindowOf({})).toBe(3_600_000);
    expect(processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '3600000' })).toBe(3_600_000);
    expect(processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '4200000' })).toBe(4_200_000);
    expect(processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '' })).toBe(3_600_000);
    expect(messageOf(() => processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '3599999' }))).toMatch(/^environment variable ADVERT_MAX_PROCESSING_MS must be at least 3600000/);
    expect(priceOf({})).toBe(3_000_000);
    expect(priceOf({ ADVERT_PRICE_LOVELACE: '4000000' })).toBe(4_000_000);
    expect(priceOf({ ADVERT_PRICE_LOVELACE: '1' })).toBe(1);
    expect(messageOf(() => priceOf({ ADVERT_PRICE_LOVELACE: '0' }))).toMatch(/^environment variable ADVERT_PRICE_LOVELACE must be a whole number of lovelace of more than 0/);
  });
});

describe('the supplier key', () => {
  const SUPPLIER_ROWS: Row[] = [
    ...rowsOf('SUPPLIER_PKH', supplierKeyOf, SUPPLIER.keyHash, [
      ['the key hash that is not set', undefined], ['a key hash that is blank', ' '], ['a key hash that is no hex', 'zz'.repeat(28)], ['a key hash of 55 characters', SUPPLIER.keyHash.slice(1)],
      ['a key in the line of the key hash', SECRET], ['the key hash of another key', PRINCIPAL.keyHash],
    ]),
    ...rowsOf('SUPPLIER_PUB_KEY_HEX', supplierKeyOf, SUPPLIER.publicKey, [
      ['the public key that is not set', undefined], ['a public key that is no hex', 'zz'.repeat(32)], ['a public key of 63 characters', SUPPLIER.publicKey.slice(1)],
      ['a key in the line of the public key', SECRET], ['the public key of another key', PRINCIPAL.publicKey],
    ]),
  ];
  test.each(SUPPLIER_ROWS)('$variable: $what stops the start by its name, and the twin passes', checkRow);

  test('is a key hash and the public key of that hash, and a public key of another key stops the start by both names', () => {
    expect(supplierKeyOf(completeEnv())).toStrictEqual({ pkh: SUPPLIER.keyHash, pubKeyHex: SUPPLIER.publicKey });
    expect(supplierKeyOf(completeEnv({ SUPPLIER_PKH: SUPPLIER.keyHash.toUpperCase(), SUPPLIER_PUB_KEY_HEX: SUPPLIER.publicKey.toUpperCase() })).pkh).toBe(SUPPLIER.keyHash);
    for (const env of [completeEnv({ SUPPLIER_PKH: 'ab'.repeat(28) }), completeEnv({ SUPPLIER_PUB_KEY_HEX: PRINCIPAL.publicKey }), completeEnv({ SUPPLIER_PKH: PRINCIPAL.keyHash })]) {
      expect(messageOf(() => supplierKeyOf(env))).toMatch(/^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/);
    }
  });
});

describe('the issuer of the compliance attestations', () => {
  const ISSUER_ROWS: Row[] = rowsOf('COMPLIANCE_ISSUER_PKH', complianceIssuerOf, ISSUER.keyHash, [
    ['the key hash that is not set', undefined], ['a key hash that is blank', '   '], ['a key hash that is no hex', 'zz'.repeat(28)], ['a key hash of 55 characters', ISSUER.keyHash.slice(1)],
    ['a key hash of 57 characters', `${ISSUER.keyHash}a`], ['a public key of 64 characters in place of the key hash', ISSUER.publicKey], ['a key in the line', SECRET],
  ]);
  test.each(ISSUER_ROWS)('$variable: $what stops the start by its name, and the twin passes', checkRow);

  test('is 56 hex characters, given in lower case, and a value of 64 characters is refused by its length only', () => {
    expect(complianceIssuerOf(completeEnv())).toBe(ISSUER.keyHash);
    expect(complianceIssuerOf(completeEnv({ COMPLIANCE_ISSUER_PKH: ` ${ISSUER.keyHash.toUpperCase()} ` }))).toBe(ISSUER.keyHash);
    expect(messageOf(() => complianceIssuerOf(completeEnv({ COMPLIANCE_ISSUER_PKH: ISSUER.publicKey })))).toBe('environment variable COMPLIANCE_ISSUER_PKH must be 56 hex characters, and it has 64 characters');
  });
});

describe('the endpoints', () => {
  const ENDPOINT_ROWS: Row[] = [
    ...rowsOf('IDENTITY_GATEWAY_URL', endpointsFromEnv, 'https://gateway.example', [
      ['an http address', 'http://gateway.example'], ['an address with a path', 'https://gateway.example/path'], ['an address with a user', 'https://user@gateway.example'], ['a text that is no address', 'x'],
      ['a key in the line', SECRET],
    ]),
    ...rowsOf('VECTOR_OGMIOS_URL', endpointsFromEnv, 'https://node.example:1337', [
      ['an http address: the tip reader of the janitor takes https only', 'http://node.example:1337'], ['an address with a key as password', `https://user:${SECRET}@node.example`],
      ['an address of another scheme', 'ftp://node.example'], ['a text that is no address', 'x'], ['a key in the line', SECRET],
    ]),
    ...rowsOf('VECTOR_KOIOS_URL', endpointsFromEnv, 'https://koios.example', [
      ['an address with a key as password', `https://user:${SECRET}@koios.example`], ['an address of another scheme', 'ftp://koios.example'], ['a text that is no address', 'x'], ['a key in the line', SECRET],
    ]),
    ...rowsOf('VECTOR_SUBMIT_URL', endpointsFromEnv, 'http://submit.example', [
      ['an address with a key as password', `https://user:${SECRET}@submit.example`], ['an address of another scheme', 'ftp://submit.example'], ['a text that is no address', 'x'], ['a key in the line', SECRET],
    ]),
    ...rowsOf('VECTOR_MARKETPLACE_INDEXER_URL', endpointsFromEnv, 'https://indexer.example/api', [
      ['an address with a key as password', `https://user:${SECRET}@indexer.example`], ['an address of another scheme', 'ftp://indexer.example'], ['a text that is no address', 'x'], ['a key in the line', SECRET],
    ]),
  ];
  test.each(ENDPOINT_ROWS)('$variable: $what stops the start by its name, and the twin passes', checkRow);

  test('the defaults are the endpoints of Vector mainnet, and a set address is the address that was set', () => {
    expect(endpointsFromEnv({})).toStrictEqual({ gatewayUrl: GATEWAY_DEFAULT, ogmiosUrl: VECTOR_OGMIOS_URL, koiosUrl: VECTOR_KOIOS_URL, submitUrl: VECTOR_SUBMIT_URL, indexerUrl: undefined });
    const set = endpointsFromEnv({ IDENTITY_GATEWAY_URL: 'https://gateway.example', VECTOR_OGMIOS_URL: 'https://127.0.0.1:1337', VECTOR_MARKETPLACE_INDEXER_URL: 'https://indexer.example/api' });
    expect(set).toMatchObject({ gatewayUrl: 'https://gateway.example', ogmiosUrl: 'https://127.0.0.1:1337', indexerUrl: 'https://indexer.example/api' });
    expect(endpointsFromEnv({ VECTOR_SUBMIT_URL: 'http://submit.example' }).submitUrl).toBe('http://submit.example');
    expect(messageOf(() => endpointsFromEnv({ VECTOR_OGMIOS_URL: 'http://node.example:1337' }))).toMatch(/^environment variable VECTOR_OGMIOS_URL must be an https address/);
    expect(messageOf(() => endpointsFromEnv({ IDENTITY_GATEWAY_URL: 'http://gateway.example' }))).toMatch(/^environment variable IDENTITY_GATEWAY_URL must be an https origin/);
  });
});

describe('the mock service', () => {
  const MOCK_ROWS: Row[] = [
    ...rowsOf('MOCK_PUBLIC_BASE', mockBasesOf, 'https://mock.example:8443', [
      ['the base that is not set', undefined], ['a base that is blank', ' '], ['an http address', 'http://mock.example'], ['an address with a path', 'https://mock.example/path'],
      ['an address with a query', 'https://mock.example?q=1'], ['an address with a user', 'https://user@mock.example'], ['an address that ends in two slashes', 'https://mock.example//'],
      ['a text that is no address', 'x'], ['a key in the line', SECRET], ['the host of the other base', 'https://mock-mtls.example'],
    ]),
    ...rowsOf('MOCK_MTLS_BASE', mockBasesOf, 'https://other-mtls.example', [
      ['the base that is not set', undefined], ['an http address', 'http://mock-mtls.example'], ['a text that is no address', 'x'], ['a key in the line', SECRET], ['the host of the other base', 'https://mock.example'],
    ]),
  ];
  test.each(MOCK_ROWS)('$variable: $what stops the start by its name, and the twin passes', checkRow);

  test('the two bases are https origins on two hosts, and a port is part of the host', () => {
    expect(mockBasesOf(completeEnv())).toStrictEqual({ publicBase: 'https://mock.example', mtlsBase: 'https://mock-mtls.example' });
    expect(messageOf(() => mockBasesOf(completeEnv({ MOCK_MTLS_BASE: 'https://mock.example' })))).toMatch(/^environment variable MOCK_MTLS_BASE must name another host than MOCK_PUBLIC_BASE/);
    expect(mockBasesOf(completeEnv({ MOCK_MTLS_BASE: 'https://mock.example:8443' })).mtlsBase).toBe('https://mock.example:8443');
    expect(httpsOriginOf('X', 'https://host.example:8443').host).toBe('host.example:8443');
    for (const wrong of ['https://host.example/path', 'https://host.example?q=1', 'https://user@host.example', 'https://host.example//']) {
      expect(messageOf(() => httpsOriginOf('MOCK_PUBLIC_BASE', wrong))).toMatch(/^environment variable MOCK_PUBLIC_BASE must be an https origin/);
    }
  });
});

describe('the Module-1 manifest', () => {
  const MODULE1_ROWS: Row[] = rowsOf('VECTOR_MODULE1_MANIFEST', module1SourceOf, MODULE1_URL, [
    ['the address that is not set', undefined], ['an address that is blank', ' '], ['a file path', '/srv/module1.json'], ['an http address', `http://198.51.100.7/a/${MODULE1_COMMIT}/m.json`],
    ['an address with no commit', 'https://198.51.100.7/a/main/m.json'], ['an address with an upper-case commit', `https://198.51.100.7/a/${MODULE1_COMMIT.toUpperCase()}/m.json`],
    ['an address with a commit of 39 characters', `https://198.51.100.7/a/${MODULE1_COMMIT.slice(1)}/m.json`], ['an address with a query that holds a key', `${MODULE1_URL}?x=${SECRET}`],
    ['an address with a key as password', `https://user:${SECRET}@198.51.100.7/a/${MODULE1_COMMIT}/m.json`], ['an address with a fragment', `${MODULE1_URL}#top`], ['a key in the line', SECRET],
  ]);
  test.each(MODULE1_ROWS)('$variable: $what stops the start by its name, and the twin passes', checkRow);

  test('is an https address pinned to a commit, and it stays as the operator wrote it', () => {
    expect(module1SourceOf(completeEnv())).toBe(MODULE1_URL);
    expect(module1SourceOf(completeEnv({ VECTOR_MODULE1_MANIFEST: ` ${MODULE1_URL} ` }))).toBe(MODULE1_URL);
    for (const wrong of ['/srv/module1.json', `http://198.51.100.7/a/${MODULE1_COMMIT}/m.json`, 'https://198.51.100.7/a/main/m.json']) {
      expect(messageOf(() => module1SourceOf(completeEnv({ VECTOR_MODULE1_MANIFEST: wrong })))).toMatch(/^environment variable VECTOR_MODULE1_MANIFEST must be /);
    }
  });
});

describe('the limits of the two kinds of hire', () => {
  const MODEL: Row[] = [
    ...rowsOf('LLM_MODEL_ALLOWLIST', limitsOf, 'a/b, c/d', [['the models that are not set', undefined], ['a model name of a wrong form', 'a/b, c d']]),
    ...rowsOf('LLM_MAX_PRICE_LOVELACE', limitsOf, '250000', [
      ['the price ceiling that is not set', undefined], ['a price ceiling that is no number', 'x'], ['a price ceiling of 0', '0'], ['a key in the line', SECRET],
    ]),
    ...rowsOf('LLM_MAX_SUPPLIER_BOND_LOVELACE', limitsOf, '15', [
      ['the supplier bond limit that is not set', undefined], ['a supplier bond limit with a fraction', '1.5'], ['a supplier bond limit of 0', '0'], ['a key in the line', SECRET],
    ]),
    ...rowsOf('LLM_MAX_BUYER_BOND_LOVELACE', limitsOf, '0001', [
      ['the buyer bond limit that is blank', '  '], ['a buyer bond limit that is negative', '-1'], ['a buyer bond limit that is the word null', 'null'], ['a key in the line', SECRET],
    ]),
  ];

  /** The three limits of the hire of a quote, each with every wrong form of a limit: not set, blank, a word, null, zero, negative, a fraction, an exponent, hex, a sign, and a number that a number cannot hold. */
  const QUOTE: Row[] = ['QUOTE_MAX_PRICE_LOVELACE', 'QUOTE_MAX_SUPPLIER_BOND_LOVELACE', 'QUOTE_MAX_BUYER_BOND_LOVELACE'].flatMap((variable) => rowsOf(variable, quoteLimitsOf, '5000000', [
    ['a limit that is not set', undefined], ['a limit that is blank', '   '], ['a limit that is empty', ''], ['a limit that is a word', 'x'], ['a limit that is the word null', 'null'],
    ['a limit that is the word undefined', 'undefined'], ['a limit of 0', '0'], ['a limit that is negative', '-1'], ['a limit with a fraction', '1.5'], ['a limit in exponent form', '1e6'],
    ['a limit in hex form', '0x10'], ['a limit with a sign', '+5'], ['a limit that is infinity', 'Infinity'], ['a limit that no number holds exactly', '9007199254740993'], ['a key in the line', SECRET],
  ]));

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

  test('a limit of the quote hire is no limit of the model hire: each kind reads its own variables and no other', () => {
    expect(messageOf(() => quoteLimitsOf(completeEnv({ QUOTE_MAX_BUYER_BOND_LOVELACE: undefined, LLM_MAX_BUYER_BOND_LOVELACE: '2000000' })))).toContain('QUOTE_MAX_BUYER_BOND_LOVELACE');
    expect(messageOf(() => limitsOf(completeEnv({ LLM_MAX_BUYER_BOND_LOVELACE: undefined, QUOTE_MAX_BUYER_BOND_LOVELACE: '2000000' })))).toContain('LLM_MAX_BUYER_BOND_LOVELACE');
  });
});

describe('the settings of the dispute code', () => {
  const DISPUTE_ROWS: Row[] = [
    ...rowsOf('DISPUTE_CHALLENGE_STAKE_LOVELACE', disputeOf, '50000000', [
      ['the stake that is not set', undefined], ['a stake of 0', '0'], ['a negative stake', '-1'], ['a stake with a fraction', '1.5'], ['a stake that is no number', 'x'], ['a key in the line', SECRET],
    ]),
    ...rowsOf('DISPUTE_MIN_WINDOW_LEFT_MS', disputeOf, '2000', [
      ['the least window that is not set', undefined], ['a least window of 1,999 ms', '1999'], ['a negative least window', '-1'], ['a least window that is no number', 'x'], ['a key in the line', SECRET],
    ]),
    ...rowsOf('DISPUTE_READ_TIMEOUT_MS', disputeOf, '1', [['the bound of a read that is not set', undefined], ['a bound of 0', '0'], ['a bound that is no number', 'x'], ['a key in the line', SECRET]]),
    ...rowsOf('DISPUTE_STARTED_LEASE_MS', disputeOf, '40000', [['a lease of 39,999 ms, below twice the bound of a read', '39999'], ['a lease that is no number', 'x'], ['a key in the line', SECRET]]),
    ...rowsOf('DISPUTE_RESOLUTION_DEADLINE_MS', disputeOf, '24000000', [['a deadline of 1,000 ms', '1000'], ['a deadline that is no number', 'x'], ['a key in the line', SECRET]]),
  ];
  test.each(DISPUTE_ROWS)('$variable: $what stops the start by its name, and the twin passes', checkRow);

  test('the stake, the least window left and the bound of a read are required, and the lease and the resolution deadline are optional', () => {
    expect(disputeOf(completeEnv())).toStrictEqual({ challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 600_000, read_timeout_ms: 20_000 });
    expect(disputeOf(completeEnv({ DISPUTE_MIN_WINDOW_LEFT_MS: '2000' })).min_window_left_ms).toBe(2_000);
    expect(disputeOf(completeEnv({ DISPUTE_READ_TIMEOUT_MS: '1' })).read_timeout_ms).toBe(1);
    const both = disputeOf(completeEnv({ DISPUTE_STARTED_LEASE_MS: '600000', DISPUTE_RESOLUTION_DEADLINE_MS: '24000000' }));
    expect(both).toMatchObject({ started_lease_ms: 600_000, resolution_deadline_ms: 24_000_000 });
    expect(disputeOf(completeEnv({ DISPUTE_STARTED_LEASE_MS: ' ', DISPUTE_RESOLUTION_DEADLINE_MS: '' }))).toStrictEqual({ challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 600_000, read_timeout_ms: 20_000 });
    expect(messageOf(() => disputeOf(completeEnv({ DISPUTE_CHALLENGE_STAKE_LOVELACE: '0' })))).toMatch(/^environment variable DISPUTE_CHALLENGE_STAKE_LOVELACE must be a whole number of lovelace of more than 0/);
    expect(messageOf(() => disputeOf(completeEnv({ DISPUTE_MIN_WINDOW_LEFT_MS: '1999' })))).toMatch(/^environment variable DISPUTE_MIN_WINDOW_LEFT_MS must be a whole number of milliseconds of at least 2000/);
    expect(messageOf(() => disputeOf(completeEnv({ DISPUTE_STARTED_LEASE_MS: '39999' })))).toMatch(/^environment variable DISPUTE_STARTED_LEASE_MS must be a whole number of milliseconds of at least 40000/);
    expect(messageOf(() => disputeOf(completeEnv({ DISPUTE_RESOLUTION_DEADLINE_MS: '1000' })))).toMatch(/^environment variable DISPUTE_RESOLUTION_DEADLINE_MS must be a whole number of milliseconds of at least 24000000/);
  });
});

describe('the settings of the co-sign route', () => {
  const COSIGN_ROWS: Row[] = [
    ...rowsOf('COSIGN_ALLOWLIST', cosignSettingsOf, PRINCIPAL.keyHash, [
      ['the allowlist that is not set', undefined], ['an entry that is no key hash', 'x'], ['an entry that is a key of 64 characters', SECRET], ['a good entry and then a bad one', `${PRINCIPAL.keyHash}\nx`],
      ['an entry of 55 characters', PRINCIPAL.keyHash.slice(1)],
    ]),
    ...rowsOf('COSIGN_MAX_CONCURRENT', cosignSettingsOf, '64', [['more than 64 requests', '65'], ['0 requests', '0'], ['a limit that is no number', 'x'], ['a limit with a fraction', '1.5'], ['a key in the line', SECRET]]),
    ...rowsOf('COSIGN_MAX_FUTURE_MS', cosignSettingsOf, '60000', [['a window of 59,999 ms', '59999'], ['a window of 3,600,001 ms', '3600001'], ['a window that is no number', 'x'], ['a key in the line', SECRET]]),
    ...rowsOf('COSIGN_LEDGER_TIMEOUT_MS', cosignSettingsOf, '50', [['a timeout of 49 ms', '49'], ['a timeout of 30,001 ms', '30001'], ['a timeout that is no number', 'x'], ['a key in the line', SECRET]]),
  ];
  test.each(COSIGN_ROWS)('$variable: $what stops the start by its name, and the twin passes', checkRow);

  test('the allowlist is required: the empty text holds nobody and is allowed, and a list may have notes and several entries on a line', () => {
    const settings = cosignSettingsOf(completeEnv());
    expect(settings.allowlist.has(PRINCIPAL.keyHash)).toBe(true);
    expect(settings).toMatchObject({ maxConcurrent: 4, maxFutureMs: 3_600_000, ledgerTimeoutMs: 5_000 });
    expect(cosignSettingsOf(completeEnv({ COSIGN_ALLOWLIST: '' })).allowlist.size).toBe(0);
    expect(messageOf(() => cosignSettingsOf(completeEnv({ COSIGN_ALLOWLIST: undefined })))).toMatch(/COSIGN_ALLOWLIST is not set/);
    expect(messageOf(() => cosignSettingsOf(completeEnv({ COSIGN_ALLOWLIST: `${PRINCIPAL.keyHash}, x` })))).toMatch(
      /^environment variable COSIGN_ALLOWLIST is refused: the allowlist has an entry on line 1 that is not a key hash/,
    );
    expect(cosignSettingsOf(completeEnv({ COSIGN_ALLOWLIST: `${PRINCIPAL.keyHash}\n# a note\n${SUPPLIER.keyHash}` })).allowlist.size).toBe(2);
  });

  test('each limit takes its range, and a blank limit takes the default', () => {
    expect(cosignSettingsOf(completeEnv({ COSIGN_MAX_CONCURRENT: '8', COSIGN_MAX_FUTURE_MS: '120000', COSIGN_LEDGER_TIMEOUT_MS: '1000' }))).toMatchObject({ maxConcurrent: 8, maxFutureMs: 120_000, ledgerTimeoutMs: 1_000 });
    expect(cosignSettingsOf(completeEnv({ COSIGN_MAX_CONCURRENT: ' ', COSIGN_MAX_FUTURE_MS: '', COSIGN_LEDGER_TIMEOUT_MS: ' ' }))).toMatchObject({ maxConcurrent: 4, maxFutureMs: 3_600_000, ledgerTimeoutMs: 5_000 });
  });
});
