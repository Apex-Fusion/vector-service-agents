// agents/audio-snippets/test/media.test.ts
// The media of a job: the kind by its first bytes, the source fetched or decoded, then ffprobe and ffmpeg on it. The tests of the tools run where ffmpeg and
// ffprobe are on PATH, and under REQUIRE_ASR=1 (CI, the host, the implementers' machine) a missing tool fails instead of skipping them.
import { describe, test, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DURATION_SLACK_S, MAX_DURATION_S, MAX_SOURCE_BYTES, checkTools, decode, familyOf, loadSource, mediaTools, mimeOf, prepareMedia, probe, wavSamples } from '../src/media.ts';
import { RequestError } from '../src/request.ts';
import { reply, routedFetch } from './fake-fetch.ts';
import { MEDIA_TOOLS, REQUIRE_ASR, SPEECH_MP3, TONE_WAV, makeMedia, skipUntilSpeech, text, toBase64 } from './support.ts';

const URL_A = 'https://203.0.113.7/talk.mp3';
const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'snippets-media-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const bytes = (...v: Array<number | string>) => Uint8Array.from(v.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])));
async function refusal(p: Promise<unknown>): Promise<RequestError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(RequestError); return e as RequestError; }
  throw new Error('accepted');
}
const serving = (body: Uint8Array, headers: Record<string, string> = {}) => routedFetch({ [`GET ${URL_A}`]: () => reply(200, body, headers) });

describe('familyOf: the first bytes decide', () => {
  test.each([
    ['an ID3 tag', bytes('ID3', 4, 0), 'mp3'], ['an MPEG-1 layer III frame', bytes(0xff, 0xfb, 0x90), 'mp3'], ['an MPEG-2 layer III frame', bytes(0xff, 0xf3), 'mp3'],
    ['an MPEG-2.5 layer III frame', bytes(0xff, 0xe3), 'mp3'], ['an MPEG-1 layer II frame', bytes(0xff, 0xfd), 'mp3'], ['RIFF and WAVE', bytes('RIFF', 1, 2, 3, 4, 'WAVE'), 'wav'],
    ['OggS', bytes('OggS', 0), 'ogg'], ['fLaC', bytes('fLaC'), 'flac'], ['EBML', bytes(0x1a, 0x45, 0xdf, 0xa3), 'webm'], ['an ftyp box', bytes(0, 0, 0, 0x20, 'ftypisom'), 'mp4'],
    ['a QuickTime moov box first', bytes(0, 0, 1, 0, 'moov'), 'mp4'], ['the tone fixture', TONE_WAV, 'wav'],
  ])('%s', (_name, b, family) => { expect(familyOf(b)).toBe(family); });
  // The speech fixture was a row of the table above. Its file waits for approval (ruling R-D14), so this one test is skipped, with the reason, until it is made.
  test('the speech fixture', (ctx) => { skipUntilSpeech(ctx); expect(familyOf(SPEECH_MP3)).toBe('mp3'); });
  test.each([
    ['nothing', bytes()], ['RIFF of an AVI', bytes('RIFF', 1, 2, 3, 4, 'AVI ')], ['ADTS AAC', bytes(0xff, 0xf1, 0x50)], ['a reserved MPEG version', bytes(0xff, 0xeb)],
    ['a UTF-16 byte-order mark', bytes(0xff, 0xfe, 0x41, 0)], ['a JPEG', bytes(0xff, 0xd8, 0xff)], ['a PDF', bytes('%PDF-1.4')], ['text', text('All LibriVox recordings')], ['an ftyp too early', bytes(0, 0, 'ftyp')],
  ])('none: %s', (_name, b) => { expect(familyOf(b)).toBeNull(); });
});

describe('loadSource', () => {
  test('by URL: the bytes as served, their sha256, written to the directory of the job; a Content-Type of the allowlist must agree with the bytes, another claims nothing', async (ctx) => {
    skipUntilSpeech(ctx);
    const dir = tempDir();
    const media = await loadSource({ url: URL_A }, dir, { fetchImpl: serving(SPEECH_MP3, { 'content-type': 'audio/mpeg' }).fetchImpl });
    expect(media).toStrictEqual({ path: join(dir, 'source.mp3'), bytes: SPEECH_MP3.length, sha256: createHash('sha256').update(SPEECH_MP3).digest('hex'), family: 'mp3', claimed: 'audio/mpeg' });
    expect(new Uint8Array(readFileSync(media.path))).toStrictEqual(SPEECH_MP3);
    expect((await loadSource({ url: URL_A }, tempDir(), { fetchImpl: serving(SPEECH_MP3, { 'content-type': 'application/octet-stream' }).fetchImpl })).claimed).toBeNull();
    const mismatch = await refusal(loadSource({ url: URL_A }, tempDir(), { fetchImpl: serving(SPEECH_MP3, { 'content-type': 'audio/wav' }).fetchImpl }));
    expect([mismatch.code, mismatch.status, mismatch.message]).toStrictEqual(['source_mime_mismatch', 422, 'the source is MPEG audio but was served as audio/wav']);
  });
  test('inline: the bytes decoded, the declared type checked against them; bytes of no kind the service reads are source_unsupported', async () => {
    const media = await loadSource({ audio_b64: toBase64(TONE_WAV), mime: 'audio/x-wav' }, tempDir(), { fetchImpl: routedFetch({}).fetchImpl });
    expect([media.bytes, media.family, media.claimed]).toStrictEqual([96044, 'wav', 'audio/x-wav']);
    expect((await refusal(loadSource({ audio_b64: toBase64(TONE_WAV), mime: 'video/mp4' }, tempDir(), { fetchImpl: routedFetch({}).fetchImpl }))).message).toBe('the source is WAV but was declared as video/mp4');
    const unsupported = await refusal(loadSource({ audio_b64: toBase64(text('<html>not audio</html>')), mime: 'audio/mpeg' }, tempDir(), { fetchImpl: routedFetch({}).fetchImpl }));
    expect([unsupported.code, unsupported.message]).toStrictEqual(['source_unsupported', 'the source is not one of the audio or video types the service reads: MP3, WAV, Ogg, FLAC, WebM, MP4, M4A or QuickTime (the type is read from the first bytes of the file)']);
  });
  test('the cap of a fetched file is 50 MB, and the refusals of the fetch are the kit\'s, as RequestError', async () => {
    expect(MAX_SOURCE_BYTES).toBe(52_428_800);
    const over = await refusal(loadSource({ url: URL_A }, tempDir(), { fetchImpl: serving(new Uint8Array(1001)).fetchImpl, maxBytes: 1000 }));
    expect([over.code, over.status]).toStrictEqual(['source_too_large', 422]);
    const moved = await refusal(loadSource({ url: URL_A }, tempDir(), { fetchImpl: routedFetch({ [`GET ${URL_A}`]: () => reply(301, null, { location: 'https://203.0.113.9/b' }) }).fetchImpl }));
    expect([moved.code, moved.status]).toStrictEqual(['source_fetch_failed', 422]);
  });
});

describe('wavSamples and mimeOf', () => {
  test('the samples of a 16 kHz mono 16-bit WAV, from its data chunk, whatever chunks come before it', () => {
    expect(wavSamples(TONE_WAV.subarray(0, 64), TONE_WAV.length)).toBe(48_000);
    const head = Buffer.concat([Buffer.from(TONE_WAV.subarray(0, 36)), Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO'), Buffer.from(TONE_WAV.subarray(36, 44))]);
    expect(wavSamples(new Uint8Array(head), head.length + 96_000)).toBe(48_000);
    const stereo = Buffer.from(TONE_WAV.subarray(0, 44)); stereo.writeUInt16LE(2, 22);
    expect(() => wavSamples(new Uint8Array(stereo), 96_044)).toThrow('the decoded audio is not 16 kHz mono 16-bit PCM');
    expect(() => wavSamples(text('RIFF....AVI '), 100)).toThrow('the decoded audio is not a WAV file');
  });
  test('the type of the result: the claim when there was one, else the kind, as video when a video stream was found', () => {
    expect(mimeOf('mp4', 'audio/x-m4a', false)).toBe('audio/x-m4a');
    expect(mimeOf('mp4', null, true)).toBe('video/mp4');
    expect(mimeOf('mp4', null, false)).toBe('audio/mp4');
    expect(mimeOf('webm', null, false)).toBe('audio/webm');
    expect([mimeOf('mp3', null, true), mimeOf('wav', null, false), mimeOf('ogg', null, false), mimeOf('flac', null, false)]).toStrictEqual(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac']);
  });
});

// Each test here runs the real tools: 60 s each, against the 5 s vitest gives by default.
describe('with ffprobe and ffmpeg (needs them on PATH)', { timeout: 60_000 }, () => {
  const tools = mediaTools();
  test.skipIf(!REQUIRE_ASR)('REQUIRE_ASR is set: ffmpeg and ffprobe are installed', () => { expect(MEDIA_TOOLS).toBe(true); });

  test.skipIf(!MEDIA_TOOLS)('the tone: one audio stream of 3 s, decoded to 48000 samples in a WAV of 96044 bytes, the samples of the fixture itself', async () => {
    const dir = tempDir();
    const media = await loadSource({ audio_b64: toBase64(TONE_WAV), mime: 'audio/wav' }, dir, { fetchImpl: routedFetch({}).fetchImpl });
    expect(await probe(media, tools)).toStrictEqual({ hasAudio: true, hasVideo: false, duration: 3 });
    const wav = await decode(media, dir, tools);
    expect(wav).toStrictEqual({ path: join(dir, 'audio.wav'), samples: 48_000, duration_s: 3 });
    expect(new Uint8Array(readFileSync(wav.path))).toStrictEqual(TONE_WAV);
  });

  test.skipIf(!MEDIA_TOOLS)('the speech fixture: MPEG audio of about 25 s, mono 16 kHz once decoded', async (ctx) => {
    skipUntilSpeech(ctx);
    const prepared = await prepareMedia({ audio_b64: toBase64(SPEECH_MP3), mime: 'audio/mpeg' }, tempDir(), { fetchImpl: routedFetch({}).fetchImpl, tools });
    expect(prepared.source.mime).toBe('audio/mpeg');
    expect(prepared.source.duration_s).toBeGreaterThan(24.5);
    expect(prepared.source.duration_s).toBeLessThan(25.5);
    expect(prepared.samples).toBe(Math.round(prepared.source.duration_s * 16_000));
  });

  // Review Focus 1.
  test.skipIf(!MEDIA_TOOLS)('a video with no audio stream is media_no_audio after the probe, and nothing is decoded', async () => {
    const dir = tempDir();
    const video = makeMedia(dir, 'video.mp4', ['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=5:duration=2', '-c:v', 'mpeg4', '-an', '-f', 'mp4']);
    const job = tempDir();
    const e = await refusal(prepareMedia({ url: URL_A }, job, { fetchImpl: serving(new Uint8Array(readFileSync(video)), { 'content-type': 'video/mp4' }).fetchImpl, tools }));
    expect([e.code, e.status, e.message]).toStrictEqual(['media_no_audio', 422, 'the file has no audio stream: there is nothing to transcribe']);
    expect(existsSync(join(job, 'audio.wav'))).toBe(false);
  });

  // Review Focus 2.
  test.skipIf(!MEDIA_TOOLS)('the 600 s edge: WAVs of 600.0 and 600.4 s pass, one of 600.6 s is media_too_long before it is decoded, and an MP3 encoded from 600 s passes', async () => {
    expect([MAX_DURATION_S, DURATION_SLACK_S]).toStrictEqual([600, 0.5]);
    const dir = tempDir();
    const silence = (name: string, seconds: string, codec: string[], format: string) => makeMedia(dir, name, ['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', seconds, ...codec, '-f', format]);
    const run = (path: string) => prepareMedia({ url: URL_A }, tempDir(), { fetchImpl: serving(new Uint8Array(readFileSync(path))).fetchImpl, tools });
    expect((await run(silence('a.wav', '600', ['-c:a', 'pcm_s16le', '-bitexact'], 'wav'))).source.duration_s).toBe(600);
    expect((await run(silence('b.wav', '600.4', ['-c:a', 'pcm_s16le', '-bitexact'], 'wav'))).source.duration_s).toBe(600.4);
    const job = tempDir();
    const long = await refusal(prepareMedia({ url: URL_A }, job, { fetchImpl: serving(new Uint8Array(readFileSync(silence('c.wav', '600.6', ['-c:a', 'pcm_s16le', '-bitexact'], 'wav')))).fetchImpl, tools }));
    expect([long.code, long.status, long.message]).toStrictEqual(['media_too_long', 422, 'the media is longer than the 600 s (10 min) a job may have']);
    expect(existsSync(join(job, 'audio.wav'))).toBe(false);
    const mp3 = await run(silence('d.mp3', '600', ['-c:a', 'libmp3lame', '-b:a', '32k'], 'mp3'));
    expect(mp3.source.duration_s).toBeGreaterThanOrEqual(599.9);
    expect(mp3.source.duration_s).toBeLessThanOrEqual(600.5);
  });

  test.skipIf(!MEDIA_TOOLS)('a file the forced demuxer cannot read is media_unreadable: a RIFF WAVE header over junk, an ID3 tag over junk', async () => {
    for (const [name, body, mime] of [['wav', bytes('RIFF', 0x24, 0, 0, 0, 'WAVEjunkjunkjunk'), 'audio/wav'], ['mp3', bytes('ID3', 4, 0, 0, 0, 0, 0, 0, 'garbagegarbage'), 'audio/mpeg']] as const) {
      const e = await refusal(prepareMedia({ audio_b64: toBase64(body), mime }, tempDir(), { fetchImpl: routedFetch({}).fetchImpl, tools }));
      expect([e.code, e.status, e.message], name).toStrictEqual(['media_unreadable', 422, 'the media could not be read: it is damaged, or it is not the type its first bytes name']);
    }
  });

  test.skipIf(!MEDIA_TOOLS)('checkTools passes with both tools, and a tool that cannot be started is a plain Error that names it; a probe with it is the same', async () => {
    await checkTools(tools);
    const missing = mediaTools({ ffprobe: 'ffprobe-that-is-not-installed' });
    await expect(checkTools(missing)).rejects.toThrow(/^ffprobe-that-is-not-installed cannot be run \(ENOENT\): ffmpeg and ffprobe must be installed and on PATH/);
    const e = await probe({ path: 'x.wav', family: 'wav' }, missing).catch((err: unknown) => err);
    expect(e).not.toBeInstanceOf(RequestError);
    expect((e as Error).message).toMatch(/^ffprobe-that-is-not-installed could not be run \(ENOENT\)/);
  });
});
