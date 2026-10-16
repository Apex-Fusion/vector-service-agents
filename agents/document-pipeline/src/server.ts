// agents/document-pipeline/src/server.ts
// The service behind the template runtime: the manifest it publishes and the three routes it answers. The runtime holds the supplier key, claims the
// escrow of a hirer and posts the job to this service as the body of POST / (the wire message below); the service runs the pipeline (src/orchestrate.ts)
// and answers with the result, which the runtime hashes into the one receipt it signs. The service holds the buyer key and nothing else (src/start.ts).
//
//   GET  /healthz     {ok: true}, or 503 {ok: false, reason: "insufficient_float"} once the last check of the buyer wallet failed. The check is made at most
//                     once a minute, in the background: a request is answered from the last one and never waits for the next.
//   GET  /agent.json  the manifest, the bytes JSON.stringify gives, which the advert hashes.
//                     These two are matched on their path, whatever the query, and a HEAD of either gets the headers of the GET and no body.
//   POST /            the wire message only, and only from the runtime: the authorization header must be exactly the token the service was given
//                     (SERVICE_AUTH_HEADER, which the template runtime sends with every call, ruling R50), or the answer is 401 {error: "unauthorized"}
//                     with no detail, before the body is read and before the job slot is taken. At most 1 MB, one job at a time: a second one gets 409
//                     {error: "busy"}. While the job runs the server writes "102 Processing" every minute, so that the runtime's fetch does not give up
//                     on the silence (HEARTBEAT_MS). The answer is JSON.stringify(result), serialised once. A refusal is {error: code, message} with its
//                     status: 400 for a request the intake refuses (RequestError), 422 for a document or a hire that failed, and 503 (the service cannot
//                     take a job now) or 500 (store_write_failed) for a failure on this side, whose message is fixed text for the buyer and whole in the
//                     log (PipelineError); anything else is 500 {error: "internal"} with no detail, and the cause goes to the log, by message only,
//                     never the request.
//   anything else     404, POST / with a query among them.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { REGISTRY_ADDRESS } from '@vsa/vector-read';
import { JOB_DEADLINE_MS } from './budget.ts';
import { COMBINATION_MAX_ENTRIES, SCHEMA_MAX_BYTES, SCHEMA_MAX_DEPTH } from './extract.ts';
import { errorText } from './format.ts';
import { GAPS } from './gaps.ts';
import { assertFunded, runPipeline as realRunPipeline } from './orchestrate.ts';
import type { Deps, PipelineResult } from './orchestrate.ts';
import { DEFAULT_LANGUAGE, MAX_INLINE_BYTES, MAX_PAGES, RequestError, parseRequest } from './request.ts';
import type { PipelineRequest } from './request.ts';
import { PipelineError } from './result.ts';
import { MAX_SOURCE_BYTES } from './source.ts';

// --- The environment -----------------------------------------------------------------------------------------------------------------
// A value as a message may show it: short and plain, or only its length. A key put in the wrong line of an env file must not be printed because a check on
// that line found fault with it.
function shown(value: string): string {
  return value.length <= 24 && !/[0-9a-fA-F]{20}/.test(value) ? JSON.stringify(value) : `${value.length} characters`;
}
// A number from the environment: absent or empty means the default (an empty string must not become 0); anything else must be a non-negative integer,
// and the error names the variable.
export function envInt(name: string, v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error(`environment variable ${name} must be a non-negative integer, got ${shown(v)}`);
  return Number(v);
}
// A setting the service cannot start without. Absent, empty and blank all mean it was not given, and the error names the variable. What it is for goes in
// the message. A value that is published in the manifest has no default: a default would be published by every deployment that forgot to set it.
export function requiredEnv(name: string, v: string | undefined, what: string): string {
  if (v === undefined || v.trim() === '') throw new Error(`environment variable ${name} is required (${what}) and is not set`);
  return v.trim();
}
const CHIPS = ['LIVE', 'DEPLOYED', 'PROPOSED'];
// The status word: live, deployed or proposed in any case, carried in the manifest in lower case. Absent or empty means proposed: the Pipeline is built and
// not yet deployed. A word above that is the operator's to set, by this variable, once it is true.
function statusChip(v: string | undefined): string {
  if (v === undefined || v === '') return 'proposed';
  if (!CHIPS.includes(v.toUpperCase())) throw new Error(`environment variable AGENT_STATUS_CHIP must be one of ${CHIPS.join(', ')}, got ${shown(v)}`);
  return v.toLowerCase();
}
// The date the status word began, YYYY-MM-DD; absent or empty means 2026-10-13, the day the word PROPOSED began (ruling R52).
function statusSince(v: string | undefined): string {
  if (v === undefined || v.trim() === '') return '2026-10-13';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) throw new Error(`environment variable AGENT_STATUS_SINCE must be a date as YYYY-MM-DD, got ${shown(v)}`);
  return v.trim();
}
/**
 * The window the advert gives a job, at least 30 min: the deadline of a job (JOB_DEADLINE_MS) and the service timeout of the runtime, 60 s later, are fixed
 * for it, and a window below them would be a promise the service cannot keep.
 */
export const MIN_PROCESSING_WINDOW_MS = 1_800_000;
function processingWindow(v: string | undefined): number {
  const ms = envInt('ADVERT_MAX_PROCESSING_MS', v, MIN_PROCESSING_WINDOW_MS);
  if (ms < MIN_PROCESSING_WINDOW_MS) {
    throw new Error(`environment variable ADVERT_MAX_PROCESSING_MS must be at least ${MIN_PROCESSING_WINDOW_MS} (the window of 30 min that the deadline of a job, ${JOB_DEADLINE_MS} ms, assumes), got ${ms}`);
  }
  return ms;
}

// --- The manifest --------------------------------------------------------------------------------------------------------------------
const SPEC_URL = 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/document-pipeline.md';
const SOURCE_URL = 'https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/document-pipeline';
/** What a buyer may post: the wire payload, 900000 bytes (the runtime takes 1 MB of JSON that holds it escaped). The service itself reads up to MAX_BODY. */
const WIRE_PAYLOAD_BYTES = 900_000;
// Standard base64 with its padding and nothing else; the form parseRequest accepts, and 800000 characters are 600000 raw bytes.
const BASE64_PATTERN = '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$';
// A language code: 2 to 8 letters and hyphen-separated subtags of 1 to 8 letters or digits (en, en-GB, zh-Hant-TW, es-419), at most 16 characters.
const LANGUAGE_PATTERN = '^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$';
const base64 = (what: string) => ({
  type: 'string', minLength: 4, maxLength: (MAX_INLINE_BYTES / 3) * 4, pattern: BASE64_PATTERN,
  description: `${what} as standard base64 text, padded, with no line breaks; at most ${MAX_INLINE_BYTES} bytes of media`,
});

/**
 * What the intake (src/request.ts) accepts, as a JSON Schema: test/server.test.ts holds the two to each other on a table of requests. What a schema cannot say
 * is in `notes` below: the rules for the extraction schema, and what an extraction does with an answer that does not fit it.
 */
const REQUEST_SCHEMA = {
  type: 'object',
  required: ['source', 'task'],
  additionalProperties: false,
  properties: {
    source: {
      description: 'The document: an https URL of a PDF, PNG or JPEG (at most 20971520 bytes), or a PDF or an image as base64',
      oneOf: [
        { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', minLength: 9, pattern: '^https://', description: 'An https URL; the service fetches it itself' } } },
        { type: 'object', required: ['pdf_b64', 'mime'], additionalProperties: false, properties: { pdf_b64: base64('A PDF'), mime: { const: 'application/pdf' } } },
        { type: 'object', required: ['image_b64', 'mime'], additionalProperties: false, properties: { image_b64: base64('A PNG or JPEG image'), mime: { enum: ['image/png', 'image/jpeg'] } } },
      ],
    },
    task: { enum: ['summary', 'extract'], description: 'summary: a plain-text summary of the pages. extract: one JSON object valid against schema' },
    schema: { type: 'object', description: 'A JSON Schema for the extraction: required with task extract, refused with task summary; the rules it must keep are in notes' },
    language: {
      type: 'string', maxLength: 16, pattern: LANGUAGE_PATTERN, default: DEFAULT_LANGUAGE,
      description: 'The language code of the answer, such as en or en-GB: 2 to 8 letters and optional hyphen-separated subtags of up to 8 letters or digits, at most 16 characters',
    },
    max_pages: { type: 'integer', minimum: 1, maximum: MAX_PAGES, default: MAX_PAGES, description: 'The most pages read, from the first; a longer document is read in part' },
  },
  // The schema goes with the extraction and with nothing else: required with it, absent without it.
  allOf: [
    { if: { properties: { task: { const: 'extract' } }, required: ['task'] }, then: { properties: { schema: { type: 'object' } }, required: ['schema'] }, else: { properties: { schema: false } } },
  ],
};
const NOTES = [
  'The schema, which goes with task extract and with no other task, is a JSON Schema of draft-07 read in strict mode: a keyword the validator does not know is refused.',
  'The schema may not use $ref, $dynamicRef, $recursiveRef, $id, $defs, definitions, pattern, patternProperties or format, have a __proto__ key, or declare $async at the root. '
    + `It is at most ${SCHEMA_MAX_BYTES} bytes of JSON and ${SCHEMA_MAX_DEPTH} levels deep, and each of its anyOf, oneOf and allOf has at most ${COMBINATION_MAX_ENTRIES} entries. `
    + 'A schema that breaks a rule is refused with the code schema_invalid (400) before anything is spent.',
  'An extraction whose answer is not JSON, or does not validate against the schema, is not an error: the result has schema_valid false and extraction null, and the answer is kept as raw_text.',
];

export function manifestFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    schema: 'vector.agent-manifest.v1', name: 'Document Pipeline', capability_id: 'document.pipeline.ocr-summary.v1', version: env.AGENT_VERSION ?? '0.1.0',
    description: 'Reads a document: OCR for each page, then a summary or a structured extraction, with every sub-receipt checked and one receipt over the whole bundle.',
    operator: { name: 'Apex Fusion Foundation', contact: requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest") },
    identity: { did: env.AGENT_DID ?? '', controller_pkh: env.SUPPLIER_PKH ?? '', registry_address: REGISTRY_ADDRESS },
    keys: { supplier_pkh: env.SUPPLIER_PKH ?? '', pub_key_hex: env.SUPPLIER_PUB_KEY_HEX ?? '', buyer_pkh: env.PIPELINE_BUYER_PKH ?? '' },
    interface: {
      request_schema: REQUEST_SCHEMA,
      response_schema: { $ref: `${SPEC_URL}#response` },
      routes: { job: '/v1/job', status: '/status', capability: '/capability' },
      notes: [...NOTES],
    },
    terms: {
      price_lovelace: envInt('ADVERT_PRICE_LOVELACE', env.ADVERT_PRICE_LOVELACE, 5_000_000), supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000,
      max_processing_ms: processingWindow(env.ADVERT_MAX_PROCESSING_MS),
      input_limits: { request_bytes: WIRE_PAYLOAD_BYTES, source_bytes: MAX_SOURCE_BYTES, inline_media_bytes: MAX_INLINE_BYTES, max_pages: MAX_PAGES },
    },
    behaviour: {
      data_handling: 'The document, its page images, the task and the schema are held in memory while a job runs; a PDF is also written to a private temporary directory while its pages are rendered, and removed after. '
        + 'Pages go to the OCR agent as images, the page texts, the task and any schema to the LLM supplier, and escrow identifiers to Koios and the marketplace indexer; on the ledger the sub-escrows carry hashes, not the document or its text. '
        + 'The service writes only the bookkeeping of the escrows it posts (references, times, the hop, a transaction hash) to its state directory, and its log carries job outcomes, never a request or a document.',
      third_parties: ['the host of the source URL', 'the ChandraOCR agent, and Datalab behind it', 'the LLM supplier it hires, and its model provider', 'Koios (Vector mainnet indexer)', 'marketplace indexer'],
    },
    status: { chip: statusChip(env.AGENT_STATUS_CHIP), since: statusSince(env.AGENT_STATUS_SINCE) },
    gaps: [...GAPS],
    links: { spec: SPEC_URL, source: SOURCE_URL, explorer_advert: env.ADVERT_EXPLORER_URL ?? '' },
  };
}
export type AgentManifest = ReturnType<typeof manifestFromEnv>;

/** The five fields the operator supplies, as the placeholders the template file shows. */
export const TEMPLATE_ENV = {
  OPERATOR_CONTACT: '<OPERATOR_CONTACT>', AGENT_DID: '<AGENT_DID>', SUPPLIER_PKH: '<SUPPLIER_PKH>', SUPPLIER_PUB_KEY_HEX: '<SUPPLIER_PUB_KEY_HEX>',
  PIPELINE_BUYER_PKH: '<PIPELINE_BUYER_PKH>',
} as const;
/** The text of agent.json.template: the manifest with the placeholders, indented, with a line break at the end. `pnpm --filter @vsa/document-pipeline template` writes it. */
export const renderTemplate = (): string => `${JSON.stringify(manifestFromEnv(TEMPLATE_ENV), null, 2)}\n`;

// --- The wire message ----------------------------------------------------------------------------------------------------------------
/** The most bytes of body the service reads: 1 MB. A buyer posts at most WIRE_PAYLOAD_BYTES; the rest is the room the runtime's own framing needs. */
export const MAX_BODY = 1_000_000;

/** A body that is not the wire message, or is too large. Carries a stable `code` and the `status` the service answers with. */
export class WireError extends Error {
  readonly code: 'bad_wire' | 'request_too_large';
  readonly status = 400;
  constructor(code: 'bad_wire' | 'request_too_large', message: string) {
    super(message);
    this.name = 'WireError';
    this.code = code;
  }
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const WIRE_SHAPE = 'the body must be the one-element message array [{"content": "<request JSON as a string>", "role": "user"}]';

/** The request JSON out of the wire message the runtime posts: `[{"content": "<request JSON as a string>", "role": "user"}]`. The request JSON is parseRequest's to read. */
export function parseWire(body: string): string {
  // Bytes on the wire, not UTF-16 code units: the HTTP layer counts the same unit.
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BODY) throw new WireError('request_too_large', `the request is too large (${bytes} bytes, the service reads at most ${MAX_BODY})`);
  let list: unknown;
  try { list = JSON.parse(body); } catch { throw new WireError('bad_wire', `the body is not JSON: ${WIRE_SHAPE}`); }
  if (!Array.isArray(list) || list.length !== 1 || !isObject(list[0]) || typeof list[0].content !== 'string') throw new WireError('bad_wire', WIRE_SHAPE);
  if (list[0].role !== 'user') throw new WireError('bad_wire', "the message role must be 'user'");
  return list[0].content;
}

// Reads the request body as bytes, the unit parseWire counts in. Past MAX_BODY it stops keeping data and fails at once (the caller answers 400 and closes the
// connection); the rest of the upload is read and dropped, never held.
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0, failed = false;
    req.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes <= MAX_BODY) chunks.push(c);
      else if (!failed) { failed = true; reject(new WireError('request_too_large', `the request is too large (more than ${MAX_BODY} bytes, the most the service reads)`)); }
    });
    req.on('end', () => resolve(Buffer.concat(chunks, bytes).toString('utf8')));
    req.on('error', reject);
  });
}

// --- The health check ----------------------------------------------------------------------------------------------------------------
/** How long the answer of a wallet check stands. */
export const FLOAT_TTL_MS = 60_000;
/** How long a wallet check may take before it counts as failed: the provider's own calls carry no time limit. */
export const FLOAT_TIMEOUT_MS = 30_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    timer.unref();
    work.then((value) => { clearTimeout(timer); resolve(value); }, (err: unknown) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Whether the buyer wallet can fund a job: the last answer of a check, with the check made again in the background when that answer is older than the TTL.
 * A request asks `poke` to start a check if one is due and reads `healthy` at once, so it never waits for the node. One check runs at a time. Nothing is
 * known before the first check has answered, and until then the wallet counts as fine.
 */
class FloatMonitor {
  #healthy = true;
  #running = false;
  #checkedAt = Number.NEGATIVE_INFINITY;
  readonly #check: () => Promise<void>;
  readonly #clock: () => number;
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #log: (line: string) => void;
  constructor(check: () => Promise<void>, clock: () => number, ttlMs: number, timeoutMs: number, log: (line: string) => void) {
    this.#check = check;
    this.#clock = clock;
    this.#ttlMs = ttlMs;
    this.#timeoutMs = timeoutMs;
    this.#log = log;
  }
  get healthy(): boolean { return this.#healthy; }
  poke(): void {
    if (this.#running) return;
    const age = this.#clock() - this.#checkedAt;
    if (age >= 0 && age < this.#ttlMs) return; // an answer from the future, after the clock was set back, is not a fresh one
    this.#running = true;
    this.#run().catch(() => undefined);
  }
  async #run(): Promise<void> {
    let failure: string | null = null;
    try { await withTimeout(this.#check(), this.#timeoutMs); } catch (err) { failure = errorText(err); }
    this.#checkedAt = this.#clock();
    this.#running = false;
    // A change of state is logged once, with its reason, and a repeat is not.
    if (failure !== null && this.#healthy) this.#log(`wallet check failed: ${failure}`);
    if (failure === null && !this.#healthy) this.#log('wallet check passed again');
    this.#healthy = failure === null;
  }
}

// --- The server ----------------------------------------------------------------------------------------------------------------------
/**
 * How often, while a job runs, the server writes an interim "102 Processing" line (ruling R47). The template runtime calls this service with the global fetch
 * and only AbortSignal.timeout(budget). Behind fetch, undici gives up on a response that has not begun after 300 s (its headers timeout), and a job takes up
 * to 27 minutes: without a line now and then the runtime would report service_unreachable at the five minute mark while the service goes on hiring and
 * paying, and holds its slot. Undici counts an interim response as life and keeps waiting for the final one, so a line a minute is plenty, and the option
 * may not be longer. The final answer is what it was: the same 200 with the same body.
 */
export const HEARTBEAT_MS = 60_000;

/**
 * Starts the interim lines of one job: a timer, unref'd so that it never keeps the process alive, which writes "102 Processing" to the response unless its
 * headers are out or it is gone. Only an HTTP/1.1 client is sent one (an interim response is not for HTTP/1.0). A write that fails changes nothing for the
 * job: the client is gone. The caller clears the timer in the same place it frees the slot.
 */
function startHeartbeat(req: IncomingMessage, res: ServerResponse, everyMs: number): NodeJS.Timeout | undefined {
  if (!(req.httpVersionMajor === 1 && req.httpVersionMinor >= 1)) return undefined;
  const timer = setInterval(() => {
    if (res.headersSent || res.destroyed) return;
    try { res.writeProcessing(); } catch { /* the socket is gone; the job goes on */ }
  }, everyMs);
  timer.unref();
  return timer;
}

/**
 * The one place a job runs: one at a time, because the money of a job is the buyer wallet's and the wallet is one. A request takes the slot once it has been
 * read and found to be a request, not while its upload is under way, so that a client that stalls cannot hold it. A service that is stopping drains the slot:
 * the job that holds it goes on, and no other is taken.
 */
export class JobSlot {
  #busy = false;
  #draining = false;
  #waiting: Array<() => void> = [];
  /** 'taken' when the caller now holds the slot; otherwise why not. Draining outranks busy: it is the answer that will not change. */
  take(): 'taken' | 'busy' | 'draining' {
    if (this.#draining) return 'draining';
    if (this.#busy) return 'busy';
    this.#busy = true;
    return 'taken';
  }
  release(): void {
    this.#busy = false;
    for (const resolve of this.#waiting.splice(0)) resolve();
  }
  /** From now on no job is taken. */
  drain(): void { this.#draining = true; }
  /** Does a job hold the slot? */
  get busy(): boolean { return this.#busy; }
  /**
   * Resolves once no job holds the slot: at once when none does, else when the job releases it, which is when its run has ended, its Accept included. A
   * stopping service waits on this and not on the connection of the job, which ends at once when the caller hangs up (ruling R61).
   */
  idle(): Promise<void> {
    if (!this.#busy) return Promise.resolve();
    return new Promise((resolve) => { this.#waiting.push(resolve); });
  }
}

export interface ServerOptions {
  manifest: AgentManifest;
  /**
   * The token the runtime sends as the authorization header of every call (SERVICE_AUTH_HEADER, ruling R50), which POST / requires. A server is never made
   * without one: a service that answered anyone would spend from the buyer wallet for anyone who can reach its port.
   */
  authHeader: string;
  /** Everything a run is given but its deadline, which the server sets for each request. */
  deps: Omit<Deps, 'deadlineMs'>;
  /** Test seam: a test injects its own run; the service always runs the real one. */
  runPipeline?: (req: PipelineRequest, deps: Deps) => Promise<PipelineResult>;
  /** Where a line of the log goes; the default prints it with the name of the service. */
  log?: (line: string) => void;
  /** How long a wallet check stands (FLOAT_TTL_MS), and how long it may take (FLOAT_TIMEOUT_MS). */
  floatTtlMs?: number;
  floatTimeoutMs?: number;
  /** How often a job that is running is sent an interim line: HEARTBEAT_MS by default, and no more than that. */
  heartbeatMs?: number;
  /** The slot jobs run in; a service that wants to stop drains it. A new one by default. */
  slot?: JobSlot;
}
/** The log of the process: one line each on stdout, with the name of the service. */
export const defaultLog = (line: string): void => { console.log(`[document-pipeline] ${line}`); };

// What a buyer is told when the service fails on its side. The runtime copies the first 200 characters of a failure to the buyer, and the detail of a failure on
// this side (a path, an escrow, the text of a provider) is the operator's.
const operatorsLog = (code: string): string => `The service could not do this job (${code}). The operator's log has the detail.`;
const STOPPING_TEXT = 'The service is stopping and takes no new job. Try again shortly.';

// --- Who may post a job --------------------------------------------------------------------------------------------------------------------
// The sha256 digest of a value: 32 bytes whatever its length, so that two of them can be compared in constant time without leaking the content or the length.
const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
// A call refused for want of the token is logged once a minute at most, with the count since the last line: a caller that cannot authenticate must not fill the log.
const REFUSAL_LOG_MS = 60_000;

export function createServer(opts: ServerOptions): Server {
  const { deps } = opts;
  const run = opts.runPipeline ?? realRunPipeline;
  const log = opts.log ?? defaultLog;
  const slot = opts.slot ?? new JobSlot();
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  if (!(heartbeatMs > 0 && heartbeatMs <= HEARTBEAT_MS)) {
    throw new RangeError(`heartbeatMs must be more than 0 and at most ${HEARTBEAT_MS}, for the runtime's fetch gives up after 300 s of silence, got ${heartbeatMs}`);
  }
  if (typeof opts.authHeader !== 'string' || opts.authHeader === '') {
    throw new RangeError('authHeader must be the value of SERVICE_AUTH_HEADER and not empty: a service that answered anyone would spend from the buyer wallet for anyone who can reach its port');
  }
  const expectedAuth = digest(opts.authHeader);
  // The header of the call against the token: both digested, so the two buffers are of one length, and compared with timingSafeEqual. Nothing here is logged or answered.
  const authorised = (req: IncomingMessage): boolean => {
    const given = req.headers.authorization;
    return typeof given === 'string' && timingSafeEqual(digest(given), expectedAuth);
  };
  let refusals = 0; // calls refused since the last line of this kind
  let lastRefusalLine: number | undefined;
  const noteRefusal = (at: number): void => {
    refusals++;
    if (lastRefusalLine !== undefined && at >= lastRefusalLine && at - lastRefusalLine < REFUSAL_LOG_MS) return; // a clock that was set back logs again, it does not go silent
    log(`request refused: unauthorized (${refusals} since the last line of this kind)`);
    lastRefusalLine = at;
    refusals = 0;
  };
  const manifestText = JSON.stringify(opts.manifest);
  const monitor = new FloatMonitor(async () => { await assertFunded(deps.chain, MAX_PAGES); }, deps.clock, opts.floatTtlMs ?? FLOAT_TTL_MS, opts.floatTimeoutMs ?? FLOAT_TIMEOUT_MS, log);
  monitor.poke(); // the first check, at start
  return httpServer(async (req, res) => {
    const arrivedAt = deps.clock();
    const head = req.method === 'HEAD';
    // The body is serialised before anything is written, so a body that cannot be serialised can still be answered with a 500. A HEAD gets the headers a GET
    // would, its content-length included, and no body.
    const sendText = (status: number, text: string) => {
      // A 400 and a 401 may be answered before the body has been read to its end (too large, or not read at all), so the connection is closed after them.
      res.writeHead(status, {
        'content-type': 'application/json', ...(head ? { 'content-length': Buffer.byteLength(text, 'utf8') } : {}), ...(status === 400 || status === 401 ? { connection: 'close' } : {}),
      });
      if (head) res.end(); else res.end(text);
    };
    const send = (status: number, body: unknown) => sendText(status, JSON.stringify(body));
    try {
      // The two open routes are matched on their path, whatever the query, and answer HEAD as they answer GET.
      const path = (req.url ?? '').split('?', 1)[0];
      const read = req.method === 'GET' || head;
      if (read && path === '/healthz') {
        monitor.poke();
        return monitor.healthy ? send(200, { ok: true }) : send(503, { ok: false, reason: 'insufficient_float' });
      }
      if (read && path === '/agent.json') return sendText(200, manifestText);
      if (req.method !== 'POST' || req.url !== '/') return send(404, { error: 'not_found' });
      // R50: only the runtime posts a job. The check comes before the body is read and before the slot is taken, so a stranger neither makes the service read a
      // megabyte nor learns that a job is running (a 409 would say so), and what the answer says is the same for a missing header and a wrong one.
      if (!authorised(req)) {
        noteRefusal(arrivedAt);
        return send(401, { error: 'unauthorized' });
      }
      const request = parseRequest(parseWire(await readBody(req)));
      const taken = slot.take();
      if (taken === 'busy') return send(409, { error: 'busy' });
      if (taken === 'draining') {
        log('job refused: the service is stopping');
        return send(503, { error: 'shutting_down', message: STOPPING_TEXT });
      }
      const heartbeat = startHeartbeat(req, res, heartbeatMs);
      let result: PipelineResult;
      try {
        result = await run(request, { ...deps, deadlineMs: arrivedAt + JOB_DEADLINE_MS });
      } finally {
        clearInterval(heartbeat);
        slot.release();
      }
      const text = JSON.stringify(result);
      log(`job done in ${deps.clock() - arrivedAt} ms: ${result.accounting.sub_jobs} sub-jobs`);
      return sendText(200, text);
    } catch (e) {
      // Headers already out: nothing more can be said on this response. Log why, then cut it.
      if (res.headersSent) { log(`response failed after the headers were sent: ${errorText(e)}`); res.destroy(); return; }
      if (e instanceof WireError || e instanceof RequestError || e instanceof PipelineError) {
        const took = deps.clock() - arrivedAt;
        if (e.status >= 500) {
          // A failure on this side: the whole message is for the operator's log, and the buyer gets the code.
          log(`job failed after ${took} ms: ${e.code} (${e.status}): ${errorText(e.message, 1000)}`);
          return send(e.status, { error: e.code, message: operatorsLog(e.code) });
        }
        log(`${e instanceof PipelineError ? 'job failed' : 'request refused'} after ${took} ms: ${e.code} (${e.status})`);
        return send(e.status, { error: e.code, message: e.message });
      }
      log(`job failed after ${deps.clock() - arrivedAt} ms: internal error: ${errorText(e)}`); // the message only, never the request
      return send(500, { error: 'internal' });
    }
  });
}
