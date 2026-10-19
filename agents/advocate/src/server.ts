// agents/advocate/src/server.ts
// The service behind the template runtime: the manifest it publishes, on the HTTP surface of packages/service-kit (createJobServer: the three routes, the token
// of the runtime on POST /, one job at a time, the 102 Processing heartbeat, the body cap, refusals as {error, message}). The runtime holds the supplier key,
// claims the escrow of a hirer and posts the job to this service as the body of POST /; the service searches, fetches the pages, buys the model call from a
// chat supplier on the Vector marketplace or makes it through OpenRouter when that hire fails, and checks every quote (src/run.ts), and answers with the
// brief, which the runtime hashes into the one receipt it signs. The service holds the buyer key (src/start.ts), which posts and accepts the escrow of the chat
// sub-job of a job, and the two keys of its third parties; none of them reaches an answer, a log line or the manifest, which publishes the key hash of the
// buyer key beside the supplier's. What is its own:
//
//   GET  /healthz     always {ok: true}: the service runs no model of its own, and a third party that is down, or a buyer wallet too short for a hire, is
//                     the failure or the fallback of a job (search_failed, model_failed, a job that goes to OpenRouter), never a reason to stop taking jobs.
//   POST /            the request JSON read by parseRequest (src/request.ts) and run by runAdvocate, with the deadline of the job set on its arrival. A
//                     refusal is {error: code, message} with its status: 400 for a request the intake refuses (RequestError, bad_shape); 422 for a job cut at
//                     its deadline, which keeps its words; 502 for a failure of a third party, of the answer of the model or of the hire of the chat supplier,
//                     and 500 for a stranded store that could not be written, each with fixed text for the buyer and whole in the log (AdvocateError,
//                     HopFailed); 499 for a job whose caller hung up. A job whose caller hangs up is stopped (abortOnClose): the runtime aborts its call at
//                     its own budget and frees the escrow, and a job nobody receives would hold the one slot for nothing. The hire of the chat supplier
//                     is not stopped with it: it runs to its own end, and the job then fails with aborted (src/inference.ts).
//   The line of a job names counts and codes and nothing else: results, pages, arguments, dropped quotes, the tokens of the model, and the path of the call.
import type { Server } from 'node:http';
import { JobSlot, createJobServer, envInt, given, requiredEnv, statusChip, statusSince } from '@vsa/service-kit';
import type { Refusal } from '@vsa/service-kit';
import { REGISTRY_ADDRESS } from '@vsa/vector-read';
import { JOB_DEADLINE_MS } from './budget.ts';
import { AdvocateError } from './errors.ts';
import { gapsFor } from './gaps.ts';
import { EXCERPT_CHARS } from './html.ts';
import { openRouterModel } from './model.ts';
import { PAGE_MAX_BYTES } from './pages.ts';
import { DECLARED_BIAS_STATEMENT, OMITTED_BY_DESIGN, QUOTE_MAX_CHARS, QUOTE_MIN_CHARS, SHAPES } from './prompt.ts';
import { DEFAULT_LANGUAGE, DEFAULT_LENGTH, LANGUAGE_PATTERN, LENGTHS, MAX_AUDIENCE_CHARS, MAX_SIDE_CHARS, MAX_SUBJECT_CHARS, RequestError, parseRequest } from './request.ts';
import type { AdvocateRequest } from './request.ts';
import { serializeResult } from './result.ts';
import type { AdvocateResult } from './result.ts';
import { runAdvocate } from './run.ts';
import type { RunDeps, RunOutcome } from './run.ts';
import { MAX_RESULTS } from './search.ts';

export { HEARTBEAT_MS, JobSlot, MAX_BODY, WireError, envInt, parseWire, requiredEnv } from '@vsa/service-kit';

// --- The environment -----------------------------------------------------------------------------------------------------------------
/**
 * The window the advert gives a job, at least 8 min: the deadline of a job (JOB_DEADLINE_MS, 300 s after its arrival) and the service timeout of the
 * runtime (SERVICE_TIMEOUT_MS, 360 s, which the runtime holds at least 60 s inside the window) are fixed for it, and a window below them would be a promise
 * the service cannot keep.
 */
export const MIN_PROCESSING_WINDOW_MS = 480_000;
/** The window of ADVERT_MAX_PROCESSING_MS, at least MIN_PROCESSING_WINDOW_MS; the manifest publishes it, and the start checks it in its order. */
export function processingWindow(v: string | undefined): number {
  const ms = envInt('ADVERT_MAX_PROCESSING_MS', v, MIN_PROCESSING_WINDOW_MS);
  if (ms < MIN_PROCESSING_WINDOW_MS) {
    throw new Error(`environment variable ADVERT_MAX_PROCESSING_MS must be at least ${MIN_PROCESSING_WINDOW_MS} (the window of ${MIN_PROCESSING_WINDOW_MS / 60_000} min that the deadline of a job, ${JOB_DEADLINE_MS} ms, assumes), got ${ms}`);
  }
  return ms;
}
/**
 * A model of LLM_MODEL_ALLOWLIST, as an advert names it: letters, digits, dots, underscores, colons, slashes and hyphens. The colon is for a variant of
 * OpenRouter such as `:free`, which OPENROUTER_MODEL takes too, and for a fleet model such as `qwen2.5:0.5b`; the shell's "." of the ops scripts reads it as it is.
 */
const MODEL_ENTRY = /^[A-Za-z0-9._:\/-]+$/;
/**
 * The chat models a hire may buy, in the order of preference of LLM_MODEL_ALLOWLIST (a comma-separated list), or the model of OPENROUTER_MODEL alone when it
 * is not set, so that both paths ask the same model. The first is the market model, which the gap of the model and the listening line name (ruling R-F19);
 * the start checks it in its order. The first is published, so every entry is held to MODEL_ENTRY, and one that is not is refused by its position among the
 * models the list names, never by what it holds.
 */
export function modelAllowlist(v: string | undefined, fallbackModel: string): string[] {
  if (given(v) === '') return [fallbackModel];
  const models = given(v).split(',').map((name) => name.trim()).filter((name) => name !== '');
  if (models.length === 0) throw new Error('environment variable LLM_MODEL_ALLOWLIST must name at least one model, as a comma-separated list');
  const wrong = models.findIndex((name) => !MODEL_ENTRY.test(name));
  if (wrong !== -1) {
    throw new Error(`environment variable LLM_MODEL_ALLOWLIST must be a comma-separated list of models, each of letters, digits, dots, underscores, colons, slashes and hyphens only, and its entry ${wrong + 1} is not`);
  }
  return models;
}

// --- The manifest --------------------------------------------------------------------------------------------------------------------
const SPEC_URL = 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/advocate.md';
const SOURCE_URL = 'https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/advocate';
/** What a buyer may post: the wire payload, 900000 bytes (the runtime takes 1 MB of JSON that holds it escaped). The service itself reads up to MAX_BODY. */
const WIRE_PAYLOAD_BYTES = 900_000;
/** The longest language code the intake takes. */
const LANGUAGE_MAX_CHARS = 16;

/**
 * What the intake (src/request.ts) accepts, as a JSON Schema: test/server.test.ts holds the two to each other on a table of requests. What a schema cannot say
 * is in `notes` below: the subject and the side must each hold a letter or a digit.
 */
const REQUEST_SCHEMA = {
  type: 'object',
  required: ['subject', 'side'],
  additionalProperties: false,
  properties: {
    subject: {
      type: 'string', minLength: 1, maxLength: MAX_SUBJECT_CHARS,
      description: `The subject of the brief, as a question or a statement: 1 to ${MAX_SUBJECT_CHARS} characters, with at least one letter or digit`,
    },
    side: {
      type: 'string', minLength: 1, maxLength: MAX_SIDE_CHARS,
      description: `The side the brief argues: for, against, or a position in words, 1 to ${MAX_SIDE_CHARS} characters with at least one letter or digit`,
    },
    // A blank audience is refused by the intake, and by the schema too (R-E34): a pattern is found anywhere in the text, and \S of ECMA is what trim() keeps.
    audience: {
      type: 'string', minLength: 1, maxLength: MAX_AUDIENCE_CHARS, pattern: '\\S',
      description: `Who the brief is written for, in words: 1 to ${MAX_AUDIENCE_CHARS} characters; optional`,
    },
    length: {
      enum: [...LENGTHS], default: DEFAULT_LENGTH,
      description: `The prompt asks for a thesis and ${SHAPES.short.minArguments} arguments (short) or ${SHAPES.standard.minArguments} to ${SHAPES.standard.maxArguments} arguments (standard), and the check can leave fewer`,
    },
    // auto has the form of a code and names no language: the intake refuses it in any case, and so does the schema (R-E25).
    language: {
      type: 'string', maxLength: LANGUAGE_MAX_CHARS, pattern: LANGUAGE_PATTERN, not: { pattern: '^[Aa][Uu][Tt][Oo]$' }, default: DEFAULT_LANGUAGE,
      description: 'The language of the brief: a code such as en or en-GB, 2 to 8 letters and optional hyphen-separated subtags of up to 8 letters or digits, at most 16 characters',
    },
  },
};
const NOTES = [
  `The side is for, against, or a position in words of at most ${MAX_SIDE_CHARS} characters, and the brief argues that side alone; the subject and the side must each hold at least one letter or digit, and a request that breaks a rule of the intake is refused with bad_shape (400).`,
  `The language is a code such as en or en-GB, 2 to 8 letters and optional hyphen-separated subtags of up to 8 letters or digits, at most ${LANGUAGE_MAX_CHARS} characters, en by default: the model is asked to write the brief in it, and the search is not told it.`,
  `The service runs the search and fetches the result pages itself, at most ${MAX_RESULTS} pages of at most ${PAGE_MAX_BYTES} bytes each, and cites only what it could fetch: a quote that is not in the text of the page it names is dropped, and so is an argument left without one.`,
  "The model call is bought first from a chat supplier on the Vector marketplace: the service posts a bonded escrow with its own buyer key, sends the prompt, verifies the supplier's signed receipt and accepts; only when that hire fails is the call made through OpenRouter, and the result says which path it took.",
];
/** What the prompt carries to the model, on either path (R-E27, R-F12), in one list that the data handling and the third parties both give (R-E32). */
const TO_THE_MODEL = 'the subject, the side, the audience, the language and the length, and the titles, URLs and excerpts of the fetched pages';
const DATA_HANDLING = 'The subject, the side, the audience, the length and the language are held in memory while a job runs, with the pages the service fetches, and none of them is kept after the job. '
  + 'The service writes only the bookkeeping of the escrows it posts (references, times, the hop, a transaction hash) to its state directory, and nothing else to disk. '
  + `The two search queries go to the Brave Search API, each page fetch to the host of that page, and the prompt (${TO_THE_MODEL}) to the chat supplier the service hires on the Vector marketplace and the model provider behind it, or, only when that hire fails, to OpenRouter and the model provider behind it. `
  + 'On the ledger the escrow of the job carries only the sha256 of the wire payload and the escrow of the chat sub-job only a sha256 commitment to its input, and the request stays off the ledger. '
  + 'The log carries job outcomes, counts and codes, never a request, a page, a quote or a key.';
const THIRD_PARTIES = [
  'Brave Search API (the two search queries)',
  'the hosts of the result pages (the fetch of each page)',
  `a chat supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it (the prompt: ${TO_THE_MODEL})`,
  'OpenRouter and the model provider behind it (the same prompt), only when that hire fails',
];

export function manifestFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const fallbackModel = openRouterModel(env.OPENROUTER_MODEL);
  const marketModel = modelAllowlist(env.LLM_MODEL_ALLOWLIST, fallbackModel)[0];
  return {
    // An AGENT_VERSION that is empty or blank is not set (given): an empty version would be published in the manifest the advert hashes.
    schema: 'vector.agent-manifest.v1', name: 'Advocate', capability_id: 'research.advocate.onesided.v1', version: given(env.AGENT_VERSION) || '0.1.0',
    description: 'The strongest one-sided brief for a position, with citations: it argues one side only, by design, omits counter-arguments, and says so in every output.',
    operator: { name: 'Apex Fusion Foundation', contact: requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest") },
    identity: { did: env.AGENT_DID ?? '', controller_pkh: env.SUPPLIER_PKH ?? '', registry_address: REGISTRY_ADDRESS },
    keys: { supplier_pkh: env.SUPPLIER_PKH ?? '', pub_key_hex: env.SUPPLIER_PUB_KEY_HEX ?? '', buyer_pkh: env.ADVOCATE_BUYER_PKH ?? '' },
    interface: {
      request_schema: REQUEST_SCHEMA,
      response_schema: { $ref: `${SPEC_URL}#response` },
      routes: { job: '/v1/job', status: '/status', capability: '/capability' },
      notes: [...NOTES],
    },
    terms: {
      price_lovelace: envInt('ADVERT_PRICE_LOVELACE', env.ADVERT_PRICE_LOVELACE, 3_000_000), supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000,
      max_processing_ms: processingWindow(env.ADVERT_MAX_PROCESSING_MS),
      input_limits: {
        request_bytes: WIRE_PAYLOAD_BYTES, subject_chars: MAX_SUBJECT_CHARS, side_chars: MAX_SIDE_CHARS, audience_chars: MAX_AUDIENCE_CHARS, results: MAX_RESULTS,
        page_bytes: PAGE_MAX_BYTES, excerpt_chars: EXCERPT_CHARS, quote_chars_min: QUOTE_MIN_CHARS, quote_chars_max: QUOTE_MAX_CHARS,
      },
    },
    behaviour: {
      declared_bias: { statement: DECLARED_BIAS_STATEMENT, omitted: OMITTED_BY_DESIGN },
      data_handling: DATA_HANDLING,
      third_parties: [...THIRD_PARTIES],
    },
    // Absent or empty means proposed since 2026-10-13, the word and the day of the spec page. A word above proposed is the operator's to set, by
    // AGENT_STATUS_CHIP, once it is true.
    status: { chip: statusChip(env.AGENT_STATUS_CHIP, 'proposed'), since: statusSince(env.AGENT_STATUS_SINCE, '2026-10-13') },
    gaps: [...gapsFor(marketModel, fallbackModel)],
    links: { spec: SPEC_URL, source: SOURCE_URL, explorer_advert: env.ADVERT_EXPLORER_URL ?? '' },
  };
}
export type AgentManifest = ReturnType<typeof manifestFromEnv>;

/** The five fields the operator supplies, as the placeholders the template file shows. */
export const TEMPLATE_ENV = {
  OPERATOR_CONTACT: '<OPERATOR_CONTACT>', AGENT_DID: '<AGENT_DID>', SUPPLIER_PKH: '<SUPPLIER_PKH>', SUPPLIER_PUB_KEY_HEX: '<SUPPLIER_PUB_KEY_HEX>',
  ADVOCATE_BUYER_PKH: '<ADVOCATE_BUYER_PKH>',
} as const;
/** The text of agent.json.template: the manifest with the placeholders, indented, with a line break at the end. `pnpm --filter @vsa/advocate template` writes it. */
export const renderTemplate = (): string => `${JSON.stringify(manifestFromEnv(TEMPLATE_ENV), null, 2)}\n`;

// --- The server ----------------------------------------------------------------------------------------------------------------------
export interface ServerOptions {
  manifest: AgentManifest;
  /** The token the runtime sends as the authorization header of every call (SERVICE_AUTH_HEADER), which POST / requires. A server is never made without one. */
  authHeader: string;
  /**
   * Everything a run is given but its deadline and its signal, which the server sets for each request: the chain of the buyer key, the stranded store, and one
   * marketplace switch for the life of the service among them. Its lookup and wait are seams of the tests: the service sets neither.
   */
  deps: Omit<RunDeps, 'deadlineMs' | 'signal'>;
  /** Test seam: a test injects its own run; the service always runs the real one. */
  runAdvocate?: typeof runAdvocate;
  /** Where a line of the log goes; the default prints it with the name of the service. */
  log?: (line: string) => void;
  /** How often a job that is running is sent an interim line: HEARTBEAT_MS by default, and no more than that. */
  heartbeatMs?: number;
  /** The slot jobs run in; a service that wants to stop drains it. A new one by default. */
  slot?: JobSlot;
}
/** The log of the process: one line each on stdout, with the name of the service. */
export const defaultLog = (line: string): void => { console.log(`[advocate] ${line}`); };

/** A refusal of the intake (RequestError, the request's) or of a job (AdvocateError, the job's), as the shared server answers it; null for anything else. */
function refusalOf(e: unknown): Refusal | null {
  if (e instanceof RequestError) return { code: e.code, status: e.status, message: e.message, kind: 'request' };
  // The detail of a job's failure: the buyer reads it at 422 (deadline) and 499 (aborted, which nobody receives); at 502 and 500 the server gives the buyer
  // fixed text and the log the detail.
  if (e instanceof AdvocateError) return { code: e.code, status: e.status, message: e.detail, kind: 'job' };
  return null;
}

/** The line of a job that answered: its time, its counts and the path of its model call, never a word of the request, of a page or of the brief. */
function jobLine(ms: number, outcome: RunOutcome): string {
  const tokens = outcome.usage === null ? '-/-' : `${outcome.usage.prompt_tokens}/${outcome.usage.completion_tokens}`;
  const inference = outcome.inference.path === 'marketplace' ? 'marketplace' : `openrouter after ${outcome.inference.fallbackFrom ?? '-'}`;
  return `job done in ${ms} ms: results ${outcome.resultsFound}, pages ${outcome.pagesKept}, arguments ${outcome.result.arguments.length} (dropped ${outcome.dropped.arguments}), quotes dropped ${outcome.dropped.quotes}, tokens ${tokens}; inference ${inference}`;
}

export function createServer(opts: ServerOptions): Server {
  const { deps } = opts;
  const run = opts.runAdvocate ?? runAdvocate;
  const log = opts.log ?? defaultLog;
  return createJobServer<AdvocateRequest, AdvocateResult>({
    manifestText: JSON.stringify(opts.manifest), authHeader: opts.authHeader, parse: parseRequest, serialize: serializeResult, abortOnClose: true,
    run: async (request, arrivedAt, signal) => {
      const outcome = await run(request, { ...deps, deadlineMs: arrivedAt + JOB_DEADLINE_MS, ...(signal === undefined ? {} : { signal }) });
      log(jobLine(deps.clock() - arrivedAt, outcome));
      return outcome.result;
    },
    // The line of a job is written by run above, with the counts of its outcome, which the brief alone does not carry; the default line would be a second one.
    done: () => undefined,
    refusalOf, clock: deps.clock, log,
    ...(opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs }), ...(opts.slot === undefined ? {} : { slot: opts.slot }),
  });
}
