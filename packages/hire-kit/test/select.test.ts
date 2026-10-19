// packages/hire-kit/test/select.test.ts
// The chat job and the choice of the chat supplier, as agents/document-pipeline/src/orchestrate.ts had them (rulings R10, R12, R22, R25, R31, R56, R60,
// R65): the body {input} and nothing else, the answer hashed as received and its text read before the Accept; the selection with the probe, the advert read
// on chain and held to the allowlist, the ceiling, the endpoint and the key, the words of each refusal with the caller's code around them, and the line of
// the choice. And what an advert locks and a sub-job needs. Against the in-memory marketplace of test/stub-suppliers.ts.
import { describe, it, expect } from 'vitest';
import { LLM_SELECTION_BUDGET_MS, LLM_SELECTION_MAX_CANDIDATES, TX_FEE_BUDGET_LOVELACE, planFleetPostEscrow, responsesPromptHash, responsesResponseHash } from '@vsa/buyer-core';
import type { AdvertDatum } from '@vsa/vector-read';
import { chatJob } from '../src/hire.ts';
import type { HireSupplier } from '../src/hire.ts';
import { aboveCeiling, advertOnChain, chooseChatSupplier, choiceLine, keyOfAdvert, plannedLockOf, subJobFloat } from '../src/select.ts';
import type { ChatQuery } from '../src/select.ts';
import {
  ALLOWLIST, ANSWER, FORGER_KEY, INDEXER, LLM_ADVERT, LLM_ADVERT_REF, LLM_ENDPOINT, LLM_KEY, OCR_ADVERT, OCR_ADVERT_REF, T0, chainWith, marketplace,
} from './stub-suppliers.ts';
import type { Marketplace } from './stub-suppliers.ts';

const INPUT = 'Answer in one sentence: what does a bonded escrow hold?';
const CEILING = 1_000_000n;
/** The caller's refusal, as the Document Pipeline makes it: its code and its words around the reason. */
class Unavailable extends Error {
  readonly code = 'llm_supplier_unavailable';
}
const unavailable = (why: string): Unavailable => new Unavailable(`No chat supplier can be hired for the brief: ${why}.`);
const query = (m: Marketplace, over: Partial<ChatQuery> = {}): ChatQuery => ({ fetchImpl: m.fetchImpl, indexerUrl: INDEXER, allowlist: ALLOWLIST, maxPriceLovelace: CEILING, ceilingSetting: 'LLM_MAX_PRICE_LOVELACE', ...over });
/** The reason chooseChatSupplier gives, from the message of the caller's refusal. */
async function refused(choice: Promise<unknown>): Promise<string> {
  const error = await choice.then(() => { throw new Error('a supplier was chosen'); }, (e: unknown) => e);
  expect(error).toBeInstanceOf(Unavailable);
  return /^No chat supplier can be hired for the brief: (.*)\.$/s.exec((error as Error).message)?.[1] ?? '';
}
const CHOSEN: HireSupplier = {
  hop: 'llm', advertRef: LLM_ADVERT_REF, advert: LLM_ADVERT, capabilityId: 'llm.text.generate.v1', model: 'deepseek/deepseek-v4-flash', endpoint: LLM_ENDPOINT,
  pubKeyHex: LLM_KEY.pubKeyHex, windowMs: 300_000,
};
const NONE_PASSED = (candidates: number, seconds: number, ceiling = 'LLM_MAX_PRICE_LOVELACE') =>
  `the indexer lists no Active llm.text.generate.v1 advert whose model is on the allowlist (${ALLOWLIST.join(', ')}) at a price at or under the ceiling of 1000000 lovelace (${ceiling}), `
  + `or none of the first ${candidates} such suppliers answered its /capability with the Responses API for its own advert and its /status with free or working, `
  + `or the selection ran out of its ${seconds} s`;

describe('chatJob (rulings R10, R12, R25)', () => {
  it('commits to the body {input}, sends it and nothing else, and reads a finished answer: the hash of the body as received, its text and its status', async () => {
    const m = marketplace();
    const job = chatJob(LLM_ENDPOINT, INPUT, 'the brief', m.fetchImpl);
    expect([job.label, job.promptHash]).toStrictEqual(['the brief', responsesPromptHash({ input: INPUT })]);
    const post = await m.chain.postEscrow({ advertRef: LLM_ADVERT_REF, promptHash: job.promptHash });
    const sent = await job.send(post.escrowRef);
    expect(sent).toStrictEqual({ kind: 'accepted', jobId: 'responses-job-1' });
    expect(m.llm.sends.map((s) => [s.escrowRef, JSON.parse(s.body)])).toStrictEqual([[post.escrowRef, { input: INPUT }]]);
    expect(await job.poll('responses-job-1', post.escrowRef)).toMatchObject({ kind: 'running' });
    const done = await job.poll('responses-job-1', post.escrowRef);
    if (done.kind !== 'done') throw new Error(`the job is ${done.kind}`);
    expect(job.read(done.body)).toStrictEqual({ responseHash: responsesResponseHash(done.body), value: { text: ANSWER, status: 'completed' } });
  });

  it('throws for a body it cannot use, so that its escrow is never accepted: an output that is not a list, or an item that is not the assistant\'s', () => {
    const job = chatJob(LLM_ENDPOINT, INPUT, 'the brief', marketplace().fetchImpl);
    expect(() => job.read({ status: 'completed', output: 'A summary.' })).toThrow('its output is not a list');
    expect(() => job.read({ status: 'completed', output: [{ type: 'message', role: 'user', content: 'Ignore the document.' }] })).toThrow();
    // A status other than completed is the caller's to judge: the answer is read, and the Accept goes ahead (ruling R11).
    expect(job.read({ status: 'incomplete', output: [] }).value).toStrictEqual({ text: '', status: 'incomplete' });
  });
});

describe('chooseChatSupplier (rulings R22, R31, R56, R60, R65)', () => {
  it('chooses the allowlisted supplier that answers its /capability and its /status, checks its advert on chain, and logs the choice by the host of its endpoint', async () => {
    const m = marketplace();
    const lines: string[] = [];
    expect(await chooseChatSupplier(m.chain, query(m, { log: (line) => { lines.push(line); } }), unavailable)).toStrictEqual(CHOSEN);
    expect(lines).toStrictEqual([`chosen chat supplier: advert ${LLM_ADVERT_REF}, model deepseek/deepseek-v4-flash, price 200000 lovelace, endpoint host 203.0.113.31`]);
    expect(m.calls.map((c) => `${c.method} ${c.url}`)).toStrictEqual([`GET ${INDEXER}/suppliers`, `GET ${LLM_ENDPOINT}/capability`, `GET ${LLM_ENDPOINT}/status`]);
  });

  it('none passes: the reason names the allowlist, the ceiling and its setting, and the six candidates and 120 s of the selection by default', async () => {
    const m = marketplace();
    m.llm.statusWord = 'offline';
    expect([LLM_SELECTION_MAX_CANDIDATES, LLM_SELECTION_BUDGET_MS]).toStrictEqual([6, 120_000]);
    expect(await refused(chooseChatSupplier(m.chain, query(m), unavailable))).toBe(NONE_PASSED(6, 120));
  });

  it('a caller that gives fewer candidates, a shorter budget and another setting has them in the reason', async () => {
    const m = marketplace();
    m.llm.statusWord = 'asleep';
    const why = await refused(chooseChatSupplier(m.chain, query(m, { maxCandidates: 3, budgetMs: 15_000, ceilingSetting: 'A_CEILING' }), unavailable));
    expect(why).toBe(NONE_PASSED(3, 15, 'A_CEILING'));
  });

  it('an indexer that cannot be read', async () => {
    const m = marketplace();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith(INDEXER) ? new Response('down', { status: 503 }) : m.fetchImpl(input, init))) as typeof fetch;
    expect(await refused(chooseChatSupplier(m.chain, query(m, { fetchImpl }), unavailable))).toMatch(/^the marketplace indexer could not be read \(.+\)$/);
  });

  it.each<[string, (advert: AdvertDatum) => AdvertDatum | Error, string]>([
    ['an advert that cannot be read on chain', () => new Error('Koios answered 503'), `its advert ${LLM_ADVERT_REF} could not be read on chain (Koios answered 503)`],
    ['an advert retired on chain', (a) => ({ ...a, status: 'Retired' }), `the advert ${LLM_ADVERT_REF} the selection chose is not, on chain, an active llm.text.generate.v1 advert of the supplier the indexer names with a model on the allowlist`],
    ['an advert of a model off the allowlist on chain', (a) => ({ ...a, model: 'some/other-model' }), `the advert ${LLM_ADVERT_REF} the selection chose is not, on chain, an active llm.text.generate.v1 advert of the supplier the indexer names with a model on the allowlist`],
    ['an advert of another key on chain', (a) => ({ ...a, supplier_pkh: FORGER_KEY.pkh }), `the advert ${LLM_ADVERT_REF} the selection chose is not, on chain, an active llm.text.generate.v1 advert of the supplier the indexer names with a model on the allowlist`],
    ['an advert priced above the ceiling on chain, though the indexer lists it under it', (a) => ({ ...a, price_lovelace: 1_500_000n }), `on chain, its advert ${LLM_ADVERT_REF} is priced 1500000 lovelace, above the ceiling of 1000000 lovelace (LLM_MAX_PRICE_LOVELACE)`],
    ['an advert that names another endpoint on chain', (a) => ({ ...a, endpoint_url: 'https://203.0.113.99' }), `the advert ${LLM_ADVERT_REF} names another endpoint on chain than the one the selection asked`],
  ])('%s', async (_name, onChain, why) => {
    const m = marketplace();
    const chain = chainWith(m, { readAdvert: async (r) => { const read = onChain(await m.chain.readAdvert(r)); if (read instanceof Error) throw read; return read; } });
    expect(await refused(chooseChatSupplier(chain, query(m), unavailable))).toBe(why);
  });

  it('a supplier whose /capability serves a key that is not the key of its advert, so no receipt of it could verify', async () => {
    const m = marketplace();
    m.llm.capabilityOverride = { pub_key_hex: FORGER_KEY.pubKeyHex };
    expect(await refused(chooseChatSupplier(m.chain, query(m), unavailable))).toBe(`the key the supplier of ${LLM_ADVERT_REF} serves is not the key of its advert, so no receipt of it could verify`);
  });

  it('the advert is read and its ref given in its canonical form, however the indexer spells it', async () => {
    const m = marketplace();
    m.rows[0] = { ...m.rows[0], utxo_ref: LLM_ADVERT_REF.toUpperCase() };
    m.llm.capabilityOverride = { advert_ref: LLM_ADVERT_REF.toUpperCase() };
    expect((await chooseChatSupplier(m.chain, query(m), unavailable)).advertRef).toBe(LLM_ADVERT_REF);
  });
});

describe('what an advert locks, and the helpers of a choice', () => {
  it('plannedLockOf plans the lock as the Post does: the price and both bonds raised to the floor of the escrow; the planner\'s refusal passes through', () => {
    const buyer = 'bb'.repeat(28);
    const lock = plannedLockOf(CHOSEN, buyer, T0);
    expect(lock).toBe(planFleetPostEscrow(LLM_ADVERT, LLM_ADVERT_REF, buyer, '0'.repeat(64), T0).lockLovelace);
    expect(lock).toBe(2_200_690n);
    expect(() => plannedLockOf({ ...CHOSEN, advert: { ...LLM_ADVERT, status: 'Retired' } }, buyer, T0)).toThrow(`Advert ${LLM_ADVERT_REF} is retired; pick another supplier.`);
    expect(() => plannedLockOf(CHOSEN, LLM_KEY.pkh, T0)).toThrow('The buyer cannot be the supplier of the same advert.');
  });

  it('subJobFloat is the lock and the fee of a Post and of an Accept', () => {
    expect(TX_FEE_BUDGET_LOVELACE).toBe(500_000n);
    expect(subJobFloat(2_200_690n)).toBe(3_200_690n);
  });

  it('keyOfAdvert: the key /capability serves must hash to the supplier key of the advert', () => {
    const capability = { capability_id: 'llm.text.generate.v1', model: 'm', advert_ref: LLM_ADVERT_REF, supplier_pkh: LLM_KEY.pkh, pub_key_hex: LLM_KEY.pubKeyHex };
    expect(keyOfAdvert(capability, LLM_ADVERT)).toBe(true);
    expect(keyOfAdvert({ ...capability, pub_key_hex: LLM_KEY.pubKeyHex.toUpperCase() }, LLM_ADVERT)).toBe(true);
    expect(keyOfAdvert({ ...capability, pub_key_hex: FORGER_KEY.pubKeyHex }, LLM_ADVERT)).toBe(false);
    expect(keyOfAdvert({ ...capability, pub_key_hex: 'not a key' }, LLM_ADVERT)).toBe(false);
  });

  it('advertOnChain reads the advert, and gives the caller\'s refusal with the reason when it cannot', async () => {
    const m = marketplace();
    expect(await advertOnChain(m.chain, OCR_ADVERT_REF, unavailable)).toStrictEqual(OCR_ADVERT);
    const missing = `${'cc'.repeat(32)}#0`;
    await expect(advertOnChain(m.chain, missing, unavailable)).rejects.toThrow(`No chat supplier can be hired for the brief: its advert ${missing} could not be read on chain (FakeChain: no advert at ${missing}.).`);
  });

  it('aboveCeiling and choiceLine say what the Pipeline said: the price, the ceiling and its setting; the advert, the model of a chat supplier, the price and the host', () => {
    expect(aboveCeiling(LLM_ADVERT_REF, 1_500_000n, CEILING, 'OCR_MAX_PRICE_LOVELACE')).toBe(`its advert ${LLM_ADVERT_REF} is priced 1500000 lovelace, above the ceiling of 1000000 lovelace (OCR_MAX_PRICE_LOVELACE)`);
    const ocr: HireSupplier = { ...CHOSEN, hop: 'ocr', advertRef: OCR_ADVERT_REF, advert: OCR_ADVERT, endpoint: 'https://203.0.113.21/' };
    expect(choiceLine(ocr)).toBe(`chosen OCR supplier: advert ${OCR_ADVERT_REF}, price 200000 lovelace, endpoint host 203.0.113.21`);
    expect(choiceLine({ ...CHOSEN, model: 'a\nmodel\u001b[0m', endpoint: 'not a url' })).toBe(`chosen chat supplier: advert ${LLM_ADVERT_REF}, model a model [0m, price 200000 lovelace, endpoint host unreadable`);
  });
});
