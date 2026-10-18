// agents/advocate/src/gaps.ts
// The gaps the manifest states, as sentences, in one place: the manifest takes them from here (src/server.ts) and the spec test holds the page to them
// (test/spec.test.ts), the page with the default model in the fifth. The manifest is frozen into the advert's hash when the advert is posted, so each
// sentence is a statement made to a hirer about what the service does today. Each is one line of plain text that ends with a full stop; its numbers are read
// from the code that holds them to it. The fifth names the model the service calls.
import { JOB_DEADLINE_MS, PAGE_TIMEOUT_MS } from './budget.ts';
import { EXCERPT_CHARS, MIN_PAGE_CHARS } from './html.ts';
import { PAGE_MAX_BYTES } from './pages.ts';
import { MAX_RESULTS } from './search.ts';

export const ONE_SIDED_GAP = 'The brief argues one side only, by design: it leaves out counter-arguments and rebuttals, says so in declared_bias and omitted_by_design, and gives no balanced answer and no fairness guarantee.';
export const QUOTE_GAP = 'A quote in the brief was found in the text the service fetched from the source it names, which shows that the source says it, not that it is right; the receipt commits to the brief, not to the page text.';
export const PAGES_GAP = `Only pages the service could fetch can be cited: a page that redirects, is not HTML or plain text, is over ${PAGE_MAX_BYTES / 1_048_576} MB, has under ${MIN_PAGE_CHARS} characters of text, or does not answer within ${PAGE_TIMEOUT_MS / 1000} s is dropped, and only the first ${EXCERPT_CHARS} characters of a page are read.`;
export const SEARCH_GAP = `The sources are what two Brave Search queries return, at most ${MAX_RESULTS} pages: a subject the search covers thinly gives a thin brief, and a job that gets no usable page or no claim that survives the check fails with search_empty, no_sources or no_supported_claims and returns no brief.`;
export function modelGap(model: string): string {
  return `The model is ${model} through OpenRouter: its claims can be wrong even when their quotes are real, and the check reads quotes, not reasoning.`;
}
export const DEADLINE_GAP = `A job has a deadline of its own, ${JOB_DEADLINE_MS} ms after its request arrives: a job cut at the deadline fails with the code deadline and returns no result.`;

/** In the order the manifest states them. */
export function gapsFor(model: string): readonly string[] {
  return [ONE_SIDED_GAP, QUOTE_GAP, PAGES_GAP, SEARCH_GAP, modelGap(model), DEADLINE_GAP];
}
