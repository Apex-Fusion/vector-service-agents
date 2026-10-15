// agents/document-pipeline/src/result.ts
// What a run gives back. On success the result bundle (PipelineResult), which the server returns as JSON.stringify(result) and the runtime hashes
// into the one receipt it signs: the document's hash, every page text with the sub-job that read it, the answer, the chat sub-job, and the accounting.
// Each sub-job carries the receipt and signature exactly as its supplier gave them and the seven checks the Pipeline ran on them. On failure a
// PipelineError, the orchestrator's own refusal, with a stable code for the server to map; a RequestError of the intake (src/request.ts) is not
// wrapped (ruling R28). The reading of an extraction answer is src/extract.ts.
//
// The codes and their status:
//   400  schema_invalid (the extraction schema is refused before anything is fetched or posted)
//   500  store_write_failed (the stranded store could not be written after money moved; the message names the escrow)
//   503  insufficient_float, ocr_supplier_unavailable, llm_supplier_unavailable (the service cannot take a job now). Nothing was spent, except when
//        llm_supplier_unavailable comes from the second choice of the chat supplier (ruling R35), which is made after the pages are paid
//   422  every other: page_too_large, deadline, llm_incomplete, and for each hop (ocr, llm) <hop>_post_failed, _busy, _refused, _send_lost, _failed,
//        _timeout, _bad_result, _receipt_failed, _receipt_unavailable and _accept_failed. src/hire.ts says when each one is thrown.
import type { FleetVerification, Receipt } from '@vsa/buyer-core';

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
  /** Every Post's lock, and every Post's and confirmed Accept's fee, in lovelace, as decimal text. */
  accounting: { sub_jobs: number; locked_total_lovelace: string; fees_total_lovelace: string };
}

/** The two hops of a run: the OCR of each page, and the one chat job. */
export type Hop = 'ocr' | 'llm';
export type HopFailure =
  | 'post_failed' | 'busy' | 'refused' | 'send_lost' | 'failed' | 'timeout' | 'bad_result' | 'receipt_failed' | 'receipt_unavailable' | 'accept_failed';
export type PipelineErrorCode =
  | 'schema_invalid' | 'insufficient_float' | 'page_too_large' | 'ocr_supplier_unavailable' | 'llm_supplier_unavailable' | 'deadline' | 'llm_incomplete'
  | 'store_write_failed' | `${Hop}_${HopFailure}`;

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

/** The seven checks of verifyFleetReceipt as true (pass) or false, in its order. */
export function verificationOf(checks: FleetVerification['checks']): Record<string, boolean> {
  return Object.fromEntries(Object.entries(checks).map(([check, state]) => [check, state === 'pass']));
}

/** What the hires of one run moved: the lock and the fee of every Post, the fee of every Accept seen confirmed. */
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
