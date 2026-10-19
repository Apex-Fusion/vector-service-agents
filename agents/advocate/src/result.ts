// agents/advocate/src/result.ts
// What a job gives back (rulings R-E7 and R-F9): the brief, which the server answers as JSON.stringify(result) and the runtime hashes into the one receipt it
// signs. Its keys come in this order, at every level: schema, declared_bias {side, statement}, thesis, arguments [{claim, support, sources [{title, url,
// retrieved_at, quote}]}], sources, omitted_by_design, search, model, inference {path, fallback_from, sub_job {capability_id, advert_ref, escrow_ref,
// supplier_pkh, receipt, receipt_signature, verification}, accepted}. The bias is declared in every brief, whatever its side or its arguments: the side as the
// request gave it, and the two fixed statements of src/prompt.ts. The search and the model that made the brief are named in it, the model with its path
// ("<model> via the Vector marketplace" or "<model> via OpenRouter"), and `inference` says which path the call took, why it fell back, and carries the chat
// supplier's sub-job, its receipt and signature as the supplier gave them and the seven checks the service ran, in the key order of the Document Pipeline's
// sub-jobs, so that a hirer checks it the same way. The schema stays vector.advocate.brief.v1: no brief has been served.
import type { HireRecord } from '@vsa/hire-kit';
import type { Argument, Checked, Source } from './check.ts';
import type { Inference, InferencePath } from './inference.ts';
import { modelLabel } from './model.ts';
import { DECLARED_BIAS_STATEMENT, OMITTED_BY_DESIGN } from './prompt.ts';
import type { AdvocateRequest } from './request.ts';

export const SCHEMA = 'vector.advocate.brief.v1';
export const SEARCH_NAME = 'Brave Search API';

export interface AdvocateResult {
  schema: typeof SCHEMA;
  declared_bias: { side: string; statement: string };
  thesis: string;
  arguments: Argument[];
  sources: Source[];
  omitted_by_design: string;
  search: string;
  /** "<model> via the Vector marketplace" or "<model> via OpenRouter". */
  model: string;
  inference: { path: InferencePath; fallback_from: string | null; sub_job: HireRecord | null; accepted: 'confirmed' | 'pending' | null };
}

/** A source with its own keys only, in their order. */
const sourceOf = (s: Source): Source => ({ title: s.title, url: s.url, retrieved_at: s.retrieved_at, quote: s.quote });
/** A sub-job with its own keys only, in the order of the Document Pipeline's sub-jobs; the receipt and its checks as they are. */
const subJobOf = (r: HireRecord): HireRecord => ({
  capability_id: r.capability_id, advert_ref: r.advert_ref, escrow_ref: r.escrow_ref, supplier_pkh: r.supplier_pkh, receipt: r.receipt, receipt_signature: r.receipt_signature,
  verification: r.verification,
});

/** The brief of a request: its thesis and what survived the check, every key in its place, the model and the path of `inference`. */
export function buildResult(req: AdvocateRequest, thesis: string, checked: Checked, inference: Inference): AdvocateResult {
  return {
    schema: SCHEMA,
    declared_bias: { side: req.side, statement: DECLARED_BIAS_STATEMENT },
    thesis,
    arguments: checked.arguments.map((a) => ({ claim: a.claim, support: a.support, sources: a.sources.map(sourceOf) })),
    sources: checked.sources.map(sourceOf),
    omitted_by_design: OMITTED_BY_DESIGN,
    search: SEARCH_NAME,
    model: modelLabel(inference.model, inference.path),
    inference: {
      path: inference.path, fallback_from: inference.fallbackFrom, sub_job: inference.subJob === null ? null : subJobOf(inference.subJob), accepted: inference.accepted,
    },
  };
}

/** The body of the answer: exactly the bytes the runtime hashes. */
export const serializeResult = (r: AdvocateResult): string => JSON.stringify(r);
