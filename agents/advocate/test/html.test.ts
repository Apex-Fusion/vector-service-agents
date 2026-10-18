// agents/advocate/test/html.test.ts
// The text of a page (rulings R-E4 and R-E18): what is dropped, the line breaks of the blocks, the tags, the entities (named, decimal and hex), the white space, a
// plain-text body, a page of under 200 characters, and the time each pattern takes on a page made to slow it down. The golden pages of test/fixtures are read
// word for word in test/pages.test.ts. Every character outside ASCII is written as an escape.
import { describe, expect, test } from 'vitest';
import { EXCERPT_CHARS, MIN_PAGE_CHARS, collapseWhitespace, decodeEntities, extractText } from '../src/html.ts';

describe('extractText: what is never text is dropped', () => {
  test('script, style, noscript, template, svg and head go with all they hold, and so do the comments, in any case', () => {
    const html = [
      '<html><head><title>The title of the page</title><meta charset="utf-8"><link rel="stylesheet" href="a.css"></head><body>',
      '<p>one</p><script>var a = "<p>never</p>";</script><style>p { color: red }</style><noscript>never either</noscript>',
      '<template><p>a template</p></template><svg viewBox="0 0 10 10"><text>a label</text></svg><!-- a comment --><p>two</p>',
      '<SCRIPT type="module">upper case too</SCRIPT ><p>three</p></body></html>',
    ].join('');
    expect(extractText(html)).toBe('one\ntwo\nthree');
  });

  test('a comment or a dropped element left open runs to the end of the page; a head left open ends at the body', () => {
    expect(extractText('<p>kept</p><!-- open to the end <p>never</p>')).toBe('kept');
    expect(extractText('<p>kept</p><script>open to the end <p>never</p>')).toBe('kept');
    expect(extractText('<html><head><title>never</title><body><p>kept</p></body></html>')).toBe('kept');
  });

  test('a tag that only begins like a dropped one is not dropped', () => {
    expect(extractText('<header>the header</header><div><scripts>kept</scripts></div><svgs>kept too</svgs>')).toBe('the header\nkept\nkept too');
  });

  test('comments and dropped elements go in one pass from left to right (R-E37): a <!-- inside a script is the script\'s, and a <script> inside a comment is the comment\'s', () => {
    expect(extractText('<p>before</p><script>if (h.indexOf("<!--") >= 0) x();</script><p>the article text that matters</p><footer>end</footer>')).toBe('before\nthe article text that matters\nend');
    expect(extractText('<style>/* <!-- */ p { color: red }</style><p>kept</p><!-- c --><p>tail</p>')).toBe('kept\ntail');
    expect(extractText('<p>before</p><!-- <script> --><p>after</p>')).toBe('before\nafter');
    expect(extractText('<p>before</p><!-- <style>never</style> --><p>after</p><script>x</script><p>end</p>')).toBe('before\nafter\nend');
  });
});

describe('extractText: blocks and tags', () => {
  test('the tags of a block and br are line breaks, every other tag is stripped, and a run of breaks is one', () => {
    expect(extractText('<div><h1>Title</h1><p>One <b>bold</b> and <a href="/x">a link</a>.</p><ul><li>first</li><li>second</li></ul>tail<br>after<BR/>end<br />last</div>'))
      .toBe('Title\nOne bold and a link.\nfirst\nsecond\ntail\nafter\nend\nlast');
    expect(extractText('<span>glued</span><span>together</span> and <i>apart</i>')).toBe('gluedtogether and apart');
  });

  // The 48 names of a block, br among them, as src/html.ts lists them (h1 to h6 as one entry there).
  const BLOCKS = [
    'address', 'article', 'aside', 'blockquote', 'body', 'br', 'caption', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
    'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'option', 'p', 'pre',
    'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
  ];
  test('every tag of a block is a line break, start or end tag, in lower case or in capitals, with an attribute or self-closed; a name that only begins like one is not', () => {
    expect(BLOCKS).toHaveLength(48);
    const wrong: string[] = [];
    for (const name of BLOCKS) {
      for (const tag of [`<${name}>`, `<${name.toUpperCase()}>`, `<${name} class="x">`, `<${name}/>`, `</${name}>`, `<${name}\n>`]) {
        if (extractText(`one${tag}two`) !== 'one\ntwo') wrong.push(tag);
      }
    }
    expect(wrong).toStrictEqual([]);
    for (const tag of ['<param>', '<bro>', '<lix>', '<divx>', '<h7>', '<tables>', '<prefix>', '<dlx>']) expect(extractText(`one${tag}two`), tag).toBe('onetwo');
  });

  test('a quoted attribute may hold a >; a tag whose quote is left open ends at its first >; a < that starts no tag is text', () => {
    expect(extractText('<a title="x > y" data-z=\'a>b\'>linked</a> and <img alt="open>after')).toBe('linked and after');
    expect(extractText('<p>if a < b and 3<4, then <!DOCTYPE html><?xml version="1.0"?>c</p>')).toBe('if a < b and 3<4, then c');
  });
});

describe('decodeEntities', () => {
  test('the named entities of R-E4, &nbsp; a plain space, and the numeric ones, decimal and hex, with an x in either case', () => {
    expect(decodeEntities('&amp; &lt; &gt; &quot; &#39; &apos; [&nbsp;]')).toBe('& < > " \' \' [ ]');
    expect(decodeEntities('&#65;&#x42;&#X43;&#0000068; &#x2014; &#8217; &#160; &#x1F600;')).toBe('ABCD \u2014 \u2019 \u00a0 \ud83d\ude00');
  });

  test('the named entities of R-E18: the typographic quotes, the two dashes, the ellipsis, the three signs, the guillemets, the euro and the pound', () => {
    expect(decodeEntities('&lsquo;a&rsquo; &ldquo;b&rdquo; 1&ndash;2 &mdash; &hellip; &copy; &reg; &trade; &laquo;c&raquo; &euro;5 &pound;6 x&nbsp;y'))
      .toBe('\u2018a\u2019 \u201cb\u201d 1\u20132 \u2014 \u2026 \u00a9 \u00ae \u2122 \u00abc\u00bb \u20ac5 \u00a36 x y');
    expect(extractText('<p>the council&rsquo;s count &mdash; eleven&nbsp;percent&hellip;</p>')).toBe('the council\u2019s count \u2014 eleven percent\u2026');
  });

  test('a hex entity in lower case, as real pages write the typographic quotes', () => {
    expect(decodeEntities('&#x201c;quoted&#x201d; caf&#xe9; &#xfb01;')).toBe('\u201cquoted\u201d caf\u00e9 \ufb01');
  });

  test('a null, a surrogate and a code point past U+10FFFF are U+FFFD', () => {
    expect(decodeEntities('&#0;&#xD800;&#x110000;&#99999999999999999999;')).toBe('\ufffd\ufffd\ufffd\ufffd');
  });

  test('once, only with a semicolon and in lower case; any other name stays as it is written', () => {
    expect(decodeEntities('&amp;lt; &amp &mdash &eacute; &hearts; &RSQUO; AT&T &#; &#x;')).toBe('&lt; &amp &mdash &eacute; &hearts; &RSQUO; AT&T &#; &#x;');
  });

  test('after the tags are stripped, so that an encoded tag is text; &nbsp; and &#160; are spaces once the white space is collapsed', () => {
    expect(extractText('<p>&lt;p&gt;not a tag&lt;/p&gt; &amp; more</p>')).toBe('<p>not a tag</p> & more');
    expect(extractText('<p>Parents&nbsp;&amp;&nbsp;teachers, 41&#160;to 27</p>')).toBe('Parents & teachers, 41 to 27');
  });
});

describe('collapseWhitespace', () => {
  test('a run of spaces and tabs is one space, every line is trimmed, a run of blank lines is one line break, and the ends are trimmed', () => {
    expect(collapseWhitespace('  one \t two  \r\n\r\n\n   three\r\rfour\u2028five\u00a0\u00a0six\u3000 \n\n')).toBe('one two\nthree\nfour\nfive six');
    expect(collapseWhitespace(' \n\t\r\n ')).toBe('');
  });

  test('a plain-text body is read as it is: its tags and its entities are text, and only its white space is collapsed', () => {
    const body = 'NOTES\n\n  Vans in the centre at noon    halved.\n\n\n<p> is text here, and &amp; stays.\n';
    expect(collapseWhitespace(body)).toBe('NOTES\nVans in the centre at noon halved.\n<p> is text here, and &amp; stays.');
  });
});

describe('the bounds of a page', () => {
  test('a page of under 200 characters of text: what is left of it once the rest is dropped is what counts', () => {
    expect([MIN_PAGE_CHARS, EXCERPT_CHARS]).toStrictEqual([200, 12_000]);
    const thin = `<!doctype html><html><head><title>${'a long title '.repeat(20)}</title></head><body><p>Too short to cite.</p><script>${'x'.repeat(500)}</script></body></html>`;
    expect(thin.length).toBeGreaterThan(MIN_PAGE_CHARS);
    expect(extractText(thin)).toBe('Too short to cite.');
    expect(extractText(thin).length).toBeLessThan(MIN_PAGE_CHARS);
  });
});

// A quadratic pattern would take minutes on any of these; each pattern of src/html.ts takes one pass.
describe('a page made to slow the extractor down: about 1 MB of it in well under 2 s', () => {
  test.each<[string, string]>([
    ['tags that never close', '<a'.repeat(500_000)],
    ['quotes that never close', '<a href="'.repeat(111_112)],
    ['comments that never close', '<!--'.repeat(250_000)],
    ['scripts that never close', '<script>'.repeat(125_000)],
    ['scripts that open comments, and never close', '<script><!--'.repeat(83_334)],
    ['comments that open scripts, and never close', '<!--<script>'.repeat(83_334)],
    ['heads that never close', '<head>'.repeat(166_667)],
    ['blocks that never close', '<div '.repeat(200_000)],
    ['entities that never end', '&#x'.repeat(333_334)],
    ['lines of white space', ' \t\n'.repeat(333_334)],
  ])('%s', (_name, html) => {
    const started = performance.now();
    extractText(html);
    expect(performance.now() - started).toBeLessThan(2_000);
  }, 10_000);
});
