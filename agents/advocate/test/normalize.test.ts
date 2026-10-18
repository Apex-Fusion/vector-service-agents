// agents/advocate/test/normalize.test.ts
// A quote and the text of its page as the check compares them (rulings R-E6 and R-E29), and the same reading with the place each of its characters came from,
// which the check gives a quote back by in the words of its page (ruling R-E36). Every character outside ASCII is written as an escape.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeMapped, normalizeText } from '../src/normalize.ts';

describe('normalizeText (R-E6, R-E29)', () => {
  test('NFKC, then lower case', () => {
    expect(normalizeText('\uff23\uff49\uff54\uff49\uff45\uff53 \ufb01ll the CENTRE')).toBe('cities fill the centre');
    expect(normalizeText('cafe\u0301 \u2460')).toBe('caf\u00e9 1');
  });

  test('the left single quote and the two apostrophes are U+0027 (R-E29), the two double quotes U+0022, the two dashes U+002D', () => {
    expect(normalizeText('the council\u2019s own count')).toBe("the council's own count");
    expect(normalizeText('the council\u02bcs own count')).toBe("the council's own count");
    expect(normalizeText('they called it \u2018the best year\u2019')).toBe("they called it 'the best year'");
    expect(normalizeText('a \u201cbanned\u201d street')).toBe('a "banned" street');
    expect(normalizeText('2019\u20132021 \u2014 two years')).toBe('2019-2021 - two years');
  });

  test('the rule names those seven marks and no other: the two low quotes and the minus sign stay', () => {
    expect(normalizeText('\u2018left\u2019 \u201alow\u2019 \u201elow\u201d \u2212minus')).toBe('\'left\' \u201alow\' \u201elow" \u2212minus');
  });

  test('every run of white space, a line break among it, is one space, and the ends are trimmed', () => {
    expect(normalizeText('  retail\tfootfall\n\nrose \u00a0 by\u2003eleven\r\npercent  ')).toBe('retail footfall rose by eleven percent');
    expect(normalizeText(' \n\t ')).toBe('');
  });

  test('a quote written with plain marks is found in a page written with typographic ones, and the other way round', () => {
    const page = 'The council\u2019s three monitors \u2014 read every hour \u2014 showed the drop.';
    expect(normalizeText(page).includes(normalizeText("COUNCIL'S three monitors - read every hour"))).toBe(true);
    expect(normalizeText("The council's monitors").includes(normalizeText('council\u2019s monitors'))).toBe(true);
    expect(normalizeText('They called it \u2018the best year\u2019.').includes(normalizeText("called it 'the best year'"))).toBe(true);
  });

  test('the module has no imports', () => {
    expect(readFileSync(new URL('../src/normalize.ts', import.meta.url), 'utf8')).not.toMatch(/^import /m);
  });
});

/**
 * A text for each case the rule has: every mark, white space of every kind, the byte order mark, a capital sigma at the end of a word and inside one, letters
 * with their accents apart, ligatures, compatibility characters that the rule makes several (one with a space), full-width letters, a dotted capital I, a sharp
 * s, Hangul letters that NFKC makes one syllable, faces and a flag outside the BMP, and an Arabic ligature that is a sentence.
 */
const TEXTS = [
  '',
  ' \n\t ',
  'Cities that closed their centres to cars saw retail footfall rise by eleven percent within two years, according to the council\u2019s own count.',
  'They called it \u201cthe best year\u201d \u2014 and the council\u02bcs count agreed, in every   street\nof the centre.',
  '\u2018left\u2019 \u201alow\u2019 \u201elow\u201d 2019\u20132021 \u2212minus',
  '  lead\u00a0and\u2003trail\r\n\u3000 ',
  'Density rose to 10\u00b3 people per km\u00b2 in the old town.',
  'It fell in the \ufb01rst year; \ufb02ats and \ufb00 too.',
  'cafe\u0301 na\u0308ive re\u0301sume\u0301',
  '\u0397 \u039f\u0394\u039f\u03a3 \u0395\u039a\u039b\u0395\u0399\u03a3\u0395. \u03a3\u0399\u0393\u0391 \u0391\u03a3\u0391 a\u03f9',
  '\u0391\u03a3\ufeff\u0392 and \u0391\u03a3 \u0392',
  'x\u00b4y and \u00a8 alone, \u00b4',
  '\uff23\uff49\uff54\uff49\uff45\uff53 \u2460 \u33a1',
  '\u0130stanbul Stra\u00dfe',
  '\u1100\u1161\u11a8 \uac01 x\u1100\u314fy',
  'a face \u{1F600} and a flag \u{1F1ED}\u{1F1F7} in a line',
  '\ufdfa is one character',
];
/** The characters the texts at random are made of: the cases of TEXTS, one character or cluster each. */
const PALETTE = [
  'a', 'B', 'z', '.', "'", '-', ' ', '  ', '\n', '\t', '\r\n', '\u00a0', '\u2003', '\u3000', '\ufeff', '\u2018', '\u2019', '\u02bc', '\u201c', '\u201d',
  '\u2013', '\u2014', '\u201a', '\u201e', '\u2212', '\u0301', '\u0308', '\ufb01', '\u00b3', '\u00b4', '\u00a8', '\uff21', '\u2460', '\u33a1',
  '\u0130', '\u00df', '\u1100', '\u1161', '\u11a8', '\u314f', '\uac01', '\u{1F600}', '\ufdfa', '\u03b1', '\u0391', '\u03a3', '\u03f9',
];
/** The capital sigmas of the palette: the one letter the rule lowers by what stands after it. */
const SIGMAS = ['\u03a3', '\u03f9'];
/** A generator of numbers from 0 to 1 of its own, so that the texts at random are the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const textsAtRandom = (palette: readonly string[], count: number, seed: number): string[] => {
  const random = seeded(seed);
  return Array.from({ length: count }, () => Array.from({ length: Math.floor(random() * 24) }, () => palette[Math.floor(random() * palette.length)]).join(''));
};

describe('normalizeMapped (R-E36)', () => {
  test('its text is normalizeText of the text, for a text of each case the rule has and for 3000 texts made at random of them', () => {
    const wrong = [...TEXTS, ...textsAtRandom(PALETTE, 3000, 20_261_018)].filter((s) => normalizeMapped(s).text !== normalizeText(s));
    expect(wrong).toStrictEqual([]);
  });

  test('each character of the text comes from a part of the read text that lies inside it, and the parts never go back', () => {
    const wrong = [...TEXTS, ...textsAtRandom(PALETTE, 3000, 17)].filter((s) => {
      const { text, from, to } = normalizeMapped(s);
      if (from.length !== text.length || to.length !== text.length) return true;
      return from.some((start, i) => start < 0 || start >= to[i] || to[i] > s.length || (i > 0 && (start < from[i - 1] || to[i] < to[i - 1])));
    });
    expect(wrong).toStrictEqual([]);
  });

  test('the part of the text a run of characters comes from reads, by the rule, as a text that holds the run (but for a capital sigma, which the end of a part lowers as the end of a word)', () => {
    const wrong: string[] = [];
    for (const s of textsAtRandom(PALETTE.filter((c) => !SIGMAS.includes(c)), 400, 2026)) {
      const { text, from, to } = normalizeMapped(s);
      for (let a = 0; a < text.length; a += 1) {
        for (let b = a; b < text.length; b += 1) {
          if (text[a] === ' ' || text[b] === ' ') continue;
          if (!normalizeText(s.slice(from[a], to[b])).includes(text.slice(a, b + 1))) wrong.push(JSON.stringify([s, a, b]));
        }
      }
    }
    expect(wrong.slice(0, 5)).toStrictEqual([]);
  });

  test('a text of ASCII: each character from the one at its own place', () => {
    expect(normalizeMapped('Cities that')).toStrictEqual({ text: 'cities that', from: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], to: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
  });

  test('a run of white space is one space that stands for the whole run, and the white space at the ends is left out', () => {
    expect(normalizeMapped('  a \n\t b  ')).toStrictEqual({ text: 'a b', from: [2, 3, 7], to: [3, 7, 8] });
    expect(normalizeMapped(' \n ')).toStrictEqual({ text: '', from: [], to: [] });
    // A run that the rule makes of a space of the text and the space the acute accent begins with: one space, which stands for both.
    expect(normalizeText('a \u00b4b')).toBe('a \u0301b');
    expect(normalizeMapped('a \u00b4b')).toStrictEqual({ text: 'a \u0301b', from: [0, 1, 2, 3], to: [1, 3, 3, 4] });
  });

  test('a character that the rule makes several stands for each of them, and a letter and its accents are one', () => {
    expect(normalizeMapped('\ufb01x cafe\u0301')).toStrictEqual({ text: 'fix caf\u00e9', from: [0, 0, 1, 2, 3, 4, 5, 6], to: [1, 1, 2, 3, 4, 5, 6, 8] });
    // The acute accent alone is a space and a combining accent to the rule: the space is white space, and here the start of the text, so it is left out.
    expect(normalizeMapped('\u00b4x')).toStrictEqual({ text: '\u0301x', from: [0, 1], to: [1, 2] });
  });

  test('a capital sigma at the end of a word is lowered to its final form, as the word is, and each letter keeps its place', () => {
    expect(normalizeMapped('\u039f\u0394\u039f\u03a3 x')).toStrictEqual({ text: '\u03bf\u03b4\u03bf\u03c2 x', from: [0, 1, 2, 3, 4, 5], to: [1, 2, 3, 4, 5, 6] });
  });

  test('the byte order mark is white space to the rule and stays inside its word, so that a sigma before it is lowered as the whole text lowers it', () => {
    expect(normalizeText('\u0391\u03a3\ufeff\u0392')).toBe('\u03b1\u03c3 \u03b2');
    expect(normalizeMapped('\u0391\u03a3\ufeff\u0392')).toStrictEqual({ text: '\u03b1\u03c3 \u03b2', from: [0, 1, 2, 3], to: [1, 2, 3, 4] });
  });

  test('in a word whose clusters read one by one give another number of characters than the word read whole, the characters both readings agree on at the start and at the end keep their clusters, and those between stand for the clusters between', () => {
    // A conjoining initial and the compatibility letter of a vowel: two clusters, which NFKC makes one syllable.
    expect(normalizeText('ab\u1100\u314fcd e')).toBe('ab\uac00cd e');
    expect(normalizeMapped('ab\u1100\u314fcd e')).toStrictEqual({ text: 'ab\uac00cd e', from: [0, 1, 2, 4, 5, 6, 7], to: [1, 2, 4, 5, 6, 7, 8] });
    expect(normalizeMapped('x \u1100\u314f y')).toStrictEqual({ text: 'x \uac00 y', from: [0, 1, 2, 4, 5], to: [1, 2, 4, 5, 6] });
    // A syllable and the compatibility letter of a final it takes: NFKC makes them one syllable, which stands for both.
    expect(normalizeText('\uac00\u3133')).toBe('\uac03');
    expect(normalizeMapped('\uac00\u3133')).toStrictEqual({ text: '\uac03', from: [0], to: [2] });
  });
});
