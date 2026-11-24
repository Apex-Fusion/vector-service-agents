// agents/bid-desk/test/serve/settings.test.ts
// How the Bid Desk reads its environment: the three price list files with their pinned hashes, the instance that selects one of them, every refusal of a reader with its accepted twin, the time of the hook,
// the limits of the model hire, the defaults, and the constants. A message names the variable and never shows a value that could be a secret. No test here starts a service or uses the network.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from '@vsa/buyer-core';
import { PRICE_LIST_SCHEMA, parsePriceList, priceFor } from '@vsa/usecase-kit/bids';
import { REGISTRY_POLICY, legacyVectorDid } from '@vsa/vector-read';
import {
  BOND_LOVELACE, CALL_TIMEOUT_MS, CHECKS_READ_BUDGET_DEFAULT_MS, CHECKS_READ_BUDGET_MAX_MS, CHECKS_READ_BUDGET_MIN_MS, GATEWAY_DEFAULT, HOOK_READS, HOOK_READS_LIMIT_MS, HOST_DEFAULT, INSTANCES,
  INSTANCE_NAMES, JOB_DEADLINE_MS, MAX_PROCESSING_WINDOW_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, PRICE_LIST_ROUTE, PRICE_LOVELACE, RUNTIME_PRECHECK_WAIT_MS, STATE_DIR_DEFAULT, agentDidOf, checksBudgetOf, endpointsFromEnv,
  faultOf, hostOf, instanceOf, limitsOf, organisationOf, portOf, priceListFileOf, processingWindowOf, publicOriginOf, stateDirOf, supplierKeyOf,
} from '../../src/serve/settings.ts';
import type { Instance } from '../../src/serve/settings.ts';
import { AGENT_DID, FULL_ENV, ORGANISATION, ORIGIN, PRICE_LIST_SHA256, SERVICE, SUPPLIER, envWith, message, priceListOf, priceListUrl, shows } from './support.ts';

const SKUS = ['GLV-NIT-M', 'SYR-10ML', 'MSK-N95'];
/** The stand-in numbers of each file: for each SKU, the lead time in days and then the unit price at the quantities 1, 100 and 500. */
const NUMBERS: Readonly<Record<Instance, Readonly<Record<string, readonly number[]>>>> = {
  alfa: { 'GLV-NIT-M': [14, 140, 125, 110], 'SYR-10ML': [10, 32, 28, 24], 'MSK-N95': [21, 60, 52, 46] },
  bravo: { 'GLV-NIT-M': [10, 148, 132, 118], 'SYR-10ML': [8, 34, 30, 26], 'MSK-N95': [18, 64, 56, 50] },
  charlie: { 'GLV-NIT-M': [21, 130, 115, 102], 'SYR-10ML': [14, 29, 25, 22], 'MSK-N95': [28, 56, 48, 42] },
};

describe.each(INSTANCES)('the price list file of %s', (instance) => {
  const { text, sha256 } = priceListOf(instance);
  const parsed = parsePriceList(JSON.parse(text));

  test('is a price list of the kit, with the three SKUs of the catalogue of the mock service, their lead times and the prices at the quantities 1, 100 and 500', () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.schema).toBe(PRICE_LIST_SCHEMA);
    expect(parsed.value.items.map((entry) => entry.sku)).toStrictEqual(SKUS);
    const seen = Object.fromEntries(parsed.value.items.map((entry) => [entry.sku, [entry.lead_time_days, ...entry.breaks.map((step) => step.unit_price)]]));
    expect(seen).toStrictEqual(NUMBERS[instance]);
    for (const entry of parsed.value.items) expect(entry.breaks.map((step) => step.min_quantity), entry.sku).toStrictEqual([1, 100, 500]);
  });

  test('has no unit price under 10, and the price falls at each break', () => {
    // The fault of a Bid Desk lowers one listed price, and it needs a listed price of 2 or more to leave a whole price of 1 or more. A price of 10 or more leaves room.
    if (!parsed.ok) throw new Error('the file is not a price list');
    for (const entry of parsed.value.items) {
      const prices = entry.breaks.map((step) => step.unit_price);
      expect(Math.min(...prices), entry.sku).toBeGreaterThanOrEqual(10);
      expect(prices, entry.sku).toStrictEqual([...prices].sort((a, b) => b - a));
      expect(new Set(prices).size, entry.sku).toBe(prices.length);
    }
  });

  test('gives the listed price and lead time at the edge of each break, and nothing for a SKU that it does not list', () => {
    if (!parsed.ok) throw new Error('the file is not a price list');
    for (const [sku, [lead, one, hundred, fiveHundred]] of Object.entries(NUMBERS[instance])) {
      for (const [quantity, price] of [[1, one], [99, one], [100, hundred], [499, hundred], [500, fiveHundred], [1_000_000, fiveHundred]] as const) {
        expect(priceFor(parsed.value, sku, quantity), `${sku} x ${quantity}`).toStrictEqual({ unit_price: price, lead_time_days: lead });
      }
    }
    expect(priceFor(parsed.value, 'NOT-A-SKU', 1)).toBeNull();
  });

  test('has the pinned SHA-256, as node:crypto hashes its bytes, and is written as a service serves it: indented JSON, one line break at the end, no carriage return', () => {
    expect(sha256).toBe(PRICE_LIST_SHA256[instance]);
    expect(createHash('sha256').update(readFileSync(priceListUrl(instance))).digest('hex')).toBe(PRICE_LIST_SHA256[instance]);
    expect(text.startsWith('{\n  "schema"')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).not.toContain('\r');
    expect(text).not.toContain('\t');
  });
});

describe('the three price list files together', () => {
  test('differ: three texts, three hashes, and each file differs from the others in every lead time and every price', () => {
    expect(new Set(Object.values(PRICE_LIST_SHA256)).size).toBe(3);
    expect(new Set(INSTANCES.map((instance) => priceListOf(instance).text)).size).toBe(3);
    for (const sku of SKUS) {
      for (const slot of [0, 1, 2, 3]) expect(new Set(INSTANCES.map((instance) => NUMBERS[instance][sku][slot])).size, `${sku} slot ${slot}`).toBe(3);
    }
  });
});

describe('the instance', () => {
  test('is one of three, and each has its name', () => {
    expect([...INSTANCES]).toStrictEqual(['alfa', 'bravo', 'charlie']);
    expect(INSTANCE_NAMES).toStrictEqual({ alfa: 'Bid Desk Alfa', bravo: 'Bid Desk Bravo', charlie: 'Bid Desk Charlie' });
    for (const instance of INSTANCES) expect(instanceOf({ BID_DESK_INSTANCE: instance })).toBe(instance);
    expect(instanceOf({ BID_DESK_INSTANCE: ' bravo\n' })).toBe('bravo');
  });

  test.each(INSTANCES)('%s selects the file price-lists/%s.json of the package: the path, and the bytes with the pinned hash', (instance) => {
    expect(priceListFileOf(instance)).toBe(fileURLToPath(priceListUrl(instance)));
    expect(priceListFileOf(instance).endsWith(`/agents/bid-desk/price-lists/${instance}.json`)).toBe(true);
    expect(createHash('sha256').update(readFileSync(priceListFileOf(instance))).digest('hex')).toBe(PRICE_LIST_SHA256[instance]);
  });

  test('makes a file name from one of the three words only: any other text is a TypeError, whatever it holds', () => {
    for (const bad of ['delta', '../alfa', 'alfa/../bravo', 'ALFA', '', 'alfa.json']) expect(() => priceListFileOf(bad as Instance), bad).toThrow(TypeError);
  });
});

type Reader = (env: NodeJS.ProcessEnv) => unknown;
/** The reader that takes each setting of this part, so that a row of the table names the setting and not the function. */
const READ: Readonly<Record<string, Reader>> = {
  BID_DESK_INSTANCE: instanceOf, BID_DESK_ORGANISATION: organisationOf, BID_DESK_PUBLIC_ORIGIN: publicOriginOf, CHECKS_READ_BUDGET_MS: checksBudgetOf, ADVERT_MAX_PROCESSING_MS: processingWindowOf,
  FAULT_MODE: faultOf, PORT: portOf, HOST: hostOf, AGENT_DID: agentDidOf, SUPPLIER_PKH: supplierKeyOf, SUPPLIER_PUB_KEY_HEX: supplierKeyOf,
  IDENTITY_GATEWAY_URL: endpointsFromEnv, VECTOR_OGMIOS_URL: endpointsFromEnv, VECTOR_KOIOS_URL: endpointsFromEnv, VECTOR_SUBMIT_URL: endpointsFromEnv, VECTOR_MARKETPLACE_INDEXER_URL: endpointsFromEnv,
  LLM_MODEL_ALLOWLIST: limitsOf, LLM_MAX_PRICE_LOVELACE: limitsOf, LLM_MAX_SUPPLIER_BOND_LOVELACE: limitsOf, LLM_MAX_BUYER_BOND_LOVELACE: limitsOf,
};

/** One refusal: the setting, the value that is refused (undefined: not set), the message, and a value of the same setting that is accepted (the twin). */
type Row = readonly [setting: string, bad: string | undefined, refusal: string | RegExp, good: string | undefined];
const ANOTHER_DID = `did:vector:${'ab'.repeat(32)}`;
const instanceRule = (text: string): string => `environment variable BID_DESK_INSTANCE must be alfa, bravo or charlie, and it has ${text.length} characters`;
const organisationRule = (text: string): string =>
  `environment variable BID_DESK_ORGANISATION must be a domain name in lower case with at least two labels and at most 64 characters, and it has ${text.length} characters`;
const originRule = (text: string): string => `environment variable BID_DESK_PUBLIC_ORIGIN must be an https origin with no user, path, query or fragment, and it has ${text.length} characters`;
const SIXTY_FOUR = `${'a'.repeat(60)}.org`;
const REFUSALS: readonly Row[] = [
  ['BID_DESK_INSTANCE', undefined, /^environment variable BID_DESK_INSTANCE is required \(.*\) and is not set$/, 'bravo'],
  ['BID_DESK_INSTANCE', '', /^environment variable BID_DESK_INSTANCE is required/, 'charlie'],
  ['BID_DESK_INSTANCE', '  ', /^environment variable BID_DESK_INSTANCE is required/, 'alfa'],
  ...['delta', 'Alfa', 'ALFA', 'alfa bravo', 'alfa,bravo', 'bid-desk-alfa', 'alfa.json', '../alfa', 'all', '1'].map((bad): Row => ['BID_DESK_INSTANCE', bad, instanceRule(bad), 'alfa']),
  ['BID_DESK_ORGANISATION', undefined, /^environment variable BID_DESK_ORGANISATION is required \(.*\) and is not set$/, ORGANISATION],
  ['BID_DESK_ORGANISATION', '   ', /^environment variable BID_DESK_ORGANISATION is required/, ORGANISATION],
  ...[
    'alfa', 'Alfa.example.org', 'alfa..example.org', '.alfa.example.org', 'alfa.example.org.', '-alfa.example.org', 'alfa-.example.org', 'alfa_x.example.org', 'alfa example.org', 'https://alfa.example.org',
    'alfa.example.org/x', 'alfa.example.org:8443', `${'a'.repeat(61)}.org`, `${'a'.repeat(64)}.org`,
  ].map((bad): Row => ['BID_DESK_ORGANISATION', bad, organisationRule(bad), 'alfa.example.org']),
  ['BID_DESK_PUBLIC_ORIGIN', undefined, /^environment variable BID_DESK_PUBLIC_ORIGIN is required \(.*\) and is not set$/, ORIGIN],
  ['BID_DESK_PUBLIC_ORIGIN', '', /^environment variable BID_DESK_PUBLIC_ORIGIN is required/, ORIGIN],
  ...[
    'http://bids-alfa.example.test', 'https://bids-alfa.example.test/price-list.json', 'https://bids-alfa.example.test/x', 'https://bids-alfa.example.test?x=1', 'https://bids-alfa.example.test/?',
    'https://bids-alfa.example.test/#', 'https://bids-alfa.example.test#top', 'https://user@bids-alfa.example.test', 'https://user:password@bids-alfa.example.test', 'bids-alfa.example.test', 'https://',
    'bids-alfa', 'https://bids-alfa.example.test//', '/srv/bids', 'ftp://bids-alfa.example.test',
  ].map((bad): Row => ['BID_DESK_PUBLIC_ORIGIN', bad, originRule(bad), ORIGIN]),
  ['CHECKS_READ_BUDGET_MS', '499', 'environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 2249, got 499', '500'],
  [
    'CHECKS_READ_BUDGET_MS', '2250',
    'environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 2249, got 2250: the hook makes 4 timed reads one after the other, so it can take 9000 ms, and the runtime waits 10000 ms for it. 4 times the budget must be under 9000 ms',
    '2249',
  ],
  ['CHECKS_READ_BUDGET_MS', '4000', /^environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 2249, got 4000: .* it can take 16000 ms, /, '1200'],
  ['CHECKS_READ_BUDGET_MS', 'fast', 'environment variable CHECKS_READ_BUDGET_MS must be a non-negative integer, got "fast"', '1200'],
  ['ADVERT_MAX_PROCESSING_MS', '479999', /^environment variable ADVERT_MAX_PROCESSING_MS must be at least 480000 .* got 479999$/, '480000'],
  ['ADVERT_MAX_PROCESSING_MS', '86400001', 'environment variable ADVERT_MAX_PROCESSING_MS must be at most 86400000 (24 h, the longest window that a Post accepts), got 86400001', '86400000'],
  ['ADVERT_MAX_PROCESSING_MS', '9007199254740991', /^environment variable ADVERT_MAX_PROCESSING_MS must be at most 86400000 .* got 9007199254740991$/, '86400000'],
  ['ADVERT_MAX_PROCESSING_MS', 'long', 'environment variable ADVERT_MAX_PROCESSING_MS must be a non-negative integer, got "long"', '900000'],
  ['FAULT_MODE', 'confirm_wrong_lot', 'environment variable FAULT_MODE must be empty or "quote_off_price_list" for bid-desk, got "confirm_wrong_lot"', 'quote_off_price_list'],
  ['FAULT_MODE', 'alter_after_approval', 'environment variable FAULT_MODE must be empty or "quote_off_price_list" for bid-desk, got "alter_after_approval"', ''],
  ['FAULT_MODE', 'invert_scores', 'environment variable FAULT_MODE must be empty or "quote_off_price_list" for bid-desk, got "invert_scores"', 'quote_off_price_list'],
  ['FAULT_MODE', 'quote_off_price_list ', /^environment variable FAULT_MODE must be empty or "quote_off_price_list" for bid-desk, got /, ''],
  ['FAULT_MODE', 'QUOTE_OFF_PRICE_LIST', /^environment variable FAULT_MODE must be empty or "quote_off_price_list" for bid-desk, got /, 'quote_off_price_list'],
  ['FAULT_MODE', 'yes', 'environment variable FAULT_MODE must be empty or "quote_off_price_list" for bid-desk, got "yes"', undefined],
  ['PORT', '70000', 'environment variable PORT must be a port from 0 to 65535, got "70000"', '0'],
  ['PORT', 'abc', 'environment variable PORT must be a non-negative integer, got "abc"', '9106'],
  ['HOST', 'bad host!', 'environment variable HOST must be an address or a host name, got "bad host!"', '127.0.0.1'],
  ['AGENT_DID', undefined, /^environment variable AGENT_DID is required/, ANOTHER_DID],
  ['AGENT_DID', 'did:vector:xyz', 'environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters, and it has 14 characters', ANOTHER_DID],
  ['AGENT_DID', 'someone', 'environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters, and it has 7 characters', ANOTHER_DID],
  ['AGENT_DID', `did:vector:${'AB'.repeat(32)}`, 'environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters, and it has 75 characters', ANOTHER_DID],
  ['IDENTITY_GATEWAY_URL', 'http://gateway.example.test', /^environment variable IDENTITY_GATEWAY_URL must be an https origin with no user, path, query or fragment, and it has 27 characters$/, 'https://gateway.example.test'],
  ['VECTOR_OGMIOS_URL', 'ftp://node.example.test', 'environment variable VECTOR_OGMIOS_URL must be an http or https address with no user and no password, and it has 23 characters', 'http://127.0.0.1:1337'],
  ['VECTOR_OGMIOS_URL', 'not an address', 'environment variable VECTOR_OGMIOS_URL must be an http or https address, and it has 14 characters', 'https://ogmios.example.test'],
  ['VECTOR_KOIOS_URL', 'https://user:password@koios.example.test', /^environment variable VECTOR_KOIOS_URL must be an http or https address with no user and no password/, 'https://koios.example.test'],
  ['VECTOR_SUBMIT_URL', 'submit.example.test', /^environment variable VECTOR_SUBMIT_URL must be an http or https address/, 'https://submit.example.test/api/submit/tx'],
  ['VECTOR_MARKETPLACE_INDEXER_URL', 'mailto:ops@example.test', /^environment variable VECTOR_MARKETPLACE_INDEXER_URL must be an http or https address/, 'https://indexer.example.test'],
  ['LLM_MODEL_ALLOWLIST', undefined, /^environment variable LLM_MODEL_ALLOWLIST is required/, 'a/one, b/two'],
  ['LLM_MODEL_ALLOWLIST', 'deepseek/deepseek-v4-flash free', 'environment variable LLM_MODEL_ALLOWLIST entry 1 must be a model name (letters, digits, dots, underscores, colons, slashes and hyphens)', 'deepseek/deepseek-v4-flash:free'],
  ['LLM_MODEL_ALLOWLIST', ' , ', 'environment variable LLM_MODEL_ALLOWLIST must name at least one model, as a comma-separated list', 'a/one'],
  ['LLM_MAX_PRICE_LOVELACE', undefined, /^environment variable LLM_MAX_PRICE_LOVELACE is required/, '250000'],
  ['LLM_MAX_PRICE_LOVELACE', '1.5', 'environment variable LLM_MAX_PRICE_LOVELACE must be a whole number of lovelace of at least 0, written in digits', '250000'],
  ['LLM_MAX_SUPPLIER_BOND_LOVELACE', undefined, /^environment variable LLM_MAX_SUPPLIER_BOND_LOVELACE is required/, '1000000'],
  ['LLM_MAX_SUPPLIER_BOND_LOVELACE', '0', 'environment variable LLM_MAX_SUPPLIER_BOND_LOVELACE must be a whole number of lovelace of more than 0, written in digits, and it has 1 characters', '1000000'],
  ['LLM_MAX_BUYER_BOND_LOVELACE', undefined, /^environment variable LLM_MAX_BUYER_BOND_LOVELACE is required/, '1000000'],
  ['LLM_MAX_BUYER_BOND_LOVELACE', 'none', /^environment variable LLM_MAX_BUYER_BOND_LOVELACE must be a whole number of lovelace of more than 0/, '1000000'],
  ['SUPPLIER_PKH', undefined, /^environment variable SUPPLIER_PKH is required/, SUPPLIER.pkh],
  ['SUPPLIER_PKH', 'ab', 'environment variable SUPPLIER_PKH must be 56 hex characters, and it has 2 characters', SUPPLIER.pkh],
  ['SUPPLIER_PKH', 'a'.repeat(56), /^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH: the key hash of the one is not the other/, SUPPLIER.pkh],
  ['SUPPLIER_PUB_KEY_HEX', undefined, /^environment variable SUPPLIER_PUB_KEY_HEX is required/, SUPPLIER.pubKeyHex],
  ['SUPPLIER_PUB_KEY_HEX', 'ab', 'environment variable SUPPLIER_PUB_KEY_HEX must be 64 hex characters, and it has 2 characters', SUPPLIER.pubKeyHex],
  ['SUPPLIER_PUB_KEY_HEX', SERVICE.pubKeyHex, /^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/, SUPPLIER.pubKeyHex],
  ['SUPPLIER_PUB_KEY_HEX', SUPPLIER.privateKeyHex, /^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/, SUPPLIER.pubKeyHex],
];

describe('every refusal of a reader, with its accepted twin', () => {
  test.each(REFUSALS)('%s = %j is refused, and the same setting with %j is accepted', (setting, bad, refusal, good) => {
    const read = READ[setting];
    if (read === undefined) throw new Error(`no reader for ${setting}`);
    const text = message(() => read(envWith({ [setting]: bad })));
    if (typeof refusal === 'string') expect(text).toBe(refusal);
    else expect(text).toMatch(refusal);
    expect(() => read(envWith({ [setting]: good })), `${setting} = ${String(good)}`).not.toThrow();
  });

  test('the table has a row for each setting of this part that a reader refuses, and a row for "not set" for each setting that is required and has no default', () => {
    const names = new Set(REFUSALS.map(([setting]) => setting));
    for (const name of names) expect(Object.keys(READ), name).toContain(name);
    for (const name of ['BID_DESK_INSTANCE', 'BID_DESK_ORGANISATION', 'BID_DESK_PUBLIC_ORIGIN', 'CHECKS_READ_BUDGET_MS', 'ADVERT_MAX_PROCESSING_MS', 'FAULT_MODE', 'PORT', 'HOST', 'AGENT_DID', 'SUPPLIER_PKH',
      'SUPPLIER_PUB_KEY_HEX', 'IDENTITY_GATEWAY_URL', 'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL', 'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE',
      'LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE']) expect(names.has(name), name).toBe(true);
    for (const name of ['BID_DESK_INSTANCE', 'BID_DESK_ORGANISATION', 'BID_DESK_PUBLIC_ORIGIN', 'AGENT_DID', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE',
      'LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE']) expect(REFUSALS.some(([setting, bad]) => setting === name && bad === undefined), name).toBe(true);
  });

  test('the full environment of the tests is accepted by every reader, so each row of the table fails by its own setting alone', () => {
    for (const [name, read] of Object.entries(READ)) expect(() => read(FULL_ENV), name).not.toThrow();
  });
});

describe('a message never shows a value that could be a secret', () => {
  const refusal = (read: Reader, env: NodeJS.ProcessEnv): string => {
    try {
      read(env);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  test('a key in the line of any setting of this part is never shown by the message that refuses the line: the length stands in its place', () => {
    const key = SERVICE.privateKeyHex;
    let refused = 0;
    for (const [name, read] of Object.entries(READ)) {
      for (const value of [key, key.toUpperCase(), `x${key}y`, `https://${key}.example.test`]) {
        const text = refusal(read, envWith({ [name]: value }));
        expect(shows(text, key), `${name} = ${value.slice(0, 12)}`).toBe(false);
        if (text !== '') refused += 1;
      }
    }
    // Most of the lines refuse a key, so that the search above looks at messages and not at silence.
    expect(refused).toBeGreaterThan(40);
  });

  test('the text readers name the variable and the length of the value, and nothing of the value itself, whatever it holds', () => {
    for (const [reader, name, bad] of [[instanceOf, 'BID_DESK_INSTANCE', 'a-very-long-and-plain-value'], [organisationOf, 'BID_DESK_ORGANISATION', 'Plain-Value'], [publicOriginOf, 'BID_DESK_PUBLIC_ORIGIN', 'http://plain.example.test']] as const) {
      const text = message(() => reader(envWith({ [name]: bad })));
      expect(text.startsWith(`environment variable ${name} must be `)).toBe(true);
      expect(text.endsWith(`, and it has ${bad.length} characters`)).toBe(true);
      expect(text.includes(bad), name).toBe(false);
    }
  });
});

describe('the readers give what they read', () => {
  test('the organisation: a domain name in lower case with at least two labels, at most 64 characters, as the sourcing record of the mock service takes it', () => {
    expect(organisationOf(FULL_ENV)).toBe(ORGANISATION);
    expect(organisationOf(envWith({ BID_DESK_ORGANISATION: ` ${SIXTY_FOUR}\n` }))).toBe(SIXTY_FOUR);
    expect(SIXTY_FOUR).toHaveLength(64);
    for (const good of ['a.b', 'a-1.b-2.c', 'alfa.vector.example.org', 'x1.y2']) expect(organisationOf(envWith({ BID_DESK_ORGANISATION: good })), good).toBe(good);
  });

  test('the public origin: an https origin as the URL parser writes it, with no trailing slash, in lower case, and a port that is not the default one stays', () => {
    expect(publicOriginOf(FULL_ENV)).toBe(ORIGIN);
    expect(publicOriginOf(envWith({ BID_DESK_PUBLIC_ORIGIN: ` ${ORIGIN}/ \n` }))).toBe(ORIGIN);
    expect(publicOriginOf(envWith({ BID_DESK_PUBLIC_ORIGIN: 'HTTPS://Bids-Alfa.Example.Test' }))).toBe(ORIGIN);
    expect(publicOriginOf(envWith({ BID_DESK_PUBLIC_ORIGIN: 'https://bids-alfa.example.test:8443' }))).toBe('https://bids-alfa.example.test:8443');
    expect(publicOriginOf(envWith({ BID_DESK_PUBLIC_ORIGIN: 'https://bids-alfa.example.test:443' }))).toBe(ORIGIN);
    expect(PRICE_LIST_ROUTE).toBe('/price-list.json');
  });

  test('the DID: in its canonical form, and the legacy form of the same identifier is the canonical one', () => {
    expect(agentDidOf(FULL_ENV)).toBe(AGENT_DID);
    expect(agentDidOf(envWith({ AGENT_DID: ` ${AGENT_DID}\n` }))).toBe(AGENT_DID);
    expect(agentDidOf(envWith({ AGENT_DID: legacyVectorDid(REGISTRY_POLICY, AGENT_DID.slice('did:vector:'.length)) }))).toBe(AGENT_DID);
  });

  test('the supplier key: the key hash and the public key, in lower case, and the two must agree', () => {
    expect(supplierKeyOf(FULL_ENV)).toStrictEqual({ pkh: SUPPLIER.pkh, pubKeyHex: SUPPLIER.pubKeyHex });
    expect(supplierKeyOf(envWith({ SUPPLIER_PKH: ` ${SUPPLIER.pkh.toUpperCase()}\n`, SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex.toUpperCase() }))).toStrictEqual({ pkh: SUPPLIER.pkh, pubKeyHex: SUPPLIER.pubKeyHex });
  });

  test('the endpoints: the defaults, and each setting that the operator gives; a blank one is not set', () => {
    expect(endpointsFromEnv(FULL_ENV)).toStrictEqual({
      gatewayUrl: GATEWAY_DEFAULT, ogmiosUrl: VECTOR_OGMIOS_URL, koiosUrl: VECTOR_KOIOS_URL, submitUrl: VECTOR_SUBMIT_URL, indexerUrl: undefined,
    });
    expect(GATEWAY_DEFAULT).toBe('https://id.vector.apexfusion.org');
    expect(endpointsFromEnv(envWith({
      VECTOR_OGMIOS_URL: 'http://127.0.0.1:1337', VECTOR_KOIOS_URL: 'https://koios.example.test/', VECTOR_SUBMIT_URL: 'https://submit.example.test/api/submit/tx',
      VECTOR_MARKETPLACE_INDEXER_URL: ' https://indexer.example.test/ ', IDENTITY_GATEWAY_URL: 'https://gateway.example.test',
    }))).toStrictEqual({
      gatewayUrl: 'https://gateway.example.test', ogmiosUrl: 'http://127.0.0.1:1337', koiosUrl: 'https://koios.example.test/', submitUrl: 'https://submit.example.test/api/submit/tx',
      indexerUrl: 'https://indexer.example.test/',
    });
    expect(endpointsFromEnv(envWith({ VECTOR_MARKETPLACE_INDEXER_URL: '', IDENTITY_GATEWAY_URL: ' ', VECTOR_OGMIOS_URL: '' }))).toStrictEqual(endpointsFromEnv(FULL_ENV));
  });
});

describe('the limits of the model hire', () => {
  test('are the allowlist, the price ceiling and the two bond limits, each a number or a list: the three amounts are bigint, and no limit is null', () => {
    expect(limitsOf(FULL_ENV)).toStrictEqual({ allowlist: ['deepseek/deepseek-v4-flash'], maxPriceLovelace: 1_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(limitsOf(envWith({ LLM_MODEL_ALLOWLIST: 'a/one, b/two', LLM_MAX_PRICE_LOVELACE: '250000', LLM_MAX_SUPPLIER_BOND_LOVELACE: '1000000', LLM_MAX_BUYER_BOND_LOVELACE: '1500000' }))).toStrictEqual({
      allowlist: ['a/one', 'b/two'], maxPriceLovelace: 250_000n, maxSupplierBondLovelace: 1_000_000n, maxBuyerBondLovelace: 1_500_000n,
    });
  });

  test('a limit that is not set, or is blank, stops the start by its name: nothing fills it in', () => {
    for (const name of ['LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE', 'LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE']) {
      for (const bad of [undefined, '', '   ']) expect(message(() => limitsOf(envWith({ [name]: bad }))), `${name} = ${JSON.stringify(bad)}`).toContain(`environment variable ${name} is required (`);
    }
    expect(message(() => limitsOf({}))).toContain('environment variable LLM_MODEL_ALLOWLIST is required (');
  });

  test('a limit of the wrong type is refused, and none of these is read as "no limit": a fraction, a sign, an exponent, a word, null as text, a hex number', () => {
    for (const name of ['LLM_MAX_PRICE_LOVELACE', 'LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE']) {
      for (const bad of ['1.5', '-1', '+5', '1e6', 'none', 'null', 'unlimited', '0x10', '1,000', '9007199254740993']) expect(() => limitsOf(envWith({ [name]: bad })), `${name} = ${bad}`).toThrow(`environment variable ${name} must be`);
    }
  });
});

describe('the time of the hook', () => {
  test('the reads of the hook are four, and the four budgets stay under 9 seconds: the budget is from 500 to 2249, and 2249 is accepted where 2250 is not', () => {
    expect([HOOK_READS, HOOK_READS_LIMIT_MS, RUNTIME_PRECHECK_WAIT_MS, CHECKS_READ_BUDGET_MIN_MS, CHECKS_READ_BUDGET_MAX_MS]).toStrictEqual([4, 9_000, 10_000, 500, 2_249]);
    for (const accepted of [500, 1_200, 2_249]) expect(checksBudgetOf({ CHECKS_READ_BUDGET_MS: String(accepted) }), String(accepted)).toBe(accepted);
    for (const refused of [499, 2_250, 3_000, 4_000]) {
      expect(() => checksBudgetOf({ CHECKS_READ_BUDGET_MS: String(refused) }), String(refused)).toThrow(/^environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 2249, got /);
    }
    expect(checksBudgetOf({})).toBe(1_200);
    expect(checksBudgetOf({ CHECKS_READ_BUDGET_MS: '' })).toBe(1_200);
  });

  test('the range that the message names is the range that the start accepts, and it is the widest range whose four reads stay under 9 seconds', () => {
    const [, from, to] = /from (\d+) to (\d+)/.exec(message(() => checksBudgetOf({ CHECKS_READ_BUDGET_MS: '1' }))) ?? [];
    const [least, most] = [Number(from), Number(to)];
    expect([least, most]).toStrictEqual([CHECKS_READ_BUDGET_MIN_MS, CHECKS_READ_BUDGET_MAX_MS]);
    for (const ms of [least, most]) expect(checksBudgetOf({ CHECKS_READ_BUDGET_MS: String(ms) }), String(ms)).toBe(ms);
    for (const ms of [least - 1, most + 1]) expect(() => checksBudgetOf({ CHECKS_READ_BUDGET_MS: String(ms) }), String(ms)).toThrow(`from ${least} to ${most}, got ${ms}`);
    expect(most * HOOK_READS).toBeLessThan(HOOK_READS_LIMIT_MS);
    expect((most + 1) * HOOK_READS).toBeGreaterThanOrEqual(HOOK_READS_LIMIT_MS);
    expect(most).toBe(Math.floor((HOOK_READS_LIMIT_MS - 1) / HOOK_READS));
    expect(CHECKS_READ_BUDGET_DEFAULT_MS).toBeGreaterThanOrEqual(least);
    expect(CHECKS_READ_BUDGET_DEFAULT_MS).toBeLessThanOrEqual(most);
  });
});

describe('the defaults and the constants', () => {
  test('the listener, the state directory and the window have defaults, and a blank value is not set', () => {
    expect([PORT_DEFAULT, HOST_DEFAULT, STATE_DIR_DEFAULT, MIN_PROCESSING_WINDOW_MS]).toStrictEqual([9106, '0.0.0.0', '/data', 480_000]);
    expect([portOf({}), hostOf({}), stateDirOf({}), processingWindowOf({})]).toStrictEqual([9106, '0.0.0.0', '/data', 480_000]);
    expect([portOf({ PORT: '' }), hostOf({ HOST: ' ' }), stateDirOf({ BID_DESK_STATE_DIR: ' ' }), processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '' })]).toStrictEqual([9106, '0.0.0.0', '/data', 480_000]);
    expect([portOf({ PORT: '9200' }), hostOf({ HOST: '127.0.0.1' }), stateDirOf({ BID_DESK_STATE_DIR: '/var/bid-desk' }), processingWindowOf({ ADVERT_MAX_PROCESSING_MS: '600000' })]).toStrictEqual([
      9200, '127.0.0.1', '/var/bid-desk', 600_000,
    ]);
  });

  test('the window of the advert is from 480000 ms to 24 hours: both ends are accepted, and one millisecond outside either end is refused', () => {
    expect([MIN_PROCESSING_WINDOW_MS, MAX_PROCESSING_WINDOW_MS]).toStrictEqual([480_000, 86_400_000]);
    for (const ms of [MIN_PROCESSING_WINDOW_MS, 600_000, 3_600_000, MAX_PROCESSING_WINDOW_MS]) expect(processingWindowOf({ ADVERT_MAX_PROCESSING_MS: String(ms) }), String(ms)).toBe(ms);
    for (const ms of [MIN_PROCESSING_WINDOW_MS - 1, MAX_PROCESSING_WINDOW_MS + 1]) {
      expect(() => processingWindowOf({ ADVERT_MAX_PROCESSING_MS: String(ms) }), String(ms)).toThrow(`environment variable ADVERT_MAX_PROCESSING_MS must be at ${ms < MIN_PROCESSING_WINDOW_MS ? 'least' : 'most'} `);
    }
  });

  test('the deadline of a job and the time of the one gateway call are the numbers of the page, and the deadline fits inside the runtime timeout inside the window of the advert', () => {
    expect([JOB_DEADLINE_MS, CALL_TIMEOUT_MS]).toStrictEqual([300_000, 20_000]);
    // The runtime waits 60 s longer than the job (SERVICE_TIMEOUT_MS 360000), and the window of the advert is 120 s longer than that.
    expect(JOB_DEADLINE_MS + 60_000 + 120_000).toBe(MIN_PROCESSING_WINDOW_MS);
  });

  test('the price and each bond are 1 million lovelace, which locks 3 million for the buyer', () => {
    expect([PRICE_LOVELACE, BOND_LOVELACE]).toStrictEqual([1_000_000, 1_000_000]);
    expect(PRICE_LOVELACE + 2 * BOND_LOVELACE).toBe(3_000_000);
  });

  test('the fault switch is empty or the one fault value of the Bid Desk, read into a frozen switch of the kind', () => {
    expect(faultOf(FULL_ENV).mode).toBe('');
    expect(faultOf(envWith({ FAULT_MODE: '' })).mode).toBe('');
    const fault = faultOf(envWith({ FAULT_MODE: 'quote_off_price_list' }));
    expect([fault.kind, fault.mode, Object.isFrozen(fault)]).toStrictEqual(['bid-desk', 'quote_off_price_list', true]);
  });
});
