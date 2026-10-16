// agents/audio-snippets/src/gaps.ts
// The gaps the manifest states, as sentences, in one place: the manifest takes them from here (src/server.ts) and the spec test holds the page to them
// (test/spec.test.ts). The manifest is frozen into the advert's hash when the advert is posted, so each sentence is a statement made to a hirer about what the
// service does today. Each is one line of plain text that ends with a full stop. The second names the speech model the service runs.
import { ASR_MAX_MS, JOB_DEADLINE_MS } from './budget.ts';
import { INLINE_CLIPS_BYTES } from './clips.ts';
import { MAX_DURATION_S, MAX_SOURCE_BYTES } from './media.ts';
import type { WhisperSize } from './model.ts';

// On the page of the spec since its design, and still true of the built service: the wording is the page's.
export const LIMITS_GAP = `At most ${MAX_DURATION_S / 60} min and ${MAX_SOURCE_BYTES / 1024 / 1024} MB per file, and one of query, quotes, ranges is required.`;
export const modelGap = (size: WhisperSize): string =>
  `The transcript is only as good as the speech model, faster-whisper ${size} int8 on CPU: names, numbers and quiet or overlapping speech can come out wrong, and every match is made against what the model heard.`;
export const LANGUAGE_GAP = 'The language is taken as asked: audio in another language is transcribed as if it were in the one asked for, and its quotes go to unmatched. With auto the model detects the language from the first 30 s.';
export const QUERY_GAP = 'A query is matched by keyword overlap at segment level, and the result says so in match_method: a question worded otherwise than the speech finds nothing, and no embedding model is installed.';
export const QUOTE_GAP = 'A quote is matched once: a quote said twice gives one match, where it is said first.';
// Its second sentence is ruling R-D18: faster-whisper starts the first word after a pause up to about 0.7 s before it is said, and ends a word within a few
// hundredths of a second of its end (measured on the recording the speech fixture is cut from; test/asr-real.test.ts holds the bound), so the cut point
// before such a word is early by as much.
export const CLIPS_GAP = `Clips carry their bytes inline only while their total stays at or under ${INLINE_CLIPS_BYTES} bytes: past that, a clip carries its sha256, its size and its cut points, and clips_truncated is true. `
  + 'A cut point after a pause may begin up to about 0.7 s early, so a clip may start with a little silence before its first word.';
export const DEADLINE_GAP = `A job has a deadline of its own, ${JOB_DEADLINE_MS} ms after its request arrives, and the speech recognition gets at most ${ASR_MAX_MS} ms of it: a job cut at the deadline fails with the code deadline and returns no result.`;

/** In the order the manifest states them. */
export const gapsFor = (size: WhisperSize): readonly string[] => [LIMITS_GAP, modelGap(size), LANGUAGE_GAP, QUERY_GAP, QUOTE_GAP, CLIPS_GAP, DEADLINE_GAP];
