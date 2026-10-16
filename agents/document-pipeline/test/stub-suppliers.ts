// agents/document-pipeline/test/stub-suppliers.ts
// The marketplace the orchestrator tests run against, all in memory: a FakeChain that holds two adverts, an indexer that lists them, and two suppliers
// that speak the fleet protocol (Apex-Fusion/agents-marketplace at e847a55, supplier/src/server.ts) through the injected fetch: the allowlisted OCR
// supplier and a chat supplier on the Responses API. Each plays its own part of the escrow on the FakeChain, the Claim when it takes a job
// (markClaimed) and the Submit when it finishes one (markSubmitted, with the hash of the receipt it signed), and signs its receipts with the real
// commitment functions and a key made from fixed bytes: Ed25519 signs deterministically, so every run gives the same receipts, and the golden result
// of test/orchestrate.test.ts can be pinned byte for byte.
//
// Each supplier can be told to misbehave the ways the tests need: answer busy, lose the connection before or after it claimed, refuse, fail the job,
// answer a poll through a proxy or a gateway, sign with another key, or change its finished answer after it signed it.
//
// The supplier endpoints are https IP literals of the documentation range 203.0.113.0/24: the clients reach a supplier only through safeFetch, which
// looks a host name up for real, and a literal needs no lookup (ruling R20). The indexer is read with the injected fetch as it is, so its name is free.
import { createHash, createPrivateKey, createPublicKey, sign as ed25519Sign } from 'node:crypto';
import { blake2b224Hex, canonicalize, formatOutRef, sha256Utf8Hex } from '@vsa/vector-read';
import type { AdvertDatum } from '@vsa/vector-read';
import { FakeChain, ocrPromptHash, ocrResponseHash, responsesPromptHash, responsesResponseHash } from '@vsa/buyer-core';
import type { FakeChainOptions } from '@vsa/buyer-core';
import { PAGE_0_PNG, PAGE_1_PNG, toBase64 } from './support.ts';

export const T0 = 1_790_000_000_000;
export const INDEXER = 'https://indexer.test';
export const OCR_ENDPOINT = 'https://203.0.113.21';
export const LLM_ENDPOINT = 'https://203.0.113.31';
export const OCR_ADVERT_REF = `${'a1'.repeat(32)}#0`;
export const LLM_ADVERT_REF = `${'b2'.repeat(32)}#1`;
export const OCR_CAPABILITY = 'ocr.page.extract.chandra-ocr-2.v1';
export const OCR_MODEL = 'historical-records-ocr-v1';
export const LLM_CAPABILITY = 'llm.text.generate.v1';
export const LLM_MODEL = 'deepseek/deepseek-v4-flash';
export const ALLOWLIST: readonly string[] = ['deepseek/deepseek-v4-flash', 'deepseek-v4-pro', 'moonshotai/kimi-k2.6', 'Qwen/Qwen3.6-35B-A3B-FP8'];
/** The window of both adverts, as the live ChandraOCR advert has it: deliver_by is posted_at + 300000 + 180000. */
export const WINDOW_MS = 300_000;
const PREFIX = 'document-pipeline-test/';
/** The escrow the n-th Post of a run opens (from 1): FakeChain's refs are sha256(prefix + n)#0. */
export const escrowNo = (n: number): string => formatOutRef(sha256Utf8Hex(`${PREFIX}${n}`), 0);
/** What the OCR supplier reads off the two fixture pages. */
export const PAGE_TEXTS: Readonly<Record<string, string>> = {
  [toBase64(PAGE_0_PNG)]: 'Page one of the test document.',
  [toBase64(PAGE_1_PNG)]: 'Page two of the test document.',
};
export const SUMMARY = 'A two-page test document. The first page says it is page one and the second that it is page two.';

// --- Keys ---------------------------------------------------------------------------------------------------------------------------
/** The PKCS#8 wrapping of a raw Ed25519 private key (RFC 8410): these 16 bytes, then the 32 bytes of the key. */
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface StubKey { pubKeyHex: string; pkh: string; sign: (receipt: unknown) => string }
/** A key made from `label` (its 32 bytes are the sha256 of it): the public key as /capability serves it, its hash, and the signature a fleet supplier writes. */
export function stubKey(label: string): StubKey {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, createHash('sha256').update(label).digest()]), format: 'der', type: 'pkcs8' });
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  if (typeof x !== 'string') throw new Error('no public key');
  const pubKeyHex = Buffer.from(x, 'base64url').toString('hex');
  return { pubKeyHex, pkh: blake2b224Hex(pubKeyHex), sign: (receipt) => ed25519Sign(null, Buffer.from(canonicalize(receipt), 'utf8'), privateKey).toString('hex') };
}
export const OCR_KEY = stubKey('document-pipeline test: the OCR supplier');
export const LLM_KEY = stubKey('document-pipeline test: the chat supplier');
/** Not the key of any advert: what a forged receipt is signed with. */
export const FORGER_KEY = stubKey('document-pipeline test: somebody else');

// --- Adverts and the indexer ---------------------------------------------------------------------------------------------------------
function advert(supplierPkh: string, capabilityId: string, model: string, endpoint: string): AdvertDatum {
  return {
    supplier_pkh: supplierPkh, capability_id: capabilityId, model, max_output_tokens: 8192, max_processing_ms: WINDOW_MS,
    price_lovelace: 200_000n, supplier_bond_lovelace: 1_000_000n, buyer_bond_lovelace: 1_000_000n, endpoint_url: endpoint,
    detail_uri: '', detail_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', advertised_at: 1_786_529_315_923, status: 'Active',
  };
}
export const OCR_ADVERT = advert(OCR_KEY.pkh, OCR_CAPABILITY, OCR_MODEL, OCR_ENDPOINT);
export const LLM_ADVERT = advert(LLM_KEY.pkh, LLM_CAPABILITY, LLM_MODEL, LLM_ENDPOINT);

/** A row of the indexer's /suppliers list for an advert, as the live indexer writes it: amounts as strings, the advert's UTxO as `utxo_ref` (ruling R19). */
export function indexerRow(ref: string, a: AdvertDatum, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    utxo_ref: ref, supplier_pkh: a.supplier_pkh, capability_id: a.capability_id, model: a.model, max_output_tokens: a.max_output_tokens,
    max_processing_ms: a.max_processing_ms, price_lovelace: String(a.price_lovelace), supplier_bond_lovelace: String(a.supplier_bond_lovelace),
    buyer_bond_lovelace: String(a.buyer_bond_lovelace), endpoint_url: a.endpoint_url, detail_uri: a.detail_uri, detail_hash: a.detail_hash,
    advertised_at: a.advertised_at, status: 'free', advert_status: 'Active', current_escrow_ref: null, last_seen_iso: '2026-10-15T09:00:00.000Z',
    created_slot: 30_043_723, ...over,
  };
}

// --- What a finished job serves --------------------------------------------------------------------------------------------------------
type Submit = (resultReceiptHash: string) => void;

/** The receipt of a finished job, signed by `signer`; `submit` gets the hash of the signed receipt, as the Submit puts it on chain. */
function signed(signer: StubKey, submit: Submit | undefined, receipt: Record<string, unknown>) {
  const receiptSignature = signer.sign(receipt);
  submit?.(sha256Utf8Hex(canonicalize({ receipt, signature: receiptSignature })));
  return { receipt, receipt_signature: receiptSignature };
}

/**
 * The body the OCR supplier serves for a finished page job (the result, the receipt, its signature, the escrow and the Submitted output), the way the
 * real one builds it: the response hash covers the page text and the output format the buyer asked for.
 */
export function ocrFinished(key: StubKey, escrowRef: string, request: { image_b64: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; output_format: 'markdown' | 'html' | 'json' }, signer: StubKey = key, submit?: Submit): Record<string, unknown> {
  const content = PAGE_TEXTS[request.image_b64] ?? 'A page the stub does not know.';
  const { receipt, receipt_signature } = signed(signer, submit, {
    escrow_ref: escrowRef, supplier_pkh: key.pkh, prompt_hash: ocrPromptHash(request), response_hash: ocrResponseHash({ content, output_format: request.output_format }),
    model: OCR_MODEL, prompt_tokens: 812, completion_tokens: 9, wallclock_ms: 4210,
  });
  return {
    output_format: request.output_format, content, usage: { prompt_tokens: 812, completion_tokens: 9, total_tokens: 821 },
    receipt, receipt_signature, escrow_ref: escrowRef, submitted_ref: formatOutRef(sha256Utf8Hex(`submit/${escrowRef}`), 0),
  };
}

/** The Responses object the chat supplier serves for a finished job, with the receipt fields, the way the real one builds it. */
export function chatFinished(key: StubKey, escrowRef: string, jobId: string, input: string, answer: string, status: string, signer: StubKey = key, submit?: Submit): Record<string, unknown> {
  const response = {
    id: `resp_${jobId}`, object: 'response', status, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null, model: LLM_MODEL,
    output: [{ type: 'message', id: `msg_${jobId}`, role: 'assistant', status, content: [{ type: 'output_text', text: answer, annotations: [] }] }],
    usage: { input_tokens: 96, output_tokens: 24, total_tokens: 120 },
  };
  const { receipt, receipt_signature } = signed(signer, submit, {
    escrow_ref: escrowRef, supplier_pkh: key.pkh, prompt_hash: responsesPromptHash({ input }), response_hash: responsesResponseHash(response),
    model: LLM_MODEL, prompt_tokens: 96, completion_tokens: 24, wallclock_ms: 1830,
  });
  return { ...response, receipt, receipt_signature, escrow_ref: escrowRef };
}

// --- The suppliers -------------------------------------------------------------------------------------------------------------------
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * What a supplier answers to one poll of a job. A job takes its steps in order and repeats the last one.
 *   running               202: the job is not finished
 *   done                  finishes the job if it is not (the Submit on chain), then 200 with the result, the receipt and its signature
 *   failed                the supplier's own failure envelope on a 502; nothing is submitted
 *   gone                  404: the supplier no longer knows the job
 *   proxy                 a 502 HTML page of a proxy, no answer of the supplier's
 *   proxy-404             a 404 HTML page of a proxy, no answer of the supplier's either (ruling R57)
 *   no-receipt            a 200 without the receipt and its signature, no answer of the supplier's
 *   gateway-after-submit  finishes the job, then a gateway's JSON error with a reason on a 504, which the client reads as `failed`
 *   { fail, submitted }   the supplier's own failure envelope with the reason `fail` on a 502, after its Submit landed when `submitted` (as the real one
 *                         answers submit_timeout when it could not see its Submit confirmed) and with nothing submitted otherwise
 */
export type PollStep = 'running' | 'done' | 'failed' | 'gone' | 'proxy' | 'proxy-404' | 'no-receipt' | 'gateway-after-submit' | { fail: string; submitted: boolean };

interface StubJob { id: string; escrowRef: string; request: Record<string, unknown>; steps: PollStep[]; finished?: Record<string, unknown> }

abstract class StubSupplier {
  /** Answer the next N sends with 409 supplier_busy, leaving the escrow Open. */
  busy = 0;
  /** The next sends fail the way a dropped connection does, after the supplier claimed the escrow or before. */
  lose: Array<'after-claim' | 'before-claim'> = [];
  /** Answer the next N sends with 404 escrow_not_found, as a supplier whose view of the chain does not show the Post yet; the escrow stays Open. */
  notFound = 0;
  /** Answer every send with this refusal: before any claim, or, with `claim`, after claiming the escrow (it took the job from an earlier send). `message` replaces its words. */
  refuse: { status: number; reason: string; claim?: boolean; message?: string } | null = null;
  /** Answer the next sends with an HTML page of each of these statuses, as a proxy in front of the supplier would; the supplier never sees them. */
  pages: number[] = [];
  /** The poll steps of every new job, unless `plans` holds one for it. */
  steps: PollStep[] = ['running', 'done'];
  /** The poll steps of the next jobs, one list per job, in order. */
  plans: PollStep[][] = [];
  /** Sign receipts with FORGER_KEY: the hash on chain is still the one of what was signed, as a supplier with the wrong key would submit it. */
  forge = false;
  /** The text of a finished answer, made from the finished body after it was signed and submitted. JSON.stringify unless set. */
  answerText: ((finished: Record<string, unknown>) => string) | null = null;
  /** Fields that replace those of the /capability answer. */
  capabilityOverride: Record<string, unknown> = {};
  /** The status word its /status answers with. */
  statusWord = 'free';
  /** Every send, with the X-Escrow-Ref header and the body exactly as received. */
  readonly sends: Array<{ escrowRef: string; body: string }> = [];
  readonly jobs = new Map<string, StubJob>();
  polls = 0;

  constructor(readonly endpoint: string, readonly key: StubKey, readonly advertRef: string, readonly advert: AdvertDatum, readonly chain: FakeChain, readonly route: string) {}

  /** The body of a finished job, after the Submit on chain with the hash of the receipt it signed. */
  protected abstract finish(job: StubJob, signer: StubKey): Record<string, unknown>;
  /** Why the body of a send is not a request this supplier takes, or null. */
  protected abstract refusal(request: Record<string, unknown>): string | null;
  protected abstract capability(): Record<string, unknown>;

  handle(method: string, path: string, escrowRef: string | null, body: string): Response {
    if (method === 'GET' && path === '/capability') return json(200, { ...this.capability(), ...this.capabilityOverride });
    if (method === 'GET' && path === '/status') return json(200, { status: this.statusWord, last_seen: '2026-10-15T09:00:00.000Z', active_sessions: 0, max_sessions: 1 });
    if (method === 'POST' && path === this.route) return this.post(escrowRef ?? '', body);
    if (method === 'GET' && path.startsWith(`${this.route}/`)) return this.poll(decodeURIComponent(path.slice(this.route.length + 1)));
    return json(404, { reason: 'no_route', message: `nothing at ${method} ${path}` });
  }

  private post(escrowRef: string, body: string): Response {
    this.sends.push({ escrowRef, body });
    const page = this.pages.shift();
    if (page !== undefined) return new Response(`<html><body><h1>${page}</h1></body></html>`, { status: page, headers: { 'content-type': 'text/html' } });
    const lost = this.lose.shift();
    if (lost !== undefined) {
      if (lost === 'after-claim') this.chain.markClaimed(escrowRef);
      throw new TypeError('fetch failed');
    }
    if (this.busy > 0) {
      this.busy -= 1;
      return json(409, { reason: 'supplier_busy', message: 'supplier is already working another job' });
    }
    if (this.notFound > 0) {
      this.notFound -= 1;
      return json(404, { reason: 'escrow_not_found', message: 'escrow UTxO not found on chain' });
    }
    if (this.refuse !== null) {
      if (this.refuse.claim === true) this.chain.markClaimed(escrowRef);
      return json(this.refuse.status, { reason: this.refuse.reason, message: this.refuse.message ?? `the supplier refused the job (${this.refuse.reason})` });
    }
    let request: unknown;
    try { request = JSON.parse(body); } catch { return json(400, { reason: 'bad_request', message: 'the body is not JSON' }); }
    if (request === null || typeof request !== 'object' || Array.isArray(request)) return json(400, { reason: 'bad_request', message: 'the body is not an object' });
    const why = this.refusal(request as Record<string, unknown>);
    if (why !== null) return json(400, { reason: 'bad_request', message: why });
    // The Claim: the real supplier answers only once its Claim is confirmed. markClaimed throws for an escrow that is not Open.
    this.chain.markClaimed(escrowRef);
    const id = `${this.route.split('/').pop()}-job-${this.jobs.size + 1}`;
    this.jobs.set(id, { id, escrowRef, request: request as Record<string, unknown>, steps: [...(this.plans.shift() ?? this.steps)] });
    return json(202, { job_id: id, status: 'accepted', escrow_ref: escrowRef });
  }

  private poll(id: string): Response {
    this.polls += 1;
    const job = this.jobs.get(id);
    if (job === undefined) return json(404, { reason: 'job_not_found', message: `no job found with id ${id}` });
    const step = job.steps.length > 1 ? (job.steps.shift() as PollStep) : job.steps[0];
    const finished = (): Record<string, unknown> => job.finished ?? (job.finished = this.finish(job, this.forge ? FORGER_KEY : this.key));
    if (typeof step === 'object') {
      if (step.submitted) finished();
      return json(502, { status: 'failed', reason: step.fail, message: `the job failed (${step.fail})`, escrow_ref: job.escrowRef });
    }
    switch (step) {
      case 'running': return json(202, { status: 'running', escrow_ref: job.escrowRef });
      case 'failed': return json(502, { status: 'failed', reason: 'upstream_failure', message: 'the upstream model did not answer', escrow_ref: job.escrowRef });
      case 'gone': return json(404, { reason: 'job_not_found', message: `no job found with id ${id}` });
      case 'proxy': return new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
      case 'proxy-404': return new Response('<html><body><h1>404 Not Found</h1></body></html>', { status: 404, headers: { 'content-type': 'text/html' } });
      case 'no-receipt': return json(200, { status: 'done', escrow_ref: job.escrowRef });
      case 'gateway-after-submit': finished(); return json(504, { reason: 'gateway_timeout', message: 'the upstream did not answer in time' });
      case 'done': {
        const body = finished();
        return new Response(this.answerText ? this.answerText(body) : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
  }
}

export class StubOcrSupplier extends StubSupplier {
  constructor(chain: FakeChain) { super(OCR_ENDPOINT, OCR_KEY, OCR_ADVERT_REF, OCR_ADVERT, chain, '/v1/ocr/extract'); }
  protected capability(): Record<string, unknown> {
    return { capability_id: OCR_CAPABILITY, model: OCR_MODEL, max_output_tokens: 8192, max_processing_ms: WINDOW_MS, price_lovelace: '200000', advert_ref: this.advertRef, supplier_pkh: this.key.pkh, pub_key_hex: this.key.pubKeyHex };
  }
  protected refusal(r: Record<string, unknown>): string | null {
    const keys = Object.keys(r).sort().join(',');
    if (keys !== 'image_b64,mime,output_format') return `the body must be {image_b64, mime, output_format} and nothing else, not {${keys}}`;
    if (typeof r.image_b64 !== 'string' || r.image_b64.length > 12_000_000) return 'image_b64 must be base64 text of at most 12000000 characters';
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(r.mime))) return 'mime is not supported';
    if (!['markdown', 'html', 'json'].includes(String(r.output_format))) return 'output_format is not supported';
    return null;
  }
  protected finish(job: StubJob, signer: StubKey): Record<string, unknown> {
    const request = job.request as Parameters<typeof ocrFinished>[2];
    return ocrFinished(this.key, job.escrowRef, request, signer, (hash) => this.chain.markSubmitted(job.escrowRef, hash));
  }
}

export class StubChatSupplier extends StubSupplier {
  /** The text of the answer. */
  answer = SUMMARY;
  /** The status of the response: `incomplete` is a model that stopped at its output limit; any other text is a supplier that says something else. */
  status = 'completed';
  constructor(chain: FakeChain) { super(LLM_ENDPOINT, LLM_KEY, LLM_ADVERT_REF, LLM_ADVERT, chain, '/v1/responses'); }
  protected capability(): Record<string, unknown> {
    return {
      capability_id: LLM_CAPABILITY, model: LLM_MODEL, max_output_tokens: 8192, max_processing_ms: WINDOW_MS, price_lovelace: '200000', advert_ref: this.advertRef,
      supplier_pkh: this.key.pkh, pub_key_hex: this.key.pubKeyHex, inference_api: 'responses', upstream_api: 'responses', reasoning_disabled: false,
    };
  }
  /** The fleet's chat route takes a Responses request; the Pipeline sends {input} and nothing else (ruling R12), so anything more is refused here. */
  protected refusal(r: Record<string, unknown>): string | null {
    const keys = Object.keys(r).sort().join(',');
    if (keys !== 'input') return `the body must be {input} and nothing else, not {${keys}}`;
    return typeof r.input === 'string' ? null : 'input must be a string';
  }
  protected finish(job: StubJob, signer: StubKey): Record<string, unknown> {
    return chatFinished(this.key, job.escrowRef, job.id, String(job.request.input), this.answer, this.status, signer, (hash) => this.chain.markSubmitted(job.escrowRef, hash));
  }
}

// --- The marketplace -----------------------------------------------------------------------------------------------------------------
export interface Marketplace {
  /** The time of the FakeChain, in POSIX milliseconds; the tests give the orchestrator the same clock. */
  clock: { now: number };
  chain: FakeChain;
  ocr: StubOcrSupplier;
  llm: StubChatSupplier;
  /** What the indexer lists at /suppliers. A test may change it before the run. */
  rows: Array<Record<string, unknown>>;
  /** Every request the fetch got, in order. */
  calls: Array<{ method: string; url: string }>;
  fetchImpl: typeof fetch;
}

/**
 * The FakeChain (the two adverts, the clock at T0), the indexer listing both adverts free, and the two suppliers behind one fetch. `ocrAdvert` and
 * `llmAdvert` replace the datum of an advert, on the chain and in the indexer's row alike (a test of a price, for one).
 */
export function marketplace(opts: Pick<FakeChainOptions, 'floatLovelace' | 'collateralLovelace'> & { ocrAdvert?: AdvertDatum; llmAdvert?: AdvertDatum } = {}): Marketplace {
  const { ocrAdvert = OCR_ADVERT, llmAdvert = LLM_ADVERT, ...chainOpts } = opts;
  const clock = { now: T0 };
  const chain = new FakeChain({ adverts: { [OCR_ADVERT_REF]: ocrAdvert, [LLM_ADVERT_REF]: llmAdvert }, clock: () => clock.now, prefix: PREFIX, ...chainOpts });
  const ocr = new StubOcrSupplier(chain);
  const llm = new StubChatSupplier(chain);
  const rows = [indexerRow(OCR_ADVERT_REF, ocrAdvert), indexerRow(LLM_ADVERT_REF, llmAdvert)];
  const calls: Marketplace['calls'] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ method, url: url.href });
    if (url.origin === INDEXER && method === 'GET' && url.pathname === '/suppliers') return json(200, rows);
    const supplier = [ocr, llm].find((s) => s.endpoint === url.origin);
    if (supplier === undefined) return json(404, { reason: 'no_route', message: `nothing at ${method} ${url.href}` });
    return supplier.handle(method, url.pathname, new Headers(init.headers).get('x-escrow-ref'), typeof init.body === 'string' ? init.body : '');
  }) as typeof fetch;
  return { clock, chain, ocr, llm, rows, calls, fetchImpl };
}
