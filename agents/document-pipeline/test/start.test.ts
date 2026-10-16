// agents/document-pipeline/test/start.test.ts
// How the service starts. loadConfig reads the environment (four settings are required, the rest have defaults), derives the buyer key hash and the
// mainnet enterprise address from the key and refuses a PIPELINE_BUYER_PKH or PIPELINE_BUYER_ADDRESS that is not the key's (ruling R44), so that the buyer
// key hash the manifest publishes is the key that signs. startService puts the real parts together (the chain from the key, the stranded store in the state
// directory, the janitor on it, the server) and is run here with the parts a test can replace. The last tests run src/index.ts as a process: the exit at
// start with the variable named, and one start against a node that is not there.
import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeChain, rawHexToBech32 } from '@vsa/buyer-core';
import { StrandedStore } from '../src/janitor.ts';
import { popplerRenderer } from '../src/render.ts';
import { manifestFromEnv } from '../src/server.ts';
import { CHAIN_SETTINGS, OTHER_SETTINGS, PRICE_CEILING_DEFAULT_LOVELACE, SHUTDOWN_WAIT_MS, WRITE_PROBE, assertNoKeyIn, assertNoTokenIn, loadConfig, startService, stopOnSignals } from '../src/start.ts';
import type { RunningService, StartOptions } from '../src/start.ts';
import { fakeRenderer } from './fake-renderer.ts';
import { AUTH, BUYER, BUYER_ADDRESS, FULL_ENV, SUPPLIER, TEST_AUTH, TEST_CONTACT, cleanDirs, fakePopplerDir, inFront, keyOf, noFetch, pathOf, rawClient, tempDir, until, wire, withPath } from './server-support.ts';
import { ALLOWLIST, INDEXER, OCR_ADVERT_REF, SUMMARY, T0, escrowNo, marketplace } from './stub-suppliers.ts';
import { TWO_PAGES_PDF, toBase64 } from './support.ts';

afterEach(() => { cleanDirs(); });

const OCR_DEFAULT = '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9';
const MODELS_DEFAULT = ['deepseek/deepseek-v4-flash', 'deepseek-v4-pro', 'moonshotai/kimi-k2.6', 'Qwen/Qwen3.6-35B-A3B-FP8'];
const thrown = (fn: () => unknown): Error => {
  try { fn(); } catch (e) { return e as Error; }
  throw new Error('it did not throw');
};
/** A port nothing listens on: one that was just given back. */
const closedPort = () => new Promise<number>((resolve, reject) => {
  const probe = netServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});

describe('loadConfig', () => {
  test('a full environment gives the defaults for everything the operator leaves out', () => {
    const config = loadConfig(FULL_ENV);
    expect(config).toMatchObject({ host: '0.0.0.0', port: 9092, stateDir: '/data', ocrAllowlistPkh: OCR_DEFAULT, llmAllowlist: MODELS_DEFAULT, privateKeyHex: BUYER.privateKeyHex });
    expect(config.indexerUrl).toBeUndefined();
    expect(config.manifest.status).toStrictEqual({ chip: 'deployed', since: '2026-10-16' });
  });

  test('every setting is read: the OCR supplier key hash, the chat models in order, the state directory, the indexer, the port and the host', () => {
    const config = loadConfig({
      ...FULL_ENV, OCR_ALLOWLIST_SUPPLIER_PKH: 'AB'.repeat(28), LLM_MODEL_ALLOWLIST: ' model-a, model-b ,, model-c ', PIPELINE_STATE_DIR: '/var/pipeline', VECTOR_MARKETPLACE_INDEXER_URL: ' https://indexer.example.test/ ',
      PORT: '9100', HOST: '127.0.0.1',
    });
    expect(config).toMatchObject({ ocrAllowlistPkh: 'ab'.repeat(28), llmAllowlist: ['model-a', 'model-b', 'model-c'], stateDir: '/var/pipeline', indexerUrl: 'https://indexer.example.test/', port: 9100, host: '127.0.0.1' });
  });

  // Ruling R56: a ceiling on the price of each hop, so that an advert priced at run time cannot cost more than the operator allows.
  test('the price ceilings OCR_MAX_PRICE_LOVELACE and LLM_MAX_PRICE_LOVELACE: 1000000 lovelace each unless set, a whole number of at least 0 when set, and anything else stops the start, naming the setting and never showing the value', () => {
    expect(PRICE_CEILING_DEFAULT_LOVELACE).toBe(1_000_000n);
    expect(loadConfig(FULL_ENV)).toMatchObject({ ocrMaxPriceLovelace: 1_000_000n, llmMaxPriceLovelace: 1_000_000n });
    expect(loadConfig({ ...FULL_ENV, OCR_MAX_PRICE_LOVELACE: '', LLM_MAX_PRICE_LOVELACE: ' ' })).toMatchObject({ ocrMaxPriceLovelace: 1_000_000n, llmMaxPriceLovelace: 1_000_000n });
    expect(loadConfig({ ...FULL_ENV, OCR_MAX_PRICE_LOVELACE: '250000', LLM_MAX_PRICE_LOVELACE: '0' })).toMatchObject({ ocrMaxPriceLovelace: 250_000n, llmMaxPriceLovelace: 0n });
    expect(loadConfig({ ...FULL_ENV, LLM_MAX_PRICE_LOVELACE: ' 5000000\n' }).llmMaxPriceLovelace).toBe(5_000_000n);
    for (const name of ['OCR_MAX_PRICE_LOVELACE', 'LLM_MAX_PRICE_LOVELACE']) {
      for (const bad of ['one', '-1', '1.5', '1e6', '0x10', '99999999999999999999', 'secret-value']) {
        const error = thrown(() => loadConfig({ ...FULL_ENV, [name]: bad }));
        expect(error.message, `${name} = ${bad}`).toBe(`environment variable ${name} must be a whole number of lovelace of at least 0, and it has ${bad.length} characters`);
      }
    }
  });

  test('a setting that is set and empty means its default', () => {
    const config = loadConfig({ ...FULL_ENV, OCR_ALLOWLIST_SUPPLIER_PKH: '', LLM_MODEL_ALLOWLIST: '', PIPELINE_STATE_DIR: '', VECTOR_MARKETPLACE_INDEXER_URL: '', PORT: '', HOST: '' });
    expect(config).toMatchObject({ ocrAllowlistPkh: OCR_DEFAULT, llmAllowlist: MODELS_DEFAULT, stateDir: '/data', port: 9092, host: '0.0.0.0' });
    expect(config.indexerUrl).toBeUndefined();
  });

  test('four settings are required, checked in this order, and the error names the variable', () => {
    expect(thrown(() => loadConfig({})).message).toMatch(/environment variable OPERATOR_CONTACT is required/);
    expect(thrown(() => loadConfig({ OPERATOR_CONTACT: TEST_CONTACT })).message).toMatch(/environment variable PIPELINE_BUYER_PRIV_KEY_HEX is required/);
    expect(thrown(() => loadConfig({ OPERATOR_CONTACT: TEST_CONTACT, PIPELINE_BUYER_PRIV_KEY_HEX: BUYER.privateKeyHex })).message).toMatch(/environment variable SUPPLIER_PKH is required/);
    expect(thrown(() => loadConfig({ OPERATOR_CONTACT: TEST_CONTACT, PIPELINE_BUYER_PRIV_KEY_HEX: BUYER.privateKeyHex, SUPPLIER_PKH: SUPPLIER.pkh })).message).toMatch(/environment variable SERVICE_AUTH_HEADER is required/);
    for (const blank of ['', ' ', '\t\n']) {
      expect(thrown(() => loadConfig({ ...FULL_ENV, OPERATOR_CONTACT: blank })).message, JSON.stringify(blank)).toMatch(/OPERATOR_CONTACT/);
      expect(thrown(() => loadConfig({ ...FULL_ENV, PIPELINE_BUYER_PRIV_KEY_HEX: blank })).message, JSON.stringify(blank)).toMatch(/PIPELINE_BUYER_PRIV_KEY_HEX/);
      expect(thrown(() => loadConfig({ ...FULL_ENV, SUPPLIER_PKH: blank })).message, JSON.stringify(blank)).toMatch(/SUPPLIER_PKH/);
      expect(thrown(() => loadConfig({ ...FULL_ENV, SERVICE_AUTH_HEADER: blank })).message, JSON.stringify(blank)).toMatch(/^environment variable SERVICE_AUTH_HEADER is required/);
    }
    // A line break at the end of a value from a file is not part of it.
    expect(loadConfig({ ...FULL_ENV, PIPELINE_BUYER_PRIV_KEY_HEX: `${BUYER.privateKeyHex}\r\n`, SUPPLIER_PKH: ` ${SUPPLIER.pkh}\n` }).privateKeyHex).toBe(BUYER.privateKeyHex);
  });

  // R50: the value the runtime sends as the authorization header of every call is the token the service requires on POST /. Without it the service would
  // answer anyone who can reach its port, so an empty one stops the start; and it is a secret, so no message of the start shows it.
  describe('the service token (SERVICE_AUTH_HEADER, ruling R50)', () => {
    const TOKEN = TEST_AUTH;
    const CREDENTIAL = TOKEN.slice('Bearer '.length);

    test('is read as given, without the space or line break a file leaves around it, and is what the server will require', () => {
      expect(loadConfig(FULL_ENV).authHeader).toBe(TOKEN);
      expect(loadConfig({ ...FULL_ENV, SERVICE_AUTH_HEADER: `  ${TOKEN}\r\n` }).authHeader).toBe(TOKEN);
      expect(loadConfig({ ...FULL_ENV, SERVICE_AUTH_HEADER: 'x' }).authHeader).toBe('x'); // the service does not judge the strength of the operator's choice
    });

    test('an unset, empty or blank token stops the start with the variable named: a service made without one would answer anyone', () => {
      for (const blank of [undefined, '', ' ', '\t\n', '\r\n']) {
        const env: Record<string, string | undefined> = { ...FULL_ENV, SERVICE_AUTH_HEADER: blank };
        const error = thrown(() => loadConfig(env));
        expect(error.message, JSON.stringify(blank)).toMatch(/^environment variable SERVICE_AUTH_HEADER is required \(.+\) and is not set$/);
      }
    });

    test('a token that cannot travel as a header value is refused with the variable named and the number of characters: it is compared with the header the runtime sends, byte for byte', () => {
      const bad = [`Bearer ${String.fromCodePoint(0xe9)}`, `Bearer a${String.fromCodePoint(0x2713)}b`, 'Bearer a\tb', 'Bearer a\nb', `Bearer a${String.fromCodePoint(0)}b`];
      for (const value of bad) {
        const error = thrown(() => loadConfig({ ...FULL_ENV, SERVICE_AUTH_HEADER: value }));
        expect(error.message, JSON.stringify(value)).toMatch(new RegExp(`^environment variable SERVICE_AUTH_HEADER must be printable ASCII \\(it is sent as an HTTP header\\), and it has ${value.length} characters`));
        expect(error.message).not.toContain(value);
      }
      expect(loadConfig({ ...FULL_ENV, SERVICE_AUTH_HEADER: 'Bearer a b ~!"#$%&' }).authHeader).toBe('Bearer a b ~!"#$%&');
    });

    test('no message of the start shows it, whatever else is wrong: not whole, not its credential', () => {
      const wrong: Array<Record<string, string>> = [
        { OPERATOR_CONTACT: '' }, { PIPELINE_BUYER_PRIV_KEY_HEX: 'abc' }, { SUPPLIER_PKH: 'abc' }, { SUPPLIER_PUB_KEY_HEX: 'abc' }, { PIPELINE_BUYER_PKH: 'cd'.repeat(28) }, { PIPELINE_BUYER_ADDRESS: 'addr1x' },
        { OCR_ALLOWLIST_SUPPLIER_PKH: 'abc' }, { LLM_MODEL_ALLOWLIST: ' , ' }, { PORT: 'ninety' }, { ADVERT_PRICE_LOVELACE: 'x' }, { ADVERT_MAX_PROCESSING_MS: '1' }, { AGENT_STATUS_CHIP: 'launched' }, { AGENT_STATUS_SINCE: 'soon' },
        { AGENT_DID: BUYER.privateKeyHex }, { SERVICE_AUTH_HEADER: `${TOKEN}${String.fromCodePoint(0)}` },
      ];
      for (const change of wrong) {
        const error = thrown(() => loadConfig({ ...FULL_ENV, ...change }));
        expect(error.message, JSON.stringify(Object.keys(change))).not.toContain(CREDENTIAL);
        expect(error.message).not.toContain(TOKEN);
      }
      // The token put in the line of another setting is not echoed by the message about that setting either.
      for (const name of ['SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'PIPELINE_BUYER_PKH', 'PIPELINE_BUYER_ADDRESS', 'OCR_ALLOWLIST_SUPPLIER_PKH', 'PORT', 'ADVERT_PRICE_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE']) {
        const error = thrown(() => loadConfig({ ...FULL_ENV, [name]: TOKEN }));
        expect(error.message, name).not.toContain(CREDENTIAL);
        expect(error.message, name).not.toContain(TOKEN);
      }
    });

    test('the manifest is looked at for it too: a token in a value that is published stops the start, unprinted, whole or by its credential', () => {
      const manifest = loadConfig(FULL_ENV).manifest;
      expect(() => assertNoTokenIn(JSON.stringify(manifest), TOKEN)).not.toThrow();
      for (const leaked of [TOKEN, CREDENTIAL, `see ${TOKEN} please`]) {
        const error = thrown(() => assertNoTokenIn(JSON.stringify({ ...manifest, description: leaked }), TOKEN));
        expect(error.message, leaked).toMatch(/^the manifest would publish the service token/);
        expect(error.message).not.toContain(CREDENTIAL);
      }
      // A short credential is no secret worth a search: it would be in any text by chance.
      expect(() => assertNoTokenIn(JSON.stringify(manifest), 'Bearer ab')).not.toThrow();
      // And loadConfig makes that last look at the manifest it builds: a manifest field that came from somewhere else is caught, whole or by its credential.
      for (const leaked of [TOKEN, CREDENTIAL.toUpperCase()]) {
        const error = thrown(() => loadConfig(FULL_ENV, (e) => ({ ...manifestFromEnv(e), description: `from somewhere else: ${leaked}` })));
        expect(error.message).toMatch(/^the manifest would publish the service token/);
        expect(error.message).not.toContain(CREDENTIAL);
      }
    });

    // C4: the token is looked for in every other line as soon as it is known, as the buyer key is, so that no check of another setting and no log line can
    // print it: the contact line is published, the host and the state directory are logged, the model list goes into an answer of the service.
    test.each([...OTHER_SETTINGS.filter((name) => name !== 'SERVICE_AUTH_HEADER'), ...CHAIN_SETTINGS].map((name) => [name]))('the token in %s: refused at start, the variable named, the token not in the message', (name) => {
      for (const value of [TOKEN, TOKEN.toLowerCase(), CREDENTIAL, CREDENTIAL.toUpperCase(), `prefix-${CREDENTIAL}-suffix`, `https://${CREDENTIAL}.example`]) {
        const error = thrown(() => loadConfig({ ...FULL_ENV, [name]: value }));
        expect(error.message, `${name} = ${value.slice(0, 12)}`).toMatch(new RegExp(`^environment variable ${name} holds the service token, which belongs in SERVICE_AUTH_HEADER alone: it would be printed or published\. Take it out of ${name}$`));
        for (let at = 0; at + 16 <= CREDENTIAL.length; at += 4) expect(error.message, name).not.toContain(CREDENTIAL.slice(at, at + 16));
      }
    });

    test('the token is looked for before the checks that could print a line, and not when it is too short to be found by anything but chance', () => {
      // SUPPLIER_PKH is checked before the token is required, and its message gives a length; the search comes first all the same.
      expect(thrown(() => loadConfig({ ...FULL_ENV, SUPPLIER_PKH: CREDENTIAL })).message).toMatch(/^environment variable SUPPLIER_PKH holds the service token/);
      // A token whose whole and whose credential are under 16 characters is not looked for: the operator's choice stands, and the line is read as it is.
      expect(loadConfig({ ...FULL_ENV, SERVICE_AUTH_HEADER: 'Bearer abc', AGENT_DID: 'did:vector:agent:abc' }).authHeader).toBe('Bearer abc');
      // The buyer key is still looked for first.
      expect(thrown(() => loadConfig({ ...FULL_ENV, AGENT_DID: `${BUYER.privateKeyHex} ${CREDENTIAL}` })).message).toMatch(/^environment variable AGENT_DID holds the buyer key/);
    });
  });

  test('a key that is not 64 lowercase hex characters is refused with the variable named, and what it was given is never echoed', () => {
    for (const bad of [BUYER.privateKeyHex.toUpperCase(), BUYER.privateKeyHex.slice(2), `${BUYER.privateKeyHex}00`, `0x${BUYER.privateKeyHex}`, 'g'.repeat(64), '<the buyer key>']) {
      const error = thrown(() => loadConfig({ ...FULL_ENV, PIPELINE_BUYER_PRIV_KEY_HEX: bad }));
      expect(error.message, bad).toMatch(/environment variable PIPELINE_BUYER_PRIV_KEY_HEX must be 64 lowercase hex characters/);
      expect(error.message).not.toContain(bad);
      expect(error.message).not.toContain(BUYER.privateKeyHex);
    }
  });

  test('the supplier key hash is 56 hex characters and is published in lower case; the public key, when given, is 64', () => {
    expect(loadConfig({ ...FULL_ENV, SUPPLIER_PKH: SUPPLIER.pkh.toUpperCase() }).manifest.keys.supplier_pkh).toBe(SUPPLIER.pkh);
    expect(loadConfig({ ...FULL_ENV, SUPPLIER_PKH: SUPPLIER.pkh.toUpperCase() }).manifest.identity.controller_pkh).toBe(SUPPLIER.pkh);
    for (const bad of ['<SUPPLIER_PKH>', SUPPLIER.pkh.slice(1), `${SUPPLIER.pkh}00`, 'zz'.repeat(28)]) {
      expect(thrown(() => loadConfig({ ...FULL_ENV, SUPPLIER_PKH: bad })).message, bad).toMatch(/environment variable SUPPLIER_PKH must be 56 hex characters/);
    }
    expect(loadConfig({ ...FULL_ENV, SUPPLIER_PUB_KEY_HEX: '' }).manifest.keys.pub_key_hex).toBe('');
    for (const bad of ['<SUPPLIER_PUB_KEY_HEX>', SUPPLIER.pubKeyHex.slice(1), `${SUPPLIER.pubKeyHex}00`]) {
      expect(thrown(() => loadConfig({ ...FULL_ENV, SUPPLIER_PUB_KEY_HEX: bad })).message, bad).toMatch(/environment variable SUPPLIER_PUB_KEY_HEX must be 64 hex characters/);
    }
  });

  test('the other settings that are given must be well formed, and the error names the variable', () => {
    expect(thrown(() => loadConfig({ ...FULL_ENV, OCR_ALLOWLIST_SUPPLIER_PKH: 'abc' })).message).toMatch(/environment variable OCR_ALLOWLIST_SUPPLIER_PKH must be 56 hex characters/);
    expect(thrown(() => loadConfig({ ...FULL_ENV, LLM_MODEL_ALLOWLIST: ' , ,' })).message).toMatch(/environment variable LLM_MODEL_ALLOWLIST must name at least one model/);
    expect(thrown(() => loadConfig({ ...FULL_ENV, PORT: 'ninety' })).message).toMatch(/PORT/);
    expect(thrown(() => loadConfig({ ...FULL_ENV, ADVERT_PRICE_LOVELACE: 'x' })).message).toMatch(/ADVERT_PRICE_LOVELACE/);
    expect(thrown(() => loadConfig({ ...FULL_ENV, AGENT_STATUS_CHIP: 'launched' })).message).toMatch(/AGENT_STATUS_CHIP/);
  });

  describe('the buyer identity (ruling R44)', () => {
    test('is derived from the key, as the key hash and the mainnet enterprise address, and the manifest publishes the hash whether or not the operator wrote it down', () => {
      const config = loadConfig(FULL_ENV);
      expect(config.buyer).toStrictEqual({ buyerPkh: BUYER.pkh, address: BUYER_ADDRESS });
      expect(config.buyer.address.startsWith('addr1v')).toBe(true);
      expect(config.manifest.keys.buyer_pkh).toBe(BUYER.pkh);
      const written = loadConfig({ ...FULL_ENV, PIPELINE_BUYER_PKH: BUYER.pkh, PIPELINE_BUYER_ADDRESS: BUYER_ADDRESS });
      expect(written.manifest).toStrictEqual(config.manifest);
    });

    test('a hash or an address written down that is the key\'s is accepted, in any case; blank means not written', () => {
      expect(loadConfig({ ...FULL_ENV, PIPELINE_BUYER_PKH: BUYER.pkh.toUpperCase() }).manifest.keys.buyer_pkh).toBe(BUYER.pkh);
      expect(loadConfig({ ...FULL_ENV, PIPELINE_BUYER_PKH: '', PIPELINE_BUYER_ADDRESS: '  ' }).buyer.buyerPkh).toBe(BUYER.pkh);
      expect(loadConfig({ ...FULL_ENV, PIPELINE_BUYER_ADDRESS: ` ${BUYER_ADDRESS}\n` }).buyer.address).toBe(BUYER_ADDRESS);
      expect(loadConfig({ ...FULL_ENV, PIPELINE_BUYER_ADDRESS: BUYER_ADDRESS.toUpperCase() }).buyer.address).toBe(BUYER_ADDRESS);
    });

    test('a hash that is not the key\'s is refused at start, naming the variable, the length of what was written and the key hash it was checked against; never the value, never the key', () => {
      for (const wrong of ['cd'.repeat(28), SUPPLIER.pkh, '<PIPELINE_BUYER_PKH>', 'abc']) {
        const error = thrown(() => loadConfig({ ...FULL_ENV, PIPELINE_BUYER_PKH: wrong }));
        expect(error.message, wrong).toMatch(new RegExp(`^environment variable PIPELINE_BUYER_PKH \\(${wrong.length} characters\\) is not the key hash`));
        expect(error.message).toContain(BUYER.pkh);
        expect(error.message).toMatch(/PIPELINE_BUYER_PRIV_KEY_HEX/);
        expect(error.message).not.toContain(BUYER.privateKeyHex);
        if (wrong.length > 20) expect(error.message, 'the value written is not shown').not.toContain(wrong);
      }
    });

    test('an address that is not the key\'s is refused the same way', () => {
      const other = new FakeChain({ buyerPkh: SUPPLIER.pkh }).address;
      for (const wrong of [other, 'addr1not-an-address', `${BUYER_ADDRESS}0`]) {
        const error = thrown(() => loadConfig({ ...FULL_ENV, PIPELINE_BUYER_ADDRESS: wrong }));
        expect(error.message, wrong).toMatch(new RegExp(`^environment variable PIPELINE_BUYER_ADDRESS \\(${wrong.length} characters\\) is not the address`));
        expect(error.message).toContain(BUYER_ADDRESS);
        expect(error.message).not.toContain(BUYER.privateKeyHex);
        expect(error.message, 'the value written is not shown').not.toContain(wrong);
      }
    });
  });

  test('a processing window below 30 min stops the start with ADVERT_MAX_PROCESSING_MS named: the deadline of a job assumes it', () => {
    expect(thrown(() => loadConfig({ ...FULL_ENV, ADVERT_MAX_PROCESSING_MS: '1799999' })).message).toMatch(/^environment variable ADVERT_MAX_PROCESSING_MS must be at least 1800000/);
    expect(thrown(() => loadConfig({ ...FULL_ENV, ADVERT_MAX_PROCESSING_MS: '300000' })).message).toMatch(/ADVERT_MAX_PROCESSING_MS/);
    expect(loadConfig({ ...FULL_ENV, ADVERT_MAX_PROCESSING_MS: '1800000' }).manifest.terms.max_processing_ms).toBe(1_800_000);
    expect(loadConfig({ ...FULL_ENV, ADVERT_MAX_PROCESSING_MS: '' }).manifest.terms.max_processing_ms).toBe(1_800_000);
  });

  // A secret in the wrong line of an env file is a common mistake and a costly one: the shape checks print what they were given, and a value that is
  // published goes out in /agent.json, which the advert hashes and anyone can read. So the key is looked for in every line the service reads, before any
  // other check can print it, and the hex settings give a length, not a value.
  describe('a secret in the wrong line is never printed and never published', () => {
    const KEY = BUYER.privateKeyHex;
    // 64 hex characters, as a private key is, but not the buyer key.
    const OTHER_SECRET = keyOf('document-pipeline service test: a secret that is not the buyer key').privateKeyHex;
    /** Is a stretch of 16 characters of `secret` in `text`? */
    const holds = (text: string, secret: string): boolean => {
      for (let at = 0; at + 16 <= secret.length; at += 4) if (text.includes(secret.slice(at, at + 16))) return true;
      return false;
    };

    test.each([...OTHER_SETTINGS, ...CHAIN_SETTINGS].map((name) => [name]))('the buyer key in %s: refused at start, the variable named, the key not in the message', (name) => {
      const forms = [KEY, KEY.toUpperCase(), `prefix-${KEY}-suffix`, rawHexToBech32(KEY), `did:vector:agent:${KEY}`];
      for (const value of forms) {
        const error = thrown(() => loadConfig({ ...FULL_ENV, [name]: value }));
        expect(error.message, `${name} = ${value.slice(0, 12)}`).toMatch(new RegExp(`^environment variable ${name} holds the buyer key`));
        expect(holds(error.message, KEY), name).toBe(false);
        expect(error.message, name).not.toContain(rawHexToBech32(KEY).slice(0, 24));
      }
    });

    test('the settings it looks in are every one the service reads but the key itself, and the ones the chain code reads and prints', () => {
      expect([...CHAIN_SETTINGS]).toStrictEqual(['VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL']);
      expect(OTHER_SETTINGS).toContain('OPERATOR_CONTACT');
      expect(OTHER_SETTINGS).toContain('AGENT_DID');
      expect(OTHER_SETTINGS).toContain('SUPPLIER_PUB_KEY_HEX');
      expect(OTHER_SETTINGS).toContain('SERVICE_AUTH_HEADER'); // the buyer key must not be handed to the runtime in the line of the token
      expect(OTHER_SETTINGS).not.toContain('PIPELINE_BUYER_PRIV_KEY_HEX');
      expect(new Set(OTHER_SETTINGS).size).toBe(OTHER_SETTINGS.length);
    });

    test('any other secret put in the line of a hex setting is not printed either: the message gives a length, never the value', () => {
      const cases: Array<[string, Record<string, string>, RegExp]> = [
        ['SUPPLIER_PKH', { SUPPLIER_PKH: OTHER_SECRET }, /^environment variable SUPPLIER_PKH must be 56 hex characters, and it has 64 characters/],
        ['OCR_ALLOWLIST_SUPPLIER_PKH', { OCR_ALLOWLIST_SUPPLIER_PKH: OTHER_SECRET }, /^environment variable OCR_ALLOWLIST_SUPPLIER_PKH must be 56 hex characters, and it has 64 characters/],
        ['SUPPLIER_PUB_KEY_HEX', { SUPPLIER_PUB_KEY_HEX: `${OTHER_SECRET}00` }, /^environment variable SUPPLIER_PUB_KEY_HEX must be 64 hex characters, and it has 66 characters/],
        ['PIPELINE_BUYER_PKH', { PIPELINE_BUYER_PKH: OTHER_SECRET }, /^environment variable PIPELINE_BUYER_PKH \(64 characters\) is not the key hash/],
        ['PIPELINE_BUYER_ADDRESS', { PIPELINE_BUYER_ADDRESS: OTHER_SECRET }, /^environment variable PIPELINE_BUYER_ADDRESS \(64 characters\) is not the address/],
      ];
      for (const [name, set, message] of cases) {
        const error = thrown(() => loadConfig({ ...FULL_ENV, ...set }));
        expect(error.message, name).toMatch(message);
        expect(holds(error.message, OTHER_SECRET), name).toBe(false);
      }
      const notHex = thrown(() => loadConfig({ ...FULL_ENV, SUPPLIER_PKH: `<${OTHER_SECRET.slice(0, 54)}>` }));
      expect(notHex.message).toMatch(/must be 56 hex characters, and some of its 56 characters are not hex/);
      expect(holds(notHex.message, OTHER_SECRET)).toBe(false);
    });

    test('SUPPLIER_PUB_KEY_HEX must be the public key of SUPPLIER_PKH: a private key put there by mistake, or the key of another pair, stops the start unprinted', () => {
      expect(loadConfig(FULL_ENV).manifest.keys).toMatchObject({ supplier_pkh: SUPPLIER.pkh, pub_key_hex: SUPPLIER.pubKeyHex }); // the pair of FULL_ENV agrees
      expect(loadConfig({ ...FULL_ENV, SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex.toUpperCase() }).manifest.keys.pub_key_hex).toBe(SUPPLIER.pubKeyHex);
      expect(loadConfig({ ...FULL_ENV, SUPPLIER_PUB_KEY_HEX: '' }).manifest.keys.pub_key_hex).toBe(''); // not given: nothing to compare
      for (const [what, wrong] of [['the supplier private key', SUPPLIER.privateKeyHex], ['the public key of another pair', BUYER.pubKeyHex], ['an unrelated secret', OTHER_SECRET]] as const) {
        const error = thrown(() => loadConfig({ ...FULL_ENV, SUPPLIER_PUB_KEY_HEX: wrong }));
        expect(error.message, what).toMatch(/^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/);
        expect(holds(error.message, wrong), what).toBe(false);
      }
      expect(thrown(() => loadConfig({ ...FULL_ENV, SUPPLIER_PKH: BUYER.pkh })).message).toMatch(/SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/);
    });

    test('the manifest is checked last, for the key in both its forms and in any case: whatever put it in a value that is published, the start stops, unprinted', () => {
      const manifest = loadConfig(FULL_ENV).manifest;
      expect(() => assertNoKeyIn(JSON.stringify(manifest), KEY)).not.toThrow();
      for (const leaked of [KEY, KEY.toUpperCase(), rawHexToBech32(KEY)]) {
        const error = thrown(() => assertNoKeyIn(JSON.stringify({ ...manifest, description: `leaked ${leaked}` }), KEY));
        expect(error.message).toMatch(/would publish the buyer key/);
        expect(holds(error.message, KEY)).toBe(false);
        expect(error.message).not.toContain(rawHexToBech32(KEY).slice(0, 24));
      }
    });

    test('and loadConfig makes that last look at the manifest it builds, whatever the settings say: a manifest field that came from somewhere else is caught', () => {
      // The settings are clean, so the look at every line finds nothing; the manifest function is the one that leaks.
      const leaking = (leaked: string) => (e: NodeJS.ProcessEnv) => ({ ...manifestFromEnv(e), description: `from somewhere else: ${leaked}` });
      for (const leaked of [KEY, KEY.toUpperCase(), rawHexToBech32(KEY)]) {
        const error = thrown(() => loadConfig(FULL_ENV, leaking(leaked)));
        expect(error.message).toMatch(/^the manifest would publish the buyer key/);
        expect(holds(error.message, KEY)).toBe(false);
      }
      expect(loadConfig(FULL_ENV, manifestFromEnv).manifest).toStrictEqual(loadConfig(FULL_ENV).manifest);
    });
  });
});

describe('startService', () => {
  const running: Array<{ stop: () => Promise<void> }> = [];
  afterEach(async () => { await Promise.all(running.splice(0).map((s) => s.stop())); cleanDirs(); });
  const logs: string[] = [];
  afterEach(() => { logs.length = 0; });
  const envIn = (dir: string, over: Record<string, string> = {}) => ({ ...FULL_ENV, PORT: '0', HOST: '127.0.0.1', PIPELINE_STATE_DIR: dir, ...over });
  const optionsWith = (over: StartOptions = {}): StartOptions => ({
    createChain: async () => new FakeChain({ buyerPkh: BUYER.pkh }), fetchImpl: noFetch, renderer: fakeRenderer(), log: (line) => { logs.push(line); }, janitorIntervalMs: 3_600_000, ...over,
  });
  async function start(env: Record<string, string>, over: StartOptions = {}) {
    const service = await startService(env, optionsWith(over));
    running.push(service);
    return service;
  }

  test('listens, serves the manifest with the buyer hash derived from the key, and is healthy', async () => {
    const service = await start(envIn(tempDir()));
    const base = `http://127.0.0.1:${service.port}`;
    const manifest = await (await fetch(`${base}/agent.json`)).json();
    expect(manifest.keys).toStrictEqual({ supplier_pkh: SUPPLIER.pkh, pub_key_hex: SUPPLIER.pubKeyHex, buyer_pkh: BUYER.pkh });
    expect(manifest.operator.contact).toBe(TEST_CONTACT);
    expect(await (await fetch(`${base}/healthz`)).json()).toStrictEqual({ ok: true });
    expect(logs.join('\n')).toContain(`listening on 127.0.0.1:${service.port}`);
  });

  test('answers a call without the token of the runtime with 401 and reads one with it; the open routes stay open; the token is not in the log (R50)', async () => {
    const service = await start(envIn(tempDir()));
    const base = `http://127.0.0.1:${service.port}`;
    const job = wire({ source: { url: 'https://example.org/a.pdf' }, task: 'summary' });
    for (const headers of [{}, { authorization: 'Bearer wrong' }] as Array<Record<string, string>>) {
      const denied = await fetch(`${base}/`, { method: 'POST', headers, body: job });
      expect(denied.status).toBe(401);
      expect(await denied.json()).toStrictEqual({ error: 'unauthorized' });
    }
    // With the token the call is read: a body that is not the wire message is a 400, which spends nothing and is not a 401.
    const read = await fetch(`${base}/`, { method: 'POST', headers: AUTH, body: 'not the wire message' });
    expect(read.status).toBe(400);
    expect((await read.json()).error).toBe('bad_wire');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/agent.json`)).status).toBe(200);
    expect(logs.join('\n')).not.toContain(TEST_AUTH.slice('Bearer '.length));
  });

  test('the token the server requires is the one of the environment: with another token in it, that one works and the usual one does not', async () => {
    const service = await start(envIn(tempDir(), { SERVICE_AUTH_HEADER: 'Bearer the-token-of-this-environment' }));
    const url = `http://127.0.0.1:${service.port}/`;
    expect((await fetch(url, { method: 'POST', headers: AUTH, body: 'x' })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer the-token-of-this-environment' }, body: 'x' })).status).toBe(400);
  });

  test('a start without the token is refused before anything is made: no chain, no state directory, no listener (R50)', async () => {
    const dir = join(tempDir(), 'state');
    let made = 0;
    for (const SERVICE_AUTH_HEADER of ['', '   ']) {
      await expect(startService(envIn(dir, { SERVICE_AUTH_HEADER }), optionsWith({ createChain: async () => { made += 1; return new FakeChain(); } }))).rejects.toThrow(/^environment variable SERVICE_AUTH_HEADER is required/);
    }
    expect(made).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  test('makes the chain from the key of the environment, and logs the address to fund but never a key', async () => {
    const keys: string[] = [];
    await start(envIn(tempDir()), { createChain: async ({ privateKeyHex }) => { keys.push(privateKeyHex); return new FakeChain({ buyerPkh: BUYER.pkh }); } });
    expect(keys).toStrictEqual([BUYER.privateKeyHex]);
    expect(logs.join('\n')).toContain(BUYER_ADDRESS);
    expect(logs.join('\n')).not.toContain(BUYER.privateKeyHex);
  });

  test('starts the janitor on the stranded store in the state directory: it looks at an escrow left there by an earlier run', async () => {
    const dir = tempDir();
    const ref = `${'ab'.repeat(32)}#0`;
    new StrandedStore(dir).add({ escrow_ref: ref, deliver_by: 1_000, posted_at: 0, kind: 'ocr' }); // long past its deliver_by; no chain knows it, so it reads unknown
    await start(envIn(dir));
    await until(() => logs.some((line) => line.includes(`janitor: kept ${ref}`)), 'the janitor has made its first pass');
    expect(logs.find((line) => line.includes(`janitor: kept ${ref}`))).toMatch(/unknown/);
  });

  // Ruling R55: a transaction of the janitor would hold the chain's queue in front of a job's Post or Accept, so the janitor is given the job slot.
  test('the janitor is given the job slot: a pass while a job runs defers the Reclaim of a due escrow, and the first pass after the job reclaims it (ruling R55)', async () => {
    const m = marketplace();
    // An escrow an earlier run left behind, posted 400 s before T0 on the marketplace's chain: its deliver_by is 80 s after T0, so it is not due at start.
    m.clock.now = T0 - 400_000;
    const left = await m.chain.postEscrow({ advertRef: OCR_ADVERT_REF, promptHash: 'ab'.repeat(32) });
    m.clock.now = T0;
    const dir = tempDir();
    new StrandedStore(dir).add({ escrow_ref: left.escrowRef, deliver_by: left.deliverBy, posted_at: left.postedAt, kind: 'ocr' });
    let sleeping = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const env = envIn(dir, { OCR_ALLOWLIST_SUPPLIER_PKH: m.ocr.key.pkh, LLM_MODEL_ALLOWLIST: ALLOWLIST.join(','), VECTOR_MARKETPLACE_INDEXER_URL: INDEXER });
    const service = await start(env, {
      createChain: async () => m.chain, fetchImpl: m.fetchImpl, renderer: fakeRenderer({ total: 2 }), clock: () => m.clock.now, janitorIntervalMs: 20,
      sleep: async (ms) => { sleeping = true; await gate; m.clock.now += ms; },
    });
    const request = { source: { pdf_b64: toBase64(TWO_PAGES_PDF), mime: 'application/pdf' }, task: 'summary' };
    const job = fetch(`http://127.0.0.1:${service.port}/`, { method: 'POST', headers: AUTH, body: wire(request) }).then((r) => r.status, () => 'closed');
    await until(() => sleeping, 'the job is running');
    m.clock.now = T0 + 100_000; // the escrow left behind is due now, 5 s after its deliver_by and more
    await until(() => logs.some((line) => line.startsWith('janitor: 1 transaction deferred: a job is running')), 'a pass has deferred the Reclaim');
    expect(await m.chain.escrowState(left.escrowRef)).toBe('Open');
    expect(logs.some((line) => line.startsWith(`janitor: reclaimed ${left.escrowRef}`))).toBe(false);
    release();
    expect(await job).toBe(200);
    await until(() => logs.some((line) => line.startsWith(`janitor: reclaimed ${left.escrowRef}`)), 'the first pass after the job has reclaimed it');
    expect(await m.chain.escrowState(left.escrowRef)).toBe('spent');
  });

  test('a job runs on the settings of the environment: the OCR supplier key, the models and the indexer it names, and the stranded store in its state directory', async () => {
    const m = marketplace();
    const dir = tempDir();
    const env = envIn(dir, { OCR_ALLOWLIST_SUPPLIER_PKH: m.ocr.key.pkh, LLM_MODEL_ALLOWLIST: ALLOWLIST.join(','), VECTOR_MARKETPLACE_INDEXER_URL: INDEXER });
    const parts: StartOptions = { createChain: async () => m.chain, fetchImpl: m.fetchImpl, renderer: fakeRenderer({ total: 2 }), clock: () => m.clock.now, sleep: async (ms) => { m.clock.now += ms; } };
    const request = { source: { pdf_b64: toBase64(TWO_PAGES_PDF), mime: 'application/pdf' }, task: 'summary' };
    const service = await start(env, parts);
    const reply = await fetch(`http://127.0.0.1:${service.port}/`, { method: 'POST', headers: AUTH, body: wire(request) });
    const result = await reply.json();
    expect(reply.status).toBe(200);
    expect(result.result).toStrictEqual({ summary: SUMMARY });
    expect(result.accounting.sub_jobs).toBe(3);
    await expect(m.chain.escrowState(escrowNo(3))).resolves.toBe('spent');
    expect(JSON.parse(readFileSync(join(dir, 'stranded.json'), 'utf8'))).toStrictEqual([]); // the store is there, and everything was accepted
    // The next job: the OCR supplier signs with a key that is not its own, the receipt fails, and the escrow it left is in the state directory.
    m.ocr.forge = true;
    const failed = await fetch(`http://127.0.0.1:${service.port}/`, { method: 'POST', headers: AUTH, body: wire(request) });
    expect(failed.status).toBe(422);
    expect((await failed.json()).error).toBe('ocr_receipt_failed');
    const kept = JSON.parse(readFileSync(join(dir, 'stranded.json'), 'utf8')) as Array<{ escrow_ref: string; kind: string }>;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ escrow_ref: escrowNo(4), kind: 'ocr' });
  });

  test('a wrong buyer hash is refused before anything is made: no chain, no state directory, no listener', async () => {
    const dir = join(tempDir(), 'state');
    let made = 0;
    await expect(startService(envIn(dir, { PIPELINE_BUYER_PKH: 'cd'.repeat(28) }), optionsWith({ createChain: async () => { made += 1; return new FakeChain(); } }))).rejects.toThrow(/PIPELINE_BUYER_PKH/);
    expect(made).toBe(0);
    expect(existsSync(dir)).toBe(false);
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
    const makeChain = async () => { made += 1; return new FakeChain(); };
    await expect(startService(envIn(bad), optionsWith({ createChain: makeChain }))).rejects.toThrow(/environment variable PIPELINE_STATE_DIR names .* which cannot be written/);
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

  test('a port that is taken stops the start with the reason', async () => {
    const first = await start(envIn(tempDir()));
    await expect(startService(envIn(tempDir(), { PORT: String(first.port) }), optionsWith())).rejects.toThrow(/EADDRINUSE|address already in use/);
  });

  test('stop closes the server and the janitor', async () => {
    const service = await start(envIn(tempDir()));
    await service.stop();
    await expect(fetch(`http://127.0.0.1:${service.port}/healthz`)).rejects.toThrow();
    await service.stop(); // safe to call twice
  });

  test('stop does not wait for a job that is running: its connection is closed', async () => {
    let asked = false;
    const hang = (async () => { asked = true; return new Promise<Response>(() => {}); }) as typeof fetch; // the indexer never answers
    const service = await start(envIn(tempDir()), { fetchImpl: hang });
    const request = { source: { pdf_b64: toBase64(TWO_PAGES_PDF), mime: 'application/pdf' }, task: 'summary' };
    const job = fetch(`http://127.0.0.1:${service.port}/`, { method: 'POST', headers: AUTH, body: wire(request) }).then(() => 'answered', () => 'closed');
    await until(() => asked, 'the job has reached the indexer');
    await service.stop();
    expect(await job).toBe('closed');
  });

  // A service whose image lost its poppler tools would answer /healthz ok and fail every PDF. It asks each tool for its version before it listens.
  describe('the poppler tools are asked for at start', () => {
    let tools = '';
    beforeEach(() => { tools = fakePopplerDir(); }); // made for each test: the directories of a test are removed when it ends
    const tool = (name: string) => join(tools, process.platform === 'win32' ? `${name}.exe` : name);
    const missing = (name: string) => `${name}-that-is-not-installed`;

    test('a tool that cannot be run stops the start before a chain is made, and the message names it', async () => {
      let made = 0;
      const makeChain = async () => { made += 1; return new FakeChain(); };
      for (const [name, renderer] of [
        ['pdfinfo', popplerRenderer({ pdfinfo: missing('pdfinfo'), pdftoppm: tool('pdftoppm') })],
        ['pdftoppm', popplerRenderer({ pdfinfo: tool('pdfinfo'), pdftoppm: missing('pdftoppm') })],
      ] as const) {
        await expect(startService(envIn(tempDir()), optionsWith({ createChain: makeChain, renderer })), name).rejects.toThrow(new RegExp(`${missing(name)} cannot be run.*poppler-utils \\(pdfinfo and pdftoppm\\) must be installed`));
      }
      expect(made).toBe(0);
    });

    test('with both tools answering the start goes on, and the check reads no PDF: the tools are asked for their version only', async () => {
      const service = await start(envIn(tempDir()), { renderer: popplerRenderer({ pdfinfo: tool('pdfinfo'), pdftoppm: tool('pdftoppm') }) });
      expect((await fetch(`http://127.0.0.1:${service.port}/healthz`)).status).toBe(200);
    });

    test('a renderer that has no check (a fake) starts as it did', async () => {
      const service = await start(envIn(tempDir()), { renderer: fakeRenderer() });
      expect((await fetch(`http://127.0.0.1:${service.port}/healthz`)).status).toBe(200);
    });
  });

  // A restart must not cut the answer of a job that is running (SIGTERM from `docker stop`, then SIGKILL after the grace period of the compose file).
  describe('shutdown: no new job, wait for the one that is running, then stop', () => {
    const REQUEST = { source: { pdf_b64: toBase64(TWO_PAGES_PDF), mime: 'application/pdf' }, task: 'summary' };
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    /** A service on the in-memory marketplace whose job stops at its first sleep until `release` is called. `signal` lets the caller hang up. */
    async function holdingService(opts: { signal?: AbortSignal } = {}) {
      const m = marketplace();
      let sleeping = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const env = envIn(tempDir(), { OCR_ALLOWLIST_SUPPLIER_PKH: m.ocr.key.pkh, LLM_MODEL_ALLOWLIST: ALLOWLIST.join(','), VECTOR_MARKETPLACE_INDEXER_URL: INDEXER });
      const service = await start(env, {
        createChain: async () => m.chain, fetchImpl: m.fetchImpl, renderer: fakeRenderer({ total: 2 }), clock: () => m.clock.now,
        sleep: async (ms) => { sleeping = true; await gate; m.clock.now += ms; },
      });
      const url = `http://127.0.0.1:${service.port}`;
      const job = fetch(`${url}/`, { method: 'POST', headers: AUTH, body: wire(REQUEST), signal: opts.signal }).then(async (r) => ({ status: r.status, json: await r.json() }));
      job.catch(() => undefined); // a test that closes the connection reads the failure itself
      await until(() => sleeping, 'the job is running');
      return { service, m, url, job, release };
    }

    test('an idle service shuts down at once, and shutdown can be called twice', async () => {
      const service = await start(envIn(tempDir()));
      const began = Date.now();
      expect(await service.shutdown(30_000)).toBe('finished');
      expect(await service.shutdown(30_000)).toBe('finished');
      expect(Date.now() - began).toBeLessThan(2000);
      await expect(fetch(`http://127.0.0.1:${service.port}/healthz`)).rejects.toThrow();
    });

    test('shutdown waits for the job that is running, takes no new connection meanwhile, delivers the answer whole, and then closes', async () => {
      const { service, m, url, job, release } = await holdingService();
      let finished = false;
      let outcome: string | undefined;
      const done = service.shutdown(30_000).then((ended) => { finished = true; outcome = ended; });
      await pause(250); // two rounds of the sweep that closes idle connections: the connection of the job is not idle
      expect(finished).toBe(false);
      await expect(fetch(`${url}/healthz`)).rejects.toThrow();
      release();
      const answer = await job;
      expect(answer.status).toBe(200);
      expect(answer.json.result).toStrictEqual({ summary: SUMMARY });
      expect(answer.json.accounting.sub_jobs).toBe(3);
      const answered = Date.now();
      await done;
      expect(Date.now() - answered).toBeLessThan(1500); // the connection that has just been answered is closed by the sweep, not left for its keep-alive timeout
      expect(finished).toBe(true);
      expect(outcome).toBe('finished');
      await expect(m.chain.escrowState(escrowNo(3))).resolves.toBe('spent');
      expect(logs.join('\n')).toMatch(/stopping: waiting up to 30000 ms for the job that is running/);
      expect(logs.join('\n')).not.toMatch(/did not finish/);
    });

    // Ruling R61: the stop waits on the job slot, which the job holds until it has its answer, its Accept included. A wait on the connections ended as soon as
    // the caller hung up, and the process then stopped a job that was still paying.
    test('a caller that hangs up does not end the wait: the stop waits for the job itself, its Accept included, and then says finished (ruling R61)', async () => {
      const abort = new AbortController();
      const { service, m, job, release } = await holdingService({ signal: abort.signal });
      let ended = false;
      let outcome: string | undefined;
      const done = service.shutdown(30_000).then((said) => { ended = true; outcome = said; });
      abort.abort(); // the runtime gives up on the job: its connection is gone
      await expect(job).rejects.toThrow();
      await pause(300); // three rounds of the sweep: no connection is left open
      expect(ended).toBe(false); // the job still holds the slot
      release();
      await done;
      expect(outcome).toBe('finished');
      await expect(m.chain.escrowState(escrowNo(3))).resolves.toBe('spent'); // the chat job was accepted before the stop ended
      expect(logs.join('\n')).not.toMatch(/did not finish/);
    });

    test('the janitor is stopped with a bound: a pass still in flight after the bound is abandoned, with a log line, and the stop goes on (ruling R61)', async () => {
      const dir = tempDir();
      // An escrow long past its deliver_by, so that the first pass of the janitor reads its state, and a chain whose read never answers.
      writeFileSync(join(dir, 'stranded.json'), JSON.stringify([{ escrow_ref: escrowNo(9), deliver_by: 1, posted_at: 0, kind: 'ocr' }]), 'utf8');
      const chain = new FakeChain({ buyerPkh: BUYER.pkh });
      let reads = 0;
      chain.escrowState = () => { reads += 1; return new Promise(() => undefined); };
      const service = await start(envIn(dir), { createChain: async () => chain, janitorIntervalMs: 60_000, janitorStopWaitMs: 200 });
      await until(() => reads > 0, 'the janitor reads the state of the escrow');
      const began = Date.now();
      expect(await service.shutdown(30_000)).toBe('finished'); // no job was running: the job wait is not what was abandoned
      expect(Date.now() - began).toBeGreaterThanOrEqual(190);
      expect(Date.now() - began).toBeLessThan(5000);
      expect(logs.join('\n')).toContain("stopping: the janitor's pass did not end within 0.2 s and is abandoned; the janitor of the next start reads the state directory again");
      await expect(fetch(`http://127.0.0.1:${service.port}/healthz`)).rejects.toThrow();
    });

    test('shutdown drains the slot: a request that was still being uploaded when the stop began is refused with 503 shutting_down when it is complete, not with 409 busy', async () => {
      const { service, release } = await holdingService();
      const late = rawClient(service.port, { body: wire(REQUEST), holdBack: 5 });
      try {
        await pause(150); // the head and most of the body are in: the request is under way, so its connection is not idle
        const done = service.shutdown(30_000);
        await pause(250); // the sweep has run: this connection is still open
        late.finish();
        const answer = await late.answer();
        expect(answer.status).toBe(503);
        expect(JSON.parse(answer.body!.toString('utf8'))).toStrictEqual({ error: 'shutting_down', message: 'The service is stopping and takes no new job. Try again shortly.' });
        release();
        await done;
      } finally {
        late.close();
      }
    });

    test('shutdown does not wait for ever: past its limit it abandons the job, closes its connection, names the escrows the state directory holds, and says abandoned', async () => {
      const { service, m, job, release } = await holdingService();
      const began = Date.now();
      expect(await service.shutdown(150)).toBe('abandoned');
      expect(Date.now() - began).toBeGreaterThanOrEqual(140);
      expect(Date.now() - began).toBeLessThan(5000);
      await expect(job).rejects.toThrow();
      // The job stopped at its first poll, so the Post of its first page is the escrow in flight.
      expect(logs.join('\n')).toContain(`stopping: the job that is running did not finish within 150 ms and is abandoned; the state directory holds 1 escrow for the janitor of the next start: ${escrowNo(1)}`);
      release(); // let the job end, so that nothing of it is still running when the directory of the test goes
      for (let i = 0; i < 600 && (await m.chain.escrowState(escrowNo(3))) !== 'spent'; i++) await pause(5);
      await expect(m.chain.escrowState(escrowNo(3))).resolves.toBe('spent');
    });
  });
});

// ---- Signals ------------------------------------------------------------------------------------------------------------------------
describe('stopOnSignals', () => {
  const lines: string[] = [];
  const log = (line: string): void => { lines.push(line); };
  afterEach(() => { lines.length = 0; });
  const serviceThatStopsAs = (shutdown: (waitMs?: number) => Promise<void>) => ({ shutdown } as unknown as RunningService);

  test('SIGTERM and SIGINT start the shutdown with the default wait, then exit 0; after the first signal the handlers are gone, so a second one is the default action', async () => {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      const target = new EventEmitter();
      const exits: number[] = [];
      const waits: Array<number | undefined> = [];
      stopOnSignals(serviceThatStopsAs(async (waitMs) => { waits.push(waitMs); }), { target, exit: (code) => { exits.push(code); }, log });
      expect(target.listenerCount('SIGTERM')).toBe(1);
      expect(target.listenerCount('SIGINT')).toBe(1);
      target.emit(signal);
      await until(() => exits.length === 1, 'the process exits');
      expect(waits).toStrictEqual([SHUTDOWN_WAIT_MS]);
      expect(exits).toStrictEqual([0]);
      expect(lines.join('\n')).toContain(signal);
      expect(target.listenerCount('SIGTERM')).toBe(0);
      expect(target.listenerCount('SIGINT')).toBe(0);
      target.emit('SIGTERM'); // nobody listens: nothing runs again
      expect(waits).toHaveLength(1);
    }
    expect(SHUTDOWN_WAIT_MS).toBe(300_000);
  });

  test('a stop that had to abandon the job that was running exits 1, so that the stop is not mistaken for a clean one (ruling R61)', async () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    stopOnSignals({ shutdown: async () => 'abandoned' } as unknown as RunningService, { target, exit: (code) => { exits.push(code); }, log });
    target.emit('SIGTERM');
    await until(() => exits.length === 1, 'the process exits');
    expect(exits).toStrictEqual([1]);
    const finished: number[] = [];
    const other = new EventEmitter();
    stopOnSignals({ shutdown: async () => 'finished' } as unknown as RunningService, { target: other, exit: (code) => { finished.push(code); }, log });
    other.emit('SIGTERM');
    await until(() => finished.length === 1, 'the process exits');
    expect(finished).toStrictEqual([0]);
  });

  test('a shutdown that fails is logged and the exit is 1', async () => {
    const target = new EventEmitter();
    const exits: number[] = [];
    stopOnSignals(serviceThatStopsAs(async () => { throw new Error('the port would not close'); }), { target, exit: (code) => { exits.push(code); }, log });
    target.emit('SIGTERM');
    await until(() => exits.length === 1, 'the process exits');
    expect(exits).toStrictEqual([1]);
    expect(lines.join('\n')).toContain('the port would not close');
  });

  test('the wait is the option when one is given', async () => {
    const target = new EventEmitter();
    const waits: Array<number | undefined> = [];
    stopOnSignals(serviceThatStopsAs(async (waitMs) => { waits.push(waitMs); }), { target, exit: () => undefined, log, waitMs: 1234 });
    target.emit('SIGINT');
    await until(() => waits.length === 1, 'the shutdown starts');
    expect(waits).toStrictEqual([1234]);
  });

  test('on the real process object the handlers are put on SIGTERM and SIGINT, and taken off again when one comes', async () => {
    const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
    const exits: number[] = [];
    stopOnSignals(serviceThatStopsAs(async () => undefined), { exit: (code) => { exits.push(code); }, log });
    try {
      expect([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')]).toStrictEqual([before[0] + 1, before[1] + 1]);
      process.emit('SIGTERM');
      await until(() => exits.length === 1, 'the process exits');
      expect([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')]).toStrictEqual(before);
    } finally {
      process.removeAllListeners('SIGINT').removeAllListeners('SIGTERM'); // only if the test failed half way; the signals are not listened for in a test run
    }
  });
});

// ---- The process --------------------------------------------------------------------------------------------------------------------
describe('src/index.ts as a process', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  // What the service reads, taken out of the environment the tests run in, so that nothing an operator has set can change what a test sees.
  const READ = [
    'OPERATOR_CONTACT', 'PIPELINE_BUYER_PRIV_KEY_HEX', 'SUPPLIER_PKH', 'SERVICE_AUTH_HEADER', 'SUPPLIER_PUB_KEY_HEX', 'AGENT_DID', 'AGENT_VERSION', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE',
    'ADVERT_PRICE_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_EXPLORER_URL', 'PIPELINE_BUYER_PKH', 'PIPELINE_BUYER_ADDRESS', 'OCR_ALLOWLIST_SUPPLIER_PKH', 'LLM_MODEL_ALLOWLIST',
    'OCR_MAX_PRICE_LOVELACE', 'LLM_MAX_PRICE_LOVELACE', 'PIPELINE_STATE_DIR', 'VECTOR_MARKETPLACE_INDEXER_URL', 'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'PORT', 'HOST',
  ];
  const baseEnv = (): Record<string, string | undefined> => {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const name of READ) delete env[name];
    return env;
  };
  const NODE_ARGS = ['--import', 'tsx', 'src/index.ts'];
  /** Starts src/index.ts on `env` and waits for it to end. `path` replaces the directories searched for programs, where a test needs that. */
  const run = (env: Record<string, string>, path?: string) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const full = { ...baseEnv(), ...env, PORT: '0', HOST: '127.0.0.1' };
    execFile(process.execPath, NODE_ARGS, { cwd, env: path === undefined ? full : withPath(full, path), encoding: 'utf8', timeout: 60_000 }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({ status: error === null ? 0 : typeof code === 'number' ? code : null, stdout, stderr });
    });
  });

  test('exits 1 at start with the variable named, and listens on nothing, when a required setting is missing, a setting is wrong, or the buyer key is in the wrong line', async () => {
    const { OPERATOR_CONTACT, PIPELINE_BUYER_PRIV_KEY_HEX, SUPPLIER_PKH } = FULL_ENV;
    const state = { PIPELINE_STATE_DIR: tempDir() };
    const cases: Array<{ label: string; env: Record<string, string>; message: RegExp; path?: string }> = [
      { label: 'OPERATOR_CONTACT is not set', env: { PIPELINE_BUYER_PRIV_KEY_HEX, SUPPLIER_PKH }, message: /environment variable OPERATOR_CONTACT is required/ },
      { label: 'OPERATOR_CONTACT is blank', env: { OPERATOR_CONTACT: '  ', PIPELINE_BUYER_PRIV_KEY_HEX, SUPPLIER_PKH }, message: /environment variable OPERATOR_CONTACT is required/ },
      { label: 'PIPELINE_BUYER_PRIV_KEY_HEX is not set', env: { OPERATOR_CONTACT, SUPPLIER_PKH }, message: /environment variable PIPELINE_BUYER_PRIV_KEY_HEX is required/ },
      { label: 'SUPPLIER_PKH is not set', env: { OPERATOR_CONTACT, PIPELINE_BUYER_PRIV_KEY_HEX }, message: /environment variable SUPPLIER_PKH is required/ },
      { label: 'SERVICE_AUTH_HEADER is not set', env: { OPERATOR_CONTACT, PIPELINE_BUYER_PRIV_KEY_HEX, SUPPLIER_PKH }, message: /environment variable SERVICE_AUTH_HEADER is required/ },
      { label: 'SERVICE_AUTH_HEADER is empty', env: { ...FULL_ENV, SERVICE_AUTH_HEADER: '' }, message: /environment variable SERVICE_AUTH_HEADER is required/ },
      { label: 'the buyer key is in SERVICE_AUTH_HEADER, where the runtime would have it', env: { ...FULL_ENV, SERVICE_AUTH_HEADER: `Bearer ${BUYER.privateKeyHex}` }, message: /environment variable SERVICE_AUTH_HEADER holds the buyer key/ },
      { label: 'PIPELINE_BUYER_PKH is not the key\'s', env: { ...FULL_ENV, PIPELINE_BUYER_PKH: 'cd'.repeat(28) }, message: /environment variable PIPELINE_BUYER_PKH/ },
      { label: 'PIPELINE_BUYER_ADDRESS is not the key\'s', env: { ...FULL_ENV, PIPELINE_BUYER_ADDRESS: new FakeChain({ buyerPkh: SUPPLIER.pkh }).address }, message: /environment variable PIPELINE_BUYER_ADDRESS/ },
      { label: 'the buyer key is in AGENT_DID, where it would be published', env: { ...FULL_ENV, AGENT_DID: BUYER.privateKeyHex }, message: /environment variable AGENT_DID holds the buyer key/ },
      { label: 'the buyer key is in SUPPLIER_PKH, where it would be printed', env: { ...FULL_ENV, SUPPLIER_PKH: BUYER.privateKeyHex }, message: /environment variable SUPPLIER_PKH holds the buyer key/ },
      { label: 'the processing window is below 30 min', env: { ...FULL_ENV, ADVERT_MAX_PROCESSING_MS: '600000' }, message: /environment variable ADVERT_MAX_PROCESSING_MS must be at least 1800000/ },
      // The tools are looked for on a path that holds nothing, so that a machine with poppler installed does not change the answer.
      { label: 'pdfinfo and pdftoppm are not on the path', env: { ...FULL_ENV, ...state }, message: /pdfinfo cannot be run \(ENOENT\).*poppler-utils \(pdfinfo and pdftoppm\) must be installed/, path: tempDir() },
    ];
    const results = await Promise.all(cases.map(({ env, path }) => run(env, path)));
    cases.forEach(({ label, message }, i) => {
      const r = results[i];
      expect(r.status, `${label}: ${r.stderr}`).toBe(1);
      expect(r.stderr, label).toMatch(message);
      expect(r.stdout, label).not.toMatch(/listening/);
      expect(r.stderr + r.stdout, label).not.toContain(BUYER.privateKeyHex);
      expect(r.stderr + r.stdout, label).not.toContain(TEST_AUTH.slice('Bearer '.length));
    });
  }, 120_000);

  test('started for real against a node that is not there: it listens, publishes the buyer hash derived from the key, and says its wallet cannot be read', async () => {
    const closed = await closedPort();
    const node = `http://127.0.0.1:${closed}`;
    const dir = tempDir();
    // The start asks pdfinfo and pdftoppm for their version: stand-ins that do, put first on the path, so that the test needs no poppler.
    const base = { ...baseEnv(), ...FULL_ENV, PORT: '0', HOST: '127.0.0.1', PIPELINE_STATE_DIR: dir, VECTOR_OGMIOS_URL: node, VECTOR_KOIOS_URL: `${node}/`, VECTOR_SUBMIT_URL: `${node}/api/submit/tx`, VECTOR_MARKETPLACE_INDEXER_URL: node };
    const child = spawn(process.execPath, NODE_ARGS, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: withPath(base, inFront(fakePopplerDir(), pathOf(base))) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    try {
      await until(() => /listening on 127\.0\.0\.1:\d+/.test(stdout), `the service listens (stdout: ${stdout}, stderr: ${stderr})`, 60_000);
      const port = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(stdout)?.[1]);
      const manifest = await (await fetch(`http://127.0.0.1:${port}/agent.json`)).json();
      expect(manifest.keys.buyer_pkh).toBe(BUYER.pkh);
      expect(manifest.keys.supplier_pkh).toBe(SUPPLIER.pkh);
      expect(stdout).toContain(BUYER_ADDRESS);
      expect(stdout.trim().split('\n').every((line) => line.startsWith('[document-pipeline] '))).toBe(true); // the log is the service's, one line each
      // The real process requires the token of its environment on POST /, and logs the refusal without it.
      const denied = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'x' });
      expect(denied.status).toBe(401);
      expect(await denied.json()).toStrictEqual({ error: 'unauthorized' });
      expect((await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: AUTH, body: 'x' })).status).toBe(400);
      await until(() => /request refused: unauthorized/.test(stdout), `the refusal is logged (stdout: ${stdout})`, 10_000);
      expect(stdout + stderr).not.toContain(TEST_AUTH.slice('Bearer '.length));
      // The first wallet check goes to the node, which is not there: from then on the service says so.
      let status = 200;
      for (let i = 0; i < 300 && status === 200; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        status = (await fetch(`http://127.0.0.1:${port}/healthz`)).status;
      }
      expect(status).toBe(503);
      expect(existsSync(dir)).toBe(true);
      expect(stdout + stderr).not.toContain(BUYER.privateKeyHex);
    } finally {
      const exited = new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
      child.kill();
      await exited;
    }
  }, 120_000);
});
