// agents/audio-snippets/src/media.ts
// From the source of a request to the audio the speech model hears (ruling R-D4): the bytes, fetched over https or decoded from base64, with their sha256; the
// kind read from their first bytes; a probe by ffprobe with the demuxer of that kind forced; and the audio decoded by ffmpeg to 16 kHz mono 16-bit PCM WAV in
// the private directory of the job. Every refusal is a RequestError (422), made before the speech model runs.
//
// The media is the caller's, and ffprobe and ffmpeg parse it, so it never meets a shell: the tools are started with an argument list, the demuxer is forced
// (-f) to the one the first bytes name, so that no file is read as a playlist or as a list of other files, and -protocol_whitelist file keeps them to the file
// they are given. What they print stays in the operator's log, and the caller is told a sentence of ours. A tool that cannot be started at all is no verdict on
// the media: that is a plain Error, a failure on the service's side (500), and the start of the service runs both tools before it listens (checkTools).
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ascii, fetchUrlBytes, runTool, sha256Hex, sniffBy, toolFailure } from '@vsa/service-kit';
import type { RunTool, Signature } from '@vsa/service-kit';
import { MIMES, RequestError } from './request.ts';
import type { Mime, SnippetsRequest } from './request.ts';

/** 50 MB, as the spec says: the most a fetched file may have. */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
/** The longest media a job takes: 10 min. */
export const MAX_DURATION_S = 600;
/** What a duration may run over MAX_DURATION_S, for the padding an encoder adds. */
export const DURATION_SLACK_S = 0.5;
/** The audio the speech model hears: 16 kHz, mono, 16-bit PCM. */
export const SAMPLE_RATE = 16_000;
/** ffmpeg decodes at most this many seconds; a longer file is refused once decoded, whatever its container said. */
export const MAX_DECODE_S = 601;
export const SOURCE_FETCH_TIMEOUT_MS = 120_000;
export const PROBE_TIMEOUT_MS = 30_000;
export const DECODE_TIMEOUT_MS = 120_000;
const TOOL_OUTPUT_LIMIT = 1024 * 1024;
const CHECK_TIMEOUT_MS = 20_000;

/** The kinds of file the service reads, by their first bytes. */
export type Family = 'mp3' | 'wav' | 'ogg' | 'flac' | 'webm' | 'mp4';
/** The types a request may declare, or a server serve, for each kind. */
export const FAMILY_MIMES: Readonly<Record<Family, readonly Mime[]>> = {
  mp3: ['audio/mpeg'], wav: ['audio/wav', 'audio/x-wav'], ogg: ['audio/ogg'], flac: ['audio/flac'], webm: ['audio/webm', 'video/webm'],
  mp4: ['audio/mp4', 'audio/x-m4a', 'video/mp4', 'video/quicktime'],
};
/** The demuxer of ffprobe and ffmpeg for each kind, forced with -f. */
export const DEMUXERS: Readonly<Record<Family, string>> = { mp3: 'mp3', wav: 'wav', ogg: 'ogg', flac: 'flac', webm: 'matroska', mp4: 'mov' };
const FAMILY_NAMES: Readonly<Record<Family, string>> = { mp3: 'MPEG audio', wav: 'WAV', ogg: 'Ogg', flac: 'FLAC', webm: 'WebM or Matroska', mp4: 'MP4 or QuickTime' };

// The first bytes of each kind. An MPEG audio file starts with an ID3 tag or with a frame header: eleven bits of sync, then a version that is not reserved and a
// layer III or II (the second byte under the mask 0xfe). Layer I is left out: its header, FF FE, is also the byte-order mark of a UTF-16 text. ADTS AAC, whose
// layer bits are 00, is none of them. A WAV file is RIFF with WAVE at byte 8. An MP4, M4A or QuickTime file has a box type at byte 4.
const FRAME_SYNC = [0xe2, 0xe4, 0xf2, 0xf4, 0xfa, 0xfc];
const SIGNATURES: readonly Signature[] = [
  { type: 'mp3', magic: ascii('ID3') },
  ...FRAME_SYNC.map((second): Signature => ({ type: 'mp3', magic: [0xff, second], mask: [0xff, 0xfe] })),
  { type: 'wav', magic: [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')], mask: [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff] },
  { type: 'ogg', magic: ascii('OggS') },
  { type: 'flac', magic: ascii('fLaC') },
  { type: 'webm', magic: [0x1a, 0x45, 0xdf, 0xa3] },
  ...['ftyp', 'moov', 'mdat', 'wide', 'free'].map((box): Signature => ({ type: 'mp4', at: 4, magic: ascii(box) })),
];

/** The kind of a file by its first bytes, or null when they name none of the six. */
export function familyOf(bytes: Uint8Array): Family | null {
  return sniffBy(bytes, SIGNATURES) as Family | null;
}

/** The two tools and how they are run: execFile by default, a stand-in in a test. */
export interface MediaTools { ffmpeg: string; ffprobe: string; run: RunTool }
export function mediaTools(opts: { ffmpeg?: string; ffprobe?: string; run?: RunTool } = {}): MediaTools {
  return { ffmpeg: opts.ffmpeg ?? 'ffmpeg', ffprobe: opts.ffprobe ?? 'ffprobe', run: opts.run ?? runTool };
}

/** Resolves when both tools can be run (each is asked for its version; an exit with a status counts as a tool that is there); rejects naming the one that cannot. */
export async function checkTools(tools: MediaTools): Promise<void> {
  for (const tool of [tools.ffprobe, tools.ffmpeg]) {
    try {
      await tools.run(tool, ['-version'], { timeoutMs: CHECK_TIMEOUT_MS, maxBuffer: TOOL_OUTPUT_LIMIT });
    } catch (error) {
      const failure = toolFailure(error);
      if (failure.kind === 'exit' || failure.kind === 'output') continue;
      const reason = failure.kind === 'start' ? failure.code : `it did not answer within ${CHECK_TIMEOUT_MS / 1000} s`;
      throw new Error(`${tool} cannot be run (${reason}): ffmpeg and ffprobe must be installed and on PATH, and no media can be read without them`, { cause: error });
    }
  }
}

/** The source of a job as the service holds it: the file in the job's directory, its size, its sha256, its kind, and the type its request or its server claimed. */
export interface SourceMedia { path: string; bytes: number; sha256: string; family: Family; claimed: Mime | null }

/** The type a Content-Type header claims when it is one of the allowlist; any other header (octet-stream, text/html, none) claims nothing. */
function claimedByHeader(header: string | null): Mime | null {
  const type = (header ?? '').split(';')[0].trim().toLowerCase();
  return (MIMES as readonly string[]).includes(type) ? (type as Mime) : null;
}

/**
 * The bytes of a source, fetched or decoded and written to `dir`. Their kind must be one of the six, and the one the request or the server claimed, if either
 * did. `signal` cuts a fetch that is still running, which then rejects with the signal's own reason.
 */
export async function loadSource(
  source: SnippetsRequest['source'], dir: string, deps: { fetchImpl: typeof fetch; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal },
): Promise<SourceMedia> {
  const maxBytes = deps.maxBytes ?? MAX_SOURCE_BYTES;
  let bytes: Uint8Array;
  let claimed: Mime | null;
  let claim: 'served as' | 'declared as';
  if ('url' in source) {
    const got = await fetchUrlBytes(source.url, {
      fetchImpl: deps.fetchImpl, maxBytes, timeoutMs: deps.timeoutMs ?? SOURCE_FETCH_TIMEOUT_MS, refuse: (code, message) => new RequestError(code, message),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    bytes = got.bytes;
    claimed = claimedByHeader(got.contentType);
    claim = 'served as';
  } else {
    const decoded = Buffer.from(source.audio_b64, 'base64');
    if (decoded.length > maxBytes) throw new RequestError('source_too_large', `the source is larger than ${maxBytes} bytes`);
    bytes = new Uint8Array(decoded); // a copy: a small Buffer sits in a pool shared with other buffers
    claimed = source.mime;
    claim = 'declared as';
  }
  const family = familyOf(bytes);
  if (family === null) {
    throw new RequestError('source_unsupported', 'the source is not one of the audio or video types the service reads: MP3, WAV, Ogg, FLAC, WebM, MP4, M4A or QuickTime (the type is read from the first bytes of the file)');
  }
  if (claimed !== null && !FAMILY_MIMES[family].includes(claimed)) throw new RequestError('source_mime_mismatch', `the source is ${FAMILY_NAMES[family]} but was ${claim} ${claimed}`);
  const path = join(dir, `source.${family}`);
  await writeFile(path, bytes);
  return { path, bytes: bytes.length, sha256: sha256Hex(bytes), family, claimed };
}

const READ_FAILED = 'the media could not be read: it is damaged, or it is not the type its first bytes name';
const unreadable = (message: string) => new RequestError('media_unreadable', message);
/** What a failed run of a tool means for the job: not started is the service's failure (a plain Error); out of time, too much output or an exit is the media's. */
function toolError(tool: string, error: unknown, action: 'read' | 'decode'): Error {
  const failure = toolFailure(error);
  if (failure.kind === 'start') return new Error(`${tool} could not be run (${failure.code}): ffmpeg and ffprobe must be installed and on PATH`, { cause: error });
  if (failure.kind === 'timeout') return unreadable(`the media took too long to ${action}`);
  return unreadable(action === 'read' ? READ_FAILED : 'the audio of the media could not be decoded: it is damaged');
}
const seconds = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** What the media holds: an audio stream, a video stream (a cover picture is none), and its duration when the container says. */
export interface Probe { hasAudio: boolean; hasVideo: boolean; duration: number | null }
export async function probe(media: Pick<SourceMedia, 'path' | 'family'>, tools: MediaTools, timeoutMs = PROBE_TIMEOUT_MS): Promise<Probe> {
  let stdout: string;
  try {
    ({ stdout } = await tools.run(tools.ffprobe, [
      '-v', 'error', '-protocol_whitelist', 'file', '-f', DEMUXERS[media.family],
      '-show_entries', 'format=duration:stream=codec_type,duration:stream_disposition=attached_pic', '-of', 'json', media.path,
    ], { timeoutMs, maxBuffer: TOOL_OUTPUT_LIMIT }));
  } catch (error) {
    throw toolError(tools.ffprobe, error, 'read');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw unreadable(READ_FAILED); }
  const json = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as { streams?: unknown; format?: { duration?: unknown } };
  // ffprobe can exit 0 on a file it could not open, with no format section at all (an ID3 tag over junk does): that file is unreadable.
  if (typeof json.format !== 'object' || json.format === null) throw unreadable(READ_FAILED);
  const streams = (Array.isArray(json.streams) ? json.streams : []) as Array<{ codec_type?: unknown; duration?: unknown; disposition?: { attached_pic?: unknown } }>;
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  return {
    hasAudio: audio !== undefined,
    hasVideo: streams.some((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1),
    duration: (audio === undefined ? null : seconds(audio.duration)) ?? seconds(json.format.duration),
  };
}

/** The samples of a 16 kHz mono 16-bit PCM WAV from its first bytes and its size: the data chunk's length, or what the file holds after it when that is less. */
export function wavSamples(head: Uint8Array, fileBytes: number): number {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const id = (at: number) => String.fromCharCode(head[at], head[at + 1], head[at + 2], head[at + 3]);
  if (head.length < 12 || id(0) !== 'RIFF' || id(8) !== 'WAVE') throw new Error('the decoded audio is not a WAV file');
  let at = 12;
  let format = false;
  while (at + 8 <= head.length) {
    const chunk = id(at);
    const length = view.getUint32(at + 4, true);
    if (chunk === 'fmt ' && at + 24 <= head.length) {
      const tag = view.getUint16(at + 8, true), channels = view.getUint16(at + 10, true), rate = view.getUint32(at + 12, true), bits = view.getUint16(at + 22, true);
      if (tag !== 1 || channels !== 1 || rate !== SAMPLE_RATE || bits !== 16) throw new Error('the decoded audio is not 16 kHz mono 16-bit PCM');
      format = true;
    } else if (chunk === 'data' && format) {
      return Math.floor(Math.min(length, fileBytes - (at + 8)) / 2);
    }
    at += 8 + length + (length % 2);
  }
  throw new Error('the decoded audio has no data chunk');
}

async function wavSamplesOf(path: string): Promise<number> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const head = new Uint8Array(Math.min(size, 4096));
    await handle.read(head, 0, head.length, 0);
    return wavSamples(head, size);
  } finally {
    await handle.close();
  }
}

/** The audio the speech model hears, decoded to `dir/audio.wav`: the first audio stream, mono, 16 kHz, 16-bit PCM, at most MAX_DECODE_S, with no tags. */
export interface Decoded { path: string; samples: number; duration_s: number }
export async function decode(media: Pick<SourceMedia, 'path' | 'family'>, dir: string, tools: MediaTools, timeoutMs = DECODE_TIMEOUT_MS): Promise<Decoded> {
  const out = join(dir, 'audio.wav');
  try {
    await tools.run(tools.ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-f', DEMUXERS[media.family], '-i', media.path,
      '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-t', String(MAX_DECODE_S), '-bitexact', '-map_metadata', '-1', '-f', 'wav', '-y', out,
    ], { timeoutMs, maxBuffer: TOOL_OUTPUT_LIMIT });
  } catch (error) {
    throw toolError(tools.ffmpeg, error, 'decode');
  }
  const samples = await wavSamplesOf(out);
  return { path: out, samples, duration_s: samples / SAMPLE_RATE };
}

/** The type the result names: the claim when there was one, else the kind's, as video when a video stream was found. */
export function mimeOf(family: Family, claimed: Mime | null, hasVideo: boolean): Mime {
  if (claimed !== null) return claimed;
  if (family === 'mp4') return hasVideo ? 'video/mp4' : 'audio/mp4';
  if (family === 'webm') return hasVideo ? 'video/webm' : 'audio/webm';
  return ({ mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac' } as const)[family];
}

const tooLong = () => new RequestError('media_too_long', `the media is longer than the ${MAX_DURATION_S} s (10 min) a job may have`);

/** The media of a job made ready: loaded, probed, decoded, with the duration of the decoded audio. Refused, before the speech model runs, when it cannot be. */
export interface Prepared { source: { sha256: string; bytes: number; mime: Mime; duration_s: number }; wav: string; samples: number }
export async function prepareMedia(
  source: SnippetsRequest['source'], dir: string,
  deps: { fetchImpl: typeof fetch; tools: MediaTools; fetchTimeoutMs?: number; probeTimeoutMs?: number; decodeTimeoutMs?: number; signal?: AbortSignal },
): Promise<Prepared> {
  const media = await loadSource(source, dir, {
    fetchImpl: deps.fetchImpl, ...(deps.fetchTimeoutMs === undefined ? {} : { timeoutMs: deps.fetchTimeoutMs }), ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  const found = await probe(media, deps.tools, deps.probeTimeoutMs);
  if (!found.hasAudio) throw new RequestError('media_no_audio', 'the file has no audio stream: there is nothing to transcribe');
  if (found.duration !== null && found.duration > MAX_DURATION_S + DURATION_SLACK_S) throw tooLong();
  const wav = await decode(media, dir, deps.tools, deps.decodeTimeoutMs);
  if (wav.samples === 0) throw new RequestError('media_no_audio', 'the audio stream holds no sound to decode: there is nothing to transcribe');
  if (wav.duration_s > MAX_DURATION_S + DURATION_SLACK_S) throw tooLong();
  return { source: { sha256: media.sha256, bytes: media.bytes, mime: mimeOf(media.family, media.claimed, found.hasVideo), duration_s: wav.duration_s }, wav: wav.path, samples: wav.samples };
}
