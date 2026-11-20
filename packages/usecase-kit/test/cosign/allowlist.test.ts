// packages/usecase-kit/test/cosign/allowlist.test.ts
// The allowlist of the operator: the text form, the check at the start, and the one function that adds a key.
import { describe, expect, it } from 'vitest';
import { Allowlist, MAX_ALLOWLIST_BYTES, MAX_ALLOWLIST_KEYS, addToAllowlist, parseAllowlist } from '@vsa/usecase-kit/cosign';

const K1 = 'a1'.repeat(28);
const K2 = 'b2'.repeat(28);
const K3 = 'c3'.repeat(28);
const MARKER = 'zq9-marker-7f3';

const parsed = (text: string): Allowlist => {
  const result = parseAllowlist(text);
  if (!result.ok) throw new Error(result.detail);
  return result.value;
};

describe('parseAllowlist', () => {
  it('reads one key on each line, and keys that commas or white space part', () => {
    expect(parsed(`${K1}\n${K2}\n`).keys().sort()).toEqual([K1, K2]);
    expect(parsed(`${K1}, ${K2}\t${K3}`).size).toBe(3);
    expect(parsed(`\r\n${K1}\r\n\r\n${K2}\r\n`).size).toBe(2);
  });

  it('skips a note: a `#` runs to the end of the line, also after a key', () => {
    const list = parsed(`# the members of the demonstration\n${K1} # the first member\n  # ${K2}\n${K3}`);
    expect(list.keys().sort()).toEqual([K1, K3]);
    expect(list.has(K2)).toBe(false);
  });

  it('reads an empty text and a text of notes as a list of no key', () => {
    expect(parsed('').size).toBe(0);
    expect(parsed('\n# nothing yet\n').size).toBe(0);
  });

  it('keeps a key that is listed twice one time', () => {
    expect(parsed(`${K1}\n${K1}`).size).toBe(1);
  });

  it.each([
    ['a key in upper case', K1.toUpperCase()], ['a key of 55 characters', K1.slice(1)], ['a key of 57 characters', `${K1}a`], ['a character that is not hex', `${K1.slice(0, 55)}g`],
    ['a key with a prefix', `0x${K1}`], ['a key in quotes', `"${K1}"`], ['a word', MARKER], ['an agent identifier of 64 characters', 'ab'.repeat(32)],
  ])('refuses %s, names the line, and does not repeat the entry', (_name, entry) => {
    const result = parseAllowlist(`${K1}\n${K2}\n${entry}\n`);
    expect(result).toMatchObject({ ok: false, code: 'bad_setting' });
    if (!result.ok) {
      expect(result.detail).toContain('line 3');
      expect(result.detail).not.toContain(entry);
    }
  });

  it.each([undefined, null, 5, {}, [K1], new Set([K1]), Buffer.from(K1)])('refuses a value that is not text: %s', (value) => {
    expect(parseAllowlist(value)).toMatchObject({ ok: false, code: 'bad_setting' });
  });

  it('takes the most keys and the most bytes that it names, and refuses one more', () => {
    const key = (i: number) => i.toString(16).padStart(56, '0');
    const most = Array.from({ length: MAX_ALLOWLIST_KEYS }, (_, i) => key(i)).join('\n');
    expect(parsed(most).size).toBe(MAX_ALLOWLIST_KEYS);
    expect(parseAllowlist(`${most}\n${key(MAX_ALLOWLIST_KEYS)}`)).toMatchObject({ ok: false });
    expect(parsed(`#${' '.repeat(MAX_ALLOWLIST_BYTES - 1)}`).size).toBe(0);
    expect(parseAllowlist(`#${' '.repeat(MAX_ALLOWLIST_BYTES)}`)).toMatchObject({ ok: false });
    // The size is in bytes of UTF-8: a note of two-byte characters is over the limit at half the characters.
    expect(parseAllowlist(`#${'é'.repeat(MAX_ALLOWLIST_BYTES / 2)}`)).toMatchObject({ ok: false });
  });
});

describe('Allowlist', () => {
  it('has the keys of the list and no other value', () => {
    const list = parsed(`${K1}\n${K2}`);
    expect(list.has(K1)).toBe(true);
    expect([K3, K1.toUpperCase(), K1.slice(0, 55), ` ${K1}`, `${K1}\n`, '', undefined, null, 5, [K1]].map((value) => list.has(value))).toEqual(Array(10).fill(false));
  });

  it('cannot be changed from outside: the keys that it gives are a copy, and it has no function that adds a key', () => {
    const list = parsed(K1);
    list.keys().push(K2);
    expect(list.has(K2)).toBe(false);
    expect(list.size).toBe(1);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(list)).sort()).toEqual(['constructor', 'has', 'keys', 'size']);
    const source = new Set([K1]);
    const copy = new Allowlist(source);
    source.add(K2);
    expect(copy.has(K2)).toBe(false);
  });
});

describe('addToAllowlist', () => {
  it('adds a key to an empty list, and the new list has the key', () => {
    const result = addToAllowlist('', K1);
    expect(result).toEqual({ ok: true, value: { text: `${K1}\n`, added: true } });
    if (result.ok) expect(parsed(result.value.text).has(K1)).toBe(true);
  });

  it('adds the key at the end, on its own line, and keeps every note and every key as they were', () => {
    const text = `# members\n${K1} # the first\n${K2}`;
    const result = addToAllowlist(text, K3);
    expect(result).toEqual({ ok: true, value: { text: `${text}\n${K3}\n`, added: true } });
    expect(addToAllowlist(`${text}\n`, K3)).toEqual({ ok: true, value: { text: `${text}\n${K3}\n`, added: true } });
  });

  it('gives the same text, and says that nothing was added, for a key that is on the list', () => {
    const text = `${K1}\n# note\n${K2}\n`;
    expect(addToAllowlist(text, K2)).toEqual({ ok: true, value: { text, added: false } });
  });

  it.each([['upper case', K1.toUpperCase()], ['55 characters', K1.slice(1)], ['text with a new line', `${K1}\n${K2}`], ['a number', 5], ['nothing', undefined]])('refuses a key that is %s', (_name, key) => {
    expect(addToAllowlist(`${K2}\n`, key)).toMatchObject({ ok: false, code: 'bad_setting' });
  });

  it('refuses to add to a text that does not pass the check: the command never writes over a file that it could not read', () => {
    expect(addToAllowlist(`${K2}\nnot a key\n`, K1)).toMatchObject({ ok: false, code: 'bad_setting' });
    expect(addToAllowlist(undefined, K1)).toMatchObject({ ok: false, code: 'bad_setting' });
  });

  it('refuses a key past the most keys, and a text past the most bytes', () => {
    const key = (i: number) => i.toString(16).padStart(56, '0');
    const full = Array.from({ length: MAX_ALLOWLIST_KEYS }, (_, i) => key(i)).join('\n');
    expect(addToAllowlist(full, key(MAX_ALLOWLIST_KEYS))).toMatchObject({ ok: false, code: 'bad_setting' });
    const noted = `#${' '.repeat(MAX_ALLOWLIST_BYTES - 10)}\n`;
    expect(addToAllowlist(noted, K1)).toMatchObject({ ok: false, code: 'bad_setting' });
    expect(addToAllowlist(`#${' '.repeat(MAX_ALLOWLIST_BYTES - 200)}\n`, K1)).toMatchObject({ ok: true });
  });
});
