// agents/audio-snippets/test/run.test.ts
// One job end to end, with the real ffmpeg and a stub speech model: the golden result, the language, the refusals and where they come, the free space, the
// 600 s edge (Review Focus 2) and the 2 MB of inline clips (Review Focus 5). The tests that need ffmpeg skip without it, and fail under REQUIRE_ASR=1.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, test, expect } from 'vitest';
import { AsrError } from '../src/asr.ts';
import type { AsrTranscript } from '../src/asr.ts';
import { JOB_DEADLINE_MS } from '../src/budget.ts';
import { freeBytes } from '../src/disk.ts';
import { mediaTools } from '../src/media.ts';
import { RequestError, parseRequest } from '../src/request.ts';
import { SnippetsError } from '../src/result.ts';
import { runSnippets } from '../src/run.ts';
import type { RunDeps } from '../src/run.ts';
import { routedFetch, reply } from './fake-fetch.ts';
import { GOLDEN_REQUEST, GOLDEN_RESULT, GOLDEN_TRANSCRIPT, stubAsr, wavSlice } from './golden.ts';
import { MEDIA_TOOLS, makeMedia } from './support.ts';

const EMPTY: AsrTranscript = { language: 'en', language_probability: 0.5, duration: 0, segments: [] };
async function until(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`gave up waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const request = (overrides: Record<string, unknown>) => parseRequest(JSON.stringify({ ...GOLDEN_REQUEST, ...overrides }));
let root: string;
let media: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'snippets-run-')); media = mkdtempSync(join(tmpdir(), 'snippets-media-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(media, { recursive: true, force: true }); });
const deps = (over: Partial<RunDeps> = {}): RunDeps => ({
  fetchImpl: routedFetch({}).fetchImpl, tools: mediaTools(), asr: stubAsr(GOLDEN_TRANSCRIPT), model: 'faster-whisper-base-int8',
  clock: Date.now, deadlineMs: Date.now() + JOB_DEADLINE_MS, scratchRoot: root, freeBytes: async () => 10 * 1024 ** 3, ...over,
});
/** A URL source served by a fake fetch from a file that ffmpeg made. */
const served = (path: string) => {
  const url = 'https://203.0.113.10/media.wav';
  const { fetchImpl, calls } = routedFetch({ [`GET ${url}`]: () => reply(200, new Uint8Array(readFileSync(path)), { 'content-type': 'audio/wav' }) });
  return { url, fetchImpl, calls };
};

describe('a job with ffmpeg and a stub speech model', () => {
  test.skipIf(!MEDIA_TOOLS)('the golden job: the result, every value of it; the model is asked once, in the language of the request, with 900 s; nothing is left on disk', async () => {
    const asr = stubAsr(GOLDEN_TRANSCRIPT);
    const result = await runSnippets(request({}), deps({ asr }));
    expect(result).toStrictEqual(GOLDEN_RESULT);
    // The runtime hashes JSON.stringify(result) into the receipt, so the body is held character for character, the order of every key with it.
    expect(JSON.stringify(result)).toBe(JSON.stringify(GOLDEN_RESULT));
    expect(asr.calls).toStrictEqual([{ language: 'en', timeoutMs: 900_000 }]);
    expect(readdirSync(root)).toStrictEqual([]);
  });

  test.skipIf(!MEDIA_TOOLS)('auto: the model detects the language and the result says which; a code asked for is passed through and reported as asked, whatever the model heard', async () => {
    const heardGerman = stubAsr({ ...GOLDEN_TRANSCRIPT, language: 'de' });
    expect((await runSnippets(request({ language: 'auto', return_clips: false, clip_format: undefined }), deps({ asr: heardGerman }))).language).toBe('de');
    expect(heardGerman.calls[0].language).toBeNull();
    const asked = stubAsr(GOLDEN_TRANSCRIPT);
    const result = await runSnippets(request({ language: 'de-AT', return_clips: false, clip_format: undefined }), deps({ asr: asked }));
    expect([result.language, asked.calls[0].language, result.clips, result.clips_truncated]).toStrictEqual(['de', 'de', [], false]);
  });

  test.skipIf(!MEDIA_TOOLS)('a range past the end of the media is range_out_of_media (422) before the model runs, and the directory is removed', async () => {
    const asr = stubAsr(GOLDEN_TRANSCRIPT);
    const refused = runSnippets(request({ ranges: [{ start_s: 1, end_s: 3.001 }] }), deps({ asr }));
    await expect(refused).rejects.toBeInstanceOf(RequestError);
    await expect(refused).rejects.toMatchObject({ code: 'range_out_of_media', status: 422, message: 'range 0 ends at 3.001 s, after the end of the media at 3 s' });
    expect(asr.calls).toStrictEqual([]);
    expect(readdirSync(root)).toStrictEqual([]);
    await expect(runSnippets(request({ ranges: [{ start_s: 2.5, end_s: 3 }] }), deps())).resolves.toMatchObject({ matches: expect.arrayContaining([{ from: 'range', start_s: 2.35, end_s: 3, text: 'public domain.', score: 1 }]) });
  });

  test.skipIf(!MEDIA_TOOLS)('too little time left for the model is deadline (422) and the model is not started; a model that runs out of its time is deadline too', async () => {
    const asr = stubAsr(GOLDEN_TRANSCRIPT);
    const now = Date.now();
    await expect(runSnippets(request({}), deps({ asr, clock: () => now, deadlineMs: now + 89_999 }))).rejects.toMatchObject({ code: 'deadline', status: 422 });
    expect(asr.calls).toStrictEqual([]);
    const fast = stubAsr(GOLDEN_TRANSCRIPT);
    await runSnippets(request({}), deps({ asr: fast, clock: () => now, deadlineMs: now + 90_000 }));
    expect(fast.calls[0].timeoutMs).toBe(30_000);
    const slow = stubAsr(async () => { throw new AsrError('timeout', 'the speech model did not finish within 900000 ms'); });
    const late = runSnippets(request({}), deps({ asr: slow }));
    await expect(late).rejects.toBeInstanceOf(SnippetsError);
    await expect(late).rejects.toMatchObject({ code: 'deadline', status: 422, message: 'the speech recognition did not finish within the 900 s the job had for it' });
    expect(readdirSync(root)).toStrictEqual([]);
  });

  test.skipIf(!MEDIA_TOOLS)('a model that fails is asr_failed (500), with what it said for the log', async () => {
    const broken = stubAsr(async () => { throw new AsrError('failed', 'the speech model failed (exit 3): model_load_failed: no model.bin'); });
    await expect(runSnippets(request({}), deps({ asr: broken }))).rejects.toMatchObject({ code: 'asr_failed', status: 500, message: 'the speech model failed (exit 3): model_load_failed: no model.bin' });
  });

  // Review Focus 2: the 600 s edge, end to end.
  test.skipIf(!MEDIA_TOOLS)('600 s of silence: 200 with an empty transcript, every quote and the query in unmatched with a best score of 0, a range at the very end matched', async () => {
    const silent = makeMedia(media, 'silence-600s.wav', ['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '600', '-c:a', 'pcm_s16le', '-bitexact', '-map_metadata', '-1', '-f', 'wav']);
    const { url, fetchImpl } = served(silent);
    const result = await runSnippets(parseRequest(JSON.stringify({
      source: { url }, quotes: ['all LibriVox recordings are in the public domain', 'This is a LibriVox recording.'], query: 'public domain', ranges: [{ start_s: 599.5, end_s: 600 }],
    })), deps({ fetchImpl, asr: stubAsr(EMPTY) }));
    expect(result.source).toStrictEqual({ sha256: createHash('sha256').update(readFileSync(silent)).digest('hex'), bytes: 19_200_044, mime: 'audio/wav', duration_s: 600 });
    expect([result.transcript, result.match_method, result.clips, result.clips_truncated]).toStrictEqual([[], 'keyword', [], false]);
    expect(result.matches).toStrictEqual([{ from: 'range', start_s: 599.35, end_s: 600, text: '', score: 1 }]);
    expect(result.unmatched).toStrictEqual([
      { from: 'quote', text: 'all LibriVox recordings are in the public domain', best_score: 0 }, { from: 'quote', text: 'This is a LibriVox recording.', best_score: 0 },
      { from: 'query', text: 'public domain', best_score: 0 },
    ]);
  }, 60_000);

  // Review Focus 5: two WAV clips of 1120044 bytes each cross the 2000000 bytes; the first is inline, the second carries its hash and size only. The media is
  // noise, so that the two halves differ and the hash of the second is of its own bytes.
  test.skipIf(!MEDIA_TOOLS)('clips over 2 MB in all: the first that fits carries its bytes, the one that would cross the line carries its sha256 and size only, and the result says truncated', async () => {
    const noise = makeMedia(media, 'noise-70s.wav', ['-f', 'lavfi', '-i', 'anoisesrc=d=70:c=white:r=16000:a=0.3:s=7', '-ac', '1', '-c:a', 'pcm_s16le', '-bitexact', '-map_metadata', '-1', '-f', 'wav']);
    const { url, fetchImpl } = served(noise);
    const result = await runSnippets(parseRequest(JSON.stringify({
      source: { url }, ranges: [{ start_s: 0.15, end_s: 34.85 }, { start_s: 35.15, end_s: 69.85 }], return_clips: true, clip_format: 'wav',
    })), deps({ fetchImpl, asr: stubAsr(EMPTY) }));
    const bytes = new Uint8Array(readFileSync(noise));
    const [first, second] = [wavSlice(bytes, 0, 560_000), wavSlice(bytes, 560_000, 1_120_000)];
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
    expect(result.matches.map((m) => [m.start_s, m.end_s])).toStrictEqual([[0, 35], [35, 70]]);
    expect(result.clips).toStrictEqual([
      { start_s: 0, end_s: 35, format: 'wav', sha256: sha(first), bytes: 1_120_044, bytes_b64: Buffer.from(first).toString('base64') },
      { start_s: 35, end_s: 70, format: 'wav', sha256: sha(second), bytes: 1_120_044 },
    ]);
    expect(result.clips_truncated).toBe(true);
    expect(Object.keys(result.clips[1])).toStrictEqual(['start_s', 'end_s', 'format', 'sha256', 'bytes']);
    expect(sha(first)).not.toBe(sha(second));
  }, 60_000);
});

describe('before anything is fetched', () => {
  test('less free space than a job needs is low_disk (503), and nothing is fetched or made; exactly 256 MiB is enough, and the job goes on to its fetch', async () => {
    const { fetchImpl, calls } = routedFetch({});
    const refused = runSnippets(parseRequest(JSON.stringify({ source: { url: 'https://203.0.113.10/a.mp3' }, quotes: ['anything'] })), deps({ fetchImpl, freeBytes: async () => 268_435_455 }));
    await expect(refused).rejects.toMatchObject({ code: 'low_disk', status: 503 });
    expect(calls).toStrictEqual([]);
    expect(readdirSync(root)).toStrictEqual([]);
    // The other side of the line: with 268435456 bytes free the job fetches its source, which this fetch answers with a 404.
    const enough = routedFetch({});
    const fetched = runSnippets(parseRequest(JSON.stringify({ source: { url: 'https://203.0.113.10/a.mp3' }, quotes: ['anything'] })), deps({ fetchImpl: enough.fetchImpl, freeBytes: async () => 268_435_456 }));
    await expect(fetched).rejects.toMatchObject({ code: 'source_fetch_failed', status: 422 });
    expect(enough.calls.map((call) => call.url)).toStrictEqual(['https://203.0.113.10/a.mp3']);
    expect(readdirSync(root)).toStrictEqual([]);
  });

  test('a free-space probe that rejects passes its own error on unchanged, a plain error with no code of a refusal; nothing is fetched and no directory is made', async () => {
    const { fetchImpl, calls } = routedFetch({});
    const job = (over: Partial<RunDeps>) => runSnippets(parseRequest(JSON.stringify({ source: { url: 'https://203.0.113.10/a.mp3' }, quotes: ['anything'] })), deps({ fetchImpl, ...over }));
    const broken = new Error('the free space could not be read');
    await expect(job({ freeBytes: async () => { throw broken; } })).rejects.toBe(broken);
    // The probe of the service itself, statfs, on a temporary directory that is not there.
    const missing = job({ scratchRoot: join(root, 'missing'), freeBytes: undefined });
    await expect(missing).rejects.not.toBeInstanceOf(SnippetsError);
    await expect(missing).rejects.toMatchObject({ code: 'ENOENT', syscall: 'statfs' });
    expect(calls).toStrictEqual([]);
    expect(readdirSync(root)).toStrictEqual([]);
  });
});

// Ruling R-D24: a job whose caller hangs up is stopped. The server aborts the signal of the job (abortOnClose); the job fails with aborted (499), which is never
// answered because the connection is gone, and its private directory is removed as after any failure.
describe('a job whose caller hangs up', () => {
  const ABORTED = { code: 'aborted', status: 499, message: 'the caller hung up, and the job was stopped' };

  test('while the source is fetched: the fetch is cut, the job fails with aborted, and nothing is left on disk', async () => {
    const url = 'https://203.0.113.10/a.mp3';
    const seen: Array<AbortSignal | undefined> = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      seen.push(init.signal ?? undefined);
      return new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener('abort', () => { reject(init.signal?.reason); }, { once: true }); });
    }) as typeof fetch;
    const controller = new AbortController();
    const job = runSnippets(parseRequest(JSON.stringify({ source: { url }, quotes: ['anything'] })), deps({ fetchImpl, signal: controller.signal }));
    job.catch(() => undefined);
    await until(() => seen.length === 1, 'the fetch has begun');
    controller.abort();
    await expect(job).rejects.toBeInstanceOf(SnippetsError);
    await expect(job).rejects.toMatchObject(ABORTED);
    expect(seen[0]?.aborted).toBe(true);
    expect(readdirSync(root)).toStrictEqual([]);
  });

  test.skipIf(!MEDIA_TOOLS)('while the model runs: the model is given the signal and stops, the job fails with aborted, and nothing is left on disk', async () => {
    const controller = new AbortController();
    const asked: Array<AbortSignal | undefined> = [];
    const stopping = stubAsr((_wav, _language, _timeoutMs, signal) => {
      asked.push(signal);
      controller.abort(); // the caller hangs up while the model runs
      return Promise.reject(new AsrError('aborted', 'the speech recognition was stopped: its caller hung up'));
    });
    const job = runSnippets(request({}), deps({ asr: stopping, signal: controller.signal }));
    await expect(job).rejects.toMatchObject(ABORTED);
    expect(asked).toStrictEqual([controller.signal]);
    expect(readdirSync(root)).toStrictEqual([]);
  });

  test.skipIf(!MEDIA_TOOLS)('after the model, before the clips: no clip is cut, the job fails with aborted, and nothing is left on disk', async () => {
    const controller = new AbortController();
    const done = stubAsr(async () => { controller.abort(); return structuredClone(GOLDEN_TRANSCRIPT); });
    const real = mediaTools();
    const cuts: string[][] = [];
    const tools: RunDeps['tools'] = { ...real, run: async (file, args, options) => { if (args.some((arg) => arg.startsWith('atrim='))) cuts.push([...args]); return real.run(file, args, options); } };
    await expect(runSnippets(request({}), deps({ asr: done, tools, signal: controller.signal }))).rejects.toMatchObject(ABORTED);
    expect(cuts).toStrictEqual([]);
    expect(readdirSync(root)).toStrictEqual([]);
  });

  test.skipIf(!MEDIA_TOOLS)('a signal that never aborts changes nothing: the golden job answers the golden result', async () => {
    expect(await runSnippets(request({}), deps({ signal: new AbortController().signal }))).toStrictEqual(GOLDEN_RESULT);
  });
});

describe('the free space', () => {
  test('the real probe reads a finite number of bytes above 0 on a directory that exists', async () => {
    const free = await freeBytes(root);
    expect(Number.isFinite(free)).toBe(true);
    expect(free).toBeGreaterThan(0);
  });
});

// What the tests above hold only in the parts, held here at the level of a job: the time checked again once the model and the matching are done, before the
// first clip is cut; the private directory removed after a failure past the model; the transcript clamped before the matching reads it; and the rest of
// Review Focus 2 (600.4 s, an MP3 encoded from 600 s, 600.6 s).
describe('a job after the model: the time, the failures, the clamp and the 600 s edge', () => {
  /** The tools of a job with every cut recorded; each cut fails, saying `cutFails`, when that is given. */
  const cutting = (cutFails?: string) => {
    const real = mediaTools();
    const cuts: string[][] = [];
    const tools: RunDeps['tools'] = {
      ...real,
      run: async (file, args, options) => {
        if (args.some((arg) => arg.startsWith('atrim='))) {
          cuts.push([...args]);
          if (cutFails !== undefined) throw Object.assign(new Error('exit 1'), { code: 1, stderr: `${cutFails}\n` });
        }
        return real.run(file, args, options);
      },
    };
    return { tools, cuts };
  };

  test.skipIf(!MEDIA_TOOLS)('the time runs out while the model or the matching runs: deadline (422) before the first clip is cut, and nothing is left on disk', async () => {
    let now = Date.now();
    const deadlineMs = now + JOB_DEADLINE_MS;
    const slow = stubAsr(async () => { now = deadlineMs; return structuredClone(GOLDEN_TRANSCRIPT); });
    const { tools, cuts } = cutting();
    await expect(runSnippets(request({}), deps({ asr: slow, tools, clock: () => now, deadlineMs }))).rejects.toMatchObject({ code: 'deadline', status: 422, message: 'the job ran out of its time after 0 of its 3 clips' });
    expect(slow.calls).toStrictEqual([{ language: 'en', timeoutMs: 900_000 }]);
    expect(cuts).toStrictEqual([]);
    expect(readdirSync(root)).toStrictEqual([]);
  });

  test.skipIf(!MEDIA_TOOLS)('a cut that fails is clip_failed (500), and a model that writes no transcript is asr_failed (500); neither leaves anything on disk', async () => {
    const { tools, cuts } = cutting('the cut broke');
    await expect(runSnippets(request({}), deps({ tools }))).rejects.toMatchObject({ code: 'clip_failed', status: 500, message: 'ffmpeg could not cut clip 0 (the cut broke)' });
    expect(cuts).toHaveLength(1);
    expect(readdirSync(root)).toStrictEqual([]);
    const garbled = stubAsr(async () => { throw new AsrError('bad_output', 'the speech model wrote something that is not JSON'); });
    await expect(runSnippets(request({}), deps({ asr: garbled }))).rejects.toMatchObject({ code: 'asr_failed', status: 500, message: 'the speech model wrote something that is not JSON' });
    expect(readdirSync(root)).toStrictEqual([]);
  });

  test.skipIf(!MEDIA_TOOLS)('a word the model times past the end of the media is clamped before the matching reads it: the transcript and the cut agree, inside the media', async () => {
    const past = stubAsr({ ...GOLDEN_TRANSCRIPT, segments: [...GOLDEN_TRANSCRIPT.segments, { start: 2.95, end: 3.4, text: 'Thanks.', words: [{ w: 'Thanks.', start: 3.1, end: 3.4 }] }] });
    const result = await runSnippets(request({ quotes: ['thanks'], query: undefined, ranges: undefined }), deps({ asr: past }));
    expect(result.transcript[2]).toStrictEqual({ start: 2.95, end: 3, text: 'Thanks.', words: [{ w: 'Thanks.', start: 3, end: 3 }] });
    expect(result.matches).toStrictEqual([{ from: 'quote', start_s: 2.85, end_s: 3, text: 'Thanks.', score: 1 }]);
    expect(result.clips.map((clip) => clip.bytes)).toStrictEqual([44 + 2 * 2_400]);
  });

  test.skipIf(!MEDIA_TOOLS)('the rest of the 600 s edge (Review Focus 2): 600.4 s and an MP3 encoded from 600 s answer, their ranges held to the duration of the decoded audio; 600.6 s is media_too_long (422) before the model runs, and nothing is left on disk', async () => {
    const silence = (name: string, seconds: string, codec: string[], format: string) => makeMedia(media, name, ['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', seconds, ...codec, '-f', format]);
    const url = 'https://203.0.113.10/media';
    const job = (path: string, type: string, ranges: Array<{ start_s: number; end_s: number }>, asr = stubAsr(EMPTY)) => runSnippets(
      parseRequest(JSON.stringify({ source: { url }, ranges })),
      deps({ fetchImpl: routedFetch({ [`GET ${url}`]: () => reply(200, new Uint8Array(readFileSync(path)), { 'content-type': type }) }).fetchImpl, asr }),
    );
    const longer = await job(silence('b.wav', '600.4', ['-c:a', 'pcm_s16le', '-bitexact'], 'wav'), 'audio/wav', [{ start_s: 600, end_s: 600.4 }]);
    expect([longer.source.duration_s, longer.matches]).toStrictEqual([600.4, [{ from: 'range', start_s: 599.85, end_s: 600.4, text: '', score: 1 }]]);
    const mp3 = await job(silence('d.mp3', '600', ['-c:a', 'libmp3lame', '-b:a', '32k'], 'mp3'), 'audio/mpeg', [{ start_s: 599, end_s: 599.5 }]);
    expect(mp3.source.duration_s).toBeGreaterThanOrEqual(599.9);
    expect(mp3.source.duration_s).toBeLessThanOrEqual(600.5);
    expect(mp3.matches).toStrictEqual([{ from: 'range', start_s: 598.85, end_s: 599.65, text: '', score: 1 }]);
    const asr = stubAsr(EMPTY);
    const refused = job(silence('c.wav', '600.6', ['-c:a', 'pcm_s16le', '-bitexact'], 'wav'), 'audio/wav', [{ start_s: 0, end_s: 1 }], asr);
    await expect(refused).rejects.toBeInstanceOf(RequestError);
    await expect(refused).rejects.toMatchObject({ code: 'media_too_long', status: 422, message: 'the media is longer than the 600 s (10 min) a job may have' });
    expect(asr.calls).toStrictEqual([]);
    expect(readdirSync(root)).toStrictEqual([]);
  }, 60_000);
});
