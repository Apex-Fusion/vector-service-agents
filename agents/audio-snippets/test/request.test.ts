// agents/audio-snippets/test/request.test.ts
import { describe, test, expect } from 'vitest';
import { WHISPER_LANGUAGES } from '../src/languages.ts';
import { MAX_INLINE_BYTES, MIMES, RequestError, chars, parseRequest } from '../src/request.ts';
import type { RequestErrorCode } from '../src/request.ts';

const parse = (v: unknown) => parseRequest(typeof v === 'string' ? v : JSON.stringify(v));
function refusal(v: unknown): RequestError {
  try { parse(v); } catch (e) { expect(e).toBeInstanceOf(RequestError); return e as RequestError; }
  throw new Error(`accepted: ${JSON.stringify(v).slice(0, 80)}`);
}
const codeOf = (v: unknown): RequestErrorCode => refusal(v).code;
const URL_SOURCE = { url: 'https://example.org/talk.mp3' };
const ok = (over: Record<string, unknown>) => ({ source: URL_SOURCE, quotes: ['a quote'], ...over });
const b64 = (bytes: number) => Buffer.alloc(bytes).toString('base64');

describe('parseRequest', () => {
  test('the example request of the spec parses, with the defaults filled in', () => {
    expect(parse({ source: URL_SOURCE, language: 'en', quotes: ['a quote that was said in the talk'], ranges: [{ start_s: 12.0, end_s: 20.5 }], return_clips: false })).toStrictEqual({
      source: URL_SOURCE, language: 'en', quotes: ['a quote that was said in the talk'], ranges: [{ start_s: 12, end_s: 20.5 }], return_clips: false, clip_format: 'mp3',
    });
    expect(parse({ source: URL_SOURCE, query: 'what is said about the public domain' })).toStrictEqual({ source: URL_SOURCE, language: 'en', query: 'what is said about the public domain', return_clips: false, clip_format: 'mp3' });
  });

  test('an inline source is exactly {audio_b64, mime}, a mime of the allowlist and at most 600000 bytes of standard padded base64', () => {
    expect(MIMES).toStrictEqual(['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/flac', 'audio/webm', 'video/mp4', 'video/webm', 'video/quicktime']);
    for (const mime of MIMES) expect(parse(ok({ source: { audio_b64: b64(9), mime } })).source).toStrictEqual({ audio_b64: b64(9), mime });
    expect(MAX_INLINE_BYTES).toBe(600_000);
    expect(parse(ok({ source: { audio_b64: b64(600_000), mime: 'audio/wav' } })).source).toMatchObject({ mime: 'audio/wav' });
    expect(codeOf(ok({ source: { audio_b64: b64(600_001), mime: 'audio/wav' } }))).toBe('base64_too_large');
    for (const source of [{ audio_b64: b64(9), mime: 'audio/aac' }, { audio_b64: b64(9) }, { audio_b64: 'abc', mime: 'audio/wav' }, { audio_b64: 'YW Jj', mime: 'audio/wav' }, { audio_b64: '', mime: 'audio/wav' },
      { url: 'https://x.test/a', mime: 'audio/wav' }, { url: '' }, { url: 7 }, {}, 'https://x.test/a.mp3', null]) {
      expect(codeOf(ok({ source })), JSON.stringify(source)).toBe('bad_shape');
    }
  });

  test('language: absent is en, auto in any case is auto, a code is asked by its first part in lower case, and a code the model does not know is refused', () => {
    expect(parse(ok({})).language).toBe('en');
    expect(parse(ok({ language: 'AUTO' })).language).toBe('auto');
    expect(parse(ok({ language: 'en-GB' })).language).toBe('en');
    expect(parse(ok({ language: 'HR' })).language).toBe('hr');
    expect(parse(ok({ language: 'yue' })).language).toBe('yue');
    expect(WHISPER_LANGUAGES).toHaveLength(100);
    for (const bad of ['e', 'english!', 'en_GB', 'a'.repeat(17), 'en-', ' en']) expect(codeOf(ok({ language: bad })), bad).toBe('language_bad');
    expect(refusal(ok({ language: 'xx-YY' }))).toMatchObject({ code: 'language_unsupported', status: 400 });
    expect(codeOf(ok({ language: 7 }))).toBe('bad_shape');
  });

  test('at least one of query, quotes and ranges', () => {
    expect(refusal({ source: URL_SOURCE })).toMatchObject({ code: 'nothing_to_find', status: 400, message: 'the request must have at least one of query, quotes and ranges' });
    expect(parse({ source: URL_SOURCE, ranges: [{ start_s: 0, end_s: 1 }] }).ranges).toStrictEqual([{ start_s: 0, end_s: 1 }]);
  });

  test('query and quotes are counted in characters, code points as JSON Schema counts them, and must hold a letter or a digit', () => {
    const emoji = '\u{1F600}';
    expect(chars(emoji.repeat(3))).toBe(3);
    expect(parse(ok({ quotes: [`a${emoji.repeat(299)}`] })).quotes).toHaveLength(1);
    expect(codeOf(ok({ quotes: [`a${emoji.repeat(300)}`] }))).toBe('bad_shape');
    expect(parse({ source: URL_SOURCE, query: 'q'.repeat(500) }).query).toHaveLength(500);
    expect(codeOf({ source: URL_SOURCE, query: 'q'.repeat(501) })).toBe('bad_shape');
    expect(parse(ok({ quotes: Array.from({ length: 20 }, (_v, i) => `quote ${i}`) })).quotes).toHaveLength(20);
    for (const quotes of [[], Array.from({ length: 21 }, () => 'q'), [''], ['?!'], [7], 'a quote']) expect(codeOf(ok({ quotes })), JSON.stringify(quotes)).toBe('bad_shape');
    for (const query of ['', '...', 7]) expect(codeOf({ source: URL_SOURCE, query }), JSON.stringify(query)).toBe('bad_shape');
  });

  test('ranges: 1 to 20 of exactly {start_s, end_s}, finite numbers with 0 <= start_s < end_s', () => {
    expect(parse(ok({ ranges: [{ start_s: 0, end_s: 0.001 }] })).ranges).toStrictEqual([{ start_s: 0, end_s: 0.001 }]);
    for (const ranges of [[], Array.from({ length: 21 }, () => ({ start_s: 0, end_s: 1 })), [{ start_s: 0 }], [{ start_s: 0, end_s: 1, label: 'x' }], [{ start_s: '0', end_s: 1 }], [[0, 1]]]) {
      expect(codeOf(ok({ ranges })), JSON.stringify(ranges)).toBe('bad_shape');
    }
    for (const range of [{ start_s: -1, end_s: 1 }, { start_s: 2, end_s: 2 }, { start_s: 3, end_s: 1 }]) expect(refusal(ok({ ranges: [range] })), JSON.stringify(range)).toMatchObject({ code: 'range_bad', status: 400 });
    expect(codeOf('{"source":{"url":"https://x.test/a"},"ranges":[{"start_s":0,"end_s":1e400}]}')).toBe('bad_shape');
  });

  test('return_clips is true or false; clip_format is mp3 or wav and goes with return_clips true only', () => {
    expect(parse(ok({ return_clips: true })).clip_format).toBe('mp3');
    expect(parse(ok({ return_clips: true, clip_format: 'wav' })).clip_format).toBe('wav');
    expect(refusal(ok({ clip_format: 'wav' })).message).toBe('clip_format is only accepted with return_clips true');
    expect(codeOf(ok({ return_clips: false, clip_format: 'mp3' }))).toBe('bad_shape');
    expect(codeOf(ok({ return_clips: true, clip_format: 'ogg' }))).toBe('bad_shape');
    expect(codeOf(ok({ return_clips: 'yes' }))).toBe('bad_shape');
  });

  test('not JSON, not an object, an unknown key: refused before anything else, every refusal of the request is a 400', () => {
    expect(refusal('{not json')).toMatchObject({ code: 'bad_json', status: 400 });
    expect(codeOf('[]')).toBe('bad_shape');
    expect(refusal(ok({ task: 'summary', speed: 2 })).message).toBe('unknown keys: "task", "speed"');
    // The order: source before language before the three before the clips.
    expect(codeOf({ source: {}, language: 'xx' })).toBe('bad_shape');
    expect(codeOf({ source: URL_SOURCE, language: 'xx' })).toBe('language_unsupported');
    for (const code of ['bad_json', 'bad_shape', 'base64_too_large', 'language_bad', 'language_unsupported', 'nothing_to_find', 'range_bad'] as const) expect(new RequestError(code, 'x').status, code).toBe(400);
    for (const code of ['source_fetch_failed', 'source_too_large', 'source_unsupported', 'source_mime_mismatch', 'media_unreadable', 'media_no_audio', 'media_too_long', 'range_out_of_media'] as const) expect(new RequestError(code, 'x').status, code).toBe(422);
  });
});
