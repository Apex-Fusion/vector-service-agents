// agents/audio-snippets/src/result.ts
// What a job gives back (ruling R-D7). On success the result, which the server answers as JSON.stringify(result) and the runtime hashes into the one receipt it
// signs: the media's hash, size, type and duration, the speech model, the language, the word-timed transcript, the matches with their cut points, what was not
// found, how a question was matched, and the clips. Every number is rounded to 3 decimals. On failure a SnippetsError, a failure of the job itself, with a stable
// code for the server to map; a RequestError of the intake or of the media (src/request.ts, src/media.ts) is not wrapped.
//
// The codes and their status:
//   422  deadline (the job ran out of its time: the speech recognition did not finish within what it had, or too little was left to start it or a clip)
//   500  asr_failed (the speech model failed or wrote no transcript), clip_failed (ffmpeg could not cut a clip)
//   503  low_disk (the temporary directory has less free space than a job needs)
import type { AsrSegment } from './asr.ts';
import type { Clip } from './clips.ts';
import { round3 } from './match.ts';
import type { Found } from './match.ts';
import type { Mime } from './request.ts';

export const RESULT_SCHEMA = 'vector.audio-snippets.result.v1';

export interface SnippetsResult {
  schema: typeof RESULT_SCHEMA;
  source: { sha256: string; bytes: number; mime: Mime; duration_s: number };
  /** faster-whisper-<size>-int8: the speech model that made the transcript. */
  model: string;
  /** The language the transcript is in: the code that was asked for, or the one the model detected when auto was asked. */
  language: string;
  transcript: AsrSegment[];
  matches: Found['matches'];
  unmatched: Found['unmatched'];
  match_method: Found['match_method'];
  /** One for each match, in the same order, when the request asked for clips; none otherwise. */
  clips: Clip[];
  clips_truncated: boolean;
}

export type SnippetsErrorCode = 'deadline' | 'asr_failed' | 'clip_failed' | 'low_disk';
const STATUS: Record<SnippetsErrorCode, 422 | 500 | 503> = { deadline: 422, asr_failed: 500, clip_failed: 500, low_disk: 503 };

/** A job that failed: a stable `code` to branch on, a `message` (for the buyer at 422, for the operator's log at 500 and 503), and the HTTP `status`. */
export class SnippetsError extends Error {
  readonly code: SnippetsErrorCode;
  readonly status: 422 | 500 | 503;
  constructor(code: SnippetsErrorCode, message: string) {
    super(message);
    this.name = 'SnippetsError';
    this.code = code;
    this.status = STATUS[code];
  }
}

const clamp = (x: number, duration: number): number => round3(Math.min(duration, Math.max(0, x)));

/** The transcript as the result gives it: every time clamped to [0, duration] and rounded to 3 decimals; the texts as the model wrote them. */
export function transcriptOf(segments: readonly AsrSegment[], duration: number): AsrSegment[] {
  return segments.map((segment) => ({
    start: clamp(segment.start, duration), end: clamp(segment.end, duration), text: segment.text,
    words: segment.words.map((word) => ({ w: word.w, start: clamp(word.start, duration), end: clamp(word.end, duration) })),
  }));
}

/** The result, its keys in the order of the spec. */
export function assemble(parts: {
  source: SnippetsResult['source']; model: string; language: string; transcript: AsrSegment[]; found: Found; clips: { clips: Clip[]; truncated: boolean };
}): SnippetsResult {
  return {
    schema: RESULT_SCHEMA,
    source: { sha256: parts.source.sha256, bytes: parts.source.bytes, mime: parts.source.mime, duration_s: round3(parts.source.duration_s) },
    model: parts.model,
    language: parts.language,
    transcript: parts.transcript,
    matches: parts.found.matches,
    unmatched: parts.found.unmatched,
    match_method: parts.found.match_method,
    clips: parts.clips.clips,
    clips_truncated: parts.clips.truncated,
  };
}
