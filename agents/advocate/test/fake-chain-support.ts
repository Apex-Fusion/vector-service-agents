// agents/advocate/test/fake-chain-support.ts
// The Vector marketplace the tests of the inference run against, all in memory, as the Document Pipeline's tests have theirs (agents/document-pipeline/test/
// stub-suppliers.ts): a FakeChain of @vsa/buyer-core that holds the advert of one chat supplier, an indexer that lists it, and that supplier speaking the
// fleet's Responses protocol through the routes of test/fake-fetch.ts. The supplier plays its own part of the escrow on the FakeChain, the Claim when it
// takes a job (markClaimed) and the Submit when it finishes one (markSubmitted, with the hash of the receipt it signed), and signs its receipts with the real
// commitment functions and a key made from fixed bytes: Ed25519 signs deterministically, so every run gives the same receipt, and the golden sub-job of
// test/golden.ts is pinned byte for byte. It can be told to misbehave the ways the tests of the fallback rule need: answer busy, answer that it does not see
// the escrow, lose a send before or after its Claim, refuse, fail the job, forget the job, fail its own Submit, sign with another key, sign token counts that
// are not counts, answer with a body the service cannot read, or an answer that is cut or is no brief. No test touches the network, DNS or a chain: the endpoint of the supplier is an https IP literal of the documentation range 203.0.113.0/24, which
// safeFetch takes as public without a host lookup, and the indexer is read with the injected fetch as it is.
import { createHash, createPrivateKey, createPublicKey, sign as ed25519Sign } from 'node:crypto';
import { FakeChain, responsesPromptHash, responsesResponseHash } from '@vsa/buyer-core';
import type { FakeChainOptions } from '@vsa/buyer-core';
import { blake2b224Hex, canonicalize, formatOutRef, sha256Utf8Hex } from '@vsa/vector-read';
import type { AdvertDatum } from '@vsa/vector-read';
import type { Route } from './fake-fetch.ts';

export const INDEXER = 'https://indexer.test';
export const CHAT_ENDPOINT = 'https://203.0.113.31';
export const CHAT_ADVERT_REF = `${'b2'.repeat(32)}#1`;
export const CHAT_CAPABILITY = 'llm.text.generate.v1';
export const CHAT_MODEL = 'deepseek/deepseek-v4-flash';
/** The window of the flash adverts on the indexer of 2026-10-19: deliver_by is posted_at + 3600000 + 180000. */
export const WINDOW_MS = 3_600_000;
/** The tokens the supplier's receipt names, the same as the usage of the OpenRouter answer of the golden job. */
export const RECEIPT_TOKENS = { prompt_tokens: 4321, completion_tokens: 512 };
const PREFIX = 'advocate-test/';
/** The escrow the n-th Post opens (from 1): FakeChain's refs are sha256(prefix + n)#0. */
export const escrowNo = (n: number): string => formatOutRef(sha256Utf8Hex(`${PREFIX}${n}`), 0);

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
export const CHAT_KEY = stubKey('advocate test: the chat supplier');
/** Not the key of the advert: what a forged receipt is signed with. */
export const FORGER_KEY = stubKey('advocate test: somebody else');

// --- The advert and the indexer --------------------------------------------------------------------------------------------------------
export function chatAdvert(over: Partial<AdvertDatum> = {}): AdvertDatum {
  return {
    supplier_pkh: CHAT_KEY.pkh, capability_id: CHAT_CAPABILITY, model: CHAT_MODEL, max_output_tokens: 8192, max_processing_ms: WINDOW_MS,
    price_lovelace: 200_000n, supplier_bond_lovelace: 1_000_000n, buyer_bond_lovelace: 1_000_000n, endpoint_url: CHAT_ENDPOINT,
    detail_uri: '', detail_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', advertised_at: 1_786_529_315_923, status: 'Active', ...over,
  };
}
/** A row of the indexer's /suppliers list for an advert, as the live indexer writes it: amounts as strings, the advert's UTxO as `utxo_ref`. */
export function indexerRow(ref: string, a: AdvertDatum, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    utxo_ref: ref, supplier_pkh: a.supplier_pkh, capability_id: a.capability_id, model: a.model, max_output_tokens: a.max_output_tokens,
    max_processing_ms: a.max_processing_ms, price_lovelace: String(a.price_lovelace), supplier_bond_lovelace: String(a.supplier_bond_lovelace),
    buyer_bond_lovelace: String(a.buyer_bond_lovelace), endpoint_url: a.endpoint_url, detail_uri: a.detail_uri, detail_hash: a.detail_hash,
    advertised_at: a.advertised_at, status: 'free', advert_status: 'Active', current_escrow_ref: null, last_seen_iso: '2026-10-19T08:00:00.000Z',
    created_slot: 30_043_723, ...over,
  };
}

// --- The supplier -----------------------------------------------------------------------------------------------------------------------
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/**
 * What the supplier answers to one poll of a job; a job takes its steps in order and repeats the last one.
 *   running   202: the job is not finished
 *   done      finishes the job if it is not (the Submit on chain), then 200 with the response, the receipt and its signature
 *   failed    the supplier's own failure envelope on a 502; nothing is submitted
 *   gone      404 job_not_found in the supplier's own envelope: it no longer knows the job, as after a restart; nothing is submitted
 *   { fail, submitted }  the supplier's own failure envelope with the reason `fail`, after its Submit landed when `submitted`
 */
export type PollStep = 'running' | 'done' | 'failed' | 'gone' | { fail: string; submitted: boolean };
interface Job { id: string; escrowRef: string; input: string; steps: PollStep[]; finished?: Record<string, unknown> }

/** The chat supplier of the advert, on the Responses API of the fleet. */
export class ChatSupplier {
  /** Answer the next N sends with 409 supplier_busy, leaving the escrow Open. */
  busy = 0;
  /** Answer the next N sends with 404 escrow_not_found, as a supplier whose view of the chain does not show the Post yet; the escrow stays Open. */
  notFound = 0;
  /** The next sends fail the way a dropped connection does, after the supplier claimed the escrow or before. */
  lose: Array<'after-claim' | 'before-claim'> = [];
  /** Answer every send with this refusal, before any claim; `message` replaces its words. */
  refuse: { status: number; reason: string; message?: string } | null = null;
  /** The poll steps of every new job. */
  steps: PollStep[] = ['running', 'done'];
  /** Sign receipts with FORGER_KEY: the hash on chain is still the one of what was signed. */
  forge = false;
  /** The token counts its receipts sign: RECEIPT_TOKENS unless a test sets others, which need not be counts at all, since no check of a receipt reads them. */
  tokens: { prompt_tokens: unknown; completion_tokens: unknown } = { ...RECEIPT_TOKENS };
  /** The text of the answer, and the status of the response: `incomplete` is a model that stopped at its output limit. */
  answer = '';
  status = 'completed';
  /** The body a finished poll answers with, made from the finished body after it was signed and submitted. JSON.stringify unless set. */
  answerText: ((finished: Record<string, unknown>) => string) | null = null;
  /** The status word its /status answers with. */
  statusWord = 'free';
  /** Called with each send as it comes, before it is answered: the tests hang up a caller here. */
  onSend: (() => void) | null = null;
  /** Every send, with the X-Escrow-Ref header and the body exactly as received. */
  readonly sends: Array<{ escrowRef: string; body: string }> = [];
  readonly jobs = new Map<string, Job>();
  polls = 0;

  constructor(readonly chain: FakeChain, readonly endpoint = CHAT_ENDPOINT, readonly advertRef = CHAT_ADVERT_REF, readonly key: StubKey = CHAT_KEY) {}

  /** The routes of this supplier's endpoint: /capability, /status, the send and the poll of /v1/responses. */
  routes(): Route[] {
    const mine = (url: URL): boolean => url.origin === this.endpoint;
    return [
      { match: (url, init) => mine(url) && (init?.method ?? 'GET') === 'GET' && url.pathname === '/capability', respond: () => json(200, this.capability()) },
      { match: (url, init) => mine(url) && (init?.method ?? 'GET') === 'GET' && url.pathname === '/status', respond: () => json(200, { status: this.statusWord, last_seen: '2026-10-19T08:00:00.000Z', active_sessions: 0, max_sessions: 1 }) },
      { match: (url, init) => mine(url) && init?.method === 'POST' && url.pathname === '/v1/responses', respond: (_url, init) => this.send(new Headers(init?.headers).get('x-escrow-ref') ?? '', String(init?.body ?? '')) },
      { match: (url, init) => mine(url) && (init?.method ?? 'GET') === 'GET' && url.pathname.startsWith('/v1/responses/'), respond: (url) => this.poll(decodeURIComponent(url.pathname.slice('/v1/responses/'.length))) },
    ];
  }

  capability(): Record<string, unknown> {
    return {
      capability_id: CHAT_CAPABILITY, model: CHAT_MODEL, max_output_tokens: 8192, max_processing_ms: WINDOW_MS, price_lovelace: '200000', advert_ref: this.advertRef,
      supplier_pkh: this.key.pkh, pub_key_hex: this.key.pubKeyHex, inference_api: 'responses', upstream_api: 'responses', reasoning_disabled: false,
    };
  }

  private send(escrowRef: string, body: string): Response {
    this.sends.push({ escrowRef, body });
    this.onSend?.();
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
    if (this.refuse !== null) return json(this.refuse.status, { reason: this.refuse.reason, message: this.refuse.message ?? `the supplier refused the job (${this.refuse.reason})` });
    const request = JSON.parse(body) as Record<string, unknown>;
    if (Object.keys(request).join(',') !== 'input' || typeof request.input !== 'string') return json(400, { reason: 'bad_request', message: 'the body must be {input} and nothing else' });
    // The Claim: the real supplier answers only once its Claim is confirmed. markClaimed throws for an escrow that is not Open.
    this.chain.markClaimed(escrowRef);
    const id = `responses-job-${this.jobs.size + 1}`;
    this.jobs.set(id, { id, escrowRef, input: request.input, steps: [...this.steps] });
    return json(202, { job_id: id, status: 'accepted', escrow_ref: escrowRef });
  }

  private poll(id: string): Response {
    this.polls += 1;
    const job = this.jobs.get(id);
    if (job === undefined) return json(404, { reason: 'job_not_found', message: `no job found with id ${id}` });
    const step = job.steps.length > 1 ? (job.steps.shift() as PollStep) : job.steps[0];
    const finished = (): Record<string, unknown> => job.finished ?? (job.finished = this.finish(job));
    if (typeof step === 'object') {
      if (step.submitted) finished();
      return json(502, { status: 'failed', reason: step.fail, message: `the job failed (${step.fail})`, escrow_ref: job.escrowRef });
    }
    if (step === 'running') return json(202, { status: 'running', escrow_ref: job.escrowRef });
    if (step === 'failed') return json(502, { status: 'failed', reason: 'upstream_failure', message: 'the upstream model did not answer', escrow_ref: job.escrowRef });
    if (step === 'gone') return json(404, { reason: 'job_not_found', message: `no job found with id ${id}` });
    const done = finished();
    return new Response(this.answerText ? this.answerText(done) : JSON.stringify(done), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  /** The Responses object of a finished job with the receipt fields, the way a fleet supplier builds it, after its Submit on chain. */
  private finish(job: Job): Record<string, unknown> {
    const response = {
      id: `resp_${job.id}`, object: 'response', status: this.status, incomplete_details: this.status === 'incomplete' ? { reason: 'max_output_tokens' } : null, model: CHAT_MODEL,
      output: [{ type: 'message', id: `msg_${job.id}`, role: 'assistant', status: this.status, content: [{ type: 'output_text', text: this.answer, annotations: [] }] }],
      usage: { input_tokens: RECEIPT_TOKENS.prompt_tokens, output_tokens: RECEIPT_TOKENS.completion_tokens, total_tokens: RECEIPT_TOKENS.prompt_tokens + RECEIPT_TOKENS.completion_tokens },
    };
    const receipt = {
      escrow_ref: job.escrowRef, supplier_pkh: this.key.pkh, prompt_hash: responsesPromptHash({ input: job.input }), response_hash: responsesResponseHash(response),
      model: CHAT_MODEL, prompt_tokens: this.tokens.prompt_tokens, completion_tokens: this.tokens.completion_tokens, wallclock_ms: 1830,
    };
    const receiptSignature = (this.forge ? FORGER_KEY : this.key).sign(receipt);
    this.chain.markSubmitted(job.escrowRef, sha256Utf8Hex(canonicalize({ receipt, signature: receiptSignature })));
    return { ...response, receipt, receipt_signature: receiptSignature, escrow_ref: job.escrowRef };
  }
}

// --- The marketplace -----------------------------------------------------------------------------------------------------------------
export interface Market {
  /** The time of the FakeChain, in POSIX milliseconds; the tests give the run the same clock. */
  clock: { now: number };
  chain: FakeChain;
  supplier: ChatSupplier;
  /** What the indexer lists at /suppliers. A test may change it before the run. */
  rows: Array<Record<string, unknown>>;
  /** The routes of the indexer and of the supplier, for the fetch of the test. */
  routes: Route[];
  /** Every pause the hire asked for; each moves the clock on by its length. */
  sleeps: number[];
  sleep: (ms: number) => Promise<void>;
}

/**
 * The FakeChain (the advert of the chat supplier, the clock at `t0`), the indexer listing it free, and the supplier, answering the golden brief `answer`.
 * `advert` replaces the datum of the advert, on the chain and in the indexer's row alike.
 */
export function market(opts: Pick<FakeChainOptions, 'floatLovelace' | 'collateralLovelace'> & { t0: number; answer: string; advert?: AdvertDatum }): Market {
  const { t0, answer, advert = chatAdvert(), ...chainOpts } = opts;
  const clock = { now: t0 };
  const chain = new FakeChain({ adverts: { [CHAT_ADVERT_REF]: advert }, clock: () => clock.now, prefix: PREFIX, ...chainOpts });
  const supplier = new ChatSupplier(chain);
  supplier.answer = answer;
  const rows = [indexerRow(CHAT_ADVERT_REF, advert)];
  const sleeps: number[] = [];
  const routes: Route[] = [
    { match: (url, init) => url.origin === INDEXER && (init?.method ?? 'GET') === 'GET' && url.pathname === '/suppliers', respond: () => json(200, rows) },
    ...supplier.routes(),
  ];
  return { clock, chain, supplier, rows, routes, sleeps, sleep: async (ms) => { sleeps.push(ms); clock.now += ms; } };
}
