// agents/audio-snippets/test/result.test.ts
import { describe, test, expect } from 'vitest';
import { RESULT_SCHEMA, SnippetsError, assemble, transcriptOf } from '../src/result.ts';

describe('the result (R-D7)', () => {
  test('the schema id, and the keys in the order of the spec', () => {
    expect(RESULT_SCHEMA).toBe('vector.audio-snippets.result.v1');
    const result = assemble({
      source: { sha256: 'ab'.repeat(32), bytes: 10, mime: 'audio/mpeg', duration_s: 2.00049 }, model: 'faster-whisper-base-int8', language: 'en', transcript: [],
      found: { matches: [], unmatched: [], match_method: null }, clips: { clips: [], truncated: false },
    });
    expect(Object.keys(result)).toStrictEqual(['schema', 'source', 'model', 'language', 'transcript', 'matches', 'unmatched', 'match_method', 'clips', 'clips_truncated']);
    expect(Object.keys(result.source)).toStrictEqual(['sha256', 'bytes', 'mime', 'duration_s']);
    expect(result.source.duration_s).toBe(2);
    expect(JSON.stringify(result)).toBe(`{"schema":"vector.audio-snippets.result.v1","source":{"sha256":"${'ab'.repeat(32)}","bytes":10,"mime":"audio/mpeg","duration_s":2},"model":"faster-whisper-base-int8","language":"en","transcript":[],"matches":[],"unmatched":[],"match_method":null,"clips":[],"clips_truncated":false}`);
  });
  test('the transcript: every time rounded to 3 decimals and clamped to [0, duration], the texts as the model wrote them', () => {
    expect(transcriptOf([
      { start: -0.0004, end: 1.23456, text: 'Hello there.', words: [{ w: 'Hello', start: -0.02, end: 0.5004 }, { w: 'there.', start: 0.6, end: 1.23456 }] },
      { start: 2.9, end: 3.4, text: 'End', words: [{ w: 'End', start: 2.9, end: 3.4 }] },
    ], 3)).toStrictEqual([
      { start: 0, end: 1.235, text: 'Hello there.', words: [{ w: 'Hello', start: 0, end: 0.5 }, { w: 'there.', start: 0.6, end: 1.235 }] },
      { start: 2.9, end: 3, text: 'End', words: [{ w: 'End', start: 2.9, end: 3 }] },
    ]);
  });
  test('the errors of a job and their status: deadline 422, asr_failed and clip_failed 500, low_disk 503', () => {
    expect(['deadline', 'asr_failed', 'clip_failed', 'low_disk'].map((code) => new SnippetsError(code as never, 'x').status)).toStrictEqual([422, 500, 500, 503]);
    const e = new SnippetsError('deadline', 'the job ran out of its time');
    expect([e.name, e.code, e.message, e instanceof Error]).toStrictEqual(['SnippetsError', 'deadline', 'the job ran out of its time', true]);
  });
});
