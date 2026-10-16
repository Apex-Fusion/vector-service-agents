// packages/buyer-core/test/fleet-clients.test.ts
// The HTTP side of a fleet hire, through a fake fetch: sending a job to a supplier once its escrow is posted, polling it, and reading /capability
// and /status. The protocol is the fleet's (Apex-Fusion/agents-marketplace at e847a55, supplier/src/server.ts): X-Escrow-Ref on every send, 202 after the
// supplier's Claim, 409 supplier_busy with the escrow still Open, an envelope {reason, message} on any other refusal, 202 while a job runs, 200 with the
// receipt when it is done, {status: "failed", ...} when it failed, 404 once it is evicted.
// Every call goes through safeFetch (https only, private ranges refused, no redirects, a byte cap and a budget). The endpoints below are IP literals of
// the documentation range 203.0.113.0/24: public for safeFetch, and no host lookup, so no test depends on DNS.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { canonicalize, sha256Utf8Hex } from '@vsa/vector-read';
import { ocrResponseHash, responsesOutputText, responsesResponseHash } from '../src/commitments.ts';
import { readCapability, probeStatus, sendOcrJob, sendResponsesJob, pollOcrJob, pollResponsesJob } from '../src/fleet-clients.ts';
import type { PollResult, SendResult } from '../src/fleet-clients.ts';
import { boom, hang, json, routedFetch, text } from './fake-fetch.ts';
import type { Answer } from './fake-fetch.ts';

afterEach(() => { vi.restoreAllMocks(); });

const ENDPOINT = 'https://203.0.113.10';
const ESCROW = `${'ab'.repeat(32)}#0`;
const JOB = '8f0d7b52-5d2c-4c6e-9d57-3f6f3a1c9b10';
const OCR_BODY = { image_b64: 'iVBORw0KGgo=', mime: 'image/png', output_format: 'markdown' } as const;
const CHAT_BODY = { input: 'Summarise the pages.' };
const RECEIPT = { escrow_ref: ESCROW, supplier_pkh: 'cd'.repeat(28), prompt_hash: 'ef'.repeat(32), response_hash: '12'.repeat(32), model: 'historical-records-ocr-v1', prompt_tokens: 0, completion_tokens: 0, wallclock_ms: 4210 };
const SIGNATURE = '9a'.repeat(64);
const OCR_DONE = { output_format: 'markdown', content: 'Page one of the test document.', usage: { prompt_tokens: 812, completion_tokens: 9, total_tokens: 821 }, receipt: RECEIPT, receipt_signature: SIGNATURE, escrow_ref: ESCROW };
const CHAT_DONE = {
  id: 'resp_1', object: 'response', status: 'completed', incomplete_details: null, model: 'deepseek/deepseek-v4-flash',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A summary.' }] }],
  usage: { input_tokens: 40, output_tokens: 3, total_tokens: 43 }, receipt: RECEIPT, receipt_signature: SIGNATURE, escrow_ref: ESCROW,
};

/** A JSON text of exactly `bytes` bytes. `make` builds it around the padding it is given, so the size is found by measuring. */
function exactly(bytes: number, make: (pad: string) => string): string {
  const text = make('x'.repeat(bytes - Buffer.byteLength(make(''))));
  expect(Buffer.byteLength(text)).toBe(bytes);
  return text;
}
// The outbound policy itself (https only, private and reserved ranges, credentials, redirects) is tested where it lives, in packages/vector-read. Here one
// refused endpoint for each function pins that the call goes through it: a private address is never reached, whichever function is called.
const PRIVATE = 'https://10.0.0.5';

// --- Sending a job ----------------------------------------------------------------------------------------------------------------
type Sender = (endpoint: string, escrowRef: string, fetchImpl: typeof fetch, timeoutMs?: number) => Promise<SendResult>;
const SENDERS: Array<{ name: string; path: string; send: Sender; wire: object }> = [
  { name: 'sendOcrJob', path: '/v1/ocr/extract', send: (e, r, f, ms) => sendOcrJob(e, r, OCR_BODY, f, ms), wire: OCR_BODY },
  { name: 'sendResponsesJob', path: '/v1/responses', send: (e, r, f, ms) => sendResponsesJob(e, r, CHAT_BODY, f, ms), wire: CHAT_BODY },
];

describe.each(SENDERS)('$name', ({ path, send, wire }) => {
  const route = (answer: Answer, endpoint = ENDPOINT) => routedFetch({ [`POST ${endpoint}${path}`]: answer });
  const accepted = json(202, { job_id: JOB, status: 'accepted', escrow_ref: ESCROW });

  it('a 202 accepted with a job id is accepted, and the request is the fleet one: POST to the route, X-Escrow-Ref, JSON, the body and nothing else', async () => {
    const f = route(accepted);
    expect(await send(ENDPOINT, ESCROW, f.fetchImpl)).toStrictEqual({ kind: 'accepted', jobId: JOB });
    expect(f.calls).toHaveLength(1);
    const [call] = f.calls;
    expect([call.method, call.url]).toStrictEqual(['POST', `${ENDPOINT}${path}`]);
    expect(call.headers['x-escrow-ref']).toBe(ESCROW);
    expect(call.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call.body ?? 'null')).toStrictEqual(wire);
  });

  it('reaches the route from an endpoint with trailing slashes or a path', async () => {
    const withSlash = route(accepted);
    expect((await send(`${ENDPOINT}///`, ESCROW, withSlash.fetchImpl)).kind).toBe('accepted');
    expect(withSlash.calls[0].url).toBe(`${ENDPOINT}${path}`);
    const withPath = route(accepted, `${ENDPOINT}/p2a/tools/one`);
    expect((await send(`${ENDPOINT}/p2a/tools/one/`, ESCROW, withPath.fetchImpl)).kind).toBe('accepted');
  });

  it('writes the escrow ref in its canonical spelling (lower-case hex), and refuses a malformed one before anything is sent', async () => {
    const f = route(accepted);
    await send(ENDPOINT, `${'AB'.repeat(32)}#0`, f.fetchImpl);
    expect(f.calls[0].headers['x-escrow-ref']).toBe(ESCROW);
    const none = route(accepted);
    await expect(send(ENDPOINT, 'not-a-ref', none.fetchImpl)).rejects.toThrow(/Invalid out ref/);
    await expect(send(ENDPOINT, `${'ab'.repeat(32)}`, none.fetchImpl)).rejects.toThrow(/Invalid out ref/);
    expect(none.calls).toHaveLength(0);
  });

  it('a 409 supplier_busy is busy: the escrow stays Open and nothing was claimed', async () => {
    const f = route(json(409, { reason: 'supplier_busy', message: 'supplier is already working another job', error: { reason: 'supplier_busy', message: 'supplier is already working another job' } }));
    expect(await send(ENDPOINT, ESCROW, f.fetchImpl)).toStrictEqual({ kind: 'busy' });
  });

  it('a 409 prompt_mismatch is refused with its status, reason and message, never busy', async () => {
    const f = route(json(409, { reason: 'prompt_mismatch', message: 'prompt_hash in escrow does not match the request' }));
    expect(await send(ENDPOINT, ESCROW, f.fetchImpl)).toStrictEqual({ kind: 'refused', status: 409, reason: 'prompt_mismatch', message: 'prompt_hash in escrow does not match the request' });
  });

  it.each([
    [400, 'escrow_ref_malformed'], [404, 'escrow_not_found'], [409, 'escrow_not_claimable'], [409, 'capability_mismatch'],
    [500, 'internal_error'], [502, 'upstream_error'], [503, 'evidence_unavailable'], [504, 'claim_timeout'],
  ])('a %i with the envelope reason %s is refused with that reason and message', async (status, reason) => {
    const f = route(json(status, { reason, message: `message of ${reason}` }));
    expect(await send(ENDPOINT, ESCROW, f.fetchImpl)).toStrictEqual({ kind: 'refused', status, reason, message: `message of ${reason}` });
  });

  it('an envelope without a reason is refused as http_<status>, with an empty message', async () => {
    const f = route(json(503, { detail: 'down for maintenance' }));
    expect(await send(ENDPOINT, ESCROW, f.fetchImpl)).toStrictEqual({ kind: 'refused', status: 503, reason: 'http_503', message: '' });
  });

  it('flattens what a supplier says about a refusal: every control character of its reason and its message becomes a space (ruling R64)', async () => {
    const f = route(json(409, { reason: 'prompt\nmismatch', message: 'line one\nline two \u001b[31mred\u001b[0m' }));
    expect(await send(ENDPOINT, ESCROW, f.fetchImpl)).toStrictEqual({ kind: 'refused', status: 409, reason: 'prompt mismatch', message: 'line one line two  [31mred [0m' });
  });

  it('bounds what a supplier says about a refusal: 100 characters of reason, 500 of message', async () => {
    const f = route(json(400, { reason: 'r'.repeat(300), message: 'm'.repeat(2000) }));
    const result = await send(ENDPOINT, ESCROW, f.fetchImpl);
    expect(result).toMatchObject({ kind: 'refused', status: 400 });
    expect(result.kind === 'refused' && [result.reason.length, result.message.length]).toStrictEqual([100, 500]);
  });

  it.each([
    ['a 202 whose body is not JSON', text(202, '<html>accepted</html>')],
    ['a 409 whose body is not JSON', text(409, 'busy')],
    ['a 502 page of a proxy', text(502, '<html>Bad gateway</html>', 'text/html')],
    ['a 200 with an empty body', text(200, '')],
    ['a 202 whose JSON is not an object', json(202, ['accepted'])],
    ['a 409 whose JSON is null', json(409, null)],
  ])('%s is refused as bad_response, with its status', async (_name, answer) => {
    const f = route(answer);
    const result = await send(ENDPOINT, ESCROW, f.fetchImpl);
    expect(result).toMatchObject({ kind: 'refused', status: answer.status, reason: 'bad_response' });
  });

  it.each([
    ['no status', { job_id: JOB }],
    ['a status that is not accepted', { job_id: JOB, status: 'running' }],
    ['no job id', { status: 'accepted' }],
    ['an empty job id', { status: 'accepted', job_id: '' }],
    ['a job id that is not a string', { status: 'accepted', job_id: 7 }],
    ['a job id that would leave the route', { status: 'accepted', job_id: '../v1/admin' }],
    ['a job id of 129 characters', { status: 'accepted', job_id: 'a'.repeat(129) }],
  ])('a 202 with %s is refused as bad_response: the job id goes into a URL and into text', async (_name, body) => {
    const f = route(json(202, body));
    expect(await send(ENDPOINT, ESCROW, f.fetchImpl)).toMatchObject({ kind: 'refused', status: 202, reason: 'bad_response' });
  });

  it('a status that is not an answer to a send (a 200) is refused with its status, not accepted', async () => {
    const f = route(json(200, { job_id: JOB, status: 'accepted' }));
    expect(await send(ENDPOINT, ESCROW, f.fetchImpl)).toStrictEqual({ kind: 'refused', status: 200, reason: 'http_200', message: '' });
  });

  it('a call that outlasts its budget is a timeout, and the fetch itself was told to stop; the client never sends again by itself', async () => {
    const f = route(hang);
    expect(await send(ENDPOINT, ESCROW, f.fetchImpl, 25)).toStrictEqual({ kind: 'timeout' });
    expect(f.calls[0].signal?.aborted).toBe(true);
    // A POST that timed out may have claimed the escrow, so a second one would be a blind retry: that is for the caller to decide, after it has read the escrow.
    expect(f.calls).toHaveLength(1);
  });

  it('a network error is a timeout too: the outcome of the POST is unknown either way, so the caller reads the escrow before it sends again, and the client sends once', async () => {
    const f = route(boom);
    expect(await send(ENDPOINT, ESCROW, f.fetchImpl)).toStrictEqual({ kind: 'timeout' });
    expect(f.calls).toHaveLength(1);
  });

  it('the budget is timeoutMs, 75 s by default (the supplier answers only after its own Claim, which takes up to 60 s); a budget of no time is a timeout, not a crash', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const f = route(accepted);
    await send(ENDPOINT, ESCROW, f.fetchImpl);
    expect(spy).toHaveBeenLastCalledWith(75_000);
    await send(ENDPOINT, ESCROW, f.fetchImpl, 90_000);
    expect(spy).toHaveBeenLastCalledWith(90_000);
    await send(ENDPOINT, ESCROW, f.fetchImpl, 1234.7);
    expect(spy).toHaveBeenLastCalledWith(1234);
    const stalled = route(hang);
    expect(await send(ENDPOINT, ESCROW, stalled.fetchImpl, 0)).toStrictEqual({ kind: 'timeout' });
    expect(spy).toHaveBeenLastCalledWith(0);
    expect(await send(ENDPOINT, ESCROW, stalled.fetchImpl, -5)).toStrictEqual({ kind: 'timeout' });
    expect(spy).toHaveBeenLastCalledWith(0);
    await expect(send(ENDPOINT, ESCROW, f.fetchImpl, Number.NaN)).rejects.toThrow(TypeError);
    await expect(send(ENDPOINT, ESCROW, f.fetchImpl, Number.POSITIVE_INFINITY)).rejects.toThrow(TypeError);
  });

  it('reads at most 1,000,000 bytes of the answer: a body of that size is read, one byte more is a timeout (no answer was read)', async () => {
    const envelope = (pad: string) => JSON.stringify({ reason: 'prompt_mismatch', message: pad });
    const atCap = route(text(409, exactly(1_000_000, envelope), 'application/json'));
    expect(await send(ENDPOINT, ESCROW, atCap.fetchImpl)).toMatchObject({ kind: 'refused', status: 409, reason: 'prompt_mismatch' });
    const over = route(text(409, exactly(1_000_001, envelope), 'application/json'));
    expect(await send(ENDPOINT, ESCROW, over.fetchImpl)).toStrictEqual({ kind: 'timeout' });
  });

  it('never sends to a private address: the outbound policy refuses it before a byte leaves, and the result is a timeout', async () => {
    const f = route(accepted, PRIVATE);
    expect(await send(PRIVATE, ESCROW, f.fetchImpl)).toStrictEqual({ kind: 'timeout' });
    expect(f.calls).toHaveLength(0);
  });

  it('does not follow a redirect: one call, a timeout', async () => {
    const f = route(() => new Response(null, { status: 302, headers: { location: 'https://203.0.113.99/v1/elsewhere' } }));
    expect(await send(ENDPOINT, ESCROW, f.fetchImpl)).toStrictEqual({ kind: 'timeout' });
    expect(f.calls).toHaveLength(1);
  });
});

describe('what goes on the wire', () => {
  it('sendOcrJob puts {image_b64, mime, output_format} on the wire and nothing else, whatever else the caller object carries', async () => {
    const f = routedFetch({ [`POST ${ENDPOINT}/v1/ocr/extract`]: json(202, { job_id: JOB, status: 'accepted' }) });
    const noisy = { ...OCR_BODY, max_output_tokens: 9, note: 'not part of the commitment' };
    await sendOcrJob(ENDPOINT, ESCROW, noisy, f.fetchImpl, 1000);
    expect(f.calls[0].body).toBe('{"image_b64":"iVBORw0KGgo=","mime":"image/png","output_format":"markdown"}');
  });

  it('sendResponsesJob puts {input} on the wire and nothing else: the body is the request whose commitment the caller hashed', async () => {
    const f = routedFetch({ [`POST ${ENDPOINT}/v1/responses`]: json(202, { job_id: JOB, status: 'accepted' }) });
    const noisy = { ...CHAT_BODY, max_output_tokens: 512, model: 'another', messages: [] };
    await sendResponsesJob(ENDPOINT, ESCROW, noisy, f.fetchImpl, 1000);
    expect(f.calls[0].body).toBe('{"input":"Summarise the pages."}');
  });
});

// --- Polling a job ----------------------------------------------------------------------------------------------------------------
type PollerFor = (endpoint: string, jobId: string, fetchImpl: typeof fetch, escrowRef: string) => Promise<PollResult>;
const POLLERS: Array<{ name: string; path: string; pollFor: PollerFor; done: Record<string, unknown> }> = [
  { name: 'pollOcrJob', path: '/v1/ocr/extract', pollFor: pollOcrJob, done: OCR_DONE },
  { name: 'pollResponsesJob', path: '/v1/responses', pollFor: pollResponsesJob, done: CHAT_DONE },
];

describe.each(POLLERS)('$name', ({ path, pollFor, done }) => {
  const url = `${ENDPOINT}${path}/${JOB}`;
  const route = (answer: Answer) => routedFetch({ [`GET ${url}`]: answer });
  /** The poll for the escrow that the answers below are for. */
  const poll = (endpoint: string, jobId: string, fetchImpl: typeof fetch) => pollFor(endpoint, jobId, fetchImpl, ESCROW);

  it.each(['accepted', 'running'])('a 202 %s is running, and the request is a GET of the job route with no body', async (status) => {
    const f = route(json(202, { status, escrow_ref: ESCROW }));
    expect(await poll(ENDPOINT, JOB, f.fetchImpl)).toStrictEqual({ kind: 'running', status });
    expect(f.calls).toHaveLength(1);
    expect([f.calls[0].method, f.calls[0].url, f.calls[0].body]).toStrictEqual(['GET', url, undefined]);
    expect(f.calls[0].headers.accept).toBe('application/json');
  });

  it('flattens what a supplier says on a poll: the status of a running job and the reason and message of a failed one (ruling R64)', async () => {
    expect(await poll(ENDPOINT, JOB, route(json(202, { status: 'running\n\u001b[2Kforged', escrow_ref: ESCROW })).fetchImpl)).toStrictEqual({ kind: 'running', status: 'running  [2Kforged' });
    const failed = await poll(ENDPOINT, JOB, route(json(502, { status: 'failed', reason: 'up\nstream', message: 'a\r\nb', escrow_ref: ESCROW })).fetchImpl);
    expect(failed).toStrictEqual({ kind: 'failed', reason: 'up stream', message: 'a  b' });
  });

  it('a 202 whose body says nothing usable is still running: the status code is the answer', async () => {
    expect(await poll(ENDPOINT, JOB, route(text(202, 'ok')).fetchImpl)).toStrictEqual({ kind: 'running', status: 'running' });
    expect(await poll(ENDPOINT, JOB, route(json(202, { status: 7 })).fetchImpl)).toStrictEqual({ kind: 'running', status: 'running' });
  });

  it('a 200 with a receipt and its signature is done: the whole body, the receipt, the signature, and the Submitted ref in its canonical spelling when the build gives one', async () => {
    const withRef = { ...done, submitted_ref: `${'AB12'.repeat(16)}#1` };
    const result = await poll(ENDPOINT, JOB, route(json(200, withRef)).fetchImpl);
    expect(result).toStrictEqual({ kind: 'done', body: withRef, receipt: RECEIPT, receiptSignature: SIGNATURE, submittedRef: `${'ab12'.repeat(16)}#1` });
  });

  it('a done job of an older build has no Submitted ref, and the result has no such key', async () => {
    const result = await poll(ENDPOINT, JOB, route(json(200, done)).fetchImpl);
    expect(result).toStrictEqual({ kind: 'done', body: done, receipt: RECEIPT, receiptSignature: SIGNATURE });
    expect('submittedRef' in result).toBe(false);
  });

  it.each([[7], ['not a ref'], [''], [null], [`${'ab'.repeat(32)}#`]])('a Submitted ref that is not a ref (%j) is left out: it is a hint, and nothing is checked on it here', async (junk) => {
    const result = await poll(ENDPOINT, JOB, route(json(200, { ...done, submitted_ref: junk })).fetchImpl);
    expect(result.kind).toBe('done');
    expect('submittedRef' in result).toBe(false);
  });

  // The supplier answers 200 for a done job only, always with its receipt and the signature, and sends a failed job with its own envelope on an error
  // status. So a 200 without them is no answer of the supplier's (a proxy page, a gateway body): the poll rejects, like a 502 page, and says nothing of the job.
  it.each([
    ['no receipt', { ...done, receipt: undefined }],
    ['a receipt that is not an object', { ...done, receipt: 'signed' }],
    ['a receipt that is an array', { ...done, receipt: [RECEIPT] }],
    ['no signature', { ...done, receipt_signature: undefined }],
    ['an empty signature', { ...done, receipt_signature: '' }],
    ['a signature that is not a string', { ...done, receipt_signature: 12 }],
    ['the failed envelope of a job', { status: 'failed', reason: 'upstream_unavailable', message: 'the model provider did not answer', escrow_ref: ESCROW }],
  ])('a 200 with %s rejects, naming the job and the status', async (_name, body) => {
    await expect(poll(ENDPOINT, JOB, route(json(200, body)).fetchImpl)).rejects.toThrow(new RegExp(`^Could not poll job ${JOB}: the supplier answered 200 with a JSON object that is no finished job`));
  });

  it.each([['not JSON', text(200, 'Service Unavailable')], ['a JSON array', json(200, [done])], ['an empty body', text(200, '')]])('a 200 whose body is %s rejects the same way', async (_name, answer) => {
    await expect(poll(ENDPOINT, JOB, route(answer).fetchImpl)).rejects.toThrow(new RegExp(`^Could not poll job ${JOB}: the supplier answered 200 with no JSON object`));
  });

  it('a 200 that is no finished job never yields done, and does not say the job failed; the message does not name the endpoint', async () => {
    const answers = [text(200, 'Service Unavailable'), text(200, ''), json(200, {}), json(200, [done]), json(200, { ...done, receipt: undefined }), json(200, { ...done, receipt_signature: '' })];
    for (const answer of answers) {
      const outcome = await poll(ENDPOINT, JOB, route(answer).fetchImpl).then((result) => result, (error: unknown) => error);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as { kind?: string }).kind).not.toBe('done');
      expect((outcome as { kind?: string }).kind).not.toBe('failed');
      expect((outcome as Error).message).not.toContain('203.0.113.10');
    }
  });

  it('a done answer must name the escrow the poll was made for, in its escrow_ref: in any spelling of the hex', async () => {
    const shouted = await poll(ENDPOINT, JOB, route(json(200, { ...done, escrow_ref: ESCROW.toUpperCase() })).fetchImpl);
    expect(shouted.kind).toBe('done');
  });

  it.each([
    ['another transaction', `${'cd'.repeat(32)}#0`],
    ['another output of the same transaction', `${'ab'.repeat(32)}#1`],
  ])('a done answer that names %s rejects: it is not an answer about this job, and its text and receipt are not used', async (_name, other) => {
    await expect(poll(ENDPOINT, JOB, route(json(200, { ...done, escrow_ref: other })).fetchImpl))
      .rejects.toThrow(new RegExp(`^Could not poll job ${JOB}: the supplier answered 200 with a finished job of another escrow than ${ESCROW}; it is not used\\.$`));
  });

  it.each([['no escrow_ref', undefined], ['an escrow_ref that is null', null], ['an escrow_ref that is not a string', 7], ['an empty escrow_ref', ''], ['an escrow_ref that is not a ref', 'not a ref']])('a done answer with %s rejects: it names no escrow', async (_name, value) => {
    await expect(poll(ENDPOINT, JOB, route(json(200, { ...done, escrow_ref: value })).fetchImpl)).rejects.toThrow(/a finished job that names no escrow/);
  });

  it('takes the escrow the poll is made for in any spelling too', async () => {
    const f = route(json(200, done));
    expect((await pollFor(ENDPOINT, JOB, f.fetchImpl, ESCROW.toUpperCase())).kind).toBe('done');
  });

  it('the escrow checked is the one the answer itself names, not the one in the receipt', async () => {
    // The receipt names the right escrow and the answer names another: the result is not used.
    await expect(poll(ENDPOINT, JOB, route(json(200, { ...done, receipt: RECEIPT, escrow_ref: `${'cd'.repeat(32)}#0` })).fetchImpl)).rejects.toThrow(/another escrow/);
  });

  it('refuses a malformed escrow ref before anything is sent', async () => {
    const f = route(json(200, done));
    for (const bad of ['not-a-ref', ESCROW.slice(0, 64), '']) await expect(pollFor(ENDPOINT, JOB, f.fetchImpl, bad)).rejects.toThrow(/Invalid out ref/);
    expect(f.calls).toHaveLength(0);
  });

  it('a 404 with the envelope of the supplier, reason job_not_found, is gone: the supplier restarted or evicted the job', async () => {
    // The fleet's own answer: {reason, message, error: {reason, message}} (agents-marketplace supplier/src/server.ts at e847a55).
    const envelope = { reason: 'job_not_found', message: `no job found with id ${JOB}`, error: { reason: 'job_not_found', message: `no job found with id ${JOB}` } };
    expect(await poll(ENDPOINT, JOB, route(json(404, envelope)).fetchImpl)).toStrictEqual({ kind: 'gone' });
  });

  // Ruling R57: a 404 from anything in front of the supplier is no word of the supplier's that the job is gone, and the caller polls again.
  it.each([
    ['a page', text(404, '<html><body>Not Found</body></html>', 'text/html')], ['plain text', text(404, 'not found')], ['an empty body', text(404, '')],
    ['a JSON object of a gateway', json(404, { error: 'not found' })], ['an envelope with another reason', json(404, { reason: 'no_route', message: 'nothing here' })], ['a JSON array', json(404, [])],
  ])('a 404 with %s is no answer of the supplier: the poll rejects, so the caller asks again', async (_name, answer) => {
    await expect(poll(ENDPOINT, JOB, route(answer).fetchImpl)).rejects.toThrow(new RegExp(`^Could not poll job ${JOB}: the supplier answered 404 with (no JSON object|a JSON object that is no envelope of its own)`));
  });

  it.each([502, 503, 504, 500, 400])('a %i with the failed envelope is failed with the reason and the message of the supplier', async (status) => {
    const f = route(json(status, { status: 'failed', reason: 'upstream_unavailable', message: 'the model provider did not answer', escrow_ref: ESCROW }));
    expect(await poll(ENDPOINT, JOB, f.fetchImpl)).toStrictEqual({ kind: 'failed', reason: 'upstream_unavailable', message: 'the model provider did not answer' });
  });

  it('an error envelope of the supplier without the failed status is its word too; without a reason it is http_<status>; what it says is bounded', async () => {
    expect(await poll(ENDPOINT, JOB, route(json(400, { reason: 'invalid_job_id', message: 'jobId must be a UUIDv4 string' })).fetchImpl)).toStrictEqual({ kind: 'failed', reason: 'invalid_job_id', message: 'jobId must be a UUIDv4 string' });
    expect(await poll(ENDPOINT, JOB, route(json(500, { status: 'failed' })).fetchImpl)).toStrictEqual({ kind: 'failed', reason: 'http_500', message: '' });
    const long = await poll(ENDPOINT, JOB, route(json(500, { status: 'failed', reason: 'r'.repeat(300), message: 'm'.repeat(2000) })).fetchImpl);
    expect(long.kind === 'failed' && [long.reason.length, long.message.length]).toStrictEqual([100, 500]);
  });

  it.each([
    ['a proxy page', text(502, '<html>Bad gateway</html>', 'text/html')],
    ['an empty 503', text(503, '')],
    ['a 429 with plain text', text(429, 'slow down')],
    ['a gateway error as JSON, without a reason', json(502, { error: 'bad gateway' })],
    ['a gateway message as JSON', json(503, { message: 'Service Unavailable' })],
    ['a JSON array', json(500, [])],
  ])('%s is no answer of the supplier: the poll rejects, so the caller asks again and the job is not given up on', async (_name, answer) => {
    await expect(poll(ENDPOINT, JOB, route(answer).fetchImpl)).rejects.toThrow(/answered \d{3} with (no JSON object|a JSON object that is no envelope of its own)/);
  });

  it('a status that is neither an answer to a poll nor an error (a 201, a 204) rejects as well', async () => {
    await expect(poll(ENDPOINT, JOB, route(json(201, { status: 'failed', reason: 'x' })).fetchImpl)).rejects.toThrow(/answered 201/);
    await expect(poll(ENDPOINT, JOB, route(new Response(null, { status: 204 })).fetchImpl)).rejects.toThrow(/answered 204/);
  });

  it('a network error rejects without the supplier URL in the message', async () => {
    const error = await poll(ENDPOINT, JOB, route(boom).fetchImpl).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Could not poll job/);
    expect((error as Error).message).not.toContain('203.0.113.10');
  });

  it('the poll has a budget of 20 s', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await poll(ENDPOINT, JOB, route(json(202, { status: 'running' })).fetchImpl);
    expect(spy).toHaveBeenLastCalledWith(20_000);
  });

  it('reads at most 1,000,000 bytes: a done body of that size is read, one byte more rejects', async () => {
    const body = (pad: string) => JSON.stringify({ ...done, note: pad });
    const atCap = exactly(1_000_000, body);
    const result = await poll(ENDPOINT, JOB, route(text(200, atCap, 'application/json')).fetchImpl);
    expect(result.kind).toBe('done');
    await expect(poll(ENDPOINT, JOB, route(text(200, exactly(1_000_001, body), 'application/json')).fetchImpl)).rejects.toThrow(/over the 1000000 byte limit/);
  });

  it.each(['', '../v1/admin', 'a/b', 'a b', 'x'.repeat(129), '%2e%2e'])('refuses the job id %j before anything is sent: it goes into a URL', async (jobId) => {
    const f = routedFetch({});
    await expect(poll(ENDPOINT, jobId, f.fetchImpl)).rejects.toThrow(/job id/);
    expect(f.calls).toHaveLength(0);
  });

  it('takes the letters, digits, hyphens and underscores of a job id', async () => {
    const f = routedFetch({ [`GET ${ENDPOINT}${path}/Job_1-a`]: json(202, { status: 'running' }) });
    expect(await poll(ENDPOINT, 'Job_1-a', f.fetchImpl)).toStrictEqual({ kind: 'running', status: 'running' });
  });

  it('never polls a private address: it rejects and nothing is sent', async () => {
    const f = routedFetch({});
    await expect(poll(PRIVATE, JOB, f.fetchImpl)).rejects.toThrow(/Could not poll job/);
    expect(f.calls).toHaveLength(0);
  });
});

describe('the body of a done job', () => {
  it('is what the commitments of the fleet take whole: the page text and its format hash as the supplier hashed them', async () => {
    const f = routedFetch({ [`GET ${ENDPOINT}/v1/ocr/extract/${JOB}`]: json(200, OCR_DONE) });
    const result = await pollOcrJob(ENDPOINT, JOB, f.fetchImpl, ESCROW);
    if (result.kind !== 'done') throw new Error('expected done');
    expect(ocrResponseHash(result.body as { content: string; output_format: string })).toBe(sha256Utf8Hex(canonicalize({ content: 'Page one of the test document.', output_format: 'markdown' })));
  });

  it('and so are the output, status and incomplete_details of the Responses object, with the text of the answer', async () => {
    const f = routedFetch({ [`GET ${ENDPOINT}/v1/responses/${JOB}`]: json(200, CHAT_DONE) });
    const result = await pollResponsesJob(ENDPOINT, JOB, f.fetchImpl, ESCROW);
    if (result.kind !== 'done') throw new Error('expected done');
    expect(responsesResponseHash(result.body)).toBe(sha256Utf8Hex(canonicalize({ output: CHAT_DONE.output, status: 'completed', incomplete_details: null })));
    expect(responsesOutputText(result.body)).toBe('A summary.');
  });
});

// --- /capability and /status ------------------------------------------------------------------------------------------------------
// The body the live ChandraOCR supplier serves (recorded 2026-10-13).
const CHANDRA_CAPABILITY = {
  capability_id: 'ocr.page.extract.chandra-ocr-2.v1', model: 'historical-records-ocr-v1', max_output_tokens: 8192, max_processing_ms: 300000, price_lovelace: '200000',
  advert_ref: '87c46c30026b438ef0aaedcf3c656743b32dd68ce69e36d11f1e2d2b91659e5d#0', supplier_pkh: '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9',
  pub_key_hex: '220dd63e34ffbd08b03795fbdaa949df0497e94f3aa2be18da8cd40e5a5ba651',
};

describe('readCapability', () => {
  const route = (answer: Answer) => routedFetch({ [`GET ${ENDPOINT}/capability`]: answer });

  it('reads the five fields of the live ChandraOCR supplier and the output limit, and nothing else the supplier says', async () => {
    const f = route(json(200, CHANDRA_CAPABILITY));
    expect(await readCapability(ENDPOINT, f.fetchImpl)).toStrictEqual({
      capability_id: 'ocr.page.extract.chandra-ocr-2.v1', model: 'historical-records-ocr-v1', advert_ref: CHANDRA_CAPABILITY.advert_ref,
      supplier_pkh: CHANDRA_CAPABILITY.supplier_pkh, pub_key_hex: CHANDRA_CAPABILITY.pub_key_hex, max_output_tokens: 8192,
    });
    expect([f.calls[0].method, f.calls[0].url, f.calls[0].headers.accept]).toStrictEqual(['GET', `${ENDPOINT}/capability`, 'application/json']);
  });

  it('carries inference_api when the supplier serves /v1/responses, and no key when it does not', async () => {
    const chat = { ...CHANDRA_CAPABILITY, capability_id: 'llm.text.generate.v1', model: 'deepseek/deepseek-v4-flash', inference_api: 'responses', upstream_api: 'responses', reasoning_disabled: false };
    expect((await readCapability(ENDPOINT, route(json(200, chat)).fetchImpl)).inference_api).toBe('responses');
    const ocr = await readCapability(ENDPOINT, route(json(200, CHANDRA_CAPABILITY)).fetchImpl);
    expect('inference_api' in ocr).toBe(false);
  });

  it('leaves out an optional field of the wrong type instead of passing it on', async () => {
    const odd = await readCapability(ENDPOINT, route(json(200, { ...CHANDRA_CAPABILITY, inference_api: 7, max_output_tokens: '8192' })).fetchImpl);
    expect('inference_api' in odd).toBe(false);
    expect('max_output_tokens' in odd).toBe(false);
  });

  it('reads from an endpoint with trailing slashes', async () => {
    const f = route(json(200, CHANDRA_CAPABILITY));
    await readCapability(`${ENDPOINT}//`, f.fetchImpl);
    expect(f.calls[0].url).toBe(`${ENDPOINT}/capability`);
  });

  it.each(['capability_id', 'model', 'advert_ref', 'supplier_pkh', 'pub_key_hex'])('rejects a capability whose %s is missing, empty or not a string, naming the field', async (field) => {
    const body: Record<string, unknown> = { ...CHANDRA_CAPABILITY };
    delete body[field];
    await expect(readCapability(ENDPOINT, route(json(200, body)).fetchImpl)).rejects.toThrow(new RegExp(field));
    await expect(readCapability(ENDPOINT, route(json(200, { ...body, [field]: 5 })).fetchImpl)).rejects.toThrow(new RegExp(field));
    await expect(readCapability(ENDPOINT, route(json(200, { ...body, [field]: '' })).fetchImpl)).rejects.toThrow(new RegExp(field));
  });

  it('rejects an answer that is not a 200 with a JSON object, saying what it was and not where it came from', async () => {
    await expect(readCapability(ENDPOINT, route(json(503, { reason: 'advert_not_active', message: 'advert is retired' })).fetchImpl)).rejects.toThrow(/answered 503/);
    await expect(readCapability(ENDPOINT, route(text(200, '<html>login</html>', 'text/html')).fetchImpl)).rejects.toThrow(/not a JSON object/);
    await expect(readCapability(ENDPOINT, route(json(200, [CHANDRA_CAPABILITY])).fetchImpl)).rejects.toThrow(/not a JSON object/);
    const error = await readCapability(ENDPOINT, route(boom).fetchImpl).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/Could not read the capability/);
    expect((error as Error).message).not.toContain('203.0.113.10');
  });

  it('has a budget of 20 s and reads at most 64 KiB: a body of 65,536 bytes is read, one byte more rejects', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const body = (pad: string) => JSON.stringify({ ...CHANDRA_CAPABILITY, note: pad });
    expect((await readCapability(ENDPOINT, route(text(200, exactly(65_536, body), 'application/json')).fetchImpl)).model).toBe('historical-records-ocr-v1');
    expect(spy).toHaveBeenLastCalledWith(20_000);
    await expect(readCapability(ENDPOINT, route(text(200, exactly(65_537, body), 'application/json')).fetchImpl)).rejects.toThrow(/over the 65536 byte limit/);
  });

  it('never reads a private address: it rejects and nothing is sent', async () => {
    const f = routedFetch({});
    await expect(readCapability(PRIVATE, f.fetchImpl)).rejects.toThrow(/Could not read the capability/);
    expect(f.calls).toHaveLength(0);
  });
});

describe('probeStatus', () => {
  const route = (answer: Answer) => routedFetch({ [`GET ${ENDPOINT}/status`]: answer });
  const status = (value: unknown) => json(200, { status: value, last_seen: '2026-10-15T09:00:00.000Z', active_sessions: 0, max_sessions: 1 });

  it.each(['free', 'working', 'offline'] as const)('reports %s as the supplier says it', async (value) => {
    const f = route(status(value));
    expect(await probeStatus(ENDPOINT, f.fetchImpl)).toBe(value);
    expect([f.calls[0].method, f.calls[0].url]).toStrictEqual(['GET', `${ENDPOINT}/status`]);
  });

  it.each([
    ['a status word of nobody', status('busy')],
    ['no status', json(200, { last_seen: '2026-10-15T09:00:00.000Z' })],
    ['a status that is not a string', status(1)],
    ['a 500', json(500, { reason: 'internal_error', message: 'x' })],
    ['a 503 with a free status in the body', json(503, { status: 'free' })],
    ['a page that is not JSON', text(200, '<html>ok</html>', 'text/html')],
    ['a JSON array', json(200, ['free'])],
    ['a network error', boom],
  ])('maps %s to unreachable', async (_name, answer) => {
    expect(await probeStatus(ENDPOINT, route(answer).fetchImpl)).toBe('unreachable');
  });

  it('has a budget of 2 s', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await probeStatus(ENDPOINT, route(status('free')).fetchImpl);
    expect(spy).toHaveBeenLastCalledWith(2_000);
  });

  it('never probes a private address: unreachable and nothing is sent', async () => {
    const f = routedFetch({});
    expect(await probeStatus(PRIVATE, f.fetchImpl)).toBe('unreachable');
    expect(f.calls).toHaveLength(0);
  });
});
