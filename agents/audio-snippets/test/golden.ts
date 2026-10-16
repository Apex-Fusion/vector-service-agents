// agents/audio-snippets/test/golden.ts
// The golden job: the tone fixture, the transcript a stub speech model gives for it, a request with a quote that is said, one that is not, a question and a
// range, and the result the service must answer for it, every value written out. The clips are WAV, so their bytes are the samples of the fixture between
// their cut points under the 44-byte header ffmpeg writes with -bitexact; wavFile builds the same bytes here.
import type { Asr, AsrTranscript } from '../src/asr.ts';
import { TONE_WAV, toBase64 } from './support.ts';
import { createHash } from 'node:crypto';

const W = (w: string, start: number, end: number) => ({ w, start, end });
export const GOLDEN_TRANSCRIPT: AsrTranscript = {
  language: 'en', language_probability: 0.99, duration: 3,
  segments: [
    { start: 0, end: 1.2, text: 'This is a LibriVox recording.', words: [W('This', 0.1, 0.25), W('is', 0.25, 0.35), W('a', 0.35, 0.4), W('LibriVox', 0.4, 0.8), W('recording.', 0.8, 1.15)] },
    {
      start: 1.4, end: 2.95, text: 'All LibriVox recordings are in the public domain.',
      words: [W('All', 1.45, 1.55), W('LibriVox', 1.55, 1.95), W('recordings', 1.95, 2.3), W('are', 2.3, 2.4), W('in', 2.4, 2.45), W('the', 2.45, 2.5), W('public', 2.5, 2.7), W('domain.', 2.7, 2.9)],
    },
  ],
};

export const GOLDEN_REQUEST = {
  source: { audio_b64: toBase64(TONE_WAV), mime: 'audio/wav' },
  language: 'en',
  query: 'where is the public domain mentioned',
  quotes: ['all LibriVox recordings are in the public domain', 'something never said here'],
  ranges: [{ start_s: 0.3, end_s: 0.9 }],
  return_clips: true,
  clip_format: 'wav',
};

/** A 16 kHz mono 16-bit PCM WAV file of `pcm`: the 44-byte header ffmpeg writes with -bitexact and no tags, then the samples. */
export function wavFile(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const id = (at: number, s: string) => { for (let i = 0; i < 4; i += 1) out[at + i] = s.charCodeAt(i); };
  id(0, 'RIFF'); view.setUint32(4, 36 + pcm.length, true); id(8, 'WAVE');
  id(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  id(36, 'data'); view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}
/** The samples [start, end) of a 16 kHz mono 16-bit WAV file with a 44-byte header, as a WAV file of their own. */
export const wavSlice = (wav: Uint8Array, start: number, end: number): Uint8Array => wavFile(wav.subarray(44 + start * 2, 44 + end * 2));
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const clipOf = (start_s: number, end_s: number, bytes: Uint8Array) => ({
  start_s, end_s, format: 'wav', sha256: sha256(bytes), bytes: bytes.length, bytes_b64: Buffer.from(bytes).toString('base64'),
});

const SENTENCE = 'All LibriVox recordings are in the public domain.';
/** The result of the golden job, key for key in the order of the spec. */
export const GOLDEN_RESULT = {
  schema: 'vector.audio-snippets.result.v1',
  source: { sha256: '9a839538910840c3b94b142ae50d67304ee7316e7fd7eb48bbd6577711471015', bytes: 96_044, mime: 'audio/wav', duration_s: 3 },
  model: 'faster-whisper-base-int8',
  language: 'en',
  transcript: GOLDEN_TRANSCRIPT.segments,
  matches: [
    { from: 'quote', start_s: 1.3, end_s: 3, text: SENTENCE, score: 1 },
    { from: 'query', start_s: 1.3, end_s: 3, text: SENTENCE, score: 0.4 },
    { from: 'range', start_s: 0.1, end_s: 1.3, text: 'is a LibriVox recording.', score: 1 },
  ],
  unmatched: [{ from: 'quote', text: 'something never said here', best_score: 0.32 }],
  match_method: 'keyword',
  clips: [
    clipOf(1.3, 3, wavSlice(TONE_WAV, 20_800, 48_000)),
    clipOf(1.3, 3, wavSlice(TONE_WAV, 20_800, 48_000)),
    clipOf(0.1, 1.3, wavSlice(TONE_WAV, 1_600, 20_800)),
  ],
  clips_truncated: false,
};

/** A speech model that answers what it is given, and records every call. */
export function stubAsr(answer: AsrTranscript | ((wav: string, language: string | null, timeoutMs: number) => Promise<AsrTranscript>)): Asr & { calls: Array<{ language: string | null; timeoutMs: number }> } {
  const calls: Array<{ language: string | null; timeoutMs: number }> = [];
  return {
    calls,
    async transcribe(wav, language, timeoutMs) {
      calls.push({ language, timeoutMs });
      return typeof answer === 'function' ? answer(wav, language, timeoutMs) : structuredClone(answer);
    },
    async check() { return { faster_whisper: '1.2.1', ctranslate2: '4.8.2' }; },
  };
}
