// agents/bid-desk/test/serve/start.test.ts
// How the Bid Desk starts and stops. The configuration that the start reads from the environment for each of the three instances, and every refusal of the start with its accepted twin: a missing required
// setting, a bad key form, a key hash that is not the hash of the key, the service key that is the supplier key, a secret in the line of another setting, an unknown instance, an unknown fault value, an
// organisation that a quote refuses, and a manifest that holds a secret or changes with the fault setting. Then the start itself: the line it logs when it listens, a start that fails before it listens and leaves
// nothing running, the stop of a restart that waits for the job that runs, the signals, and src/index.ts run as a process for each instance, with the real parts and a chain that nothing answers. No test here
// uses the network.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { rawHexToBech32 } from '@vsa/buyer-core';
import type { Chain, RealChainOptions } from '@vsa/buyer-core';
import { PayingKey } from '@vsa/hire-kit';
import { parseQuote } from '@vsa/usecase-kit/bids';
import { manifestFromEnv } from '../../src/serve/manifest.ts';
import { INSTANCES, INSTANCE_NAMES, PORT_DEFAULT, STATE_DIR_DEFAULT } from '../../src/serve/settings.ts';
import type { Instance } from '../../src/serve/settings.ts';
import { JANITOR_INTERVAL_MS, JANITOR_STOP_WAIT_MS, SETTINGS, loadConfig, startService, stopOnSignals } from '../../src/serve/start.ts';
import { choiceOf, quoteOf } from '../job/samples.ts';
import { until } from './serve.ts';
import { AGENT_DID, CONTACT, FULL_ENV, IDENTITY_SETTINGS, ORGANISATION, ORIGIN, POLICY, PRICE_LIST_SHA256, SERVICE, SERVICE_ADDRESS, SUPPLIER, TOKEN, envOf, envWith, keyOf, message, priceListOf, shows } from './support.ts';
import { cleanDirs, headersOf, makeWorld, tempDir, wire } from './world.ts';

afterEach(() => {
  vi.restoreAllMocks();
  cleanDirs();
});

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const refusal = (work: Promise<unknown>): Promise<string> => work.then(() => 'accepted', (error: unknown) => (error instanceof Error ? error.message : String(error)));
/** A full environment of the first instance: what `FULL_ENV` holds, the four settings that name the identity deployment, and the changes of the test. A value of `undefined` takes the setting away. */
const full = (over: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv => envWith({ ...IDENTITY_SETTINGS, ...over });
/** The same for one of the three instances, with its own origin and organisation. */
const fullOf = (instance: Instance, over: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv => envOf(instance, { ...IDENTITY_SETTINGS, ...over });

describe('loadConfig on a full environment', () => {
  test('gives the defaults for everything the operator leaves out, and the identity that the service key derives to', () => {
    const config = loadConfig(full());
    expect([config.host, config.port, config.stateDir, config.fault.mode, config.checksBudgetMs]).toStrictEqual(['0.0.0.0', 9106, '/data', '', 1_200]);
    expect([PORT_DEFAULT, STATE_DIR_DEFAULT]).toStrictEqual([9106, '/data']);
    expect(config.service).toStrictEqual({ privateKeyHex: SERVICE.privateKeyHex, pkh: SERVICE.pkh, address: SERVICE_ADDRESS });
    expect(SERVICE_ADDRESS.startsWith('addr1v')).toBe(true);
    expect(config.agentDid).toBe(AGENT_DID);
    expect(config.authHeader).toBe(TOKEN);
    expect([config.instance, config.organisation]).toStrictEqual(['alfa', ORGANISATION]);
    expect(config.supplier).toStrictEqual({ pkh: SUPPLIER.pkh, pubKeyHex: SUPPLIER.pubKeyHex });
    expect(config.limits).toStrictEqual({ allowlist: ['deepseek/deepseek-v4-flash'], maxPriceLovelace: 1_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(config.endpoints.indexerUrl).toBeUndefined();
    expect(config.endpoints.gatewayUrl).toBe('https://id.vector.apexfusion.org');
    expect(config.identityDeployment.identity.hash).toBe(POLICY);
    expect(config.priceList.sha256).toBe(PRICE_LIST_SHA256.alfa);
  });

  test('reads every optional setting: the listener, the state directory, the endpoints, the budget and the window; a blank one is not set', () => {
    const config = loadConfig(full({
      PORT: '9200', HOST: '127.0.0.1', BID_DESK_STATE_DIR: '/var/bid-desk', CHECKS_READ_BUDGET_MS: '900', ADVERT_MAX_PROCESSING_MS: '600000',
      VECTOR_OGMIOS_URL: 'http://127.0.0.1:1337', VECTOR_KOIOS_URL: 'https://koios.example.test/', VECTOR_SUBMIT_URL: 'https://submit.example.test/api/submit/tx',
      VECTOR_MARKETPLACE_INDEXER_URL: ' https://indexer.example.test/ ', IDENTITY_GATEWAY_URL: 'https://gateway.example.test',
    }));
    expect([config.port, config.host, config.stateDir, config.checksBudgetMs]).toStrictEqual([9200, '127.0.0.1', '/var/bid-desk', 900]);
    expect(config.endpoints).toStrictEqual({
      gatewayUrl: 'https://gateway.example.test', ogmiosUrl: 'http://127.0.0.1:1337', koiosUrl: 'https://koios.example.test/', submitUrl: 'https://submit.example.test/api/submit/tx',
      indexerUrl: 'https://indexer.example.test/',
    });
    const published = JSON.parse(config.manifest.text) as { terms: { max_processing_ms: number } };
    expect(published.terms.max_processing_ms).toBe(600_000);
    const blank = loadConfig(full({
      PORT: '', HOST: '', BID_DESK_STATE_DIR: ' ', CHECKS_READ_BUDGET_MS: '', ADVERT_MAX_PROCESSING_MS: '', VECTOR_MARKETPLACE_INDEXER_URL: '', IDENTITY_GATEWAY_URL: '',
    }));
    expect(blank.manifest).toStrictEqual(loadConfig(full()).manifest);
    expect([blank.port, blank.host, blank.stateDir, blank.checksBudgetMs, blank.endpoints.indexerUrl]).toStrictEqual([9106, '0.0.0.0', '/data', 1_200, undefined]);
  });

  test('a value that a file leaves a line break or a space around is the value without it', () => {
    const config = loadConfig(full({
      OPERATOR_CONTACT: ` ${CONTACT}\n`, BID_DESK_SERVICE_PRIV_KEY_HEX: `${SERVICE.privateKeyHex}\r\n`, SUPPLIER_PKH: ` ${SUPPLIER.pkh.toUpperCase()}\n`, AGENT_DID: ` ${AGENT_DID}\n`,
      BID_DESK_PUBLIC_ORIGIN: ` ${ORIGIN}\n`, BID_DESK_SERVICE_PKH: ` ${SERVICE.pkh.toUpperCase()} `, BID_DESK_INSTANCE: ' alfa\n',
    }));
    expect(config.service.privateKeyHex).toBe(SERVICE.privateKeyHex);
    expect(config.supplier.pkh).toBe(SUPPLIER.pkh);
    expect(config.manifest).toStrictEqual(loadConfig(full()).manifest);
  });
});

describe.each(INSTANCES)('loadConfig for the Bid Desk %s', (instance) => {
  test('names its instance, its organisation, its price list and its manifest, and the manifest is the same bytes for the empty setting and for the fault value', () => {
    const clean = loadConfig(fullOf(instance));
    const fault = loadConfig(fullOf(instance, { FAULT_MODE: 'quote_off_price_list' }));
    expect([clean.instance, clean.organisation, clean.priceList.sha256]).toStrictEqual([instance, `${instance}.example.test`, PRICE_LIST_SHA256[instance]]);
    expect(clean.priceList.text).toBe(priceListOf(instance).text);
    expect([clean.fault.mode, fault.fault.mode]).toStrictEqual(['', 'quote_off_price_list']);
    expect(fault.manifest).toStrictEqual(clean.manifest);
    expect(sha256(clean.manifest.text)).toBe(clean.manifest.sha256);
    const manifest = JSON.parse(clean.manifest.text) as { name: string; behaviour: { price_list: { uri: string; sha256: string }; fault_modes: string[] } };
    expect(manifest.name).toBe(INSTANCE_NAMES[instance]);
    expect(manifest.behaviour.price_list).toStrictEqual({ uri: `https://bids-${instance}.example.test/price-list.json`, sha256: PRICE_LIST_SHA256[instance] });
    expect(manifest.behaviour.fault_modes).toStrictEqual(['quote_off_price_list']);
  });
});

test('the three Bid Desks have three manifests and three hashes', () => {
  const hashes = INSTANCES.map((instance) => loadConfig(fullOf(instance)).manifest.sha256);
  expect(new Set(hashes).size).toBe(3);
});

/** One refusal of the start: the setting, the value that is refused (undefined: not set), the message, and a value of the same setting that is accepted (the twin). */
type Row = readonly [setting: string, bad: string | undefined, refusal: RegExp, good: string | undefined];
const BAD_HASH = 'a'.repeat(56);
const REFUSALS: readonly Row[] = [
  ['OPERATOR_CONTACT', undefined, /^environment variable OPERATOR_CONTACT is required/, CONTACT],
  ['BID_DESK_SERVICE_PRIV_KEY_HEX', undefined, /^environment variable BID_DESK_SERVICE_PRIV_KEY_HEX is required/, SERVICE.privateKeyHex],
  ['BID_DESK_SERVICE_PRIV_KEY_HEX', 'not a key', /^environment variable BID_DESK_SERVICE_PRIV_KEY_HEX must be 64 lowercase hex characters \(a raw Ed25519 key\)$/, SERVICE.privateKeyHex],
  ['BID_DESK_SERVICE_PRIV_KEY_HEX', SERVICE.privateKeyHex.toUpperCase(), /^environment variable BID_DESK_SERVICE_PRIV_KEY_HEX must be 64 lowercase hex characters/, SERVICE.privateKeyHex],
  ['SERVICE_AUTH_HEADER', '', /^environment variable SERVICE_AUTH_HEADER is required/, TOKEN],
  ['AGENT_DID', 'did:vector:abc', /^environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters/, AGENT_DID],
  ['BID_DESK_INSTANCE', undefined, /^environment variable BID_DESK_INSTANCE is required/, 'alfa'],
  ['BID_DESK_INSTANCE', 'delta', /^environment variable BID_DESK_INSTANCE must be alfa, bravo or charlie/, 'bravo'],
  ['BID_DESK_ORGANISATION', 'Alfa.Example.Test', /^environment variable BID_DESK_ORGANISATION must be a domain name in lower case/, ORGANISATION],
  ['BID_DESK_PUBLIC_ORIGIN', 'http://bids.example.test', /^environment variable BID_DESK_PUBLIC_ORIGIN must be an https origin/, ORIGIN],
  ['FAULT_MODE', 'yes', /^environment variable FAULT_MODE must be empty or "quote_off_price_list" for bid-desk, got /, 'quote_off_price_list'],
  ['FAULT_MODE', 'confirm_wrong_lot', /^environment variable FAULT_MODE must be empty or "quote_off_price_list" for bid-desk, got /, ''],
  ['PORT', '70000', /^environment variable PORT must be a port from 0 to 65535/, '9200'],
  ['CHECKS_READ_BUDGET_MS', '2250', /^environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 2249/, '2249'],
  ['CHECKS_READ_BUDGET_MS', '499', /^environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 2249/, '500'],
  ['ADVERT_MAX_PROCESSING_MS', '479999', /^environment variable ADVERT_MAX_PROCESSING_MS must be at least 480000/, '480000'],
  ['ADVERT_MAX_PROCESSING_MS', '86400001', /^environment variable ADVERT_MAX_PROCESSING_MS must be at most 86400000/, '86400000'],
  ['SUPPLIER_PKH', undefined, /^environment variable SUPPLIER_PKH is required/, SUPPLIER.pkh],
  ['SUPPLIER_PKH', 'abc', /^environment variable SUPPLIER_PKH /, SUPPLIER.pkh],
  ['SUPPLIER_PUB_KEY_HEX', keyOf('bid desk start test: another supplier key').pubKeyHex, /^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/, SUPPLIER.pubKeyHex],
  ['BID_DESK_SERVICE_PKH', BAD_HASH, /^environment variable BID_DESK_SERVICE_PKH \(56 characters\) is not the key hash of the key in BID_DESK_SERVICE_PRIV_KEY_HEX/, SERVICE.pkh],
  ['LLM_MODEL_ALLOWLIST', undefined, /^environment variable LLM_MODEL_ALLOWLIST is required/, 'deepseek/deepseek-v4-flash'],
  ['LLM_MAX_PRICE_LOVELACE', 'free', /^environment variable LLM_MAX_PRICE_LOVELACE /, '1000000'],
  ['LLM_MAX_SUPPLIER_BOND_LOVELACE', undefined, /^environment variable LLM_MAX_SUPPLIER_BOND_LOVELACE is required/, '2000000'],
  ['LLM_MAX_BUYER_BOND_LOVELACE', '2.5', /^environment variable LLM_MAX_BUYER_BOND_LOVELACE must be a whole number of lovelace/, '2000000'],
  ['IDENTITY_GATEWAY_URL', 'http://gateway.example.test', /^environment variable IDENTITY_GATEWAY_URL must be an https origin/, 'https://gateway.example.test'],
  ['VECTOR_OGMIOS_URL', 'ftp://node.example.test', /^environment variable VECTOR_OGMIOS_URL must be an http or https address/, 'http://node.example.test'],
  ['VECTOR_IDENTITY_LEGACY_ROOT', undefined, /^environment variable .*but VECTOR_IDENTITY_LEGACY_ROOT is not: set both VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED/, IDENTITY_SETTINGS.VECTOR_IDENTITY_LEGACY_ROOT],
  ['IDENTITY_POLICY_ID', 'ab'.repeat(28), /^environment variable IDENTITY_POLICY_ID /, POLICY],
];

describe('every refusal of the start has its twin', () => {
  test.each(REFUSALS)('%s = %s is refused by its name, and the twin is accepted', (setting, bad, expected, good) => {
    expect(message(() => loadConfig(full({ [setting]: bad }))), `${setting} refused`).toMatch(expected);
    expect(() => loadConfig(full({ [setting]: good })), `${setting} twin`).not.toThrow();
  });

  test('every setting that the service reads is one of those that a refusal or a default covers: SETTINGS has no name twice, and each required name stops the start when it is missing', () => {
    expect(new Set(SETTINGS).size).toBe(SETTINGS.length);
    for (const name of ['OPERATOR_CONTACT', 'BID_DESK_SERVICE_PRIV_KEY_HEX', 'SERVICE_AUTH_HEADER', 'AGENT_DID', 'BID_DESK_INSTANCE', 'BID_DESK_ORGANISATION', 'BID_DESK_PUBLIC_ORIGIN', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX',
      'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE', 'LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE']) {
      expect(SETTINGS, name).toContain(name);
      expect(() => loadConfig(full({ [name]: undefined })), name).toThrow(new RegExp(`^environment variable ${name} `));
    }
  });

  test('a message of the start never shows the service key, in any form of the refusal', () => {
    const texts = [
      message(() => loadConfig(full({ BID_DESK_SERVICE_PRIV_KEY_HEX: 'not a key' }))),
      message(() => loadConfig(full({ BID_DESK_SERVICE_PKH: BAD_HASH }))),
      message(() => loadConfig(full({ AGENT_DID: `did:${SERVICE.privateKeyHex}` }))),
      message(() => loadConfig(full({ BID_DESK_SERVICE_PRIV_KEY_HEX: SUPPLIER.privateKeyHex }))),
      message(() => loadConfig(full({ SUPPLIER_PUB_KEY_HEX: SERVICE.privateKeyHex }))),
    ];
    for (const text of texts) {
      expect(shows(text, SERVICE.privateKeyHex), text).toBe(false);
      expect(shows(text, SUPPLIER.privateKeyHex), text).toBe(false);
      expect(text.toLowerCase()).not.toContain(rawHexToBech32(SERVICE.privateKeyHex));
    }
  });
});

describe('the service key and the token in the lines of other settings', () => {
  const lines = (secret: string): string[] => [secret, secret.toUpperCase(), `prefix-${secret}-suffix`, `did:vector:agent:${secret}`];

  test('the service key in any other setting is refused, naming that setting and not showing the key: raw, in another case, inside a longer value, and as bech32', () => {
    const key = SERVICE.privateKeyHex;
    for (const name of SETTINGS.filter((setting) => setting !== 'BID_DESK_SERVICE_PRIV_KEY_HEX')) {
      for (const value of [...lines(key), rawHexToBech32(key)]) {
        const text = message(() => loadConfig(full({ [name]: value })));
        expect(text, `${name} = ${value.slice(0, 12)}`).toBe(`environment variable ${name} holds the service key, which belongs in BID_DESK_SERVICE_PRIV_KEY_HEX alone: it would be printed or published. Take it out of ${name}`);
        expect(shows(text, key)).toBe(false);
      }
    }
  });

  test('the token in any other setting is refused, naming that setting and not showing it: whole or by its credential, in any case, inside a longer value', () => {
    const credential = TOKEN.slice('Bearer '.length);
    for (const name of SETTINGS.filter((setting) => setting !== 'SERVICE_AUTH_HEADER' && setting !== 'BID_DESK_SERVICE_PRIV_KEY_HEX')) {
      for (const value of [TOKEN, credential.toUpperCase(), `x${credential}y`]) {
        const text = message(() => loadConfig(full({ [name]: value })));
        expect(text, name).toBe(`environment variable ${name} holds the service token, which belongs in SERVICE_AUTH_HEADER alone: it would be printed or published. Take it out of ${name}`);
        expect(shows(text, credential)).toBe(false);
      }
    }
    // In the line of the key, the token is refused by the form of a key, which shows nothing either.
    expect(message(() => loadConfig(full({ BID_DESK_SERVICE_PRIV_KEY_HEX: TOKEN })))).toBe('environment variable BID_DESK_SERVICE_PRIV_KEY_HEX must be 64 lowercase hex characters (a raw Ed25519 key)');
  });

  test('a short value that is not a secret in a line is accepted: the search is for the whole key and the whole token', () => {
    expect(() => loadConfig(full({ OPERATOR_CONTACT: `ops-${SERVICE.privateKeyHex.slice(0, 20)}@example.test` }))).not.toThrow();
    expect(() => loadConfig(full({ OPERATOR_CONTACT: `ops-${TOKEN.slice(0, 12)}@example.test` }))).not.toThrow();
  });
});

describe('the keys of the service and of the supplier', () => {
  test('the key hash that the operator wrote down is taken in any case, and the supplier key is never the service key', () => {
    expect(loadConfig(full({ BID_DESK_SERVICE_PKH: SERVICE.pkh.toUpperCase() })).manifest).toStrictEqual(loadConfig(full()).manifest);
    const asSupplier = { BID_DESK_SERVICE_PRIV_KEY_HEX: SUPPLIER.privateKeyHex };
    expect(message(() => loadConfig(full(asSupplier)))).toBe("environment variable BID_DESK_SERVICE_PRIV_KEY_HEX holds the supplier key: the supplier key is the runtime's, and the service key must be a key of its own");
    // The twin: the same supplier key beside a service key of its own starts.
    expect(loadConfig(full()).service.pkh).toBe(SERVICE.pkh);
  });

  test('a private key in the line of the public key is refused by the key hash that the line must give, and the message shows nothing of it', () => {
    const text = message(() => loadConfig(full({ SUPPLIER_PUB_KEY_HEX: SUPPLIER.privateKeyHex })));
    expect(text).toMatch(/^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/);
    expect(shows(text, SUPPLIER.privateKeyHex)).toBe(false);
  });
});

describe('the organisation of the desk is one that a quote takes', () => {
  /** True when the parser of the quote takes `organisation` as the domain of the desk: the quote of the samples of the job, with only that member changed. */
  const quoteTakes = (organisation: string): boolean => {
    const quote = quoteOf(choiceOf());
    if (quote === null) throw new Error('the quote of the samples cannot be made');
    return parseQuote({ ...quote, organisation }).ok;
  };
  const startTakes = (organisation: string): boolean => { try { loadConfig(full({ BID_DESK_ORGANISATION: organisation })); return true; } catch { return false; } };

  test('the start takes an organisation exactly when the quote takes it: a desk must not fail on its own organisation', () => {
    const CANDIDATES = [
      'alfa.example.org', 'a.b', 'a-1.b-2.c', 'x1.y2', 'xn--alfa.example.org', 'alfa.vector.example.org', `${'a'.repeat(31)}.${'b'.repeat(32)}`, `${'a'.repeat(61)}.org`, `${'a'.repeat(63)}.b`,
      `${'a'.repeat(64)}.org`, 'alfa', 'Alfa.example.org', 'alfa..example.org', '-alfa.example.org', 'alfa-.example.org', 'alfa.example.org.', 'alfa example.org', 'alfa.example.org/path',
      'alfa.example.\u212A', 'alfa_beta.example.org', 'alfa@example.org', 'alfa.example.org:8443', '.example.org', 'alfa.-example.org',
    ];
    const taken = CANDIDATES.filter(quoteTakes);
    expect(taken.length, 'the table holds names that the quote takes').toBeGreaterThanOrEqual(6);
    expect(CANDIDATES.length - taken.length, 'the table holds names that the quote refuses').toBeGreaterThanOrEqual(10);
    for (const organisation of CANDIDATES) expect(startTakes(organisation), organisation).toBe(quoteTakes(organisation));
  });
});

describe('the manifest is looked at last', () => {
  test('for the service key in both its forms and in any case, and for the token: whatever puts either in a value that is published, the start stops, unprinted', () => {
    for (const leaked of [SERVICE.privateKeyHex, SERVICE.privateKeyHex.toUpperCase(), rawHexToBech32(SERVICE.privateKeyHex)]) {
      const text = message(() => loadConfig(full(), (env, list) => ({ ...manifestFromEnv(env, list), description: `from somewhere else: ${leaked}` })));
      expect(text).toBe('the manifest would publish the service key: a value that goes into it holds the key, and the service does not start with it');
    }
    const token = message(() => loadConfig(full(), (env, list) => ({ ...manifestFromEnv(env, list), description: `from somewhere else: ${TOKEN}` })));
    expect(token).toBe('the manifest would publish the service token: a value that goes into it holds the token of SERVICE_AUTH_HEADER, and the service does not start with it');
  });

  test('the builder of the manifest is given an environment with no secret in it', () => {
    let seen: NodeJS.ProcessEnv = {};
    loadConfig(full(), (env, list) => { seen = env; return manifestFromEnv(env, list); });
    expect(Object.keys(seen)).not.toContain('BID_DESK_SERVICE_PRIV_KEY_HEX');
    expect(Object.keys(seen)).not.toContain('SERVICE_AUTH_HEADER');
    expect(JSON.stringify(seen)).not.toContain(SERVICE.privateKeyHex);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });

  test('a manifest that the kit refuses stops the start with its code: a placeholder in a served value', () => {
    expect(message(() => loadConfig(full({ OPERATOR_CONTACT: '<OPERATOR_CONTACT>' })))).toMatch(/^the manifest is refused \(manifest_has_placeholder\)/);
  });

  test('a manifest that holds the hash of the price list of another instance stops the start, and the hash that the builder is given is the hash of the file of the instance', () => {
    const seen: string[] = [];
    loadConfig(fullOf('bravo'), (env, list) => { seen.push(list.sha256); return manifestFromEnv(env, list); });
    expect(new Set(seen)).toStrictEqual(new Set([PRICE_LIST_SHA256.bravo]));
    const other = message(() => loadConfig(fullOf('bravo'), (env) => manifestFromEnv(env, { sha256: PRICE_LIST_SHA256.alfa })));
    expect(other).toMatch(/^the price list hash is not the hash of the file of the instance bravo/);
  });
});

describe('the manifest that the start renders for each setting of the fault switch', () => {
  // A builder that lets the fault setting into the bytes of the manifest. The start gives the builder each setting of the switch, one after the other, in the environment that it passes. The live value of
  // FAULT_MODE is not what the builder reads: a builder that reads the live value gives one text for every setting, and the check would prove nothing.
  const leaking: Parameters<typeof loadConfig>[1] = (env, list) => ({ ...manifestFromEnv(env, list), description: `${manifestFromEnv(env, list).description}${env.FAULT_MODE ?? ''}` });
  const faithful: Parameters<typeof loadConfig>[1] = (env, list) => manifestFromEnv(env, list);

  test('a manifest that changes with the fault setting stops the start with manifest_changes_with_fault, whatever the live value is, and the twin that does not change starts', () => {
    for (const live of ['', 'quote_off_price_list']) {
      expect(message(() => loadConfig(full({ FAULT_MODE: live }), leaking)), `live value ${JSON.stringify(live)}`).toMatch(/^the manifest is refused \(manifest_changes_with_fault\)/);
      expect(() => loadConfig(full({ FAULT_MODE: live }), faithful), `the twin, live value ${JSON.stringify(live)}`).not.toThrow();
    }
  });

  test('the builder is given every setting of the switch and nothing else in the member FAULT_MODE: the empty setting, and the fault value, whatever the live value is', () => {
    for (const live of ['', 'quote_off_price_list']) {
      const seen: string[] = [];
      loadConfig(full({ FAULT_MODE: live }), (env, list) => { seen.push(env.FAULT_MODE ?? '(none)'); return manifestFromEnv(env, list); });
      expect(new Set(seen), `live value ${JSON.stringify(live)}`).toStrictEqual(new Set(['', 'quote_off_price_list']));
    }
  });
});

describe('startService', () => {
  test('logs one line when it listens: the address, the address of the service key and the state directory, and no key', async () => {
    const world = makeWorld();
    const service = await startService(world.env, world.options);
    try {
      const listening = world.logs.filter((line) => line.startsWith('listening on'));
      expect(listening).toStrictEqual([`listening on 127.0.0.1:${service.port}; service address ${SERVICE_ADDRESS}; state directory ${world.stateDir}`]);
      expect(world.logs.join('\n')).not.toContain(SERVICE.privateKeyHex);
      expect((await fetch(`http://127.0.0.1:${service.port}/healthz`)).status).toBe(200);
    } finally {
      await service.stop();
    }
  });

  test('stop is safe to call twice, and a service that was stopped takes no connection', async () => {
    const world = makeWorld();
    const service = await startService(world.env, world.options);
    await service.stop();
    await service.stop();
    await expect(fetch(`http://127.0.0.1:${service.port}/healthz`)).rejects.toThrow();
  });

  test('a setting that is missing or wrong stops the start by its name before anything listens, and nothing is made: no chain, no state file', async () => {
    for (const [name, bad, expected] of [
      ['BID_DESK_INSTANCE', undefined, /^environment variable BID_DESK_INSTANCE is required/],
      ['FAULT_MODE', 'yes', /^environment variable FAULT_MODE must be empty or "quote_off_price_list" for bid-desk/],
      ['BID_DESK_SERVICE_PRIV_KEY_HEX', 'not a key', /^environment variable BID_DESK_SERVICE_PRIV_KEY_HEX must be 64 lowercase hex characters/],
    ] as const) {
      const world = makeWorld();
      const chains: RealChainOptions[] = [];
      const createChain = async (options: RealChainOptions): Promise<Chain> => { chains.push(options); return world.m.chain; };
      expect(await refusal(startService({ ...world.env, [name]: bad }, { ...world.options, createChain })), name).toMatch(expected);
      expect(world.logs.filter((line) => line.startsWith('listening on')), name).toStrictEqual([]);
      expect(chains, name).toStrictEqual([]);
      expect(existsSync(join(world.stateDir, 'rfq-book.json')), name).toBe(false);
    }
  });

  test('a state directory that cannot be written stops the start, naming the setting', async () => {
    const world = makeWorld();
    const file = join(tempDir(), 'a-file');
    writeFileSync(file, 'not a directory', 'utf8');
    const text = await refusal(startService({ ...world.env, BID_DESK_STATE_DIR: join(file, 'state') }, world.options));
    expect(text).toMatch(/^environment variable BID_DESK_STATE_DIR names /);
    expect(world.logs.filter((line) => line.startsWith('listening on'))).toStrictEqual([]);
  });

  test('the janitor of the paying key is started one time, with the interval of the options and the log of the service', async () => {
    const world = makeWorld();
    const started = vi.spyOn(PayingKey.prototype, 'startJanitor');
    const service = await startService(world.env, world.options);
    try {
      expect(started).toHaveBeenCalledTimes(1);
      expect(started.mock.calls[0]?.[0]).toBe(3_600_000);
    } finally {
      await service.stop();
    }
    expect([JANITOR_INTERVAL_MS, JANITOR_STOP_WAIT_MS]).toStrictEqual([60_000, 30_000]);
  });
});

describe('the stop of a restart', () => {
  test('takes no new job, waits for the job that runs, answers it, and then closes: a job that holds the slot is the job that the stop waits for', async () => {
    const world = makeWorld();
    const service = await startService(world.env, world.options);
    const base = `http://127.0.0.1:${service.port}`;
    const post = (path: string): Promise<Response> => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: TOKEN, ...headersOf(world.context) }, body: wire(world.message) });
    expect((await post('/precheck')).status).toBe(200);
    const hold = world.holdModel();
    const job = post('/');
    await hold.reached;
    let outcome: string | null = null;
    const stopping = service.shutdown(30_000).then((value) => { outcome = value; });
    await until(() => world.logs.some((line) => line.startsWith('stopping: waiting up to 30000 ms for the job that is running')), 'the stop has begun to wait');
    expect(outcome).toBeNull();
    // A new job is refused while the stop waits.
    const refused = await post('/precheck').then((reply) => reply.status, () => 'closed');
    expect([503, 'closed']).toContain(refused);
    hold.release();
    expect((await job).status).toBe(200);
    await stopping;
    expect(outcome).toBe('finished');
  });
});

describe('stopOnSignals', () => {
  test('SIGTERM starts the shutdown with the log of this service and exits 0; the second signal finds no handler', async () => {
    const lines: string[] = [];
    const exits: number[] = [];
    const target = new EventEmitter();
    stopOnSignals({ shutdown: async () => 'finished' }, { target, exit: (code) => { exits.push(code); }, log: (line) => { lines.push(line); } });
    target.emit('SIGTERM');
    await until(() => exits.length === 1, 'the exit');
    expect([exits, lines]).toStrictEqual([[0], ['SIGTERM: stopping; no new job, and up to 300 s for the one that is running']]);
    expect(target.listenerCount('SIGTERM') + target.listenerCount('SIGINT')).toBe(0);
  });

  test('a job that had to be abandoned makes the exit code 1', async () => {
    const exits: number[] = [];
    const target = new EventEmitter();
    stopOnSignals({ shutdown: async () => 'abandoned' }, { target, exit: (code) => { exits.push(code); }, log: () => undefined });
    target.emit('SIGINT');
    await until(() => exits.length === 1, 'the exit');
    expect(exits).toStrictEqual([1]);
  });
});

describe('src/index.ts as a process', () => {
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  /** The ledger and the marketplace indexer at a loopback port where nothing listens. */
  let offChain: Record<string, string> = {};
  const closedPort = (): Promise<number> => new Promise<number>((resolve, reject) => {
    const probe = netServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
  });
  beforeAll(async () => {
    const node = `http://127.0.0.1:${await closedPort()}`;
    offChain = { VECTOR_OGMIOS_URL: node, VECTOR_KOIOS_URL: `${node}/`, VECTOR_SUBMIT_URL: `${node}/api/submit/tx`, VECTOR_MARKETPLACE_INDEXER_URL: node, IDENTITY_GATEWAY_URL: 'https://gateway.example.test' };
  });

  /** The settings of a full deployment of one instance on a state directory of its own, with the real parts. */
  const childEnv = (instance: Instance, over: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv =>
    fullOf(instance, { ...offChain, PORT: '0', HOST: '127.0.0.1', BID_DESK_STATE_DIR: tempDir(), ...over });

  /**
   * Starts src/index.ts on `env` over the environment the tests run in, less every setting that the service reads, so that nothing an operator has set can change what a test sees, and with the chain off
   * (offChain, last), so that no call of the real chain can leave the machine.
   */
  const run = (env: NodeJS.ProcessEnv) => {
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    for (const name of SETTINGS) delete inherited[name];
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd, env: { ...inherited, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, exited, out: () => out, err: () => err };
  };
  const listening = async (p: ReturnType<typeof run>): Promise<string> => {
    await until(() => /listening on 127\.0\.0\.1:\d+/.test(p.out()) || p.child.exitCode !== null, 'the service listens', 30_000);
    const port = /listening on 127\.0\.0\.1:(\d+)/.exec(p.out())?.[1];
    if (port === undefined) throw new Error(`the service did not listen: ${p.err()}`);
    return `http://127.0.0.1:${port}`;
  };

  test('exits 1 at start with the variable named, and listens on nothing, when a setting is missing or wrong, and prints no secret', async () => {
    const cases: Array<[Record<string, string | undefined>, RegExp]> = [
      [{ BID_DESK_INSTANCE: undefined }, /^\[bid-desk\] cannot start: environment variable BID_DESK_INSTANCE is required/],
      [{ BID_DESK_INSTANCE: 'delta' }, /^\[bid-desk\] cannot start: environment variable BID_DESK_INSTANCE must be alfa, bravo or charlie/],
      [{ BID_DESK_SERVICE_PRIV_KEY_HEX: undefined }, /^\[bid-desk\] cannot start: environment variable BID_DESK_SERVICE_PRIV_KEY_HEX is required/],
      [{ FAULT_MODE: 'confirm_wrong_lot' }, /^\[bid-desk\] cannot start: environment variable FAULT_MODE must be empty or "quote_off_price_list" for bid-desk/],
      [{ AGENT_DID: SERVICE.privateKeyHex }, /^\[bid-desk\] cannot start: environment variable AGENT_DID holds the service key/],
    ];
    const results = await Promise.all(cases.map(async ([over]) => { const p = run(childEnv('alfa', over)); return { code: await p.exited, out: p.out(), err: p.err() }; }));
    cases.forEach(([, expected], index) => {
      const result = results[index]!;
      expect(result.code).toBe(1);
      expect(result.err).toMatch(expected);
      expect(result.out).not.toContain('listening on');
      expect(shows(result.out + result.err, SERVICE.privateKeyHex)).toBe(false);
    });
  }, 90_000);

  // A signal reaches a handler only on POSIX (on Windows kill() ends the process at once), so CI on Linux runs this. The line "listening" does not show that the handlers of SIGTERM are on: the entry puts them on
  // in the same run of its event loop, a moment after that line. An answer of the server comes in a later run of the loop, so the test waits for one answer before it sends the signal.
  test.skipIf(process.platform === 'win32').each(INSTANCES)(
    'the Bid Desk %s started for real: it logs its line, answers /healthz, /agent.json and /price-list.json, refuses a job without the token, prints no secret, and SIGTERM stops it with exit 0',
    async (instance) => {
      const p = run(childEnv(instance));
      try {
        const base = await listening(p);
        expect(p.out()).toContain(`[bid-desk] listening on 127.0.0.1:${base.split(':')[2]}; service address ${SERVICE_ADDRESS}; state directory `);
        expect(await (await fetch(`${base}/healthz`)).json(), p.err()).toStrictEqual({ ok: true });
        const manifest = await (await fetch(`${base}/agent.json`)).json() as { name: string; identity: { did: string }; keys: { service_pkh: string }; behaviour: { price_list: { uri: string; sha256: string } } };
        expect([manifest.name, manifest.identity.did, manifest.keys.service_pkh]).toStrictEqual([INSTANCE_NAMES[instance], AGENT_DID, SERVICE.pkh]);
        // The bytes at /price-list.json are the bytes of the file of the instance, and their hash is the hash that the manifest holds.
        const list = Buffer.from(await (await fetch(`${base}/price-list.json`)).arrayBuffer());
        expect(list.equals(Buffer.from(priceListOf(instance).text, 'utf8'))).toBe(true);
        expect([sha256(list), manifest.behaviour.price_list.sha256]).toStrictEqual([PRICE_LIST_SHA256[instance], PRICE_LIST_SHA256[instance]]);
        expect(manifest.behaviour.price_list.uri).toBe(`https://bids-${instance}.example.test/price-list.json`);
        expect((await fetch(`${base}/`, { method: 'POST', body: wire(FULL_ENV) })).status).toBe(401);
        expect((await fetch(`${base}/precheck`, { method: 'POST', body: wire(FULL_ENV) })).status).toBe(401);
        p.child.kill('SIGTERM');
        expect(await p.exited).toBe(0);
        expect(p.out()).toContain('[bid-desk] SIGTERM: stopping; no new job, and up to 300 s for the one that is running');
        for (const secret of [TOKEN, TOKEN.slice('Bearer '.length), SERVICE.privateKeyHex, rawHexToBech32(SERVICE.privateKeyHex)]) expect((p.out() + p.err()).toLowerCase()).not.toContain(secret.toLowerCase());
      } finally {
        p.child.kill();
        await p.exited;
      }
    },
    90_000,
  );

  test('started with the fault value it serves the same manifest bytes as the clean start, and an unlisted fault value does not start', async () => {
    const texts: string[] = [];
    for (const fault of ['', 'quote_off_price_list']) {
      const p = run(childEnv('alfa', { FAULT_MODE: fault }));
      try {
        const base = await listening(p);
        texts.push(await (await fetch(`${base}/agent.json`)).text());
      } finally {
        p.child.kill();
        await p.exited;
      }
    }
    expect(texts[1]).toBe(texts[0]);
    const refused = run(childEnv('alfa', { FAULT_MODE: 'invert_scores' }));
    expect(await refused.exited).toBe(1);
    expect(refused.out()).not.toContain('listening on');
  }, 90_000);
});
