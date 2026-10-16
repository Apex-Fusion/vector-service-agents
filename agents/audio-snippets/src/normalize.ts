// agents/audio-snippets/src/normalize.ts
// The text of a word, a quote or a query as the matching reads it (ruling R-D5): Unicode NFKC, lower case, the apostrophes U+0027 and U+2019 dropped (a model
// writes don't or dont), every other character that is not a letter, a combining mark or a digit made a space, and the spaces collapsed. A module with no
// imports: the intake (a quote must hold a letter or a digit) and the matching both read it.

export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/['\u2019]/gu, '').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}

/** The tokens of a text: its normalised words. A text of punctuation alone has none. */
export function tokensOf(text: string): string[] {
  const normal = normalizeText(text);
  return normal === '' ? [] : normal.split(' ');
}
