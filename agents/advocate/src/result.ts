// agents/advocate/src/result.ts
// What a job gives back (ruling R-E7): the brief, which the server answers as JSON.stringify(result) and the runtime hashes into the one receipt it signs.
// Its keys come in this order, at every level: schema, declared_bias {side, statement}, thesis, arguments [{claim, support, sources [{title, url,
// retrieved_at, quote}]}], sources, omitted_by_design, search, model. The bias is declared in every brief, whatever its side or its arguments: the side as
// the request gave it, and the two fixed statements of src/prompt.ts. The search and the model that made the brief are named in it.
import type { Argument, Checked, Source } from './check.ts';
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
  /** "<OPENROUTER_MODEL> via OpenRouter". */
  model: string;
}

/** A source with its own keys only, in their order. */
const sourceOf = (s: Source): Source => ({ title: s.title, url: s.url, retrieved_at: s.retrieved_at, quote: s.quote });

/** The brief of a request: its thesis and what survived the check, every key in its place; `model` is the id of OpenRouter the job called. */
export function buildResult(req: AdvocateRequest, thesis: string, checked: Checked, model: string): AdvocateResult {
  return {
    schema: SCHEMA,
    declared_bias: { side: req.side, statement: DECLARED_BIAS_STATEMENT },
    thesis,
    arguments: checked.arguments.map((a) => ({ claim: a.claim, support: a.support, sources: a.sources.map(sourceOf) })),
    sources: checked.sources.map(sourceOf),
    omitted_by_design: OMITTED_BY_DESIGN,
    search: SEARCH_NAME,
    model: modelLabel(model),
  };
}

/** The body of the answer: exactly the bytes the runtime hashes. */
export const serializeResult = (r: AdvocateResult): string => JSON.stringify(r);
