// agents/advocate/src/check.ts
// The post-check (rulings R-E6, R-E35 and R-E36), the rule that makes a brief something a hirer can test: a quote the model gives survives only when the
// source it names is a page the service kept, and the quote, normalised as src/normalize.ts does it, is 20 to 300 characters long and found in the normalised
// excerpt of that page. A quote that fails is dropped; an argument left with no quote is dropped; the thesis stays as the model wrote it. A brief with no
// argument left is AdvocateError no_supported_claims (502): the thesis never answers alone. The check reads quotes and nothing else: a claim can still be
// wrong when its quote is real (the model gap of the manifest says so).
//
// A source in the brief carries the title, the URL and the time of retrieval of its page, and its quote in the words of the page (ruling R-E36): the part of
// the excerpt that the normalised quote was found in, from the first character the match came from to the last, as the page writes it, whatever case, marks
// or forms the model gave the quote. So the brief shows only text its page holds. An argument lists a source once: a citation of a page and a quote it already
// has (the same page and the same normalised quote, which give the same words) is not counted again (ruling R-E35). The brief's own list of sources is every
// surviving source once, by its URL and its quote, in the order of first use: a quote cited by two arguments is in both, and listed once.
import { AdvocateError } from './errors.ts';
import type { ModelBrief } from './model.ts';
import { normalizeMapped, normalizeText } from './normalize.ts';
import type { NormalizedText } from './normalize.ts';
import type { Page } from './pages.ts';
import { QUOTE_MAX_CHARS, QUOTE_MIN_CHARS } from './prompt.ts';

export interface Source { title: string; url: string; retrieved_at: string; quote: string }
export interface Argument { claim: string; support: string; sources: Source[] }
export interface Checked { arguments: Argument[]; sources: Source[]; droppedQuotes: number; droppedArguments: number }

/**
 * The words of `excerpt` that `normal`, a normalised quote, stands for: null when `normal` is not within the bounds (counted in characters, as Unicode code
 * points) or not found in `read`, the normalised excerpt; else the part of the excerpt that its first match came from, from its first character to its last.
 */
function wordsOf(normal: string, excerpt: string, read: NormalizedText): string | null {
  const length = [...normal].length;
  if (length < QUOTE_MIN_CHARS || length > QUOTE_MAX_CHARS) return null;
  const at = read.text.indexOf(normal);
  return at === -1 ? null : excerpt.slice(read.from[at], read.to[at + normal.length - 1]);
}

/**
 * Does `excerpt` hold `quote`, both normalised, and is the quote within the bounds? It returns the answer of the rule by which checkCitations keeps a quote,
 * yes or no, and no text: the text a brief gives for a quote that is kept is the words of its page, which checkCitations returns.
 */
export function quoteFound(quote: string, excerpt: string): boolean {
  return wordsOf(normalizeText(quote), excerpt, normalizeMapped(excerpt)) !== null;
}

/**
 * The arguments and the sources of `brief` that survive the check against `pages`, with the counts of what was dropped; no_supported_claims when none
 * survives. It returns each source with its quote in the words of its page, the part of the excerpt the normalised quote was found in (R-E36); each argument
 * with a page and a quote once (R-E35); and the list of sources unique by URL and quote, in the order of first use.
 */
export function checkCitations(brief: ModelBrief, pages: readonly Page[]): Checked {
  // Each page is read by the rule once, at its first citation.
  const byNumber = new Map(pages.map((page): [number, { page: Page; read?: NormalizedText }] => [page.n, { page }]));
  const kept: Argument[] = [];
  const sources: Source[] = [];
  const listed = new Set<string>();
  let droppedQuotes = 0;
  let droppedArguments = 0;
  for (const argument of brief.arguments) {
    const cited: Source[] = [];
    const own = new Set<string>();
    for (const { n, quote } of argument.sources) {
      const source = byNumber.get(n);
      if (source === undefined) {
        droppedQuotes += 1;
        continue;
      }
      source.read ??= normalizeMapped(source.page.excerpt);
      const words = wordsOf(normalizeText(quote), source.page.excerpt, source.read);
      if (words === null) {
        droppedQuotes += 1;
        continue;
      }
      const key = JSON.stringify([source.page.url, words]);
      // A page and a quote the argument cites already: one source of it, whatever the form the model gave the quote again in (R-E35).
      if (own.has(key)) continue;
      own.add(key);
      const found: Source = { title: source.page.title, url: source.page.url, retrieved_at: source.page.retrieved_at, quote: words };
      cited.push(found);
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
