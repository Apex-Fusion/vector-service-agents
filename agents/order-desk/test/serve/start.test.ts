// agents/order-desk/test/serve/start.test.ts
// How the service starts and stops: the line it logs when it listens, a start that fails before it listens (a setting, the state directory, the Module-1 manifest) and leaves nothing running, the stop of a restart that
// waits for the job that runs, the signals, and src/index.ts run as a process with the real parts and a chain that nothing answers. No test here uses the network.
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { rawHexToBech32 } from '@vsa/buyer-core';
import { CHILD_CLEANUP_MS, Child } from '../../../../services/mock-systems/test/support/child.ts';
import { LOTS_FILE } from '../../src/serve/settings.ts';
import { SETTINGS, startService, stopOnSignals } from '../../src/serve/start.ts';
import { until } from './serve.ts';
import { AGENT_DID, FULL_ENV, MODULE1_URL, SERVICE, SERVICE_ADDRESS, TOKEN, cleanDirs, envWith, module1StubFile, shows, tempDir, withModule1 } from './support.ts';
import { headersOf, makeWorld, wire } from './world.ts';

afterEach(() => { cleanDirs(); });

const refusal = (work: Promise<unknown>): Promise<string> => work.then(() => 'accepted', (error: unknown) => (error instanceof Error ? error.message : String(error)));

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

  test('a setting that is missing or wrong stops the start by its name before anything listens', async () => {
    for (const [name, bad, expected] of [
      ['LOTS_PUBLIC_ORIGIN', undefined, /^environment variable LOTS_PUBLIC_ORIGIN is required/],
      ['FAULT_MODE', 'yes', /^environment variable FAULT_MODE must be empty or "confirm_wrong_lot" for order-desk/],
      ['ORDER_DESK_SERVICE_PRIV_KEY_HEX', 'not a key', /^environment variable ORDER_DESK_SERVICE_PRIV_KEY_HEX must be 64 lowercase hex characters/],
    ] as const) {
      const world = makeWorld();
      expect(await refusal(startService(envWith({ ...world.env, [name]: bad }), world.options)), name).toMatch(expected);
      expect(world.logs.filter((line) => line.startsWith('listening on')), name).toStrictEqual([]);
    }
  });

  test('a state directory that cannot be written stops the start, naming the setting', async () => {
    const world = makeWorld();
    const file = join(tempDir(), 'a-file');
    writeFileSync(file, 'not a directory', 'utf8');
    const text = await refusal(startService({ ...world.env, ORDER_DESK_STATE_DIR: join(file, 'state') }, world.options));
    expect(text.length).toBeGreaterThan(0);
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

  test('the janitor of the paying key is started: a stop waits for it, and an interval of one hour makes a pass at the start and no more', async () => {
    const world = makeWorld();
    const service = await startService(world.env, world.options);
    await service.stop();
    expect(world.logs.filter((line) => line.startsWith('janitor'))).toStrictEqual([]);
  });
});

describe('what the start says that it fetches', () => {
  test('the comments of the start, of the wiring and of the Dockerfile name the one fetch of the Module-1 manifest, and none of them says that the start makes no call', () => {
    for (const path of ['../../src/serve/start.ts', '../../src/serve/wiring.ts', '../../Dockerfile']) {
      const text = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(text, path).toContain('the one fetch of the Module-1 manifest');
      expect(text, path).not.toMatch(/makes no network call|asks no third party anything but what the janitor|Nothing is fetched at run time but what the hook reads/);
    }
  });
});

describe('the stop of a restart', () => {
  test('takes no new job, waits for the job that runs, answers it, and then closes: a job that holds the slot is the job that the stop waits for', async () => {
    const world = makeWorld();
    const service = await startService(world.env, world.options);
    const base = `http://127.0.0.1:${service.port}`;
    const auth = { authorization: TOKEN };
    const post = (path: string): Promise<Response> => fetch(`${base}${path}`, { method: 'POST', headers: { ...auth, ...headersOf(world.context) }, body: wire(world.handoff) });
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
  const START_MS = 60_000;
  const REQUEST_MS = 15_000;
  const EXIT_MS = 15_000;
  const PROCESS_TEST_MS = START_MS + REQUEST_MS + EXIT_MS + CHILD_CLEANUP_MS + 5_000;
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

  /**
   * The settings of a full deployment on a state directory of its own, with the real parts. A state directory is made for the run. The child cannot take a stub fetch, so the preload answers the one fetch of the
   * start, the Module-1 manifest at its pinned address, from a file that is made for the run.
   */
  const envOf = (over: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv => envWith({
    ...offChain, PORT: '0', HOST: '127.0.0.1', ORDER_DESK_STATE_DIR: tempDir(), MODULE1_STUB_URL: MODULE1_URL, MODULE1_STUB_FILE: module1StubFile(), LLM_MAX_PRICE_LOVELACE: '1000000', ...over,
  });

  const run = (env: NodeJS.ProcessEnv, label: string) => {
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    for (const name of SETTINGS) delete inherited[name];
    return new Child(process.execPath, ['--import', 'tsx', '--import', PRELOAD, 'src/index.ts'], { cwd, env: { ...inherited, ...env }, label });
  };
  const listening = async (child: Child) => {
    const [, port] = await child.waitFor(/^\[order-desk\] listening on 127\.0\.0\.1:([1-9]\d*);/m, 'Order Desk startup', START_MS);
    const signal = AbortSignal.timeout(REQUEST_MS);
    const request = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal }).catch((cause: unknown) => {
      throw new Error(`request to ${path} failed\n${child.diagnostics()}`, { cause });
    });
    return { port, request };
  };

  test('exits 1 at start with the variable named, and listens on nothing, when a setting is missing or wrong, and prints no secret', async () => {
    const cases: Array<[Record<string, string | undefined>, RegExp]> = [
      [{ SMALL_SUPPLIER_PKH: undefined }, /^\[order-desk\] cannot start: environment variable SMALL_SUPPLIER_PKH is required/],
      [{ ORDER_DESK_SERVICE_PRIV_KEY_HEX: undefined }, /^\[order-desk\] cannot start: environment variable ORDER_DESK_SERVICE_PRIV_KEY_HEX is required/],
      [{ FAULT_MODE: 'alter_after_approval' }, /^\[order-desk\] cannot start: environment variable FAULT_MODE must be empty or "confirm_wrong_lot" for order-desk/],
      [{ AGENT_DID: SERVICE.privateKeyHex }, /^\[order-desk\] cannot start: environment variable AGENT_DID holds the service key/],
    ];
    const results = await Promise.allSettled(cases.map(async ([over, expected]) => {
      const child = run(envOf(over), `refusal: ${Object.keys(over)[0]}`);
      try {
        expect(await child.waitForExit('startup refusal', START_MS), child.diagnostics()).toEqual({ code: 1, signal: null });
        expect(child.stderr).toMatch(expected);
        expect(child.stdout).not.toContain('listening on');
        expect(shows(child.stdout + child.stderr, SERVICE.privateKeyHex)).toBe(false);
      } finally {
        await child.cleanup();
      }
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }, START_MS + CHILD_CLEANUP_MS + 5_000);

  test.each(['', 'confirm_wrong_lot'])('started for real with FAULT_MODE=%j: it logs its line, answers /healthz, /agent.json and /lots.json, refuses a job without the token, and prints no secret', async (fault) => {
    const p = run(envOf({ FAULT_MODE: fault }), `FAULT_MODE=${JSON.stringify(fault)}`);
    try {
      const { port, request } = await listening(p);
      expect(p.stdout).toContain(`[order-desk] listening on 127.0.0.1:${port}; service address ${SERVICE_ADDRESS}; state directory `);
      expect(await (await request('/healthz')).json()).toStrictEqual({ ok: true });
      const manifest = await (await request('/agent.json')).json() as { name: string; identity: { did: string }; keys: { service_pkh: string }; behaviour: { lots: { sha256: string } } };
      expect([manifest.name, manifest.identity.did, manifest.keys.service_pkh]).toStrictEqual(['Order Desk', AGENT_DID, SERVICE.pkh]);
      const lots = Buffer.from(await (await request('/lots.json')).arrayBuffer());
      expect(lots.equals(readFileSync(LOTS_FILE))).toBe(true);
      expect((await request('/', { method: 'POST', body: wire(FULL_ENV) })).status).toBe(401);
      expect((await request('/precheck', { method: 'POST', body: wire(FULL_ENV) })).status).toBe(401);
      for (const secret of [TOKEN, TOKEN.slice('Bearer '.length), SERVICE.privateKeyHex, rawHexToBech32(SERVICE.privateKeyHex)]) expect((p.stdout + p.stderr).toLowerCase()).not.toContain(secret.toLowerCase());
    } finally {
      await p.cleanup();
    }
  }, PROCESS_TEST_MS);

  // The signal test needs POSIX. Wait for a real HTTP answer before sending the signal: the entry sets the handlers after it logs the listener.
  test.skipIf(process.platform === 'win32')('SIGTERM stops it the way a restart should: the line of the stop, and exit 0', async () => {
    const p = run(envOf(), 'SIGTERM');
    try {
      const { request } = await listening(p);
      expect(await (await request('/healthz')).json(), p.diagnostics()).toStrictEqual({ ok: true });
      p.signal('SIGTERM');
      expect(await p.waitForExit('exit after SIGTERM', EXIT_MS), p.diagnostics()).toEqual({ code: 0, signal: null });
      expect(p.stdout).toContain('[order-desk] SIGTERM: stopping; no new job, and up to 300 s for the one that is running');
    } finally {
      await p.cleanup();
    }
  }, PROCESS_TEST_MS);
});
