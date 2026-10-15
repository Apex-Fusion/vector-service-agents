// agents/document-pipeline/src/orchestrate.ts
// One Pipeline job, from the parsed request to the result bundle the runtime signs: OCR for each page from the allowlisted OCR supplier, then one
// chat job for the summary or the extraction, every sub-receipt verified before its escrow is accepted (the hire itself is src/hire.ts).
//
// Before anything is posted, in this order: the extraction schema is compiled (schema_invalid, ruling R27); the buyer wallet must have its collateral
// output and a float of (max_pages + 1) x 4500000 lovelace outside it (insufficient_float, 503); the document is loaded and its pages rendered (a
// RequestError of the intake passes through unchanged, ruling R28); each page's base64 must fit the OCR supplier's 12000000 characters (page_too_large,
// ruling R27); the OCR supplier must be found and checked (ocr_supplier_unavailable, 503). Its advert is the one free advert of the allowlisted key the
// indexer lists, read again on chain, where it must be an active OCR advert of that very key: the indexer is a guide, the chain is what an escrow pays.
// Its /capability must serve the key of that advert, or no receipt of it could verify. The endpoint a job is sent to is the one on chain. The chat
// supplier is chosen then too, before any page is paid for (ruling R35): the cheapest free allowlisted supplier, probed live (selectLlmSupplier),
// whose advert is read on chain as well (llm_supplier_unavailable, 503).
//
// Then the pages in order, none started with less than 660 s left before the deadline, and the chat job, not started with less than 420 s left
// (ruling R40): its supplier is chosen again first when the first choice is more than 10 minutes old. The chat body is {input} and nothing else
// (ruling R12). Its answer must be a completed response: one that is not is still verified and accepted (the supplier delivered), and the job fails
// with llm_incomplete (ruling R11). Every escrow a failure leaves behind is in the stranded store, for the janitor.
import {
  findOcrAdvert, ocrPromptHash, ocrResponseHash, pollOcrJob, pollResponsesJob, readCapability, responsesOutputText, responsesPromptHash,
  responsesResponseHash, selectLlmSupplier, sendOcrJob, sendResponsesJob,
} from '@vsa/buyer-core';
import type { Chain, SupplierCapability } from '@vsa/buyer-core';
import { blake2b224Hex } from '@vsa/vector-read';
import type { AdvertDatum } from '@vsa/vector-read';
import { LLM_MIN_LEFT_MS, LLM_SELECTION_MAX_AGE_MS, OCR_IMAGE_B64_MAX, PAGE_MIN_LEFT_MS, assertTimeLeft, floatNeeded } from './budget.ts';
import { answerResult, compileExtractionSchema } from './extract.ts';
import { canonicalRef, errorText } from './format.ts';
import { hire } from './hire.ts';
import type { Supplier } from './hire.ts';
import type { StrandedStore } from './janitor.ts';
import { llmInput } from './llm-prompt.ts';
import { pagesOf } from './render.ts';
import type { Renderer } from './render.ts';
import type { PipelineRequest } from './request.ts';
import { Accounting, PipelineError, RESULT_SCHEMA } from './result.ts';
import type { PipelineResult } from './result.ts';
import { loadSource } from './source.ts';

export { PipelineError } from './result.ts';
export type { PipelineErrorCode, PipelineResult, SubJob } from './result.ts';

export interface Deps {
  chain: Chain;
  /** The fetch every outbound call ends in: the source URL and the suppliers through safeFetch, the indexer as it is. */
  fetchImpl: typeof fetch;
  renderer: Renderer;
  /** POSIX milliseconds. */
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The key hash of the one OCR supplier the Pipeline hires. */
  ocrAllowlistPkh: string;
  /** The chat models the Pipeline hires, in order of preference. */
  llmAllowlist: readonly string[];
  /** The marketplace indexer; the configured one when absent. */
  indexerUrl?: string;
  stranded: StrandedStore;
  /** The moment (POSIX ms) the run must be over by: the server sets it 1620000 ms after the request arrived. */
  deadlineMs: number;
}

const OCR_CAPABILITY = 'ocr.page.extract.chandra-ocr-2.v1';
const LLM_CAPABILITY = 'llm.text.generate.v1';
const OUTPUT_FORMAT = 'markdown';
const PUB_KEY = /^[0-9a-f]{64}$/i;
const withoutSlash = (url: string): string => url.replace(/\/+$/, '');
/** Does the key a supplier's /capability serves hash to the supplier key of its advert? */
const keyOfAdvert = (capability: SupplierCapability, advert: AdvertDatum): boolean =>
  PUB_KEY.test(capability.pub_key_hex) && blake2b224Hex(capability.pub_key_hex.toLowerCase()) === advert.supplier_pkh.toLowerCase();

/** Runs one job: see the head of this file. Resolves with the result bundle, or rejects with a PipelineError, a RequestError of the intake, or an Error of the machine (a renderer that cannot run, a store that cannot be written). */
export async function runPipeline(req: PipelineRequest, deps: Deps): Promise<PipelineResult> {
  const check = req.task === 'extract' ? compileExtractionSchema(req.schema) : null;
  await assertFunded(deps.chain, req.max_pages);
  const source = await loadSource(req, { fetchImpl: deps.fetchImpl });
  const { total, pages, mime } = await pagesOf(source, req.max_pages, deps.renderer);
  const imageMime = ocrMime(mime);
  const images = pages.map((page) => ({ index: page.index, base64: Buffer.from(page.png).toString('base64') }));
  for (const image of images) {
    if (image.base64.length > OCR_IMAGE_B64_MAX) {
      throw new PipelineError('page_too_large', `Page ${image.index + 1} is ${image.base64.length} characters of base64, over the ${OCR_IMAGE_B64_MAX} the OCR supplier takes. Nothing was spent.`);
    }
  }
  const ocr = await ocrSupplier(deps);
  const label = req.task === 'summary' ? 'the summary' : 'the extraction';
  let llm = await llmSupplier(deps, label);
  const chosenAt = deps.clock();
  const accounting = new Accounting();

  const pagesRead: PipelineResult['pages'] = [];
  for (const image of images) {
    const label = `page ${image.index + 1}`;
    assertTimeLeft(deps, PAGE_MIN_LEFT_MS, label);
    const page = { image_b64: image.base64, mime: imageMime, output_format: OUTPUT_FORMAT } as const;
    const hired = await hire(deps, ocr, {
      label,
      promptHash: ocrPromptHash(page),
      send: (escrowRef) => sendOcrJob(ocr.endpoint, escrowRef, page, deps.fetchImpl),
      poll: (jobId, escrowRef) => pollOcrJob(ocr.endpoint, jobId, deps.fetchImpl, escrowRef),
      // The response hash covers the text and the format the job was sent with, which is the one the supplier hashed (ruling R25: text, or no hash).
      read: (body) => {
        if (typeof body.content !== 'string') throw new Error('its content is not text');
        return { responseHash: ocrResponseHash({ content: body.content, output_format: OUTPUT_FORMAT }), value: body.content };
      },
    }, accounting);
    pagesRead.push({ index: image.index, text: hired.value, sub_job: hired.subJob });
  }

  assertTimeLeft(deps, LLM_MIN_LEFT_MS, label);
  if (deps.clock() - chosenAt > LLM_SELECTION_MAX_AGE_MS) {
    llm = await llmSupplier(deps, label);
    assertTimeLeft(deps, LLM_MIN_LEFT_MS, label);
  }
  // A schema rides only with an extraction: parseRequest refuses one with a summary, and a request made another way is not failed for it after the pages are paid.
  const input = llmInput({ task: req.task, language: req.language, schema: req.task === 'extract' ? req.schema : undefined, pages: pagesRead });
  const answer = await hire(deps, llm, {
    label,
    promptHash: responsesPromptHash({ input }),
    send: (escrowRef) => sendResponsesJob(llm.endpoint, escrowRef, { input }, deps.fetchImpl),
    poll: (jobId, escrowRef) => pollResponsesJob(llm.endpoint, jobId, deps.fetchImpl, escrowRef),
    // Hashed as received (ruling R10), and the answer text read before the Accept, so a body without one is not paid for (ruling R12).
    read: (body) => {
      if (!Array.isArray(body.output)) throw new Error('its output is not a list');
      return { responseHash: responsesResponseHash(body), value: { text: responsesOutputText(body), status: body.status } };
    },
  }, accounting);
  if (answer.value.status !== 'completed') {
    const status = typeof answer.value.status === 'string' ? `the status "${answer.value.status.slice(0, 40)}"` : 'no status';
    throw new PipelineError('llm_incomplete', `The chat supplier's answer for ${label} has ${status}, not "completed": it was verified and its escrow accepted, since the supplier delivered, but a cut answer is no result.`);
  }

  return {
    schema: RESULT_SCHEMA,
    source: { sha256: source.sha256, bytes: source.bytes.length, mime: source.mime, pages: total },
    pages: pagesRead,
    result: answerResult(req.task, answer.value.text, check),
    llm_sub_job: answer.subJob,
    accounting: accounting.summary(),
  };
}

/** The wallet pre-flight: a collateral output, and a float of (max_pages + 1) x 4500000 outside it. A wallet that cannot be read is not confirmed. */
async function assertFunded(chain: Chain, maxPages: number): Promise<void> {
  const needed = floatNeeded(maxPages);
  const jobs = `the ${maxPages + 1} sub-jobs of a run of ${maxPages} page${maxPages === 1 ? '' : 's'}`;
  let wallet: Awaited<ReturnType<Chain['wallet']>>;
  try { wallet = await chain.wallet(); } catch (err) {
    throw new PipelineError('insufficient_float', `The buyer wallet could not be read (${errorText(err)}), so its float of ${needed} lovelace for ${jobs} cannot be confirmed. Nothing was spent.`, 503);
  }
  if (wallet.collateralLovelace === null) {
    throw new PipelineError('insufficient_float', 'The buyer wallet has no collateral output (a pure output of at least 5000000 lovelace that the Accept and the Reclaim need). Nothing was spent.', 503);
  }
  if (wallet.floatLovelace < needed) {
    throw new PipelineError('insufficient_float', `The buyer wallet holds ${wallet.floatLovelace} lovelace outside its collateral, less than the ${needed} that ${jobs} need. Nothing was spent.`, 503);
  }
}

/** The mime type the OCR supplier is sent: pagesOf gives PNG for a rendered PDF and the source's own type for an image. */
function ocrMime(mime: string): 'image/png' | 'image/jpeg' {
  if (mime === 'image/png' || mime === 'image/jpeg') return mime;
  throw new Error(`The pages are ${mime}, which is not sent to the OCR supplier.`);
}

async function advertOnChain(chain: Chain, advertRef: string, unavailable: (why: string) => PipelineError): Promise<AdvertDatum> {
  try { return await chain.readAdvert(advertRef); } catch (err) { throw unavailable(`its advert ${advertRef} could not be read on chain (${errorText(err)})`); }
}

/** The OCR supplier: the allowlisted key's one free advert, checked on chain, and the key its /capability serves. ocr_supplier_unavailable (503) otherwise. */
async function ocrSupplier(deps: Deps): Promise<Supplier> {
  const pkh = deps.ocrAllowlistPkh.toLowerCase();
  const unavailable = (why: string) => new PipelineError('ocr_supplier_unavailable', `The allowlisted OCR supplier ${pkh} cannot be hired: ${why}. Nothing was spent.`, 503);
  let listed: Awaited<ReturnType<typeof findOcrAdvert>>;
  try { listed = await findOcrAdvert({ fetchImpl: deps.fetchImpl, indexerUrl: deps.indexerUrl, supplierPkh: pkh }); } catch (err) {
    throw unavailable(`the marketplace indexer could not be read (${errorText(err)})`);
  }
  if (listed === null) throw unavailable(`the marketplace indexer lists no single free ${OCR_CAPABILITY} advert of it`);
  const advertRef = canonicalRef(listed.advertRef);
  const advert = await advertOnChain(deps.chain, advertRef, unavailable);
  if (advert.supplier_pkh !== pkh || advert.capability_id !== OCR_CAPABILITY || advert.status !== 'Active') {
    throw unavailable(`the advert ${advertRef} the indexer lists for it is not, on chain, an active ${OCR_CAPABILITY} advert of that key`);
  }
  let capability: SupplierCapability;
  try { capability = await readCapability(advert.endpoint_url, deps.fetchImpl); } catch (err) { throw unavailable(`its /capability could not be read (${errorText(err)})`); }
  if (!keyOfAdvert(capability, advert)) throw unavailable('the key its /capability serves is not the key of its advert, so no receipt of it could verify');
  return { hop: 'ocr', advertRef, capabilityId: advert.capability_id, model: advert.model, endpoint: advert.endpoint_url, pubKeyHex: capability.pub_key_hex, windowMs: advert.max_processing_ms };
}

/** The chat supplier: the selection's choice, its advert checked on chain against it. llm_supplier_unavailable (503) otherwise. */
async function llmSupplier(deps: Deps, label: string): Promise<Supplier> {
  const unavailable = (why: string) => new PipelineError('llm_supplier_unavailable', `No chat supplier can be hired for ${label}: ${why}.`, 503);
  let chosen: Awaited<ReturnType<typeof selectLlmSupplier>>;
  try { chosen = await selectLlmSupplier({ fetchImpl: deps.fetchImpl, indexerUrl: deps.indexerUrl, allowlist: deps.llmAllowlist, probe: true }); } catch (err) {
    throw unavailable(`the marketplace indexer could not be read (${errorText(err)})`);
  }
  if (chosen === null) {
    // Null says none passed in time, not that none exists (ruling R22): the reasons are the selection's three.
    throw unavailable(`the indexer lists no free ${LLM_CAPABILITY} advert whose model is on the allowlist (${deps.llmAllowlist.join(', ')}), or none of the first six such suppliers answered its /capability with the Responses API for its own advert and its /status with free, or the selection ran out of its 120 s`);
  }
  const advertRef = canonicalRef(chosen.advertRef);
  const advert = await advertOnChain(deps.chain, advertRef, unavailable);
  if (advert.capability_id !== LLM_CAPABILITY || advert.status !== 'Active' || advert.supplier_pkh !== chosen.supplierPkh.toLowerCase() || !deps.llmAllowlist.includes(advert.model)) {
    throw unavailable(`the advert ${advertRef} the selection chose is not, on chain, an active ${LLM_CAPABILITY} advert of the supplier the indexer names with a model on the allowlist`);
  }
  if (withoutSlash(advert.endpoint_url) !== withoutSlash(chosen.endpoint)) throw unavailable(`the advert ${advertRef} names another endpoint on chain than the one the selection asked`);
  if (!keyOfAdvert(chosen.capability, advert)) throw unavailable(`the key the supplier of ${advertRef} serves is not the key of its advert, so no receipt of it could verify`);
  return { hop: 'llm', advertRef, capabilityId: advert.capability_id, model: advert.model, endpoint: advert.endpoint_url, pubKeyHex: chosen.capability.pub_key_hex, windowMs: advert.max_processing_ms };
}
