// agents/advocate/test/request.test.ts
// The request JSON (rulings R-E2 and R-E21): a table of requests the intake takes, with what it reads from each (the defaults, the trimming, the side in lower
// case, lengths in code points), and a table of requests it refuses, each with the message, which names the field. Every refusal is bad_shape (400).
// Characters outside ASCII are written as escapes.
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_LANGUAGE, DEFAULT_LENGTH, LANGUAGE_PATTERN, LENGTHS, MAX_AUDIENCE_CHARS, MAX_SIDE_CHARS, MAX_SUBJECT_CHARS, RequestError, parseRequest,
} from '../src/request.ts';
import type { AdvocateRequest } from '../src/request.ts';

const SUBJECT = 'Should a city ban cars from its centre?';
const parse = (v: unknown): AdvocateRequest => parseRequest(typeof v === 'string' ? v : JSON.stringify(v));
function refusal(v: unknown): RequestError {
  try { parse(v); } catch (e) { expect(e).toBeInstanceOf(RequestError); return e as RequestError; }
  throw new Error(`accepted: ${JSON.stringify(v).slice(0, 80)}`);
}
const read = (over: Partial<AdvocateRequest>): AdvocateRequest => ({ subject: SUBJECT, side: 'for', audience: null, length: 'standard', language: 'en', ...over });
/** A letter of two UTF-16 units, MATHEMATICAL BOLD CAPITAL A: a length is counted in characters, code points, as JSON Schema's maxLength counts them. */
const ASTRAL = '\u{1D400}';
const LANGUAGE_RULE = 'language must be a language code such as "en" or "en-GB": 2 to 8 letters, with optional hyphen-separated subtags of 1 to 8 letters or digits, at most 16 characters';

describe('parseRequest', () => {
  test('the limits and the defaults', () => {
    expect([MAX_SUBJECT_CHARS, MAX_SIDE_CHARS, MAX_AUDIENCE_CHARS, LENGTHS, DEFAULT_LENGTH, DEFAULT_LANGUAGE, LANGUAGE_PATTERN])
      .toStrictEqual([300, 120, 200, ['short', 'standard'], 'standard', 'en', '^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$']);
  });

  test.each<[string, unknown, AdvocateRequest]>([
    ['the example request of the spec', { subject: SUBJECT, side: 'for', length: 'short', language: 'en' }, read({ length: 'short' })],
    ['the least a request holds, with the defaults', { subject: SUBJECT, side: 'against' }, read({ side: 'against' })],
    ['every field given', { subject: SUBJECT, side: 'for', audience: 'city councillors', length: 'standard', language: 'en-GB' }, read({ audience: 'city councillors', language: 'en-GB' })],
    ['every text but the length trimmed', { subject: `  ${SUBJECT}\n`, side: ' for ', audience: '\tcity councillors ', length: 'short', language: ' de ' }, read({ audience: 'city councillors', length: 'short', language: 'de' })],
    ['for in any case, kept in lower case', { subject: SUBJECT, side: 'FOR' }, read({ side: 'for' })],
    ['against in any case, kept in lower case', { subject: SUBJECT, side: ' Against ' }, read({ side: 'against' })],
    ['a position in words, kept as it was given', { subject: SUBJECT, side: 'For a ban on weekends only' }, read({ side: 'For a ban on weekends only' })],
    ['a position in words, trimmed', { subject: SUBJECT, side: '  only on market days  ' }, read({ side: 'only on market days' })],
    ['a position that only begins with for', { subject: SUBJECT, side: 'for.' }, read({ side: 'for.' })],
    ['a language code as it was given: case and subtags kept', { subject: SUBJECT, side: 'for', language: 'zh-Hant-TW' }, read({ language: 'zh-Hant-TW' })],
    ['a language code of three letters', { subject: SUBJECT, side: 'for', language: 'yue' }, read({ language: 'yue' })],
    ['a language code in capitals', { subject: SUBJECT, side: 'for', language: 'EN' }, read({ language: 'EN' })],
    ['a language code of 16 characters', { subject: SUBJECT, side: 'for', language: 'zh-Hant-TW-abcde' }, read({ language: 'zh-Hant-TW-abcde' })],
    ['a subject of 300 astral letters, 600 UTF-16 units: 300 code points', { subject: ASTRAL.repeat(300), side: 'for' }, read({ subject: ASTRAL.repeat(300) })],
    ['a side of 120 characters', { subject: SUBJECT, side: `b${'c'.repeat(119)}` }, read({ side: `b${'c'.repeat(119)}` })],
    ['an audience of 200 characters, which needs no letter', { subject: SUBJECT, side: 'for', audience: '?'.repeat(200) }, read({ audience: '?'.repeat(200) })],
    ['a subject in another script', { subject: '\u03a0\u03cc\u03bb\u03b7 \u03c7\u03c9\u03c1\u03af\u03c2 \u03b1\u03c5\u03c4\u03bf\u03ba\u03af\u03bd\u03b7\u03c4\u03b1;', side: 'against' }, read({ subject: '\u03a0\u03cc\u03bb\u03b7 \u03c7\u03c9\u03c1\u03af\u03c2 \u03b1\u03c5\u03c4\u03bf\u03ba\u03af\u03bd\u03b7\u03c4\u03b1;', side: 'against' })],
  ])('takes %s', (_name, request, expected) => {
    expect(parse(request)).toStrictEqual(expected);
  });

  test.each<[string, string, unknown, string]>([
    ['text that is not JSON', 'the request', '{not json', 'the request is not valid JSON: '],
    ['a list', 'the request', '[]', 'the request must be a JSON object'],
    ['a string', 'the request', '"a subject"', 'the request must be a JSON object'],
    ['null', 'the request', 'null', 'the request must be a JSON object'],
    ['an unknown key', 'unknown key', { subject: SUBJECT, side: 'for', model: 'x' }, 'unknown key: "model"'],
    ['two unknown keys', 'unknown key', { subject: SUBJECT, side: 'for', tone: 'angry', words: 300 }, 'unknown keys: "tone", "words"'],
    ['no subject', 'subject', { side: 'for' }, 'subject is required: the subject of the brief, text of 1 to 300 characters'],
    ['an empty subject', 'subject', { subject: '', side: 'for' }, 'subject must be text of 1 to 300 characters'],
    ['a subject of white space', 'subject', { subject: ' \n\t ', side: 'for' }, 'subject must be text of 1 to 300 characters'],
    ['a subject that is a number', 'subject', { subject: 7, side: 'for' }, 'subject must be text of 1 to 300 characters'],
    ['a subject that is null', 'subject', { subject: null, side: 'for' }, 'subject must be text of 1 to 300 characters'],
    ['a subject of 301 astral letters', 'subject', { subject: ASTRAL.repeat(301), side: 'for' }, 'subject must be text of 1 to 300 characters'],
    ['a subject with no letter or digit', 'subject', { subject: '?!', side: 'for' }, 'subject must hold at least one letter or digit'],
    ['no side', 'side', { subject: SUBJECT }, 'side is required: for, against, or a position in words of 1 to 120 characters'],
    ['an empty side', 'side', { subject: SUBJECT, side: '  ' }, 'side must be for, against, or a position in words of 1 to 120 characters'],
    ['a side that is a list', 'side', { subject: SUBJECT, side: ['for'] }, 'side must be for, against, or a position in words of 1 to 120 characters'],
    ['a side of 121 characters', 'side', { subject: SUBJECT, side: `b${'c'.repeat(120)}` }, 'side must be for, against, or a position in words of 1 to 120 characters'],
    ['a side with no letter or digit', 'side', { subject: SUBJECT, side: '...' }, 'side must hold at least one letter or digit'],
    ['an empty audience', 'audience', { subject: SUBJECT, side: 'for', audience: ' ' }, 'audience must be text of 1 to 200 characters'],
    ['an audience that is null', 'audience', { subject: SUBJECT, side: 'for', audience: null }, 'audience must be text of 1 to 200 characters'],
    ['an audience of 201 characters', 'audience', { subject: SUBJECT, side: 'for', audience: 'a'.repeat(201) }, 'audience must be text of 1 to 200 characters'],
    ['a length of another word', 'length', { subject: SUBJECT, side: 'for', length: 'long' }, 'length must be "short" or "standard"'],
    ['a length in capitals', 'length', { subject: SUBJECT, side: 'for', length: 'SHORT' }, 'length must be "short" or "standard"'],
    ['a length that is a number', 'length', { subject: SUBJECT, side: 'for', length: 3 }, 'length must be "short" or "standard"'],
    ['a length with spaces around it', 'length', { subject: SUBJECT, side: 'for', length: ' short ' }, 'length must be "short" or "standard"'],
    ['a length that is null', 'length', { subject: SUBJECT, side: 'for', length: null }, 'length must be "short" or "standard"'],
    ['a language of one letter', 'language', { subject: SUBJECT, side: 'for', language: 'e' }, LANGUAGE_RULE],
    ['a language with a mark', 'language', { subject: SUBJECT, side: 'for', language: 'english!' }, LANGUAGE_RULE],
    ['a language with an underscore', 'language', { subject: SUBJECT, side: 'for', language: 'en_GB' }, LANGUAGE_RULE],
    ['a language with an empty subtag', 'language', { subject: SUBJECT, side: 'for', language: 'en-' }, LANGUAGE_RULE],
    ['a language of 17 characters', 'language', { subject: SUBJECT, side: 'for', language: 'zh-Hant-TW-abcdef' }, LANGUAGE_RULE],
    ['a language that is a number', 'language', { subject: SUBJECT, side: 'for', language: 7 }, LANGUAGE_RULE],
    ['a language that is null', 'language', { subject: SUBJECT, side: 'for', language: null }, LANGUAGE_RULE],
    ['the language auto', 'language', { subject: SUBJECT, side: 'for', language: 'auto' }, `${LANGUAGE_RULE}; auto is not one, for the brief is written in the language the request names, en by default`],
    ['the language auto in capitals', 'language', { subject: SUBJECT, side: 'for', language: ' AUTO ' }, `${LANGUAGE_RULE}; auto is not one, for the brief is written in the language the request names, en by default`],
  ])('refuses %s, naming %s', (_name, field, request, message) => {
    const e = refusal(request);
    expect([e.name, e.code, e.status]).toStrictEqual(['RequestError', 'bad_shape', 400]);
    if (message.endsWith(': ')) expect(e.message.startsWith(message)).toBe(true);
    else expect(e.message).toBe(message);
    expect(e.message.startsWith(field)).toBe(true);
  });

  test('the checks run in their order: the subject before the side, the side before the audience, the length and the language', () => {
    expect(refusal({ subject: 7, side: 7, length: 'long' }).message).toMatch(/^subject /);
    expect(refusal({ subject: SUBJECT, side: 7, audience: '', language: 'x' }).message).toMatch(/^side /);
    expect(refusal({ subject: SUBJECT, side: 'for', audience: '', language: 'x' }).message).toMatch(/^audience /);
    expect(refusal({ subject: SUBJECT, side: 'for', length: 'long', language: 'x' }).message).toMatch(/^length /);
    expect(refusal({ subject: 7, unknown: true }).message).toBe('unknown key: "unknown"');
  });
});
