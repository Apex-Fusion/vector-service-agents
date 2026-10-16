// agents/audio-snippets/src/request.ts
// The request JSON of the spec (specs/audio-snippets.md, Request), read strictly: the documented shape and nothing else (ruling R-D4). Anything outside it is
// refused here, with a RequestError, before the service fetches a byte. The service holds no key and posts nothing, so a refusal locks nothing of the service;
// the runtime fails the job, and the hirer reclaims the escrow after its deliver_by.
//
// Which errors are 400 and which are 422. A request that is malformed is 400: bad_json, bad_shape, base64_too_large, language_bad, language_unsupported,
// nothing_to_find, range_bad. A request that is well formed but names media the service cannot use is 422: source_fetch_failed, source_too_large,
// source_unsupported, source_mime_mismatch, media_unreadable, media_no_audio, media_too_long (thrown by src/media.ts) and range_out_of_media (src/run.ts).
import { clip } from '@vsa/service-kit/text';
import { WHISPER_LANGUAGES } from './languages.ts';
import { tokensOf } from './normalize.ts';

/** The types an inline source may declare, in this order (R-D4). */
export const MIMES = ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/flac', 'audio/webm', 'video/mp4', 'video/webm', 'video/quicktime'] as const;
export type Mime = (typeof MIMES)[number];
export type ClipFormat = 'mp3' | 'wav';
export interface Range { start_s: number; end_s: number }
export interface SnippetsRequest {
  source: { url: string } | { audio_b64: string; mime: Mime };
  /** auto, or the code the model is asked for: the first part of the code given, in lower case (en-GB is en). */
  language: string;
  query?: string;
  quotes?: string[];
  ranges?: Range[];
  return_clips: boolean;
  clip_format: ClipFormat;
}

export type RequestErrorCode =
  | 'bad_json' | 'bad_shape' | 'base64_too_large' | 'language_bad' | 'language_unsupported' | 'nothing_to_find' | 'range_bad'
  | 'source_fetch_failed' | 'source_too_large' | 'source_unsupported' | 'source_mime_mismatch' | 'media_unreadable' | 'media_no_audio' | 'media_too_long' | 'range_out_of_media';

const STATUS: Record<RequestErrorCode, 400 | 422> = {
  bad_json: 400, bad_shape: 400, base64_too_large: 400, language_bad: 400, language_unsupported: 400, nothing_to_find: 400, range_bad: 400,
  source_fetch_failed: 422, source_too_large: 422, source_unsupported: 422, source_mime_mismatch: 422, media_unreadable: 422, media_no_audio: 422, media_too_long: 422,
  range_out_of_media: 422,
};

/** A refusal with a stable `code` for the caller to branch on, a `message` in words for a person, and the HTTP `status` the service answers with. */
export class RequestError extends Error {
  readonly code: RequestErrorCode;
  readonly status: 400 | 422;
  constructor(code: RequestErrorCode, message: string) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
    this.status = STATUS[code];
  }
}

/** Raw media in an inline source: the hosted MCP server caps a request at 1 MB, and base64 adds a third. */
export const MAX_INLINE_BYTES = 600_000;
export const DEFAULT_LANGUAGE = 'en';
export const MAX_QUERY_CHARS = 500;
export const MAX_QUOTE_CHARS = 300;
export const MAX_QUOTES = 20;
export const MAX_RANGES = 20;

const TOP_LEVEL_KEYS = ['source', 'language', 'query', 'quotes', 'ranges', 'return_clips', 'clip_format'];
// A language code is 2 to 8 letters, or a BCP-47 tag: that code and hyphen-separated subtags of 1 to 8 letters or digits (en-GB, zh-Hant-TW, es-419), at most
// 16 characters: the Pipeline's rule. JavaScript's $ does not match before a final line break.
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const MAX_LANGUAGE_LENGTH = 16;
// Standard base64 with its padding. The length is checked on its own, and the class is a plain loop, linear on 800,000 characters.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The characters of a text: Unicode code points, the unit JSON Schema's minLength and maxLength count. */
export const chars = (s: string): number => [...s].length;
const bad = (message: string) => new RequestError('bad_shape', message);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, key: string) => Object.hasOwn(o, key);
/** The size of the bytes behind a base64 text, without decoding it: three bytes for every four characters, less the padding. */
function rawBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function parseSource(value: unknown): SnippetsRequest['source'] {
  const shape = 'source must be exactly one of {"url"} or {"audio_b64", "mime"}';
  if (!isObject(value)) throw bad(shape);
  if (has(value, 'url')) {
    if (Object.keys(value).length !== 1) throw bad(shape);
    if (typeof value.url !== 'string' || value.url === '') throw bad('source.url must be the text of an https URL');
    return { url: value.url };
  }
  if (!has(value, 'audio_b64') || !has(value, 'mime') || Object.keys(value).length !== 2) throw bad(shape);
  const mime = value.mime;
  if (typeof mime !== 'string' || !(MIMES as readonly string[]).includes(mime)) throw bad(`source.mime must be one of ${MIMES.join(', ')}`);
  const data = value.audio_b64;
  if (typeof data !== 'string' || data === '') throw bad('source.audio_b64 must be base64 text');
  // The size first: a text too long to be 600,000 bytes is too large whatever it holds, and no pattern needs to run over it.
  if (rawBytes(data) > MAX_INLINE_BYTES) throw new RequestError('base64_too_large', `source.audio_b64 holds more than ${MAX_INLINE_BYTES} bytes of media; pass an https URL instead`);
  if (data.length % 4 !== 0 || !BASE64.test(data)) throw bad('source.audio_b64 must be standard base64 text, padded, with no line breaks');
  return { audio_b64: data, mime: mime as Mime };
}

function parseLanguage(value: unknown): string {
  if (typeof value !== 'string') throw bad('language must be text: auto, or a language code such as "en" or "en-GB"');
  if (/^auto$/i.test(value)) return 'auto';
  if (value.length > MAX_LANGUAGE_LENGTH || !LANGUAGE.test(value)) {
    throw new RequestError('language_bad', `language must be auto, or a language code such as "en" or "en-GB": 2 to 8 letters, with optional hyphen-separated subtags, at most ${MAX_LANGUAGE_LENGTH} characters`);
  }
  const primary = value.split('-')[0].toLowerCase();
  if (!WHISPER_LANGUAGES.includes(primary)) {
    throw new RequestError('language_unsupported', `the speech model does not know the language "${clip(primary, 16)}": use auto, or one of the ${WHISPER_LANGUAGES.length} codes the manifest lists (en, de, fr, hr and the rest)`);
  }
  return primary;
}

/** A text of 1 to `max` characters with at least one letter or digit, or the refusal that names `what`. */
function findable(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string' || chars(value) < 1 || chars(value) > max) throw bad(`${what} must be text of 1 to ${max} characters`);
  if (tokensOf(value).length === 0) throw bad(`${what} must hold at least one letter or digit`);
  return value;
}

function parseRange(value: unknown, i: number): Range {
  if (!isObject(value) || Object.keys(value).length !== 2 || !has(value, 'start_s') || !has(value, 'end_s')) throw bad(`ranges[${i}] must be exactly {"start_s", "end_s"}`);
  const start = value.start_s;
  const end = value.end_s;
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) throw bad(`ranges[${i}] must hold two finite numbers of seconds`);
  if (start < 0 || end <= start) throw new RequestError('range_bad', `ranges[${i}] must have 0 <= start_s < end_s, and has ${start} and ${end}`);
  return { start_s: start, end_s: end };
}

/**
 * Reads the request JSON (the text of the wire message's content, never the wire message itself). Checks run in this order and the first failure is thrown:
 * JSON, object, unknown keys, source, language, query, quotes, ranges, at least one of the three, return_clips, clip_format.
 */
export function parseRequest(requestJson: string): SnippetsRequest {
  let value: unknown;
  try {
    value = JSON.parse(requestJson);
  } catch (e) {
    throw new RequestError('bad_json', `the request is not valid JSON: ${clip(e instanceof Error ? e.message : String(e), 120)}`);
  }
  if (!isObject(value)) throw bad('the request must be a JSON object');
  const extra = Object.keys(value).filter((key) => !TOP_LEVEL_KEYS.includes(key));
  if (extra.length > 0) throw bad(`unknown key${extra.length > 1 ? 's' : ''}: ${extra.slice(0, 5).map((key) => `"${clip(key, 40)}"`).join(', ')}${extra.length > 5 ? ` and ${extra.length - 5} more` : ''}`);

  const source = parseSource(value.source);
  const language = has(value, 'language') ? parseLanguage(value.language) : DEFAULT_LANGUAGE;
  const query = has(value, 'query') ? findable(value.query, MAX_QUERY_CHARS, 'query') : undefined;

  let quotes: string[] | undefined;
  if (has(value, 'quotes')) {
    const list = value.quotes;
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_QUOTES) throw bad(`quotes must be a list of 1 to ${MAX_QUOTES} texts`);
    quotes = list.map((quote, i) => findable(quote, MAX_QUOTE_CHARS, `quotes[${i}]`));
  }
  let ranges: Range[] | undefined;
  if (has(value, 'ranges')) {
    const list = value.ranges;
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_RANGES) throw bad(`ranges must be a list of 1 to ${MAX_RANGES} objects {"start_s", "end_s"}`);
    ranges = list.map(parseRange);
  }
  if (query === undefined && quotes === undefined && ranges === undefined) throw new RequestError('nothing_to_find', 'the request must have at least one of query, quotes and ranges');

  let returnClips = false;
  if (has(value, 'return_clips')) {
    if (typeof value.return_clips !== 'boolean') throw bad('return_clips must be true or false');
    returnClips = value.return_clips;
  }
  let clipFormat: ClipFormat = 'mp3';
  if (has(value, 'clip_format')) {
    // A format with no clips would be ignored; refusing it keeps "clip_format is given" and "clips are cut" the same fact for everything downstream.
    if (!returnClips) throw bad('clip_format is only accepted with return_clips true');
    if (value.clip_format !== 'mp3' && value.clip_format !== 'wav') throw bad('clip_format must be "mp3" or "wav"');
    clipFormat = value.clip_format;
  }
  return {
    source, language, ...(query === undefined ? {} : { query }), ...(quotes === undefined ? {} : { quotes }), ...(ranges === undefined ? {} : { ranges }),
    return_clips: returnClips, clip_format: clipFormat,
  };
}
