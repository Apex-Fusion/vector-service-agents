// agents/audio-snippets/src/clips.ts
// The clips of a job (ruling R-D6), only when the request asks for them: one for each match, in the order of the matches, cut by ffmpeg from the decoded 16 kHz
// WAV of the job, as MP3 (libmp3lame, 64 kbps, mono) or as WAV. A cut is sample-exact: its first sample is the start of the match times 16000, rounded, and its
// end the same way, so a WAV clip is the samples of the decoded audio between its cut points under a header of 44 bytes. Every clip carries its sha256 and its
// size, and its bytes, as base64, only while the total of the clips that carry them stays at or under 2000000 bytes. From the first clip that would cross that
// line on, no clip carries its bytes and clips_truncated is true: a hirer who wants the rest cuts them from the media at the cut points. Each clip is read and
// removed before the next one is cut, so a job holds one clip on disk at a time.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex, toolFailure } from '@vsa/service-kit';
import { CLIP_TIMEOUT_MS } from './budget.ts';
import type { Match } from './match.ts';
import { SAMPLE_RATE } from './media.ts';
import type { MediaTools } from './media.ts';
import type { ClipFormat } from './request.ts';
import { SnippetsError } from './result.ts';

/** The most bytes of clips a result carries inline, in all: 2 MB. */
export const INLINE_CLIPS_BYTES = 2_000_000;
export const MP3_BITRATE = '64k';
const TOOL_OUTPUT_LIMIT = 1024 * 1024;

export interface Clip { start_s: number; end_s: number; format: ClipFormat; sha256: string; bytes: number; bytes_b64?: string }

/** The samples of a clip, [start, end): its cut points times 16000, rounded; at least one sample. */
export function sampleRange(startS: number, endS: number): { start: number; end: number } {
  const start = Math.round(startS * SAMPLE_RATE);
  return { start, end: Math.max(start + 1, Math.round(endS * SAMPLE_RATE)) };
}

/** The arguments of ffmpeg that cut one clip from the decoded WAV of the job: an argument list, the demuxer forced, files only. */
export function cutArgs(wav: string, out: string, startS: number, endS: number, format: ClipFormat): string[] {
  const { start, end } = sampleRange(startS, endS);
  const codec = format === 'mp3'
    ? ['-c:a', 'libmp3lame', '-b:a', MP3_BITRATE, '-id3v2_version', '0', '-write_xing', '0', '-f', 'mp3']
    : ['-c:a', 'pcm_s16le', '-f', 'wav'];
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-f', 'wav', '-i', wav,
    '-af', `atrim=start_sample=${start}:end_sample=${end},asetpts=PTS-STARTPTS`, '-ac', '1', '-ar', String(SAMPLE_RATE), ...codec, '-bitexact', '-map_metadata', '-1', '-y', out,
  ];
}

/** The inline budget of the clips of one job: a clip carries its bytes while the running total stays at or under the limit; from the first that does not fit, none does. */
export function inlineBudget(limit: number = INLINE_CLIPS_BYTES): { take: (size: number) => boolean; truncated: () => boolean } {
  let total = 0;
  let open = true;
  return {
    take: (size) => {
      if (open && total + size <= limit) { total += size; return true; }
      open = false;
      return false;
    },
    truncated: () => !open,
  };
}

export interface ClipDeps { tools: MediaTools; clock: () => number; deadlineMs: number }

/** The clips of `matches`, cut in `dir` from `wav`. Refused with deadline when the time of the job runs out first, and with clip_failed when ffmpeg fails on a clip. */
export async function cutClips(matches: readonly Match[], wav: string, dir: string, format: ClipFormat, deps: ClipDeps): Promise<{ clips: Clip[]; truncated: boolean }> {
  const budget = inlineBudget();
  const clips: Clip[] = [];
  for (const [index, match] of matches.entries()) {
    const left = deps.deadlineMs - deps.clock();
    if (left <= 0) throw new SnippetsError('deadline', `the job ran out of its time after ${index} of its ${matches.length} clips`);
    const out = join(dir, `clip-${index}.${format}`);
    try {
      await deps.tools.run(deps.tools.ffmpeg, cutArgs(wav, out, match.start_s, match.end_s, format), { timeoutMs: Math.min(CLIP_TIMEOUT_MS, left), maxBuffer: TOOL_OUTPUT_LIMIT });
    } catch (error) {
      const failure = toolFailure(error);
      if (failure.kind === 'start') throw new Error(`${deps.tools.ffmpeg} could not be run (${failure.code}): ffmpeg must be installed and on PATH`, { cause: error });
      if (failure.kind === 'timeout' && left <= CLIP_TIMEOUT_MS) throw new SnippetsError('deadline', `the job ran out of its time while clip ${index} was cut`);
      const said = failure.kind === 'exit' ? (failure.stderr.trim().split('\n').at(-1) ?? '') : failure.kind;
      throw new SnippetsError('clip_failed', `ffmpeg could not cut clip ${index} (${said === '' ? 'no message' : said})`);
    }
    const bytes = await readFile(out);
    await rm(out, { force: true });
    const clip: Clip = { start_s: match.start_s, end_s: match.end_s, format, sha256: sha256Hex(bytes), bytes: bytes.length };
    if (budget.take(bytes.length)) clip.bytes_b64 = bytes.toString('base64');
    clips.push(clip);
  }
  return { clips, truncated: budget.truncated() };
}
