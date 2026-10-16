// packages/service-kit/test/text.test.ts
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { clip, errorText, flatText } from '../src/text.ts';

describe('text', () => {
  test('clip cuts at max characters and marks the cut', () => {
    expect(clip('abcdef', 3)).toBe('abc...');
    expect(clip('abc', 3)).toBe('abc');
  });
  test('flatText makes every control character a space and cuts at max: the cases of packages/buyer-core/test/guards.test.ts', () => {
    expect(flatText('one\ntwo\r\nthree\tfour\u001b[31mred\u001b[0m\u0000\u007f end', 500)).toBe('one two  three four [31mred [0m   end');
    for (let code = 0; code < 0x20; code++) expect(flatText(`a${String.fromCharCode(code)}b`, 10), String(code)).toBe('a b');
    expect(flatText('a\u007fb', 10)).toBe('a b');
    expect(flatText('Pr\u00e9cis \u2713 text', 100)).toBe('Pr\u00e9cis \u2713 text');
    expect(flatText('x'.repeat(600), 500)).toBe('x'.repeat(500));
    expect(flatText('\n'.repeat(10), 3)).toBe('   ');
  });
  test('errorText is the message of an Error or the text of anything else, flat, cut at 300 by default', () => {
    expect(errorText(new Error('line one\nline two'))).toBe('line one line two');
    expect(errorText('plain')).toBe('plain');
    expect(errorText(new Error('y'.repeat(400)))).toBe(`${'y'.repeat(300)}...`);
    expect(errorText(new Error('y'.repeat(400)), 1000)).toBe('y'.repeat(400));
  });
  test('src/text.ts has no imports, so @vsa/service-kit/text loads nothing else', () => {
    expect(readFileSync(new URL('../src/text.ts', import.meta.url), 'utf8')).not.toMatch(/^import /m);
  });
});
