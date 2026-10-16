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
import { mediaTools } from '../src/media.ts';
import { RequestError, parseRequest } from '../src/request.ts';
import { SnippetsError } from '../src/result.ts';
import { runSnippets } from '../src/run.ts';
import type { RunDeps } from '../src/run.ts';
import { routedFetch, reply } from './fake-fetch.ts';
import { GOLDEN_REQUEST, GOLDEN_RESULT, GOLDEN_TRANSCRIPT, stubAsr, wavSlice } from './golden.ts';
import { MEDIA_TOOLS, makeMedia } from './support.ts';

const EMPTY: AsrTranscript = { language: 'en', language_probability: 0.5, duration: 0, segments: [] };
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
  test('less free space than a job needs is low_disk (503), and nothing is fetched', async () => {
    const { fetchImpl, calls } = routedFetch({});
    const refused = runSnippets(parseRequest(JSON.stringify({ source: { url: 'https://203.0.113.10/a.mp3' }, quotes: ['anything'] })), deps({ fetchImpl, freeBytes: async () => 268_435_455 }));
    await expect(refused).rejects.toMatchObject({ code: 'low_disk', status: 503 });
    expect(calls).toStrictEqual([]);
    expect(readdirSync(root)).toStrictEqual([]);
  });
});
