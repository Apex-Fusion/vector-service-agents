// packages/buyer-core/src/fleet-clients.ts
// The HTTP side of a fleet hire: what the buyer says to a supplier once the escrow is posted (send the job, poll it) and what it asks of one before it
// posts (GET /capability, GET /status). The protocol is the fleet's (Apex-Fusion/agents-marketplace at e847a55, supplier/src/server.ts). The routes and
// the headers are the vendored route table's (ROUTES.ocr and ROUTES.chat in src/vendored/mcp/marketplace-supplier.ts), the table the mcp-server keeps for
// this path and does not use itself; the answers are read here.
//
// A supplier's endpoint comes from an on-chain advert and is untrusted, so every call goes through safeFetch (https only, private and reserved addresses
// refused, no redirects, the answer read to a byte cap, one budget for the whole call, the host lookup included), whatever fetch is injected: `fetchImpl` is
// the fetch safeFetch calls once it has vetted the host. Nothing here puts an endpoint or a supplier's words into an error message. (A test that injects a
// fake fetch gives its suppliers IP-literal endpoints, as test/fleet-clients.test.ts does: a host name is looked up for real before the fake is called.)
//
// What a send says. The supplier answers a POST only after its own Claim has confirmed (up to 60 s), so the budget of a send is long (75 s by default).
//   accepted  202 {job_id, status: "accepted"}: the supplier has claimed the escrow and has a job to poll.
//   busy      409 supplier_busy: the supplier is working another job and has not claimed; the escrow is still Open and the same send can be repeated.
//   refused   any other answer: the status and the {reason, message} of its envelope, bounded (bad_response when the answer is not a JSON object, or is a 202
//             without a usable job id). A 4xx is the supplier turning the job down before it claimed. A 5xx, and a 202 that gives no job id, may come after
//             the claim, so the caller reads the escrow's state before it reclaims or sends again.
//   timeout   no answer was read: the budget ran out, the network failed, the answer was over the cap, or the outbound policy refused the endpoint. The POST
//             may have reached the supplier, which may have claimed the escrow, so the caller reads the escrow's state before it does anything else, and
//             never sends again blindly. Neither does this client: whatever the outcome, a send makes one POST.
// What a poll says. running (202), done (200 with the receipt and its signature, for the escrow the poll was made for), failed (the supplier's own word: its
// failed or error envelope on an error status), gone (a 404 with the supplier's own envelope, reason job_not_found: the supplier restarted or evicted the
// job). A poll that gets no answer of the supplier's at all rejects instead of saying failed or gone: the call fails, a proxy answers with a page or a body
// of its own (a 404 among them, ruling R57), or a 200 comes without the receipt and its signature (the supplier answers 200 for a done job only, always with
// both, and sends a failed job with its own envelope on an error status). The job may well be running, and the caller asks again on its next tick.
import { safeFetch } from '@vsa/vector-read';
import { ROUTES, callFailure, canonicalRef, jsonObject, trim } from './vendored/mcp/marketplace-supplier.ts';
import type { Call, Route } from './vendored/mcp/marketplace-supplier.ts';
import { isRecord } from './guards.ts';

/** The fetch safeFetch calls for each request, once it has vetted the host. Production passes the platform fetch; tests pass a fake. */
export type FetchLike = typeof fetch;

/**
 * The receipt of a job exactly as the supplier gave it: the JSON object it signed, untrusted until a verifier has checked it. The vendored verifier takes
 * a receipt as `unknown` and the vendored transport carries it as this shape (`JobView.receipt`); the fields the spec's receipt table lists (escrow_ref,
 * supplier_pkh, prompt_hash, response_hash, model, prompt_tokens, completion_tokens, wallclock_ms) are checked there, not here.
 */
export type Receipt = Record<string, unknown>;

/** What a supplier serves at GET /capability, the fields a buyer needs. `inference_api` is present only on the chat build that serves /v1/responses. */
export interface SupplierCapability {
  capability_id: string; model: string; advert_ref: string; supplier_pkh: string; pub_key_hex: string;
  inference_api?: string; max_output_tokens?: number;
}

export type SendResult =
  | { kind: 'accepted'; jobId: string }
  | { kind: 'busy' }
  | { kind: 'refused'; status: number; reason: string; message: string }
  | { kind: 'timeout' };

export type PollResult =
  | { kind: 'running'; status: string }
  | { kind: 'done'; body: Record<string, unknown>; receipt: Receipt; receiptSignature: string; submittedRef?: string }
  | { kind: 'failed'; reason: string; message: string }
  | { kind: 'gone' };

// --- The budget and the cap of each call ------------------------------------------------------------------------------------------
/** A supplier's own limit for its Claim is 60 s; a send waits 15 s longer. */
const SEND_TIMEOUT_MS = 75_000;
/** The most of an answer to a send or a poll that is read: a page of OCR text, or a Responses object, with the receipt. */
const ANSWER_BYTES = 1_000_000;
const CAPABILITY_CALL: Call = { maxResponseBytes: 64 * 1024, timeoutMs: 20_000 };
const STATUS_CALL: Call = { maxResponseBytes: 64 * 1024, timeoutMs: 2_000 };
const POLL_CALL: Call = { maxResponseBytes: ANSWER_BYTES, timeoutMs: 20_000 };
/** A job id goes into a URL and into text a person reads: letters, digits, hyphens and underscores (a UUID fits). */
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const READ_HEADERS = { accept: 'application/json' } as const;

/** What a supplier said about a failure, as the reason and the message of its envelope, bounded; the status stands in for a missing reason. */
function said(status: number, body: Record<string, unknown>): { reason: string; message: string } {
  return {
    reason: typeof body.reason === 'string' && body.reason !== '' ? body.reason.slice(0, 100) : `http_${status}`,
    message: typeof body.message === 'string' ? body.message.slice(0, 500) : '',
  };
}

// --- /capability and /status ------------------------------------------------------------------------------------------------------
const CAPABILITY_FIELDS = ['capability_id', 'model', 'advert_ref', 'supplier_pkh', 'pub_key_hex'] as const;

/**
 * GET /capability (20 s, 64 KiB): who the supplier says it is, the advert it serves and the key its receipts are signed with. Only the fields of
 * SupplierCapability are returned; the five strings are required and a supplier that lacks one is rejected, naming it. Rejects when the supplier does not
 * answer 200 with a JSON object.
 */
export async function readCapability(endpoint: string, fetchImpl: FetchLike): Promise<SupplierCapability> {
  let res: { status: number; text: string };
  try {
    res = await safeFetch(`${trim(endpoint)}/capability`, { headers: READ_HEADERS }, { ...CAPABILITY_CALL, fetchImpl });
  } catch (err) {
    throw new Error(`Could not read the capability: ${callFailure(err, CAPABILITY_CALL)}.`);
  }
  if (res.status !== 200) throw new Error(`Could not read the capability: the supplier answered ${res.status}.`);
  const body = jsonObject(res.text);
  if (body === null) throw new Error('Could not read the capability: the answer is not a JSON object.');
  const strings = {} as Record<(typeof CAPABILITY_FIELDS)[number], string>;
  for (const field of CAPABILITY_FIELDS) {
    const value = body[field];
    if (typeof value !== 'string' || value === '') throw new Error(`Could not read the capability: ${field} is missing or is not a string.`);
    strings[field] = value;
  }
  return {
    ...strings,
    ...(typeof body.inference_api === 'string' ? { inference_api: body.inference_api } : {}),
    ...(typeof body.max_output_tokens === 'number' ? { max_output_tokens: body.max_output_tokens } : {}),
  };
}

/** GET /status (2 s): the supplier's own word on whether it is free. Any failure, and any word but the three, is `unreachable`. */
export async function probeStatus(endpoint: string, fetchImpl: FetchLike): Promise<'free' | 'working' | 'offline' | 'unreachable'> {
  try {
    const res = await safeFetch(`${trim(endpoint)}/status`, { headers: READ_HEADERS }, { ...STATUS_CALL, fetchImpl });
    if (res.status !== 200) return 'unreachable';
    const status = jsonObject(res.text)?.status;
    return status === 'free' || status === 'working' || status === 'offline' ? status : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

// --- Sending a job ----------------------------------------------------------------------------------------------------------------
function refused(status: number, reason: string, message: string): SendResult {
  return { kind: 'refused', status, reason, message };
}

function sendResult(status: number, text: string): SendResult {
  const answer = jsonObject(text);
  if (answer === null) return refused(status, 'bad_response', `The supplier answered ${status} with something that is not a JSON object.`);
  if (status === 202) {
    const jobId = answer.job_id;
    if (answer.status === 'accepted' && typeof jobId === 'string' && JOB_ID.test(jobId)) return { kind: 'accepted', jobId };
    return refused(202, 'bad_response', 'The supplier answered 202 without the status accepted and a usable job_id.');
  }
  if (status === 409 && answer.reason === 'supplier_busy') return { kind: 'busy' };
  return { kind: 'refused', status, ...said(status, answer) };
}

async function send(route: Route, endpoint: string, escrowRef: string, payload: string, fetchImpl: FetchLike, timeoutMs: number): Promise<SendResult> {
  if (!Number.isFinite(timeoutMs)) throw new TypeError('timeoutMs must be a number of milliseconds.');
  const { headers, body } = route.body(canonicalRef(escrowRef), payload);
  // A budget of no time, or less, or a fraction of a millisecond, is the shortest there is: the send ends in a timeout and does not crash.
  const call: Call = { maxResponseBytes: ANSWER_BYTES, timeoutMs: Math.max(0, Math.floor(timeoutMs)) };
  let res: { status: number; text: string };
  try {
    res = await safeFetch(route.post(endpoint), { method: 'POST', headers, body }, { ...call, fetchImpl });
  } catch {
    return { kind: 'timeout' };
  }
  return sendResult(res.status, res.text);
}

/**
 * POST /v1/ocr/extract for the page of an escrow that is posted and Open: the body is `{image_b64, mime, output_format}` and nothing else, the header
 * X-Escrow-Ref the escrow. `timeoutMs` is the budget of the call, 75 s by default. Rejects only for a malformed escrow ref or a budget that is not a number,
 * before anything is sent.
 */
export function sendOcrJob(endpoint: string, escrowRef: string, body: { image_b64: string; mime: string; output_format: 'markdown' }, fetchImpl: FetchLike, timeoutMs: number = SEND_TIMEOUT_MS): Promise<SendResult> {
  return send(ROUTES.ocr, endpoint, escrowRef, JSON.stringify({ image_b64: body.image_b64, mime: body.mime, output_format: body.output_format }), fetchImpl, timeoutMs);
}

/**
 * POST /v1/responses for the prompt of an escrow that is posted and Open: the body is `{input}` and nothing else, so it is the request whose commitment the
 * caller hashed. The header and the budget are those of sendOcrJob.
 */
export function sendResponsesJob(endpoint: string, escrowRef: string, body: { input: string }, fetchImpl: FetchLike, timeoutMs: number = SEND_TIMEOUT_MS): Promise<SendResult> {
  return send(ROUTES.chat, endpoint, escrowRef, body.input, fetchImpl, timeoutMs);
}

// --- Polling a job ----------------------------------------------------------------------------------------------------------------
/** The ref a supplier names as its Submitted output, in canonical form, or undefined when it names none or not a ref: a hint, checked against the chain by whoever uses it. */
function submittedRefOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { return canonicalRef(value); } catch { return undefined; }
}

/**
 * The result of a poll answer. `escrowRef` is the canonical ref the poll was made for: a done answer must name it (a job id is a bearer token, and the
 * answer of a supplier that names another escrow, or none, is not an answer about this job).
 */
function pollResult(jobId: string, escrowRef: string, status: number, text: string): PollResult {
  const lost = (why: string) => new Error(`Could not poll job ${jobId}: the supplier answered ${status} with ${why}.`);
  const answer = jsonObject(text);
  // A 404 says the supplier no longer knows the job only in the supplier's own envelope, with the reason job_not_found: agents-marketplace
  // supplier/src/server.ts at e847a55, lines 631, 878 and 1177, jsonError(res, 404, "job_not_found", ...). Any other 404 (a page, the body of a gateway,
  // another reason) is no word of the supplier's, and the poll rejects like every other answer that is not its own (ruling R57).
  if (status === 404) {
    if (answer?.reason === 'job_not_found') return { kind: 'gone' };
    throw lost(answer === null ? 'no JSON object' : 'a JSON object that is no envelope of its own');
  }
  // A 202 says the job is not finished whatever else the body says.
  if (status === 202) return { kind: 'running', status: typeof answer?.status === 'string' && answer.status !== '' ? answer.status.slice(0, 100) : 'running' };
  if (status === 200) {
    if (answer === null) throw lost('no JSON object');
    const { receipt, receipt_signature: signature } = answer;
    // A job is done when the supplier hands over a receipt and its signature; the receipt is what the Accept is decided on. A 200 without them is no
    // answer of the supplier's (see the head of this file), and the poll does not say the job failed.
    if (!isRecord(receipt) || typeof signature !== 'string' || signature === '') throw lost('a JSON object that is no finished job (no receipt object and non-empty receipt_signature)');
    const echoed = answer.escrow_ref;
    let named: string | undefined;
    if (typeof echoed === 'string') { try { named = canonicalRef(echoed); } catch { /* names no escrow, below */ } }
    if (named === undefined) throw lost('a finished job that names no escrow (escrow_ref)');
    if (named !== escrowRef) throw lost(`a finished job of another escrow than ${escrowRef}; it is not used`);
    const submittedRef = submittedRefOf(answer.submitted_ref);
    return { kind: 'done', body: answer, receipt, receiptSignature: signature, ...(submittedRef === undefined ? {} : { submittedRef }) };
  }
  // An error status with the supplier's envelope (the failed one of a job, `{status: "failed", reason, message}`, or an error one, `{reason, message}`) is
  // its own word. A page, or a JSON object that is no envelope of the supplier's (a proxy's, a gateway's), is not: the job may well be running.
  if (status >= 400 && answer !== null && (answer.status === 'failed' || typeof answer.reason === 'string')) return { kind: 'failed', ...said(status, answer) };
  throw lost(answer === null ? 'no JSON object' : 'a JSON object that is no envelope of its own');
}

async function poll(route: Route, endpoint: string, jobId: string, fetchImpl: FetchLike, escrowRef: string): Promise<PollResult> {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new Error('The job id must be 1 to 128 letters, digits, hyphens or underscores.');
  const expected = canonicalRef(escrowRef);
  let res: { status: number; text: string };
  try {
    res = await safeFetch(route.poll(endpoint, jobId), { headers: READ_HEADERS }, { ...POLL_CALL, fetchImpl });
  } catch (err) {
    throw new Error(`Could not poll job ${jobId}: ${callFailure(err, POLL_CALL)}.`);
  }
  return pollResult(jobId, expected, res.status, res.text);
}

/**
 * GET /v1/ocr/extract/:jobId (20 s, 1,000,000 bytes) for the job that `jobId` names, sent for the escrow `escrowRef`. `done` carries the whole body of the
 * finished job (the page text and its output format among the rest, which is what the response hash is made of), the receipt and its signature, and the
 * Submitted ref when the build names one; a done answer must name `escrowRef` in its escrow_ref, or the poll rejects. Rejects as well when the call gets no
 * usable answer (see the head of this file), when the job id is not 1 to 128 letters, digits, hyphens and underscores, and when `escrowRef` is malformed,
 * the last two before anything is sent.
 */
export function pollOcrJob(endpoint: string, jobId: string, fetchImpl: FetchLike, escrowRef: string): Promise<PollResult> {
  return poll(ROUTES.ocr, endpoint, jobId, fetchImpl, escrowRef);
}

/** GET /v1/responses/:jobId, with the budget, the cap, the escrow check and the results of pollOcrJob. `done` carries the whole Responses object with the receipt fields. */
export function pollResponsesJob(endpoint: string, jobId: string, fetchImpl: FetchLike, escrowRef: string): Promise<PollResult> {
  return poll(ROUTES.chat, endpoint, jobId, fetchImpl, escrowRef);
}
