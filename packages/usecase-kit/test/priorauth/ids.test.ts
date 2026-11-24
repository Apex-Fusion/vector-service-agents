// packages/usecase-kit/test/priorauth/ids.test.ts: the helpers that every parser of the priorauth folder uses. `parseId`, `parseDay`, `objectOf`, `isList` and `valuesOf` are copies of the helpers of the
// inventory folder, so the forms below are the forms that the tests of the inventory folder give to the same rules (the identifiers `po_number` and `sku`, and the date `needed_by`). The text, the list and the
// rule "no entry twice" are the rules that the mock systems have for the other members. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { accepted, refused } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { checkUnique, isList, objectOf, parseDay, parseDiagnosisCodes, parseId, parseIds, parseList, parseText, valuesOf } from '../../src/priorauth/ids.ts';
import { BAD_TEXT, DAY_BAD, DAY_GOOD, ID_BAD, ID_GOOD, NOT_TEXT, expectRefused, withPrototype } from './support.ts';

/** Values that are no text, and no value at all. */
const NOT_A_TEXT: readonly unknown[] = [...NOT_TEXT, undefined];

describe('parseId', () => {
  it('takes 1 to 64 letters, digits, dots, hyphens and underscores that start with a letter or a digit, and gives the text as it is', () => {
    for (const id of [...ID_GOOD, 'SYN-MRI-LS', 'REC-0001', 'C1']) expect(parseId(id, 'id'), String(id)).toStrictEqual({ ok: true, value: id });
  });

  it('refuses a text of another form, and names the field and never repeats the text', () => {
    for (const value of [...ID_BAD, ' a', 'a ', undefined]) {
      const result = parseId(value, 'the id');
      expect(result.ok, JSON.stringify(value)).toBe(false);
      expectRefused(result, 'the id');
    }
  });

  it('checks the text as it is written: the Kelvin sign is refused, although NFC turns it into the letter K, and the twin with the letter K passes', () => {
    for (const text of ['\u212AEL', 'REC-\u212A', 'x\u212Ay']) {
      const result = parseId(text, 'the id');
      expectRefused(result, 'the id');
      expect(!result.ok && result.detail).not.toContain('\u212A');
    }
    for (const text of ['KEL', 'REC-K', 'xKy']) expect(parseId(text, 'the id').ok, text).toBe(true);
  });
});

describe('parseDay', () => {
  it('takes a date that exists, with a year of 0100 or later', () => {
    for (const day of DAY_GOOD) expect(parseDay(day, 'day'), String(day)).toStrictEqual({ ok: true, value: day });
  });

  it('refuses a date that does not exist, a text of another form, and a year before 0100, and names the field', () => {
    for (const value of [...DAY_BAD, undefined]) {
      const result = parseDay(value, 'the day');
      expect(result.ok, JSON.stringify(value)).toBe(false);
      expectRefused(result, 'the day');
    }
  });
});

describe('objectOf and isList', () => {
  it('give the object that a copy holds, and refuse a list, null, a text and a number', () => {
    const object = { a: 1 };
    expect(objectOf(object, 'the object')).toStrictEqual({ ok: true, value: object });
    expect(objectOf({}, 'the object').ok).toBe(true);
    for (const value of [[], [1], null, 'a', 1, true]) expectRefused(objectOf(value as JsonValue, 'the object'), 'the object');
  });

  it('tell a list from the other values of JSON', () => {
    expect(isList([])).toBe(true);
    expect(isList([1, 'a', null])).toBe(true);
    for (const value of [{}, { length: 0 }, null, 'a', 1, true]) expect(isList(value as JsonValue)).toBe(false);
  });
});

describe('valuesOf', () => {
  it('gives the values in the order of the results, in a new list', () => {
    const results = [accepted(3), accepted(1), accepted(2)];
    const values = valuesOf(results);
    expect(values).toStrictEqual({ ok: true, value: [3, 1, 2] });
    expect(valuesOf([])).toStrictEqual({ ok: true, value: [] });
  });

  it('gives the first refusal, and no value', () => {
    const first = refused('bad_shape', 'first');
    expect(valuesOf([accepted(1), first, refused('bad_shape', 'second'), accepted(2)])).toBe(first);
  });

  it('runs no setter of a prototype for an index', () => {
    const results = [accepted(1), accepted(2)];
    let calls = 0;
    const values = withPrototype(Array.prototype, { 0: { set() { calls += 1; } }, 1: { set() { calls += 1; } } }, () => valuesOf(results));
    expect(values).toStrictEqual({ ok: true, value: [1, 2] });
    expect(calls).toBe(0);
  });
});

describe('parseText', () => {
  it('takes 1 to `max` characters and gives the text', () => {
    expect(parseText('x', 'text', 16)).toStrictEqual({ ok: true, value: 'x' });
    expect(parseText('x'.repeat(16), 'text', 16).ok).toBe(true);
    expect(parseText('M54.16: low back pain, (left) / right # 2', 'text', 64).ok).toBe(true);
  });

  it('refuses the empty text and a text of more than `max` characters, and takes the twins', () => {
    expectRefused(parseText('', 'text', 16), 'text');
    expectRefused(parseText('x'.repeat(17), 'text', 16), 'text');
    expectRefused(parseText('x'.repeat(2001), 'text', 2000), 'text');
    expect(parseText('x'.repeat(2000), 'text', 2000).ok).toBe(true);
  });

  it('counts the characters as the mock systems count them, in UTF-16 code units, so a character outside the BMP counts two', () => {
    expect(parseText('\u{1F600}'.repeat(8), 'text', 16).ok).toBe(true);
    expectRefused(parseText('\u{1F600}'.repeat(9), 'text', 16), 'text');
    expect(parseText(`${'\u{1F600}'.repeat(7)}ab`, 'text', 16).ok).toBe(true);
    expectRefused(parseText(`${'\u{1F600}'.repeat(7)}abc`, 'text', 16), 'text');
  });

  it('refuses the control characters that the mock systems refuse: U+0000 to U+0008, U+000B, U+000C, U+000E to U+001F and U+007F', () => {
    const refusedCodes = [...Array.from({ length: 9 }, (_, code) => code), 0x0b, 0x0c, ...Array.from({ length: 18 }, (_, index) => 0x0e + index), 0x7f];
    for (const code of refusedCodes) {
      const text = `a${String.fromCharCode(code)}b`;
      expectRefused(parseText(text, 'text', 16), 'text');
    }
    expect(parseText('a b', 'text', 16).ok).toBe(true);
  });

  it('takes the characters that the mock systems take: the tab, the line feed, the carriage return, and the controls U+0080 to U+009F', () => {
    for (const code of [0x09, 0x0a, 0x0d, 0x80, 0x85, 0x9f]) expect(parseText(`a${String.fromCharCode(code)}b`, 'text', 16).ok, `U+${code.toString(16)}`).toBe(true);
  });

  it('gives the NFC form of a text, and keeps a text that is in the NFC form as it is', () => {
    const nfc = 'Caf\u00e9 \u00c5ngstr\u00f6m';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    expect(parseText(nfd, 'text', 64)).toStrictEqual({ ok: true, value: nfc });
    expect(parseText(nfc, 'text', 64)).toStrictEqual({ ok: true, value: nfc });
  });

  it('checks the limit for the text as written and for its NFC form: a character that NFC writes as two is refused when the NFC form is too long, and the twin that fits both passes', () => {
    // U+0958 is one character, and NFC writes it as U+0915 and U+093C. Eight of them fit 16 characters in both forms. Nine fit as written (9) and not in the NFC form (18).
    const copy = parseText('\u0958'.repeat(8), 'text', 16);
    expect(copy).toStrictEqual({ ok: true, value: '\u0915\u093c'.repeat(8) });
    expectRefused(parseText('\u0958'.repeat(9), 'text', 16), 'text');
    // The copy is a text that the helper takes again, with the same value: the helper gives back what it takes.
    expect(parseText('\u0915\u093c'.repeat(8), 'text', 16)).toStrictEqual(copy);
  });

  it('refuses a value that is not a text, names the field, and never repeats the text', () => {
    for (const value of NOT_A_TEXT) expectRefused(parseText(value, 'the text', 16), 'the text');
    const result = parseText(BAD_TEXT, 'the text', 40);
    expectRefused(result, 'the text');
    expectRefused(parseText(`zq9 marker ${'y'.repeat(40)}`, 'the text', 16), 'the text');
  });
});

describe('parseList', () => {
  it('takes `min` to `max` entries and refuses one fewer and one more', () => {
    const entries = (count: number): JsonValue[] => Array.from({ length: count }, (_, index) => `a${index}`);
    expect(parseList(entries(2), 'list', 2, 4, parseId).ok).toBe(true);
    expect(parseList(entries(4), 'list', 2, 4, parseId).ok).toBe(true);
    expectRefused(parseList(entries(1), 'list', 2, 4, parseId), 'list');
    expectRefused(parseList(entries(5), 'list', 2, 4, parseId), 'list');
    expect(parseList(entries(0), 'list', 0, 4, parseId)).toStrictEqual({ ok: true, value: [] });
  });

  it('gives the values that the reader gives, in the order of the entries', () => {
    expect(parseList(['b', 'a', 'c'], 'list', 1, 3, (entry, field) => parseText(entry, field, 5))).toStrictEqual({ ok: true, value: ['b', 'a', 'c'] });
    expect(parseList(['Cafe\u0301'], 'list', 1, 3, (entry, field) => parseText(entry, field, 5))).toStrictEqual({ ok: true, value: ['Caf\u00e9'] });
  });

  it('names the entry that is wrong by its index, and gives the first refusal, with no value', () => {
    expectRefused(parseList(['a', 'b c', 'd', 'e f'], 'the list', 1, 4, parseId), 'the list[1]');
    expectRefused(parseList(['a', 'b', 5], 'the list', 1, 4, parseId), 'the list[2]');
  });

  it('refuses a value that is not a list', () => {
    for (const value of [{}, { 0: 'a', length: 1 }, null, 'a', 1, true]) expectRefused(parseList(value as JsonValue, 'the list', 0, 4, parseId), 'the list');
  });
});

describe('checkUnique', () => {
  const same = (entries: readonly string[], member = '') => checkUnique(entries, 'the list', (entry) => entry, member);

  it('gives null for entries with different keys, also for keys that differ only in case, and for no entry', () => {
    expect(same(['a', 'b', 'c'])).toBeNull();
    expect(same(['REC-1', 'rec-1'])).toBeNull();
    expect(same([])).toBeNull();
  });

  it('names the second entry and the member, and never repeats the key', () => {
    const refusal = checkUnique([{ id: 'a' }, { id: 'zq9 marker' }, { id: 'c' }, { id: 'zq9 marker' }], 'the set.records', (entry) => entry.id, '.record_id');
    expect(refusal).not.toBeNull();
    expectRefused(refusal ?? refused('bad_shape', ''), 'the set.records[3].record_id');
    expectRefused(same(['a', 'a']) ?? refused('bad_shape', ''), 'the list[1]');
  });
});

describe('parseIds', () => {
  it('takes `min` to `max` identifiers, none twice, and refuses one fewer and one more', () => {
    const ids = (count: number): JsonValue[] => Array.from({ length: count }, (_, index) => `C${index}`);
    expect(parseIds(ids(0), 'ids', 0, 3)).toStrictEqual({ ok: true, value: [] });
    expect(parseIds(ids(3), 'ids', 1, 3)).toStrictEqual({ ok: true, value: ['C0', 'C1', 'C2'] });
    expectRefused(parseIds(ids(0), 'ids', 1, 3), 'ids');
    expectRefused(parseIds(ids(4), 'ids', 1, 3), 'ids');
  });

  it('refuses an entry that is not an identifier, and an identifier two times, names the entry, and never repeats the identifier', () => {
    expectRefused(parseIds(['C1', 'C 2'], 'ids', 0, 3), 'ids[1]');
    expectRefused(parseIds(['C1', 'a'.repeat(65)], 'ids', 0, 3), 'ids[1]');
    expectRefused(parseIds(['C1', 'C2', 'C1'], 'ids', 0, 3), 'ids[2]');
    expect(parseIds(['C1', 'C2', 'c1'], 'ids', 0, 3).ok).toBe(true);
  });
});

describe('parseDiagnosisCodes', () => {
  it('takes 1 to 8 codes of 1 to 16 characters, and takes a code two times, as the records system does', () => {
    expect(parseDiagnosisCodes(['M54.16'], 'codes')).toStrictEqual({ ok: true, value: ['M54.16'] });
    expect(parseDiagnosisCodes(['M54.16', 'M54.16'], 'codes').ok).toBe(true);
    expect(parseDiagnosisCodes(Array.from({ length: 8 }, (_, index) => `M${index}`), 'codes').ok).toBe(true);
    expect(parseDiagnosisCodes(['c'.repeat(16)], 'codes').ok).toBe(true);
  });

  it('refuses no code, 9 codes, an empty code and a code of 17 characters, and names the field', () => {
    expectRefused(parseDiagnosisCodes([], 'codes'), 'codes');
    expectRefused(parseDiagnosisCodes(Array.from({ length: 9 }, (_, index) => `M${index}`), 'codes'), 'codes');
    expectRefused(parseDiagnosisCodes(['M54.16', ''], 'codes'), 'codes[1]');
    expectRefused(parseDiagnosisCodes(['c'.repeat(17)], 'codes'), 'codes[0]');
    expectRefused(parseDiagnosisCodes('M54.16', 'codes'), 'codes');
  });

  it('gives each code in the NFC form', () => {
    expect(parseDiagnosisCodes(['e\u0301'], 'codes')).toStrictEqual({ ok: true, value: ['\u00e9'] });
  });
});
