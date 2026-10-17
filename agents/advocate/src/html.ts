// agents/advocate/src/html.ts
// The text of a fetched page (rulings R-E4 and R-E18), by a hand-written extractor on regular expressions, with no dependency. In HTML the comments and the
// elements a reader never sees as text (script, style, noscript, template, svg and head) are dropped with all they hold; the tags that start or end a block,
// and br, become line breaks; every other tag is stripped; the entities are decoded, after the tags, so that an encoded < stays text: the twenty named ones of
// the two rulings (&amp; &lt; &gt; &quot; &apos; &nbsp;, the typographic quotes, the two dashes, the ellipsis, the copyright, registered and trade mark
// signs, the guillemets, the euro and the pound) and every numeric one, decimal and hex; and the white space is collapsed. Plain text goes through
// collapseWhitespace only. The excerpt a brief may cite is the first EXCERPT_CHARS characters of that text, and a page with fewer than MIN_PAGE_CHARS
// characters of it is not kept (src/pages.ts).
//
// A page is a third party's, up to 1 MB of it, so every pattern here runs in time linear in its length however the page is made: no part of a tag may hold a <,
// so the scan of a tag ends at the next <; a comment or a dropped element left open runs to the end of the page, as a browser reads it, in one pass. The page's
// own title goes with its head: the title a brief gives a source is the one of its search result. Block boundaries stay line breaks, for the model, and
// src/normalize.ts reads them as spaces, for the check.

/** The fewest characters of text a page must have to be kept. */
export const MIN_PAGE_CHARS = 200;
/** The characters of a page's text that the model reads and the check searches: the first 12000. */
export const EXCERPT_CHARS = 12_000;

// The attributes of a tag, quoted or not: the unrolled form of (unquoted | "double" | 'single')*, in which a quoted value may hold a > and nothing holds a <.
const ATTRIBUTES = String.raw`[^<>"']*(?:(?:"[^"<]*"|'[^'<]*')[^<>"']*)*`;
// A comment, to its --> or to the end of the page.
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
// An element whose content is no text, with that content: to its end tag, or to the end of the page when it has none.
const DROPPED = new RegExp(String.raw`<(script|style|noscript|template|svg)(?=[\s/>])${ATTRIBUTES}>[\s\S]*?(?:<\/\1\s*>|$)`, 'gi');
// The head: to its end tag, to the start tag of the body (HTML lets a page leave out </head>), or to the end of the page.
const HEAD = new RegExp(String.raw`<head(?=[\s/>])${ATTRIBUTES}>[\s\S]*?(?:<\/head\s*>|(?=<body[\s/>])|$)`, 'gi');
// The start and end tags of a block, and br: each is a line break.
const BLOCK_NAMES = [
  'address', 'article', 'aside', 'blockquote', 'body', 'br', 'caption', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h[1-6]', 'header', 'hgroup', 'hr', 'html', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'option', 'p', 'pre', 'section', 'summary', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
].join('|');
const BLOCK = new RegExp(String.raw`<\/?(?:${BLOCK_NAMES})(?=[\s/>])${ATTRIBUTES}>`, 'gi');
// Any other tag: the start or end tag of an element (one with a quote left open ends at its first >), a declaration (<!DOCTYPE html>) or a processing
// instruction (<?xml ...?>). A < not followed by a letter, a / and a letter, a ! or a ? is text.
const TAG = new RegExp(String.raw`<\/?[A-Za-z]${ATTRIBUTES}>|<\/?[A-Za-z][^<>]*>|<[!?][^<>]*>`, 'g');
// The entities that are decoded, each with its semicolon and in lower case: the twenty named ones and every numeric one. Any other stays as it is written.
const ENTITY = /&(?:#(\d+)|#[xX]([0-9A-Fa-f]+)|(amp|lt|gt|quot|apos|nbsp|lsquo|rsquo|ldquo|rdquo|ndash|mdash|hellip|copy|reg|trade|laquo|raquo|euro|pound));/g;
// What each named one stands for; &nbsp; is a plain space (R-E18).
const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', ndash: '\u2013', mdash: '\u2014',
  hellip: '\u2026', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', laquo: '\u00ab', raquo: '\u00bb', euro: '\u20ac', pound: '\u00a3',
};

/** A code point as a character: the null character, a surrogate and anything past U+10FFFF are U+FFFD, as HTML reads them. */
function character(code: number): string {
  return code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff ? '\ufffd' : String.fromCodePoint(code);
}

/** The text with its entities decoded, once: &amp;lt; is &lt;. */
export function decodeEntities(s: string): string {
  return s.replace(ENTITY, (_entity: string, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED[name];
    return character(decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? '', 16));
  });
}

/**
 * The white space of a text collapsed, its line breaks kept. Every line break (CR LF, CR, LF, U+2028, U+2029) is LF; in each line every run of spaces and tabs
 * (the no-break space U+00A0 of &#160; and of a page that holds it as it is, and the other white space of a line, among them) is one space, and the line is
 * trimmed; a line left empty is dropped, so a run of blank lines is one line break, and the text begins and ends with a character that is not white space.
 */
export function collapseWhitespace(s: string): string {
  return s
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/** The text of an HTML page (R-E4): what is never text dropped, each block on a line of its own, the other tags stripped, the entities decoded, the white space collapsed. */
export function extractText(html: string): string {
  const text = html.replace(COMMENT, '').replace(DROPPED, '').replace(HEAD, '').replace(BLOCK, '\n').replace(TAG, '');
  return collapseWhitespace(decodeEntities(text));
}
