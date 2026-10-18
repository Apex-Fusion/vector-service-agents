// agents/advocate/src/normalize.ts
// A quote and the text of its page as the check compares them (rulings R-E6 and R-E29): Unicode NFKC, lower case, the left single quote U+2018 and the
// apostrophes U+2019 and U+02BC made U+0027, the double quotes U+201C and U+201D made U+0022, the dashes U+2013 and U+2014 made U+002D, every run of white space
// (a line break among it) made one space, and the ends trimmed. A model that copies a sentence may write its marks the plain way or the typographic way; both
// sides are read the same way, so a quote is found in its page when, read so, it is a part of the page's text.
//
// normalizeMapped reads a text by the same rule and says where each character of what it gives came from, so that the check can give a quote back in the words
// of its page (ruling R-E36). It reads the text a word at a time, a word being what lies between two runs of white space, for the rule carries nothing across
// white space: NFKC composes no character with a space, and lower case looks past a run of white space for the letter after a capital sigma only through the
// byte order mark U+FEFF, which is white space to the rule and so stays inside its word. In a word each character of the result comes from a cluster of the
// text (a letter and its accents, as Intl.Segmenter cuts them): the one at its own place when the clusters read one by one give as many characters as the word
// read whole (a capital sigma at the end of a word, which they read as a plain sigma, is one character either way); when they do not, as in a word of Hangul
// whose syllable NFKC composes across two clusters, the characters the two readings agree on at the start and at the end keep their clusters, and those between
// stand for the clusters between. A module with no imports.

/** NFKC, lower case and the seven marks made plain: the rule but for its white space. */
function folded(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/gu, "'")
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/[\u2013\u2014]/gu, '-');
}

export function normalizeText(s: string): string {
  return folded(s).replace(/\s+/gu, ' ').trim();
}

/**
 * A text read by the rule of normalizeText, with where each of its characters came from: the UTF-16 unit `i` of `text` comes from the characters `from[i]` to
 * `to[i]` (the end left out) of the text that was read. Neither list goes down from one unit to the next.
 */
export interface NormalizedText { text: string; from: number[]; to: number[] }

// A run of white space (the byte order mark aside), or a word: a run of what is not white space, the byte order mark among it.
const PIECES = /([^\S\ufeff]+)|[\S\ufeff]+/gu;
const SPACE = /\s/u;
const CLUSTERS = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Is the text all ASCII? Then the rule is lower case alone, and each character it gives comes from the character at its own place. */
const ascii = (s: string): boolean => /^[\x00-\x7f]*$/.test(s);

/** `s` read by the rule of normalizeText, with where each character of the result came from (ruling R-E36): normalizeMapped(s).text is normalizeText(s). */
export function normalizeMapped(s: string): NormalizedText {
  // The text read piece by piece, each unit with the part of `s` it came from: a run of white space is one space for the whole run.
  const units: string[] = [];
  const unitFrom: number[] = [];
  const unitTo: number[] = [];
  const add = (unit: string, from: number, to: number): void => { units.push(unit); unitFrom.push(from); unitTo.push(to); };
  for (const match of s.matchAll(PIECES)) {
    const piece = match[0];
    const at = match.index;
    if (match[1] !== undefined) {
      add(' ', at, at + piece.length);
      continue;
    }
    const word = folded(piece);
    if (ascii(piece)) {
      for (let k = 0; k < word.length; k += 1) add(word[k], at + k, at + k + 1);
      continue;
    }
    // The clusters read one by one, each unit with its cluster.
    const from: number[] = [];
    const to: number[] = [];
    let alone = '';
    for (const { segment, index } of CLUSTERS.segment(piece)) {
      const read = folded(segment);
      alone += read;
      for (let k = 0; k < read.length; k += 1) { from.push(at + index); to.push(at + index + segment.length); }
    }
    if (alone.length === word.length) {
      for (let k = 0; k < word.length; k += 1) add(word[k], from[k], to[k]);
      continue;
    }
    // Another number of units: the characters the two readings agree on at the start and at the end keep their clusters, and each one between stands for
    // every cluster between them (for the one after them when the clusters have none there).
    let head = 0;
    while (head < word.length && head < alone.length && word[head] === alone[head]) head += 1;
    let tail = 0;
    while (tail < word.length - head && tail < alone.length - head && word[word.length - 1 - tail] === alone[alone.length - 1 - tail]) tail += 1;
    const first = Math.min(head, alone.length - 1);
    const last = Math.max(alone.length - tail - 1, first);
    for (let k = 0; k < word.length; k += 1) {
      if (k < head) add(word[k], from[k], to[k]);
      else if (k >= word.length - tail) add(word[k], from[k + alone.length - word.length], to[k + alone.length - word.length]);
      else add(word[k], from[first], to[last]);
    }
  }
  // The white space collapsed and the ends trimmed: the space of a run stands for every unit of white space in it.
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  let space = false;
  for (let i = 0; i < units.length; i += 1) {
    if (!SPACE.test(units[i])) {
      text += units[i];
      from.push(unitFrom[i]);
      to.push(unitTo[i]);
      space = false;
    } else if (space) {
      to[to.length - 1] = unitTo[i];
    } else if (text !== '') {
      text += ' ';
      from.push(unitFrom[i]);
      to.push(unitTo[i]);
      space = true;
    }
  }
  if (space) {
    text = text.slice(0, -1);
    from.pop();
    to.pop();
  }
  return { text, from, to };
}
