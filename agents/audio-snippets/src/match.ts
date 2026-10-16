// agents/audio-snippets/src/match.ts
// Where the quotes, the question and the ranges of a request are in the transcript (ruling R-D5), and the cut points of each. Deterministic: the same transcript
// and the same request give the same matches, on every host.
//
// Quotes. The words of the transcript are a stream of tokens (src/normalize.ts; a word such as well-known is two tokens, both of that word). A quote of n tokens
// is compared with every window of the stream of floor(0.7 n) to ceil(1.3 n) tokens (at least one), by the ratio 1 - levenshtein / longer length, over the
// tokens joined by single spaces, in code points. The best window is its match, ties going to the earlier window and then to the shorter; a quote whose best is
// under 0.55 is listed in unmatched with its best score. One match per quote: a quote said twice is matched where it is said first.
// The query. Keyword overlap at segment level (match_method keyword): its content words (its tokens less the stop words) against those of each segment, by
// Jaccard; the segments at or over 0.2, at most 3 by score (ties to the earlier), given in the order they are said, adjacent ones merged into one match whose
// score is the higher. A match runs from the first word of its first segment to the last word of its last, and an end segment that has text but no words gives
// its own start or end. A query that no segment reaches is listed in unmatched with its best score.
// Ranges. Taken as given, with the words inside, score 1.
// Cut points. A match runs from the start of its first word to the end of its last; an end that falls inside a word (a range's can) moves out to that word's
// boundary; then 150 ms of padding on each side, each cut point clamped to [0, duration] (a word or a range past the end gives the end twice). Every number is
// rounded to 3 decimals.
import type { AsrSegment } from './asr.ts';
import { tokensOf } from './normalize.ts';
import type { SnippetsRequest } from './request.ts';

export const PAD_S = 0.15;
export const QUOTE_MIN_SCORE = 0.55;
export const QUERY_MIN_SCORE = 0.2;
export const QUERY_MAX_MATCHES = 3;
/** A small English stop-word list (R-D5): the words a question is made of that say nothing of its subject. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'she',
  'so', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up', 'us', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);
export const round3 = (x: number): number => Math.round(x * 1000) / 1000;

export type TranscriptSegment = AsrSegment;
export interface Match { from: 'quote' | 'query' | 'range'; start_s: number; end_s: number; text: string; score: number }
export interface Unmatched { from: 'quote' | 'query'; text: string; best_score: number }
export interface Found { matches: Match[]; unmatched: Unmatched[]; match_method: 'keyword' | null }
export interface FlatWord { w: string; start: number; end: number; segment: number }
export interface Token { text: string; word: number }

/** The words of the transcript in order, each with the index of its segment. */
export function flatWords(transcript: readonly TranscriptSegment[]): FlatWord[] {
  const words: FlatWord[] = [];
  transcript.forEach((segment, s) => { for (const word of segment.words) words.push({ w: word.w, start: word.start, end: word.end, segment: s }); });
  return words;
}

/** The tokens of the words, in order, each with the index of the word it came from. A word of punctuation alone gives none. */
export function tokenStream(words: readonly FlatWord[]): Token[] {
  const tokens: Token[] = [];
  words.forEach((word, index) => { for (const text of tokensOf(word.w)) tokens.push({ text, word: index }); });
  return tokens;
}

/**
 * The best window of `tokens` for the quote, by the ratio above. For each start the window grows a token at a time, and one column of the edit-distance table is
 * added for each character, so a start costs (quote length) x (characters of its longest window) cells of the table: hundreds of millions in all for a quote of
 * 300 characters over 2000 words, before the pruning below.
 *
 * The pruning cannot change the answer. The edit distance of two texts is at least the difference of their lengths, so a window of c characters scores at most
 * 1 - |m - c| / max(m, c) for a quote of m, computed as the score is, and a window that cannot score more than the best so far is never chosen (a tie keeps the
 * earlier window). So a start none of whose windows can, by their lengths, is skipped, and the windows of a start stop growing once they are longer than the
 * quote and that bound, which only falls as they grow, cannot beat the best.
 */
export function bestQuoteWindow(quote: string, tokens: readonly Token[]): { score: number; from: number; to: number } | null {
  const quoteTokens = tokensOf(quote);
  const q = Array.from(quoteTokens.join(' '));
  const n = quoteTokens.length;
  if (n === 0 || tokens.length === 0) return null;
  // The bounds are worked in integers: 90 x 0.7 is 62.99999999999999 in floating point, which floors to 62 where the bound is 63.
  const lo = Math.max(1, Math.floor((n * 7) / 10));
  const hi = Math.max(lo, Math.ceil((n * 13) / 10));
  const m = q.length;
  const prev = new Uint32Array(m + 1);
  const cur = new Uint32Array(m + 1);
  // The characters of each token, in code points, as the table counts them.
  const sizes = tokens.map((token) => Array.from(token.text).length);
  /** The most a window of `col` characters can score against the quote: its edit distance is at least the difference of the two lengths. */
  const bound = (col: number): number => 1 - Math.abs(m - col) / Math.max(m, col);
  /** Can a window of the start `i` beat `score`, by its length alone? A window longer than the quote only gets a lower bound as it grows. */
  const canBeat = (i: number, score: number): boolean => {
    let col = -1;
    for (let k = 1; k <= hi && i + k <= tokens.length; k += 1) {
      col += 1 + sizes[i + k - 1];
      if (k >= lo && bound(col) > score) return true;
      if (col >= m && bound(col) <= score) return false;
    }
    return false;
  };
  let best: { score: number; from: number; to: number } | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    if (best !== null && !canBeat(i, best.score)) continue;
    for (let r = 0; r <= m; r += 1) prev[r] = r;
    let col = 0;
    for (let k = 1; k <= hi && i + k <= tokens.length; k += 1) {
      const grown = col + (k === 1 ? 0 : 1) + sizes[i + k - 1];
      if (best !== null && grown >= m && bound(grown) <= best.score) break; // no longer window of this start can beat the best
      const piece = (k === 1 ? '' : ' ') + tokens[i + k - 1].text;
      for (const c of piece) {
        col += 1;
        cur[0] = col;
        for (let r = 1; r <= m; r += 1) {
          const sub = prev[r - 1] + (q[r - 1] === c ? 0 : 1);
          const del = prev[r] + 1;
          const ins = cur[r - 1] + 1;
          cur[r] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
        }
        prev.set(cur);
      }
      if (k >= lo) {
        const score = 1 - prev[m] / Math.max(m, col);
        if (best === null || score > best.score) best = { score, from: i, to: i + k - 1 };
      }
    }
  }
  return best;
}

/** The content words of a text: its tokens less the stop words. */
export function contentWords(text: string): Set<string> {
  return new Set(tokensOf(text).filter((token) => !STOP_WORDS.has(token)));
}

/** |a and b| / |a or b|; 0 when either is empty. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both += 1;
  return both / (a.size + b.size - both);
}

/**
 * The cut points of the interval [a, b]: an end inside a word moves out to that word's boundary, then PAD_S on each side, and each cut point is clamped to
 * [0, duration] and rounded. Both ends are clamped on both sides, so the function is total: a word or a range past the end of the media gives the end twice.
 */
export function cutPoints(a: number, b: number, words: readonly FlatWord[], duration: number): { from: number; to: number; start_s: number; end_s: number } {
  let from = a;
  let to = b;
  for (const word of words) {
    if (word.start < from && from < word.end) from = word.start;
    if (word.start < to && to < word.end) to = word.end;
  }
  const within = (x: number): number => round3(Math.min(duration, Math.max(0, x)));
  return { from, to, start_s: within(from - PAD_S), end_s: within(to + PAD_S) };
}

const breathe = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

export async function findMatches(req: Pick<SnippetsRequest, 'query' | 'quotes' | 'ranges'>, transcript: readonly TranscriptSegment[], duration: number): Promise<Found> {
  const words = flatWords(transcript);
  const tokens = tokenStream(words);
  const matches: Match[] = [];
  const unmatched: Unmatched[] = [];

  for (const quote of req.quotes ?? []) {
    const best = bestQuoteWindow(quote, tokens);
    if (best === null || best.score < QUOTE_MIN_SCORE) {
      unmatched.push({ from: 'quote', text: quote, best_score: round3(best === null ? 0 : best.score) });
    } else {
      const first = tokens[best.from].word;
      const last = tokens[best.to].word;
      const cut = cutPoints(words[first].start, words[last].end, words, duration);
      matches.push({ from: 'quote', start_s: cut.start_s, end_s: cut.end_s, text: words.slice(first, last + 1).map((w) => w.w).join(' '), score: round3(best.score) });
    }
    await breathe();
  }

  if (req.query !== undefined) {
    const asked = contentWords(req.query);
    const scored = transcript.map((segment, index) => ({ index, score: jaccard(asked, contentWords(segment.text)) }));
    const top = scored.filter((s) => s.score >= QUERY_MIN_SCORE).sort((x, y) => y.score - x.score || x.index - y.index).slice(0, QUERY_MAX_MATCHES).sort((x, y) => x.index - y.index);
    if (top.length === 0) unmatched.push({ from: 'query', text: req.query, best_score: round3(Math.max(0, ...scored.map((s) => s.score))) });
    const groups: Array<typeof top> = [];
    for (const s of top) {
      const group = groups.at(-1);
      if (group !== undefined && group[group.length - 1].index === s.index - 1) group.push(s); else groups.push([s]);
    }
    for (const group of groups) {
      const segments = group.map((s) => transcript[s.index]);
      // Each end is its own segment's: the first word of the first segment, the last word of the last, or the segment's own time when it has no words.
      const first = segments[0];
      const last = segments[segments.length - 1];
      const a = first.words.length > 0 ? first.words[0].start : first.start;
      const b = last.words.length > 0 ? last.words[last.words.length - 1].end : last.end;
      const cut = cutPoints(a, b, words, duration);
      matches.push({ from: 'query', start_s: cut.start_s, end_s: cut.end_s, text: segments.map((s) => s.text).join(' '), score: round3(Math.max(...group.map((s) => s.score))) });
    }
  }

  for (const range of req.ranges ?? []) {
    const cut = cutPoints(range.start_s, range.end_s, words, duration);
    const text = words.filter((w) => w.start >= cut.from && w.end <= cut.to).map((w) => w.w).join(' ');
    matches.push({ from: 'range', start_s: cut.start_s, end_s: cut.end_s, text, score: 1 });
  }

  return { matches, unmatched, match_method: req.query === undefined ? null : 'keyword' };
}
