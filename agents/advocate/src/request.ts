// agents/advocate/src/request.ts
// The request JSON of the spec (specs/advocate.md, Request), read strictly: the documented shape and nothing else (ruling R-E2). Anything outside it is
// refused here, with a RequestError, before the service makes a search. The service holds a buyer key and posts at most one escrow a job, for the chat
// sub-job of its model call after the search, so a refusal locks nothing of the service: the runtime fails the job, and the hirer reclaims the escrow after
// its deliver_by. Every refusal of the request is bad_shape (400), with a message that names the field: there is no 422 in the intake.
//
// A length is counted in characters, Unicode code points, as JSON Schema's maxLength counts them. The subject, the side, the audience and the language are
// trimmed before they are checked; the length is short or standard exactly, as given (ruling R-E21). An optional field given as null is refused like any other
// value that is not of its kind. The side is for or against in any case, kept in lower case, or a position in words, kept as it was given once trimmed: it
// is what declared_bias.side says in every brief.
import { clip } from '@vsa/service-kit/text';

/** A refusal of the request: always bad_shape (400), with a message in words for a person that names the field. */
export class RequestError extends Error {
  readonly code: 'bad_shape';
  readonly status: 400;
  constructor(message: string) {
    super(message);
    this.name = 'RequestError';
    this.code = 'bad_shape';
    this.status = 400;
  }
}

export const MAX_SUBJECT_CHARS = 300;
export const MAX_SIDE_CHARS = 120;
export const MAX_AUDIENCE_CHARS = 200;
export const LENGTHS = ['short', 'standard'] as const;
export type Length = (typeof LENGTHS)[number];
export const DEFAULT_LENGTH: Length = 'standard';
export const DEFAULT_LANGUAGE = 'en';
/** A language code: 2 to 8 letters, and hyphen-separated subtags of 1 to 8 letters or digits (en-GB, zh-Hant-TW, es-419), at most 16 characters in all. */
export const LANGUAGE_PATTERN = '^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$';

export interface AdvocateRequest {
  subject: string;
  /** for, against, or a position in words: the side the brief argues, as declared_bias.side gives it. */
  side: string;
  /** Who the brief is written for, or null when the request names no one. */
  audience: string | null;
  length: Length;
  /** The code of the language the model is asked to write the brief in, as it was given once trimmed. */
  language: string;
}

const TOP_LEVEL_KEYS = ['subject', 'side', 'audience', 'length', 'language'];
const SIDES = ['for', 'against'];
const LANGUAGE = new RegExp(LANGUAGE_PATTERN);
const MAX_LANGUAGE_CHARS = 16;
const SIDE_RULE = `for, against, or a position in words of 1 to ${MAX_SIDE_CHARS} characters`;
const LANGUAGE_RULE = `a language code such as "en" or "en-GB": 2 to 8 letters, with optional hyphen-separated subtags of 1 to 8 letters or digits, at most ${MAX_LANGUAGE_CHARS} characters`;

/** The characters of a text: Unicode code points, the unit JSON Schema's minLength and maxLength count. */
const chars = (s: string): number => [...s].length;
/** Does the text hold a letter or a digit, in any script? */
const hasWord = (s: string): boolean => /[\p{L}\p{N}]/u.test(s);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, key: string): boolean => Object.hasOwn(o, key);

/** A text of 1 to `max` characters once trimmed, or the refusal that names `field`. */
function trimmedText(value: unknown, field: string, max: number): string {
  const rule = `${field} must be text of 1 to ${max} characters`;
  if (typeof value !== 'string') throw new RequestError(rule);
  const text = value.trim();
  if (chars(text) < 1 || chars(text) > max) throw new RequestError(rule);
  return text;
}

function parseSubject(value: unknown): string {
  const subject = trimmedText(value, 'subject', MAX_SUBJECT_CHARS);
  if (!hasWord(subject)) throw new RequestError('subject must hold at least one letter or digit');
  return subject;
}

function parseSide(value: unknown): string {
  if (typeof value !== 'string') throw new RequestError(`side must be ${SIDE_RULE}`);
  const side = value.trim();
  if (SIDES.includes(side.toLowerCase())) return side.toLowerCase();
  if (chars(side) < 1 || chars(side) > MAX_SIDE_CHARS) throw new RequestError(`side must be ${SIDE_RULE}`);
  if (!hasWord(side)) throw new RequestError('side must hold at least one letter or digit');
  return side;
}

function parseLength(value: unknown): Length {
  if (value !== 'short' && value !== 'standard') throw new RequestError('length must be "short" or "standard"');
  return value;
}

function parseLanguage(value: unknown): string {
  if (typeof value !== 'string') throw new RequestError(`language must be ${LANGUAGE_RULE}`);
  const language = value.trim();
  // auto is made of letters, but it names no language: the request names the language the model is asked to write the brief in, en by default.
  if (/^auto$/i.test(language)) {
    throw new RequestError(`language must be ${LANGUAGE_RULE}; auto is not one: the request names the language the model is asked to write the brief in, ${DEFAULT_LANGUAGE} by default`);
  }
  if (language.length > MAX_LANGUAGE_CHARS || !LANGUAGE.test(language)) throw new RequestError(`language must be ${LANGUAGE_RULE}`);
  return language;
}

/**
 * Reads the request JSON (the text of the wire message's content, never the wire message itself). Checks run in this order and the first failure is thrown:
 * JSON, object, unknown keys, subject, side, audience, length, language.
 */
export function parseRequest(requestJson: string): AdvocateRequest {
  let value: unknown;
  try {
    value = JSON.parse(requestJson);
  } catch (e) {
    throw new RequestError(`the request is not valid JSON: ${clip(e instanceof Error ? e.message : String(e), 120)}`);
  }
  if (!isObject(value)) throw new RequestError('the request must be a JSON object');
  const extra = Object.keys(value).filter((key) => !TOP_LEVEL_KEYS.includes(key));
  if (extra.length > 0) {
    const named = extra.slice(0, 5).map((key) => `"${clip(key, 40)}"`).join(', ');
    throw new RequestError(`unknown key${extra.length > 1 ? 's' : ''}: ${named}${extra.length > 5 ? ` and ${extra.length - 5} more` : ''}`);
  }
  if (!has(value, 'subject')) throw new RequestError(`subject is required: the subject of the brief, text of 1 to ${MAX_SUBJECT_CHARS} characters`);
  const subject = parseSubject(value.subject);
  if (!has(value, 'side')) throw new RequestError(`side is required: ${SIDE_RULE}`);
  const side = parseSide(value.side);
  const audience = has(value, 'audience') ? trimmedText(value.audience, 'audience', MAX_AUDIENCE_CHARS) : null;
  const length = has(value, 'length') ? parseLength(value.length) : DEFAULT_LENGTH;
  const language = has(value, 'language') ? parseLanguage(value.language) : DEFAULT_LANGUAGE;
  return { subject, side, audience, length, language };
}
