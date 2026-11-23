// packages/hire-kit/src/template-client.ts
// The HTTP side of the hire of an agent of the template contract: the send of a job (POST /v1/job with the escrow and the wire payload), the poll (GET /v1/job/:id), and the
// job that `hireOne` runs (the prompt hash of the payload, the answer text and its hash). It follows the fleet clients of buyer-core step by step: one POST per send, a poll that
// rejects for every answer that is not the supplier's own, and no endpoint and no network word in a message.
// What a send says. accepted (202 with the status accepted and a job id), busy (409 with the code supplier_busy: the runtime answers it when it or its service works another job, and
// it is the only code to retry), refused (the status, the code and the words of the envelope of the runtime: 4xx for its checks before the Claim, the terms of the escrow and its service
// among them, and 503 for a service it could not ask; or bad_response for an answer that is no envelope: a page, a gateway), timeout (no answer at all). A send that ends in anything
// but accepted and refused may have reached the supplier, which may have claimed the escrow: the caller reads the escrow before it sends again.
// The runtime writes two envelopes. A refusal of a check before the Claim is `{error: <code>, message, reason: <code>}`. Its other errors are `{reason, message, error: {reason, message}}`.
// Both carry the code as `reason`, and that is where this client reads it.
import { flatText, isRecord } from '@vsa/buyer-core';
import type { FetchLike, PollResult, SendResult } from '@vsa/buyer-core';
import { promptHashForPayload, safeFetch, sha256Utf8Hex, wirePayloadFor } from '@vsa/vector-read';
import { canonicalRef } from './format.ts';
import type { HireJob } from './hire.ts';

/** A send waits 15 s longer than the 60 s that a supplier gives its Claim. */
const SEND_TIMEOUT_MS = 75_000;
/** The most of an answer to a send or a poll that is read. */
const ANSWER_BYTES = 1_000_000;
const POLL_TIMEOUT_MS = 20_000;
/** A job id goes into a URL and into text a person reads: letters, digits, hyphens and underscores. */
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' } as const;
const READ_HEADERS = { accept: 'application/json' } as const;
/** The codes of the 503 answers that the runtime gives, before its Claim, when it could not ask its service. */
const PRECHECK_UNAVAILABLE: Readonly<Record<string, true>> = { precheck_unreachable: true, precheck_timeout: true, precheck_failed: true };
/**
 * The most bytes of body that the runtime of an agent takes in one call: 1 MiB. It refuses a body above it. The use case kit keeps a number of its own for the same limit (`RUNTIME_BODY_LIMIT_BYTES` of
 * its protocol), and a test of that kit pins the two to each other.
 */
export const RUNTIME_BODY_LIMIT_BYTES = 1_048_576;
/** The reference of the escrow that a vault Pay opens: 64 hex characters, a hash sign and output 0. A vault Pay opens its escrow at output 0, so the body of a vault hire has the size that this reference gives. */
const VAULT_ESCROW_REF = `${'0'.repeat(64)}#0`;
/** The longest reference that a body can hold: 64 hex characters, a hash sign and 10 digits, the most that an output index has. The Post of a wallet promises no output, so its body is sized with this reference. */
const LONGEST_ESCROW_REF = `${'0'.repeat(64)}#${'9'.repeat(10)}`;

/**
 * Is an answer to a send the runtime's own refusal, made before its Claim? It is the envelope of the runtime with a code (an answer that is no envelope has the code bad_response), and its
 * status is below 500, or is 503 with one of the three codes of a service that the runtime could not ask. A 404 escrow_not_found is the runtime's word about its own view of the
 * chain, which may lag, so it is not one. A 5xx with another code may come after a Claim was sent.
 */
export function isRuntimeRefusal({ status, code }: { status: number; code: string }): boolean {
  if (code === 'bad_response' || code === 'escrow_not_found') return false;
  return status < 500 || (status === 503 && PRECHECK_UNAVAILABLE[code] === true);
}

/** The status and the code of the answer of the service of an agent, as the runtime writes them into a job that failed. Both are numbers and texts, or both are `null`. */
export interface ServiceFailure { service_status: number | null; service_code: string | null }
/** The reason that the runtime gives a job whose service answered with an HTTP error: `service_http_<status>`, with the three digits of a status from 100 to 599. */
const SERVICE_REASON = /^service_http_([1-5][0-9]{2})$/;
/**
 * The start of the message that the runtime writes with that reason: `service returned HTTP <status>: ` and the first 200 characters of the answer of the service. A service of an agent answers with an
 * error as `{"error":"<code>", ...}`, and the code is 1 to 64 lower-case letters and underscores.
 */
const SERVICE_ANSWER = /^service returned HTTP ([1-5][0-9]{2}): \{"error":"([a-z_]{1,64})"/;

/**
 * The status and the code of the answer of the service, read from the words of a job that the runtime failed, or `null` and `null`. The runtime writes the failure of its service in one frame: the reason
 * `service_http_<status>` and the message `service returned HTTP <status>: <the start of the answer>`. The code is read at the start of the answer only, and only when the reason and the message name the same
 * status. So a form inside the reason of the poll, later in the answer, or in the words of a supplier that does not write this frame gives nothing: a code is never read from free text, and a status is never read
 * alone. The status and the code are given as they came. What they mean is for the caller to decide: the kit does not know the codes of any protocol.
 */
export function serviceFailureOf(words: { reason: string; message: string } | undefined): ServiceFailure {
  const none: ServiceFailure = { service_status: null, service_code: null };
  if (words === undefined) return none;
  const reason = SERVICE_REASON.exec(words.reason);
  const answer = SERVICE_ANSWER.exec(words.message);
  if (reason === null || answer === null || reason[1] !== answer[1]) return none;
  return { service_status: Number(reason[1]), service_code: answer[2] };
}

/** The endpoint without the slashes at its end. It comes from an advert on the chain, so no pattern runs over it: a loop on the last character does it. */
function trim(endpoint: string): string {
  let end = endpoint.length;
  while (end > 0 && endpoint[end - 1] === '/') end -= 1;
  return endpoint.slice(0, end);
}
function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch { return null; }
}
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The code of an envelope of the runtime: its `reason`. Flat and bounded (the supplier wrote it). */
function codeOf(body: Record<string, unknown>): string | undefined {
  return nonEmpty(body.reason) ? flatText(body.reason, 100) : undefined;
}
/** The words of an envelope of the runtime: its `message`. Flat and bounded. */
const messageOf = (body: Record<string, unknown>): string => (typeof body.message === 'string' ? flatText(body.message, 500) : '');
const refused = (status: number, reason: string, message: string): SendResult => ({ kind: 'refused', status, reason, message });

function sendResult(status: number, text: string): SendResult {
  const answer = jsonObject(text);
  if (answer === null) return refused(status, 'bad_response', `The agent answered ${status} with something that is not a JSON object.`);
  if (status === 202) {
    const { job_id: jobId } = answer;
    if (answer.status === 'accepted' && typeof jobId === 'string' && JOB_ID.test(jobId)) return { kind: 'accepted', jobId };
    return refused(202, 'bad_response', 'The agent answered 202 without the status accepted and a usable job_id.');
  }
  const code = codeOf(answer);
  // A JSON object without a code is a gateway's or a proxy's in front of the agent, and is no more its verdict than a page is.
  if (code === undefined) return refused(status, 'bad_response', `The agent answered ${status} with a JSON object that is not its envelope (no code).`);
  if (status === 409 && code === 'supplier_busy') return { kind: 'busy' };
  return refused(status, code, messageOf(answer));
}

/** The body of the call that sends a job: the escrow and the wire form of the payload. It is written here only, so that the size that is checked before the Pay is the size that is sent after it. */
function sendBody(escrowRef: string, payload: string): string {
  return JSON.stringify({ escrow_ref: escrowRef, payload: wirePayloadFor(payload) });
}

/**
 * The most bytes that the body of the send of `payload` can have, in bytes of UTF-8 as the runtime counts them. The escrow of a send exists only after the payment, so the body is sized with the
 * reference that the payment will give: output 0 for a vault Pay (`fromVault`), and the longest reference for a Post of the wallet. The real body is never longer than the body that this gives.
 */
export function bodyBytesOf(payload: string, fromVault: boolean): number {
  return Buffer.byteLength(sendBody(fromVault ? VAULT_ESCROW_REF : LONGEST_ESCROW_REF, payload), 'utf8');
}

/**
 * POST /v1/job of the endpoint for the payload of an escrow that is posted and Open: the body is `{escrow_ref, payload}` where the payload is the wire form of the text whose hash the
 * escrow commits to. `timeoutMs` is the budget of the call, 75 s by default. Rejects only for a malformed escrow ref or a budget that is not a number, before anything is sent.
 */
export async function sendTemplateJob(endpoint: string, escrowRef: string, payload: string, fetchImpl: FetchLike, timeoutMs: number = SEND_TIMEOUT_MS): Promise<SendResult> {
  if (!Number.isFinite(timeoutMs)) throw new TypeError('timeoutMs must be a number of milliseconds.');
  const body = sendBody(canonicalRef(escrowRef), payload);
  let res: { status: number; text: string };
  try {
    res = await safeFetch(`${trim(endpoint)}/v1/job`, { method: 'POST', headers: { ...JSON_HEADERS }, body }, { maxResponseBytes: ANSWER_BYTES, timeoutMs: Math.max(0, Math.floor(timeoutMs)), fetchImpl });
  } catch {
    return { kind: 'timeout' };
  }
  return sendResult(res.status, res.text);
}

function pollResult(jobId: string, escrowRef: string, status: number, text: string): PollResult {
  const lost = (why: string) => new Error(`Could not poll job ${jobId}: the agent answered ${status} with ${why}.`);
  const answer = jsonObject(text);
  // A 404 says the agent no longer knows the job only in its own envelope, with the code job_not_found. Any other 404 is no word of the agent's.
  if (status === 404) {
    if (answer !== null && codeOf(answer) === 'job_not_found') return { kind: 'gone' };
    throw lost(answer === null ? 'no JSON object' : 'a JSON object that is no envelope of its own');
  }
  if (status === 202) return { kind: 'running', status: typeof answer?.status === 'string' && answer.status !== '' ? flatText(answer.status, 100) : 'running' };
  if (status === 200) {
    if (answer === null) throw lost('no JSON object');
    const { receipt, receipt_signature: signature, escrow_ref: echoed, submitted_ref: submitted } = answer;
    if (!isRecord(receipt) || !nonEmpty(signature)) throw lost('a JSON object that is no finished job (no receipt object and non-empty receipt_signature)');
    let named: string | undefined;
    if (typeof echoed === 'string') { try { named = canonicalRef(echoed); } catch { /* it names no escrow, below */ } }
    if (named === undefined) throw lost('a finished job that names no escrow (escrow_ref)');
    if (named !== escrowRef) throw lost(`a finished job of another escrow than ${escrowRef}; it is not used`);
    let submittedRef: string | undefined;
    if (typeof submitted === 'string') { try { submittedRef = canonicalRef(submitted); } catch { /* a hint only: the chain is read for the output */ } }
    return { kind: 'done', body: answer, receipt, receiptSignature: signature, ...(submittedRef === undefined ? {} : { submittedRef }) };
  }
  const code = answer === null ? undefined : codeOf(answer);
  if (status >= 400 && answer !== null && (answer.status === 'failed' || code !== undefined)) return { kind: 'failed', reason: code ?? `http_${status}`, message: messageOf(answer) };
  throw lost(answer === null ? 'no JSON object' : 'a JSON object that is no envelope of its own');
}

/**
 * GET /v1/job/:jobId (20 s, 1,000,000 bytes) for the job that `jobId` names, sent for the escrow `escrowRef`. `done` carries the whole body, the receipt and its signature, and the
 * Submitted ref when the agent names one. A done answer must name `escrowRef`, or the poll rejects. The poll rejects as well when the call gets no usable answer, when the job id
 * is not 1 to 128 letters, digits, hyphens and underscores, and when `escrowRef` is malformed, the last two before anything is sent.
 */
export async function pollTemplateJob(endpoint: string, jobId: string, fetchImpl: FetchLike, escrowRef: string): Promise<PollResult> {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new Error('The job id must be 1 to 128 letters, digits, hyphens or underscores.');
  const expected = canonicalRef(escrowRef);
  let res: { status: number; text: string };
  try {
    res = await safeFetch(`${trim(endpoint)}/v1/job/${encodeURIComponent(jobId)}`, { headers: { ...READ_HEADERS } }, { maxResponseBytes: ANSWER_BYTES, timeoutMs: POLL_TIMEOUT_MS, fetchImpl });
  } catch {
    throw new Error(`Could not poll job ${jobId}: the call got no answer.`);
  }
  return pollResult(jobId, expected, res.status, res.text);
}

/** What the kit keeps of the answer of an agent: the text of its first choice, which is what the response hash of the receipt is made of. */
export interface TemplateAnswer { text: string }

/**
 * The job of one request to an agent. Its prompt hash is the hash of the wire form of `payload`, the commitment the template checks. Its `read` takes the text of the first choice
 * of the finished body and hashes it with sha256, as the template does, and refuses a body that has no such text.
 */
export function templateJob(endpoint: string, payload: string, label: string, fetchImpl: FetchLike): HireJob<TemplateAnswer> {
  if (typeof payload !== 'string' || payload === '') throw new TypeError('The payload must be a non-empty string.');
  return {
    label,
    promptHash: promptHashForPayload(payload),
    send: (escrowRef) => sendTemplateJob(endpoint, escrowRef, payload, fetchImpl),
    poll: (jobId, escrowRef) => pollTemplateJob(endpoint, jobId, fetchImpl, escrowRef),
    read: (body) => {
      const { choices } = body;
      if (!Array.isArray(choices)) throw new Error('its choices are not a list');
      const first: unknown = choices[0];
      if (!isRecord(first)) throw new Error('it has no first choice');
      const { message } = first;
      if (!isRecord(message) || typeof message.content !== 'string') throw new Error('its first choice has no text');
      const text = message.content;
      return { responseHash: sha256Utf8Hex(text), value: { text } };
    },
    // The runtime answers 503 with one of three codes when it could not ask its service before the Claim: it claimed nothing, so the refusal is final and the job is not sent again.
    finalRefusal: ({ status, reason }) => status === 503 && PRECHECK_UNAVAILABLE[reason] === true,
  };
}
