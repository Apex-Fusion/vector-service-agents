// packages/usecase-kit/test/protocol/canonical-drift.test.ts: the canonical form of the protocol is the one that `canonicalize` of the buyer code gives (sorted keys, NFC strings, no white space).
// The protocol folder keeps its own copy of the rule, so that it loads no chain library. This test holds the two together: on every document that the protocol takes, both give the same text, and
// the same SHA-256. It also shows the two inputs on which `canonicalize` is not the plain form, and so the protocol refuses them.
import { createHash } from 'node:crypto';
import { canonicalize, sha256Utf8Hex } from '@vsa/vector-read';
import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256, parseDocument, proposalDigest } from '@vsa/usecase-kit/protocol';
import { DOCUMENT, SALT } from './support.ts';

/** A small seeded generator, so that a failure can be repeated. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const STRINGS = [
  '', 'a', 'B', 'z', 'sku-100', 'lot-medium', 'sp ace', 'a.b', '_k', 'K-1', 'caf\u00e9', 'cafe\u0301', 'e\u0301', '\u00e9', '\u00e5', 'a\u030a', '\uff5e', '\u{1f600}', '\ud7ff', '\ue000', '\u4e2d\u6587',
  'quote"s', 'back\\slash', 'line\nbreak', 'tab\t', '\u0001', '\u001f', '\u007f', '\u2028', 'x'.repeat(40), '\ud800', '/', "'", '<tag>', '\u00df', '\u1e9b\u0323',
];
const NUMBERS = [0, -0, 1, -1, 7, 42, 100, 4.5, 87.5, -0.25, 0.1, 0.30000000000000004, 1e21, 1e-7, 123456789012, 5e-324, Number.MAX_VALUE, 2 ** 53, 0.000001, 1e300];

function generate(next: () => number, depth: number): unknown {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const kind = depth <= 0 ? Math.floor(next() * 4) : Math.floor(next() * 6);
  if (kind === 0) return pick(STRINGS);
  if (kind === 1) return pick(NUMBERS);
  if (kind === 2) return next() < 0.5;
  if (kind === 3) return null;
  if (kind === 4) return Array.from({ length: Math.floor(next() * 5) }, () => generate(next, depth - 1));
  const object: Record<string, unknown> = {};
  for (let i = Math.floor(next() * 6); i > 0; i -= 1) {
    const key = pick(STRINGS);
    // A key that is a whole number, and a key that is not in the NFC form, are the cases that the protocol refuses.
    if (/^(?:0|[1-9][0-9]*)$/.test(key) || key !== key.normalize('NFC')) continue;
    object[key] = generate(next, depth - 1);
  }
  return object;
}

describe('the canonical form of the protocol and canonicalize of the buyer code', () => {
  it('give the same text and the same hash on 600 generated documents', () => {
    const next = random(20261120);
    let taken = 0;
    for (let i = 0; i < 600; i += 1) {
      const document = generate(next, 5);
      const mine = canonicalJson(document);
      expect(mine.ok, `document ${i}`).toBe(true);
      if (!mine.ok) continue;
      expect(mine.value, `document ${i}`).toBe(canonicalize(document));
      expect(canonicalSha256(document), `document ${i}`).toStrictEqual({ ok: true, value: sha256Utf8Hex(canonicalize(document)) });
      taken += 1;
    }
    expect(taken).toBe(600);
  });

  it('give the same salted digest on the generated documents that are objects', () => {
    const next = random(7);
    let objects = 0;
    for (let i = 0; i < 400; i += 1) {
      const document = generate(next, 4);
      if (!parseDocument(document).ok) continue;
      objects += 1;
      const expected = createHash('sha256').update(Buffer.from(SALT, 'hex')).update(canonicalize(document), 'utf8').digest('hex');
      expect(proposalDigest(SALT, document), `document ${i}`).toStrictEqual({ ok: true, value: expected });
    }
    expect(objects).toBeGreaterThan(50);
  });

  it('give the same text on the purchase order sample and on keys that are not in the order of the writer', () => {
    expect(canonicalJson(DOCUMENT)).toStrictEqual({ ok: true, value: canonicalize(DOCUMENT) });
    const reversed = Object.fromEntries(Object.entries(DOCUMENT).reverse());
    expect(canonicalJson(reversed)).toStrictEqual({ ok: true, value: canonicalize(DOCUMENT) });
  });

  it('differ on a key that is a whole number, because canonicalize writes such a key first, and the protocol refuses such a document', () => {
    const document = JSON.parse('{"b":1,"10":2,"9":3}');
    expect(canonicalize(document)).toBe('{"9":3,"10":2,"b":1}');
    expect(parseDocument(document)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(canonicalJson(document)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('differ on the key __proto__, because canonicalize drops that key, and the protocol refuses such a document', () => {
    const document = JSON.parse('{"a":1,"__proto__":{"x":2}}');
    expect(canonicalize(document)).toBe('{"a":1}');
    expect(canonicalize({ a: 1 })).toBe('{"a":1}');
    expect(parseDocument(document)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(canonicalJson(document)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('differ on a key that is not in the NFC form, because canonicalize sorts the key as it is and then writes it in the NFC form, and the protocol refuses such a document', () => {
    const nfd = JSON.parse('{"e\u0301":1,"f":2}');
    const nfc = JSON.parse('{"\u00e9":1,"f":2}');
    // The same keys give two different texts, so the order of the text depends on the form of the key.
    expect(canonicalize(nfd)).toBe('{"\u00e9":1,"f":2}');
    expect(canonicalize(nfc)).toBe('{"f":2,"\u00e9":1}');
    expect(parseDocument(nfd)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(canonicalJson(nfd)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(canonicalJson(nfc)).toStrictEqual({ ok: true, value: canonicalize(nfc) });
  });

  it('differ on two keys of one normal form, because canonicalize keeps one of them, and the protocol refuses such a document', () => {
    const document = JSON.parse('{"\u00e9":1,"e\u0301":2}');
    expect(canonicalize(document)).toMatch(/^\{"\u00e9":[12]\}$/);
    expect(parseDocument(document)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('differ on an undefined member, because canonicalize drops it, and the protocol refuses such a value', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toMatchObject({ ok: false, code: 'bad_shape' });
  });
});
