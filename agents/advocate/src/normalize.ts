// agents/advocate/src/normalize.ts
// A quote and the text of its page as the check compares them (ruling R-E6): Unicode NFKC, lower case, the apostrophes U+2019 and U+02BC made U+0027, the
// double quotes U+201C and U+201D made U+0022, the dashes U+2013 and U+2014 made U+002D, every run of white space (a line break among it) made one space, and
// the ends trimmed. A model that copies a sentence may write its marks the plain way or the typographic way; both sides are read the same way, so a quote is
// found in its page when, read so, it is a part of the page's text. A module with no imports.

export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2019\u02bc]/gu, "'")
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/[\u2013\u2014]/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim();
}
