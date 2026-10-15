// agents/document-pipeline/src/result.ts
// What a run gives back. On success the result bundle (PipelineResult), which the server returns as JSON.stringify(result) and the runtime hashes
// into the one receipt it signs: the document's hash, every page text with the sub-job that read it, the answer, the chat sub-job, and the accounting.
// Each sub-job carries the receipt and signature exactly as its supplier gave them and the seven checks the Pipeline ran on them. On failure a
// PipelineError, the orchestrator's own refusal, with a stable code for the server to map; a RequestError of the intake (src/request.ts) is not
// wrapped (ruling R28).
//
// The codes. 503 for the three that say the service cannot take a job now: insufficient_float, ocr_supplier_unavailable, llm_supplier_unavailable.
// 422 for every other: schema_invalid and page_too_large (refused before anything is posted), deadline, llm_incomplete, and for each hop (ocr, llm)
// <hop>_post_failed, _busy, _refused, _send_lost, _failed, _timeout, _bad_result, _receipt_failed and _accept_failed. src/hire.ts says when each one is
// thrown.
//
// Also here, the reading of the chat answer of an `extract` job: the request's schema is compiled before anything is posted (ruling R27), and an answer
// that is not JSON, or does not validate, is kept as raw_text with schema_valid false: the job still succeeds, the supplier delivered.
import Ajv from 'ajv';
import type { FleetVerification, Receipt } from '@vsa/buyer-core';
import type { Task } from './request.ts';

export const RESULT_SCHEMA = 'vector.document-pipeline.result.v1';

/** One hire: the advert and escrow it ran under, the receipt and its signature as the supplier gave them, and each check of verifyFleetReceipt. */
export interface SubJob {
  capability_id: string; advert_ref: string; escrow_ref: string; supplier_pkh: string;
  receipt: Receipt; receipt_signature: string; verification: Record<string, boolean>;
}
export type PipelineAnswer = { summary: string } | { extraction: unknown; schema_valid: boolean; raw_text?: string };
export interface PipelineResult {
  schema: 'vector.document-pipeline.result.v1';
  /** `pages` is the page count of the whole document; the `pages` below are the ones read, at most max_pages. */
  source: { sha256: string; bytes: number; mime: string; pages: number };
  pages: Array<{ index: number; text: string; sub_job: SubJob }>;
  result: PipelineAnswer;
  llm_sub_job: SubJob;
  /** Every Post's lock, and every Post's and Accept's fee, in lovelace, as decimal text. */
  accounting: { sub_jobs: number; locked_total_lovelace: string; fees_total_lovelace: string };
}

/** The two hops of a run: the OCR of each page, and the one chat job. */
export type Hop = 'ocr' | 'llm';
export type HopFailure = 'post_failed' | 'busy' | 'refused' | 'send_lost' | 'failed' | 'timeout' | 'bad_result' | 'receipt_failed' | 'accept_failed';
export type PipelineErrorCode =
  | 'schema_invalid' | 'insufficient_float' | 'page_too_large' | 'ocr_supplier_unavailable' | 'llm_supplier_unavailable' | 'deadline' | 'llm_incomplete'
  | `${Hop}_${HopFailure}`;

/** A run the orchestrator gave up on: a stable `code` to branch on, a `message` for a person, the HTTP `status` the server answers with (422 unless given). */
export class PipelineError extends Error {
  readonly code: PipelineErrorCode;
  readonly status: number;
  constructor(code: PipelineErrorCode, message: string, status = 422) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.status = status;
  }
}

/** The message of an error, cut short: errors from the chain and the clients go into a PipelineError's message, which the caller reads. */
export function errorText(err: unknown, max = 300): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** The seven checks of verifyFleetReceipt as true (pass) or false, in its order. */
export function verificationOf(checks: FleetVerification['checks']): Record<string, boolean> {
  return Object.fromEntries(Object.entries(checks).map(([check, state]) => [check, state === 'pass']));
}

/** What the hires of one run moved: the lock and the fee of every Post, the fee of every Accept. */
export class Accounting {
  #subJobs = 0;
  #locked = 0n;
  #fees = 0n;
  posted(post: { lockLovelace: bigint; feeLovelace: bigint }): void {
    this.#subJobs += 1;
    this.#locked += post.lockLovelace;
    this.#fees += post.feeLovelace;
  }
  accepted(accept: { feeLovelace: bigint }): void {
    this.#fees += accept.feeLovelace;
  }
  summary(): PipelineResult['accounting'] {
    return { sub_jobs: this.#subJobs, locked_total_lovelace: String(this.#locked), fees_total_lovelace: String(this.#fees) };
  }
}

/** Whether a value is valid against the schema of an extract request. */
export type ExtractionCheck = (value: unknown) => boolean;

/**
 * Compiles the schema of an extract request, before anything is fetched or posted (ruling R27): Ajv's default draft-07, stopping at the first error
 * (allErrors false), in strict mode, so a misspelt keyword is refused here instead of quietly constraining nothing. `format` is an annotation and is
 * not checked: no format is defined, and a schema that uses one is not refused for it. A remote $ref is never fetched; it does not resolve, and the
 * schema is refused. Ajv writes no warning to the console. Throws schema_invalid.
 */
export function compileExtractionSchema(schema: Record<string, unknown> | undefined): ExtractionCheck {
  if (schema === undefined) throw new PipelineError('schema_invalid', 'Task "extract" needs a schema; nothing was spent.');
  try {
    const validate = new Ajv({ allErrors: false, validateFormats: false, logger: false }).compile(schema);
    return (value) => validate(value) === true;
  } catch (err) {
    throw new PipelineError('schema_invalid', `The schema cannot be used (${errorText(err)}): it must be a JSON Schema of draft-07 that compiles in strict mode, with no remote references. Nothing was spent.`);
  }
}

// A fenced block, with or without a language tag: its content, as a model writes JSON around prose.
const FENCED = /```[A-Za-z0-9_-]*\s*([\s\S]*?)\s*```/;

/** The JSON value of an answer: the answer itself when it is JSON, else the content of its first fenced block when that is JSON, else none. */
function jsonOf(text: string): { value: unknown } | null {
  for (const candidate of [text.trim(), FENCED.exec(text)?.[1]]) {
    if (candidate === undefined || candidate === '') continue;
    try { return { value: JSON.parse(candidate) as unknown }; } catch { /* the next candidate */ }
  }
  return null;
}

/**
 * The `result` of a run from the chat answer. A summary is the answer text. An extraction is the answer's JSON value when it validates against the
 * schema; otherwise (not JSON, or JSON the schema refuses) it is null with schema_valid false and the answer kept as raw_text, exactly as received.
 */
export function answerResult(task: Task, text: string, check: ExtractionCheck | null): PipelineAnswer {
  if (task === 'summary') return { summary: text };
  if (check === null) throw new Error('An extraction is read with the check of its schema.');
  const parsed = jsonOf(text);
  if (parsed !== null && check(parsed.value)) return { extraction: parsed.value, schema_valid: true };
  return { extraction: null, schema_valid: false, raw_text: text };
}
