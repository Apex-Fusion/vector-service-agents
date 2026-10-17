// agents/advocate/src/check.ts
// The post-check (ruling R-E6), the rule that makes a brief something a hirer can test: a quote the model gives survives only when the source it names is a
// page the service kept, and the quote, normalised as src/normalize.ts does it, is 20 to 300 characters long and found in the normalised excerpt of that
// page. A quote that fails is dropped; an argument left with no quote is dropped; the thesis stays as the model wrote it. A brief with no argument left is
// AdvocateError no_supported_claims (502): the thesis never answers alone. The check reads quotes and nothing else: a claim can still be wrong when its
// quote is real (the model gap of the manifest says so).
//
// A source in the brief carries the title, the URL and the time of retrieval of its page and the quote as the model wrote it, which the normalised page
// text holds. The brief's own list of sources is every surviving source once, by its URL and its normalised quote, in the order of first use: a quote cited
// by two arguments is in both, and listed once.
import { AdvocateError } from './errors.ts';
import type { ModelBrief } from './model.ts';
import { normalizeText } from './normalize.ts';
import type { Page } from './pages.ts';
import { QUOTE_MAX_CHARS, QUOTE_MIN_CHARS } from './prompt.ts';

export interface Source { title: string; url: string; retrieved_at: string; quote: string }
export interface Argument { claim: string; support: string; sources: Source[] }
export interface Checked { arguments: Argument[]; sources: Source[]; droppedQuotes: number; droppedArguments: number }

/** Is `normal`, a normalised quote, within the bounds (counted in characters, as Unicode code points) and found in `text`, a normalised excerpt? */
function foundIn(normal: string, text: string): boolean {
  const length = [...normal].length;
  return length >= QUOTE_MIN_CHARS && length <= QUOTE_MAX_CHARS && text.includes(normal);
}

/** Does `excerpt` hold `quote`, both normalised, and is the quote within the bounds? */
export function quoteFound(quote: string, excerpt: string): boolean {
  return foundIn(normalizeText(quote), normalizeText(excerpt));
}

/** The arguments and sources of `brief` that survive the check against `pages`, with the counts of what was dropped; no_supported_claims when none survives. */
export function checkCitations(brief: ModelBrief, pages: readonly Page[]): Checked {
  const byNumber = new Map(pages.map((page) => [page.n, { page, text: normalizeText(page.excerpt) }]));
  const kept: Argument[] = [];
  const sources: Source[] = [];
  const listed = new Set<string>();
  let droppedQuotes = 0;
  let droppedArguments = 0;
  for (const argument of brief.arguments) {
    const cited: Source[] = [];
    for (const { n, quote } of argument.sources) {
      const source = byNumber.get(n);
      const normal = normalizeText(quote);
      if (source === undefined || !foundIn(normal, source.text)) {
        droppedQuotes += 1;
        continue;
      }
      const found: Source = { title: source.page.title, url: source.page.url, retrieved_at: source.page.retrieved_at, quote };
      cited.push(found);
      const key = JSON.stringify([found.url, normal]);
      if (!listed.has(key)) {
        listed.add(key);
        sources.push(found);
      }
    }
    if (cited.length === 0) {
      droppedArguments += 1;
      continue;
    }
    kept.push({ claim: argument.claim, support: argument.support, sources: cited });
  }
  if (kept.length === 0) {
    throw new AdvocateError('no_supported_claims', `no argument of the brief kept a quote found in the page it names: ${droppedQuotes} quotes and ${droppedArguments} arguments dropped`);
  }
  return { arguments: kept, sources, droppedQuotes, droppedArguments };
}
