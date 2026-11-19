// packages/hire-kit/test/testing.test.ts
// The shared stubs of @vsa/hire-kit/testing, which the kit and the services use for their tests: a world makes the keys, the refs and the numbers of one set of tests, the
// marketplace lists the suppliers a test asks for, and each supplier does what a test tells it. The services pin goldens byte for byte on these suppliers (the Document Pipeline
// and the Advocate each hold a world), so what a world sets must show in every body a supplier serves, and the same world must give the same bytes every time.
import { describe, it, expect } from 'vitest';
import { ocrPromptHash, responsesPromptHash } from '@vsa/buyer-core';
import {
  AGENT_ADVERT_REF, HIRE_KIT_WORLD, LLM_ADVERT_REF, LLM_CAPABILITY, LLM_ENDPOINT, LLM_KEY, OCR_ADVERT_REF, OCR_CAPABILITY, OCR_ENDPOINT, OCR_KEY, T0, chatFinished,
  escrowNo, marketplace, stubKey, stubWorld,
} from '../testing/index.ts';
import type { OcrRequest } from '../testing/index.ts';

const INPUT = 'Answer in one sentence: what does a bonded escrow hold?';
const PAGE = 'cGFnZSBvbmU=';
const OCR_REQUEST: OcrRequest = { image_b64: PAGE, mime: 'image/png', output_format: 'markdown' };
const A = stubWorld({ prefix: 'a-test/', label: 'a test' });
const B = stubWorld({ prefix: 'b-test/', label: 'b test', windowMs: 3_600_000, answer: 'the answer of b', lastSeen: '2026-10-19T08:00:00.000Z', chatReceipt: { promptTokens: 4321, completionTokens: 512, wallclockMs: 99 }, pageTexts: { [PAGE]: 'Page one of b.' } });

/** The supplier's answer to a send, as the body of the Response. */
const bodyOf = async (response: Response): Promise<Record<string, unknown>> => (await response.json()) as Record<string, unknown>;

describe('stubWorld', () => {
  it('makes the keys, the adverts and the refs of a set of tests from its label and its prefix; two worlds share none of them, and the default world is the one of the kit', () => {
    expect(A.llmKey.pkh).toBe(stubKey('a test: the chat supplier').pkh);
    expect(A.forgerKey.pkh).toBe(stubKey('a test: somebody else').pkh);
    expect([A.ocrAdvert.supplier_pkh, A.llmAdvert.supplier_pkh, A.agentAdvert.supplier_pkh]).toStrictEqual([A.ocrKey.pkh, A.llmKey.pkh, A.agentKey.pkh]);
    for (const key of ['ocrKey', 'llmKey', 'agentKey', 'forgerKey'] as const) expect(A[key].pkh).not.toBe(B[key].pkh);
    expect(A.escrowNo(1)).not.toBe(B.escrowNo(1));
    expect(A.escrowNo(2)).not.toBe(A.escrowNo(1));
    expect([LLM_KEY, OCR_KEY, escrowNo(3)]).toStrictEqual([HIRE_KIT_WORLD.llmKey, HIRE_KIT_WORLD.ocrKey, HIRE_KIT_WORLD.escrowNo(3)]);
    expect(HIRE_KIT_WORLD.llmKey.pkh).toBe(stubKey('hire-kit test: the chat supplier').pkh);
  });

  it('puts the window, the last-seen time and the receipt counts of the world into the adverts, the indexer, /capability, /status and the finished bodies of its suppliers', async () => {
    const m = marketplace({ world: B, listed: ['llm'] });
    expect(B.llmAdvert.max_processing_ms).toBe(3_600_000);
    expect(m.rows).toMatchObject([{ max_processing_ms: 3_600_000, last_seen_iso: '2026-10-19T08:00:00.000Z', utxo_ref: LLM_ADVERT_REF }]);
    expect(await bodyOf(m.llm.handle('GET', '/capability', null, ''))).toMatchObject({ max_processing_ms: 3_600_000, advert_ref: LLM_ADVERT_REF, pub_key_hex: B.llmKey.pubKeyHex });
    expect(await bodyOf(m.llm.handle('GET', '/status', null, ''))).toMatchObject({ status: 'free', last_seen: '2026-10-19T08:00:00.000Z' });
    expect(m.llm.answer).toBe('the answer of b');
    const finished = B.chatFinished(B.llmKey, B.escrowNo(1), 'responses-job-1', INPUT, 'text', 'completed');
    expect(finished).toMatchObject({ usage: { input_tokens: 4321, output_tokens: 512, total_tokens: 4833 }, receipt: { prompt_tokens: 4321, completion_tokens: 512, wallclock_ms: 99 } });
    // The same world gives the same bytes every time: Ed25519 signs deterministically.
    expect(B.chatFinished(B.llmKey, B.escrowNo(1), 'responses-job-1', INPUT, 'text', 'completed')).toStrictEqual(finished);
    // Another world signs the same job with another key, so its bytes differ.
    expect(A.chatFinished(A.llmKey, B.escrowNo(1), 'responses-job-1', INPUT, 'text', 'completed').receipt_signature).not.toBe(finished.receipt_signature);
    // The module-level names are those of the default world.
    expect(chatFinished(LLM_KEY, escrowNo(1), 'responses-job-1', INPUT, 'text', 'completed')).toMatchObject({ usage: { input_tokens: 96, output_tokens: 24, total_tokens: 120 } });
  });

  it('opens the n-th escrow of a marketplace at the ref that its world names, and starts the clock of the chain at t0', async () => {
    const m = marketplace({ world: A, t0: 5_000 });
    expect(m.clock.now).toBe(5_000);
    const first = await m.chain.postEscrow({ advertRef: LLM_ADVERT_REF, promptHash: responsesPromptHash({ input: INPUT }) });
    const second = await m.chain.postEscrow({ advertRef: LLM_ADVERT_REF, promptHash: responsesPromptHash({ input: 'again' }) });
    expect([first.escrowRef, second.escrowRef, first.postedAt]).toStrictEqual([A.escrowNo(1), A.escrowNo(2), 5_000]);
    expect(marketplace().clock.now).toBe(T0);
  });
});

describe('marketplace', () => {
  it('lists the suppliers that a test asks for, in the order given, and the model supplier and the template supplier by default', async () => {
    expect(marketplace().rows.map((row) => row.utxo_ref)).toStrictEqual([LLM_ADVERT_REF, AGENT_ADVERT_REF]);
    expect(marketplace({ listed: ['ocr', 'llm'] }).rows.map((row) => row.capability_id)).toStrictEqual([OCR_CAPABILITY, LLM_CAPABILITY]);
    expect(marketplace({ listed: ['llm'] }).rows).toHaveLength(1);
    expect(marketplace({ listed: [] }).rows).toStrictEqual([]);
    // The chain holds an advert for each supplier whether it is listed or not.
    expect((await marketplace({ listed: ['llm'] }).chain.readAdvert(OCR_ADVERT_REF)).capability_id).toBe(OCR_CAPABILITY);
  });

  it('serves the indexer, the supplier endpoints and the Koios asset_utxos that a test sets, through one fetch, and says no_route for any other address', async () => {
    const m = marketplace({ listed: ['ocr', 'llm'] });
    m.records.push({ asset_name: 'a record' });
    const indexer = await m.fetchImpl('https://indexer.test/suppliers');
    expect(((await indexer.json()) as unknown[]).length).toBe(2);
    expect((await m.fetchImpl(`${OCR_ENDPOINT}/capability`)).status).toBe(200);
    expect((await m.fetchImpl(`${LLM_ENDPOINT}/capability`)).status).toBe(200);
    const other = await m.fetchImpl('https://203.0.113.99/capability');
    expect([other.status, (await bodyOf(other)).reason]).toStrictEqual([404, 'no_route']);
    expect(m.calls.map((call) => call.url)).toStrictEqual(['https://indexer.test/suppliers', `${OCR_ENDPOINT}/capability`, `${LLM_ENDPOINT}/capability`, 'https://203.0.113.99/capability']);
  });

  it('takes a page job from the OCR supplier from the Post to the finished body, in the world that the marketplace has', async () => {
    const m = marketplace({ world: B, listed: ['ocr'] });
    const post = await m.chain.postEscrow({ advertRef: OCR_ADVERT_REF, promptHash: ocrPromptHash(OCR_REQUEST) });
    const send = await m.ocr.handle('POST', '/v1/ocr/extract', post.escrowRef, JSON.stringify(OCR_REQUEST));
    expect([send.status, (await bodyOf(send)).job_id]).toStrictEqual([202, 'extract-job-1']);
    expect((await m.ocr.handle('GET', '/v1/ocr/extract/extract-job-1', null, '')).status).toBe(202);
    const done = await m.ocr.handle('GET', '/v1/ocr/extract/extract-job-1', null, '');
    expect(await bodyOf(done)).toStrictEqual(B.ocrFinished(B.ocrKey, post.escrowRef, OCR_REQUEST));
    expect(await m.chain.escrowState(post.escrowRef)).toBe('Submitted');
    // A body of another shape is refused, and the escrow stays Open.
    const second = await m.chain.postEscrow({ advertRef: OCR_ADVERT_REF, promptHash: ocrPromptHash(OCR_REQUEST) });
    const refused = await m.ocr.handle('POST', '/v1/ocr/extract', second.escrowRef, JSON.stringify({ image_b64: PAGE }));
    expect([refused.status, await m.chain.escrowState(second.escrowRef)]).toStrictEqual([400, 'Open']);
  });
});

describe('the misbehaviour that a supplier can be told', () => {
  async function posted() {
    const m = marketplace();
    const post = await m.chain.postEscrow({ advertRef: LLM_ADVERT_REF, promptHash: responsesPromptHash({ input: INPUT }) });
    const send = () => m.llm.handle('POST', '/v1/responses', post.escrowRef, JSON.stringify({ input: INPUT }));
    return { m, post, send };
  }

  it('answers the next sends with a page of a proxy, then with a gateway body, and then the supplier itself answers; the escrow stays Open until it does', async () => {
    const { m, post, send } = await posted();
    m.llm.pages = [502];
    m.llm.oddAnswers = [{ status: 400, body: { hello: 'world' } }];
    const page = send();
    expect([page.status, page.headers.get('content-type'), await page.text()]).toStrictEqual([502, 'text/html', '<html><body><h1>502</h1></body></html>']);
    const odd = send();
    expect([odd.status, await bodyOf(odd)]).toStrictEqual([400, { hello: 'world' }]);
    expect(await m.chain.escrowState(post.escrowRef)).toBe('Open');
    expect(send().status).toBe(202);
    expect(m.llm.sends).toHaveLength(3);
  });

  it('calls onSend with each send before it answers it, and signs the counts it is given in the receipt and no other count', async () => {
    const { m, post, send } = await posted();
    let seen = 0;
    m.llm.onSend = () => { seen += 1; };
    m.llm.tokens = { prompt_tokens: 'not a count', completion_tokens: 7 };
    expect(send().status).toBe(202);
    expect(seen).toBe(1);
    m.llm.handle('GET', '/v1/responses/responses-job-1', null, '');
    const done = await bodyOf(m.llm.handle('GET', '/v1/responses/responses-job-1', null, ''));
    expect(done).toMatchObject({ receipt: { prompt_tokens: 'not a count', completion_tokens: 7 }, usage: { input_tokens: 96, output_tokens: 24 }, escrow_ref: post.escrowRef });
  });

  it('gives each job the poll steps of its own plan, then the steps of the supplier', async () => {
    const { m, post, send } = await posted();
    m.llm.plans = [['failed']];
    expect(send().status).toBe(202);
    const failed = m.llm.handle('GET', '/v1/responses/responses-job-1', null, '');
    expect([failed.status, (await bodyOf(failed)).reason]).toStrictEqual([502, 'upstream_failure']);
    // The escrow is Claimed and the job is gone, so a second send is of a second escrow; its job takes the default steps.
    const second = await m.chain.postEscrow({ advertRef: LLM_ADVERT_REF, promptHash: responsesPromptHash({ input: INPUT }) });
    expect(m.llm.handle('POST', '/v1/responses', second.escrowRef, JSON.stringify({ input: INPUT })).status).toBe(202);
    expect(m.llm.handle('GET', '/v1/responses/responses-job-2', null, '').status).toBe(202);
    expect(m.llm.handle('GET', '/v1/responses/responses-job-2', null, '').status).toBe(200);
    expect(await m.chain.escrowState(post.escrowRef)).toBe('Claimed');
  });

  it('answers the next /status calls with a 503 page and then with its word, and refuses after it claimed the escrow when it is told to', async () => {
    const { m, post, send } = await posted();
    m.llm.statusFailures = 1;
    expect(m.llm.handle('GET', '/status', null, '').status).toBe(503);
    expect(await bodyOf(m.llm.handle('GET', '/status', null, ''))).toMatchObject({ status: 'free' });
    m.llm.refuse = { status: 409, reason: 'already_taken', claim: true, message: 'the job was taken from an earlier send' };
    const refused = send();
    expect([refused.status, await bodyOf(refused)]).toStrictEqual([409, { reason: 'already_taken', message: 'the job was taken from an earlier send' }]);
    expect(await m.chain.escrowState(post.escrowRef)).toBe('Claimed');
  });
});
