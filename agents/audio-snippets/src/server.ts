// agents/audio-snippets/src/server.ts
// The service behind the template runtime: the manifest it publishes, on the HTTP surface of packages/service-kit (createJobServer: the three routes, the token
// of the runtime on POST /, one job at a time, the 102 Processing heartbeat, the body cap, refusals as {error, message}). The runtime holds the supplier key,
// claims the escrow of a hirer and posts the job to this service as the body of POST /; the service transcribes and matches (src/run.ts) and answers with the
// result, which the runtime hashes into the one receipt it signs. The service holds no key. What is its own:
//
//   GET  /healthz     503 {ok: false, reason: "low_disk"} once the last check found less free space in the temporary directory than a job needs
//                     (src/disk.ts). The check is made at most once a minute, in the background: a request is answered from the last one and never waits.
//   POST /            the request JSON read by parseRequest (src/request.ts) and run by runSnippets, with the deadline of the job set on its arrival. A refusal
//                     is {error: code, message} with its status: 400 for a request the intake refuses and 422 for media it cannot use (RequestError), 422
//                     for a job cut at its deadline, and 500 (asr_failed, clip_failed) or 503 (low_disk) for a failure on this side, whose message is fixed
//                     text for the buyer and whole in the log (SnippetsError). A job whose caller hangs up is stopped (abortOnClose, ruling R-D24): the
//                     runtime aborts its call at its own budget and frees the escrow, and a job nobody receives would hold the one slot for nothing. It
//                     fails with aborted (499), which the log keeps and no caller reads.
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { HealthMonitor, JobSlot, createJobServer, envInt, given, requiredEnv, statusChip, statusSince } from '@vsa/service-kit';
import type { Refusal } from '@vsa/service-kit';
import { REGISTRY_ADDRESS } from '@vsa/vector-read';
import { JOB_DEADLINE_MS } from './budget.ts';
import { INLINE_CLIPS_BYTES } from './clips.ts';
import { assertScratch } from './disk.ts';
import { gapsFor } from './gaps.ts';
import { WHISPER_LANGUAGES } from './languages.ts';
import { MAX_DURATION_S, MAX_SOURCE_BYTES } from './media.ts';
import { whisperSize } from './model.ts';
import { DEFAULT_LANGUAGE, MAX_INLINE_BYTES, MAX_QUERY_CHARS, MAX_QUOTES, MAX_QUOTE_CHARS, MAX_RANGES, MIMES, RequestError, parseRequest } from './request.ts';
import type { SnippetsRequest } from './request.ts';
import { SnippetsError } from './result.ts';
import type { SnippetsResult } from './result.ts';
import { runSnippets as realRunSnippets } from './run.ts';
import type { RunDeps } from './run.ts';

export { HEARTBEAT_MS, JobSlot, MAX_BODY, WireError, envInt, parseWire, requiredEnv } from '@vsa/service-kit';

// --- The environment -----------------------------------------------------------------------------------------------------------------
/**
 * The window the advert gives a job, at least 25 min: the deadline of a job (JOB_DEADLINE_MS) and the service timeout of the runtime, 60 s later, are fixed for
 * it, and a window below them would be a promise the service cannot keep.
 */
export const MIN_PROCESSING_WINDOW_MS = 1_500_000;
function processingWindow(v: string | undefined): number {
  const ms = envInt('ADVERT_MAX_PROCESSING_MS', v, MIN_PROCESSING_WINDOW_MS);
  if (ms < MIN_PROCESSING_WINDOW_MS) {
    throw new Error(`environment variable ADVERT_MAX_PROCESSING_MS must be at least ${MIN_PROCESSING_WINDOW_MS} (the window of 25 min that the deadline of a job, ${JOB_DEADLINE_MS} ms, assumes), got ${ms}`);
  }
  return ms;
}

// --- The manifest --------------------------------------------------------------------------------------------------------------------
const SPEC_URL = 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/audio-snippets.md';
const SOURCE_URL = 'https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/audio-snippets';
/** What a buyer may post: the wire payload, 900000 bytes (the runtime takes 1 MB of JSON that holds it escaped). The service itself reads up to MAX_BODY. */
const WIRE_PAYLOAD_BYTES = 900_000;
// Standard base64 with its padding and nothing else; the form parseRequest accepts, and 800000 characters are 600000 raw bytes.
const BASE64_PATTERN = '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$';
// A language code: 2 to 8 letters and hyphen-separated subtags of 1 to 8 letters or digits (en, en-GB, zh-Hant-TW, es-419), at most 16 characters; or auto.
const LANGUAGE_PATTERN = '^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$';

/**
 * What the intake (src/request.ts) accepts, as a JSON Schema: test/server.test.ts holds the two to each other on a table of requests. What a schema cannot say
 * is in `notes` below: a quote and the query must hold a letter or a digit, a range must start before it ends, and the languages the model knows.
 */
const REQUEST_SCHEMA = {
  type: 'object',
  required: ['source'],
  additionalProperties: false,
  properties: {
    source: {
      description: `The media: an https URL of an audio or video file (at most ${MAX_SOURCE_BYTES} bytes), or the file itself as base64 with its type`,
      oneOf: [
        { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', minLength: 9, pattern: '^https://', description: 'An https URL; the service fetches it itself' } } },
        {
          type: 'object', required: ['audio_b64', 'mime'], additionalProperties: false,
          properties: {
            audio_b64: {
              type: 'string', minLength: 4, maxLength: (MAX_INLINE_BYTES / 3) * 4, pattern: BASE64_PATTERN,
              description: `The media as standard base64 text, padded, with no line breaks; at most ${MAX_INLINE_BYTES} bytes of media`,
            },
            mime: { enum: [...MIMES] },
          },
        },
      ],
    },
    language: {
      type: 'string', anyOf: [{ pattern: '^[Aa][Uu][Tt][Oo]$' }, { maxLength: 16, pattern: LANGUAGE_PATTERN }], default: DEFAULT_LANGUAGE,
      description: 'The language of the speech: auto, or a language code such as en or en-GB, 2 to 8 letters and optional hyphen-separated subtags of up to 8 letters or digits, at most 16 characters',
    },
    query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_CHARS, description: 'A question in words, matched by keyword overlap at segment level' },
    quotes: {
      type: 'array', minItems: 1, maxItems: MAX_QUOTES, items: { type: 'string', minLength: 1, maxLength: MAX_QUOTE_CHARS },
      description: 'Quotes as they were said, or nearly: each one is matched once, where it is said first',
    },
    ranges: {
      type: 'array', minItems: 1, maxItems: MAX_RANGES,
      items: { type: 'object', required: ['start_s', 'end_s'], additionalProperties: false, properties: { start_s: { type: 'number', minimum: 0 }, end_s: { type: 'number', exclusiveMinimum: 0 } } },
      description: 'Time ranges in seconds, taken as given, each with the words inside it',
    },
    return_clips: { type: 'boolean', default: false, description: 'Cut a clip for each match' },
    clip_format: { enum: ['mp3', 'wav'], default: 'mp3', description: 'The format of the clips: mp3 at 64 kbps or 16 kHz mono wav, only with return_clips true' },
  },
  // At least one of the three things to find, and a clip format only with clips. Each required name is defined beside it, as strict mode wants.
  anyOf: [{ properties: { query: true }, required: ['query'] }, { properties: { quotes: true }, required: ['quotes'] }, { properties: { ranges: true }, required: ['ranges'] }],
  allOf: [{ if: { properties: { clip_format: true }, required: ['clip_format'] }, then: { properties: { return_clips: { const: true } }, required: ['return_clips'] } }],
};
const NOTES = [
  'A quote and the query must each hold at least one letter or digit, and a range must start before it ends; a range that ends after the media is refused with range_out_of_media (422) once the media is read.',
  `The language is auto, or a code whose first part is one of the ${WHISPER_LANGUAGES.length} the speech model knows: ${WHISPER_LANGUAGES.join(', ')}. Any other is refused with language_unsupported (400).`,
  `A source URL must be https and public and must not redirect: the service fetches it itself, at most ${MAX_SOURCE_BYTES} bytes, reads the type of the media from its first bytes, and refuses one that differs from the type the request declared or the server served (source_mime_mismatch, 422).`,
];

export function manifestFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    // An AGENT_VERSION that is empty or blank is not set (given): an empty version would be published in the manifest the advert hashes.
    schema: 'vector.agent-manifest.v1', name: 'Audio Snippets', capability_id: 'audio.transcript.snippets.v1', version: given(env.AGENT_VERSION) || '0.1.0',
    description: 'A word-timed transcript of an audio or video file, plus the cut points for the quotes or the question you give it, and optionally the cut clips.',
    operator: { name: 'Apex Fusion Foundation', contact: requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest") },
    identity: { did: env.AGENT_DID ?? '', controller_pkh: env.SUPPLIER_PKH ?? '', registry_address: REGISTRY_ADDRESS },
    keys: { supplier_pkh: env.SUPPLIER_PKH ?? '', pub_key_hex: env.SUPPLIER_PUB_KEY_HEX ?? '' },
    interface: {
      request_schema: REQUEST_SCHEMA,
      response_schema: { $ref: `${SPEC_URL}#response` },
      routes: { job: '/v1/job', status: '/status', capability: '/capability' },
      notes: [...NOTES],
    },
    terms: {
      price_lovelace: envInt('ADVERT_PRICE_LOVELACE', env.ADVERT_PRICE_LOVELACE, 2_000_000), supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000,
      max_processing_ms: processingWindow(env.ADVERT_MAX_PROCESSING_MS),
      input_limits: {
        request_bytes: WIRE_PAYLOAD_BYTES, source_bytes: MAX_SOURCE_BYTES, inline_media_bytes: MAX_INLINE_BYTES, duration_s: MAX_DURATION_S,
        query_chars: MAX_QUERY_CHARS, quotes: MAX_QUOTES, quote_chars: MAX_QUOTE_CHARS, ranges: MAX_RANGES, inline_clip_bytes: INLINE_CLIPS_BYTES,
      },
    },
    behaviour: {
      data_handling: 'The media, the language, the query, the quotes and the ranges are held in memory while a job runs; the media is also written to a private temporary directory, with its decode to 16 kHz WAV and each clip while it is cut, and the directory is removed when the job ends. '
        + 'The speech model runs in the service from files built into its image, so nothing leaves but the fetch of the media from the host of its URL. On the ledger the escrow carries only the sha256 of the wire payload, and the media stays off the ledger. '
        + 'The log carries job outcomes, never a request, a transcript or the media.',
      third_parties: ['the host of the source URL'],
    },
    status: { chip: statusChip(env.AGENT_STATUS_CHIP, 'proposed'), since: statusSince(env.AGENT_STATUS_SINCE, '2026-10-13') },
    gaps: [...gapsFor(whisperSize(env.WHISPER_MODEL))],
    links: { spec: SPEC_URL, source: SOURCE_URL, explorer_advert: env.ADVERT_EXPLORER_URL ?? '' },
  };
}
export type AgentManifest = ReturnType<typeof manifestFromEnv>;

/** The four fields the operator supplies, as the placeholders the template file shows. */
export const TEMPLATE_ENV = { OPERATOR_CONTACT: '<OPERATOR_CONTACT>', AGENT_DID: '<AGENT_DID>', SUPPLIER_PKH: '<SUPPLIER_PKH>', SUPPLIER_PUB_KEY_HEX: '<SUPPLIER_PUB_KEY_HEX>' } as const;
/** The text of agent.json.template: the manifest with the placeholders, indented, with a line break at the end. `pnpm --filter @vsa/audio-snippets template` writes it. */
export const renderTemplate = (): string => `${JSON.stringify(manifestFromEnv(TEMPLATE_ENV), null, 2)}\n`;

// --- The health check ----------------------------------------------------------------------------------------------------------------
/** How long the answer of a disk check stands, and how long a check may take before it counts as failed. */
export const DISK_TTL_MS = 60_000;
export const DISK_TIMEOUT_MS = 5_000;

// --- The server ----------------------------------------------------------------------------------------------------------------------
export interface ServerOptions {
  manifest: AgentManifest;
  /** The token the runtime sends as the authorization header of every call (SERVICE_AUTH_HEADER), which POST / requires. A server is never made without one. */
  authHeader: string;
  /** Everything a run is given but its deadline, which the server sets for each request. */
  deps: Omit<RunDeps, 'deadlineMs'>;
  /** Test seam: a test injects its own run; the service always runs the real one. */
  runSnippets?: (req: SnippetsRequest, deps: RunDeps) => Promise<SnippetsResult>;
  /** Where a line of the log goes; the default prints it with the name of the service. */
  log?: (line: string) => void;
  /** How long a disk check stands (DISK_TTL_MS), and how long it may take (DISK_TIMEOUT_MS). */
  diskTtlMs?: number;
  diskTimeoutMs?: number;
  /** How often a job that is running is sent an interim line: HEARTBEAT_MS by default, and no more than that. */
  heartbeatMs?: number;
  /** The slot jobs run in; a service that wants to stop drains it. A new one by default. */
  slot?: JobSlot;
}
/** The log of the process: one line each on stdout, with the name of the service. */
export const defaultLog = (line: string): void => { console.log(`[audio-snippets] ${line}`); };

/** A refusal of the intake or the media (RequestError, the request's) or of a job (SnippetsError, the job's), as the shared server answers it; null for anything else. */
function refusalOf(e: unknown): Refusal | null {
  if (e instanceof RequestError) return { code: e.code, status: e.status, message: e.message, kind: 'request' };
  if (e instanceof SnippetsError) return { code: e.code, status: e.status, message: e.message, kind: 'job' };
  return null;
}

export function createServer(opts: ServerOptions): Server {
  const { deps } = opts;
  const run = opts.runSnippets ?? realRunSnippets;
  const log = opts.log ?? defaultLog;
  // Whether the temporary directory has room for a job, checked at most once a minute, in the background.
  const health = new HealthMonitor({
    check: () => assertScratch(deps.scratchRoot ?? tmpdir(), deps.minFreeBytes, deps.freeBytes), reason: 'low_disk', clock: deps.clock,
    ttlMs: opts.diskTtlMs ?? DISK_TTL_MS, timeoutMs: opts.diskTimeoutMs ?? DISK_TIMEOUT_MS,
    // A change of state is logged once, with its reason, and a repeat is not.
    onChange: (healthy, failure) => { if (healthy) log('disk check passed again'); else log(`disk check failed: ${failure}`); },
  });
  return createJobServer<SnippetsRequest, SnippetsResult>({
    manifestText: JSON.stringify(opts.manifest), authHeader: opts.authHeader, parse: parseRequest, abortOnClose: true,
    run: (request, arrivedAt, signal) => run(request, { ...deps, deadlineMs: arrivedAt + JOB_DEADLINE_MS, ...(signal === undefined ? {} : { signal }) }),
    done: (result, arrivedAt) => {
      log(`job done in ${deps.clock() - arrivedAt} ms: ${result.source.duration_s} s of media; matches ${result.matches.length}, unmatched ${result.unmatched.length}, clips ${result.clips.length}`);
    },
    refusalOf, health, clock: deps.clock, log,
    ...(opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs }), ...(opts.slot === undefined ? {} : { slot: opts.slot }),
  });
}
