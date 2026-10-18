// agents/advocate/test/check.test.ts
// The post-check (ruling R-E6, Review Focus 2): the golden answer, whose true quote is kept and whose made-up quote, wrong page number and short quote are
// dropped; a quote read only against the page it names; the bounds of a quote, counted after normalisation; the normalisation of apostrophes, quotation
// marks, dashes, whitespace, case and compatibility forms, and what it does not forgive; the quote of a source given in the words of its page, whatever form
// the model wrote it in (ruling R-E36); an argument left without a quote dropped; no argument left is no_supported_claims, so that the thesis never answers
// alone; a page and a quote once in an argument (ruling R-E35); and the list of sources, each once, in the order of first use.
import { describe, test, expect } from 'vitest';
import { checkCitations, quoteFound } from '../src/check.ts';
import { AdvocateError } from '../src/errors.ts';
import { parseBriefAnswer } from '../src/model.ts';
import type { ModelBrief } from '../src/model.ts';
import type { Page } from '../src/pages.ts';
import { QUOTE_MAX_CHARS, QUOTE_MIN_CHARS } from '../src/prompt.ts';
import { GOLDEN_MODEL_BRIEF, GOLDEN_PAGES, GOLDEN_RESULT, MODEL_ANSWER } from './golden.ts';

const AT = '2026-10-17T09:00:00.000Z';
const page = (n: number, excerpt: string): Page => ({ n, title: `Page ${n}`, url: `https://example.org/page-${n}`, retrieved_at: AT, excerpt });
const Q1 = 'retail footfall rise by eleven percent within two years';
const Q2 = 'fell by a third in the first year';
const PAGES = [
  page(1, 'Cities that closed their centres to cars saw retail footfall rise by eleven percent within two years, according to the council\u{2019}s own count.'),
  page(2, 'Nitrogen dioxide at the school gate fell by a third in the first year after the street was closed to through traffic.'),
];
const source = (n: number, quote: string) => ({ title: `Page ${n}`, url: `https://example.org/page-${n}`, retrieved_at: AT, quote });
/** A brief whose arguments cite these [n, quote] pairs, one list for each argument. */
const brief = (...cited: Array<Array<[number, string]>>): ModelBrief => ({
  thesis: 'A thesis.', arguments: cited.map((list, i) => ({ claim: `Claim ${i}.`, support: `Support ${i}.`, sources: list.map(([n, quote]) => ({ n, quote })) })),
});
function refusalOf(fn: () => unknown): AdvocateError {
  try { fn(); } catch (e) { if (e instanceof AdvocateError) return e; throw e; }
  throw new Error('it was accepted');
}

describe('the golden answer (Review Focus 2)', () => {
  test('the brief of the fixture is the golden one, word for word', () => {
    const content = (JSON.parse(MODEL_ANSWER) as { choices: Array<{ message: { content: string } }> }).choices[0].message.content;
    expect(parseBriefAnswer(content)).toStrictEqual(GOLDEN_MODEL_BRIEF);
  });

  test('the true quote is kept; the made-up quote, the wrong page number and the short quote are dropped, and so is the argument they leave with none', () => {
    expect(checkCitations(GOLDEN_MODEL_BRIEF, GOLDEN_PAGES)).toStrictEqual({
      arguments: GOLDEN_RESULT.arguments, sources: GOLDEN_RESULT.sources, droppedQuotes: 3, droppedArguments: 1,
    });
  });

  test('each bad citation of the fixture fails for its own reason', () => {
    const [, page2, page3] = GOLDEN_PAGES;
    expect(quoteFound('the street became a river of bicycles overnight', page2.excerpt)).toBe(false); // made up
    expect(quoteFound('the number of vans in the centre at noon halved', page3.excerpt)).toBe(true); // true of page 3, cited as page 9
    expect(GOLDEN_PAGES.map((p) => p.n)).not.toContain(9);
    expect(GOLDEN_PAGES[0].excerpt).toContain('footfall r'); // in the page, and too short
    expect(quoteFound('footfall r', GOLDEN_PAGES[0].excerpt)).toBe(false);
  });
});

describe('a quote is read against the page it names', () => {
  test('a true quote of another page is dropped, and a number with no page is dropped', () => {
    const checked = checkCitations(brief([[2, Q1]], [[3, Q1]], [[1, Q1]]), PAGES);
    expect(checked).toStrictEqual({
      arguments: [{ claim: 'Claim 2.', support: 'Support 2.', sources: [source(1, Q1)] }], sources: [source(1, Q1)], droppedQuotes: 2, droppedArguments: 2,
    });
  });

  test('a source carries the title, the URL and the time of retrieval of its page and the quote in the words of the page (R-E36), in that order', () => {
    const [kept] = checkCitations(brief([[2, 'FELL BY A THIRD IN THE FIRST YEAR']]), PAGES).arguments[0].sources;
    expect(Object.keys(kept)).toStrictEqual(['title', 'url', 'retrieved_at', 'quote']);
    expect(kept).toStrictEqual(source(2, Q2));
  });
});

describe('the quote of a source is the words of its page (R-E36)', () => {
  /** The quote the brief gives when the model cites `quote` from a page whose excerpt is `excerpt`. */
  const given = (excerpt: string, quote: string): string => checkCitations(brief([[1, quote]]), [page(1, excerpt)]).sources[0].quote;

  test('the model writes plain quotation marks, apostrophes and dashes, and the page has typographic ones: the brief gives the marks of the page', () => {
    const excerpt = 'They called it \u{201C}the best year\u{201D} \u{2014} and the council\u{2019}s count agreed, as the \u{2018}first\u{2019} count had.';
    expect(given(excerpt, '"the best year" - and the council\'s count agreed')).toBe('\u{201C}the best year\u{201D} \u{2014} and the council\u{2019}s count agreed');
    expect(given(excerpt, "the council's count agreed, as the 'first' count had")).toBe('the council\u{2019}s count agreed, as the \u{2018}first\u{2019} count had');
  });

  test('the model writes in lower case or in capitals, and the brief gives the case of the page', () => {
    expect(given(PAGES[0].excerpt, 'cities that closed their centres to cars')).toBe('Cities that closed their centres to cars');
    expect(given(PAGES[1].excerpt, 'NITROGEN DIOXIDE AT THE SCHOOL GATE')).toBe('Nitrogen dioxide at the school gate');
  });

  test('the model writes a compatibility character in its plain form, and the brief gives the character of the page: a superscript stays one, so the brief never shows a number the page does not', () => {
    const excerpt = 'Density rose to 10\u{B3} people per km\u{B2} in the old town, and it fell in the \u{FB01}rst year after the closure.';
    expect(given(excerpt, 'Density rose to 103 people per km2')).toBe('Density rose to 10\u{B3} people per km\u{B2}');
    expect(given(excerpt, 'it fell in the first year after the closure')).toBe('it fell in the \u{FB01}rst year after the closure');
    // A quote that begins inside the two letters the ligature stands for: the brief gives the whole character.
    expect(given(excerpt, 'irst year after the closure')).toBe('\u{FB01}rst year after the closure');
  });

  test('the space around the quote of the model and the runs of space in it are not the page\'s: the brief gives the page\'s, a line break of its text among them', () => {
    expect(given(PAGES[0].excerpt, `${' '.repeat(400)}retail   footfall rise\tby eleven percent  `)).toBe('retail footfall rise by eleven percent');
    expect(given('They walk in every street\nof the centre now.', 'in every street of the centre')).toBe('in every street\nof the centre');
  });

  test('a letter whose accent the page writes apart, and capital letters of Greek with a sigma at the end of a word: the brief gives the letters of the page', () => {
    expect(given('The cafe\u{301} on the corner kept its terrace all year.', 'the caf\u{E9} on the corner kept its terrace')).toBe('The cafe\u{301} on the corner kept its terrace');
    const greek = '\u{397} \u{39F}\u{394}\u{39F}\u{3A3} \u{395}\u{39A}\u{39B}\u{395}\u{399}\u{3A3}\u{395} \u{393}\u{399}\u{391} \u{3A4}\u{391} \u{391}\u{3A5}\u{3A4}\u{39F}\u{39A}\u{399}\u{39D}\u{397}\u{3A4}\u{391}.';
    const quote = '\u{3B7} \u{3BF}\u{3B4}\u{3BF}\u{3C2} \u{3B5}\u{3BA}\u{3BB}\u{3B5}\u{3B9}\u{3C3}\u{3B5} \u{3B3}\u{3B9}\u{3B1} \u{3C4}\u{3B1} \u{3B1}\u{3C5}\u{3C4}\u{3BF}\u{3BA}\u{3B9}\u{3BD}\u{3B7}\u{3C4}\u{3B1}';
    expect(given(greek, quote)).toBe(greek.slice(0, -1));
  });

  test('the words are those of the first place the quote is found, and every quote the brief gives is found again in its page', () => {
    expect(given('Retail footfall rose. Later, retail footfall rose again in the centre.', 'RETAIL FOOTFALL ROSE')).toBe('Retail footfall rose');
    const { sources } = checkCitations(GOLDEN_MODEL_BRIEF, GOLDEN_PAGES);
    for (const s of sources) expect(quoteFound(s.quote, GOLDEN_PAGES.find((p) => p.url === s.url)?.excerpt ?? ''), s.quote).toBe(true);
  });

  test('the bounds are those of the normalised quote: 300 characters of it are kept, whatever the length of the words of the page, and 301 are not', () => {
    const apart = 'e\u{301}';
    expect(given(`x ${apart.repeat(300)} y`, '\u{E9}'.repeat(300))).toBe(apart.repeat(300));
    expect(() => given(`x ${apart.repeat(301)} y`, '\u{E9}'.repeat(301))).toThrow(expect.objectContaining({ code: 'no_supported_claims' }));
  });
});

describe('the bounds of a quote: 20 to 300 characters after normalisation', () => {
  const text = 'abcdefghij'.repeat(40);
  test('20 and 300 are kept, 19 and 301 dropped', () => {
    expect([QUOTE_MIN_CHARS, QUOTE_MAX_CHARS]).toStrictEqual([20, 300]);
    expect([20, 19, 300, 301].map((length) => quoteFound(text.slice(0, length), text))).toStrictEqual([true, false, true, false]);
  });

  test('the space around a quote and the runs of space inside it do not count toward the bounds', () => {
    expect(quoteFound(`   ${text.slice(0, 19)}   `, text)).toBe(false);
    expect(quoteFound(`fell by a third ${' '.repeat(10)}`, PAGES[1].excerpt)).toBe(false);
    expect(quoteFound(`  ${Q2}  `, PAGES[1].excerpt)).toBe(true);
  });

  test('the bounds count characters, so a quote of 20 characters outside the BMP is kept', () => {
    const wide = '\u{1F600}'.repeat(25);
    expect(quoteFound(wide.slice(0, 40), `before ${wide} after`)).toBe(true);
    expect(quoteFound(wide.slice(0, 38), `before ${wide} after`)).toBe(false);
  });
});

describe('the normalisation (R-E6)', () => {
  test('curly apostrophes and quotation marks, the dashes, whitespace and case are read as the page reads them, either way round', () => {
    const excerpt = 'They called it \u{201C}the best year\u{201D} \u{2014} and the council\u{2BC}s count agreed, in every   street\nof the centre.';
    expect(quoteFound('"the best year" - and the council\'s count agreed, in every street of the centre', excerpt)).toBe(true);
    expect(quoteFound('THE BEST YEAR\u{201D} \u{2013} AND THE COUNCIL\u{2019}S COUNT', excerpt)).toBe(true);
    expect(quoteFound('the council\u{2019}s own count', PAGES[0].excerpt)).toBe(true);
    expect(quoteFound("according to the council's own count", PAGES[0].excerpt)).toBe(true);
  });

  test('the compatibility forms of NFKC: a ligature and full-width letters match their plain letters', () => {
    expect(quoteFound('fell in the first year after the closure', 'It fell in the \u{FB01}rst year after the closure.')).toBe(true);
    expect(quoteFound('\u{FF46}\u{FF45}\u{FF4C}\u{FF4C} by a third in the first year', PAGES[1].excerpt)).toBe(true);
  });

  test('what it does not forgive: another word, a comma left out, a word left out', () => {
    for (const quote of ['fell by a half in the first year', 'within two years according to the council', 'retail footfall rise by eleven percent in two years']) {
      expect(quoteFound(quote, PAGES[0].excerpt + ' ' + PAGES[1].excerpt), quote).toBe(false);
    }
  });
});

describe('the arguments', () => {
  test('an argument that cites nothing, or whose every quote fails, is dropped; the others are kept in their order, and the thesis is not checked', () => {
    const checked = checkCitations(brief([], [[1, 'not in the page at all, not even close']], [[2, Q2]], [[1, Q1], [5, Q1]]), PAGES);
    expect(checked.arguments.map((a) => a.claim)).toStrictEqual(['Claim 2.', 'Claim 3.']);
    expect(checked.arguments[1].sources).toStrictEqual([source(1, Q1)]);
    expect([checked.droppedQuotes, checked.droppedArguments]).toStrictEqual([2, 2]);
  });

  test('no argument left is no_supported_claims (502): the thesis never answers alone', () => {
    const e = refusalOf(() => checkCitations(brief([[1, 'footfall r']], [[9, Q1]], []), PAGES));
    expect([e.code, e.status, e.detail]).toStrictEqual(['no_supported_claims', 502, 'no argument of the brief kept a quote found in the page it names: 2 quotes and 3 arguments dropped']);
    expect(() => checkCitations(GOLDEN_MODEL_BRIEF, [])).toThrow(expect.objectContaining({ code: 'no_supported_claims' }));
  });
});

describe('the sources of the brief', () => {
  test('a quote cited by two arguments is kept in both and listed once; the list is unique by page and quote, in the order of first use', () => {
    const checked = checkCitations(brief([[2, Q2]], [[1, Q1], [2, Q2]], [[1, Q1]], [[2, Q2.toUpperCase()]]), PAGES);
    expect(checked.arguments.map((a) => a.sources)).toStrictEqual([[source(2, Q2)], [source(1, Q1), source(2, Q2)], [source(1, Q1)], [source(2, Q2)]]);
    expect(checked.sources).toStrictEqual([source(2, Q2), source(1, Q1)]);
    expect([checked.droppedQuotes, checked.droppedArguments]).toStrictEqual([0, 0]);
  });

  test('a page and a quote that an argument cites twice are one source of it, in whatever form the model gave the quote again, and no quote is dropped for it (R-E35)', () => {
    const checked = checkCitations(brief([[1, Q1], [1, Q1.toUpperCase()], [2, Q2], [1, `  ${Q1} `]], [[1, Q1]]), PAGES);
    expect(checked.arguments.map((a) => a.sources)).toStrictEqual([[source(1, Q1), source(2, Q2)], [source(1, Q1)]]);
    expect(checked.sources).toStrictEqual([source(1, Q1), source(2, Q2)]);
    expect([checked.droppedQuotes, checked.droppedArguments]).toStrictEqual([0, 0]);
  });

  test('two quotes of one page are two sources', () => {
    const checked = checkCitations(brief([[1, Q1], [1, 'according to the council\u{2019}s own count']]), PAGES);
    expect(checked.sources).toStrictEqual([source(1, Q1), source(1, 'according to the council\u{2019}s own count')]);
  });

  test('one quote found in two pages is two sources, for the list is unique by URL and quote', () => {
    const both = PAGES[1].excerpt;
    expect(checkCitations(brief([[1, Q2], [2, Q2]]), [page(1, both), page(2, both)]).sources).toStrictEqual([source(1, Q2), source(2, Q2)]);
  });
});
