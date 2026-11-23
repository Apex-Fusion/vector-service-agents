// packages/hire-kit/test/template-client.test.ts
// The HTTP side of the hire of an agent of the template contract: the send of a job (POST /v1/job with the escrow and the wire payload), the poll (GET /v1/job/:id), and the
// job that the kit hires with (the prompt hash of the payload, the answer text and its hash). The supplier is the template supplier of testing/stub-suppliers.ts, behind the injected
// fetch, and a fetch that answers by hand where a test needs an answer that the stub does not give. Every answer that is not the supplier's own is no verdict: a page, a body
// without a code, an answer for another escrow.
import { describe, it, expect } from 'vitest';
import { promptHashForPayload, sha256Utf8Hex, wirePayloadFor } from '@vsa/vector-read';
import { bodyBytesOf, isRuntimeRefusal, pollTemplateJob, sendTemplateJob, serviceFailureOf, templateJob } from '../src/template-client.ts';
import { AGENT_ANSWER, AGENT_ENDPOINT, AGENT_KEY, escrowNo, marketplace, templateFinished } from '../testing/index.ts';
import type { Marketplace } from '../testing/index.ts';

const PAYLOAD = '{"purchase_order":"PO-7"}';
const OTHER = `${'e9'.repeat(32)}#0`;
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** A fetch that answers every call with `answer`, and records the calls. */
function answering(answer: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init }); return answer(); }) as typeof fetch;
  return { fetchImpl, calls };
}
/** A marketplace whose chain holds one Open escrow for the payload. */
async function posted(m: Marketplace = marketplace(), payload = PAYLOAD) {
  const post = await m.chain.postEscrow({ advertRef: m.agent.advertRef, promptHash: promptHashForPayload(payload) });
  return { m, post };
}

describe('sendTemplateJob', () => {
  it('posts the escrow and the wire payload to /v1/job of the endpoint, and the supplier claims the escrow and gives a job id', async () => {
    const { m, post } = await posted();
    const sent = await sendTemplateJob(AGENT_ENDPOINT, post.escrowRef, PAYLOAD, m.fetchImpl);
    expect(sent).toStrictEqual({ kind: 'accepted', jobId: '00000000-0000-4000-8000-000000000001' });
    expect(m.agent.sends).toStrictEqual([{ escrowRef: post.escrowRef, body: JSON.stringify({ escrow_ref: post.escrowRef, payload: wirePayloadFor(PAYLOAD) }), payload: wirePayloadFor(PAYLOAD) }]);
    expect(m.calls.at(-1)).toStrictEqual({ method: 'POST', url: `${AGENT_ENDPOINT}/v1/job` });
    expect(await m.chain.escrowState(post.escrowRef)).toBe('Claimed');
  });

  it('names the escrow in its canonical form and ignores the slash at the end of the endpoint', async () => {
    const { m, post } = await posted();
    const [tx, index] = post.escrowRef.split('#');
    await sendTemplateJob(`${AGENT_ENDPOINT}///`, ` ${tx.toUpperCase()}#${Number(index)} `, PAYLOAD, m.fetchImpl);
    expect(m.agent.sends[0].escrowRef).toBe(post.escrowRef);
    expect(m.calls.at(-1)?.url).toBe(`${AGENT_ENDPOINT}/v1/job`);
  });

  it('refuses a malformed escrow ref before anything is sent', async () => {
    const { m } = await posted();
    await expect(sendTemplateJob(AGENT_ENDPOINT, 'not-a-ref', PAYLOAD, m.fetchImpl)).rejects.toThrow(/Invalid out ref/);
    expect(m.agent.sends).toStrictEqual([]);
  });

  it('says busy for 409 supplier_busy, which the runtime answers when it or its service works another job; the escrow stays Open, and the same send is accepted once the supplier is free', async () => {
    const { m, post } = await posted();
    m.agent.busy = 2;
    expect(await sendTemplateJob(AGENT_ENDPOINT, post.escrowRef, PAYLOAD, m.fetchImpl)).toStrictEqual({ kind: 'busy' });
    expect(await sendTemplateJob(AGENT_ENDPOINT, post.escrowRef, PAYLOAD, m.fetchImpl)).toStrictEqual({ kind: 'busy' });
    expect(await m.chain.escrowState(post.escrowRef)).toBe('Open');
    expect((await sendTemplateJob(AGENT_ENDPOINT, post.escrowRef, PAYLOAD, m.fetchImpl)).kind).toBe('accepted');
  });

  it('says refused, not busy, for every other 409 and for the busy word of the service itself: only supplier_busy is retried', async () => {
    for (const code of ['busy', 'wrong_advert', 'underpaid', 'bond_mismatch', 'prompt_mismatch', 'escrow_not_claimable']) {
      const { m, post } = await posted();
      m.agent.refuse = { status: 409, code };
      expect(await sendTemplateJob(AGENT_ENDPOINT, post.escrowRef, PAYLOAD, m.fetchImpl)).toMatchObject({ kind: 'refused', status: 409, reason: code });
    }
  });

  it('is a refusal, with the status, the code and the words of the envelope, for the answer of the pre-check of the service; the escrow stays Open and nothing is claimed', async () => {
    const { m, post } = await posted();
    m.agent.refuse = { status: 403, code: 'approval_revoked', message: 'The approval was revoked on 2026-11-19.' };
    expect(await sendTemplateJob(AGENT_ENDPOINT, post.escrowRef, PAYLOAD, m.fetchImpl)).toStrictEqual({
      kind: 'refused', status: 403, reason: 'approval_revoked', message: 'The approval was revoked on 2026-11-19.',
    });
    expect(await m.chain.escrowState(post.escrowRef)).toBe('Open');
    // A busy 409 is not a refusal, and any other 409 is: the envelope of the runtime names its own code.
    m.agent.refuse = { status: 409, code: 'prompt_mismatch' };
    expect(await sendTemplateJob(AGENT_ENDPOINT, post.escrowRef, PAYLOAD, m.fetchImpl)).toMatchObject({ kind: 'refused', status: 409, reason: 'prompt_mismatch' });
  });

  it('says refused with the code and the status for the three 503 codes of a runtime that could not ask its service, and for the statuses that its service gives', async () => {
    for (const [status, code] of [[503, 'precheck_unreachable'], [503, 'precheck_timeout'], [503, 'precheck_failed'], [403, 'approval_revoked'], [422, 'order_rejected'], [429, 'rate_limited']] as const) {
      const { m, post } = await posted();
      m.agent.refuse = { status, code };
      expect(await sendTemplateJob(AGENT_ENDPOINT, post.escrowRef, PAYLOAD, m.fetchImpl)).toMatchObject({ kind: 'refused', status, reason: code });
      expect(await m.chain.escrowState(post.escrowRef)).toBe('Open');
    }
  });

  it('reads the code from `reason`, which both envelopes of the runtime carry; a body without it is no envelope of the runtime, whatever else it holds', async () => {
    const send = (body: unknown) => sendTemplateJob(AGENT_ENDPOINT, OTHER, PAYLOAD, answering(() => json(403, body)).fetchImpl);
    // The refusal of a check before the Claim: the code twice, and the words.
    expect(await send({ error: 'a_code', message: 'words', reason: 'a_code' })).toStrictEqual({ kind: 'refused', status: 403, reason: 'a_code', message: 'words' });
    // Every other error: reason and message, and error as an object that holds both.
    expect(await send({ reason: 'b_code', message: 'words', error: { reason: 'b_code', message: 'words' } })).toStrictEqual({ kind: 'refused', status: 403, reason: 'b_code', message: 'words' });
    expect(await send({ error: 'c_code', message: 'words' })).toMatchObject({ kind: 'refused', status: 403, reason: 'bad_response' });
    expect(await send({ error: { reason: 'd_code', message: 'words' } })).toMatchObject({ reason: 'bad_response' });
    expect(await send({ message: 'no code here' })).toMatchObject({ reason: 'bad_response' });
    expect(await send({ reason: '' })).toMatchObject({ reason: 'bad_response' });
  });

  it('keeps what the supplier wrote out of a log line: control characters become spaces and the text is cut', async () => {
    const answer = answering(() => json(403, { reason: `a\u001b[31m${'x'.repeat(300)}`, message: `line one\nline two ${'y'.repeat(900)}` }));
    const sent = await sendTemplateJob(AGENT_ENDPOINT, OTHER, PAYLOAD, answer.fetchImpl);
    expect(sent.kind).toBe('refused');
    if (sent.kind !== 'refused') return;
    expect(sent.reason).toHaveLength(100);
    expect(sent.reason).not.toMatch(/[\u0000-\u001f]/);
    expect(sent.message).toHaveLength(500);
    expect(sent.message).toMatch(/^line one line two /);
  });

  it('says a page, a body that is no JSON object and a 202 without the job id are not the supplier\'s word (bad_response), and a dropped connection is a timeout', async () => {
    const send = (answer: () => Response | Promise<Response>) => sendTemplateJob(AGENT_ENDPOINT, OTHER, PAYLOAD, answering(answer).fetchImpl);
    expect(await send(() => new Response('<html>502</html>', { status: 502 }))).toMatchObject({ kind: 'refused', status: 502, reason: 'bad_response' });
    expect(await send(() => new Response('[1,2]', { status: 400 }))).toMatchObject({ reason: 'bad_response' });
    expect(await send(() => json(202, { status: 'accepted' }))).toMatchObject({ kind: 'refused', status: 202, reason: 'bad_response' });
    expect(await send(() => json(202, { status: 'accepted', job_id: 'has space' }))).toMatchObject({ reason: 'bad_response' });
    expect(await send(() => json(202, { status: 'queued', job_id: 'ok-1' }))).toMatchObject({ reason: 'bad_response' });
    expect(await send(() => { throw new TypeError('fetch failed'); })).toStrictEqual({ kind: 'timeout' });
    // The twin of the 202 cases: a status accepted with a usable job id is accepted.
    expect(await send(() => json(202, { status: 'accepted', job_id: 'ok-1' }))).toStrictEqual({ kind: 'accepted', jobId: 'ok-1' });
  });

  it('goes through safeFetch: an endpoint that is not https, or is a private address, is no answer', async () => {
    const answer = answering(() => json(202, { status: 'accepted', job_id: 'ok-1' }));
    expect(await sendTemplateJob('http://203.0.113.41', OTHER, PAYLOAD, answer.fetchImpl)).toStrictEqual({ kind: 'timeout' });
    expect(await sendTemplateJob('https://10.0.0.1', OTHER, PAYLOAD, answer.fetchImpl)).toStrictEqual({ kind: 'timeout' });
    expect(answer.calls).toStrictEqual([]);
  });

  it('refuses a timeout that is not a number, before anything is sent', async () => {
    const answer = answering(() => json(202, { status: 'accepted', job_id: 'ok-1' }));
    await expect(sendTemplateJob(AGENT_ENDPOINT, OTHER, PAYLOAD, answer.fetchImpl, Number.NaN)).rejects.toThrow(TypeError);
    expect(answer.calls).toStrictEqual([]);
  });
});

describe('bodyBytesOf', () => {
  it('is the size of the body that sendTemplateJob sends for the escrow of a vault Pay, which is output 0: the size that is checked before the Pay is the size that is sent after it', async () => {
    for (const payload of [PAYLOAD, '€"\\\n\u0001'.repeat(50), '\u{1D15E}'.repeat(20)]) {
      const { m, post } = await posted(marketplace(), payload);
      await sendTemplateJob(AGENT_ENDPOINT, post.escrowRef, payload, m.fetchImpl);
      expect(post.escrowRef).toMatch(/^[0-9a-f]{64}#0$/);
      expect(bodyBytesOf(payload, true)).toBe(Buffer.byteLength(m.agent.sends[0]!.body, 'utf8'));
    }
  });

  it('is nine bytes longer for a Post of the wallet, whose escrow reference is sized as the longest: a hash sign and 10 digits, and not a hash sign and output 0', () => {
    expect(bodyBytesOf(PAYLOAD, false) - bodyBytesOf(PAYLOAD, true)).toBe(9);
  });

  it('counts bytes of UTF-8 and the escapes of the body: a quote mark is four bytes, a character of three bytes is three, and a line feed is three', () => {
    const base = bodyBytesOf('', true);
    expect(bodyBytesOf('a'.repeat(10), true)).toBe(base + 10);
    expect(bodyBytesOf('"'.repeat(10), true)).toBe(base + 40);
    expect(bodyBytesOf('\\'.repeat(10), true)).toBe(base + 40);
    expect(bodyBytesOf('€'.repeat(10), true)).toBe(base + 30);
    expect(bodyBytesOf('\n'.repeat(10), true)).toBe(base + 30);
    expect(bodyBytesOf('\u0001'.repeat(10), true)).toBe(base + 70);
  });
});

describe('pollTemplateJob', () => {
  it('says running for a job that is not finished, and done with the whole body, the receipt, its signature and the Submitted output when it is', async () => {
    const { m, post } = await posted();
    const sent = await sendTemplateJob(AGENT_ENDPOINT, post.escrowRef, PAYLOAD, m.fetchImpl);
    if (sent.kind !== 'accepted') throw new Error('the send was not accepted');
    expect(await pollTemplateJob(AGENT_ENDPOINT, sent.jobId, m.fetchImpl, post.escrowRef)).toStrictEqual({ kind: 'running', status: 'running' });
    const done = await pollTemplateJob(AGENT_ENDPOINT, sent.jobId, m.fetchImpl, post.escrowRef);
    expect(done.kind).toBe('done');
    if (done.kind !== 'done') return;
    const expected = templateFinished(AGENT_KEY, post.escrowRef, sent.jobId, wirePayloadFor(PAYLOAD), AGENT_ANSWER);
    expect(done.body).toStrictEqual(expected);
    expect([done.receipt, done.receiptSignature, done.submittedRef]).toStrictEqual([expected.receipt, expected.receipt_signature, expected.submitted_ref]);
    expect(m.calls.at(-1)?.url).toBe(`${AGENT_ENDPOINT}/v1/job/${sent.jobId}`);
  });

  it('says failed for the failed envelope of the supplier, with its reason and its words, and gone for its own 404 job_not_found', async () => {
    const poll = (answer: () => Response) => pollTemplateJob(AGENT_ENDPOINT, 'job-1', answering(answer).fetchImpl, OTHER);
    expect(await poll(() => json(502, { status: 'failed', reason: 'service_failure', message: 'the service did not answer', escrow_ref: OTHER }))).toStrictEqual({
      kind: 'failed', reason: 'service_failure', message: 'the service did not answer',
    });
    expect(await poll(() => json(404, { reason: 'job_not_found', message: 'no job' }))).toStrictEqual({ kind: 'gone' });
    expect(await poll(() => json(404, { reason: 'job_not_found', message: 'no job', error: { reason: 'job_not_found', message: 'no job' } }))).toStrictEqual({ kind: 'gone' });
    expect(await poll(() => json(500, { reason: 'internal_error', message: 'it broke' }))).toMatchObject({ kind: 'failed', reason: 'internal_error' });
  });

  it('rejects, so that the poll is made again, for an answer that is not the supplier\'s own: a page, another 404, a JSON object without an envelope, a finished job of another escrow', async () => {
    const poll = (answer: () => Response) => pollTemplateJob(AGENT_ENDPOINT, 'job-1', answering(answer).fetchImpl, OTHER);
    await expect(poll(() => new Response('<html>502</html>', { status: 502 }))).rejects.toThrow(/Could not poll job job-1/);
    await expect(poll(() => new Response('not found', { status: 404 }))).rejects.toThrow(/no JSON object/);
    await expect(poll(() => json(404, { reason: 'something_else' }))).rejects.toThrow(/no envelope of its own/);
    await expect(poll(() => json(502, { hello: 'world' }))).rejects.toThrow(/no envelope of its own/);
    await expect(poll(() => json(200, { receipt: { a: 1 } }))).rejects.toThrow(/no finished job/);
    await expect(poll(() => json(200, { receipt: { a: 1 }, receipt_signature: 'ab' }))).rejects.toThrow(/names no escrow/);
    await expect(poll(() => json(200, { receipt: { a: 1 }, receipt_signature: 'ab', escrow_ref: `${'e8'.repeat(32)}#0` }))).rejects.toThrow(/another escrow than/);
    // The twin: a finished job that names the escrow of the poll is done.
    expect((await poll(() => json(200, { receipt: { a: 1 }, receipt_signature: 'ab', escrow_ref: OTHER.toUpperCase() }))).kind).toBe('done');
  });

  it('refuses a job id that cannot be a path segment, and a malformed escrow ref, before anything is sent', async () => {
    const answer = answering(() => json(202, { status: 'running' }));
    await expect(pollTemplateJob(AGENT_ENDPOINT, '../secret', answer.fetchImpl, OTHER)).rejects.toThrow(/job id must be/);
    await expect(pollTemplateJob(AGENT_ENDPOINT, 'job-1', answer.fetchImpl, 'nope')).rejects.toThrow(/Invalid out ref/);
    expect(answer.calls).toStrictEqual([]);
  });

  it('a call that gets no answer rejects, and says neither the endpoint nor what the network said', async () => {
    const error = await pollTemplateJob(AGENT_ENDPOINT, 'job-1', answering(() => { throw new TypeError('connect ECONNREFUSED 203.0.113.41:443'); }).fetchImpl, OTHER).catch((err: unknown) => err);
    expect(String(error)).toMatch(/Could not poll job job-1/);
    expect(String(error)).not.toMatch(/203\.0\.113|ECONNREFUSED/);
  });
});

describe('templateJob', () => {
  it('commits to the hash of the wire payload, and sends and polls through the template route', async () => {
    const { m, post } = await posted();
    const job = templateJob(AGENT_ENDPOINT, PAYLOAD, 'the handoff', m.fetchImpl);
    expect([job.label, job.promptHash]).toStrictEqual(['the handoff', promptHashForPayload(PAYLOAD)]);
    expect(job.promptHash).toBe(sha256Utf8Hex(wirePayloadFor(PAYLOAD)));
    const sent = await job.send(post.escrowRef);
    expect(sent.kind).toBe('accepted');
    if (sent.kind !== 'accepted') return;
    expect((await job.poll(sent.jobId, post.escrowRef)).kind).toBe('running');
  });

  it('reads the answer text from the first choice and hashes it as the template does: sha256 of the text', () => {
    const job = templateJob(AGENT_ENDPOINT, PAYLOAD, 'the handoff', answering(() => json(200, {})).fetchImpl);
    const read = job.read({ choices: [{ message: { content: AGENT_ANSWER } }] });
    expect(read).toStrictEqual({ responseHash: sha256Utf8Hex(AGENT_ANSWER), value: { text: AGENT_ANSWER } });
  });

  it('refuses a body that has no text to accept: the escrow of such an answer is never accepted', () => {
    const job = templateJob(AGENT_ENDPOINT, PAYLOAD, 'the handoff', answering(() => json(200, {})).fetchImpl);
    expect(() => job.read({})).toThrow(/not a list/);
    expect(() => job.read({ choices: [] })).toThrow(/no first choice/);
    expect(() => job.read({ choices: [{ message: {} }] })).toThrow(/no text/);
    expect(() => job.read({ choices: [{ message: { content: 7 } }] })).toThrow(/no text/);
    expect(() => job.read({ choices: [null] })).toThrow(/no first choice|no text/);
    expect(job.read({ choices: [{ message: { content: '' } }] }).value.text).toBe('');
  });

  it('refuses an empty payload: the template refuses it too, and its prompt hash would commit to nothing', () => {
    expect(() => templateJob(AGENT_ENDPOINT, '', 'the handoff', answering(() => json(200, {})).fetchImpl)).toThrow(/non-empty/);
  });

  it('the supplier of the stub signs the hash that the job recomputes, so that the eight checks can pass', async () => {
    const { m, post } = await posted();
    const job = templateJob(AGENT_ENDPOINT, PAYLOAD, 'the handoff', m.fetchImpl);
    const sent = await job.send(post.escrowRef);
    if (sent.kind !== 'accepted') throw new Error('the send was not accepted');
    await job.poll(sent.jobId, post.escrowRef);
    const done = await job.poll(sent.jobId, post.escrowRef);
    if (done.kind !== 'done') throw new Error('the job is not done');
    expect(done.receipt.response_hash).toBe(job.read(done.body).responseHash);
    expect(done.receipt.prompt_hash).toBe(job.promptHash);
    expect(escrowNo(1)).toBe(post.escrowRef);
  });
});

describe('the template supplier of the stub', () => {
  it('writes the two envelopes of the runtime: the refusal of a check before the Claim, and every other error', async () => {
    const { m, post } = await posted();
    const body = JSON.stringify({ escrow_ref: post.escrowRef, payload: wirePayloadFor(PAYLOAD) });
    m.agent.refuse = { status: 409, code: 'underpaid', message: 'The escrow holds less than the price.' };
    const refusal = await m.agent.handle('POST', '/v1/job', body);
    expect([refusal.status, await refusal.json()]).toStrictEqual([409, { error: 'underpaid', message: 'The escrow holds less than the price.', reason: 'underpaid' }]);
    m.agent.refuse = null;
    m.agent.busy = 1;
    const busy = await m.agent.handle('POST', '/v1/job', body);
    const words = 'supplier is already working another job';
    expect([busy.status, await busy.json()]).toStrictEqual([409, { reason: 'supplier_busy', message: words, error: { reason: 'supplier_busy', message: words } }]);
    // The twin: with nothing to refuse, the supplier claims the escrow and answers 202.
    const accepted = await m.agent.handle('POST', '/v1/job', body);
    expect(accepted.status).toBe(202);
  });

  it('answers an escrow that is not Open with a fixed text and never with the error of the chain: nothing of the stub reaches the client', async () => {
    const { m, post } = await posted();
    const body = JSON.stringify({ escrow_ref: post.escrowRef, payload: wirePayloadFor(PAYLOAD) });
    expect((await m.agent.handle('POST', '/v1/job', body)).status).toBe(202);
    // The escrow is Claimed now: a second send is turned down, in the words that the stub always uses for it.
    const again = await m.agent.handle('POST', '/v1/job', body);
    const words = 'the escrow is not in a state that can be claimed';
    expect([again.status, await again.json()]).toStrictEqual([409, { reason: 'escrow_not_claimable', message: words, error: { reason: 'escrow_not_claimable', message: words } }]);
  });
});

describe('isRuntimeRefusal', () => {
  it('is true for what the runtime refuses before its Claim: a status below 500 with a code of its envelope, and the three 503 codes of a service that it could not ask', () => {
    const refusals: Array<[number, string]> = [
      [400, 'payload_required'], [403, 'wrong_supplier'], [403, 'approval_revoked'], [408, 'past_deliver_by'], [409, 'underpaid'], [409, 'wrong_advert'], [409, 'busy'], [422, 'service_refused'],
      [503, 'precheck_unreachable'], [503, 'precheck_timeout'], [503, 'precheck_failed'],
    ];
    for (const [status, code] of refusals) expect(isRuntimeRefusal({ status, code }), `${status} ${code}`).toBe(true);
  });

  it('is false for what may come after a Claim, or is no word of the runtime: a page, a lagging view of the chain, a 5xx with another code, and a precheck code with another status', () => {
    const others: Array<[number, string]> = [
      [502, 'bad_response'], [404, 'bad_response'], [403, 'bad_response'], [404, 'escrow_not_found'], [500, 'internal_error'], [502, 'chain_submit_failed'], [503, 'chain_submit_failed'],
      [503, 'supplier_unavailable'], [504, 'claim_timeout'], [500, 'precheck_failed'], [504, 'precheck_timeout'], [502, 'precheck_unreachable'],
    ];
    for (const [status, code] of others) expect(isRuntimeRefusal({ status, code }), `${status} ${code}`).toBe(false);
  });
});

describe('serviceFailureOf', () => {
  const FORM = '{"error":"cannot_supply","message":"the lot is gone"}';
  /** The words of the runtime when its service answered with an HTTP error: the reason `service_http_<status>`, and the message with the start of the answer. */
  const answer = (status: number, body: string): { reason: string; message: string } => ({ reason: `service_http_${status}`, message: `service returned HTTP ${status}: ${body}` });
  const NONE = { service_status: null, service_code: null };

  it('reads the status and the code of the answer of the service, in the frame that the runtime writes', () => {
    expect(serviceFailureOf(answer(403, FORM))).toStrictEqual({ service_status: 403, service_code: 'cannot_supply' });
    expect(serviceFailureOf(answer(409, '{"error":"duplicate_po"}'))).toStrictEqual({ service_status: 409, service_code: 'duplicate_po' });
  });

  it('reads the failed job as the poll gives it: the words are flat and cut, and the runtime has cut the answer at 200 characters', async () => {
    const body = `{"error":"cannot_supply","message":"${'line one\nline two '.repeat(12)}`.slice(0, 200);
    const poll = await pollTemplateJob(AGENT_ENDPOINT, 'job-1', answering(() => json(502, { status: 'failed', ...answer(403, body), escrow_ref: OTHER })).fetchImpl, OTHER);
    if (poll.kind !== 'failed') throw new Error(`the poll said ${poll.kind}`);
    expect(poll.message).not.toContain('\n');
    expect(serviceFailureOf(poll)).toStrictEqual({ service_status: 403, service_code: 'cannot_supply' });
  });

  it('gives the status and the code as they came, for every status of an HTTP answer and every code of the right form: what they mean is for the caller to decide', () => {
    for (const [status, code] of [[500, 'cannot_supply'], [403, 'duplicate_po'], [429, 'rate_limited'], [404, 'not_for_this_supplier'], [503, 'check_unavailable'], [100, 'a'], [599, 'a_b_c']] as const) {
      expect(serviceFailureOf(answer(status, `{"error":"${code}"}`)), `${status} ${code}`).toStrictEqual({ service_status: status, service_code: code });
    }
  });

  it('says null and null for the words that are not the frame of the runtime: a code is never read from free text, and a status is never read alone', () => {
    const cases: Array<[string, { reason: string; message: string } | undefined]> = [
      ['no words at all, as for a supplier that no longer knows the job', undefined],
      ['a failure of the service that is no HTTP answer', { reason: 'service_timeout', message: 'service call failed after 30000ms: the operation timed out' }],
      ['a reason of the failure that holds the form', { reason: `x ${FORM} y`, message: `the job failed (x ${FORM} y)` }],
      ['a reason of the failure that is the form', { reason: FORM, message: 'the job failed' }],
      ['a form later in the answer of the service', answer(403, `it said ${FORM}`)],
      ['a form in a second answer', { reason: 'service_http_500', message: `service returned HTTP 500: the service fell over service returned HTTP 403: ${FORM}` }],
      ['a form in a second answer of the same status', { reason: 'service_http_403', message: `service returned HTTP 403: the service fell over service returned HTTP 403: ${FORM}` }],
      ['the frame of the message after other words', { reason: 'service_http_403', message: `a note first: service returned HTTP 403: ${FORM}` }],
      ['the reason after other words', { reason: 'a note first: service_http_403', message: `service returned HTTP 403: ${FORM}` }],
      ['the form with no frame of the message', { reason: 'service_http_403', message: FORM }],
      ['the frame in the reason and not in the message', { reason: `service_http_403: service returned HTTP 403: ${FORM}`, message: 'the job failed' }],
      ['two statuses', { reason: 'service_http_403', message: `service returned HTTP 500: ${FORM}` }],
      ['a reason with more than the status', { reason: 'service_http_403x', message: `service returned HTTP 403: ${FORM}` }],
      ['a status of four digits', answer(4030, FORM)],
      ['a status of two digits', answer(40, FORM)],
      ['a status that is no HTTP status', answer(999, FORM)],
      ['a status with a leading zero', { reason: 'service_http_040', message: `service returned HTTP 040: ${FORM}` }],
      ['a status that is a word', { reason: 'service_http_abc', message: `service returned HTTP abc: ${FORM}` }],
      ['a code that is not closed', answer(403, '{"error":"cannot_supply')],
      ['a code of capital letters', answer(403, '{"error":"CANNOT_SUPPLY"}')],
      ['a code with a space', answer(403, '{"error":"cannot supply"}')],
      ['a code that is too long', answer(403, `{"error":"${'a'.repeat(65)}"}`)],
      ['an empty code', answer(403, '{"error":""}')],
      ['an error that is an object', answer(403, '{"error": {"reason":"cannot_supply"}}')],
      ['a space in the form', answer(403, '{ "error":"cannot_supply"}')],
      ['an answer that is a page, which has a status and no code', answer(503, '<html><body>503</body></html>')],
      ['text that only names the code', { reason: 'service_failure', message: 'the supplier says cannot_supply and nothing else' }],
      ['empty words', { reason: '', message: '' }],
    ];
    for (const [name, words] of cases) expect(serviceFailureOf(words), name).toStrictEqual(NONE);
    // The twin: the longest code that the form allows is read.
    expect(serviceFailureOf(answer(403, `{"error":"${'a'.repeat(64)}"}`))).toStrictEqual({ service_status: 403, service_code: 'a'.repeat(64) });
  });
});
