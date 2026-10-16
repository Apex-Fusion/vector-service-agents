// agents/document-pipeline/test/orchestrate.test.ts
// runPipeline end to end against the in-memory marketplace of test/stub-suppliers.ts: a FakeChain, an indexer, the OCR supplier and a chat supplier
// speaking the fleet protocol through the injected fetch (every call through safeFetch), with a clock the test owns. Nothing here mocks the
// orchestrator's own parts: the request is read by the intake of Task 6, every sub-receipt is checked by verifyFleetReceipt over Ed25519 and the hash
// the stub put on chain, and every escrow moves on the FakeChain.
//
// The golden run pins the whole result byte for byte. The result is test/golden.ts: its values were computed from the stubs alone (what each supplier signs
// for the request the Pipeline must send), not from a run of the code under test, and test/spec.test.ts holds the example of specs/document-pipeline.md to it.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { responsesPromptHash, TxNotConfirmedError } from '@vsa/buyer-core';
import type { Chain, ChainEscrowState } from '@vsa/buyer-core';
import { runPipeline, PipelineError } from '../src/orchestrate.ts';
import type { Deps } from '../src/orchestrate.ts';
import { StrandedStore } from '../src/janitor.ts';
import { llmInput } from '../src/llm-prompt.ts';
import { RequestError } from '../src/request.ts';
import type { PipelineRequest } from '../src/request.ts';
import type { Renderer } from '../src/render.ts';
import { fakeRenderer } from './fake-renderer.ts';
import { ALL_PASS, GOLDEN } from './golden.ts';
import { PAGE_0_PNG, PAGE_1_PNG, TWO_PAGES_PDF, text, toBase64 } from './support.ts';
import {
  ALLOWLIST, INDEXER, LLM_ADVERT, LLM_ADVERT_REF, LLM_ENDPOINT, OCR_ADVERT, OCR_ADVERT_REF, OCR_ENDPOINT, T0, escrowNo, indexerRow, marketplace,
} from './stub-suppliers.ts';
import type { Marketplace } from './stub-suppliers.ts';

const DEADLINE_MS = 1_620_000;
const SCHEMA = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } };
const PDF = { pdf_b64: toBase64(TWO_PAGES_PDF), mime: 'application/pdf' as const };
const PAGES = [{ index: 0, text: 'Page one of the test document.' }, { index: 1, text: 'Page two of the test document.' }];
const request = (over: Partial<PipelineRequest> = {}): PipelineRequest => ({ source: PDF, task: 'summary', language: 'en', max_pages: 5, ...over });

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
    ocrMaxPriceLovelace: CEILING, llmMaxPriceLovelace: CEILING,
  };
  return { m, deps, stranded, sleeps };
}
/** The default price ceiling of both hops (OCR_MAX_PRICE_LOVELACE and LLM_MAX_PRICE_LOVELACE, ruling R56). */
const CEILING = 1_000_000n;

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
      // The OCR supplier is asked for its /status too, after its /capability, as a chat candidate is (ruling R60).
      `GET ${INDEXER}/suppliers`, `GET ${OCR_ENDPOINT}/capability`, `GET ${OCR_ENDPOINT}/status`,
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

  it('logs the supplier chosen for each hop when it is chosen: its advert, the model of the chat supplier, its price and the host of its endpoint, never the whole URL (ruling R65)', async () => {
    const run = setup();
    const lines: string[] = [];
    expect(await runPipeline(request(), { ...run.deps, log: (line) => { lines.push(line); } })).toStrictEqual(GOLDEN);
    expect(lines).toStrictEqual([
      `chosen OCR supplier: advert ${OCR_ADVERT_REF}, price 200000 lovelace, endpoint host 203.0.113.21`,
      `chosen chat supplier: advert ${LLM_ADVERT_REF}, model ${LLM_ADVERT.model}, price 200000 lovelace, endpoint host 203.0.113.31`,
    ]);
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

  it('a schema with references is refused before anything is fetched or posted: the chain of the review and a recursive tree (ruling R42)', async () => {
    const definitions: Record<string, unknown> = { d23: { type: 'string' } };
    for (let i = 0; i < 23; i++) definitions[`d${i}`] = { anyOf: [{ $ref: `#/definitions/d${i + 1}` }, { $ref: `#/definitions/d${i + 1}` }] };
    const tree = { type: 'object', properties: { title: { type: 'string' }, children: { type: 'array', items: { $ref: '#' } } } };
    for (const schema of [{ $ref: '#/definitions/d0', definitions }, tree]) {
      const run = setup();
      run.m.llm.answer = '{"title":"A letter","children":[{"children":[{"children":[]}]}]}';
      const error = await failure(runPipeline(request({ task: 'extract', schema }), run.deps), 'schema_invalid', 400);
      expect(error.message).toMatch(/\$ref at #/);
      expect(run.m.calls).toStrictEqual([]);
      expect(await states(run.m, escrowNo(1))).toStrictEqual(['unknown']);
    }
  });

  it('a schema with an own __proto__ key is refused before anything is fetched or posted, so the prompt never carries it', async () => {
    const run = setup();
    const schema = JSON.parse(`{"type":"object","properties":{"title":{"type":"string"},"__proto__":{"type":"string","description":"${'x'.repeat(10_000)}"}}}`) as Record<string, unknown>;
    const error = await failure(runPipeline(request({ task: 'extract', schema }), run.deps), 'schema_invalid', 400);
    expect(error.message).toMatch(/own __proto__ key at #\/properties\/__proto__ /);
    expect(run.m.calls).toStrictEqual([]);
  });

  it('an answer nested deeper than a schema may be (100000 levels) is no extraction: schema_valid false and the raw text, the job paid and answered, never a throw (ruling R62)', async () => {
    const run = setup();
    const depth = 100_000;
    run.m.llm.answer = `${'['.repeat(depth)}${']'.repeat(depth)}`;
    const result = await runPipeline(request({ task: 'extract', schema: { type: 'array' } }), run.deps);
    expect(result.result).toStrictEqual({ extraction: null, schema_valid: false, raw_text: run.m.llm.answer });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(await states(run.m, escrowNo(1), escrowNo(2), escrowNo(3))).toStrictEqual(['spent', 'spent', 'spent']);
  });

  it('a plain object schema with nested properties checks a nested answer at every level', async () => {
    const schema = {
      type: 'object', required: ['title', 'sender'],
      properties: { title: { type: 'string' }, sender: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, address: { type: 'object', properties: { city: { type: 'string' } } } } } },
    };
    const valid = setup();
    valid.m.llm.answer = '{"title":"A letter","sender":{"name":"The city archive","address":{"city":"Split"}}}';
    expect((await runPipeline(request({ task: 'extract', schema }), valid.deps)).result).toStrictEqual({
      extraction: { title: 'A letter', sender: { name: 'The city archive', address: { city: 'Split' } } }, schema_valid: true,
    });
    const invalid = setup();
    invalid.m.llm.answer = '{"title":"A letter","sender":{"name":"The city archive","address":{"city":21000}}}';
    expect((await runPipeline(request({ task: 'extract', schema }), invalid.deps)).result).toStrictEqual({ extraction: null, schema_valid: false, raw_text: invalid.m.llm.answer });
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

  // Ruling R57: a 4xx whose body is no JSON object (bad_response) is a page of something in front of the supplier, not the supplier turning the job down,
  // and it is handled like no answer: the state of the escrow decides, and the job is sent once more while it is Open.
  it('a 403 page in answer to the first send is no refusal of the supplier: the escrow is read once, the job is sent once more, and it finishes (ruling R57)', async () => {
    const run = setup();
    run.m.ocr.pages = [403];
    let reads = 0;
    const chain = chainWith(run.m, { escrowState: (r) => { reads += 1; return run.m.chain.escrowState(r); } });
    expect(await runPipeline(request(), { ...run.deps, chain })).toStrictEqual(GOLDEN);
    expect(run.m.ocr.sends.map((s) => s.escrowRef)).toStrictEqual([escrowNo(1), escrowNo(1), escrowNo(2)]);
    expect(reads).toBe(1);
  });

  // The residual round of R57: a JSON object without a string reason is not the supplier's envelope either, and is handled like a page.
  it('a 4xx whose body is a JSON object without a reason ({"error":"gateway"}) is no refusal of the supplier: the job is sent once more and finishes', async () => {
    const run = setup();
    run.m.ocr.oddAnswers = [{ status: 403, body: { error: 'gateway' } }];
    expect(await runPipeline(request(), run.deps)).toStrictEqual(GOLDEN);
    expect(run.m.ocr.sends.map((s) => s.escrowRef)).toStrictEqual([escrowNo(1), escrowNo(1), escrowNo(2)]);
  });

  it('a 403 page twice is ocr_refused, as a 5xx answered twice is', async () => {
    const run = setup();
    run.m.ocr.pages = [403, 403];
    const error = await failure(runPipeline(request(), run.deps), 'ocr_refused');
    expect(error.message).toMatch(/refused page 1 twice \(403 bad_response/);
    expect(run.m.ocr.sends).toHaveLength(2);
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

  it('a supplier that does not see the escrow yet (404 escrow_not_found) while it reads Open is sent the job again every 15 s like a busy one: twice, then 202, one escrow and three sends (ruling R32)', async () => {
    const run = setup();
    run.m.ocr.notFound = 2;
    let reads = 0;
    const chain = chainWith(run.m, { escrowState: (r) => { reads += 1; return run.m.chain.escrowState(r); } });
    const result = await runPipeline(request(), { ...run.deps, chain });
    expect(result).toStrictEqual(GOLDEN);
    expect(run.m.ocr.sends.map((s) => s.escrowRef)).toStrictEqual([escrowNo(1), escrowNo(1), escrowNo(1), escrowNo(2)]);
    expect(run.sleeps.slice(0, 2)).toStrictEqual([15_000, 15_000]);
    // Each not-found answer reads the escrow before the job is sent again.
    expect(reads).toBe(2);
  });

  it('a not-found answer while the escrow reads Claimed is a supplier that took an earlier send whose answer was lost: ocr_send_lost at once, never sent again (ruling R32)', async () => {
    const run = setup();
    // The first send is taken (the supplier claims) and its answer lost; the first read of the escrow lags the Claim and still says Open.
    run.m.ocr.lose = ['after-claim'];
    run.m.ocr.notFound = 1;
    let reads = 0;
    const chain = chainWith(run.m, { escrowState: async (r) => { reads += 1; return reads === 1 ? 'Open' : run.m.chain.escrowState(r); } });
    const error = await failure(runPipeline(request(), { ...run.deps, chain }), 'ocr_send_lost');
    expect(error.message).toMatch(/404 escrow_not_found/);
    expect(error.message).toMatch(/is Claimed/);
    expect(run.m.ocr.sends).toHaveLength(2);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['Claimed']);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });

  // Ruling R58: a state that cannot be read is no verdict on the escrow. In the send loop it is read again every 15 s, until the send cutoff.
  it('a not-found answer while the state of the escrow cannot be read: it is read again 15 s later, and once it reads Open the job is sent again and finishes (ruling R58)', async () => {
    const run = setup();
    run.m.ocr.notFound = 1;
    let reads = 0;
    const chain = chainWith(run.m, { escrowState: async (r) => { reads += 1; if (reads === 1) throw new Error('Could not read escrow: Koios answered 503'); return run.m.chain.escrowState(r); } });
    expect(await runPipeline(request(), { ...run.deps, chain })).toStrictEqual(GOLDEN);
    expect(run.m.ocr.sends.map((s) => s.escrowRef)).toStrictEqual([escrowNo(1), escrowNo(1), escrowNo(2)]);
    expect(reads).toBe(2);
    expect(run.sleeps.slice(0, 2)).toStrictEqual([15_000, 15_000]); // the read again, then the send again
  });

  it('a not-found answer while the state of the escrow stays unreadable until the send cutoff: ocr_send_lost, saying the state could not be read; it is never sent again (ruling R58)', async () => {
    const run = setup();
    run.m.ocr.notFound = 1;
    let reads = 0;
    const chain = chainWith(run.m, { escrowState: async () => { reads += 1; throw new Error('Could not read escrow: Koios answered 503'); } });
    const error = await failure(runPipeline(request(), { ...run.deps, chain }), 'ocr_send_lost');
    expect(error.message).toMatch(/the state of its escrow [0-9a-f]{64}#0 could not be read until 90 s before its deliver_by/);
    expect(run.m.ocr.sends).toHaveLength(1);
    // Reads at T0, T0 + 15 s, ... T0 + 390 s, the send cutoff (deliver_by - 90 s): the next one would be past it.
    expect(reads).toBe(27);
    expect(run.m.clock.now).toBe(T0 + 390_000);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });

  it('a send with no answer while the state of the escrow cannot be read: it is read again, and once it reads Open the job is sent once more (ruling R58)', async () => {
    const run = setup();
    run.m.ocr.lose = ['before-claim'];
    let reads = 0;
    const chain = chainWith(run.m, { escrowState: async (r) => { reads += 1; if (reads === 1) throw new Error('Could not read escrow: Koios answered 503'); return run.m.chain.escrowState(r); } });
    expect(await runPipeline(request(), { ...run.deps, chain })).toStrictEqual(GOLDEN);
    expect(run.m.ocr.sends.map((s) => s.escrowRef)).toStrictEqual([escrowNo(1), escrowNo(1), escrowNo(2)]);
    expect(run.sleeps[0]).toBe(15_000);
  });

  it('only a 404 is a not-found: a 5xx that names escrow_not_found is an answer that may come after a claim, handled as any 5xx (ruling R32)', async () => {
    const run = setup();
    run.m.ocr.refuse = { status: 503, reason: 'escrow_not_found' };
    const error = await failure(runPipeline(request(), run.deps), 'ocr_refused');
    expect(error.message).toMatch(/refused page 1 twice \(503 escrow_not_found/);
    expect(run.m.ocr.sends).toHaveLength(2);
    expect(run.sleeps).toStrictEqual([]);
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

  it('a 404 page on a poll is no word of the supplier that the job is gone: it is polled again, and the job finishes when the supplier answers (ruling R57)', async () => {
    const run = setup();
    run.m.ocr.plans = [['proxy-404', 'running', 'done']];
    let reads = 0;
    const chain = chainWith(run.m, { escrowState: (r) => { reads += 1; return run.m.chain.escrowState(r); } });
    expect(await runPipeline(request(), { ...run.deps, chain })).toStrictEqual(GOLDEN);
    expect(run.m.ocr.polls).toBe(3 + 2);
    expect(reads).toBe(0); // no verdict was read into it, so the escrow was not even asked about
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

  // Ruling R54: the Accept of a verified sub-job is made again every 15 s on any failure that cannot land, until the planner says the accept window has
  // closed or 600 s have passed since the supplier's answer (its Submit came before it, so the window cannot last longer). The loop runs past the job's
  // deadline on purpose (ruling R53). A one-shot Accept would lose a paid, verified page to the supplier's Release.
  it('an Accept that fails once is made again 15 s later: the result is the golden one, one extra pause of 15 s, the fee of the Accept booked once (ruling R54)', async () => {
    const run = setup();
    run.m.chain.failNextAccepts(1);
    const result = await runPipeline(request(), run.deps);
    expect(result).toStrictEqual(GOLDEN);
    expect(run.sleeps).toStrictEqual([3_000, 3_000, 15_000, 3_000, 3_000, 3_000, 3_000]);
    expect(await states(run.m, escrowNo(1), escrowNo(2), escrowNo(3))).toStrictEqual(['spent', 'spent', 'spent']);
    expect(run.stranded.list()).toStrictEqual([]);
  });

  it('an Accept refused outright (it cannot land) once is made again too: a rebuild takes fresh inputs and a fresh validity range (ruling R54)', async () => {
    const run = setup();
    run.m.chain.failNextAccepts(1, new TxNotConfirmedError('The Accept was refused and cannot land (400 BadInputsUTxO).', { txHash: 'ac'.repeat(32), escrowRef: escrowNo(1), deliverBy: null, validTo: T0 + 606_000, mayLand: false }));
    expect(await runPipeline(request(), run.deps)).toStrictEqual(GOLDEN);
    expect(run.sleeps.filter((ms) => ms === 15_000)).toHaveLength(1);
  });

  it('an Accept that keeps failing is made every 15 s until 600 s after the answer of the supplier, then ocr_accept_failed, saying how often and why the last failed; the escrow stays with the janitor', async () => {
    const run = setup();
    let accepts = 0;
    const chain = chainWith(run.m, { accept: async () => { accepts += 1; throw new Error('Could not read the escrow reference script from the node: network error'); } });
    const error = await failure(runPipeline(request(), { ...run.deps, chain }), 'ocr_accept_failed');
    // The answer came at T0 + 6 s: attempts at 6 s, 21 s, ... 606 s, the last one exactly 600 s after it.
    expect(accepts).toBe(41);
    expect(run.m.clock.now).toBe(T0 + 6_000 + 600_000);
    expect(error.message).toMatch(/^The Accept of page 1 was made 41 times, 15 s apart, and the last attempt failed \(Could not read the escrow reference script from the node: network error\)/);
    expect(error.message).toMatch(/600 s/);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['Submitted']);
  });

  it('an Accept the planner says is too late is not made again: ocr_accept_failed as soon as the window has closed (ruling R54)', async () => {
    const run = setup();
    let accepts = 0;
    const chain = chainWith(run.m, { accept: (r) => { accepts += 1; if (accepts === 2) run.m.chain.closeAcceptWindow(); return run.m.chain.accept(r); } });
    run.m.chain.failNextAccepts(1);
    const error = await failure(runPipeline(request(), { ...run.deps, chain }), 'ocr_accept_failed');
    expect(accepts).toBe(2);
    expect(run.sleeps.filter((ms) => ms === 15_000)).toHaveLength(1);
    expect(error.message).toMatch(/^The Accept of page 1 was made 2 times, 15 s apart, and the last attempt failed \(Accept window closed at /);
    expect(error.message).toMatch(/the accept window has closed/);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), T0)]);
  });

  it('the retries of an Accept run past the deadline of the job (rulings R53, R54): a chat Accept that fails once after the deadline is made again, and the job returns its result', async () => {
    const run = setup();
    let accepts = 0;
    const chain = chainWith(run.m, {
      accept: async (r) => {
        accepts += 1;
        // The pages are accepted with 420 s left, so the chat job starts then; its first Accept is made 1 s after the deadline, well inside 600 s of its answer.
        if (accepts === 3) { run.m.clock.now = run.deps.deadlineMs + 1_000; run.m.chain.failNextAccepts(1); }
        const done = await run.m.chain.accept(r);
        if (accepts === 2) run.m.clock.now = run.deps.deadlineMs - 420_000;
        return done;
      },
    });
    expect(await runPipeline(request(), { ...run.deps, chain })).toStrictEqual(GOLDEN);
    expect(accepts).toBe(4);
    expect(run.m.clock.now).toBe(run.deps.deadlineMs + 1_000 + 15_000);
    expect(run.stranded.list()).toStrictEqual([]);
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

  it('an Accept refused outright every time still fails the page with ocr_accept_failed once its retries are over, the escrow unmarked for the janitor', async () => {
    const run = setup();
    const refused = new TxNotConfirmedError('The Accept was refused and cannot land (400).', { txHash: 'ac'.repeat(32), escrowRef: escrowNo(1), deliverBy: null, validTo: T0 + 606_000, mayLand: false });
    const chain = chainWith(run.m, { accept: async () => { throw refused; } });
    const error = await failure(runPipeline(request(), { ...run.deps, chain }), 'ocr_accept_failed');
    expect(error.message).toMatch(/refused and cannot land/);
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

  it('the status a supplier gives an answer that is not completed arrives flat in the message of llm_incomplete (ruling R64)', async () => {
    const run = setup();
    run.m.llm.status = 'cut\nshort\u001b[0m';
    const error = await failure(runPipeline(request(), run.deps), 'llm_incomplete');
    expect(error.message).toContain('the status "cut short [0m"');
    expect(error.message).not.toMatch(/[\u0000-\u001f\u007f]/);
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

  // Ruling R60: what the indexer says of a supplier at the moment, and a /status that says it is busy, do not fail a job before it spends: the send waits.
  it('an OCR supplier and a chat supplier whose /status says working are hired all the same, whatever the indexer lists them as: the golden result (ruling R60)', async () => {
    const run = setup();
    run.m.rows[0] = indexerRow(OCR_ADVERT_REF, OCR_ADVERT, { status: 'working' });
    run.m.rows[1] = indexerRow(LLM_ADVERT_REF, LLM_ADVERT, { status: 'offline' });
    run.m.ocr.statusWord = 'working';
    run.m.llm.statusWord = 'working';
    expect(await runPipeline(request(), run.deps)).toStrictEqual(GOLDEN);
  });

  it('a chat supplier whose /status says offline is passed over, and with no other the job is llm_supplier_unavailable (503) before anything is posted (ruling R60)', async () => {
    const run = setup();
    run.m.llm.statusWord = 'offline';
    const error = await failure(runPipeline(request(), run.deps), 'llm_supplier_unavailable', 503);
    expect(error.message).toContain('and its /status with free or working, or the selection ran out of its 120 s');
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['unknown']);
    expect(run.m.ocr.sends).toHaveLength(0);
  });

  it('a chat supplier whose /status cannot be read is skipped, and with no other the job is llm_supplier_unavailable (503) before anything is posted', async () => {
    const run = setup();
    run.m.llm.statusWord = 'asleep';
    const error = await failure(runPipeline(request(), run.deps), 'llm_supplier_unavailable', 503);
    expect(error.message).toContain('or none of the first 6 such suppliers answered its /capability with the Responses API for its own advert and its /status with free or working, or the selection ran out of its 120 s');
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['unknown']);
  });

  it('no allowlisted chat supplier is listed: llm_supplier_unavailable (503) before anything is posted, so no page is paid for (ruling R35)', async () => {
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

  // The residual round of R56: the second choice is held to the float too, its lock and two fees against the float read then.
  it('a chat supplier chosen again whose lock and fees are more than the float holds then: insufficient_float (503), the pages paid, the chat escrow never posted', async () => {
    const run = setup();
    const dear = { ...LLM_ADVERT, supplier_bond_lovelace: 60_000_000n };
    let accepts = 0;
    let changed = false;
    const chain = chainWith(run.m, {
      accept: async (r) => {
        const done = await run.m.chain.accept(r);
        accepts += 1;
        if (accepts === 2) { run.m.clock.now = T0 + 700_000; run.m.rows[1] = indexerRow(LLM_ADVERT_REF, dear); changed = true; }
        return done;
      },
      readAdvert: async (r) => (changed && r.toLowerCase() === LLM_ADVERT_REF.toLowerCase() ? dear : run.m.chain.readAdvert(r)),
    });
    const error = await failure(runPipeline(request(), { ...run.deps, chain }), 'insufficient_float', 503);
    const float = (await run.m.chain.wallet()).floatLovelace;
    expect(error.message).toMatch(new RegExp(`^The buyer wallet holds ${float} lovelace outside its collateral, less than the \\d+ that the chat job takes at the price of the supplier chosen again: a lock of \\d+ lovelace and two fees of 500000\\. The pages are paid; nothing was posted for the chat job\\.$`));
    expect(await states(run.m, escrowNo(1), escrowNo(2), escrowNo(3))).toStrictEqual(['spent', 'spent', 'unknown']);
    expect(run.m.llm.sends).toHaveLength(0);
  });

  it('a chat supplier chosen again whose lock and fees the float covers is hired as the first choice would be: the golden result', async () => {
    const stale = setup();
    expect(await runPipeline(request(), { ...stale.deps, chain: jumpAt(stale, 2, T0 + 600_001) })).toStrictEqual(GOLDEN);
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

  it('the polls of a hire stop at the deadline: a chat job still running when it comes fails with deadline, its escrow with the janitor', async () => {
    const run = setup();
    run.m.llm.steps = ['running'];
    const posted = run.deps.deadlineMs - 420_000;
    await failure(runPipeline(request(), { ...run.deps, chain: jumpAfterAccept(run, 2, 420_000) }), 'deadline');
    expect(run.m.clock.now).toBe(run.deps.deadlineMs);
    expect(run.m.llm.polls).toBe(140);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(3), posted, 'llm')]);
  });

  it('the repeats of a send stop at the deadline: a supplier that stays busy fails the page with deadline once the next send would start after it, the escrow with the janitor', async () => {
    const run = setup();
    run.m.ocr.busy = 100;
    // The Post is made 100 s before the deadline, so its deliver_by is later than the deadline and the deadline is the first limit of the sends.
    const posted = run.deps.deadlineMs - 100_000;
    const chain = chainWith(run.m, { postEscrow: async (a) => { run.m.clock.now = posted; return run.m.chain.postEscrow(a); } });
    const error = await failure(runPipeline(request(), { ...run.deps, chain }), 'deadline');
    expect(error.message).toMatch(/page 1 waited for its supplier/);
    expect(run.m.ocr.sends).toHaveLength(7); // 100, 85, 70, 55, 40, 25 and 10 s before the deadline: the next send would be 5 s after it
    expect(run.m.clock.now).toBe(run.deps.deadlineMs - 10_000);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['Open']);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(1), posted)]);
  });

  it('the repeated reads of the receipt hash stop at the deadline: a chat receipt whose hash does not show in time fails the job with deadline, its escrow Submitted and with the janitor', async () => {
    const run = setup();
    // 119 polls of 3 s from 420 s before the deadline bring the answer to 63 s before it, and the hash of the chat receipt is never listed.
    run.m.llm.steps = [...Array.from({ length: 118 }, () => 'running' as const), 'done'];
    const posted = run.deps.deadlineMs - 420_000;
    let accepts = 0;
    const chain = chainWith(run.m, {
      accept: async (r) => { const done = await run.m.chain.accept(r); accepts += 1; if (accepts === 2) run.m.clock.now = posted; return done; },
      onChainReceiptHash: (r) => (accepts < 2 ? run.m.chain.onChainReceiptHash(r) : Promise.resolve(null)),
    });
    await failure(runPipeline(request(), { ...run.deps, chain }), 'deadline');
    expect(run.m.llm.polls).toBe(119);
    expect(run.m.clock.now).toBe(run.deps.deadlineMs);
    expect(await states(run.m, escrowNo(3))).toStrictEqual(['Submitted']);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(3), posted, 'llm')]);
  });

  it('the confirmation of a Post is not cut at the deadline: one confirmed after it stands, the job is sent once, and the hire stops with deadline at its first poll, its escrow with the janitor', async () => {
    const run = setup();
    const posted = run.deps.deadlineMs - 420_000;
    let accepts = 0;
    let posts = 0;
    const chain = chainWith(run.m, {
      accept: async (r) => { const done = await run.m.chain.accept(r); accepts += 1; if (accepts === 2) run.m.clock.now = posted; return done; },
      postEscrow: async (a) => { const post = await run.m.chain.postEscrow(a); posts += 1; if (posts === 3) run.m.clock.now = run.deps.deadlineMs + 1_000; return post; },
    });
    await failure(runPipeline(request(), { ...run.deps, chain }), 'deadline');
    expect(posts).toBe(3);
    expect(run.m.llm.sends).toHaveLength(1);
    expect(run.m.llm.polls).toBe(0);
    expect(await states(run.m, escrowNo(3))).toStrictEqual(['Claimed']);
    expect(run.stranded.list()).toStrictEqual([entry(escrowNo(3), posted, 'llm')]);
  });

  it('the confirmation of an Accept is not cut at the deadline: one in flight when it comes is confirmed and booked, and the job then fails with deadline before the next hop', async () => {
    const run = setup();
    let accepts = 0;
    const chain = chainWith(run.m, { accept: async (r) => { accepts += 1; if (accepts === 1) run.m.clock.now = run.deps.deadlineMs + 1_000; return run.m.chain.accept(r); } });
    const error = await failure(runPipeline(request(), { ...run.deps, chain }), 'deadline');
    expect(error.message).toMatch(/page 2/);
    expect(await states(run.m, escrowNo(1), escrowNo(2))).toStrictEqual(['spent', 'unknown']);
    expect(run.m.ocr.sends).toHaveLength(1);
    expect(run.stranded.list()).toStrictEqual([]);
  });

  it('the heads of budget.ts and hire.ts say what the deadline cuts and what it does not, as the tests above show it', () => {
    for (const file of ['budget.ts', 'hire.ts']) {
      const head = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').split('\nimport ')[0].replace(/\n\/\/ ?/g, ' ');
      expect(head, file).not.toMatch(/every wait of a run is cut at the deadline|nothing waits past the deadline/);
      expect(head, file).toContain('does not cut the confirmation of a Post or of an Accept');
      expect(head, file).toContain('the repeats of a send, the polls, the repeats of a read of the receipt hash');
      expect(head, file).toContain('runs on');
    }
  });

  it('the Accept of the chat job is not cut either: confirmed after the deadline the job still returns its result, and unseen it is left accept_pending with the result standing', async () => {
    const late = setup();
    let accepts = 0;
    const confirmedLate = chainWith(late.m, { accept: async (r) => { accepts += 1; if (accepts === 3) late.m.clock.now = late.deps.deadlineMs + 1_000; return late.m.chain.accept(r); } });
    expect(await runPipeline(request(), { ...late.deps, chain: confirmedLate })).toStrictEqual(GOLDEN);
    expect(late.stranded.list()).toStrictEqual([]);

    const unseen = setup();
    let n = 0;
    const validTo = unseen.deps.deadlineMs + 100_000;
    const notSeen = chainWith(unseen.m, {
      accept: async (r) => {
        n += 1;
        if (n < 3) return unseen.m.chain.accept(r);
        unseen.m.clock.now = unseen.deps.deadlineMs + 1_000;
        throw new TxNotConfirmedError(`The Accept ${'ac'.repeat(32)} of escrow ${r} was submitted, but Koios did not report it confirmed within 180000 ms.`, { txHash: 'ac'.repeat(32), escrowRef: r, deliverBy: null, validTo, mayLand: true });
      },
    });
    expect(await runPipeline(request(), { ...unseen.deps, chain: notSeen })).toStrictEqual({ ...GOLDEN, accounting: { ...GOLDEN.accounting, fees_total_lovelace: '2500000' } });
    expect(unseen.stranded.list()).toStrictEqual([{ ...entry(escrowNo(3), T0 + 12_000, 'llm'), accept_pending: { tx_hash: 'ac'.repeat(32), valid_to: validTo, by: 'run' } }]);
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

  // Ruling R56: the adverts are read at run time and nothing else bounds what they cost. A ceiling for each hop, and a second look at the float once both
  // suppliers are known, with the locks they will really take, before the first Post.
  it('the OCR advert priced above OCR_MAX_PRICE_LOVELACE: ocr_supplier_unavailable (503), saying its price and the ceiling, and nothing is posted (ruling R56)', async () => {
    const run = setup({ ocrAdvert: { ...OCR_ADVERT, price_lovelace: 1_500_000n } });
    const error = await failure(runPipeline(request(), run.deps), 'ocr_supplier_unavailable', 503);
    expect(error.message).toContain(`its advert ${OCR_ADVERT_REF} is priced 1500000 lovelace, above the ceiling of 1000000 lovelace (OCR_MAX_PRICE_LOVELACE)`);
    expect(error.message).toMatch(/Nothing was spent\.$/);
    expect(run.m.ocr.sends).toHaveLength(0);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['unknown']);
  });

  it('an OCR advert the indexer lists under the ceiling but the chain prices above it: ocr_supplier_unavailable, as the chain is what an escrow pays', async () => {
    const run = setup({ ocrAdvert: { ...OCR_ADVERT, price_lovelace: 1_500_000n } });
    run.m.rows[0] = indexerRow(OCR_ADVERT_REF, OCR_ADVERT);
    const error = await failure(runPipeline(request(), run.deps), 'ocr_supplier_unavailable', 503);
    expect(error.message).toContain(`on chain, its advert ${OCR_ADVERT_REF} is priced 1500000 lovelace, above the ceiling of 1000000 lovelace (OCR_MAX_PRICE_LOVELACE)`);
    expect(run.m.ocr.sends).toHaveLength(0);
  });

  it('no chat advert at or under LLM_MAX_PRICE_LOVELACE: llm_supplier_unavailable (503), naming the ceiling and the setting, before any page is paid for (ruling R56)', async () => {
    const run = setup({ llmAdvert: { ...LLM_ADVERT, price_lovelace: 1_500_000n } });
    const error = await failure(runPipeline(request(), run.deps), 'llm_supplier_unavailable', 503);
    expect(error.message).toContain('at a price at or under the ceiling of 1000000 lovelace (LLM_MAX_PRICE_LOVELACE)');
    expect(run.m.llm.sends).toHaveLength(0);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['unknown']);
  });

  it('the second look at the float, with the locks of the suppliers chosen: a one-page job whose chat advert is priced 5 is refused with a float of 9, before any Post (ruling R56)', async () => {
    // 9 passes the gate of (max_pages + 1) x 4.5 for one page, which assumes prices at or under the ceilings. At a chat price of 5 the locks and fees are
    // 2.261030 + 1 for the page and 7 + 1 for the chat job: 11.261030 in all.
    const run = setup({ floatLovelace: 9_000_000n, llmAdvert: { ...LLM_ADVERT, price_lovelace: 5_000_000n } });
    const error = await failure(runPipeline(request({ max_pages: 1 }), { ...run.deps, llmMaxPriceLovelace: 5_000_000n }), 'insufficient_float', 503);
    expect(error.message).toContain('The buyer wallet holds 9000000 lovelace outside its collateral, less than the 11261030');
    expect(error.message).toMatch(/Nothing was spent\.$/);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['unknown']);
    expect(run.m.ocr.sends).toHaveLength(0);
    expect((await run.m.chain.wallet()).floatLovelace).toBe(9_000_000n);
    // With a float that covers them, the same two suppliers pass the check: the one-page job of the golden adverts needs 6.522060 of a float of 9.
    const enough = setup({ floatLovelace: 9_000_000n });
    expect((await runPipeline(request({ max_pages: 1 }), enough.deps)).accounting.sub_jobs).toBe(2);
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

  // The residual round: the read of the wallet is bounded as the health check's is, so a node that never answers does not hold the job for undici's 300 s.
  it('a read of the buyer wallet that never answers is abandoned after 30 s: insufficient_float (503), could not be read within 30 s, nothing posted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const run = setup();
      const job = runPipeline(request(), { ...run.deps, chain: chainWith(run.m, { wallet: () => new Promise(() => undefined) }) });
      let settled = false;
      job.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const error = await failure(job, 'insufficient_float', 503);
      expect(error.message).toBe('The buyer wallet could not be read within 30 s, so its float of 27000000 lovelace for the 6 sub-jobs of a run of 5 pages cannot be confirmed. Nothing was spent.');
      expect(await states(run.m, escrowNo(1))).toStrictEqual(['unknown']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the allowlisted OCR supplier has no Active advert the indexer lists: ocr_supplier_unavailable (503), nothing posted', async () => {
    const run = setup();
    run.m.rows.splice(0, 1);
    const error = await failure(runPipeline(request(), run.deps), 'ocr_supplier_unavailable', 503);
    expect(error.message).toMatch(new RegExp(run.m.ocr.key.pkh));
    expect(error.message).toContain('the marketplace indexer lists no single Active ocr.page.extract.chandra-ocr-2.v1 advert of it');
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['unknown']);
  });

  // Ruling R60, refined: the OCR supplier is asked for its /status too, before the first Post, as a chat candidate is. Free or working hires it (the send
  // waits for one at work); offline, another word, or no answer refuses the job before anything is spent.
  it('an OCR supplier whose /status says offline refuses the job: ocr_supplier_unavailable (503), saying what it answered; no escrow is posted and the float is whole', async () => {
    const run = setup();
    const before = (await run.m.chain.wallet()).floatLovelace;
    run.m.ocr.statusWord = 'offline';
    const error = await failure(runPipeline(request(), run.deps), 'ocr_supplier_unavailable', 503);
    expect(error.message).toMatch(/its \/status says it is offline\. Nothing was spent\.$/);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['unknown']);
    expect(run.m.ocr.sends).toHaveLength(0);
    expect((await run.m.chain.wallet()).floatLovelace).toBe(before);
  });

  it('an OCR supplier whose /status cannot be read, or says a word that is not a status of a supplier, refuses the job the same way, asked twice 3 s apart', async () => {
    for (const word of ['asleep', '']) {
      const run = setup();
      run.m.ocr.statusWord = word;
      const error = await failure(runPipeline(request(), run.deps), 'ocr_supplier_unavailable', 503);
      expect(error.message, word).toMatch(/its \/status could not be read \(no answer, an error, or no status word of a supplier\), asked twice 3 s apart\. Nothing was spent\.$/);
      expect(await states(run.m, escrowNo(1)), word).toStrictEqual(['unknown']);
    }
  });

  // The residual round of R60: a /status that cannot be read is asked once more, 3 s later, before the job is refused; offline refuses at once.
  it('an OCR /status that cannot be read once is asked again 3 s later, and the job is hired when it answers free: the golden result', async () => {
    const run = setup();
    run.m.ocr.statusFailures = 1;
    expect(await runPipeline(request(), run.deps)).toStrictEqual(GOLDEN);
    expect(run.sleeps[0]).toBe(3_000);
    expect(calls(run.m).filter((c) => c === `GET ${OCR_ENDPOINT}/status`)).toHaveLength(2);
  });

  it('an OCR /status that cannot be read twice, 3 s apart, refuses the job: ocr_supplier_unavailable (503), no escrow posted', async () => {
    const run = setup();
    run.m.ocr.statusFailures = 2;
    const error = await failure(runPipeline(request(), run.deps), 'ocr_supplier_unavailable', 503);
    expect(error.message).toMatch(/its \/status could not be read \(no answer, an error, or no status word of a supplier\), asked twice 3 s apart\. Nothing was spent\.$/);
    expect(run.sleeps).toStrictEqual([3_000]);
    expect(await states(run.m, escrowNo(1))).toStrictEqual(['unknown']);
    expect(run.m.ocr.sends).toHaveLength(0);
  });

  it('an OCR supplier that says offline is not asked again: it refuses the job at once', async () => {
    const run = setup();
    run.m.ocr.statusWord = 'offline';
    await failure(runPipeline(request(), run.deps), 'ocr_supplier_unavailable', 503);
    expect(run.sleeps).toStrictEqual([]);
    expect(calls(run.m).filter((c) => c === `GET ${OCR_ENDPOINT}/status`)).toHaveLength(1);
  });

  it('an OCR advert the indexer lists as retired is not hired, whatever its supplier says: ocr_supplier_unavailable (503), nothing posted (ruling R60)', async () => {
    const run = setup();
    run.m.rows[0] = indexerRow(OCR_ADVERT_REF, OCR_ADVERT, { advert_status: 'Retired' });
    await failure(runPipeline(request(), run.deps), 'ocr_supplier_unavailable', 503);
    expect(run.m.ocr.sends).toHaveLength(0);
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

  // Ruling R59: a submit API can answer 4xx for a transaction it forwarded. A refused Post is recorded too, and the janitor drops the entry once its validity
  // has passed and the chain shows nothing at the ref (the rule of janitor.ts): a phantom entry costs nothing, an unrecorded lock could.
  it('one the submit API refused after its signature is recorded too, with its validity, in case it landed anyway (ruling R59): ocr_post_failed says so', async () => {
    const run = setup();
    run.m.chain.failNextPost(new TxNotConfirmedError(`The Post ${lost} of escrow ${lost}#0 was refused and cannot land (Transaction submission rejected (400 Bad Request): BadInputsUTxO).`, {
      txHash: lost, escrowRef: `${lost}#0`, deliverBy: T0 + 480_000, validTo: T0 + 180_000, mayLand: false,
    }));
    const error = await failure(runPipeline(request(), run.deps), 'ocr_post_failed');
    expect(error.message).toMatch(/^The submit API refused the Post for page 1 after it was signed \(.*BadInputsUTxO.*\)\./);
    expect(error.message).toMatch(new RegExp(`its escrow ${lost}#0 is recorded for the janitor in case it landed anyway`));
    expect(run.stranded.list()).toStrictEqual([{ ...entry(`${lost}#0`, T0), valid_to: T0 + 180_000 }]);
    expect(run.m.ocr.sends).toHaveLength(0);
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

  // Ruling R62: a paid, verified result is not lost to bookkeeping. The entry the remove left behind reads spent, and the janitor drops it on its own.
  it('after a confirmed Accept: a remove that fails is logged, naming the escrow, and the run goes on; the result stands', async () => {
    const run = setup();
    const removes: string[] = [];
    run.stranded.remove = (ref: string) => { removes.push(ref); throw new Error('EIO: i/o error'); };
    const lines: string[] = [];
    expect(await runPipeline(request(), { ...run.deps, log: (line) => { lines.push(line); } })).toStrictEqual(GOLDEN);
    expect(removes).toStrictEqual([escrowNo(1), escrowNo(2), escrowNo(3)]);
    expect(await states(run.m, escrowNo(1), escrowNo(2), escrowNo(3))).toStrictEqual(['spent', 'spent', 'spent']);
    const failed = lines.filter((line) => line.includes('could not be removed from the stranded store'));
    expect(failed).toHaveLength(3);
    expect(failed[0]).toMatch(new RegExp(`^escrow ${escrowNo(1)} was accepted for page 1 in [0-9a-f]{64} and could not be removed from the stranded store \\(EIO: i/o error\\); the janitor drops it once it reads it spent$`));
  });

  it('after an Accept that may land: store_write_failed (500), since the store cannot say the Accept is pending', async () => {
    const run = setup();
    const unseen = new TxNotConfirmedError('The Accept was submitted, but Koios did not report it confirmed.', { txHash: 'ac'.repeat(32), escrowRef: escrowNo(1), deliverBy: null, validTo: T0 + 606_000, mayLand: true });
    const chain = chainWith(run.m, { accept: async () => { throw unseen; } });
    run.stranded.update = () => { throw new Error('ENOSPC: no space left on device'); };
    const error = await failure(runPipeline(request(), { ...run.deps, chain }), 'store_write_failed', 500);
    expect(error.message).toMatch(new RegExp(`${escrowNo(1)}.*ENOSPC.*${'ac'.repeat(32)}`));
  });

  it('after a Post that may land, or that the submit API refused after its signature: store_write_failed (500), not ocr_post_failed', async () => {
    for (const mayLand of [true, false]) {
      const run = setup();
      const lost = 'ee'.repeat(32);
      run.m.chain.failNextPost(new TxNotConfirmedError('The Post was submitted, but Koios did not report it confirmed.', { txHash: lost, escrowRef: `${lost}#0`, deliverBy: T0 + 480_000, validTo: T0 + 180_000, mayLand }));
      run.stranded.add = () => { throw new Error('EROFS: read-only file system'); };
      const error = await failure(runPipeline(request(), run.deps), 'store_write_failed', 500);
      expect(error.message, String(mayLand)).toMatch(new RegExp(`${lost}#0.*EROFS`));
    }
  });
});
