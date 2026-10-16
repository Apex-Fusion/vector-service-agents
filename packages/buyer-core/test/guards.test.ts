// packages/buyer-core/test/guards.test.ts
// The checks on untrusted values that fleet-clients.ts, select-supplier.ts and fleet-verify.ts share: is it a JSON object, and do two refs name the same output;
// and the one way text a supplier sent is made fit for a log line or an answer (flatText).
import { describe, it, expect } from 'vitest';
import { flatText, isRecord, sameRef } from '../src/guards.ts';

// Ruling R64: a supplier's message reaches log lines and the body of a refusal. A line break in it would forge a log line, an escape would steer a terminal.
describe('flatText', () => {
  it('turns every control character into a space, line breaks and escapes included, and keeps the rest as it is', () => {
    expect(flatText('one\ntwo\r\nthree\tfour\u001b[31mred\u001b[0m\u0000\u007f end', 500)).toBe('one two  three four [31mred [0m   end');
    for (let code = 0; code < 0x20; code++) expect(flatText(`a${String.fromCharCode(code)}b`, 10), String(code)).toBe('a b');
    expect(flatText('a\u007fb', 10)).toBe('a b');
    expect(flatText('Pr\u00e9cis \u2713 text', 100)).toBe('Pr\u00e9cis \u2713 text');
  });

  it('cuts the text at the length it is given', () => {
    expect(flatText('x'.repeat(600), 500)).toBe('x'.repeat(500));
    expect(flatText('short', 500)).toBe('short');
    expect(flatText('\n'.repeat(10), 3)).toBe('   ');
  });
});

const TX = 'ab'.repeat(32);

describe('isRecord', () => {
  it('is true for a JSON object and false for null, arrays and every other value', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    for (const other of [null, undefined, [], [{}], 'x', '', 0, 1, true, Symbol('s'), () => ({})]) expect(isRecord(other), String(other)).toBe(false);
  });
});

describe('sameRef', () => {
  it('is true for refs that name the same output, whatever the spelling: hex case, padding, leading zeros in the index', () => {
    expect(sameRef(`${TX}#0`, `${TX}#0`)).toBe(true);
    expect(sameRef(`${TX}#0`, `${TX.toUpperCase()}#0`)).toBe(true);
    expect(sameRef(` ${TX}#0\n`, `${TX}#0`)).toBe(true);
    expect(sameRef(`${TX}#007`, `${TX}#7`)).toBe(true);
  });

  it('is false for another index or another transaction', () => {
    expect(sameRef(`${TX}#0`, `${TX}#1`)).toBe(false);
    expect(sameRef(`${TX}#0`, `${'cd'.repeat(32)}#0`)).toBe(false);
  });

  it('is false for anything that is no ref, even two equal values that are none, and for anything that is no text', () => {
    for (const junk of ['', 'not a ref', TX, `${TX}#`, `${TX}#-1`, `${TX.slice(1)}#0`]) {
      expect(sameRef(junk, junk), JSON.stringify(junk)).toBe(false);
      expect(sameRef(junk, `${TX}#0`), JSON.stringify(junk)).toBe(false);
      expect(sameRef(`${TX}#0`, junk), JSON.stringify(junk)).toBe(false);
    }
    // An object that only looks like text (canonicalRef would call its trim) is no text either.
    const looksLikeText = { trim: () => `${TX}#0` };
    expect(sameRef(looksLikeText, `${TX}#0`)).toBe(false);
    expect(sameRef(`${TX}#0`, looksLikeText)).toBe(false);
    for (const notText of [undefined, null, 7, {}, ['x']]) {
      expect(sameRef(notText, notText), String(notText)).toBe(false);
      expect(sameRef(notText, `${TX}#0`), String(notText)).toBe(false);
      expect(sameRef(`${TX}#0`, notText), String(notText)).toBe(false);
    }
  });
});
