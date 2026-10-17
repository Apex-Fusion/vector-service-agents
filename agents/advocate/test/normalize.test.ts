// agents/advocate/test/normalize.test.ts
// A quote and the text of its page as the check compares them (ruling R-E6). Every character outside ASCII is written as an escape.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeText } from '../src/normalize.ts';

describe('normalizeText (R-E6)', () => {
  test('NFKC, then lower case', () => {
    expect(normalizeText('\uff23\uff49\uff54\uff49\uff45\uff53 \ufb01ll the CENTRE')).toBe('cities fill the centre');
    expect(normalizeText('cafe\u0301 \u2460')).toBe('caf\u00e9 1');
  });

  test('the two apostrophes are U+0027, the two double quotes U+0022, the two dashes U+002D', () => {
    expect(normalizeText('the council\u2019s own count')).toBe("the council's own count");
    expect(normalizeText('the council\u02bcs own count')).toBe("the council's own count");
    expect(normalizeText('a \u201cbanned\u201d street')).toBe('a "banned" street');
    expect(normalizeText('2019\u20132021 \u2014 two years')).toBe('2019-2021 - two years');
  });

  test('the rule names those six marks and no other: the left single quote, the low double quote and the minus sign stay', () => {
    expect(normalizeText('\u2018left\u2019 \u201elow\u201d \u2212minus')).toBe('\u2018left\' \u201elow" \u2212minus');
  });

  test('every run of white space, a line break among it, is one space, and the ends are trimmed', () => {
    expect(normalizeText('  retail\tfootfall\n\nrose \u00a0 by\u2003eleven\r\npercent  ')).toBe('retail footfall rose by eleven percent');
    expect(normalizeText(' \n\t ')).toBe('');
  });

  test('a quote written with plain marks is found in a page written with typographic ones, and the other way round', () => {
    const page = 'The council\u2019s three monitors \u2014 read every hour \u2014 showed the drop.';
    expect(normalizeText(page).includes(normalizeText("COUNCIL'S three monitors - read every hour"))).toBe(true);
    expect(normalizeText("The council's monitors").includes(normalizeText('council\u2019s monitors'))).toBe(true);
  });

  test('the module has no imports', () => {
    expect(readFileSync(new URL('../src/normalize.ts', import.meta.url), 'utf8')).not.toMatch(/^import /m);
  });
});
