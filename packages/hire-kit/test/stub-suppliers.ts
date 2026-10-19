// packages/hire-kit/test/stub-suppliers.ts
// The marketplace the tests of the kit run against, all in memory: a FakeChain that holds a chat advert and an OCR advert, an indexer that lists the chat
// advert, and a chat supplier on the Responses API that speaks the fleet protocol (Apex-Fusion/agents-marketplace at e847a55, supplier/src/server.ts)
// through the injected fetch. Moved from agents/document-pipeline/test/stub-suppliers.ts without its OCR supplier: the OCR advert stays, as data, for the
// tests of the janitor. The chat supplier plays its own part of the escrow on the FakeChain, the Claim when it takes a job (markClaimed) and the Submit
// when it finishes one (markSubmitted, with the hash of the receipt it signed), and signs its receipts with the real commitment functions and a key made
// from fixed bytes: Ed25519 signs deterministically, so every run gives the same receipts, and a test can make the receipt it expects with chatFinished.
//
// The supplier can be told to misbehave the ways the tests need: answer busy, lose the connection before or after it claimed, refuse, fail the job, answer
// a poll through a proxy, sign with another key, or change its finished answer after it signed it.
//
// The supplier endpoint is an https IP literal of the documentation range 203.0.113.0/24: the clients reach a supplier only through safeFetch, which looks a
// host name up for real, and a literal needs no lookup. The indexer is read with the injected fetch as it is, so its name is free.
import { createHash, createPrivateKey, createPublicKey, sign as ed25519Sign } from 'node:crypto';
import { blake2b224Hex, canonicalize, formatOutRef, sha256Utf8Hex } from '@vsa/vector-read';
import type { AdvertDatum } from '@vsa/vector-read';
import { FakeChain, responsesPromptHash, responsesResponseHash } from '@vsa/buyer-core';
import type { Chain, FakeChainOptions } from '@vsa/buyer-core';

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
const PREFIX = 'hire-kit-test/';
/** The escrow the n-th Post of a test opens (from 1): FakeChain's refs are sha256(prefix + n)#0. */
export const escrowNo = (n: number): string => formatOutRef(sha256Utf8Hex(`${PREFIX}${n}`), 0);
/** What the chat supplier answers, unless a test says otherwise. */
export const ANSWER = 'A bonded escrow holds the price and both bonds until the buyer accepts the work or reclaims the lock.';
/** The seven checks of verifyFleetReceipt, all passed: what the record of every hire that is accepted carries. */
export const ALL_PASS = {
  escrow_ref_matches: true, response_hash_matches: true, supplier_key_matches: true, signature_valid: true, on_chain_hash_matches: true,
  prompt_hash_matches: true, model_matches: true,
};

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
export const OCR_KEY = stubKey('hire-kit test: the OCR supplier');
export const LLM_KEY = stubKey('hire-kit test: the chat supplier');
/** Not the key of any advert: what a forged receipt is signed with. */
export const FORGER_KEY = stubKey('hire-kit test: somebody else');

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

/** A row of the indexer's /suppliers list for an advert, as the live indexer writes it: amounts as strings, the advert's UTxO as `utxo_ref`. */
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

/** The Responses object the chat supplier serves for a finished job, with the receipt fields, the way the real one builds it; `submit` gets the hash of the signed receipt. */
export function chatFinished(key: StubKey, escrowRef: string, jobId: string, input: string, answer: string, status: string, signer: StubKey = key, submit?: Submit): Record<string, unknown> {
  const response = {
    id: `resp_${jobId}`, object: 'response', status, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null, model: LLM_MODEL,
    output: [{ type: 'message', id: `msg_${jobId}`, role: 'assistant', status, content: [{ type: 'output_text', text: answer, annotations: [] }] }],
    usage: { input_tokens: 96, output_tokens: 24, total_tokens: 120 },
  };
  const receipt = {
    escrow_ref: escrowRef, supplier_pkh: key.pkh, prompt_hash: responsesPromptHash({ input }), response_hash: responsesResponseHash(response),
    model: LLM_MODEL, prompt_tokens: 96, completion_tokens: 24, wallclock_ms: 1830,
  };
  const receiptSignature = signer.sign(receipt);
  submit?.(sha256Utf8Hex(canonicalize({ receipt, signature: receiptSignature })));
  return { ...response, receipt, receipt_signature: receiptSignature, escrow_ref: escrowRef };
}

// --- The chat supplier -----------------------------------------------------------------------------------------------------------------
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * What the supplier answers to one poll of a job. A job takes its steps in order and repeats the last one.
 *   running               202: the job is not finished
 *   done                  finishes the job if it is not (the Submit on chain), then 200 with the result, the receipt and its signature
 *   failed                the supplier's own failure envelope on a 502; nothing is submitted
 *   gone                  404: the supplier no longer knows the job
 *   proxy                 a 502 HTML page of a proxy, no answer of the supplier's
 *   { fail, submitted }   the supplier's own failure envelope with the reason `fail` on a 502, after its Submit landed when `submitted`, with nothing
 *                         submitted otherwise
 */
export type PollStep = 'running' | 'done' | 'failed' | 'gone' | 'proxy' | { fail: string; submitted: boolean };

interface StubJob { id: string; escrowRef: string; input: string; steps: PollStep[]; finished?: Record<string, unknown> }

export class StubChatSupplier {
  readonly endpoint = LLM_ENDPOINT;
  readonly key = LLM_KEY;
  readonly advertRef = LLM_ADVERT_REF;
  readonly route = '/v1/responses';
  readonly chain: FakeChain;
  /** The text of the answer. */
  answer = ANSWER;
  /** The status of the response: `incomplete` is a model that stopped at its output limit. */
  status = 'completed';
  /** Answer the next N sends with 409 supplier_busy, leaving the escrow Open. */
  busy = 0;
  /** The next sends fail the way a dropped connection does, after the supplier claimed the escrow or before. */
  lose: Array<'after-claim' | 'before-claim'> = [];
  /** Answer the next N sends with 404 escrow_not_found, as a supplier whose view of the chain does not show the Post yet; the escrow stays Open. */
  notFound = 0;
  /** Answer every send with this refusal, before any claim. */
  refuse: { status: number; reason: string } | null = null;
  /** The poll steps of every new job. */
  steps: PollStep[] = ['running', 'done'];
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

  constructor(chain: FakeChain) { this.chain = chain; }

  handle(method: string, path: string, escrowRef: string | null, body: string): Response {
    if (method === 'GET' && path === '/capability') {
      return json(200, {
        capability_id: LLM_CAPABILITY, model: LLM_MODEL, max_output_tokens: 8192, max_processing_ms: WINDOW_MS, price_lovelace: '200000', advert_ref: this.advertRef,
        supplier_pkh: this.key.pkh, pub_key_hex: this.key.pubKeyHex, inference_api: 'responses', upstream_api: 'responses', reasoning_disabled: false, ...this.capabilityOverride,
      });
    }
    if (method === 'GET' && path === '/status') return json(200, { status: this.statusWord, last_seen: '2026-10-15T09:00:00.000Z', active_sessions: 0, max_sessions: 1 });
    if (method === 'POST' && path === this.route) return this.post(escrowRef ?? '', body);
    if (method === 'GET' && path.startsWith(`${this.route}/`)) return this.poll(decodeURIComponent(path.slice(this.route.length + 1)));
    return json(404, { reason: 'no_route', message: `nothing at ${method} ${path}` });
  }

  private post(escrowRef: string, body: string): Response {
    this.sends.push({ escrowRef, body });
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
    if (this.refuse !== null) return json(this.refuse.status, { reason: this.refuse.reason, message: `the supplier refused the job (${this.refuse.reason})` });
    let request: unknown;
    try { request = JSON.parse(body); } catch { return json(400, { reason: 'bad_request', message: 'the body is not JSON' }); }
    // The fleet's chat route takes a Responses request; a hire sends {input} and nothing else (ruling R12), so anything more is refused here.
    const keys = request !== null && typeof request === 'object' && !Array.isArray(request) ? Object.keys(request).sort().join(',') : '';
    if (keys !== 'input' || typeof (request as { input: unknown }).input !== 'string') return json(400, { reason: 'bad_request', message: `the body must be {input} and nothing else, not {${keys}}` });
    // The Claim: the real supplier answers only once its Claim is confirmed. markClaimed throws for an escrow that is not Open.
    this.chain.markClaimed(escrowRef);
    const id = `responses-job-${this.jobs.size + 1}`;
    this.jobs.set(id, { id, escrowRef, input: (request as { input: string }).input, steps: [...this.steps] });
    return json(202, { job_id: id, status: 'accepted', escrow_ref: escrowRef });
  }

  private poll(id: string): Response {
    this.polls += 1;
    const job = this.jobs.get(id);
    if (job === undefined) return json(404, { reason: 'job_not_found', message: `no job found with id ${id}` });
    const step = job.steps.length > 1 ? (job.steps.shift() as PollStep) : job.steps[0];
    const finished = (): Record<string, unknown> => job.finished
      ?? (job.finished = chatFinished(this.key, job.escrowRef, job.id, job.input, this.answer, this.status, this.forge ? FORGER_KEY : this.key, (hash) => this.chain.markSubmitted(job.escrowRef, hash)));
    if (typeof step === 'object') {
      if (step.submitted) finished();
      return json(502, { status: 'failed', reason: step.fail, message: `the job failed (${step.fail})`, escrow_ref: job.escrowRef });
    }
    switch (step) {
      case 'running': return json(202, { status: 'running', escrow_ref: job.escrowRef });
      case 'failed': return json(502, { status: 'failed', reason: 'upstream_failure', message: 'the upstream model did not answer', escrow_ref: job.escrowRef });
      case 'gone': return json(404, { reason: 'job_not_found', message: `no job found with id ${id}` });
      case 'proxy': return new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502, headers: { 'content-type': 'text/html' } });
      case 'done': {
        const body = finished();
        return new Response(this.answerText ? this.answerText(body) : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
  }
}

// --- The marketplace -----------------------------------------------------------------------------------------------------------------
export interface Marketplace {
  /** The time of the FakeChain, in POSIX milliseconds; the tests give the hire the same clock. */
  clock: { now: number };
  chain: FakeChain;
  llm: StubChatSupplier;
  /** What the indexer lists at /suppliers. A test may change it before the run. */
  rows: Array<Record<string, unknown>>;
  /** Every request the fetch got, in order. */
  calls: Array<{ method: string; url: string }>;
  fetchImpl: typeof fetch;
}

/**
 * The FakeChain (the two adverts, the clock at T0), the indexer listing the chat advert free, and the chat supplier behind one fetch. `llmAdvert` replaces
 * the datum of the chat advert, on the chain and in the indexer's row alike.
 */
export function marketplace(opts: Pick<FakeChainOptions, 'floatLovelace' | 'collateralLovelace'> & { llmAdvert?: AdvertDatum } = {}): Marketplace {
  const { llmAdvert = LLM_ADVERT, ...chainOpts } = opts;
  const clock = { now: T0 };
  const chain = new FakeChain({ adverts: { [OCR_ADVERT_REF]: OCR_ADVERT, [LLM_ADVERT_REF]: llmAdvert }, clock: () => clock.now, prefix: PREFIX, ...chainOpts });
  const llm = new StubChatSupplier(chain);
  const rows = [indexerRow(LLM_ADVERT_REF, llmAdvert)];
  const calls: Marketplace['calls'] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ method, url: url.href });
    if (url.origin === INDEXER && method === 'GET' && url.pathname === '/suppliers') return json(200, rows);
    if (url.origin !== llm.endpoint) return json(404, { reason: 'no_route', message: `nothing at ${method} ${url.href}` });
    return llm.handle(method, url.pathname, new Headers(init.headers).get('x-escrow-ref'), typeof init.body === 'string' ? init.body : '');
  }) as typeof fetch;
  return { clock, chain, llm, rows, calls, fetchImpl };
}

/** The FakeChain of `m` behind a plain Chain object whose methods `over` replaces. */
export function chainWith(m: Marketplace, over: Partial<Chain>): Chain {
  const c = m.chain;
  return {
    wallet: () => c.wallet(), postEscrow: (a) => c.postEscrow(a), accept: (r) => c.accept(r), reclaim: (r) => c.reclaim(r),
    escrowState: (r) => c.escrowState(r), onChainReceiptHash: (r) => c.onChainReceiptHash(r), readAdvert: (r) => c.readAdvert(r), ...over,
  };
}
