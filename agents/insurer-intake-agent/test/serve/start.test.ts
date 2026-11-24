// agents/insurer-intake-agent/test/serve/start.test.ts
// How the service starts and stops. The configuration that the environment gives (the defaults, the two secrets kept out of every other line and out of the manifest, the key hash that the operator wrote down, the
// fault switch that must be empty, the list of settings), the line that the start logs when it listens, a start that fails before it listens (a setting, the state directory, the Module-1 manifest) and leaves
// nothing running, the stop of a restart that waits for the job that runs, the signals, and src/index.ts run as a process with the real parts and a chain that nothing answers. No test here uses the network.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { VAULT_PAYER_IDENTITY_SETTINGS, rawHexToBech32 } from '@vsa/buyer-core';
import { AGENT_KINDS, FAULT_MODES } from '@vsa/usecase-kit/protocol';
import { manifestFromEnv } from '../../src/serve/manifest.ts';
import { CHECKS_READ_BUDGET_DEFAULT_MS, GATEWAY_DEFAULT, PORT_DEFAULT, STATE_DIR_DEFAULT } from '../../src/serve/settings.ts';
import { JANITOR_INTERVAL_MS, JANITOR_STOP_WAIT_MS, SETTINGS, loadConfig, startService, stopOnSignals } from '../../src/serve/start.ts';
import { until } from './serve.ts';
import {
  AGENT_DID, DEPLOYMENT_POLICY, KEY_VARIABLES, MODULE1_COMMIT, MODULE1_URL, SERVICE, SERVICE_ADDRESS, SUPPLIER, TOKEN, cleanDirs, message, module1ManifestText, module1StubFile, secretsOf, shows, startEnvWith, tempDir,
  withModule1,
} from './support.ts';
import { headersOf, makeWorld, wire } from './world.ts';

afterEach(() => { cleanDirs(); });

const refusal = (work: Promise<unknown>): Promise<string> => work.then(() => 'accepted', (error: unknown) => (error instanceof Error ? error.message : String(error)));
const KEY_VARIABLE = KEY_VARIABLES.service;
/** The pinned address of the tests with a branch in the place of the commit: an address that names no commit. */
const UNPINNED = MODULE1_URL.split(MODULE1_COMMIT).join('main');
const FAULT_REFUSAL = /^environment variable FAULT_MODE must be empty \(insurer-intake-agent has no fault value\) for insurer-intake-agent, and it has \d+ characters$/;

describe('loadConfig on a full environment', () => {
  test('gives the defaults for everything the operator leaves out, and the key material that the service key derives to', () => {
    const config = loadConfig(startEnvWith());
    expect([config.host, config.port, config.stateDir, config.checksBudgetMs]).toStrictEqual(['0.0.0.0', 9104, '/data', 1_200]);
    expect([PORT_DEFAULT, STATE_DIR_DEFAULT, CHECKS_READ_BUDGET_DEFAULT_MS]).toStrictEqual([9104, '/data', 1_200]);
    expect([config.service.pkh, config.service.address, config.service.publicKeyHex]).toStrictEqual([SERVICE.pkh, SERVICE_ADDRESS, SERVICE.pubKeyHex]);
    expect(SERVICE_ADDRESS.startsWith('addr1v')).toBe(true);
    expect(JSON.stringify(config.service)).not.toContain(SERVICE.privateKeyHex);
    expect(config.agentDid).toBe(AGENT_DID);
    expect(config.authHeader).toBe(TOKEN);
    expect(config.supplier).toStrictEqual({ pkh: SUPPLIER.pkh, pubKeyHex: SUPPLIER.pubKeyHex });
    expect(config.limits).toStrictEqual({ allowlist: ['deepseek/deepseek-v4-flash'], maxPriceLovelace: 1_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(config.dispute).toStrictEqual({ challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 600_000, read_timeout_ms: 20_000 });
    expect(config.mock).toStrictEqual({ publicBase: 'https://mock.example.test', mtlsBase: 'https://mock-mtls.example.test' });
    expect(config.endpoints.indexerUrl).toBeUndefined();
    expect(config.endpoints.gatewayUrl).toBe(GATEWAY_DEFAULT);
    expect(config.module1Manifest).toBe(MODULE1_URL);
    expect(config.identityDeployment.identity.hash).toBe(DEPLOYMENT_POLICY);
    expect(config.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('reads every optional setting: the listener, the state directory, the indexer, the budget of the hook, the lease and the deadline of the dispute code', () => {
    const config = loadConfig(startEnvWith({
      PORT: '9999', HOST: '127.0.0.2', INTAKE_STATE_DIR: '/var/lib/intake', VECTOR_MARKETPLACE_INDEXER_URL: 'https://indexer.example.test', CHECKS_READ_BUDGET_MS: '900', DISPUTE_STARTED_LEASE_MS: '60000',
      DISPUTE_RESOLUTION_DEADLINE_MS: '259200000',
    }));
    expect([config.host, config.port, config.stateDir, config.checksBudgetMs, config.endpoints.indexerUrl]).toStrictEqual(['127.0.0.2', 9999, '/var/lib/intake', 900, 'https://indexer.example.test']);
    expect(config.dispute).toStrictEqual({ challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 600_000, read_timeout_ms: 20_000, started_lease_ms: 60_000, resolution_deadline_ms: 259_200_000 });
  });

  test('the list of settings has each name once, holds the four identity names of the buyer code and the key and its key hash, and every setting that a source of the service reads is in it', () => {
    expect(new Set(SETTINGS).size).toBe(SETTINGS.length);
    for (const name of [...VAULT_PAYER_IDENTITY_SETTINGS, KEY_VARIABLE, 'INTAKE_SERVICE_PKH', 'SERVICE_AUTH_HEADER', 'FAULT_MODE', 'CHECKS_READ_BUDGET_MS', 'INTAKE_STATE_DIR']) expect(SETTINGS, name).toContain(name);
    // A setting that a source reads and that the list lacks escapes the search for the key and the token in every other line.
    const dir = fileURLToPath(new URL('../../src/serve/', import.meta.url));
    const read = new Set<string>();
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      for (const hit of readFileSync(join(dir, file), 'utf8').matchAll(/\benv\.([A-Z][A-Z0-9_]*)|(?:requiredEnv|envInt|hexOf)\('([A-Z][A-Z0-9_]*)'/g)) read.add(hit[1] ?? hit[2] ?? '');
    }
    expect(read.size).toBeGreaterThan(20);
    for (const name of read) expect(SETTINGS, name).toContain(name);
  });
});

describe('the service key and the token in the lines of other settings', () => {
  const lines = (secret: string): string[] => [secret, secret.toUpperCase(), `prefix-${secret}-suffix`, `did:vector:agent:${secret}`];

  test('the service key in any other setting is refused, naming that setting and not showing the key: raw, in another case, inside a longer value, and as bech32', () => {
    const key = SERVICE.privateKeyHex;
    for (const name of SETTINGS.filter((setting) => setting !== KEY_VARIABLE)) {
      for (const value of [...lines(key), rawHexToBech32(key)]) {
        const text = message(() => loadConfig(startEnvWith({ [name]: value })));
        expect(text, `${name} = ${value.slice(0, 12)}`).toBe(`environment variable ${name} holds the service key, which belongs in ${KEY_VARIABLE} alone: it would be printed or published. Take it out of ${name}`);
        expect(shows(text, key)).toBe(false);
      }
    }
  });

  test('the token in any other setting is refused, naming that setting and not showing it: whole or by its credential, in any case, inside a longer value', () => {
    const credential = TOKEN.slice('Bearer '.length);
    for (const name of SETTINGS.filter((setting) => setting !== 'SERVICE_AUTH_HEADER' && setting !== KEY_VARIABLE)) {
      for (const value of [TOKEN, credential.toUpperCase(), `x${credential}y`]) {
        const text = message(() => loadConfig(startEnvWith({ [name]: value })));
        expect(text, name).toBe(`environment variable ${name} holds the service token, which belongs in SERVICE_AUTH_HEADER alone: it would be printed or published. Take it out of ${name}`);
        expect(shows(text, credential)).toBe(false);
      }
    }
    // In the line of the key, the token is refused by the form of a key, which shows nothing either.
    expect(message(() => loadConfig(startEnvWith({ [KEY_VARIABLE]: TOKEN })))).toBe(`environment variable ${KEY_VARIABLE} must be 64 lowercase hex characters (a raw Ed25519 key)`);
  });

  test('a short value that is not a secret in a line is accepted: the search is for the whole key and the whole token', () => {
    expect(() => loadConfig(startEnvWith({ OPERATOR_CONTACT: `ops-${SERVICE.privateKeyHex.slice(0, 20)}@example.test` }))).not.toThrow();
    expect(() => loadConfig(startEnvWith({ OPERATOR_CONTACT: `ops-${TOKEN.slice(0, 12)}@example.test` }))).not.toThrow();
  });

  test('a key that is missing or is no key is refused by name, and shows nothing of what was written', () => {
    expect(message(() => loadConfig(startEnvWith({ [KEY_VARIABLE]: undefined })))).toMatch(new RegExp(`^environment variable ${KEY_VARIABLE} is required`));
    for (const bad of ['not a key', SERVICE.privateKeyHex.toUpperCase(), SERVICE.privateKeyHex.slice(2)]) {
      const text = message(() => loadConfig(startEnvWith({ [KEY_VARIABLE]: bad })));
      expect(text, bad.slice(0, 10)).toBe(`environment variable ${KEY_VARIABLE} must be 64 lowercase hex characters (a raw Ed25519 key)`);
    }
  });
});

describe('the key hash and the supplier key', () => {
  test('the key hash that the operator wrote down is taken in any case, and a wrong one is refused with its length and the hash of the key', () => {
    expect(loadConfig(startEnvWith({ INTAKE_SERVICE_PKH: SERVICE.pkh.toUpperCase() })).manifest).toStrictEqual(loadConfig(startEnvWith()).manifest);
    expect(loadConfig(startEnvWith({ INTAKE_SERVICE_PKH: undefined })).manifest).toStrictEqual(loadConfig(startEnvWith()).manifest);
    const text = message(() => loadConfig(startEnvWith({ INTAKE_SERVICE_PKH: SUPPLIER.pkh })));
    expect(text).toBe(`environment variable INTAKE_SERVICE_PKH (56 characters) is not the key hash of the key in ${KEY_VARIABLE} (the hash of that key is ${SERVICE.pkh}); correct the line or remove it`);
  });

  test('the service key is never the supplier key: the supplier key is the key of the runtime', () => {
    const asSupplier = { SUPPLIER_PKH: SERVICE.pkh, SUPPLIER_PUB_KEY_HEX: SERVICE.pubKeyHex };
    expect(message(() => loadConfig(startEnvWith(asSupplier)))).toBe(`environment variable ${KEY_VARIABLE} holds the key of SUPPLIER_PKH: the supplier key is the runtime's, and the service key must be a key of its own`);
    // The supplier key beside a service key of its own starts.
    expect(loadConfig(startEnvWith()).supplier.pkh).toBe(SUPPLIER.pkh);
  });

  test('a private key in the line of the public key is refused by the key hash that the line must give, and the message shows nothing of it', () => {
    const text = message(() => loadConfig(startEnvWith({ SUPPLIER_PUB_KEY_HEX: SUPPLIER.privateKeyHex })));
    expect(text).toMatch(/^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/);
    expect(shows(text, SUPPLIER.privateKeyHex)).toBe(false);
  });
});

describe('the manifest is looked at last', () => {
  test('for the service key in both its forms and in any case, and for the token: whatever puts either in a value that is published, the start stops, unprinted', () => {
    for (const leaked of [SERVICE.privateKeyHex, SERVICE.privateKeyHex.toUpperCase(), rawHexToBech32(SERVICE.privateKeyHex)]) {
      const text = message(() => loadConfig(startEnvWith(), (env) => ({ ...manifestFromEnv(env), description: `from somewhere else: ${leaked}` })));
      expect(text).toBe('the manifest would publish the service key: a value that goes into it holds the key, and the service does not start with it');
    }
    const token = message(() => loadConfig(startEnvWith(), (env) => ({ ...manifestFromEnv(env), description: `from somewhere else: ${TOKEN}` })));
    expect(token).toBe('the manifest would publish the service token: a value that goes into it holds the token of SERVICE_AUTH_HEADER, and the service does not start with it');
  });

  test('the builder of the manifest is given an environment with no secret in it, and the key hash that the key derives to', () => {
    let seen: NodeJS.ProcessEnv = {};
    loadConfig(startEnvWith(), (env) => { seen = env; return manifestFromEnv(env); });
    expect(Object.keys(seen)).not.toContain(KEY_VARIABLE);
    expect(Object.keys(seen)).not.toContain('SERVICE_AUTH_HEADER');
    expect(JSON.stringify(seen)).not.toContain(SERVICE.privateKeyHex);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
    expect([seen.INTAKE_SERVICE_PKH, seen.SUPPLIER_PKH, seen.AGENT_DID]).toStrictEqual([SERVICE.pkh, SUPPLIER.pkh, AGENT_DID]);
  });

  test('a manifest that the kit refuses stops the start with its code: a placeholder in a served value', () => {
    expect(message(() => loadConfig(startEnvWith({ OPERATOR_CONTACT: '<OPERATOR_CONTACT>' })))).toMatch(/^the manifest is refused \(manifest_has_placeholder\)/);
  });

  test('the builder is given the empty setting of the fault switch in the member FAULT_MODE and nothing else, and the bytes are the same for it every time', () => {
    const seen: string[] = [];
    const config = loadConfig(startEnvWith(), (env) => { seen.push(env.FAULT_MODE ?? '(none)'); return manifestFromEnv(env); });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toStrictEqual(new Set(['']));
    expect(config.manifest.text).toBe(loadConfig(startEnvWith()).manifest.text);
  });
});

describe('the fault switch', () => {
  test('is empty or not set: both start', () => {
    for (const env of [startEnvWith(), startEnvWith({ FAULT_MODE: '' })]) expect(() => loadConfig(env)).not.toThrow();
  });

  test('any other value stops the start, naming the setting and giving its length: the value of any kind of agent, and a value that no kind has', () => {
    const values = [...AGENT_KINDS.flatMap((kind) => [...FAULT_MODES[kind]]), 'yes', '0', ' ', 'alter_after_approval '];
    expect(values.length).toBeGreaterThan(3);
    for (const value of values) {
      const text = message(() => loadConfig(startEnvWith({ FAULT_MODE: value })));
      expect(text, JSON.stringify(value)).toMatch(FAULT_REFUSAL);
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
      for (const secret of secretsOf()) expect(world.logs.join('\n').toLowerCase()).not.toContain(secret.toLowerCase());
      expect((await fetch(`http://127.0.0.1:${service.port}/healthz`)).status).toBe(200);
      expect(existsSync(join(world.stateDir, 'requests.json'))).toBe(true);
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

  test('a setting that is missing or wrong stops the start by its name before anything listens', async () => {
    for (const [name, bad, expected] of [
      ['SUPPLIER_PKH', undefined, /^environment variable SUPPLIER_PKH is required/],
      [KEY_VARIABLE, undefined, new RegExp(`^environment variable ${KEY_VARIABLE} is required`)],
      [KEY_VARIABLE, 'not a key', new RegExp(`^environment variable ${KEY_VARIABLE} must be 64 lowercase hex characters`)],
      ['SERVICE_AUTH_HEADER', undefined, /^environment variable SERVICE_AUTH_HEADER is required/],
      ['MOCK_MTLS_BASE', undefined, /^environment variable MOCK_MTLS_BASE is required/],
      ['CHECKS_READ_BUDGET_MS', '1500', /^environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 1499/],
      ['LLM_MAX_SUPPLIER_BOND_LOVELACE', undefined, /^environment variable LLM_MAX_SUPPLIER_BOND_LOVELACE is required/],
    ] as const) {
      const world = makeWorld();
      expect(await refusal(startService({ ...world.env, [name]: bad }, world.options)), name).toMatch(expected);
      expect(world.logs.filter((line) => line.startsWith('listening on')), name).toStrictEqual([]);
    }
  });

  test('any FAULT_MODE value stops the start, and the empty setting starts it', async () => {
    for (const value of ['alter_after_approval', 'confirm_wrong_lot', 'invert_scores', 'yes', ' ']) {
      const world = makeWorld();
      expect(await refusal(startService({ ...world.env, FAULT_MODE: value }, world.options)), JSON.stringify(value)).toMatch(FAULT_REFUSAL);
      expect(world.logs.filter((line) => line.startsWith('listening on')), JSON.stringify(value)).toStrictEqual([]);
    }
    const world = makeWorld();
    const service = await startService({ ...world.env, FAULT_MODE: '' }, world.options);
    await service.stop();
  });

  test('an http VECTOR_OGMIOS_URL and an unpinned VECTOR_MODULE1_MANIFEST stop the start, and the pinned https address of the twin starts', async () => {
    const unpinned = UNPINNED;
    for (const [name, bad, expected] of [
      ['VECTOR_OGMIOS_URL', 'http://127.0.0.1:1337', /^environment variable VECTOR_OGMIOS_URL must be an https address/],
      ['VECTOR_MODULE1_MANIFEST', unpinned, /^environment variable VECTOR_MODULE1_MANIFEST must be pinned to a commit/],
      ['VECTOR_MODULE1_MANIFEST', 'http://203.0.113.9/modules/manifest.json', /^environment variable VECTOR_MODULE1_MANIFEST must be an https URL/],
    ] as const) {
      const world = makeWorld();
      expect(await refusal(startService({ ...world.env, [name]: bad }, world.options)), `${name} ${bad}`).toMatch(expected);
      expect(world.logs.filter((line) => line.startsWith('listening on'))).toStrictEqual([]);
    }
    const world = makeWorld();
    const service = await startService({ ...world.env, VECTOR_OGMIOS_URL: 'https://127.0.0.1:1337' }, world.options);
    await service.stop();
  });

  test('a Module-1 manifest of another identity registry than IDENTITY_POLICY_ID stops the start before the listener, and nothing keeps running', async () => {
    const world = makeWorld();
    const other = { ...world.options, fetchImpl: withModule1(world.options.fetchImpl!, module1ManifestText('ab'.repeat(28))), module1Port: undefined };
    expect(await refusal(startService(world.env, other))).toMatch(/^the Module-1 manifest names the identity registry (ab){28}, but the identity deployment of this service is [0-9a-f]{56}/);
    expect(world.logs.filter((line) => line.startsWith('listening on'))).toStrictEqual([]);
  });

  test('a state directory that cannot be written stops the start, naming the setting', async () => {
    const world = makeWorld();
    const file = join(tempDir(), 'a-file');
    writeFileSync(file, 'not a directory', 'utf8');
    const text = await refusal(startService({ ...world.env, INTAKE_STATE_DIR: join(file, 'state') }, world.options));
    expect(text).toMatch(/^environment variable INTAKE_STATE_DIR names /);
    expect(world.logs.filter((line) => line.startsWith('listening on'))).toStrictEqual([]);
  });

  test('a Module-1 manifest that cannot be fetched stops the start after the settings and before the listener, and nothing keeps running; the twin with the manifest at its address starts', async () => {
    const world = makeWorld();
    const missing = { ...world.options, fetchImpl: withModule1(world.options.fetchImpl!, { status: 404 }), module1Port: undefined };
    expect(await refusal(startService(world.env, missing))).toBe(`The Module-1 manifest (VECTOR_MODULE1_MANIFEST) ${MODULE1_URL} cannot be fetched: the host answered HTTP 404.`);
    expect(world.logs.filter((line) => line.startsWith('listening on'))).toStrictEqual([]);
    const service = await startService(world.env, { ...world.options, module1Port: undefined });
    try {
      expect(world.logs.filter((line) => line.startsWith('listening on'))).toHaveLength(1);
    } finally {
      await service.stop();
    }
  });

  test('the janitor of the paying key is started: a stop waits for it, and an interval of one hour makes no pass of its own that logs', async () => {
    const world = makeWorld();
    const service = await startService(world.env, world.options);
    await service.stop();
    expect([JANITOR_INTERVAL_MS, JANITOR_STOP_WAIT_MS]).toStrictEqual([60_000, 30_000]);
    expect(world.logs.filter((line) => line.includes('janitor'))).toStrictEqual([]);
  });
});

describe('the stop of a restart', () => {
  test('takes no new job, waits for the job that runs, answers it, and then closes: a job that holds the slot is the job that the stop waits for', async () => {
    const world = makeWorld();
    const service = await startService(world.env, world.options);
    const base = `http://127.0.0.1:${service.port}`;
    const post = (path: string): Promise<Response> => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: TOKEN, ...headersOf(world.context) }, body: wire(world.handoff) });
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
  /** The file that the child loads before the service: it answers the fetch of the Module-1 manifest from MODULE1_STUB_FILE and passes every other fetch on. */
  const PRELOAD = fileURLToPath(new URL('./module1-preload.mjs', import.meta.url));
  /** The chain, the gateway and the indexer at addresses that nothing answers. The node is an https address in the range for documentation: the start makes no call to it. */
  const OFF_CHAIN: Readonly<Record<string, string>> = {
    VECTOR_OGMIOS_URL: 'https://198.51.100.8:1337', VECTOR_KOIOS_URL: 'http://127.0.0.1:9', VECTOR_SUBMIT_URL: 'http://127.0.0.1:9', VECTOR_MARKETPLACE_INDEXER_URL: 'http://127.0.0.1:9',
    IDENTITY_GATEWAY_URL: 'https://127.0.0.1:9',
  };

  /**
   * The settings of a full deployment on a state directory of its own, with the real parts. The child cannot take a stub fetch, so the preload answers the one fetch of the start, the Module-1 manifest at its
   * pinned address, from a file that is made for the run.
   */
  const envOf = (over: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv => startEnvWith({
    ...OFF_CHAIN, PORT: '0', HOST: '127.0.0.1', INTAKE_STATE_DIR: tempDir(), MODULE1_STUB_URL: MODULE1_URL, MODULE1_STUB_FILE: module1StubFile(), ...over,
  });

  /** Starts src/index.ts on `env` over the environment the tests run in, less every setting that the service reads, so that nothing an operator has set can change what a test sees. */
  const run = (env: NodeJS.ProcessEnv) => {
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    for (const name of SETTINGS) delete inherited[name];
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', PRELOAD, 'src/index.ts'], { cwd, env: { ...inherited, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
      [{ SUPPLIER_PKH: undefined }, /^\[insurer-intake-agent\] cannot start: environment variable SUPPLIER_PKH is required/],
      [{ [KEY_VARIABLE]: undefined }, new RegExp(`^\\[insurer-intake-agent\\] cannot start: environment variable ${KEY_VARIABLE} is required`)],
      [{ FAULT_MODE: 'alter_after_approval' }, /^\[insurer-intake-agent\] cannot start: environment variable FAULT_MODE must be empty \(insurer-intake-agent has no fault value\)/],
      [{ AGENT_DID: SERVICE.privateKeyHex }, /^\[insurer-intake-agent\] cannot start: environment variable AGENT_DID holds the service key/],
      [{ VECTOR_OGMIOS_URL: 'http://198.51.100.8:1337' }, /^\[insurer-intake-agent\] cannot start: environment variable VECTOR_OGMIOS_URL must be an https address/],
      [{ VECTOR_MODULE1_MANIFEST: UNPINNED }, /^\[insurer-intake-agent\] cannot start: environment variable VECTOR_MODULE1_MANIFEST must be pinned to a commit/],
    ];
    const results = await Promise.all(cases.map(async ([over]) => { const p = run(envOf(over)); return { code: await p.exited, out: p.out(), err: p.err() }; }));
    cases.forEach(([, expected], index) => {
      const result = results[index]!;
      expect(result.code).toBe(1);
      expect(result.err).toMatch(expected);
      expect(result.out).not.toContain('listening on');
      for (const secret of secretsOf()) expect((result.out + result.err).toLowerCase()).not.toContain(secret.toLowerCase());
    });
  }, 90_000);

  test('started for real: it logs its line, answers /healthz and /agent.json, keeps its files on the state directory, refuses a job without the token, and prints no secret', async () => {
    const dir = tempDir();
    const p = run(envOf({ INTAKE_STATE_DIR: dir }));
    try {
      const base = await listening(p);
      expect(p.out()).toContain(`[insurer-intake-agent] listening on 127.0.0.1:${base.split(':')[2]}; service address ${SERVICE_ADDRESS}; state directory ${dir}`);
      expect(await (await fetch(`${base}/healthz`)).json()).toStrictEqual({ ok: true });
      const manifest = await (await fetch(`${base}/agent.json`)).json() as { name: string; identity: { did: string }; keys: { buyer_pkh: string } };
      expect([manifest.name, manifest.identity.did, manifest.keys.buyer_pkh]).toStrictEqual(['Insurer Intake Agent', AGENT_DID, SERVICE.pkh]);
      expect(existsSync(join(dir, 'requests.json'))).toBe(true);
      expect(existsSync(join(dir, 'keys', SERVICE.pkh))).toBe(true);
      expect((await fetch(`${base}/`, { method: 'POST', body: wire({}) })).status).toBe(401);
      expect((await fetch(`${base}/precheck`, { method: 'POST', body: wire({}) })).status).toBe(401);
      for (const secret of secretsOf()) expect((p.out() + p.err()).toLowerCase()).not.toContain(secret.toLowerCase());
    } finally {
      p.child.kill();
      await p.exited;
    }
  }, 90_000);

  // A signal reaches a handler only on POSIX (on Windows kill() ends the process at once), so CI on Linux runs this. The line "listening" does not show that the handlers of SIGTERM are on: the entry puts them on
  // in the same run of its event loop, a moment after that line. An answer of the server comes in a later run of the loop, so the test waits for one answer before it sends the signal.
  test.skipIf(process.platform === 'win32')('SIGTERM stops it the way a restart should: the line of the stop, and exit 0', async () => {
    const p = run(envOf());
    try {
      const base = await listening(p);
      expect(await (await fetch(`${base}/healthz`)).json(), p.err()).toStrictEqual({ ok: true });
      p.child.kill('SIGTERM');
      expect(await p.exited).toBe(0);
      expect(p.out()).toContain('[insurer-intake-agent] SIGTERM: stopping; no new job, and up to 300 s for the one that is running');
    } finally {
      p.child.kill();
      await p.exited;
    }
  }, 60_000);
});
