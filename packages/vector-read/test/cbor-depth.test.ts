// Tests of src/cbor-depth.ts, the scanner that this package copies from Apex-Fusion/mcp-server (see VENDORED-FROM.md, CBOR check). The rule that it enforces:
// refuse CBOR that is nested deeper than 64 levels before it is decoded. The tests here pin what the services rely on: where the limit is, what counts as a
// level, what else the scan refuses, and that the scan does not recurse. They are local: the source has its own tests, and they are not copied.
import { describe, test, expect } from 'vitest';
import { CborGuardError, MAX_CBOR_DEPTH, assertCborDepth, assertCborHexDepth, cborDepth } from '../src/cbor-depth.ts';

const bytes = (hex: string): Uint8Array => Buffer.from(hex, 'hex');
/** CBOR hex of an array that is nested `levels` levels deep, with the integer 0 inside. */
const nested = (levels: number): string => `${'81'.repeat(levels)}00`;
/** The head of a byte string of `length` bytes, for a length up to 65,535. */
const head = (length: number): string => (length < 24 ? (0x40 + length).toString(16).padStart(2, '0') : length < 256 ? `58${length.toString(16).padStart(2, '0')}` : `59${length.toString(16).padStart(4, '0')}`);
/** CBOR in CBOR: the bytes of `inner` in a byte string under tag 24, as an inline datum holds them. */
const embedded = (inner: string): string => `d818${head(inner.length / 2)}${inner}`;
const tooDeep = (what = 'The CBOR'): string => `${what} is nested deeper than 64 levels.`;

/** Values of `levels` levels, one kind of level each: the way each kind is written, with the integer 0 inside. */
const KINDS: Array<[string, (levels: number) => string]> = [
  ['an array', (levels) => nested(levels)],
  ['a map', (levels) => `${'a100'.repeat(levels - 1)}a10000`],
  ['a tag', (levels) => `${'c1'.repeat(levels)}00`],
  ['an array with no declared count', (levels) => `${'9f'.repeat(levels)}00${'ff'.repeat(levels)}`],
  ['a map with no declared count', (levels) => `${'bf00'.repeat(levels)}00${'ff'.repeat(levels)}`],
];

describe('the limit', () => {
  test('is 64 levels', () => {
    expect(MAX_CBOR_DEPTH).toBe(64);
  });

  test('64 levels pass and 65 are refused, for each kind of level', () => {
    for (const [kind, make] of KINDS) {
      expect(() => assertCborDepth(bytes(make(64))), `${kind}, 64 levels`).not.toThrow();
      expect(() => assertCborDepth(bytes(make(65))), `${kind}, 65 levels`).toThrow(tooDeep());
    }
  });

  test('the hex form follows the same rule, in lower case and in upper case, and the refusal names the value that the caller gives', () => {
    expect(() => assertCborHexDepth(nested(64))).not.toThrow();
    expect(() => assertCborHexDepth(nested(64).toUpperCase())).not.toThrow();
    expect(() => assertCborHexDepth(nested(65), { what: 'The datum' })).toThrow(tooDeep('The datum'));
    expect(() => assertCborHexDepth(nested(65), { limit: 70 })).not.toThrow();
  });

  test('the refusal is an ordinary Error of the class CborGuardError, with the reason depth', () => {
    let refusal: unknown;
    try { assertCborHexDepth(nested(65)); } catch (err) { refusal = err; }
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).toBeInstanceOf(CborGuardError);
    expect((refusal as CborGuardError).name).toBe('CborGuardError');
    expect((refusal as CborGuardError).reason).toBe('depth');
  });
});

describe('what counts as a level', () => {
  test('an array, a map and a tag are one level each, and an empty array or map is a level of its own', () => {
    expect(cborDepth(bytes('00'))).toBe(0);
    expect(cborDepth(bytes('80'))).toBe(1);
    expect(cborDepth(bytes('a0'))).toBe(1);
    expect(cborDepth(bytes('8100'))).toBe(1);
    expect(cborDepth(bytes('818100'))).toBe(2);
    expect(cborDepth(bytes('a10000'))).toBe(1);
    expect(cborDepth(bytes('c100'))).toBe(1);
    expect(cborDepth(bytes('d8799f0102ff'))).toBe(2); // a constructor: the tag and its list
    expect(cborDepth(bytes('8180'))).toBe(2);
  });

  test('the levels of the bytes under tag 24 (CBOR in CBOR) add to the levels around them', () => {
    expect(cborDepth(bytes(embedded('00')))).toBe(1);
    expect(cborDepth(bytes(embedded(nested(3))))).toBe(4);
    expect(() => assertCborDepth(bytes(embedded(nested(63))))).not.toThrow();
    expect(() => assertCborDepth(bytes(embedded(nested(64))))).toThrow(tooDeep());
    // Each byte string under a tag 24 can hold the next one: the levels of the whole chain count.
    let chain = '00';
    for (let level = 0; level < 65; level += 1) chain = embedded(chain);
    expect(() => assertCborDepth(bytes(chain))).toThrow(tooDeep());
  });

  test('bytes that follow the first item are not read', () => {
    expect(() => assertCborDepth(bytes(`00${nested(1000)}`))).not.toThrow();
  });
});

describe('what else is refused', () => {
  const format = (err: unknown): boolean => err instanceof CborGuardError && err.reason === 'format';

  test('hex that is not whole bytes', () => {
    for (const hex of ['abc', 'zz', '0x00', ' 00']) expect(() => assertCborHexDepth(hex), hex).toThrow('is not hex of whole bytes');
  });

  test('bytes that are not well-formed CBOR', () => {
    for (const hex of ['', '81', '1c', 'ff', '5f', '9f', 'a1ff', '5801', '9bffffffffffffffff', 'bf00ff']) {
      expect(() => assertCborHexDepth(hex), hex).toThrow(CborGuardError);
      try { assertCborHexDepth(hex); } catch (err) { expect(format(err), hex).toBe(true); }
    }
  });

  test('a float or a simple value, which Plutus data and metadata do not hold', () => {
    for (const hex of ['f4', 'f5', 'f6', 'f7', 'f9003c', 'fa3f800000', 'fb3ff0000000000000', '81f6', 'd8799ff5ff']) {
      expect(() => assertCborHexDepth(hex), hex).toThrow('simple value or a float');
    }
  });

  test('a value with no limit is measured, not refused, for a float too', () => {
    expect(cborDepth(bytes('81f6'))).toBe(1);
  });
});

describe('the scan does not recurse', () => {
  test('a value of 300,000 levels is refused with the same error as one of 65 levels', () => {
    expect(() => assertCborHexDepth(nested(300_000))).toThrow(tooDeep());
    expect(() => assertCborHexDepth(`${'9f'.repeat(300_000)}00`)).toThrow(tooDeep());
    expect(() => assertCborHexDepth(embedded(nested(1000)))).toThrow(tooDeep());
  });

  test('a length that the input declares but does not hold is refused as it is read', () => {
    expect(() => assertCborHexDepth(`9a7fffffff00`)).toThrow('declares more items than the input has bytes');
    expect(() => assertCborHexDepth(`5a7fffffff00`)).toThrow('longer than the input');
  });
});
