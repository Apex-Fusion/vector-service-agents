// agents/audio-snippets/test/asr.test.ts
// The bridge to the worker, against a stand-in worker that node runs (test/fixtures/stand-in-worker.mjs): the request it is sent, the answer it reads, the
// time limit, the output limit, and what a failure says. The real worker and model are test/asr-real.test.ts.
import { describe, test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AsrError, STDOUT_LIMIT, WORKER_PATH, parseTranscript, workerAsr } from '../src/asr.ts';
import type { AsrSettings } from '../src/asr.ts';

const STAND_IN = fileURLToPath(new URL('./fixtures/stand-in-worker.mjs', import.meta.url));
const settings = (over: Partial<AsrSettings> = {}): AsrSettings => ({ python: process.execPath, pythonArgs: [], worker: STAND_IN, modelDir: '/app/asr/models/base', threads: 4, computeType: 'int8', ...over });
async function failure(p: Promise<unknown>): Promise<AsrError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(AsrError); return e as AsrError; }
  throw new Error('the recognition did not fail');
}

describe('workerAsr', () => {
  test('sends the request of the contract and reads the transcript back', async () => {
    const t = await workerAsr(settings()).transcribe('/tmp/job/echo.wav', null, 10_000);
    expect(JSON.parse(t.segments[0].text)).toStrictEqual({ wav: '/tmp/job/echo.wav', language: null, model_dir: '/app/asr/models/base', threads: 4, compute_type: 'int8' });
    expect(await workerAsr(settings()).transcribe('/tmp/job/ok.wav', 'de', 10_000)).toStrictEqual({
      language: 'de', language_probability: 0.97, duration: 3, segments: [{ start: 0, end: 1.2, text: 'This is a LibriVox recording.', words: [{ w: 'This', start: 0.1, end: 0.25 }] }],
    });
  });
  test('the service starts the worker as <python> -I <worker>, with an argument list', async () => {
    const seen: string[][] = [];
    const spawnImpl = ((file: string, args: readonly string[], opts: object) => { seen.push([file, ...args]); return spawn(process.execPath, [STAND_IN, ...args.slice(2)], opts); }) as unknown as typeof spawn;
    await workerAsr({ python: 'python3', worker: WORKER_PATH, modelDir: '/m', threads: 2, computeType: 'int8' }, { spawnImpl }).transcribe('/tmp/ok.wav', 'en', 10_000);
    expect(seen).toStrictEqual([['python3', '-I', WORKER_PATH]]);
    expect(WORKER_PATH.replace(/\\/g, '/')).toMatch(/agents\/audio-snippets\/asr\/worker\.py$/);
  });
  test('the worker is started without the secrets of the service: its environment lacks the token and every name that holds a key, a token, a secret, a password, an API key or an access key, and has the rest', async () => {
    const token = `Bearer ${'ef'.repeat(32)}`;
    const set: Record<string, string> = {
      SERVICE_AUTH_HEADER: token, ASR_TEST_PRIV_KEY_HEX: 'a key', ASR_TEST_TOKEN: 'a token', ASR_TEST_SECRET: 'a secret', ASR_TEST_PASSWORD: 'a password',
      ASR_TEST_API_KEY: 'an api key', ASR_TEST_ACCESS_KEY: 'an access key', ASR_TEST_KEPT: 'kept',
    };
    const saved = Object.fromEntries(Object.keys(set).map((name) => [name, process.env[name]]));
    Object.assign(process.env, set);
    try {
      // In place of the worker, a child that answers its own environment as the text of a segment.
      const printEnv = "process.stdout.write(JSON.stringify({ ok: true, language: 'en', language_probability: 1, duration: 0, segments: [{ start: 0, end: 0, text: JSON.stringify(process.env), words: [] }] }))";
      const spawnImpl = ((_file: string, _args: readonly string[], opts: object) => spawn(process.execPath, ['-e', printEnv], opts)) as unknown as typeof spawn;
      const transcript = await workerAsr(settings(), { spawnImpl }).transcribe('/tmp/job/ok.wav', 'en', 10_000);
      const seen = JSON.parse(transcript.segments[0].text) as Record<string, string>;
      const names = Object.keys(seen).map((name) => name.toUpperCase());
      expect(names.filter((name) => name === 'SERVICE_AUTH_HEADER' || /PRIV_KEY|TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY/.test(name))).toStrictEqual([]);
      expect(transcript.segments[0].text).not.toContain('ef'.repeat(32));
      expect([seen.ASR_TEST_KEPT, names.includes('PATH')]).toStrictEqual(['kept', true]);
    } finally {
      for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });
  test('a worker that runs out of time is killed: reason timeout', async () => {
    const began = Date.now();
    const e = await failure(workerAsr(settings()).transcribe('/tmp/slow.wav', 'en', 200));
    expect([e.reason, e.message]).toStrictEqual(['timeout', 'the speech model did not finish within 200 ms']);
    expect(Date.now() - began).toBeLessThan(5000);
  });
  test('a worker that fails says why: its error and message, flat, or the last line it wrote on stderr', async () => {
    expect(await failure(workerAsr(settings()).transcribe('/tmp/fails.wav', 'en', 10_000))).toMatchObject({ reason: 'failed', message: 'the speech model failed (exit 4): transcribe_failed: the decoder broke' });
    expect(await failure(workerAsr(settings()).transcribe('/tmp/crashes.wav', 'en', 10_000))).toMatchObject({ reason: 'failed', message: 'the speech model failed (exit 1): RuntimeError: out of memory' });
    expect(await failure(workerAsr(settings({ python: 'a-python-that-is-not-installed' })).transcribe('/tmp/ok.wav', 'en', 10_000))).toMatchObject({ reason: 'failed' });
  });
  test('what is no transcript of the contract is bad_output, and so is more than STDOUT_LIMIT bytes', async () => {
    expect((await failure(workerAsr(settings()).transcribe('/tmp/garbage.wav', 'en', 10_000))).reason).toBe('bad_output');
    expect((await failure(workerAsr(settings()).transcribe('/tmp/shape.wav', 'en', 10_000))).message).toBe('the speech model wrote a transcript with segment 0 of the wrong shape');
    expect(STDOUT_LIMIT).toBe(16 * 1024 * 1024);
    expect(await failure(workerAsr(settings()).transcribe('/tmp/flood.wav', 'en', 20_000))).toMatchObject({ reason: 'bad_output', message: `the speech model wrote more than ${STDOUT_LIMIT} bytes` });
  });
  test('stderr goes to the log flat, at most 300 characters a line and 20 lines a job', async () => {
    const lines: string[] = [];
    await workerAsr(settings(), { log: (l) => { lines.push(l); } }).transcribe('/tmp/chatty.wav', 'en', 10_000);
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('asr: warning 0 [31m');
    expect(lines.every((l) => !/[\u0000-\u001f]/.test(l))).toBe(true);
  });
  test('check answers the versions, and a model that is not there or a Python that cannot be run stops it with the reason', async () => {
    expect(await workerAsr(settings()).check()).toStrictEqual({ faster_whisper: 'stand-in', ctranslate2: 'stand-in' });
    await expect(workerAsr(settings({ modelDir: '/models/missing' })).check()).rejects.toThrow(/^the speech model is not ready \(model_missing: the model directory lacks model\.bin\)/);
    await expect(workerAsr(settings({ python: 'a-python-that-is-not-installed' })).check()).rejects.toThrow(/^a-python-that-is-not-installed cannot be run/);
  });
});

describe('parseTranscript', () => {
  const T = { ok: true, language: 'en', language_probability: 0.9, duration: 2, segments: [{ start: 0, end: 1, text: 'hi', words: [{ w: 'hi', start: 0, end: 0.5 }] }] };
  test('takes the transcript of the contract and leaves the rest out', () => {
    expect(parseTranscript(JSON.stringify({ ...T, extra: 1 }))).toStrictEqual({ language: 'en', language_probability: 0.9, duration: 2, segments: T.segments });
  });
  test.each([
    ['ok false', { ...T, ok: false }], ['a language that is no code', { ...T, language: 'English' }], ['no segments', { ...T, segments: 'x' }],
    ['a segment with a text that is no text', { ...T, segments: [{ start: 0, end: 1, text: 7, words: [] }] }], ['an empty word', { ...T, segments: [{ start: 0, end: 1, text: '', words: [{ w: '', start: 0, end: 1 }] }] }],
    ['a time that is no number', { ...T, segments: [{ start: 0, end: 1, text: '', words: [{ w: 'a', start: '0', end: 1 }] }] }],
  ])('refuses %s', (_name, value) => { expect(() => parseTranscript(JSON.stringify(value))).toThrow(AsrError); });
});
