// agents/audio-snippets/test/normalize.test.ts
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeText, tokensOf } from '../src/normalize.ts';

describe('the text of a word, a quote or a query, as the matching reads it (R-D5)', () => {
  test('NFKC, lower case, apostrophes dropped, every other mark a space, spaces collapsed', () => {
    expect(normalizeText("Don't stop \u2014 the well-known U.S. \ufb01le")).toBe('dont stop the well known u s file');
    expect(normalizeText('It\u2019s  ALL\tthe\nsame.')).toBe('its all the same');
    expect(normalizeText('\uff21\uff22\uff23 123')).toBe('abc 123');
  });
  test('tokens: letters, combining marks and digits survive in any script; punctuation alone is no token', () => {
    expect(tokensOf('  \u00bfQu\u00e9?  ')).toStrictEqual(['qu\u00e9']);
    expect(tokensOf('Que\u0301 pasa')).toStrictEqual(['qu\u00e9', 'pasa']);
    expect(tokensOf('\u0928\u092e\u0938\u094d\u0924\u0947 world')).toStrictEqual(['\u0928\u092e\u0938\u094d\u0924\u0947', 'world']);
    expect(tokensOf('?!... --- ...')).toStrictEqual([]);
    expect(tokensOf('')).toStrictEqual([]);
  });
  test('the module has no imports: the intake and the matching both read it', () => {
    expect(readFileSync(new URL('../src/normalize.ts', import.meta.url), 'utf8')).not.toMatch(/^import /m);
  });
});
