// agents/advocate/test/start.test.ts
// How the service starts and stops: the environment read into a configuration, its checks in their order, the buyer key, the token and the two API keys kept
// out of every other line and out of the manifest, the buyer key hash, address and public key the operator wrote down held to the key (ruling R-F11) and the
// buyer key kept apart from the supplier key, the model, the window, the allowlist and the form of its entries, the ceiling and the state directory read; the
// line it logs when it listens (it asks no third party anything at start but what its janitor reads of the chain); the chain made from the key, the stranded
// store in the state directory and the janitor on it, whose first pass settles what a stranded file of the Document Pipeline's format names, with the interval
// of its passes and the bound of its stop; a job on the settings of the environment, the allowlist the manifest names among them; a start that fails once its
// port is open; the stop of the kit with this service's log and the bounded stop of the janitor; and src/index.ts run as a process, off the real chain.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, test, expect, vi } from 'vitest';
import { FakeChain, rawHexToBech32 } from '@vsa/buyer-core';
import { sha256Utf8Hex } from '@vsa/vector-read';
import { modelGap } from '../src/gaps.ts';
import { DEFAULT_MODEL } from '../src/model.ts';
import { manifestFromEnv } from '../src/server.ts';
import {
  CHAIN_SETTINGS, JANITOR_INTERVAL_MS, JANITOR_STOP_WAIT_MS, PORT_DEFAULT, PRICE_CEILING_DEFAULT_LOVELACE, SETTINGS, SHUTDOWN_WAIT_MS, STATE_DIR_DEFAULT, WRITE_PROBE, loadConfig,
  startService, stopOnSignals,
} from '../src/start.ts';
import type { StartOptions } from '../src/start.ts';
import { CHAT_ADVERT_REF, CHAT_MODEL, INDEXER, WINDOW_MS, escrowNo } from './fake-chain-support.ts';
import type { Market } from './fake-chain-support.ts';
import { at, fixture, reply, routedFetch } from './fake-fetch.ts';
import { GOLDEN_REQUEST, GOLDEN_T0, TEST_BRAVE_KEY, TEST_OPENROUTER_KEY, braveAnswer, braveAnswers, goldenAnswer, goldenMarket, modelRoute } from './golden.ts';
import { AUTH, BUYER, BUYER_ADDRESS, FULL_ENV, SUPPLIER, T0, TEST_AUTH, TEST_CONTACT, cleanDirs, keyOf, tempDir, until, wire } from './server-support.ts';

afterEach(() => { cleanDirs(); });

const message = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as Error).message; } throw new Error('it was accepted'); };
/** The two keys of the third parties: the line of each, the key the tests use, and its name in a message. */
const KEYS = [
  { own: 'BRAVE_SEARCH_API_KEY', key: TEST_BRAVE_KEY, what: 'the Brave Search API key' },
  { own: 'OPENROUTER_API_KEY', key: TEST_OPENROUTER_KEY, what: 'the OpenRouter API key' },
] as const;
const KEY_LINES: readonly string[] = KEYS.map((k) => k.own);
/** Every line the secrets are looked for in: the settings of the service and those of the chain code. */
const SEARCHED: readonly string[] = [...SETTINGS, ...CHAIN_SETTINGS];
/** The lines a check before the search of the API keys reads: the buyer key's own, the token's own search, and the two hex values of the supplier. */
const EARLIER: readonly string[] = ['ADVOCATE_BUYER_PRIV_KEY_HEX', 'SERVICE_AUTH_HEADER', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX'];
/** Does `text` show a part of `secret` worth a search, in any case? */
const shows = (text: string, secret: string): boolean => text.toLowerCase().includes(secret.slice(-16).toLowerCase());
const KEY = BUYER.privateKeyHex;
/** A loopback port where nothing listens: one the system gave a server that has closed again. */
const closedPort = (): Promise<number> => new Promise<number>((resolve, reject) => {
  const probe = netServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});

describe('loadConfig', () => {
  test('a full environment gives the defaults for everything the operator leaves out, and the buyer identity derived from the key', () => {
    expect(loadConfig(FULL_ENV)).toStrictEqual({
      manifest: manifestFromEnv({ ...FULL_ENV, ADVOCATE_BUYER_PKH: BUYER.pkh }), authHeader: TEST_AUTH, host: '0.0.0.0', port: 9094, braveApiKey: TEST_BRAVE_KEY,
      openRouterApiKey: TEST_OPENROUTER_KEY, model: DEFAULT_MODEL, buyer: { privateKeyHex: KEY, pkh: BUYER.pkh, address: BUYER_ADDRESS }, stateDir: '/data',
      allowlist: [DEFAULT_MODEL], maxPriceLovelace: 1_000_000n,
    });
    // The janitor's interval and the bound of its stop are the Document Pipeline's (ruling R61).
    expect([PORT_DEFAULT, STATE_DIR_DEFAULT, PRICE_CEILING_DEFAULT_LOVELACE, JANITOR_INTERVAL_MS, JANITOR_STOP_WAIT_MS]).toStrictEqual([9094, '/data', 1_000_000n, 60_000, 30_000]);
    expect(BUYER_ADDRESS.startsWith('addr1v')).toBe(true);
  });

  test('every setting is read: the model, the allowlist in its order, the ceiling, the state directory, the indexer, the port and the host; an empty one is not set', () => {
    const config = loadConfig({
      ...FULL_ENV, OPENROUTER_MODEL: 'openai/gpt-4o-mini', LLM_MODEL_ALLOWLIST: ' model-a, model-b ,, model-c ', LLM_MAX_PRICE_LOVELACE: ' 250000\n', ADVOCATE_STATE_DIR: '/var/advocate',
      VECTOR_MARKETPLACE_INDEXER_URL: ' https://indexer.example.test/ ', PORT: '9100', HOST: '127.0.0.1',
    });
    expect([config.model, config.allowlist, config.maxPriceLovelace, config.stateDir, config.indexerUrl, config.port, config.host, config.manifest.gaps[4]])
      .toStrictEqual(['openai/gpt-4o-mini', ['model-a', 'model-b', 'model-c'], 250_000n, '/var/advocate', 'https://indexer.example.test/', 9100, '127.0.0.1', modelGap('model-a', 'openai/gpt-4o-mini')]);
    const blank = loadConfig({ ...FULL_ENV, OPENROUTER_MODEL: '', LLM_MODEL_ALLOWLIST: '', LLM_MAX_PRICE_LOVELACE: ' ', ADVOCATE_STATE_DIR: '', VECTOR_MARKETPLACE_INDEXER_URL: '', PORT: '', HOST: '' });
    expect(blank).toStrictEqual(loadConfig(FULL_ENV));
    expect(blank.indexerUrl).toBeUndefined();
  });

  test('the allowlist is the model of OPENROUTER_MODEL unless set, so that both paths ask the same model; a list that names none is refused (ruling R-F6)', () => {
    expect(loadConfig({ ...FULL_ENV, OPENROUTER_MODEL: 'openai/gpt-4o-mini' }).allowlist).toStrictEqual(['openai/gpt-4o-mini']);
    expect(message(() => loadConfig({ ...FULL_ENV, LLM_MODEL_ALLOWLIST: ' , ,' }))).toBe('environment variable LLM_MODEL_ALLOWLIST must name at least one model, as a comma-separated list');
  });

  test('each model of LLM_MODEL_ALLOWLIST is letters, digits, dots, underscores, colons, slashes and hyphens, for the first is published: another entry is refused by its position alone, at the start and in the manifest in the same words', () => {
    const refusal = (n: number): string => `environment variable LLM_MODEL_ALLOWLIST must be a comma-separated list of models, each of letters, digits, dots, underscores, colons, slashes and hyphens only, and its entry ${n} is not`;
    const dash = String.fromCodePoint(0x2013); // a dash that is not a hyphen, made from its code point so that this file holds none
    const refused: Array<[string, number]> = [
      ['deepseek/deepseek-v4-flash, openai/gpt 4o mini', 2], // a space inside a model
      ['deepseek/deepseek-v4-flash\nopenai/gpt-4o-mini', 1], // one model a line, not comma-separated
      ['deepseek/deepseek-v4-flash;openai/gpt-4o-mini', 1],
      [`openai/gpt-4o-mini, deepseek/deepseek${dash}v4-flash`, 2],
      ['a/one,, b/two, c three', 3], // counted among the models the list names, which an empty entry is not
      ['deepseek/deepseek-v4-flash:free openai/gpt-4o-mini', 1], // a colon is taken, a space is not
    ];
    for (const [list, n] of refused) {
      const text = message(() => loadConfig({ ...FULL_ENV, LLM_MODEL_ALLOWLIST: list }));
      expect(text, JSON.stringify(list)).toBe(refusal(n));
      expect(message(() => manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT, LLM_MODEL_ALLOWLIST: list })), JSON.stringify(list)).toBe(text);
    }
    for (const list of ['Qwen/Qwen3.6-35B-A3B-FP8', 'deepseek-v4-pro, moonshotai/kimi-k2.6', 'org_a/model.b-c', 'deepseek/deepseek-v4-flash:free', 'qwen2.5:0.5b, qwen3.6:35b']) {
      expect(loadConfig({ ...FULL_ENV, LLM_MODEL_ALLOWLIST: list }).allowlist, list).toStrictEqual(list.split(',').map((model) => model.trim()));
    }
    // A model of OPENROUTER_MODEL with a variant of OpenRouter, written out in the allowlist as the env example asks: the list of the default, and one model in the gap.
    const free = 'deepseek/deepseek-v4-flash:free';
    const written = loadConfig({ ...FULL_ENV, OPENROUTER_MODEL: free, LLM_MODEL_ALLOWLIST: free });
    expect([written.allowlist, written.manifest.gaps[4]]).toStrictEqual([loadConfig({ ...FULL_ENV, OPENROUTER_MODEL: free }).allowlist, modelGap(free, free)]);
  });

  test('LLM_MAX_PRICE_LOVELACE: 1000000 unless set, a whole number of at least 0 when set, and anything else stops the start, naming the setting and never showing the value', () => {
    expect(loadConfig({ ...FULL_ENV, LLM_MAX_PRICE_LOVELACE: '0' }).maxPriceLovelace).toBe(0n);
    for (const bad of ['one', '-1', '1.5', '1e6', '0x10', '99999999999999999999', 'secret-value']) {
      expect(message(() => loadConfig({ ...FULL_ENV, LLM_MAX_PRICE_LOVELACE: bad })), bad).toBe(`environment variable LLM_MAX_PRICE_LOVELACE must be a whole number of lovelace of at least 0, and it has ${bad.length} characters`);
    }
  });

  test('the DID is published without the space a file leaves around it', () => {
    expect(loadConfig({ ...FULL_ENV, AGENT_DID: ' did:test\n' }).manifest.identity.did).toBe('did:test');
  });

  test('seven settings are required, checked in this order, each error naming its variable; then the model, the window and the manifest, in that order', () => {
    const { OPERATOR_CONTACT, ADVOCATE_BUYER_PRIV_KEY_HEX, SUPPLIER_PKH, SERVICE_AUTH_HEADER, SUPPLIER_PUB_KEY_HEX, BRAVE_SEARCH_API_KEY, OPENROUTER_API_KEY } = FULL_ENV;
    const steps: Array<[NodeJS.ProcessEnv, string]> = [
      [{}, "environment variable OPERATOR_CONTACT is required (the operator's contact address, published in the manifest) and is not set"],
      [{ OPERATOR_CONTACT }, 'environment variable ADVOCATE_BUYER_PRIV_KEY_HEX is required (the buyer key: 64 lowercase hex characters, a raw Ed25519 key, which posts the escrow of the chat sub-job of a job) and is not set'],
      [{ OPERATOR_CONTACT, ADVOCATE_BUYER_PRIV_KEY_HEX }, 'environment variable SUPPLIER_PKH is required (the key hash of the supplier key, published in the manifest) and is not set'],
      [{ OPERATOR_CONTACT, ADVOCATE_BUYER_PRIV_KEY_HEX, SUPPLIER_PKH }, 'environment variable SERVICE_AUTH_HEADER is required (the value the template runtime sends as the authorization header of every call, which POST / requires) and is not set'],
      [{ OPERATOR_CONTACT, ADVOCATE_BUYER_PRIV_KEY_HEX, SUPPLIER_PKH, SERVICE_AUTH_HEADER }, 'environment variable SUPPLIER_PUB_KEY_HEX is required (the public key of the supplier key, published in the manifest) and is not set'],
      [{ OPERATOR_CONTACT, ADVOCATE_BUYER_PRIV_KEY_HEX, SUPPLIER_PKH, SERVICE_AUTH_HEADER, SUPPLIER_PUB_KEY_HEX }, 'environment variable BRAVE_SEARCH_API_KEY is required (the key of the Brave Search API, which the two search queries of a job send) and is not set'],
      [{ OPERATOR_CONTACT, ADVOCATE_BUYER_PRIV_KEY_HEX, SUPPLIER_PKH, SERVICE_AUTH_HEADER, SUPPLIER_PUB_KEY_HEX, BRAVE_SEARCH_API_KEY }, 'environment variable OPENROUTER_API_KEY is required (the key of OpenRouter, which the model call of a job sends when it is made through OpenRouter) and is not set'],
    ];
    for (const [env, refusal] of steps) expect(message(() => loadConfig(env))).toBe(refusal);
    const seven = { OPERATOR_CONTACT, ADVOCATE_BUYER_PRIV_KEY_HEX, SUPPLIER_PKH, SERVICE_AUTH_HEADER, SUPPLIER_PUB_KEY_HEX, BRAVE_SEARCH_API_KEY, OPENROUTER_API_KEY };
    expect(loadConfig(seven).authHeader).toBe(TEST_AUTH);
    expect(message(() => loadConfig({ ...seven, OPENROUTER_MODEL: 'no-slash', ADVERT_MAX_PROCESSING_MS: '1', AGENT_STATUS_CHIP: 'built' }))).toMatch(/^environment variable OPENROUTER_MODEL /);
    expect(message(() => loadConfig({ ...seven, ADVERT_MAX_PROCESSING_MS: '1', AGENT_STATUS_CHIP: 'built' }))).toMatch(/^environment variable ADVERT_MAX_PROCESSING_MS must be at least 480000/);
    expect(message(() => loadConfig({ ...seven, AGENT_STATUS_CHIP: 'built' }))).toMatch(/^environment variable AGENT_STATUS_CHIP /);
    // And the search for the buyer key and for the token comes before every check that could print a line.
    expect(message(() => loadConfig({ OPERATOR_CONTACT, ADVOCATE_BUYER_PRIV_KEY_HEX, SERVICE_AUTH_HEADER, AGENT_DID: TEST_AUTH }))).toMatch(/^environment variable AGENT_DID holds the service token/);
    expect(message(() => loadConfig({ OPERATOR_CONTACT, ADVOCATE_BUYER_PRIV_KEY_HEX, SUPPLIER_PKH: KEY }))).toMatch(/^environment variable SUPPLIER_PKH holds the buyer key/);
  });

  test('the supplier key hash is 56 hex characters, published in lower case; the public key must be the key of that hash, and no value is shown', () => {
    expect(loadConfig({ ...FULL_ENV, SUPPLIER_PKH: SUPPLIER.pkh.toUpperCase(), SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex.toUpperCase() }).manifest.keys).toStrictEqual({ supplier_pkh: SUPPLIER.pkh, pub_key_hex: SUPPLIER.pubKeyHex, buyer_pkh: BUYER.pkh });
    expect(message(() => loadConfig({ ...FULL_ENV, SUPPLIER_PKH: 'ab'.repeat(27) }))).toBe('environment variable SUPPLIER_PKH must be 56 hex characters, and it has 54 characters');
    const text = message(() => loadConfig({ ...FULL_ENV, SUPPLIER_PUB_KEY_HEX: 'cd'.repeat(32) }));
    expect(text).toBe('environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH: the key hash of the one is not the other. Both are published, so they must come from the same key pair, and the public key line must not hold a private key');
    expect(text).not.toMatch(/[0-9a-f]{16}/i);
  });

  describe('the buyer key (ruling R-F11)', () => {
    test('a key that is not 64 lowercase hex characters is refused with the variable named, and what it was given is never echoed', () => {
      for (const bad of [KEY.toUpperCase(), KEY.slice(2), `${KEY}00`, `0x${KEY}`, 'g'.repeat(64), '<the buyer key>']) {
        const text = message(() => loadConfig({ ...FULL_ENV, ADVOCATE_BUYER_PRIV_KEY_HEX: bad }));
        expect(text, bad).toBe('environment variable ADVOCATE_BUYER_PRIV_KEY_HEX must be 64 lowercase hex characters (a raw Ed25519 key)');
      }
      // A line break at the end of a value from a file is not part of it.
      expect(loadConfig({ ...FULL_ENV, ADVOCATE_BUYER_PRIV_KEY_HEX: `${KEY}\r\n` }).buyer.privateKeyHex).toBe(KEY);
    });

    test('the key in any other line, the chain\'s among them, is refused, naming that line and not showing the key: raw, in another case, inside a longer value, and as bech32', () => {
      for (const name of SEARCHED.filter((n) => n !== 'ADVOCATE_BUYER_PRIV_KEY_HEX')) {
        for (const value of [KEY, KEY.toUpperCase(), `prefix-${KEY}-suffix`, rawHexToBech32(KEY), `did:vector:agent:${KEY}`]) {
          const text = message(() => loadConfig({ ...FULL_ENV, [name]: value }));
          expect(text, `${name} = ${value.slice(0, 12)}`).toBe(`environment variable ${name} holds the buyer key, which belongs in ADVOCATE_BUYER_PRIV_KEY_HEX alone: it would be printed or published. Take it out of ${name}`);
          expect(shows(text, KEY)).toBe(false);
        }
      }
      expect([...CHAIN_SETTINGS]).toStrictEqual(['VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL']);
    });

    test('the key hash, the address and the public key the operator wrote down must be the key\'s: in any case they are taken, otherwise refused, naming the line and what it was checked against, never the value', () => {
      const written = loadConfig({ ...FULL_ENV, ADVOCATE_BUYER_PKH: BUYER.pkh.toUpperCase(), ADVOCATE_BUYER_ADDRESS: ` ${BUYER_ADDRESS}\n`, ADVOCATE_BUYER_PUB_KEY_HEX: BUYER.pubKeyHex.toUpperCase() });
      expect(written.manifest).toStrictEqual(loadConfig(FULL_ENV).manifest);
      const other = keyOf('advocate service test: another key');
      const pkh = message(() => loadConfig({ ...FULL_ENV, ADVOCATE_BUYER_PKH: other.pkh }));
      expect(pkh).toBe(`environment variable ADVOCATE_BUYER_PKH (56 characters) is not the key hash of the key in ADVOCATE_BUYER_PRIV_KEY_HEX (the hash of that key is ${BUYER.pkh}); correct the line or remove it`);
      const address = message(() => loadConfig({ ...FULL_ENV, ADVOCATE_BUYER_ADDRESS: new FakeChain({ buyerPkh: other.pkh }).address }));
      expect(address).toMatch(new RegExp(`^environment variable ADVOCATE_BUYER_ADDRESS \\(\\d+ characters\\) is not the address of the key in ADVOCATE_BUYER_PRIV_KEY_HEX \\(the address of that key is ${BUYER_ADDRESS}\\); correct the line or remove it$`));
      const pub = message(() => loadConfig({ ...FULL_ENV, ADVOCATE_BUYER_PUB_KEY_HEX: other.pubKeyHex }));
      expect(pub).toBe(`environment variable ADVOCATE_BUYER_PUB_KEY_HEX is not the public key of the key in ADVOCATE_BUYER_PRIV_KEY_HEX (the key hash of that key is ${BUYER.pkh}); correct the line or remove it`);
      expect(message(() => loadConfig({ ...FULL_ENV, ADVOCATE_BUYER_PUB_KEY_HEX: 'ab'.repeat(31) }))).toBe('environment variable ADVOCATE_BUYER_PUB_KEY_HEX must be 64 hex characters, and it has 62 characters');
      for (const text of [pkh, address, pub]) expect(shows(text, KEY)).toBe(false);
      expect(pkh).not.toContain(other.pkh);
      expect(pub).not.toContain(other.pubKeyHex);
    });

    test("a buyer key whose key hash is SUPPLIER_PKH, the supplier key itself, is refused, naming the two settings and no value: the supplier key is the runtime's", () => {
      const pair = keyOf('advocate service test: one key in both roles');
      const both = { ...FULL_ENV, SUPPLIER_PKH: pair.pkh, SUPPLIER_PUB_KEY_HEX: pair.pubKeyHex, ADVOCATE_BUYER_PRIV_KEY_HEX: pair.privateKeyHex };
      const text = message(() => loadConfig(both));
      expect(text).toBe("environment variable ADVOCATE_BUYER_PRIV_KEY_HEX holds the key of SUPPLIER_PKH: the supplier key is the runtime's, and the buyer key must be a key of its own");
      expect(message(() => loadConfig({ ...both, SUPPLIER_PKH: pair.pkh.toUpperCase() }))).toBe(text);
      expect(text).not.toMatch(/[0-9a-f]{16}/i);
      // The same buyer key beside a supplier key of its own starts.
      expect(loadConfig({ ...both, SUPPLIER_PKH: SUPPLIER.pkh, SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex }).buyer.pkh).toBe(pair.pkh);
    });

    test('the manifest is looked at last for the key in both its forms and in any case: whatever put it in a value that is published, the start stops, unprinted', () => {
      for (const leaked of [KEY, KEY.toUpperCase(), rawHexToBech32(KEY)]) {
        const text = message(() => loadConfig(FULL_ENV, (env) => ({ ...manifestFromEnv(env), description: `from somewhere else: ${leaked}` })));
        expect(text).toBe('the manifest would publish the buyer key: a value that goes into it holds the key, and the service does not start with it');
      }
    });
  });

  describe('the service token', () => {
    test('a token of the form the runbook makes is accepted; one that is not printable ASCII is refused with its length only', () => {
      expect(loadConfig(FULL_ENV).authHeader).toHaveLength(71);
      expect(message(() => loadConfig({ ...FULL_ENV, SERVICE_AUTH_HEADER: `Bearer ${'ab'.repeat(30)}\u{e9}` }))).toBe('environment variable SERVICE_AUTH_HEADER must be printable ASCII (it is sent as an HTTP header), and it has 68 characters');
    });
    test('the token in any other setting, the chain\'s among them, is refused, naming that setting and not showing it: whole or its credential, in any case, inside a longer value', () => {
      const credential = TEST_AUTH.slice('Bearer '.length);
      for (const name of SEARCHED.filter((n) => n !== 'SERVICE_AUTH_HEADER' && n !== 'ADVOCATE_BUYER_PRIV_KEY_HEX')) {
        for (const value of [TEST_AUTH, credential.toUpperCase(), `x${credential}y`]) {
          const text = message(() => loadConfig({ ...FULL_ENV, [name]: value }));
          expect(text, name).toBe(`environment variable ${name} holds the service token, which belongs in SERVICE_AUTH_HEADER alone: it would be printed or published. Take it out of ${name}`);
          expect(shows(text, credential)).toBe(false);
        }
      }
      // In the line of the buyer key, the token is refused by the form of a key, which shows nothing either.
      expect(message(() => loadConfig({ ...FULL_ENV, ADVOCATE_BUYER_PRIV_KEY_HEX: TEST_AUTH }))).toBe('environment variable ADVOCATE_BUYER_PRIV_KEY_HEX must be 64 lowercase hex characters (a raw Ed25519 key)');
    });
  });

  describe('the two API keys', () => {
    test('a key is at least 20 characters of letters, digits, dots, hyphens and underscores (R-E31), and one that is not is refused with its length only; the space a file leaves around it is not part of it', () => {
      const refused = [
        ['BRAVE_SEARCH_API_KEY', 'BSA one two three four'], ['OPENROUTER_API_KEY', `sk-or-v1-${'ab'.repeat(30)}\u{e9}`], ['BRAVE_SEARCH_API_KEY', `BSA${'a'.repeat(16)}`],
        ['OPENROUTER_API_KEY', `sk-or-v1-${'ab'.repeat(10)}/x`], ['OPENROUTER_API_KEY', `sk-or-v1-${'ab'.repeat(10)}"x`], ['BRAVE_SEARCH_API_KEY', `BSA${'a'.repeat(20)}\\x`],
        ['BRAVE_SEARCH_API_KEY', `BSA${'a'.repeat(20)}+x`], ['OPENROUTER_API_KEY', `sk-or-v1-${'ab'.repeat(10)}(x)`],
      ] as const;
      for (const [name, bad] of refused) {
        const text = message(() => loadConfig({ ...FULL_ENV, [name]: bad }));
        expect(text, bad).toBe(`environment variable ${name} must be at least 20 characters of letters, digits, dots, hyphens and underscores, and it has ${bad.length} characters`);
        expect(text, bad).not.toContain(bad.slice(0, 12));
      }
      for (const good of [`BSA${'a'.repeat(17)}`, `sk-or-v1-${'0123456789abcdef'.repeat(4)}`, 'a.b-c_d'.repeat(3)]) expect(loadConfig({ ...FULL_ENV, BRAVE_SEARCH_API_KEY: good }).braveApiKey, good).toBe(good);
      expect(loadConfig({ ...FULL_ENV, BRAVE_SEARCH_API_KEY: ` ${TEST_BRAVE_KEY}\n` }).braveApiKey).toBe(TEST_BRAVE_KEY);
    });

    test('a key in any other setting, the chain\'s among them, is refused, naming that setting and not showing the key: whole, in another case, inside a longer value', () => {
      for (const { own, key, what } of KEYS) {
        for (const name of SEARCHED.filter((n) => !KEY_LINES.includes(n) && !EARLIER.includes(n))) {
          for (const value of [key, key.toUpperCase(), `x${key}y`]) {
            const text = message(() => loadConfig({ ...FULL_ENV, [name]: value }));
            expect(text, `${own} in ${name}`).toBe(`environment variable ${name} holds ${what}, which belongs in ${own} alone: it would be printed or published. Take it out of ${name}`);
            expect(shows(text, key)).toBe(false);
          }
        }
      }
    });

    test('a key in a line that a check before the search reads (the buyer key, the token, the key hash, the public key) is refused there, and the message shows no key', () => {
      for (const { key } of KEYS) {
        for (const name of EARLIER) {
          const text = message(() => loadConfig({ ...FULL_ENV, [name]: key }));
          expect(shows(text, key), `${name}: ${text}`).toBe(false);
        }
      }
    });

    test("the two keys in each other's line, or one key in both, are refused, naming one of the two lines, and neither key is shown", () => {
      for (const env of [
        { ...FULL_ENV, BRAVE_SEARCH_API_KEY: TEST_OPENROUTER_KEY },
        { ...FULL_ENV, OPENROUTER_API_KEY: TEST_BRAVE_KEY },
        { ...FULL_ENV, OPENROUTER_API_KEY: `${TEST_OPENROUTER_KEY}${TEST_BRAVE_KEY}` },
      ]) {
        const text = message(() => loadConfig(env));
        expect(text).toMatch(/^environment variable (BRAVE_SEARCH_API_KEY|OPENROUTER_API_KEY) holds the (Brave Search|OpenRouter) API key, /);
        expect(shows(text, TEST_BRAVE_KEY) || shows(text, TEST_OPENROUTER_KEY)).toBe(false);
      }
    });
  });

  test('the manifest is looked at last: one that would publish the token or either API key stops the start, and says which', () => {
    const leaky = (secret: string) => (env: NodeJS.ProcessEnv) => ({ ...manifestFromEnv(env), description: `see ${secret}` });
    expect(message(() => loadConfig(FULL_ENV, leaky(TEST_AUTH)))).toBe('the manifest would publish the service token: a value that goes into it holds the token of SERVICE_AUTH_HEADER, and the service does not start with it');
    expect(message(() => loadConfig(FULL_ENV, leaky(TEST_BRAVE_KEY)))).toBe('the manifest would publish the Brave Search API key: a value that goes into it holds the key of BRAVE_SEARCH_API_KEY, and the service does not start with it');
    expect(message(() => loadConfig(FULL_ENV, leaky(TEST_OPENROUTER_KEY.toUpperCase())))).toBe('the manifest would publish the OpenRouter API key: a value that goes into it holds the key of OPENROUTER_API_KEY, and the service does not start with it');
  });

  test('OPENROUTER_MODEL: absent or empty is the default; an id of OpenRouter is used, in the config and in the gap of the manifest; anything else is refused', () => {
    expect(loadConfig({ ...FULL_ENV, OPENROUTER_MODEL: ' ' }).model).toBe(DEFAULT_MODEL);
    const config = loadConfig({ ...FULL_ENV, OPENROUTER_MODEL: ' openai/gpt-4o-mini ' });
    expect([config.model, config.manifest.gaps[4]]).toStrictEqual(['openai/gpt-4o-mini', modelGap('openai/gpt-4o-mini', 'openai/gpt-4o-mini')]);
    for (const bad of ['deepseek', '/deepseek', 'deepseek/', 'deep seek/v4', 'deepseek/v4\u{e9}']) {
      expect(message(() => loadConfig({ ...FULL_ENV, OPENROUTER_MODEL: bad })), bad).toMatch(/^environment variable OPENROUTER_MODEL must be the id of a model of OpenRouter, <provider>\/<name> in printable ASCII without spaces, such as deepseek\/deepseek-v4-flash, got /);
    }
  });

  test('ADVERT_MAX_PROCESSING_MS: at least 480000, the window the deadline of a job assumes; a larger window is published (ruling R-F2)', () => {
    for (const bad of ['0', '300000', '479999']) {
      expect(message(() => loadConfig({ ...FULL_ENV, ADVERT_MAX_PROCESSING_MS: bad }))).toBe(`environment variable ADVERT_MAX_PROCESSING_MS must be at least 480000 (the window of 8 min that the deadline of a job, 300000 ms, assumes), got ${bad}`);
    }
    expect(message(() => loadConfig({ ...FULL_ENV, ADVERT_MAX_PROCESSING_MS: 'five' }))).toMatch(/^environment variable ADVERT_MAX_PROCESSING_MS must be a non-negative integer/);
    expect(loadConfig({ ...FULL_ENV, ADVERT_MAX_PROCESSING_MS: '600000' }).manifest.terms.max_processing_ms).toBe(600_000);
  });

  test('SETTINGS are the names the service reads, each once: the list of Plan E with the buyer key, its identity, the state directory and what the hire reads', () => {
    expect([...SETTINGS]).toStrictEqual([
      'OPERATOR_CONTACT', 'AGENT_DID', 'AGENT_VERSION', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_PRICE_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_EXPLORER_URL',
      'SERVICE_AUTH_HEADER', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'BRAVE_SEARCH_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL',
      'ADVOCATE_BUYER_PRIV_KEY_HEX', 'ADVOCATE_BUYER_PUB_KEY_HEX', 'ADVOCATE_BUYER_PKH', 'ADVOCATE_BUYER_ADDRESS', 'ADVOCATE_STATE_DIR', 'LLM_MODEL_ALLOWLIST',
      'LLM_MAX_PRICE_LOVELACE', 'VECTOR_MARKETPLACE_INDEXER_URL', 'PORT', 'HOST',
    ]);
    expect(new Set(SEARCHED).size).toBe(SEARCHED.length);
  });
});

describe('startService', () => {
  const logs: string[] = [];
  const log = (line: string): void => { logs.push(line); };
  const running: Array<{ stop: () => Promise<void> }> = [];
  afterEach(async () => { await Promise.all(running.splice(0).map((s) => s.stop())); logs.length = 0; });
  /** A fetch that records any call, and answers none: the start makes no outbound call. */
  const outbound: string[] = [];
  const noCall = (async (input: RequestInfo | URL) => { outbound.push(String(input)); throw new Error('no outbound call at start'); }) as typeof fetch;
  afterEach(() => { outbound.length = 0; });
  const envIn = (dir: string, over: Record<string, string> = {}) => ({ ...FULL_ENV, PORT: '0', HOST: '127.0.0.1', ADVOCATE_STATE_DIR: dir, ...over });
  const optionsWith = (over: StartOptions = {}): StartOptions => ({ createChain: async () => new FakeChain({ buyerPkh: BUYER.pkh }), fetchImpl: noCall, log, janitorIntervalMs: 3_600_000, ...over });
  async function start(env: Record<string, string>, over: StartOptions = {}) {
    const service = await startService(env, optionsWith(over));
    running.push(service);
    return service;
  }
  /** The golden request, with the token of the runtime, to a service that is running. */
  const postJob = (port: number): Promise<Response> => fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: wire(GOLDEN_REQUEST), headers: AUTH });

  test('listens, serves the manifest with the buyer key hash derived from the key, refuses a job without the token, and logs its search, its model, its buyer address and its state directory; it asks no third party anything, and no line holds a secret', async () => {
    const dir = tempDir();
    const service = await start(envIn(dir));
    const base = `http://127.0.0.1:${service.port}`;
    const manifest = await (await fetch(`${base}/agent.json`)).json();
    expect(manifest.keys).toStrictEqual({ supplier_pkh: SUPPLIER.pkh, pub_key_hex: SUPPLIER.pubKeyHex, buyer_pkh: BUYER.pkh });
    expect(await (await fetch(`${base}/healthz`)).json()).toStrictEqual({ ok: true });
    expect((await fetch(`${base}/`, { method: 'POST', body: wire(GOLDEN_REQUEST) })).status).toBe(401);
    expect(logs).toContain(`listening on 127.0.0.1:${service.port}; search Brave Search API; model deepseek/deepseek-v4-flash from the Vector marketplace, OpenRouter as the fallback; buyer address ${BUYER_ADDRESS}; state directory ${dir}`);
    expect(outbound).toStrictEqual([]);
    for (const secret of [TEST_AUTH, TEST_BRAVE_KEY, TEST_OPENROUTER_KEY, KEY]) expect(shows(logs.join('\n'), secret)).toBe(false);
  });

  test('the listening line names the model of each path as the manifest does: once when the first of LLM_MODEL_ALLOWLIST is the model of OPENROUTER_MODEL, both when it is another (ruling R-F19)', async () => {
    const same = await start(envIn(tempDir(), { LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash, openai/gpt-4o-mini' }));
    const other = await start(envIn(tempDir(), { LLM_MODEL_ALLOWLIST: 'openai/gpt-4o-mini, deepseek/deepseek-v4-flash' }));
    const lineOf = (port: number): string | undefined => logs.find((l) => l.startsWith(`listening on 127.0.0.1:${port};`));
    expect(lineOf(same.port)).toContain('; model deepseek/deepseek-v4-flash from the Vector marketplace, OpenRouter as the fallback;');
    expect(lineOf(other.port)).toContain('; model openai/gpt-4o-mini from the Vector marketplace, OpenRouter deepseek/deepseek-v4-flash as the fallback;');
    const gapOf = async (port: number): Promise<string> => (await (await fetch(`http://127.0.0.1:${port}/agent.json`)).json()).gaps[4];
    expect([await gapOf(same.port), await gapOf(other.port)]).toStrictEqual([modelGap(DEFAULT_MODEL, DEFAULT_MODEL), modelGap('openai/gpt-4o-mini', DEFAULT_MODEL)]);
  });

  test('makes the chain from the key of the environment, and only once the environment, the stranded store and the state directory have passed', async () => {
    const keys: string[] = [];
    await start(envIn(tempDir()), { createChain: async ({ privateKeyHex }) => { keys.push(privateKeyHex); return new FakeChain({ buyerPkh: BUYER.pkh }); } });
    expect(keys).toStrictEqual([KEY]);
  });

  test('a start without the buyer key, with a wrong buyer key hash, or without the token is refused before anything is made: no chain, no state directory, no listener', async () => {
    const dir = join(tempDir(), 'state');
    let made = 0;
    const counting = optionsWith({ createChain: async () => { made += 1; return new FakeChain(); } });
    const { ADVOCATE_BUYER_PRIV_KEY_HEX: _key, ...withoutKey } = envIn(dir);
    await expect(startService(withoutKey, counting)).rejects.toThrow(/^environment variable ADVOCATE_BUYER_PRIV_KEY_HEX is required/);
    await expect(startService(envIn(dir, { ADVOCATE_BUYER_PKH: 'cd'.repeat(28) }), counting)).rejects.toThrow(/ADVOCATE_BUYER_PKH/);
    await expect(startService(envIn(dir, { SERVICE_AUTH_HEADER: ' ' }), counting)).rejects.toThrow(/^environment variable SERVICE_AUTH_HEADER is required/);
    expect([made, existsSync(dir), logs.filter((l) => l.startsWith('listening on'))]).toStrictEqual([0, false, []]);
  });

  test('a stranded file that is not a list stops the start before a chain is made, and the file is left as it is', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'stranded.json'), 'this is not a list', 'utf8');
    let made = 0;
    await expect(startService(envIn(dir), optionsWith({ createChain: async () => { made += 1; return new FakeChain(); } }))).rejects.toThrow(/stranded\.json is not a list of stranded escrows/);
    expect(made).toBe(0);
    expect(readFileSync(join(dir, 'stranded.json'), 'utf8')).toBe('this is not a list');
  });

  test('a state directory that cannot be written stops the start before a chain is made, and a good one is left as it was found', async () => {
    const bad = tempDir();
    mkdirSync(join(bad, WRITE_PROBE)); // a directory where the probe file goes: writing it fails on every platform
    let made = 0;
    await expect(startService(envIn(bad), optionsWith({ createChain: async () => { made += 1; return new FakeChain(); } }))).rejects.toThrow(/^environment variable ADVOCATE_STATE_DIR names .* which cannot be written/);
    expect(made).toBe(0);
    const good = tempDir();
    await start(envIn(good));
    expect(readdirSync(good)).toStrictEqual([]); // no probe left behind, and no stranded file until there is an escrow to put in it
  });

  test('a start that fails once the port is open closes the port again', async () => {
    const free = await closedPort();
    await expect(startService(envIn(tempDir(), { PORT: String(free) }), optionsWith({ janitorIntervalMs: 0 }))).rejects.toThrow(/janitor interval/);
    await expect(fetch(`http://127.0.0.1:${free}/healthz`)).rejects.toThrow();
  });

  test("the janitor's first pass settles what a stranded file of the Document Pipeline's format names: the Open escrow is reclaimed, the Submitted one kept with the time from which its supplier may release it (Review Focus 1)", async () => {
    const m = goldenMarket();
    // Two escrows a job left behind: one Open (its send failed), one Submitted (its receipt failed a check); both long past their deliver_by.
    const open = await m.chain.postEscrow({ advertRef: CHAT_ADVERT_REF, promptHash: 'ab'.repeat(32) });
    const submitted = await m.chain.postEscrow({ advertRef: CHAT_ADVERT_REF, promptHash: 'cd'.repeat(32) });
    m.chain.markClaimed(submitted.escrowRef);
    m.chain.markSubmitted(submitted.escrowRef, 'ef'.repeat(32));
    const dir = tempDir();
    const entries = [open, submitted].map((post) => ({ escrow_ref: post.escrowRef, deliver_by: post.deliverBy, posted_at: post.postedAt, kind: 'llm' }));
    // The file as the Pipeline's store writes it: the list, indented by two, and a line break at the end.
    writeFileSync(join(dir, 'stranded.json'), `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    m.clock.now = GOLDEN_T0 + WINDOW_MS + 180_000 + 5_000;
    await start(envIn(dir), { createChain: async () => m.chain, clock: () => m.clock.now });
    await until(() => logs.some((line) => line.startsWith(`janitor: kept ${submitted.escrowRef}`)), 'the janitor has made its first pass');
    const lostAfter = submitted.deliverBy + 600_000;
    // FakeChain names the Reclaim of an escrow by the sha256 of its prefix, the word reclaim and the escrow.
    const reclaim = sha256Utf8Hex(`advocate-test/reclaim/${open.escrowRef}`);
    expect(logs.filter((line) => line.startsWith('janitor: '))).toStrictEqual([
      `janitor: reclaimed ${open.escrowRef}: Open: the Reclaim ${reclaim} returned everything it locked`,
      `janitor: kept ${submitted.escrowRef}: Submitted: it cannot be reclaimed, and its supplier may release it from ${new Date(lostAfter).toISOString()} at the latest`,
    ]);
    expect([await m.chain.escrowState(open.escrowRef), await m.chain.escrowState(submitted.escrowRef)]).toStrictEqual(['spent', 'Submitted']);
    expect(JSON.parse(readFileSync(join(dir, 'stranded.json'), 'utf8'))).toStrictEqual([{ ...entries[1], lost_to_release_after: lostAfter }]);
  });

  /**
   * A job whose search finds one page at an https IP literal, which safeFetch reaches without a host lookup, on the marketplace `m`: its routes, the page,
   * and OpenRouter, which counts its calls in `openRouter`.
   */
  function ipJob(m: Market, openRouter: number[]): typeof fetch {
    const page = 'https://203.0.113.51/car-free-centres';
    return routedFetch([
      ...braveAnswers(() => braveAnswer([{ title: 'Car-free centres: what the evidence says', url: page, description: 'd' }])),
      { match: at(page), respond: () => reply(200, fixture('page-1.html'), { 'content-type': 'text/html' }) },
      ...m.routes,
      modelRoute(() => { openRouter.push(1); return goldenAnswer(); }),
    ]);
  }

  test('a job runs on the settings of the environment: the allowlist, the ceiling and the indexer it names, the chain it makes, and the stranded store in its state directory', async () => {
    const m = goldenMarket();
    const dir = tempDir();
    const openRouter: number[] = [];
    const service = await start(envIn(dir, { VECTOR_MARKETPLACE_INDEXER_URL: INDEXER }), {
      createChain: async () => m.chain, fetchImpl: ipJob(m, openRouter), clock: () => m.clock.now, sleep: m.sleep,
    });
    const reply1 = await postJob(service.port);
    const first = await reply1.json();
    expect([reply1.status, first.model, first.inference.path, first.inference.sub_job.escrow_ref, openRouter]).toStrictEqual([200, 'deepseek/deepseek-v4-flash via the Vector marketplace', 'marketplace', escrowNo(1), []]);
    expect(JSON.parse(readFileSync(join(dir, 'stranded.json'), 'utf8'))).toStrictEqual([]); // the store is there, and the escrow was accepted
    expect(logs.filter((line) => line.startsWith('job done'))).toStrictEqual(['job done in 6000 ms: results 1, pages 1, arguments 1 (dropped 2), quotes dropped 4, tokens 4321/512; inference marketplace']);
    // The next job: the supplier signs with a key that is not its own, the receipt fails, the escrow it left is in the state directory, and OpenRouter answers.
    m.supplier.forge = true;
    const reply2 = await postJob(service.port);
    const second = await reply2.json();
    expect([reply2.status, second.inference, openRouter]).toStrictEqual([200, { path: 'openrouter', fallback_from: 'llm_receipt_failed', sub_job: null, accepted: null }, [1]]);
    expect(JSON.parse(readFileSync(join(dir, 'stranded.json'), 'utf8'))).toMatchObject([{ escrow_ref: escrowNo(2), kind: 'llm' }]);
    // A ceiling under the price of the advert: the next job finds no supplier and goes to OpenRouter.
    const cheap = await start(envIn(tempDir(), { VECTOR_MARKETPLACE_INDEXER_URL: INDEXER, LLM_MAX_PRICE_LOVELACE: '199999' }), {
      createChain: async () => m.chain, fetchImpl: ipJob(m, openRouter), clock: () => m.clock.now, sleep: m.sleep,
    });
    expect((await (await postJob(cheap.port)).json()).inference.fallback_from).toBe('llm_supplier_unavailable');
  });

  test('the allowlist of LLM_MODEL_ALLOWLIST reaches the hire of a job and the manifest alike: the gap and the listening line name its first model, and the hire buys a model on it and no other (ruling R-F19)', async () => {
    /** A service on the list `models` and a market of its own, and the answer of one job: the market's one chat supplier sells CHAT_MODEL. */
    const jobOn = async (models: string) => {
      const m = goldenMarket();
      const openRouter: number[] = [];
      const service = await start(envIn(tempDir(), { VECTOR_MARKETPLACE_INDEXER_URL: INDEXER, LLM_MODEL_ALLOWLIST: models }), {
        createChain: async () => m.chain, fetchImpl: ipJob(m, openRouter), clock: () => m.clock.now, sleep: m.sleep,
      });
      const answer = await (await postJob(service.port)).json();
      return { port: service.port, answer, openRouter };
    };
    // Another model alone: no supplier of it is listed, so nothing is hired and the brief comes from OpenRouter.
    const alone = await jobOn('other/model');
    expect([alone.answer.inference.path, alone.answer.inference.fallback_from, alone.openRouter]).toStrictEqual(['openrouter', 'llm_supplier_unavailable', [1]]);
    // The model of the supplier second on the list: the hire buys it on the marketplace.
    const second = await jobOn(`other/model, ${CHAT_MODEL}`);
    expect([second.answer.inference.path, second.answer.model, second.openRouter]).toStrictEqual(['marketplace', `${CHAT_MODEL} via the Vector marketplace`, []]);
    // Both manifests and both listening lines name the first model of the list each hire was given.
    for (const { port } of [alone, second]) {
      expect((await (await fetch(`http://127.0.0.1:${port}/agent.json`)).json()).gaps[4]).toBe(modelGap('other/model', DEFAULT_MODEL));
      expect(logs.find((line) => line.startsWith(`listening on 127.0.0.1:${port};`))).toContain(`; model other/model from the Vector marketplace, OpenRouter ${DEFAULT_MODEL} as the fallback;`);
    }
  });

  test('the janitor is given the job slot: a pass while a job runs defers the Reclaim of a due escrow, and the first pass after the job reclaims it', async () => {
    const m = goldenMarket();
    // An escrow an earlier job left behind, posted so that its deliver_by is 10 s after the arrival of the job: due 5 s later.
    m.clock.now = GOLDEN_T0 - WINDOW_MS - 180_000 + 10_000;
    const left = await m.chain.postEscrow({ advertRef: CHAT_ADVERT_REF, promptHash: 'ab'.repeat(32) });
    m.clock.now = GOLDEN_T0;
    const dir = tempDir();
    writeFileSync(join(dir, 'stranded.json'), `${JSON.stringify([{ escrow_ref: left.escrowRef, deliver_by: left.deliverBy, posted_at: left.postedAt, kind: 'llm' }], null, 2)}\n`, 'utf8');
    let sleeping = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = await start(envIn(dir, { VECTOR_MARKETPLACE_INDEXER_URL: INDEXER }), {
      createChain: async () => m.chain, fetchImpl: ipJob(m, []), clock: () => m.clock.now, janitorIntervalMs: 20,
      sleep: async (ms) => { sleeping = true; await gate; await m.sleep(ms); },
    });
    const job = postJob(service.port).then((r) => r.status, () => 'closed');
    await until(() => sleeping, 'the job is in its hop');
    m.clock.now = left.deliverBy + 5_000; // the escrow left behind is due now
    await until(() => logs.some((line) => line.startsWith('janitor: 1 transaction deferred: a job is running')), 'a pass has deferred the Reclaim');
    expect(await m.chain.escrowState(left.escrowRef)).toBe('Open');
    release();
    expect(await job).toBe(200);
    await until(() => logs.some((line) => line.startsWith(`janitor: reclaimed ${left.escrowRef}`)), 'the first pass after the job has reclaimed it');
    expect(await m.chain.escrowState(left.escrowRef)).toBe('spent');
  });

  test('stop closes the server and the janitor, and is safe to call twice', async () => {
    const service = await start(envIn(tempDir()));
    await service.stop();
    await expect(fetch(`http://127.0.0.1:${service.port}/healthz`)).rejects.toThrow();
    await service.stop();
  });

  test('the janitor is stopped with a bound: a pass still in flight after the bound is abandoned, with a log line, and the stop goes on', async () => {
    const dir = tempDir();
    // An escrow long past its deliver_by, so that the first pass of the janitor reads its state, and a chain whose read never answers.
    writeFileSync(join(dir, 'stranded.json'), JSON.stringify([{ escrow_ref: escrowNo(9), deliver_by: 1, posted_at: 0, kind: 'llm' }]), 'utf8');
    const chain = new FakeChain({ buyerPkh: BUYER.pkh });
    let reads = 0;
    chain.escrowState = () => { reads += 1; return new Promise(() => undefined); };
    const service = await start(envIn(dir), { createChain: async () => chain, janitorIntervalMs: 60_000, janitorStopWaitMs: 200 });
    await until(() => reads > 0, 'the janitor reads the state of the escrow');
    const began = Date.now();
    expect(await service.shutdown(30_000)).toBe('finished');
    expect(Date.now() - began).toBeGreaterThanOrEqual(190);
    expect(Date.now() - began).toBeLessThan(5000);
    expect(logs.join('\n')).toContain("stopping: the janitor's pass did not end within 0.2 s and is abandoned; the janitor of the next start reads the state directory again");
    await expect(fetch(`http://127.0.0.1:${service.port}/healthz`)).rejects.toThrow();
  });

  test("a start given neither seam of the janitor runs a pass every JANITOR_INTERVAL_MS and gives a pass in flight JANITOR_STOP_WAIT_MS at a stop: the Pipeline's 60 s and 30 s (ruling R61)", async () => {
    const dir = tempDir();
    // An escrow long past its deliver_by, so that every pass reads its state: the first two reads answer Submitted, and the third answers only when let go.
    writeFileSync(join(dir, 'stranded.json'), JSON.stringify([{ escrow_ref: escrowNo(9), deliver_by: 1, posted_at: 0, kind: 'llm' }]), 'utf8');
    const chain = new FakeChain({ buyerPkh: BUYER.pkh });
    let reads = 0;
    let letGo: (state: 'Submitted') => void = () => undefined;
    chain.escrowState = async () => {
      reads += 1;
      if (reads < 3) return 'Submitted';
      return new Promise((resolve) => { letGo = resolve; });
    };
    /** Lets what is due run on the real event loop: only the timers the janitor and its stop set are fake. */
    const settle = async (): Promise<void> => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    try {
      service = await startService(envIn(dir), { createChain: async () => chain, fetchImpl: noCall, log }); // no janitorIntervalMs, no janitorStopWaitMs
      await settle();
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(JANITOR_INTERVAL_MS - 1);
      await settle();
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(reads).toBe(2);
      await vi.advanceTimersByTimeAsync(JANITOR_INTERVAL_MS);
      await settle();
      expect(reads).toBe(3); // a pass in flight, which the stop finds
      let stopped = false;
      const stopping = service.stop().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(JANITOR_STOP_WAIT_MS - 1);
      await settle();
      expect([stopped, logs.filter((line) => line.startsWith('stopping:'))]).toStrictEqual([false, []]);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(logs).toContain("stopping: the janitor's pass did not end within 30 s and is abandoned; the janitor of the next start reads the state directory again");
      vi.useRealTimers();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      letGo('Submitted'); // the pass ends, so that a stop after a failure here does not wait the 30 s on the real clock
      vi.useRealTimers();
      await service?.stop();
    }
  });

  test('a shutdown that has to abandon a job in its hop names the escrow the state directory holds for the janitor of the next start, and says abandoned', async () => {
    const m = goldenMarket();
    let sleeping = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = await start(envIn(tempDir(), { VECTOR_MARKETPLACE_INDEXER_URL: INDEXER }), {
      createChain: async () => m.chain, fetchImpl: ipJob(m, []), clock: () => m.clock.now, sleep: async (ms) => { sleeping = true; await gate; await m.sleep(ms); },
    });
    const job = postJob(service.port);
    job.catch(() => undefined);
    await until(() => sleeping, 'the job is in its hop');
    expect(await service.shutdown(150)).toBe('abandoned');
    expect(logs.join('\n')).toContain(`stopping: the job that is running did not finish within 150 ms and is abandoned; the state directory holds 1 escrow for the janitor of the next start: ${escrowNo(1)}`);
    release(); // let the hop end, so that nothing of it is still running when the directory of the test goes
    await until(async () => (await m.chain.escrowState(escrowNo(1))) === 'spent', 'the hop has ended');
  });

  test('a shutdown with no job running finishes at once and closes the port; the wait is 300 s by default', async () => {
    const service = await start(envIn(tempDir()));
    await expect(service.shutdown()).resolves.toBe('finished');
    await expect(fetch(`http://127.0.0.1:${service.port}/healthz`)).rejects.toThrow();
    expect(SHUTDOWN_WAIT_MS).toBe(300_000);
  });

  test('a job runs on the clock the start is given: the line of its failure gives its time on that clock', async () => {
    // The search takes 7 s on the clock of the service, and the key is refused (the janitor reads the same clock at start, before any job).
    let now = T0;
    const clock = (): number => now;
    const refusing = (async () => { now += 7_000; return new Response('{"error":"refused"}', { status: 401 }); }) as typeof fetch;
    const service = await start(envIn(tempDir()), { fetchImpl: refusing, clock });
    expect((await postJob(service.port)).status).toBe(502);
    expect(logs.filter((l) => l.startsWith('job failed'))).toStrictEqual(['job failed after 7000 ms: search_failed (502): the Brave Search API refused the key (HTTP 401)']);
  });

  test('SIGTERM starts the shutdown with the log of this service and exits 0; the second signal finds no handler', async () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    const lines: string[] = [];
    stopOnSignals({ shutdown: async () => 'finished' }, { target, exit: (code) => exits.push(code), log: (line) => lines.push(line) });
    target.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));
    expect([exits, lines]).toStrictEqual([[0], ['SIGTERM: stopping; no new job, and up to 300 s for the one that is running']]);
    expect(target.listenerCount('SIGTERM') + target.listenerCount('SIGINT')).toBe(0);
  });
});

describe('src/index.ts as a process', () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  /** The chain and the marketplace indexer at a loopback port where nothing listens. */
  let offChain: Record<string, string> = {};
  beforeAll(async () => {
    const node = `http://127.0.0.1:${await closedPort()}`;
    offChain = { VECTOR_OGMIOS_URL: node, VECTOR_KOIOS_URL: `${node}/`, VECTOR_SUBMIT_URL: `${node}/api/submit/tx`, VECTOR_MARKETPLACE_INDEXER_URL: node };
  });
  /**
   * Starts src/index.ts on `env` over the environment the tests run in, less every setting the service and the chain code read, so that nothing an operator
   * has set can change what a test sees (as the Document Pipeline's process tests do), and with the chain and the indexer off (offChain, last), so that no call
   * of the real chain can leave the machine, whatever the state directory holds.
   */
  const run = (env: NodeJS.ProcessEnv) => {
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    for (const name of [...SETTINGS, ...CHAIN_SETTINGS]) delete inherited[name];
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd, env: { ...inherited, ...env, ...offChain }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, exited, out: () => out, err: () => err };
  };

  test('exits 1 at start with the variable named, and listens on nothing, when a required setting is missing or the buyer key is in the wrong line', async () => {
    const dir = tempDir();
    const cases: Array<[NodeJS.ProcessEnv, RegExp]> = [
      [{ ...FULL_ENV, OPENROUTER_API_KEY: '' }, /^\[advocate\] cannot start: environment variable OPENROUTER_API_KEY is required/],
      [{ ...FULL_ENV, ADVOCATE_BUYER_PRIV_KEY_HEX: '' }, /^\[advocate\] cannot start: environment variable ADVOCATE_BUYER_PRIV_KEY_HEX is required/],
      [{ ...FULL_ENV, AGENT_DID: KEY }, /^\[advocate\] cannot start: environment variable AGENT_DID holds the buyer key/],
    ];
    const results = await Promise.all(cases.map(async ([env]) => { const p = run({ ...env, PORT: '0', HOST: '127.0.0.1', ADVOCATE_STATE_DIR: dir }); return { code: await p.exited, out: p.out(), err: p.err() }; }));
    cases.forEach(([, refusal], i) => {
      expect(results[i].code).toBe(1);
      expect(results[i].err).toMatch(refusal);
      expect(results[i].out).not.toContain('listening on');
      expect(shows(results[i].out + results[i].err, KEY)).toBe(false);
    });
  }, 60_000);

  test('started for real: it logs its line, answers /healthz and /agent.json, refuses a job without the token, and prints no secret', async () => {
    const dir = tempDir();
    const p = run({ ...FULL_ENV, PORT: '0', HOST: '127.0.0.1', OPENROUTER_MODEL: '', ADVOCATE_STATE_DIR: dir });
    try {
      const end = Date.now() + 30_000;
      while (!/listening on 127\.0\.0\.1:\d+/.test(p.out()) && Date.now() < end && p.child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 50));
      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(p.out())?.[1];
      expect(port, p.err()).toBeDefined();
      expect(p.out()).toContain(`[advocate] listening on 127.0.0.1:${port}; search Brave Search API; model deepseek/deepseek-v4-flash from the Vector marketplace, OpenRouter as the fallback; buyer address ${BUYER_ADDRESS}; state directory ${dir}`);
      const base = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${base}/healthz`)).json()).toStrictEqual({ ok: true });
      const manifest = await (await fetch(`${base}/agent.json`)).json();
      expect([manifest.status, manifest.keys.buyer_pkh]).toStrictEqual([{ chip: 'deployed', since: '2026-10-20' }, BUYER.pkh]);
      expect((await fetch(`${base}/`, { method: 'POST', body: wire(GOLDEN_REQUEST) })).status).toBe(401);
      for (const secret of [TEST_AUTH, TEST_BRAVE_KEY, TEST_OPENROUTER_KEY, KEY]) expect(shows(p.out() + p.err(), secret)).toBe(false);
      expect(TEST_CONTACT).toBe('ops@example.test');
    } finally {
      p.child.kill();
      await p.exited;
    }
  }, 60_000);

  test('started for real with an escrow in its state directory: its janitor asks the chain of the environment, where nothing answers, keeps the escrow, and leaves the file as it was', async () => {
    const dir = tempDir();
    const file = `${JSON.stringify([{ escrow_ref: escrowNo(9), deliver_by: 1, posted_at: 0, kind: 'llm' }], null, 2)}\n`;
    writeFileSync(join(dir, 'stranded.json'), file, 'utf8');
    const p = run({ ...FULL_ENV, PORT: '0', HOST: '127.0.0.1', ADVOCATE_STATE_DIR: dir });
    const kept = `[advocate] janitor: kept ${escrowNo(9)}: its state could not be read (`;
    try {
      const end = Date.now() + 30_000;
      while (!p.out().includes(kept) && Date.now() < end && p.child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(p.out(), p.err()).toContain(kept);
      expect(readFileSync(join(dir, 'stranded.json'), 'utf8')).toBe(file);
      for (const secret of [TEST_AUTH, TEST_BRAVE_KEY, TEST_OPENROUTER_KEY, KEY]) expect(shows(p.out() + p.err(), secret)).toBe(false);
    } finally {
      p.child.kill();
      await p.exited;
    }
  }, 60_000);

  // A signal reaches a handler only on POSIX (on Windows kill() ends the process at once, whatever the signal), so CI on Linux runs this and Windows skips it.
  test.skipIf(process.platform === 'win32')('SIGTERM stops it the way a restart should: the line of the stop, and exit 0', async () => {
    const p = run({ ...FULL_ENV, PORT: '0', HOST: '127.0.0.1', OPENROUTER_MODEL: '', ADVOCATE_STATE_DIR: tempDir() });
    try {
      const end = Date.now() + 30_000;
      while (!/listening on 127\.0\.0\.1:\d+/.test(p.out()) && Date.now() < end && p.child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(p.out(), p.err()).toMatch(/listening on 127\.0\.0\.1:\d+/);
      p.child.kill('SIGTERM');
      expect(await p.exited).toBe(0);
      expect(p.out()).toContain('[advocate] SIGTERM: stopping; no new job, and up to 300 s for the one that is running');
    } finally {
      p.child.kill();
      await p.exited;
    }
  }, 60_000);
});
