// agents/document-pipeline/src/request.ts
// The request JSON of the spec (specs/document-pipeline.md, Request), read strictly: the documented shape and nothing else. Anything outside it is
// refused here, with a RequestError, before the service fetches a byte or posts an escrow, because after that every mistake costs fees or a stranded lock.
//
// Which errors are 400 and which are 422. A request that is malformed is 400: bad_json, bad_shape, schema_required, max_pages_range,
// base64_too_large, language_bad. A request that is well formed but names a document the service cannot use is 422: source_fetch_failed,
// source_mime_mismatch, source_unsupported, source_too_large (thrown by src/source.ts) and unreadable_source (thrown by src/render.ts).
// RequestError lives here so that the server maps one class to a status.
import { clip } from './text.ts';

export type Task = 'summary' | 'extract';

export interface PipelineRequest {
  source: { url: string } | { pdf_b64: string; mime: 'application/pdf' } | { image_b64: string; mime: 'image/png' | 'image/jpeg' };
  task: Task;
  /** A JSON Schema. Present exactly when `task` is `extract`. */
  schema?: Record<string, unknown>;
  language: string;
  max_pages: number;
}

export type RequestErrorCode =
  | 'bad_json' | 'bad_shape' | 'schema_required' | 'max_pages_range' | 'base64_too_large' | 'language_bad'
  | 'source_fetch_failed' | 'source_mime_mismatch' | 'source_unsupported' | 'source_too_large' | 'unreadable_source';

const STATUS: Record<RequestErrorCode, 400 | 422> = {
  bad_json: 400, bad_shape: 400, schema_required: 400, max_pages_range: 400, base64_too_large: 400, language_bad: 400,
  source_fetch_failed: 422, source_mime_mismatch: 422, source_unsupported: 422, source_too_large: 422, unreadable_source: 422,
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
/** Pages read per document in v1; also the default. */
export const MAX_PAGES = 5;
export const DEFAULT_LANGUAGE = 'en';

const TOP_LEVEL_KEYS = ['source', 'task', 'schema', 'language', 'max_pages'];
// The mimes an inline source may claim, by field. A PDF is only ever application/pdf.
const INLINE_MIMES = { pdf_b64: ['application/pdf'], image_b64: ['image/png', 'image/jpeg'] } as const;
// A language code is 2 to 8 letters, or a BCP-47 tag: that code and hyphen-separated subtags of 1 to 8 letters or digits (en-GB, zh-Hant-TW, es-419).
// It reaches the instructions of the model, so it is checked as text and nothing else can ride in it. JavaScript's $ does not match before a final line break.
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const MAX_LANGUAGE_LENGTH = 16;
// Standard base64 with its padding. The length is checked on its own, and the character class is a plain loop so that the test is linear on 800,000 characters.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const bad = (message: string) => new RequestError('bad_shape', message);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, key: string) => Object.hasOwn(o, key);


/** The size of the bytes behind a base64 text, without decoding it: three bytes for every four characters, less the padding. */
function rawBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function parseSource(value: unknown): PipelineRequest['source'] {
  const shape = 'source must be exactly one of {"url"}, {"pdf_b64", "mime"} or {"image_b64", "mime"}';
  if (!isObject(value)) throw bad(shape);
  if (has(value, 'url')) {
    if (Object.keys(value).length !== 1) throw bad(shape);
    if (typeof value.url !== 'string' || value.url === '') throw bad('source.url must be the text of an https URL');
    return { url: value.url };
  }
  const field = has(value, 'pdf_b64') ? 'pdf_b64' : has(value, 'image_b64') ? 'image_b64' : null;
  if (field === null || Object.keys(value).length !== 2 || !has(value, 'mime')) throw bad(shape);
  const allowed: readonly string[] = INLINE_MIMES[field];
  const mime = value.mime;
  if (typeof mime !== 'string' || !allowed.includes(mime)) throw bad(`source.mime for ${field} must be ${allowed.map((m) => `"${m}"`).join(' or ')}`);
  const data = value[field];
  if (typeof data !== 'string' || data === '') throw bad(`source.${field} must be base64 text`);
  // The size first: a text too long to be 600,000 bytes is too large whatever it holds, and no pattern needs to run over it.
  if (rawBytes(data) > MAX_INLINE_BYTES) throw new RequestError('base64_too_large', `source.${field} holds more than ${MAX_INLINE_BYTES} bytes of media; pass an https URL instead`);
  if (data.length % 4 !== 0 || !BASE64.test(data)) throw bad(`source.${field} must be standard base64 text, padded, with no line breaks`);
  return field === 'pdf_b64' ? { pdf_b64: data, mime: 'application/pdf' } : { image_b64: data, mime: mime as 'image/png' | 'image/jpeg' };
}

/**
 * Reads the request JSON (the text of the wire message's content, not the wire message itself). Checks run in this order and the first failure is
 * thrown: JSON, object, unknown keys, source, task, schema, max_pages, language.
 */
export function parseRequest(requestJson: string): PipelineRequest {
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

  const task = value.task;
  if (task !== 'summary' && task !== 'extract') throw bad('task must be "summary" or "extract"');

  let schema: Record<string, unknown> | undefined;
  if (has(value, 'schema')) {
    // A schema with a summary would be ignored; refusing it keeps "schema is present" and "task is extract" the same fact for everything downstream.
    if (task !== 'extract') throw bad('schema is only accepted with task "extract"');
    if (!isObject(value.schema)) throw bad('schema must be a JSON Schema object');
    schema = value.schema;
  } else if (task === 'extract') {
    throw new RequestError('schema_required', 'task "extract" needs a schema: a JSON Schema object that describes what to extract');
  }

  let maxPages = MAX_PAGES;
  if (has(value, 'max_pages')) {
    if (typeof value.max_pages !== 'number') throw bad(`max_pages must be a whole number from 1 to ${MAX_PAGES}`);
    if (!Number.isInteger(value.max_pages) || value.max_pages < 1 || value.max_pages > MAX_PAGES) throw new RequestError('max_pages_range', `max_pages must be a whole number from 1 to ${MAX_PAGES}`);
    maxPages = value.max_pages;
  }

  let language = DEFAULT_LANGUAGE;
  if (has(value, 'language')) {
    if (typeof value.language !== 'string') throw bad('language must be text: a language code such as "en" or "en-GB"');
    if (value.language.length > MAX_LANGUAGE_LENGTH || !LANGUAGE.test(value.language)) throw new RequestError('language_bad', `language must be a language code such as "en" or "en-GB": 2 to 8 letters, with optional hyphen-separated subtags, at most ${MAX_LANGUAGE_LENGTH} characters`);
    language = value.language;
  }

  return { source, task, ...(schema === undefined ? {} : { schema }), language, max_pages: maxPages };
}
