// packages/hire-kit/test/template-client.test.ts
// The HTTP side of the hire of an agent of the template contract: the send of a job (POST /v1/job with the escrow and the wire payload), the poll (GET /v1/job/:id), and the
// job that the kit hires with (the prompt hash of the payload, the answer text and its hash). The supplier is the template supplier of testing/stub-suppliers.ts, behind the injected
// fetch, and a fetch that answers by hand where a test needs an answer that the stub does not give. Every answer that is not the supplier's own is no verdict: a page, a body
// without a code, an answer for another escrow.
import { describe, it, expect } from 'vitest';
import { promptHashForPayload, sha256Utf8Hex, wirePayloadFor } from '@vsa/vector-read';
import { pollTemplateJob, sendTemplateJob, templateJob } from '../src/template-client.ts';
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

  it('says busy for 409 supplier_busy and for 409 busy, which the pre-check of the service answers, and the escrow stays Open', async () => {
    const { m, post } = await posted();
    m.agent.busy = 1;
    m.agent.serviceBusy = 1;
    expect(await sendTemplateJob(AGENT_ENDPOINT, post.escrowRef, PAYLOAD, m.fetchImpl)).toStrictEqual({ kind: 'busy' });
    expect(await sendTemplateJob(AGENT_ENDPOINT, post.escrowRef, PAYLOAD, m.fetchImpl)).toStrictEqual({ kind: 'busy' });
    expect(await m.chain.escrowState(post.escrowRef)).toBe('Open');
    // The twin: the same send, once the supplier is free, is accepted.
    expect((await sendTemplateJob(AGENT_ENDPOINT, post.escrowRef, PAYLOAD, m.fetchImpl)).kind).toBe('accepted');
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

  it('reads the code from `reason`, from `error` as a text, and from `error` as an object with a reason; a body with none is no envelope of the supplier', async () => {
    const send = (body: unknown) => sendTemplateJob(AGENT_ENDPOINT, OTHER, PAYLOAD, answering(() => json(403, body)).fetchImpl);
    expect(await send({ reason: 'a_code', message: 'words' })).toStrictEqual({ kind: 'refused', status: 403, reason: 'a_code', message: 'words' });
    expect(await send({ error: 'b_code', message: 'words' })).toStrictEqual({ kind: 'refused', status: 403, reason: 'b_code', message: 'words' });
    expect(await send({ error: { reason: 'c_code', message: 'inner words' } })).toStrictEqual({ kind: 'refused', status: 403, reason: 'c_code', message: 'inner words' });
    expect(await send({ message: 'no code here' })).toMatchObject({ kind: 'refused', status: 403, reason: 'bad_response' });
    expect(await send({ error: '' })).toMatchObject({ reason: 'bad_response' });
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
    expect(await poll(() => json(404, { error: 'job_not_found', message: 'no job' }))).toStrictEqual({ kind: 'gone' });
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
