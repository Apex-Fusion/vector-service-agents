// agents/document-pipeline/src/gaps.ts
// The gaps the manifest states, as sentences, in one place: the manifest takes them from here (src/server.ts) and the spec test holds the page to them
// (test/spec.test.ts), as agent-history's manifest and its report share their blind-spot lines. The manifest is frozen into the advert's hash when the
// advert is posted, so each sentence is a statement made to a hirer about what the service does today and not about what it is meant to do. Each is one line
// of plain text that ends with a full stop.
import { JOB_DEADLINE_MS, LLM_MIN_LEFT_MS, PAGE_MIN_LEFT_MS } from './budget.ts';
import { MAX_PAGES } from './request.ts';

// On the page of the spec since its design, and still true of the built service: the wording is the page's.
export const PAGES_GAP = `v1 reads at most ${MAX_PAGES} pages, renders PDFs at 150 dpi and reads pages one after another, hence the 30 min window.`;
export const OCR_FIRST_PARTY_GAP = 'The OCR hop is first-party only. A third-party OCR path needs the Datalab terms to allow it.';
export const SUPPLIERS_FIRST_PARTY_GAP = 'Every supplier it can hire today is first-party.';
export const RECEIPTS_GAP = 'The Pipeline checks receipts and leaves truth to the model: a summary is as good as the model that wrote it.';
/** The "Economics" lines of the Terms of the page, without their label. */
export const SUBSIDY_GAP = 'At five pages the Pipeline\'s six sub-jobs cost it about 13 net at today\'s fleet price of 0.2 per sub-job (each sub-job: the price, the supplier bond of 1 and about 1 in fees), '
  + 'against a job price of 5; the locks and fees in flight come to about 19, of which the buyer bonds and the lock excess return on Accept. '
  + 'The Foundation carries that gap on purpose while the fee floor stands.';

// Stated by the built service. The deadline cuts the start of a hire and the waits of a hire (src/budget.ts), not an Accept under way (ruling R53).
export const DEADLINE_GAP = `A job has a deadline of its own, ${JOB_DEADLINE_MS} ms after its request arrives: a page is not started with less than ${PAGE_MIN_LEFT_MS / 1000} s left, `
  + `nor the summary or extraction with less than ${LLM_MIN_LEFT_MS / 1000} s. A job that cannot start its next hire in time, or whose hire would have to wait again on its `
  + 'supplier or on the ledger after the deadline, fails with the code deadline and returns no bundle, and the sub-jobs it had already settled stay settled. '
  + 'A hire in its Accept at the deadline is not cut: it finishes late, and the chat job may then answer after the runtime has given up on the job.';
export const SCHEMA_INVALID_GAP = 'An extraction whose answer is not JSON, or does not validate against the schema, still succeeds and settles: '
  + 'the result has schema_valid false and extraction null, and the answer is kept as raw_text.';

/** In the order the manifest states them. */
export const GAPS = [PAGES_GAP, DEADLINE_GAP, OCR_FIRST_PARTY_GAP, SUPPLIERS_FIRST_PARTY_GAP, RECEIPTS_GAP, SCHEMA_INVALID_GAP, SUBSIDY_GAP] as const;
