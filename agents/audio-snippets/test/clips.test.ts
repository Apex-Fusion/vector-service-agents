// agents/audio-snippets/test/clips.test.ts
// The clips (R-D6): the inline budget, the cut points as samples, the arguments of ffmpeg, and, with ffmpeg on PATH, clips cut from a decoded WAV: a WAV clip is
// the samples between its cut points, an MP3 clip is MPEG audio of its length. Under REQUIRE_ASR=1 (CI, and the implementers' machine) a missing tool fails.
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test, expect } from 'vitest';
import { INLINE_CLIPS_BYTES, MP3_BITRATE, cutArgs, cutClips, inlineBudget, sampleRange } from '../src/clips.ts';
import { decode, familyOf, mediaTools, probe } from '../src/media.ts';
import { SnippetsError } from '../src/result.ts';
import { wavSlice } from './golden.ts';
import { MEDIA_TOOLS, TONE_WAV, fixturePath } from './support.ts';

const match = (start_s: number, end_s: number) => ({ from: 'range' as const, start_s, end_s, text: '', score: 1 });

describe('the inline budget (Review Focus 5)', () => {
  const plan = (sizes: number[]) => { const budget = inlineBudget(); return { inline: sizes.map((size) => budget.take(size)), truncated: budget.truncated() }; };
  test('2 MB in all, and clips of exactly 2000000 bytes in all are all inline', () => {
    expect(INLINE_CLIPS_BYTES).toBe(2_000_000);
    expect(plan([1_000_000, 1_000_000])).toStrictEqual({ inline: [true, true], truncated: false });
    expect(plan([2_000_000])).toStrictEqual({ inline: [true], truncated: false });
    expect(plan([])).toStrictEqual({ inline: [], truncated: false });
  });
  test('the first clip that would cross the line and every one after it carry no bytes, even one that would fit, and the result says truncated', () => {
    expect(plan([1_000_000, 999_999, 2])).toStrictEqual({ inline: [true, true, false], truncated: true });
    expect(plan([1_500_000, 600_000, 10, 10])).toStrictEqual({ inline: [true, false, false, false], truncated: true });
    expect(plan([2_000_001, 1])).toStrictEqual({ inline: [false, false], truncated: true });
  });
});

describe('the cut', () => {
  test('the samples are the cut points times 16000, rounded, and a clip has at least one', () => {
    expect(sampleRange(1.3, 3)).toStrictEqual({ start: 20_800, end: 48_000 });
    expect(sampleRange(0.1, 1.3)).toStrictEqual({ start: 1_600, end: 20_800 });
    expect(sampleRange(0.0001, 0.0001)).toStrictEqual({ start: 2, end: 3 });
  });
  test('the arguments: the WAV of the job read as WAV only, the samples trimmed exactly, mono 16 kHz, MP3 at 64 kbps without tags or a Xing frame, or WAV, bit-exact', () => {
    expect(MP3_BITRATE).toBe('64k');
    expect(cutArgs('/job/audio.wav', '/job/clip-0.mp3', 1.3, 3, 'mp3')).toStrictEqual([
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-f', 'wav', '-i', '/job/audio.wav',
      '-af', 'atrim=start_sample=20800:end_sample=48000,asetpts=PTS-STARTPTS', '-ac', '1', '-ar', '16000',
      '-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '0', '-write_xing', '0', '-f', 'mp3', '-bitexact', '-map_metadata', '-1', '-y', '/job/clip-0.mp3',
    ]);
    expect(cutArgs('/job/audio.wav', '/job/clip-1.wav', 0.1, 1.3, 'wav').slice(10, 20)).toStrictEqual([
      '-af', 'atrim=start_sample=1600:end_sample=20800,asetpts=PTS-STARTPTS', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav',
    ]);
  });
  test('a clip cut past the time of the job is deadline, and a tool that fails is clip_failed; neither runs on', async () => {
    const tools = mediaTools({ run: async () => { throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'line one\nthe real reason\n' }); } });
    const now = 1_000;
    await expect(cutClips([match(0, 1)], 'audio.wav', tmpdir(), 'wav', { tools, clock: () => now, deadlineMs: now })).rejects.toMatchObject({ code: 'deadline', status: 422 });
    const failed = cutClips([match(0, 1)], 'audio.wav', tmpdir(), 'wav', { tools, clock: () => now, deadlineMs: now + 600_000 });
    await expect(failed).rejects.toBeInstanceOf(SnippetsError);
    await expect(failed).rejects.toMatchObject({ code: 'clip_failed', status: 500, message: 'ffmpeg could not cut clip 0 (the real reason)' });
    const late = mediaTools({ run: async () => { throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }); } });
    await expect(cutClips([match(0, 1)], 'audio.wav', tmpdir(), 'wav', { tools: late, clock: () => now, deadlineMs: now + 30_000 })).rejects.toMatchObject({ code: 'deadline' });
    await expect(cutClips([match(0, 1)], 'audio.wav', tmpdir(), 'wav', { tools: late, clock: () => now, deadlineMs: now + 600_000 })).rejects.toMatchObject({ code: 'clip_failed' });
    const missing = mediaTools({ run: async () => { throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }); } });
    await expect(cutClips([match(0, 1)], 'audio.wav', tmpdir(), 'wav', { tools: missing, clock: () => now, deadlineMs: now + 600_000 })).rejects.toThrow(/^ffmpeg could not be run \(ENOENT\): ffmpeg must be installed and on PATH$/);
  });
});

describe('with ffmpeg (needs it on PATH)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'snippets-clips-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const tools = mediaTools();
  const deps = () => ({ tools, clock: Date.now, deadlineMs: Date.now() + 600_000 });

  test.skipIf(!MEDIA_TOOLS)('a WAV clip is the samples of the decoded audio between its cut points, byte for byte, and each file is removed once read', async () => {
    const wav = await decode({ path: fixturePath('tone-3s.wav'), family: 'wav' }, dir, tools);
    const { clips, truncated } = await cutClips([match(1.3, 3), match(0.1, 1.3)], wav.path, dir, 'wav', deps());
    expect(truncated).toBe(false);
    const expected = [wavSlice(TONE_WAV, 20_800, 48_000), wavSlice(TONE_WAV, 1_600, 20_800)];
    clips.forEach((clip, i) => {
      const bytes = Buffer.from(clip.bytes_b64 ?? '', 'base64');
      expect(bytes.equals(Buffer.from(expected[i]))).toBe(true);
      expect(clip).toStrictEqual({ ...clip, format: 'wav', bytes: expected[i].length, sha256: createHash('sha256').update(expected[i]).digest('hex') });
    });
    expect(readdirSync(dir)).toStrictEqual(['audio.wav']);
  });

  test.skipIf(!MEDIA_TOOLS)('an MP3 clip is MPEG audio of its length, its sha256 and size are those of its bytes', async () => {
    const wav = await decode({ path: fixturePath('tone-3s.wav'), family: 'wav' }, dir, tools);
    const [clip] = (await cutClips([match(0.5, 2.5)], wav.path, dir, 'mp3', deps())).clips;
    const bytes = Buffer.from(clip.bytes_b64 ?? '', 'base64');
    expect([clip.start_s, clip.end_s, clip.format, clip.bytes, clip.sha256]).toStrictEqual([0.5, 2.5, 'mp3', bytes.length, createHash('sha256').update(bytes).digest('hex')]);
    expect(familyOf(bytes)).toBe('mp3');
    const back = join(dir, 'back.mp3');
    writeFileSync(back, bytes);
    const found = await probe({ path: back, family: 'mp3' }, tools);
    expect(found.hasAudio).toBe(true);
    expect(Math.abs((found.duration ?? 0) - 2)).toBeLessThan(0.1);
    expect(readFileSync(wav.path).length).toBe(96_044);
  });
});
