// agents/audio-snippets/test/start.test.ts
// How the service starts and stops: the environment read into a configuration, the probes of the tools and of the speech model before it listens, the token
// kept out of every other line and out of the manifest, the stop of the kit with this service's log, and src/index.ts run as a process.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test, expect } from 'vitest';
import { WORKER_PATH } from '../src/asr.ts';
import { mediaTools } from '../src/media.ts';
import { manifestFromEnv } from '../src/server.ts';
import { PORT_DEFAULT, SETTINGS, SHUTDOWN_WAIT_MS, loadConfig, startService, stopOnSignals } from '../src/start.ts';
import { GOLDEN_TRANSCRIPT, stubAsr } from './golden.ts';
import { FULL_ENV, SUPPLIER, TEST_AUTH, TEST_CONTACT, cleanDirs, tempDir, wire } from './server-support.ts';
import { ASR_PYTHON, MEDIA_TOOLS, PYTHON_READY, TONE_WAV, toBase64 } from './support.ts';

afterEach(() => { cleanDirs(); });
const message = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as Error).message; } throw new Error('it was accepted'); };

describe('loadConfig', () => {
  test('a full environment gives the defaults for everything the operator leaves out', () => {
    expect(loadConfig(FULL_ENV)).toStrictEqual({
      manifest: manifestFromEnv(FULL_ENV), authHeader: TEST_AUTH, host: '0.0.0.0', port: 9093,
      asr: { python: 'python3', worker: WORKER_PATH, modelDir: '/app/asr/models/base', threads: 4, computeType: 'int8' }, model: 'faster-whisper-base-int8',
    });
    expect(PORT_DEFAULT).toBe(9093);
  });

  test('every setting is read: the size of the model, its threads and its files, the Python and the worker, the port and the host', () => {
    const config = loadConfig({ ...FULL_ENV, WHISPER_MODEL: 'Small', WHISPER_THREADS: '8', ASR_PYTHON: '/app/asr/venv/bin/python3', ASR_WORKER: '/app/asr/worker.py', PORT: '9100', HOST: '127.0.0.1' });
    expect(config).toMatchObject({ host: '127.0.0.1', port: 9100, model: 'faster-whisper-small-int8', asr: { python: '/app/asr/venv/bin/python3', worker: '/app/asr/worker.py', modelDir: '/app/asr/models/small', threads: 8 } });
    expect(config.manifest.gaps[1]).toContain('faster-whisper small int8');
    expect(loadConfig({ ...FULL_ENV, WHISPER_MODEL_DIR: '/models/base' }).asr.modelDir).toBe('/models/base');
    expect(loadConfig({ ...FULL_ENV, WHISPER_MODEL: '', WHISPER_THREADS: '', ASR_PYTHON: '', ASR_WORKER: '', WHISPER_MODEL_DIR: '', PORT: '', HOST: '' })).toStrictEqual(loadConfig(FULL_ENV));
  });

  test('three settings are required, checked in this order, and the error names the variable', () => {
    const { OPERATOR_CONTACT, SUPPLIER_PKH, SERVICE_AUTH_HEADER, ...rest } = FULL_ENV;
    expect(message(() => loadConfig({ ...rest }))).toMatch(/^environment variable OPERATOR_CONTACT is required/);
    expect(message(() => loadConfig({ ...rest, OPERATOR_CONTACT }))).toMatch(/^environment variable SUPPLIER_PKH is required \(the key hash of the supplier key, published in the manifest\) and is not set$/);
    expect(message(() => loadConfig({ ...rest, OPERATOR_CONTACT, SUPPLIER_PKH, SERVICE_AUTH_HEADER: ' ' }))).toMatch(/^environment variable SERVICE_AUTH_HEADER is required \(the value the template runtime sends as the authorization header of every call, which POST \/ requires\) and is not set$/);
    expect(loadConfig({ ...rest, OPERATOR_CONTACT, SUPPLIER_PKH, SERVICE_AUTH_HEADER }).authHeader).toBe(TEST_AUTH);
  });

  test('WHISPER_MODEL is base or small, WHISPER_THREADS a whole number from 1 to 64, and the error names the variable', () => {
    expect(message(() => loadConfig({ ...FULL_ENV, WHISPER_MODEL: 'large-v3' }))).toBe('environment variable WHISPER_MODEL must be one of base, small, got "large-v3"');
    for (const bad of ['0', '65']) expect(message(() => loadConfig({ ...FULL_ENV, WHISPER_THREADS: bad }))).toBe(`environment variable WHISPER_THREADS must be a whole number from 1 to 64, got ${bad}`);
    expect(message(() => loadConfig({ ...FULL_ENV, WHISPER_THREADS: 'four' }))).toMatch(/^environment variable WHISPER_THREADS must be a non-negative integer/);
    expect(loadConfig({ ...FULL_ENV, WHISPER_THREADS: '64' }).asr.threads).toBe(64);
  });

  test('the supplier key hash is 56 hex characters, published in lower case; a public key, when given, must be the key of that hash', () => {
    expect(loadConfig({ ...FULL_ENV, SUPPLIER_PKH: SUPPLIER.pkh.toUpperCase(), SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex.toUpperCase() }).manifest.keys).toStrictEqual({ supplier_pkh: SUPPLIER.pkh, pub_key_hex: SUPPLIER.pubKeyHex });
    expect(message(() => loadConfig({ ...FULL_ENV, SUPPLIER_PKH: 'ab'.repeat(27) }))).toBe('environment variable SUPPLIER_PKH must be 56 hex characters, and it has 54 characters');
    expect(message(() => loadConfig({ ...FULL_ENV, SUPPLIER_PUB_KEY_HEX: 'cd'.repeat(32) }))).toMatch(/^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH/);
    expect(loadConfig({ ...FULL_ENV, SUPPLIER_PUB_KEY_HEX: '' }).manifest.keys.pub_key_hex).toBe('');
  });

  describe('the service token', () => {
    test('a token of the form the runbook makes is accepted; one that is not printable ASCII is refused with its length only', () => {
      expect(loadConfig(FULL_ENV).authHeader).toHaveLength(71);
      const text = message(() => loadConfig({ ...FULL_ENV, SERVICE_AUTH_HEADER: `Bearer ${'ab'.repeat(30)}\u{e9}` }));
      expect(text).toBe('environment variable SERVICE_AUTH_HEADER must be printable ASCII (it is sent as an HTTP header), and it has 68 characters');
    });
    test('the token in any other setting is refused, naming that setting and not showing it: whole or its credential, in any case, inside a longer value', () => {
      const credential = TEST_AUTH.slice('Bearer '.length);
      for (const name of SETTINGS.filter((n) => n !== 'SERVICE_AUTH_HEADER')) {
        for (const value of [TEST_AUTH, credential.toUpperCase(), `x${credential}y`]) {
          const text = message(() => loadConfig({ ...FULL_ENV, [name]: value }));
          expect(text, name).toBe(`environment variable ${name} holds the service token, which belongs in SERVICE_AUTH_HEADER alone: it would be printed or published. Take it out of ${name}`);
          expect(text).not.toContain(credential.slice(0, 16));
        }
      }
    });
    test('the manifest is looked at last: one that would publish the token stops the start', () => {
      const leaky = (env: NodeJS.ProcessEnv) => ({ ...manifestFromEnv(env), description: `see ${TEST_AUTH}` });
      expect(message(() => loadConfig(FULL_ENV, leaky))).toBe('the manifest would publish the service token: a value that goes into it holds the token of SERVICE_AUTH_HEADER, and the service does not start with it');
    });
    test('SETTINGS are the names the service reads, the token among them, each once', () => {
      expect(SETTINGS).toHaveLength(18);
      expect(new Set(SETTINGS).size).toBe(SETTINGS.length);
      for (const name of ['OPERATOR_CONTACT', 'SUPPLIER_PKH', 'SERVICE_AUTH_HEADER', 'WHISPER_MODEL', 'WHISPER_THREADS', 'WHISPER_MODEL_DIR', 'ASR_PYTHON', 'ASR_WORKER', 'PORT', 'HOST']) expect(SETTINGS).toContain(name);
    });
  });
});

describe('startService', () => {
  const logs: string[] = [];
  const log = (line: string): void => { logs.push(line); };
  afterEach(() => { logs.length = 0; });
  const env = { ...FULL_ENV, PORT: '0', HOST: '127.0.0.1' };
  const asked: string[] = [];
  const fakeTools = (missing?: string) => mediaTools({
    run: async (file) => {
      asked.push(file);
      if (file === missing) throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
      return { stdout: `${file} version 8.1.1`, stderr: '' };
    },
  });
  afterEach(() => { asked.length = 0; });

  test('asks ffprobe, ffmpeg and the speech model before it listens, then listens, serves the manifest and logs its model, never the token', async () => {
    const service = await startService(env, { tools: fakeTools(), asr: stubAsr(GOLDEN_TRANSCRIPT), log, scratchRoot: tempDir() });
    try {
      expect(asked).toStrictEqual(['ffprobe', 'ffmpeg']);
      const base = `http://127.0.0.1:${service.port}`;
      expect(await (await fetch(`${base}/agent.json`)).text()).toBe(JSON.stringify(manifestFromEnv(env)));
      expect((await fetch(`${base}/`, { method: 'POST', body: wire({ source: { url: 'https://example.org/a.mp3' }, quotes: ['x'] }) })).status).toBe(401);
      expect(logs).toContain(`listening on 127.0.0.1:${service.port}; speech model faster-whisper-base-int8 (faster-whisper 1.2.1, ctranslate2 4.8.2, 4 threads)`);
      expect(logs.join('\n')).not.toContain(TEST_AUTH.slice(-16));
    } finally {
      await service.stop();
      await service.stop();
    }
  });

  test('a tool that cannot be run, or a speech model that is not ready, stops the start before it listens', async () => {
    await expect(startService(env, { tools: fakeTools('ffmpeg'), asr: stubAsr(GOLDEN_TRANSCRIPT), log })).rejects.toThrow(/^ffmpeg cannot be run \(ENOENT\): ffmpeg and ffprobe must be installed and on PATH/);
    const notReady = { ...stubAsr(GOLDEN_TRANSCRIPT), check: async () => { throw new Error('the speech model is not ready (model_missing: the model directory lacks model.bin)'); } };
    await expect(startService(env, { tools: fakeTools(), asr: notReady, log })).rejects.toThrow(/^the speech model is not ready/);
    expect(logs.filter((l) => l.startsWith('listening on'))).toStrictEqual([]);
  });

  test('a start without the token is refused before anything is asked', async () => {
    const { SERVICE_AUTH_HEADER: _token, ...withoutToken } = env;
    await expect(startService(withoutToken, { tools: fakeTools(), asr: stubAsr(GOLDEN_TRANSCRIPT), log })).rejects.toThrow(/^environment variable SERVICE_AUTH_HEADER is required/);
    expect(asked).toStrictEqual([]);
  });

  test('a shutdown with no job running finishes at once and closes the port; the wait is 300 s by default', async () => {
    const service = await startService(env, { tools: fakeTools(), asr: stubAsr(GOLDEN_TRANSCRIPT), log, scratchRoot: tempDir() });
    await expect(service.shutdown()).resolves.toBe('finished');
    await expect(fetch(`http://127.0.0.1:${service.port}/healthz`)).rejects.toThrow();
    expect(SHUTDOWN_WAIT_MS).toBe(300_000);
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
    const { OPERATOR_CONTACT: _contact, ...withoutContact } = FULL_ENV;
    const p = run({ ...withoutContact, OPERATOR_CONTACT: '', PORT: '0', HOST: '127.0.0.1' });
    expect(await p.exited).toBe(1);
    expect(p.err()).toMatch(/^\[audio-snippets\] cannot start: environment variable OPERATOR_CONTACT is required/);
    expect(p.out()).not.toContain('listening on');
  }, 30_000);

  test.skipIf(!(PYTHON_READY && MEDIA_TOOLS))('started for real with a stand-in of the worker: it listens, answers /healthz and /agent.json, and answers a job on the tone', async () => {
    const p = run({
      ...FULL_ENV, PORT: '0', HOST: '127.0.0.1', ASR_PYTHON, ASR_WORKER: fileURLToPath(new URL('./fixtures/stand-in-asr.py', import.meta.url)), WHISPER_MODEL_DIR: tempDir(),
    });
    try {
      const end = Date.now() + 30_000;
      while (!/listening on 127\.0\.0\.1:\d+/.test(p.out()) && Date.now() < end && p.child.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 50));
      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(p.out())?.[1];
      expect(port, p.err()).toBeDefined();
      expect(p.out()).toContain('speech model faster-whisper-base-int8 (faster-whisper 1.2.1, ctranslate2 4.8.2, 4 threads)');
      const base = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${base}/healthz`)).json()).toStrictEqual({ ok: true });
      expect((await (await fetch(`${base}/agent.json`)).json()).status).toStrictEqual({ chip: 'proposed', since: '2026-10-13' });
      const r = await fetch(`${base}/`, { method: 'POST', headers: { authorization: TEST_AUTH }, body: wire({ source: { audio_b64: toBase64(TONE_WAV), mime: 'audio/wav' }, quotes: ['all LibriVox recordings are in the public domain'] }) });
      const result = await r.json();
      expect([r.status, result.source.duration_s, result.language, result.transcript, result.unmatched]).toStrictEqual([200, 3, 'en', [], [{ from: 'quote', text: 'all LibriVox recordings are in the public domain', best_score: 0 }]]);
      expect(TEST_CONTACT).toBe('ops@example.test');
    } finally {
      p.child.kill();
      await p.exited;
    }
  }, 60_000);
});
