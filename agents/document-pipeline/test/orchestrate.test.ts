// agents/document-pipeline/test/orchestrate.test.ts
// runPipeline end to end against the in-memory marketplace of test/stub-suppliers.ts: a FakeChain, an indexer, the OCR supplier and a chat supplier
// speaking the fleet protocol through the injected fetch (every call through safeFetch), with a clock the test owns. Nothing here mocks the
// orchestrator's own parts: the request is read by the intake of Task 6, every sub-receipt is checked by verifyFleetReceipt over Ed25519 and the hash
// the stub put on chain, and every escrow moves on the FakeChain.
//
// The golden run pins the whole result byte for byte. Its values were computed from the stubs alone (what each supplier signs for the request the
// Pipeline must send), not from a run of the code under test.
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { responsesPromptHash, TxNotConfirmedError } from '@vsa/buyer-core';
import type { Chain, ChainEscrowState } from '@vsa/buyer-core';
import { runPipeline, PipelineError } from '../src/orchestrate.ts';
import type { Deps, PipelineResult } from '../src/orchestrate.ts';
import { StrandedStore } from '../src/janitor.ts';
import { llmInput } from '../src/llm-prompt.ts';
import { RequestError } from '../src/request.ts';
import type { PipelineRequest } from '../src/request.ts';
import type { Renderer } from '../src/render.ts';
import { fakeRenderer } from './fake-renderer.ts';
import { PAGE_0_PNG, PAGE_1_PNG, TWO_PAGES_PDF, text, toBase64 } from './support.ts';
import {
  ALLOWLIST, INDEXER, LLM_ADVERT, LLM_ADVERT_REF, LLM_ENDPOINT, OCR_ADVERT, OCR_ENDPOINT, SUMMARY, T0, escrowNo, indexerRow, marketplace,
} from './stub-suppliers.ts';
import type { Marketplace } from './stub-suppliers.ts';

const DEADLINE_MS = 1_620_000;
const SCHEMA = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } };
const PDF = { pdf_b64: toBase64(TWO_PAGES_PDF), mime: 'application/pdf' as const };
const PAGES = [{ index: 0, text: 'Page one of the test document.' }, { index: 1, text: 'Page two of the test document.' }];
const request = (over: Partial<PipelineRequest> = {}): PipelineRequest => ({ source: PDF, task: 'summary', language: 'en', max_pages: 5, ...over });
const ALL_PASS = {
  escrow_ref_matches: true, response_hash_matches: true, supplier_key_matches: true, signature_valid: true, on_chain_hash_matches: true,
  prompt_hash_matches: true, model_matches: true,
};

/** The result of the two-page summary run, computed from the stubs (see the head of this file). */
const GOLDEN: PipelineResult = {
  schema: 'vector.document-pipeline.result.v1',
  source: { sha256: 'b81efed5987c7ecd75875885c774b8932df3d49aaded4a10c467cb543357f547', bytes: 927, mime: 'application/pdf', pages: 2 },
  pages: [
    {
      index: 0,
      text: 'Page one of the test document.',
      sub_job: {
        capability_id: 'ocr.page.extract.chandra-ocr-2.v1',
        advert_ref: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1#0',
        escrow_ref: 'a5782bb76953802d31292675208f441f93ef14b3dcfa28cea9877711616070e7#0',
        supplier_pkh: '11222e2867c74fb59111c65ad3338d6f5ae1060a07cd9118c8ae93e9',
        receipt: {
          escrow_ref: 'a5782bb76953802d31292675208f441f93ef14b3dcfa28cea9877711616070e7#0',
          supplier_pkh: '11222e2867c74fb59111c65ad3338d6f5ae1060a07cd9118c8ae93e9',
          prompt_hash: 'bb0d1c8c08fbfaf43ad12ca4908bd52aa38a8c11bdbd6f09b91bf062d578b1a6',
          response_hash: '255451782018770be2711ca0132ef0fd1d43f892af57def595f6e6b24a7d9298',
          model: 'historical-records-ocr-v1',
          prompt_tokens: 812,
          completion_tokens: 9,
          wallclock_ms: 4210,
        },
        receipt_signature: '9eb6fa22f4d8c08bfd0325fabf06339ca7fa1455a31af81400521d0d75d3e77dc19ef02308168127e3c2779e550864c579c91f3f9ee2f0c2593d55e34d552e09',
        verification: ALL_PASS,
      },
    },
    {
      index: 1,
      text: 'Page two of the test document.',
      sub_job: {
        capability_id: 'ocr.page.extract.chandra-ocr-2.v1',
        advert_ref: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1#0',
        escrow_ref: '2d8f75c78eab66b5cbe6d531e5721377ed77dcdb287cc14a8f50cb95fe8c89c5#0',
        supplier_pkh: '11222e2867c74fb59111c65ad3338d6f5ae1060a07cd9118c8ae93e9',
        receipt: {
          escrow_ref: '2d8f75c78eab66b5cbe6d531e5721377ed77dcdb287cc14a8f50cb95fe8c89c5#0',
          supplier_pkh: '11222e2867c74fb59111c65ad3338d6f5ae1060a07cd9118c8ae93e9',
          prompt_hash: 'b4c1430893768b40fcc6c79249355732ab4bdcdb70d3103ff03d2c05b7f834e8',
          response_hash: 'ae9bd16a398486065213dd48da81c38e122507a9323d499f23a85fbb766aebb8',
          model: 'historical-records-ocr-v1',
          prompt_tokens: 812,
          completion_tokens: 9,
          wallclock_ms: 4210,
        },
        receipt_signature: '4ba6446624467438cb65a11090fbf0e9716a5c0764a07744fb96889ecf10df652485bd3499d03d90f16518b3ee7e71bfef9cd008205fb3ea3481537b4bab1908',
        verification: ALL_PASS,
      },
    },
  ],
  result: { summary: SUMMARY },
  llm_sub_job: {
    capability_id: 'llm.text.generate.v1',
    advert_ref: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2#1',
    escrow_ref: '1f07d11f417efea663484e29efc9d348a64d9fc9816d97472e9187234702477d#0',
    supplier_pkh: 'a40f8784e101005a5daf6fb39e96c4ac63a2c204d31af76922b6481d',
    receipt: {
      escrow_ref: '1f07d11f417efea663484e29efc9d348a64d9fc9816d97472e9187234702477d#0',
      supplier_pkh: 'a40f8784e101005a5daf6fb39e96c4ac63a2c204d31af76922b6481d',
      prompt_hash: 'a0240ad4d68264b305c362e03b55808cf04e93001b11731df147df71b692d4f2',
      response_hash: '7b2e46c5680008869172db8bce13aed536f53c7ef803fa03fd4fdfaccb64b0d2',
      model: 'deepseek/deepseek-v4-flash',
      prompt_tokens: 96,
      completion_tokens: 24,
      wallclock_ms: 1830,
    },
    receipt_signature: 'de6eb7143976cd0dda7700ceef1ba7451dde1641eb8464936e6dfd19cd068e2748ab711d1da884b0f6ab5c2bd7bde73bd149033ee37fea4a28e4eb86ad0ce401',
    verification: ALL_PASS,
  },
  accounting: { sub_jobs: 3, locked_total_lovelace: '6783090', fees_total_lovelace: '3000000' },
};

// --- The harness -------------------------------------------------------------------------------------------------------------------
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Run { m: Marketplace; deps: Deps; stranded: StrandedStore; sleeps: number[] }
/** A marketplace, an empty stranded store, and the deps of a run whose deadline is the server's (1620000 ms after T0), on the marketplace's clock. */
function setup(opts: Parameters<typeof marketplace>[0] = {}): Run {
  const m = marketplace(opts);
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-run-'));
  dirs.push(dir);
  const stranded = new StrandedStore(dir);
  const sleeps: number[] = [];
  const deps: Deps = {
    chain: m.chain, fetchImpl: m.fetchImpl, renderer: fakeRenderer({ total: 2 }), clock: () => m.clock.now,
    sleep: async (ms) => { sleeps.push(ms); m.clock.now += ms; },
    ocrAllowlistPkh: m.ocr.key.pkh, llmAllowlist: ALLOWLIST, indexerUrl: INDEXER, stranded, deadlineMs: T0 + DEADLINE_MS,
  };
  return { m, deps, stranded, sleeps };
}

/** The FakeChain of `m` behind a plain Chain object whose methods `over` replaces. */
function chainWith(m: Marketplace, over: Partial<Chain>): Chain {
  const c = m.chain;
  return {
    wallet: () => c.wallet(), postEscrow: (a) => c.postEscrow(a), accept: (r) => c.accept(r), reclaim: (r) => c.reclaim(r),
    escrowState: (r) => c.escrowState(r), onChainReceiptHash: (r) => c.onChainReceiptHash(r), readAdvert: (r) => c.readAdvert(r), ...over,
  };
}

/** The chain of `run`, whose clock jumps to `time` once the `n`-th Accept is confirmed. */
function jumpAt(run: Run, n: number, time: number): Chain {
  let accepts = 0;
  return chainWith(run.m, {
    accept: async (r) => {
      const done = await run.m.chain.accept(r);
      accepts += 1;
      if (accepts === n) run.m.clock.now = time;
      return done;
    },
  });
}

/** The PipelineError a run rejects with, checked for its code and status. */
async function failure(run: Promise<unknown>, code: string, status = 422): Promise<PipelineError> {
  const error = await run.then(() => { throw new Error(`the run succeeded; expected ${code}`); }, (e: unknown) => e);
  expect(error).toBeInstanceOf(PipelineError);
  expect(error).toMatchObject({ name: 'PipelineError', code, status });
  return error as PipelineError;
}

const states = async (m: Marketplace, ...refs: string[]): Promise<ChainEscrowState[]> => Promise.all(refs.map((r) => m.chain.escrowState(r)));
const entry = (ref: string, postedAt: number, kind: 'ocr' | 'llm' = 'ocr') => ({ escrow_ref: ref, deliver_by: postedAt + 480_000, posted_at: postedAt, kind });
const calls = (m: Marketplace) => m.calls.map((c) => `${c.method} ${c.url}`);

// --- The golden run ----------------------------------------------------------------------------------------------------------------
describe('runPipeline: the golden run', () => {
  it('reads two pages and summarises them: the exact result, every sub-receipt verified, every escrow accepted, three sub-jobs accounted', async () => {
    const run = setup();
    const result = await runPipeline(request(), run.deps);
    expect(result).toStrictEqual(GOLDEN);
    // Byte for byte, keys in this order: the server returns JSON.stringify(result), and the runtime hashes those bytes into its receipt.
    expect(JSON.stringify(result)).toBe(JSON.stringify(GOLDEN));
    expect(await states(run.m, escrowNo(1), escrowNo(2), escrowNo(3))).toStrictEqual(['spent', 'spent', 'spent']);
    expect(run.stranded.list()).toStrictEqual([]);
    // Three Posts (lock and fee out), three Accepts (buyer bond and lock excess back, fee out): 2200000 a sub-job, the price, the supplier bond and two fees.
    expect((await run.m.chain.wallet()).floatLovelace).toBe(50_000_000n - 3n * 2_200_000n);
  });

  it('speaks the fleet protocol: both suppliers found and checked before the first Post, one send per escrow with exactly the committed body, polls 3 s apart', async () => {
    const run = setup();
    await runPipeline(request(), run.deps);
    expect(calls(run.m)).toStrictEqual([
      `GET ${INDEXER}/suppliers`, `GET ${OCR_ENDPOINT}/capability`,
      `GET ${INDEXER}/suppliers`, `GET ${LLM_ENDPOINT}/capability`, `GET ${LLM_ENDPOINT}/status`,
      `POST ${OCR_ENDPOINT}/v1/ocr/extract`, `GET ${OCR_ENDPOINT}/v1/ocr/extract/extract-job-1`, `GET ${OCR_ENDPOINT}/v1/ocr/extract/extract-job-1`,
      `POST ${OCR_ENDPOINT}/v1/ocr/extract`, `GET ${OCR_ENDPOINT}/v1/ocr/extract/extract-job-2`, `GET ${OCR_ENDPOINT}/v1/ocr/extract/extract-job-2`,
      `POST ${LLM_ENDPOINT}/v1/responses`, `GET ${LLM_ENDPOINT}/v1/responses/responses-job-1`, `GET ${LLM_ENDPOINT}/v1/responses/responses-job-1`,
    ]);
    expect(run.m.ocr.sends.map((s) => [s.escrowRef, JSON.parse(s.body)])).toStrictEqual([
      [escrowNo(1), { image_b64: toBase64(PAGE_0_PNG), mime: 'image/png', output_format: 'markdown' }],
      [escrowNo(2), { image_b64: toBase64(PAGE_1_PNG), mime: 'image/png', output_format: 'markdown' }],
    ]);
    // The chat body is {input} and nothing else, so the prompt hash the escrow commits to is the hash of the request the supplier got (ruling R12).
    const input = llmInput({ task: 'summary', language: 'en', pages: PAGES });
    expect(run.m.llm.sends.map((s) => [s.escrowRef, JSON.parse(s.body)])).toStrictEqual([[escrowNo(3), { input }]]);
    expect(responsesPromptHash({ input })).toBe(GOLDEN.llm_sub_job.receipt.prompt_hash);
    expect(run.sleeps).toStrictEqual([3_000, 3_000, 3_000, 3_000, 3_000, 3_000]);
  });

  it('reports source.pages as the page count of the document and reads only max_pages of them, accounting two sub-jobs', async () => {
    const run = setup();
    const result = await runPipeline(request({ max_pages: 1 }), run.deps);
    expect(result.source).toStrictEqual(GOLDEN.source);
    expect(result.pages).toStrictEqual([GOLDEN.pages[0]]);
    expect(result.accounting).toStrictEqual({ sub_jobs: 2, locked_total_lovelace: '4522060', fees_total_lovelace: '2000000' });
    expect(JSON.parse(run.m.llm.sends[0].body)).toStrictEqual({ input: llmInput({ task: 'summary', language: 'en', pages: [PAGES[0]] }) });
  });

  it('reads an image source as one page, sent with its own mime type', async () => {
    const run = setup();
    const result = await runPipeline(request({ source: { image_b64: toBase64(PAGE_1_PNG), mime: 'image/png' }, max_pages: 3 }), run.deps);
    expect(result.source).toStrictEqual({ sha256: createHash('sha256').update(PAGE_1_PNG).digest('hex'), bytes: PAGE_1_PNG.length, mime: 'image/png', pages: 1 });
    expect(result.pages.map((p) => [p.index, p.text])).toStrictEqual([[0, 'Page two of the test document.']]);
    expect(JSON.parse(run.m.ocr.sends[0].body)).toStrictEqual({ image_b64: toBase64(PAGE_1_PNG), mime: 'image/png', output_format: 'markdown' });
  });
});

// --- Extraction --------------------------------------------------------------------------------------------------------------------
describe('runPipeline: a request not made by parseRequest', () => {
  it('a summary that carries a schema is read as a summary: the schema is not sent, and the run does not fail on it after the pages are paid', async () => {
    const run = setup();
    const result = await runPipeline(request({ schema: SCHEMA }), run.deps);
    expect(result).toStrictEqual(GOLDEN);
    expect(JSON.parse(run.m.llm.sends[0].body)).toStrictEqual({ input: llmInput({ task: 'summary', language: 'en', pages: PAGES }) });
  });

  it('an extraction without a schema is refused before anything is fetched or posted', async () => {
    const run = setup();
    await failure(runPipeline(request({ task: 'extract' }), run.deps), 'schema_invalid', 400);
    expect(run.m.calls).toStrictEqual([]);
  });
});

describe('runPipeline: task extract', () => {
  const extract = request({ task: 'extract', schema: SCHEMA });

  it('an answer that is JSON valid against the schema is the extraction, schema_valid true, and the prompt carries the schema', async () => {
    const run = setup();
    run.m.llm.answer = '{"title":"A letter"}';
    const result = await runPipeline(extract, run.deps);
    expect(result.result).toStrictEqual({ extraction: { title: 'A letter' }, schema_valid: true });
    expect(JSON.parse(run.m.llm.sends[0].body)).toStrictEqual({ input: llmInput({ task: 'extract', language: 'en', schema: SCHEMA, pages: PAGES }) });
    expect(result.llm_sub_job.verification).toStrictEqual(ALL_PASS);
  });

  it('an answer that is not JSON: schema_valid false, extraction null, the raw text kept; the job still succeeds and the sub-receipt is still verified and accepted', async () => {
    const run = setup();
    run.m.llm.answer = 'not json';
    const result = await runPipeline(extract, run.deps);
    expect(result.result).toStrictEqual({ extraction: null, schema_valid: false, raw_text: 'not json' });
    expect(result.llm_sub_job.verification).toStrictEqual(ALL_PASS);
    expect(await states(run.m, escrowNo(1), escrowNo(2), escrowNo(3))).toStrictEqual(['spent', 'spent', 'spent']);
    expect(result.accounting).toStrictEqual(GOLDEN.accounting);
  });

  it('JSON that does not validate against the schema: schema_valid false, extraction null, the raw text kept', async () => {
    const run = setup();
    run.m.llm.answer = '{"name":"A letter"}';
    expect((await runPipeline(extract, run.deps)).result).toStrictEqual({ extraction: null, schema_valid: false, raw_text: '{"name":"A letter"}' });
  });

  it('strips a fenced code block around the JSON', async () => {
    const run = setup();
    run.m.llm.answer = 'Here it is:\n```json\n{"title":"A letter"}\n```\n';
    expect((await runPipeline(extract, run.deps)).result).toStrictEqual({ extraction: { title: 'A letter' }, schema_valid: true });
  });

  it('takes an answer that is JSON as it is, even when a string inside it holds a fence', async () => {
    const run = setup();
    run.m.llm.answer = '{"title":"```json {} ```"}';
    expect((await runPipeline(extract, run.deps)).result).toStrictEqual({ extraction: { title: '```json {} ```' }, schema_valid: true });
  });

  it('an answer nested past the stack against a recursive schema is not valid, and nothing crashes: the job succeeds with the raw text', async () => {
    const run = setup();
    const depth = 100_000;
    run.m.llm.answer = `${'['.repeat(depth)}${']'.repeat(depth)}`;
    const recursive = { $ref: '#/definitions/node', definitions: { node: { type: 'array', items: { $ref: '#/definitions/node' } } } };
    const result = await runPipeline(request({ task: 'extract', schema: recursive }), run.deps);
    expect(result.result).toStrictEqual({ extraction: null, schema_valid: false, raw_text: run.m.llm.answer });
    expect(await states(run.m, escrowNo(1), escrowNo(2), escrowNo(3))).toStrictEqual(['spent', 'spent', 'spent']);
  });
});

// --- Sending -------------------------------------------------------------------------------------------------------------------------
describe('runPipeline: sending a job', () => {
  it('a busy supplier is sent the same job again every 15 s on the same escrow: 409 twice, then 202, one escrow and three sends', async () => {
    const run = setup();
    run.m.ocr.busy = 2;
    const result = await runPipeline(request(), run.deps);
    expect(run.m.ocr.sends.map((s) => s.escrowRef)).toStrictEqual([escrowNo(1), escrowNo(1), escrowNo(1), escrowNo(2)]);
    expect(result.pages.map((p) => p.sub_job.escrow_ref)).toStrictEqual([escrowNo(1), escrowNo(2)]);
    expect(result.accounting.sub_jobs).toBe(3);
    expect(run.sleeps.slice(0, 2)).toStrictEqual([15_000, 15_000]);
  });

  it('a supplier that stays busy is sent the job until 90 s before deliver_by, then the page fails with ocr_busy and the Open escrow goes to the janitor', async () => {
    const run = setup();
    run.m.ocr.busy = 1_000;
    const error = await failure(runPipeline(request(), run.deps), 'ocr_busy');
    expect(error.message).toMatch(/busy/);
    // Sends at T0, T0 + 15 s, ... T0 + 390 s: the last one starts at deliver_by - 90 s.
    expect(run.m.ocr.sends).toHaveLength(27);
    expect(new Set(run.m.ocr.sends.map((s) => s.escrowRef))).toStrictEqual(new Set([escrowNo(1)]));
    expect(await states(run.m, escrowNo(1), escrowNo(2))).toStrictEqual(['Open', 'unknown']);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });

  it('a send that timed out after the supplier claimed: ocr_send_lost, never sent again blindly, and the Claimed escrow goes to the janitor', async () => {
    const run = setup();
    run.m.ocr.lose = ['after-claim'];
    const error = await failure(runPipeline(request(), run.deps), 'ocr_send_lost');
    expect(error.message).toMatch(/Claimed/);
    expect(run.m.ocr.sends).toHaveLength(1);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['Claimed']);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });

  it('a send that timed out with the escrow still Open is sent once more, and the run goes on', async () => {
    const run = setup();
    run.m.ocr.lose = ['before-claim'];
    const result = await runPipeline(request(), run.deps);
    expect(run.m.ocr.sends.map((s) => s.escrowRef)).toStrictEqual([escrowNo(1), escrowNo(1), escrowNo(2)]);
    expect(result).toStrictEqual(GOLDEN);
  });

  it('a second send whose outcome is unknown fails the page with ocr_send_lost, the Open escrow with the janitor', async () => {
    const run = setup();
    run.m.ocr.lose = ['before-claim', 'before-claim'];
    await failure(runPipeline(request(), run.deps), 'ocr_send_lost');
    expect(run.m.ocr.sends).toHaveLength(2);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['Open']);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });

  it('a 4xx refusal fails the page with ocr_refused and its reason: the supplier turned the job down before it claimed', async () => {
    const run = setup();
    run.m.ocr.refuse = { status: 409, reason: 'prompt_mismatch' };
    const error = await failure(runPipeline(request(), run.deps), 'ocr_refused');
    expect(error.message).toMatch(/409 prompt_mismatch/);
    expect(run.m.ocr.sends).toHaveLength(1);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });

  it('a 5xx refusal may come after a claim: the escrow is read, sent once more while it is Open, then ocr_refused', async () => {
    const run = setup();
    run.m.ocr.refuse = { status: 503, reason: 'evidence_unavailable' };
    let reads = 0;
    const chain = chainWith(run.m, { escrowState: (r) => { reads += 1; return run.m.chain.escrowState(r); } });
    await failure(runPipeline(request(), { ...run.deps, chain }), 'ocr_refused');
    expect(run.m.ocr.sends).toHaveLength(2);
    expect(reads).toBe(2);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['Open']);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });

  it('a supplier that does not see the escrow yet (404 escrow_not_found) is sent the job again every 15 s like a busy one: twice, then 202, one escrow and three sends (ruling R32)', async () => {
    const run = setup();
    run.m.ocr.notFound = 2;
    const result = await runPipeline(request(), run.deps);
    expect(result).toStrictEqual(GOLDEN);
    expect(run.m.ocr.sends.map((s) => s.escrowRef)).toStrictEqual([escrowNo(1), escrowNo(1), escrowNo(1), escrowNo(2)]);
    expect(run.sleeps.slice(0, 2)).toStrictEqual([15_000, 15_000]);
  });

  it('a supplier that never sees the escrow is sent the job until 90 s before deliver_by, then ocr_refused, naming the state the escrow is in (ruling R32)', async () => {
    const run = setup();
    run.m.ocr.notFound = 1_000;
    const error = await failure(runPipeline(request(), run.deps), 'ocr_refused');
    expect(error.message).toMatch(/404 escrow_not_found/);
    expect(error.message).toMatch(/is Open and goes to the janitor/);
    expect(run.m.ocr.sends).toHaveLength(27);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });

  it('a 4xx after a send whose outcome was unknown reads the escrow and says its real state: Claimed by a supplier that took the first send after all (ruling R32)', async () => {
    const run = setup();
    run.m.ocr.lose = ['before-claim'];
    run.m.ocr.refuse = { status: 409, reason: 'escrow_not_claimable', claim: true };
    const error = await failure(runPipeline(request(), run.deps), 'ocr_refused');
    expect(error.message).toMatch(/409 escrow_not_claimable/);
    expect(error.message).toMatch(/is Claimed and goes to the janitor/);
    expect(run.m.ocr.sends).toHaveLength(2);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['Claimed']);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });
});

// --- Polling --------------------------------------------------------------------------------------------------------------------------
describe('runPipeline: polling a job', () => {
  it('a poll answered by a proxy page or by a 200 without the receipt is not a verdict: it is polled again (ruling R21)', async () => {
    const run = setup();
    run.m.ocr.plans = [['proxy', 'no-receipt', 'running', 'done']];
    expect(await runPipeline(request(), run.deps)).toStrictEqual(GOLDEN);
    expect(run.m.ocr.polls).toBe(6);
  });

  it('a failure read on a poll while the escrow is Submitted is not terminal: polling goes on and the receipt comes (ruling R23)', async () => {
    const run = setup();
    run.m.ocr.plans = [['gateway-after-submit', 'done']];
    const read: ChainEscrowState[] = [];
    const chain = chainWith(run.m, { escrowState: async (r) => { const s = await run.m.chain.escrowState(r); read.push(s); return s; } });
    expect(await runPipeline(request(), { ...run.deps, chain })).toStrictEqual(GOLDEN);
    expect(read).toStrictEqual(['Submitted']);
  });

  it('the supplier failing its own Submit step (submit_timeout, submit_failed) with the escrow Submitted fails the page at once with ocr_receipt_unavailable (ruling R34)', async () => {
    for (const fail of ['submit_timeout', 'submit_failed']) {
      const run = setup();
      run.m.ocr.plans = [[{ fail, submitted: true }]];
      const error = await failure(runPipeline(request(), run.deps), 'ocr_receipt_unavailable');
      expect(error.message).toMatch(new RegExp(fail));
      expect(run.m.ocr.polls).toBe(1);
      expect(await states(run.m, escrowNo(1))).toStrictEqual(['Submitted']);
      expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
    }
  });

  it('submit_failed with the escrow still Claimed is the supplier failing the job: ocr_failed (ruling R23)', async () => {
    const run = setup();
    run.m.ocr.plans = [[{ fail: 'submit_failed', submitted: false }]];
    await failure(runPipeline(request(), run.deps), 'ocr_failed');
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['Claimed']);
  });

  it('any other failure of the supplier with the escrow Submitted is not terminal: polling goes on (rulings R23, R34)', async () => {
    const run = setup();
    run.m.ocr.plans = [[{ fail: 'upstream_failure', submitted: true }, 'done']];
    expect(await runPipeline(request(), run.deps)).toStrictEqual(GOLDEN);
    expect(run.m.ocr.polls).toBe(2 + 2);
  });

  it("the supplier's own failure, with the escrow Claimed, fails the page with ocr_failed and its reason; the escrow goes to the janitor", async () => {
    const run = setup();
    run.m.ocr.plans = [['running', 'failed']];
    const error = await failure(runPipeline(request(), run.deps), 'ocr_failed');
    expect(error.message).toMatch(/upstream_failure/);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['Claimed']);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });

  it('a job the supplier no longer knows (404), with the escrow Claimed, fails the page with ocr_failed', async () => {
    const run = setup();
    run.m.ocr.plans = [['gone']];
    const error = await failure(runPipeline(request(), run.deps), 'ocr_failed');
    expect(error.message).toMatch(/no longer knows the job/);
    expect(await states(run.m, escrowNo(1), escrowNo(2))).toStrictEqual(['Claimed', 'unknown']);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });

  it('a failure while the state of the escrow cannot be read is not terminal either: polling goes on until deliver_by', async () => {
    const run = setup();
    run.m.ocr.plans = [['failed']];
    const chain = chainWith(run.m, { escrowState: async () => { throw new Error('Could not read escrow: Koios answered 503'); } });
    await failure(runPipeline(request(), { ...run.deps, chain }), 'ocr_timeout');
    expect(run.m.ocr.polls).toBe(160);
  });

  it('a job that is still running at deliver_by fails the page with ocr_timeout after polls 3 s apart; the escrow goes to the janitor', async () => {
    const run = setup();
    run.m.ocr.steps = ['running'];
    await failure(runPipeline(request(), run.deps), 'ocr_timeout');
    // Polls at T0 + 3 s ... T0 + 480 s, the last one at deliver_by.
    expect(run.m.ocr.polls).toBe(160);
    expect(run.m.clock.now).toBe(T0 + 480_000);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });
});

// --- Verifying and accepting ------------------------------------------------------------------------------------------------------------
describe('runPipeline: the sub-receipt', () => {
  it('a receipt signed with the wrong key fails the page with ocr_receipt_failed: no Accept, and the Submitted escrow goes to the janitor', async () => {
    const run = setup();
    run.m.ocr.forge = true;
    let accepts = 0;
    let hashReads = 0;
    const chain = chainWith(run.m, {
      accept: (r) => { accepts += 1; return run.m.chain.accept(r); },
      onChainReceiptHash: (r) => { hashReads += 1; return run.m.chain.onChainReceiptHash(r); },
    });
    const error = await failure(runPipeline(request(), { ...run.deps, chain }), 'ocr_receipt_failed');
    expect(error.message).toMatch(/signature_valid/);
    expect(accepts).toBe(0);
    // A receipt that fails a check of its own is final: the chain is not even asked for its hash.
    expect(hashReads).toBe(0);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['Submitted']);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });

  it('waits for the hash on chain while the indexer lags the Submit, 3 s apart, then verifies and accepts (ruling R16)', async () => {
    const run = setup();
    let reads = 0;
    const chain = chainWith(run.m, { onChainReceiptHash: async (r) => { reads += 1; return reads <= 4 ? null : run.m.chain.onChainReceiptHash(r); } });
    expect(await runPipeline(request(), { ...run.deps, chain })).toStrictEqual(GOLDEN);
    expect(reads).toBe(5 + 1 + 1);
    expect(run.sleeps).toStrictEqual(Array(10).fill(3_000));
  });

  it('a read of the hash on chain that throws is asked again too', async () => {
    const run = setup();
    let reads = 0;
    const chain = chainWith(run.m, {
      onChainReceiptHash: async (r) => { reads += 1; if (reads <= 2) throw new Error('Could not read escrow: Koios answered 503'); return run.m.chain.onChainReceiptHash(r); },
    });
    expect(await runPipeline(request(), { ...run.deps, chain })).toStrictEqual(GOLDEN);
  });

  it('gives the hash on chain 120 s, then fails the page with ocr_receipt_failed and leaves the escrow to the janitor', async () => {
    const run = setup();
    let reads = 0;
    let accepts = 0;
    const chain = chainWith(run.m, { onChainReceiptHash: async () => { reads += 1; return null; }, accept: (r) => { accepts += 1; return run.m.chain.accept(r); } });
    const error = await failure(runPipeline(request(), { ...run.deps, chain }), 'ocr_receipt_failed');
    expect(error.message).toMatch(/120 s/);
    // Reads at 0, 3, ... 120 s after the receipt arrived (6 s after the Post).
    expect(reads).toBe(41);
    expect(run.m.clock.now).toBe(T0 + 6_000 + 120_000);
    expect(accepts).toBe(0);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });

  it('an OCR answer whose content is not text fails the page with ocr_bad_result before anything is hashed or accepted (ruling R25)', async () => {
    const run = setup();
    run.m.ocr.answerText = (finished) => JSON.stringify({ ...finished, content: 42 });
    await failure(runPipeline(request(), run.deps), 'ocr_bad_result');
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['Submitted']);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });

  it('an Accept that fails fails the page with ocr_accept_failed, and the escrow stays with the janitor', async () => {
    const run = setup();
    const chain = chainWith(run.m, { accept: async () => { throw new Error('The Accept was refused and cannot land (400).'); } });
    const error = await failure(runPipeline(request(), { ...run.deps, chain }), 'ocr_accept_failed');
    expect(error.message).toMatch(/refused and cannot land/);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });

  it('an Accept that was submitted but not seen confirmed does not fail the run: the result stands, its fee is not booked, and the escrow is left to the janitor marked accept_pending (ruling R33)', async () => {
    for (const landed of [false, true]) {
      const run = setup();
      let accepts = 0;
      const unseen = (ref: string) => new TxNotConfirmedError(`The Accept ${'ac'.repeat(32)} of escrow ${ref} was submitted, but Koios did not report it confirmed within 180000 ms.`, {
        txHash: 'ac'.repeat(32), escrowRef: ref, deliverBy: null, validTo: T0 + 606_000, mayLand: true,
      });
      const chain = chainWith(run.m, {
        accept: async (r) => {
          accepts += 1;
          if (accepts !== 1) return run.m.chain.accept(r);
          if (landed) await run.m.chain.accept(r);
          throw unseen(r);
        },
      });
      const result = await runPipeline(request(), { ...run.deps, chain });
      expect(result).toStrictEqual({ ...GOLDEN, accounting: { ...GOLDEN.accounting, fees_total_lovelace: '2500000' } });
      expect(run.stranded.list()).toStrictEqual([{ ...entry(escrowNo(1), T0), accept_pending: { tx_hash: 'ac'.repeat(32), valid_to: T0 + 606_000, by: 'run' } }]);
      expect(await states(run.m, escrowNo(1), escrowNo(2), escrowNo(3))).toStrictEqual([landed ? 'spent' : 'Submitted', 'spent', 'spent']);
    }
  });

  it('an Accept refused outright still fails the page with ocr_accept_failed, the escrow unmarked for the janitor', async () => {
    const run = setup();
    const refused = new TxNotConfirmedError('The Accept was refused and cannot land (400).', { txHash: 'ac'.repeat(32), escrowRef: escrowNo(1), deliverBy: null, validTo: T0 + 606_000, mayLand: false });
    const chain = chainWith(run.m, { accept: async () => { throw refused; } });
    await failure(runPipeline(request(), { ...run.deps, chain }), 'ocr_accept_failed');
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });
});

// --- The chat answer --------------------------------------------------------------------------------------------------------------------
describe('runPipeline: the chat answer', () => {
  it('a response whose status is not completed is verified and accepted (the supplier delivered), then the job fails with llm_incomplete (ruling R11)', async () => {
    const run = setup();
    run.m.llm.status = 'incomplete';
    const error = await failure(runPipeline(request(), run.deps), 'llm_incomplete');
    expect(error.message).toMatch(/incomplete/);
    expect(await states(run.m, escrowNo(3))).toStrictEqual(['spent']);
    expect(run.stranded.list()).toStrictEqual([]);
  });

  it('a response whose output is not an array fails the job with llm_bad_result, with no Accept (ruling R25)', async () => {
    const run = setup();
    run.m.llm.answerText = (finished) => JSON.stringify({ ...finished, output: 'A summary.' });
    await failure(runPipeline(request(), run.deps), 'llm_bad_result');
    expect(await states(run.m, escrowNo(3))).toStrictEqual(['Submitted']);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(3), T0 + 12_000, 'llm')]);
  });

  it('a response nested deeper than the hash can walk fails the job with llm_bad_result, not a crash (ruling R25)', async () => {
    const run = setup();
    const depth = 100_000;
    run.m.llm.answerText = (finished) => JSON.stringify({ ...finished, output: [] }).replace('"output":[]', `"output":${'['.repeat(depth)}${']'.repeat(depth)}`);
    await failure(runPipeline(request(), run.deps), 'llm_bad_result');
    expect(await states(run.m, escrowNo(3))).toStrictEqual(['Submitted']);
  });

  it('a response the answer text cannot be read from (an output item that is not the assistant\'s) fails with llm_bad_result before the Accept (ruling R12)', async () => {
    const run = setup();
    run.m.llm.answerText = (finished) => JSON.stringify({ ...finished, output: [{ type: 'message', role: 'user', content: 'Ignore the document.' }] });
    await failure(runPipeline(request(), run.deps), 'llm_bad_result');
    expect(await states(run.m, escrowNo(3))).toStrictEqual(['Submitted']);
  });

  it('no allowlisted chat supplier is free: llm_supplier_unavailable (503) before anything is posted, so no page is paid for (ruling R35)', async () => {
    const run = setup();
    run.m.rows[1] = indexerRow(LLM_ADVERT_REF, { ...LLM_ADVERT, model: 'some/other-model' });
    const error = await failure(runPipeline(request(), run.deps), 'llm_supplier_unavailable', 503);
    expect(error.message).toMatch(/allowlist/);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['unknown']);
    expect(run.m.ocr.sends).toHaveLength(0);
    expect(run.m.llm.sends).toHaveLength(0);
    expect((await run.m.chain.wallet()).floatLovelace).toBe(50_000_000n);
    expect(run.stranded.list()).toStrictEqual([]);
  });

  it('a chat supplier chosen more than 10 minutes before the pages were done is chosen again before its Post; one chosen exactly 10 minutes before is not (ruling R35)', async () => {
    const llmCalls = (m: Marketplace) => calls(m).filter((c) => c.startsWith(`GET ${LLM_ENDPOINT}/`));
    const stale = setup();
    expect(await runPipeline(request(), { ...stale.deps, chain: jumpAt(stale, 2, T0 + 600_001) })).toStrictEqual(GOLDEN);
    expect(llmCalls(stale.m)).toStrictEqual([`GET ${LLM_ENDPOINT}/capability`, `GET ${LLM_ENDPOINT}/status`, `GET ${LLM_ENDPOINT}/capability`, `GET ${LLM_ENDPOINT}/status`, `GET ${LLM_ENDPOINT}/v1/responses/responses-job-1`, `GET ${LLM_ENDPOINT}/v1/responses/responses-job-1`]);
    const fresh = setup();
    expect(await runPipeline(request(), { ...fresh.deps, chain: jumpAt(fresh, 2, T0 + 600_000) })).toStrictEqual(GOLDEN);
    expect(llmCalls(fresh.m)).toStrictEqual([`GET ${LLM_ENDPOINT}/capability`, `GET ${LLM_ENDPOINT}/status`, `GET ${LLM_ENDPOINT}/v1/responses/responses-job-1`, `GET ${LLM_ENDPOINT}/v1/responses/responses-job-1`]);
  });

  it('a chat supplier that is gone when it is chosen again fails the job with llm_supplier_unavailable, the pages paid', async () => {
    const run = setup();
    let accepts = 0;
    const chain = chainWith(run.m, {
      accept: async (r) => {
        const done = await run.m.chain.accept(r);
        accepts += 1;
        if (accepts === 2) { run.m.clock.now = T0 + 700_000; run.m.rows.splice(1, 1); }
        return done;
      },
    });
    await failure(runPipeline(request(), { ...run.deps, chain }), 'llm_supplier_unavailable', 503);
    expect(await states(run.m, escrowNo(1), escrowNo(2), escrowNo(3))).toStrictEqual(['spent', 'spent', 'unknown']);
  });
});

// --- The deadline -------------------------------------------------------------------------------------------------------------------------
describe('runPipeline: the deadline', () => {
  /** The chain of `run`, whose clock jumps to `left` ms before the deadline once the `n`-th Accept is confirmed. */
  const jumpAfterAccept = (run: Run, n: number, left: number): Chain => jumpAt(run, n, run.deps.deadlineMs - left);

  it('no page starts with less than 660 s left (ruling R40): deadline, page 1 accepted, nothing posted for page 2', async () => {
    const run = setup();
    const error = await failure(runPipeline(request(), { ...run.deps, chain: jumpAfterAccept(run, 1, 659_999) }), 'deadline');
    expect(error.message).toMatch(/page 2/);
    expect(await states(run.m, escrowNo(1), escrowNo(2))).toStrictEqual(['spent', 'unknown']);
    expect(run.m.ocr.sends).toHaveLength(1);
    expect(run.stranded.list()).toStrictEqual([]);
  });

  it('a page starts with exactly 660 s left', async () => {
    const run = setup();
    expect(await runPipeline(request(), { ...run.deps, chain: jumpAfterAccept(run, 1, 660_000) })).toStrictEqual(GOLDEN);
  });

  it('no chat job starts with less than 420 s left (ruling R40): deadline, both pages accepted, nothing posted for the summary and no second selection', async () => {
    const run = setup();
    await failure(runPipeline(request(), { ...run.deps, chain: jumpAfterAccept(run, 2, 419_999) }), 'deadline');
    expect(await states(run.m, escrowNo(1), escrowNo(2), escrowNo(3))).toStrictEqual(['spent', 'spent', 'unknown']);
    expect(run.m.llm.sends).toHaveLength(0);
    expect(calls(run.m).filter((c) => c === `GET ${INDEXER}/suppliers`)).toHaveLength(2);
  });

  it('nothing waits past the deadline: a chat job still running when it comes fails with deadline, its escrow with the janitor', async () => {
    const run = setup();
    run.m.llm.steps = ['running'];
    const posted = run.deps.deadlineMs - 420_000;
    await failure(runPipeline(request(), { ...run.deps, chain: jumpAfterAccept(run, 2, 420_000) }), 'deadline');
    expect(run.m.clock.now).toBe(run.deps.deadlineMs);
    expect(run.m.llm.polls).toBe(140);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(3), posted, 'llm')]);
  });
});

// --- Before anything is posted --------------------------------------------------------------------------------------------------------
describe('runPipeline: refusals before anything is posted', () => {
  it('a wallet without a collateral output: insufficient_float (503), and nothing is fetched or posted', async () => {
    const run = setup({ collateralLovelace: null });
    const error = await failure(runPipeline(request(), run.deps), 'insufficient_float', 503);
    expect(error.message).toMatch(/collateral/);
    expect(run.m.calls).toStrictEqual([]);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['unknown']);
  });

  it('a float below (max_pages + 1) x 4500000: insufficient_float (503); at exactly that float the run goes ahead', async () => {
    const short = setup({ floatLovelace: 26_999_999n });
    const error = await failure(runPipeline(request(), short.deps), 'insufficient_float', 503);
    expect(error.message).toMatch(/27000000/);
    expect(short.m.calls).toStrictEqual([]);
    const exact = setup({ floatLovelace: 9_000_000n });
    expect((await runPipeline(request({ max_pages: 1 }), exact.deps)).accounting.sub_jobs).toBe(2);
  });

  it('a wallet that cannot be read: insufficient_float (503), the float cannot be confirmed', async () => {
    const run = setup();
    const chain = chainWith(run.m, { wallet: async () => { throw new Error('Ogmios answered 502'); } });
    const error = await failure(runPipeline(request(), { ...run.deps, chain }), 'insufficient_float', 503);
    expect(error.message).toMatch(/could not be read/);
  });

  it('an extraction schema that does not compile, is asynchronous or uses pattern, patternProperties or format: schema_invalid (400), before anything is fetched or posted (rulings R27, R36)', async () => {
    const schemas = [
      { type: 'objekt' }, { type: 'object', requird: ['title'] }, { $ref: 'https://203.0.113.9/schema.json' }, { $async: true, type: 'object' },
      { type: 'object', properties: { title: { type: 'string', pattern: '^(a+)+$' } } }, { type: 'object', patternProperties: { '^t': { type: 'string' } } },
      { type: 'object', properties: { date: { type: 'string', format: 'date' } } },
    ];
    for (const schema of schemas) {
      const run = setup();
      await failure(runPipeline(request({ task: 'extract', schema }), run.deps), 'schema_invalid', 400);
      expect(run.m.calls).toStrictEqual([]);
    }
  });

  it('a page whose base64 is over the 12000000 characters the OCR supplier takes: page_too_large, before anything is posted (ruling R27)', async () => {
    const run = setup();
    const page = (bytes: number): Renderer => ({ pageCount: async () => 1, render: async () => [{ index: 0, png: new Uint8Array(bytes) }] });
    const error = await failure(runPipeline(request(), { ...run.deps, renderer: page(9_000_003) }), 'page_too_large');
    expect(error.message).toMatch(/12000004/);
    expect(run.m.calls).toStrictEqual([]);
    // 9000000 bytes are exactly 12000000 characters of base64: taken.
    const fits = setup();
    expect((await runPipeline(request(), { ...fits.deps, renderer: page(9_000_000) })).pages[0].text).toBe('A page the stub does not know.');
  });

  it('a request error of the intake passes through unchanged, and so does a failure of the renderer that is not about the document (ruling R28)', async () => {
    const run = setup();
    const error = await runPipeline(request({ source: { image_b64: toBase64(text('plain text, not a picture')), mime: 'image/png' } }), run.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestError);
    expect(error).toMatchObject({ code: 'source_unsupported', status: 422 });
    const missing = new Error('pdfinfo could not be run (ENOENT): poppler-utils must be installed and on PATH');
    const broken: Renderer = { pageCount: async () => { throw missing; }, render: async () => [] };
    await expect(runPipeline(request(), { ...run.deps, renderer: broken })).rejects.toBe(missing);
    expect(run.m.calls).toStrictEqual([]);
  });

  it('an OCR supplier whose /capability cannot be read: ocr_supplier_unavailable, saying so in one sentence', async () => {
    const run = setup();
    run.m.ocr.capabilityOverride = { pub_key_hex: undefined };
    const error = await failure(runPipeline(request(), run.deps), 'ocr_supplier_unavailable', 503);
    expect(error.message).toMatch(/its \/capability could not be read \(Could not read the capability: pub_key_hex is missing or is not a string\.\)\. Nothing was spent\.$/);
    expect(run.m.ocr.sends).toHaveLength(0);
  });

  it('the allowlisted OCR supplier is not listed free: ocr_supplier_unavailable (503), nothing posted', async () => {
    const run = setup();
    run.m.rows.splice(0, 1);
    const error = await failure(runPipeline(request(), run.deps), 'ocr_supplier_unavailable', 503);
    expect(error.message).toMatch(new RegExp(run.m.ocr.key.pkh));
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['unknown']);
  });

  it('an indexer row that names the allowlisted key but points at an advert of another supplier: ocr_supplier_unavailable, never another advert', async () => {
    const run = setup();
    run.m.rows[0] = indexerRow(LLM_ADVERT_REF, { ...LLM_ADVERT, supplier_pkh: OCR_ADVERT.supplier_pkh, capability_id: OCR_ADVERT.capability_id });
    await failure(runPipeline(request(), run.deps), 'ocr_supplier_unavailable', 503);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['unknown']);
  });

  it('an OCR supplier whose /capability serves a key that is not the key of its advert: ocr_supplier_unavailable, as its receipts could never verify', async () => {
    const run = setup();
    run.m.ocr.capabilityOverride = { pub_key_hex: run.m.llm.key.pubKeyHex };
    await failure(runPipeline(request(), run.deps), 'ocr_supplier_unavailable', 503);
    expect(run.m.ocr.sends).toHaveLength(0);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['unknown']);
  });
});

// --- A Post that fails --------------------------------------------------------------------------------------------------------------------
describe('runPipeline: a Post that fails', () => {
  const lost = 'ee'.repeat(32);
  const notConfirmed = (mayLand: boolean) => new TxNotConfirmedError(`The Post ${lost} of escrow ${lost}#0 was submitted, but Koios did not report it confirmed.`, {
    txHash: lost, escrowRef: `${lost}#0`, deliverBy: T0 + 480_000, validTo: T0 + 180_000, mayLand,
  });

  it('one that may still land is recorded for the janitor with its deliver_by and the end of its validity (ruling R16): ocr_post_failed', async () => {
    const run = setup();
    run.m.chain.failNextPost(notConfirmed(true));
    const error = await failure(runPipeline(request(), run.deps), 'ocr_post_failed');
    expect(error.message).toMatch(/may still land/);
    expect(run.stranded.list()).toStrictEqual([{ ...entry(`${lost}#0`, T0), valid_to: T0 + 180_000 }]);
  });

  it('one that cannot land is not recorded', async () => {
    const run = setup();
    run.m.chain.failNextPost(notConfirmed(false));
    await failure(runPipeline(request(), run.deps), 'ocr_post_failed');
    expect(run.stranded.list()).toStrictEqual([]);
  });

  it('one that fails before it is signed is not recorded either', async () => {
    const run = setup();
    const chain = chainWith(run.m, { postEscrow: async () => { throw new Error('Could not read advert: Koios answered 503'); } });
    const error = await failure(runPipeline(request(), { ...run.deps, chain }), 'ocr_post_failed');
    expect(error.message).toMatch(/Koios answered 503/);
    expect(run.stranded.list()).toStrictEqual([]);
  });

  it('the summary hop says llm_post_failed', async () => {
    const run = setup();
    let posts = 0;
    const chain = chainWith(run.m, { postEscrow: async (a) => { posts += 1; if (posts === 3) throw new Error('no node'); return run.m.chain.postEscrow(a); } });
    await failure(runPipeline(request(), { ...run.deps, chain }), 'llm_post_failed');
    expect(await states(run.m, escrowNo(1), escrowNo(2), escrowNo(3))).toStrictEqual(['spent', 'spent', 'unknown']);
    expect(run.stranded.list()).toStrictEqual([]);
  });
});

describe('PipelineError', () => {
  it('is an Error with a stable code, a message and a status, 422 unless given', () => {
    const error = new PipelineError('ocr_failed', 'The page failed.');
    expect(error).toBeInstanceOf(Error);
    expect([error.name, error.code, error.message, error.status]).toStrictEqual(['PipelineError', 'ocr_failed', 'The page failed.', 422]);
    expect(new PipelineError('insufficient_float', 'Not enough.', 503).status).toBe(503);
  });
});

describe('runPipeline: the stranded store cannot be written', () => {
  it('after a Post: store_write_failed (500), naming the escrow that holds funds the janitor does not know of; nothing is sent', async () => {
    const run = setup();
    run.stranded.add = () => { throw new Error('ENOSPC: no space left on device'); };
    const error = await failure(runPipeline(request(), run.deps), 'store_write_failed', 500);
    expect(error.message).toMatch(new RegExp(`${escrowNo(1)}.*ENOSPC`));
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['Open']);
    expect(run.m.ocr.sends).toHaveLength(0);
  });

  it('after an Accept: store_write_failed (500), the escrow accepted', async () => {
    const run = setup();
    run.stranded.remove = () => { throw new Error('EIO: i/o error'); };
    const error = await failure(runPipeline(request(), run.deps), 'store_write_failed', 500);
    expect(error.message).toMatch(new RegExp(`${escrowNo(1)}.*EIO`));
    expect(await states(run.m, escrowNo(1), escrowNo(2))).toStrictEqual(['spent', 'unknown']);
  });

  it('after an Accept that may land: store_write_failed (500), since the store cannot say the Accept is pending', async () => {
    const run = setup();
    const unseen = new TxNotConfirmedError('The Accept was submitted, but Koios did not report it confirmed.', { txHash: 'ac'.repeat(32), escrowRef: escrowNo(1), deliverBy: null, validTo: T0 + 606_000, mayLand: true });
    const chain = chainWith(run.m, { accept: async () => { throw unseen; } });
    run.stranded.update = () => { throw new Error('ENOSPC: no space left on device'); };
    const error = await failure(runPipeline(request(), { ...run.deps, chain }), 'store_write_failed', 500);
    expect(error.message).toMatch(new RegExp(`${escrowNo(1)}.*ENOSPC.*${'ac'.repeat(32)}`));
  });

  it('after a Post that may land: store_write_failed (500), not ocr_post_failed', async () => {
    const run = setup();
    const lost = 'ee'.repeat(32);
    run.m.chain.failNextPost(new TxNotConfirmedError('The Post was submitted, but Koios did not report it confirmed.', { txHash: lost, escrowRef: `${lost}#0`, deliverBy: T0 + 480_000, validTo: T0 + 180_000, mayLand: true }));
    run.stranded.add = () => { throw new Error('EROFS: read-only file system'); };
    const error = await failure(runPipeline(request(), run.deps), 'store_write_failed', 500);
    expect(error.message).toMatch(new RegExp(`${lost}#0.*EROFS`));
  });
});
