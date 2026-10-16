// agents/document-pipeline/src/server.ts
// The service behind the template runtime: the manifest it publishes, on the HTTP surface of packages/service-kit (createJobServer: the three routes, the token
// of the runtime on POST /, one job at a time, the 102 Processing heartbeat, the body cap, refusals as {error, message}). The runtime holds the supplier key,
// claims the escrow of a hirer and posts the job to this service as the body of POST /; the service runs the pipeline (src/orchestrate.ts) and answers with the
// result, which the runtime hashes into the one receipt it signs. The service holds the buyer key and nothing else (src/start.ts). What is the Pipeline's own:
//
//   GET  /healthz     503 {ok: false, reason: "insufficient_float"} once the last check of the buyer wallet failed. The check is made at most once a minute,
//                     in the background: a request is answered from the last one and never waits for the next.
//   POST /            the request JSON read by parseRequest (src/request.ts) and run by runPipeline, with the deadline of the job set on its arrival. A
//                     refusal is {error: code, message} with its status: 400 for a request the intake refuses (RequestError), 422 for a document or a hire
//                     that failed, and 503 (the service cannot take a job now) or 500 (store_write_failed) for a failure on this side, whose message is fixed
//                     text for the buyer and whole in the log (PipelineError).
import type { Server } from 'node:http';
import { HealthMonitor, JobSlot, createJobServer, envInt, requiredEnv, statusChip, statusSince } from '@vsa/service-kit';
import type { Refusal } from '@vsa/service-kit';
import { REGISTRY_ADDRESS } from '@vsa/vector-read';
import { JOB_DEADLINE_MS, WALLET_READ_TIMEOUT_MS } from './budget.ts';
import { COMBINATION_MAX_ENTRIES, SCHEMA_MAX_BYTES, SCHEMA_MAX_DEPTH } from './extract.ts';
import { GAPS } from './gaps.ts';
import { assertFunded, runPipeline as realRunPipeline } from './orchestrate.ts';
import type { Deps, PipelineResult } from './orchestrate.ts';
import { DEFAULT_LANGUAGE, MAX_INLINE_BYTES, MAX_PAGES, RequestError, parseRequest } from './request.ts';
import type { PipelineRequest } from './request.ts';
import { PipelineError } from './result.ts';
import { MAX_SOURCE_BYTES } from './source.ts';

export { HEARTBEAT_MS, JobSlot, MAX_BODY, WireError, envInt, parseWire, requiredEnv } from '@vsa/service-kit';

// --- The environment -----------------------------------------------------------------------------------------------------------------
// The status word and its date are read by statusChip and statusSince of packages/service-kit, the rules and the messages the Pipeline had. The word is
// live, deployed or proposed in any case, carried in the manifest in lower case; absent or empty means deployed, the word since 2026-10-16
// (RUNBOOK-document-pipeline step 17). A first run, before any job has settled, sets proposed in the env file (step 4). A word above deployed is the
// operator's to set, by this variable, once it is true. The date is YYYY-MM-DD; absent or empty means 2026-10-16, the day the word DEPLOYED began (ruling R52).
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
    + 'A schema that breaks a rule is refused with the code schema_invalid (400) before anything is locked.',
  'An extraction whose answer is not JSON, or does not validate against the schema, still succeeds: the result has schema_valid false and extraction null, and the answer is kept as raw_text.',
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
        + 'Pages go to the OCR agent as images, the page texts, the task and any schema to the LLM supplier, and escrow identifiers to Koios and the marketplace indexer; on the ledger the sub-escrows carry hashes only, and the document and its text stay off the ledger. '
        + 'The service writes only the bookkeeping of the escrows it posts (references, times, the hop, a transaction hash) to its state directory, and its log carries job outcomes, never a request or a document.',
      third_parties: ['the host of the source URL', 'the ChandraOCR agent, and Datalab behind it', 'the LLM supplier it hires, and its model provider', 'Koios (Vector mainnet indexer)', 'marketplace indexer'],
    },
    status: { chip: statusChip(env.AGENT_STATUS_CHIP, 'deployed'), since: statusSince(env.AGENT_STATUS_SINCE, '2026-10-16') },
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

// --- The health check ----------------------------------------------------------------------------------------------------------------
/** How long the answer of a wallet check stands. */
export const FLOAT_TTL_MS = 60_000;
/** How long a wallet check may take before it counts as failed: the provider's own calls carry no time limit. */
export const FLOAT_TIMEOUT_MS = WALLET_READ_TIMEOUT_MS;

// --- The server ----------------------------------------------------------------------------------------------------------------------
export interface ServerOptions {
  manifest: AgentManifest;
  /**
   * The token the runtime sends as the authorization header of every call (SERVICE_AUTH_HEADER, ruling R50), which POST / requires. A server is never made
   * without one: a service that answered anyone would post escrows from the buyer wallet for anyone who can reach its port.
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

/** A refusal of the intake (RequestError, the request's) or of a run (PipelineError, the job's), as the shared server answers it; null for anything else. */
function refusalOf(e: unknown): Refusal | null {
  if (e instanceof RequestError) return { code: e.code, status: e.status, message: e.message, kind: 'request' };
  if (e instanceof PipelineError) return { code: e.code, status: e.status, message: e.message, kind: 'job' };
  return null;
}

export function createServer(opts: ServerOptions): Server {
  const { deps } = opts;
  const run = opts.runPipeline ?? realRunPipeline;
  const log = opts.log ?? defaultLog;
  // Whether the buyer wallet can cover a job of the most pages, checked at most once a minute, in the background.
  const health = new HealthMonitor({
    check: async () => { await assertFunded(deps.chain, MAX_PAGES); }, reason: 'insufficient_float', clock: deps.clock,
    ttlMs: opts.floatTtlMs ?? FLOAT_TTL_MS, timeoutMs: opts.floatTimeoutMs ?? FLOAT_TIMEOUT_MS,
    // A change of state is logged once, with its reason, and a repeat is not.
    onChange: (healthy, failure) => { if (healthy) log('wallet check passed again'); else log(`wallet check failed: ${failure}`); },
  });
  return createJobServer<PipelineRequest, PipelineResult>({
    manifestText: JSON.stringify(opts.manifest), authHeader: opts.authHeader, parse: parseRequest,
    run: (request, arrivedAt) => run(request, { ...deps, deadlineMs: arrivedAt + JOB_DEADLINE_MS }),
    done: (result, arrivedAt) => { log(`job done in ${deps.clock() - arrivedAt} ms: ${result.accounting.sub_jobs} sub-jobs`); },
    refusalOf, health, clock: deps.clock, log,
    ...(opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs }), ...(opts.slot === undefined ? {} : { slot: opts.slot }),
  });
}
