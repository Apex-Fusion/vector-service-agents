// agents/advocate/test/start.test.ts
// How the service starts and stops: the environment read into a configuration, its checks in their order, the token and the two API keys kept out of every
// other line and out of the manifest, the model and the window checked, the line it logs when it listens (it asks no third party anything at start), the
// stop of the kit with this service's log, and src/index.ts run as a process.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test, expect } from 'vitest';
import { modelGap } from '../src/gaps.ts';
import { DEFAULT_MODEL } from '../src/model.ts';
import { manifestFromEnv } from '../src/server.ts';
import { PORT_DEFAULT, SETTINGS, SHUTDOWN_WAIT_MS, loadConfig, startService, stopOnSignals } from '../src/start.ts';
import { GOLDEN_REQUEST, TEST_BRAVE_KEY, TEST_OPENROUTER_KEY } from './golden.ts';
import { FULL_ENV, SUPPLIER, T0, TEST_AUTH, TEST_CONTACT, wire } from './server-support.ts';

const message = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as Error).message; } throw new Error('it was accepted'); };
/** The two keys of the third parties: the line of each, the key the tests use, and its name in a message. */
const KEYS = [
  { own: 'BRAVE_SEARCH_API_KEY', key: TEST_BRAVE_KEY, what: 'the Brave Search API key' },
  { own: 'OPENROUTER_API_KEY', key: TEST_OPENROUTER_KEY, what: 'the OpenRouter API key' },
] as const;
const KEY_LINES: readonly string[] = KEYS.map((k) => k.own);
/** The lines a check before the search of the keys reads: the token's own search, and the two hex values of the supplier. */
const EARLIER: readonly string[] = ['SERVICE_AUTH_HEADER', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX'];
/** Does `text` show a part of `secret` worth a search, in any case? */
const shows = (text: string, secret: string): boolean => text.toLowerCase().includes(secret.slice(-16).toLowerCase());

describe('loadConfig', () => {
  test('a full environment gives the defaults for everything the operator leaves out', () => {
    expect(loadConfig(FULL_ENV)).toStrictEqual({
      manifest: manifestFromEnv(FULL_ENV), authHeader: TEST_AUTH, host: '0.0.0.0', port: 9094, braveApiKey: TEST_BRAVE_KEY, openRouterApiKey: TEST_OPENROUTER_KEY, model: DEFAULT_MODEL,
    });
    expect(PORT_DEFAULT).toBe(9094);
  });

  test('every setting is read: the model, the port and the host; an empty one is not set', () => {
    const config = loadConfig({ ...FULL_ENV, OPENROUTER_MODEL: 'openai/gpt-4o-mini', PORT: '9100', HOST: '127.0.0.1' });
    expect([config.model, config.port, config.host, config.manifest.gaps[4]]).toStrictEqual(['openai/gpt-4o-mini', 9100, '127.0.0.1', modelGap('openai/gpt-4o-mini')]);
    expect(loadConfig({ ...FULL_ENV, OPENROUTER_MODEL: '', PORT: '', HOST: '' })).toStrictEqual(loadConfig(FULL_ENV));
  });

  test('the DID is published without the space a file leaves around it', () => {
    expect(loadConfig({ ...FULL_ENV, AGENT_DID: ' did:test\n' }).manifest.identity.did).toBe('did:test');
  });

  test('six settings are required, checked in this order, each error naming its variable; then the model, the window and the manifest, in that order', () => {
    const { OPERATOR_CONTACT, SUPPLIER_PKH, SERVICE_AUTH_HEADER, SUPPLIER_PUB_KEY_HEX, BRAVE_SEARCH_API_KEY, OPENROUTER_API_KEY } = FULL_ENV;
    const steps: Array<[NodeJS.ProcessEnv, string]> = [
      [{}, "environment variable OPERATOR_CONTACT is required (the operator's contact address, published in the manifest) and is not set"],
      [{ OPERATOR_CONTACT }, 'environment variable SUPPLIER_PKH is required (the key hash of the supplier key, published in the manifest) and is not set'],
      [{ OPERATOR_CONTACT, SUPPLIER_PKH }, 'environment variable SERVICE_AUTH_HEADER is required (the value the template runtime sends as the authorization header of every call, which POST / requires) and is not set'],
      [{ OPERATOR_CONTACT, SUPPLIER_PKH, SERVICE_AUTH_HEADER }, 'environment variable SUPPLIER_PUB_KEY_HEX is required (the public key of the supplier key, published in the manifest) and is not set'],
      [{ OPERATOR_CONTACT, SUPPLIER_PKH, SERVICE_AUTH_HEADER, SUPPLIER_PUB_KEY_HEX }, 'environment variable BRAVE_SEARCH_API_KEY is required (the key of the Brave Search API, which the two search queries of a job send) and is not set'],
      [{ OPERATOR_CONTACT, SUPPLIER_PKH, SERVICE_AUTH_HEADER, SUPPLIER_PUB_KEY_HEX, BRAVE_SEARCH_API_KEY }, 'environment variable OPENROUTER_API_KEY is required (the key of OpenRouter, which the model call of a job sends) and is not set'],
    ];
    for (const [env, refusal] of steps) expect(message(() => loadConfig(env))).toBe(refusal);
    const six = { OPERATOR_CONTACT, SUPPLIER_PKH, SERVICE_AUTH_HEADER, SUPPLIER_PUB_KEY_HEX, BRAVE_SEARCH_API_KEY, OPENROUTER_API_KEY };
    expect(loadConfig(six).authHeader).toBe(TEST_AUTH);
    expect(message(() => loadConfig({ ...six, OPENROUTER_MODEL: 'no-slash', ADVERT_MAX_PROCESSING_MS: '1', AGENT_STATUS_CHIP: 'built' }))).toMatch(/^environment variable OPENROUTER_MODEL /);
    expect(message(() => loadConfig({ ...six, ADVERT_MAX_PROCESSING_MS: '1', AGENT_STATUS_CHIP: 'built' }))).toMatch(/^environment variable ADVERT_MAX_PROCESSING_MS must be at least 300000/);
    expect(message(() => loadConfig({ ...six, AGENT_STATUS_CHIP: 'built' }))).toMatch(/^environment variable AGENT_STATUS_CHIP /);
    // And the search for the token comes before them all, when the token is given.
    expect(message(() => loadConfig({ SERVICE_AUTH_HEADER, AGENT_DID: TEST_AUTH }))).toMatch(/^environment variable AGENT_DID holds the service token/);
  });

  test('the supplier key hash is 56 hex characters, published in lower case; the public key must be the key of that hash, and no value is shown', () => {
    expect(loadConfig({ ...FULL_ENV, SUPPLIER_PKH: SUPPLIER.pkh.toUpperCase(), SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex.toUpperCase() }).manifest.keys).toStrictEqual({ supplier_pkh: SUPPLIER.pkh, pub_key_hex: SUPPLIER.pubKeyHex });
    expect(message(() => loadConfig({ ...FULL_ENV, SUPPLIER_PKH: 'ab'.repeat(27) }))).toBe('environment variable SUPPLIER_PKH must be 56 hex characters, and it has 54 characters');
    const text = message(() => loadConfig({ ...FULL_ENV, SUPPLIER_PUB_KEY_HEX: 'cd'.repeat(32) }));
    expect(text).toBe('environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH: the key hash of the one is not the other. Both are published, so they must come from the same key pair, and the public key line must not hold a private key');
    expect(text).not.toMatch(/[0-9a-f]{16}/i);
  });

  describe('the service token', () => {
    test('a token of the form the runbook makes is accepted; one that is not printable ASCII is refused with its length only', () => {
      expect(loadConfig(FULL_ENV).authHeader).toHaveLength(71);
      expect(message(() => loadConfig({ ...FULL_ENV, SERVICE_AUTH_HEADER: `Bearer ${'ab'.repeat(30)}\u{e9}` }))).toBe('environment variable SERVICE_AUTH_HEADER must be printable ASCII (it is sent as an HTTP header), and it has 68 characters');
    });
    test('the token in any other setting is refused, naming that setting and not showing it: whole or its credential, in any case, inside a longer value', () => {
      const credential = TEST_AUTH.slice('Bearer '.length);
      for (const name of SETTINGS.filter((n) => n !== 'SERVICE_AUTH_HEADER')) {
        for (const value of [TEST_AUTH, credential.toUpperCase(), `x${credential}y`]) {
          const text = message(() => loadConfig({ ...FULL_ENV, [name]: value }));
          expect(text, name).toBe(`environment variable ${name} holds the service token, which belongs in SERVICE_AUTH_HEADER alone: it would be printed or published. Take it out of ${name}`);
          expect(shows(text, credential)).toBe(false);
        }
      }
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

    test('a key in any other setting is refused, naming that setting and not showing the key: whole, in another case, inside a longer value', () => {
      for (const { own, key, what } of KEYS) {
        for (const name of SETTINGS.filter((n) => !KEY_LINES.includes(n) && !EARLIER.includes(n))) {
          for (const value of [key, key.toUpperCase(), `x${key}y`]) {
            const text = message(() => loadConfig({ ...FULL_ENV, [name]: value }));
            expect(text, `${own} in ${name}`).toBe(`environment variable ${name} holds ${what}, which belongs in ${own} alone: it would be printed or published. Take it out of ${name}`);
            expect(shows(text, key)).toBe(false);
          }
        }
      }
    });

    test('a key in a line that a check before the search reads (the token, the key hash, the public key) is refused there, and the message shows no key', () => {
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

  test('the manifest is looked at last: one that would publish the token or either key stops the start, and says which', () => {
    const leaky = (secret: string) => (env: NodeJS.ProcessEnv) => ({ ...manifestFromEnv(env), description: `see ${secret}` });
    expect(message(() => loadConfig(FULL_ENV, leaky(TEST_AUTH)))).toBe('the manifest would publish the service token: a value that goes into it holds the token of SERVICE_AUTH_HEADER, and the service does not start with it');
    expect(message(() => loadConfig(FULL_ENV, leaky(TEST_BRAVE_KEY)))).toBe('the manifest would publish the Brave Search API key: a value that goes into it holds the key of BRAVE_SEARCH_API_KEY, and the service does not start with it');
    expect(message(() => loadConfig(FULL_ENV, leaky(TEST_OPENROUTER_KEY.toUpperCase())))).toBe('the manifest would publish the OpenRouter API key: a value that goes into it holds the key of OPENROUTER_API_KEY, and the service does not start with it');
  });

  test('OPENROUTER_MODEL: absent or empty is the default; an id of OpenRouter is used, in the config and in the gap of the manifest; anything else is refused', () => {
    expect(loadConfig({ ...FULL_ENV, OPENROUTER_MODEL: ' ' }).model).toBe(DEFAULT_MODEL);
    const config = loadConfig({ ...FULL_ENV, OPENROUTER_MODEL: ' openai/gpt-4o-mini ' });
    expect([config.model, config.manifest.gaps[4]]).toStrictEqual(['openai/gpt-4o-mini', modelGap('openai/gpt-4o-mini')]);
    for (const bad of ['deepseek', '/deepseek', 'deepseek/', 'deep seek/v4', 'deepseek/v4\u{e9}']) {
      expect(message(() => loadConfig({ ...FULL_ENV, OPENROUTER_MODEL: bad })), bad).toMatch(/^environment variable OPENROUTER_MODEL must be the id of a model of OpenRouter, <provider>\/<name> in printable ASCII without spaces, such as deepseek\/deepseek-v4-flash, got /);
    }
  });

  test('ADVERT_MAX_PROCESSING_MS: at least 300000, the window the deadline of a job assumes; a larger window is published', () => {
    for (const bad of ['0', '150000', '299999']) {
      expect(message(() => loadConfig({ ...FULL_ENV, ADVERT_MAX_PROCESSING_MS: bad }))).toBe(`environment variable ADVERT_MAX_PROCESSING_MS must be at least 300000 (the window of 5 min that the deadline of a job, 150000 ms, assumes), got ${bad}`);
    }
    expect(message(() => loadConfig({ ...FULL_ENV, ADVERT_MAX_PROCESSING_MS: 'five' }))).toMatch(/^environment variable ADVERT_MAX_PROCESSING_MS must be a non-negative integer/);
    expect(loadConfig({ ...FULL_ENV, ADVERT_MAX_PROCESSING_MS: '600000' }).manifest.terms.max_processing_ms).toBe(600_000);
  });

  test('SETTINGS are the names the service reads, each once: the list of Audio Snippets without the speech model, with the two keys and the model', () => {
    expect([...SETTINGS]).toStrictEqual([
      'OPERATOR_CONTACT', 'AGENT_DID', 'AGENT_VERSION', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_PRICE_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_EXPLORER_URL',
      'SERVICE_AUTH_HEADER', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'BRAVE_SEARCH_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'PORT', 'HOST',
    ]);
    expect(new Set(SETTINGS).size).toBe(SETTINGS.length);
  });
});

describe('startService', () => {
  const logs: string[] = [];
  const log = (line: string): void => { logs.push(line); };
  afterEach(() => { logs.length = 0; });
  const env = { ...FULL_ENV, PORT: '0', HOST: '127.0.0.1' };
  /** A fetch that records any call, and answers none: the start makes no outbound call. */
  const outbound: string[] = [];
  const noCall = (async (input: RequestInfo | URL) => { outbound.push(String(input)); throw new Error('no outbound call at start'); }) as typeof fetch;
  afterEach(() => { outbound.length = 0; });

  test('listens, serves the manifest, refuses a job without the token, and logs its search and its model; it asks no third party anything, and no line holds a secret', async () => {
    const service = await startService(env, { fetchImpl: noCall, log });
    try {
      const base = `http://127.0.0.1:${service.port}`;
      expect(await (await fetch(`${base}/agent.json`)).text()).toBe(JSON.stringify(manifestFromEnv(env)));
      expect(await (await fetch(`${base}/healthz`)).json()).toStrictEqual({ ok: true });
      expect((await fetch(`${base}/`, { method: 'POST', body: wire(GOLDEN_REQUEST) })).status).toBe(401);
      expect(logs).toContain(`listening on 127.0.0.1:${service.port}; search Brave Search API; model deepseek/deepseek-v4-flash via OpenRouter`);
      expect(outbound).toStrictEqual([]);
      for (const secret of [TEST_AUTH, TEST_BRAVE_KEY, TEST_OPENROUTER_KEY]) expect(shows(logs.join('\n'), secret)).toBe(false);
    } finally {
      await service.stop();
      await service.stop();
    }
  });

  test('the line names the model of OPENROUTER_MODEL', async () => {
    const service = await startService({ ...env, OPENROUTER_MODEL: 'openai/gpt-4o-mini' }, { fetchImpl: noCall, log });
    try {
      expect(logs).toContain(`listening on 127.0.0.1:${service.port}; search Brave Search API; model openai/gpt-4o-mini via OpenRouter`);
    } finally {
      await service.stop();
    }
  });

  test('a start without a key is refused before it listens', async () => {
    const { BRAVE_SEARCH_API_KEY: _brave, ...withoutBrave } = env;
    await expect(startService(withoutBrave, { fetchImpl: noCall, log })).rejects.toThrow(/^environment variable BRAVE_SEARCH_API_KEY is required/);
    const { OPENROUTER_API_KEY: _openRouter, ...withoutOpenRouter } = env;
    await expect(startService(withoutOpenRouter, { fetchImpl: noCall, log })).rejects.toThrow(/^environment variable OPENROUTER_API_KEY is required/);
    expect(logs.filter((l) => l.startsWith('listening on'))).toStrictEqual([]);
  });

  test('a shutdown with no job running finishes at once and closes the port; the wait is 300 s by default', async () => {
    const service = await startService(env, { fetchImpl: noCall, log });
    await expect(service.shutdown()).resolves.toBe('finished');
    await expect(fetch(`http://127.0.0.1:${service.port}/healthz`)).rejects.toThrow();
    expect(SHUTDOWN_WAIT_MS).toBe(300_000);
  });

  /** A fetch that records each call and answers as the Brave Search API answers a key it refuses: a job on it ends at its first query, before any page is looked up. */
  const refusing = (urls: string[]): typeof fetch =>
    (async (input: RequestInfo | URL) => { urls.push(String(input)); return new Response('{"error":"refused"}', { status: 401 }); }) as typeof fetch;
  /** The golden request, with the token of the runtime, to a service that is running. */
  const postJob = (port: number): Promise<Response> => fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: wire(GOLDEN_REQUEST), headers: { authorization: TEST_AUTH } });

  test('a job runs on the fetch the start is given: a key refused at the first query is search_failed (502), and the log says why', async () => {
    const urls: string[] = [];
    const service = await startService(env, { fetchImpl: refusing(urls), log });
    try {
      const r = await postJob(service.port);
      expect([r.status, (await r.json()).error]).toStrictEqual([502, 'search_failed']);
    } finally {
      await service.stop();
    }
    expect(urls).toHaveLength(1);
    expect(urls[0].startsWith('https://api.search.brave.com/res/v1/web/search?')).toBe(true);
    expect(logs).toContain('search: the key was refused (HTTP 401)');
  });

  test('a job runs on the clock the start is given: the line of its failure gives its time on that clock', async () => {
    let calls = 0;
    const clock = (): number => (calls++ === 0 ? T0 : T0 + 7_000);
    const service = await startService(env, { fetchImpl: refusing([]), clock, log });
    try {
      expect((await postJob(service.port)).status).toBe(502);
    } finally {
      await service.stop();
    }
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
  const run = (env: NodeJS.ProcessEnv) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    return { child, exited, out: () => out, err: () => err };
  };

  test('exits 1 at start with the variable named, and listens on nothing, when a required setting is missing', async () => {
    const p = run({ ...FULL_ENV, OPENROUTER_API_KEY: '', PORT: '0', HOST: '127.0.0.1' });
    expect(await p.exited).toBe(1);
    expect(p.err()).toMatch(/^\[advocate\] cannot start: environment variable OPENROUTER_API_KEY is required/);
    expect(p.out()).not.toContain('listening on');
  }, 30_000);

  test('started for real: it logs its line, answers /healthz and /agent.json, refuses a job without the token, and prints no secret', async () => {
    const p = run({ ...FULL_ENV, PORT: '0', HOST: '127.0.0.1', OPENROUTER_MODEL: '' });
    try {
      const end = Date.now() + 30_000;
      while (!/listening on 127\.0\.0\.1:\d+/.test(p.out()) && Date.now() < end && p.child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 50));
      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(p.out())?.[1];
      expect(port, p.err()).toBeDefined();
      expect(p.out()).toContain(`[advocate] listening on 127.0.0.1:${port}; search Brave Search API; model deepseek/deepseek-v4-flash via OpenRouter`);
      const base = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${base}/healthz`)).json()).toStrictEqual({ ok: true });
      expect((await (await fetch(`${base}/agent.json`)).json()).status).toStrictEqual({ chip: 'proposed', since: '2026-10-13' });
      expect((await fetch(`${base}/`, { method: 'POST', body: wire(GOLDEN_REQUEST) })).status).toBe(401);
      for (const secret of [TEST_AUTH, TEST_BRAVE_KEY, TEST_OPENROUTER_KEY]) expect(shows(p.out() + p.err(), secret)).toBe(false);
      expect(TEST_CONTACT).toBe('ops@example.test');
    } finally {
      p.child.kill();
      await p.exited;
    }
  }, 60_000);

  // A signal reaches a handler only on POSIX (on Windows kill() ends the process at once, whatever the signal), so CI on Linux runs this and Windows skips it.
  test.skipIf(process.platform === 'win32')('SIGTERM stops it the way a restart should: the line of the stop, and exit 0', async () => {
    const p = run({ ...FULL_ENV, PORT: '0', HOST: '127.0.0.1', OPENROUTER_MODEL: '' });
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
