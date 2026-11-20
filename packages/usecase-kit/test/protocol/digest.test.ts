// packages/usecase-kit/test/protocol/digest.test.ts: the canonical form of a document and the digest of a proposal, SHA-256(salt bytes ++ UTF-8 of the canonical document).
//
// The vectors were made in three ways that do not use this code. (1) By hand: the canonical text below is written out from the rule (keys sorted by UTF-16 code units, strings and keys in
// the NFC form, no white space, numbers as JSON.stringify writes them). (2) With the shell: `( printf %s <salt hex> | xxd -r -p; printf %s '<canonical text>' ) | sha256sum`, and the same
// with openssl. (3) With a Python script that sorts keys by the UTF-16BE bytes of the key, normalises with unicodedata, and hashes with hashlib. All three agree on every vector. Each test
// below also computes the digest from the literal canonical text with node:crypto, so that the text and the hash are checked apart.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256, proposalDigest } from '@vsa/usecase-kit/protocol';
import { BAD_MARKER, MARKER, SALT } from './support.ts';

const sha256Of = (salt: string, text: string): string => createHash('sha256').update(Buffer.concat([Buffer.from(salt, 'hex'), Buffer.from(text, 'utf8')])).digest('hex');

interface Vector {
  readonly name: string;
  readonly salt: string;
  readonly document: unknown;
  readonly canonical: string;
  readonly digest: string;
}

const VECTORS: readonly Vector[] = [
  {
    name: 'A: two keys in the wrong order, a salt of the bytes 0 to 31',
    salt: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    document: JSON.parse('{"b":2,"a":1}'),
    canonical: '{"a":1,"b":2}',
    digest: 'd45776930b02190ea2744bf6f679f0e9841141264141d2ad82451217ca3e5abf',
  },
  {
    name: 'B: a purchase order',
    salt: '9f2c7a41d3e85b60a1f4c8d2e7b93a5c0d6e1f48b27a93c5e0d1f6a84b3c7e29',
    document: {
      schema: 'vector.usecase.po.v1',
      po_number: 'run1-0001',
      tenant: 'run1',
      sku: 'SKU-100',
      lot: 'lot-medium',
      quantity: 50,
      needed_by: '2026-12-01',
      supplier_did: `did:vector:${'ab'.repeat(32)}`,
      advert_ref: `${'cd'.repeat(32)}#0`,
      stock_reading_sha256: 'ef'.repeat(32),
    },
    canonical:
      `{"advert_ref":"${'cd'.repeat(32)}#0","lot":"lot-medium","needed_by":"2026-12-01","po_number":"run1-0001","quantity":50,"schema":"vector.usecase.po.v1","sku":"SKU-100",` +
      `"stock_reading_sha256":"${'ef'.repeat(32)}","supplier_did":"did:vector:${'ab'.repeat(32)}","tenant":"run1"}`,
    digest: '23276e730de9f5e0226e78c8c9f681bce6153e31edc0257e5a2da00a7ed9c63b',
  },
  {
    name: 'C: escapes, a decimal, an empty key, nesting, and a value in the NFD form',
    salt: 'ff'.repeat(32),
    document: JSON.parse(String.raw`{"z":[3,{"y":null,"x":true},"a\"b\\c\nd\u0001"],"Ab":{"\u00e9":"cafe\u0301","a":87.5,"":[]},"B":0}`),
    canonical: String.raw`{"Ab":{"":[],"a":87.5,"${'\u00e9'}":"caf${'\u00e9'}"},"B":0,"z":[3,{"x":true,"y":null},"a\"b\\c\nd\u0001"]}`,
    digest: '17b5d66c491bed92adc501a03d3995f6f10f526e8f1ec17dad2defbc612ed3f2',
  },
  {
    name: 'D: keys that sort differently by UTF-16 code units and by code points',
    salt: '0f'.repeat(32),
    document: JSON.parse(String.raw`{"\uff5e":1,"\ud83d\ude00":2,"plain":[],"\ud7ff":"x","\ue000":"y"}`),
    canonical: '{"plain":[],"\ud7ff":"x","\u{1f600}":2,"\ue000":"y","\uff5e":1}',
    digest: 'ad52fc954faa4e074d3ec92e039f267564bcad6b4d2c3b888ced3bbfaf4fa2b1',
  },
];

describe.each(VECTORS)('vector $name', ({ salt, document, canonical, digest }) => {
  it('has the canonical text that was written by hand', () => {
    expect(canonicalJson(document)).toStrictEqual({ ok: true, value: canonical });
  });

  it('has the digest that the shell, openssl and Python made', () => {
    expect(proposalDigest(salt, document)).toStrictEqual({ ok: true, value: digest });
  });

  it('has a digest that node:crypto makes from the literal text, so the text and the hash are checked apart', () => {
    expect(sha256Of(salt, canonical)).toBe(digest);
  });
});

describe('canonicalJson', () => {
  it('keeps the order of an array and sorts the keys of every object', () => {
    expect(canonicalJson(JSON.parse('[{"b":[3,1,2],"a":{"d":1,"c":2}},"z","a"]'))).toStrictEqual({ ok: true, value: '[{"a":{"c":2,"d":1},"b":[3,1,2]},"z","a"]' });
  });

  it('writes no white space and no trailing text', () => {
    const result = canonicalJson(JSON.parse('{ "a" : [ 1 , 2 ] ,\n "b" : { } }'));
    expect(result).toStrictEqual({ ok: true, value: '{"a":[1,2],"b":{}}' });
  });

  it('writes the scalars and the empty containers', () => {
    expect(canonicalJson(null)).toStrictEqual({ ok: true, value: 'null' });
    expect(canonicalJson(true)).toStrictEqual({ ok: true, value: 'true' });
    expect(canonicalJson(false)).toStrictEqual({ ok: true, value: 'false' });
    expect(canonicalJson('')).toStrictEqual({ ok: true, value: '""' });
    expect(canonicalJson([])).toStrictEqual({ ok: true, value: '[]' });
    expect(canonicalJson({})).toStrictEqual({ ok: true, value: '{}' });
  });

  it('writes numbers as JSON.stringify writes them, which is the form of RFC 8785', () => {
    const numbers = JSON.parse('[0,-0,1,-1,4.5,0.002,1e21,1e30,1e-6,1e-7,5e-324,1.7976931348623157e308,9007199254740992,123456789012345680000,0.30000000000000004]');
    expect(canonicalJson(numbers)).toStrictEqual({
      ok: true,
      value: '[0,0,1,-1,4.5,0.002,1e+21,1e+30,0.000001,1e-7,5e-324,1.7976931348623157e+308,9007199254740992,123456789012345680000,0.30000000000000004]',
    });
  });

  it('escapes what JSON requires and nothing else', () => {
    const short: Record<number, string | undefined> = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' };
    let text = '';
    let expected = '';
    for (let code = 0; code < 0x20; code += 1) {
      text += String.fromCharCode(code);
      expected += short[code] ?? `\\u${code.toString(16).padStart(4, '0')}`;
    }
    text += '"\\\u007f\u2028\u2029/';
    expected += '\\"\\\\\u007f\u2028\u2029/';
    expect(canonicalJson(text)).toStrictEqual({ ok: true, value: `"${expected}"` });
  });

  it('writes a lone surrogate as an escape, so the text is always valid UTF-8', () => {
    expect(canonicalJson('\ud800')).toStrictEqual({ ok: true, value: '"\\ud800"' });
  });

  it('takes the NFC form of every string value, and keeps the key, which is in the NFC form already', () => {
    const nfd = JSON.parse('{"\\u00e9":"e\\u0301","k":["a\\u030a"]}');
    expect(canonicalJson(nfd)).toStrictEqual({ ok: true, value: '{"k":["\u00e5"],"\u00e9":"\u00e9"}' });
    const nfc = JSON.parse('{"\\u00e9":"\\u00e9","k":["\\u00e5"]}');
    expect(canonicalJson(nfc)).toStrictEqual(canonicalJson(nfd));
  });

  it('does not change the document that it is given', () => {
    const document = JSON.parse('{"b":{"y":1,"x":"e\\u0301"},"a":[2,1]}');
    const before = JSON.stringify(document);
    canonicalJson(document);
    expect(JSON.stringify(document)).toBe(before);
  });

  it('writes the same text for the same value whatever the order of the keys', () => {
    const one = JSON.parse('{"a":1,"b":{"c":2,"d":3},"e":[{"g":1,"f":2}]}');
    const two = JSON.parse('{"e":[{"f":2,"g":1}],"b":{"d":3,"c":2},"a":1}');
    expect(canonicalJson(one)).toStrictEqual(canonicalJson(two));
  });

  it.each([
    ['undefined', undefined],
    ['a function', () => 1],
    ['not a number', Number.NaN],
    ['an object with a member that is undefined', { a: undefined }],
    ['the key __proto__', JSON.parse('{"__proto__":1}')],
    ['a key that is a whole number', JSON.parse('{"1":1}')],
    ['a key that is not in the NFC form', JSON.parse('{"e\u0301":1}')],
    ['a document that is too deep', JSON.parse(`${'['.repeat(100)}${']'.repeat(100)}`)],
  ])('refuses %s with bad_shape, and names the field', (_name, value) => {
    const result = canonicalJson(value, 'document');
    expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(!result.ok && result.detail).toContain('document');
  });
});

describe('canonicalSha256', () => {
  it('is the SHA-256 of the canonical text, with no salt', () => {
    expect(canonicalSha256(JSON.parse('{"b":2,"a":1}'))).toStrictEqual({ ok: true, value: '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777' });
    expect(createHash('sha256').update('{"a":1,"b":2}', 'utf8').digest('hex')).toBe('43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  });

  it('is the hash of the canonical text of a purchase order', () => {
    const vector = VECTORS[1]!;
    expect(canonicalSha256(vector.document)).toStrictEqual({ ok: true, value: createHash('sha256').update(vector.canonical, 'utf8').digest('hex') });
  });

  it('takes any JSON value, not only an object', () => {
    expect(canonicalSha256([1, 2]).ok).toBe(true);
    expect(canonicalSha256('text').ok).toBe(true);
    expect(canonicalSha256(null).ok).toBe(true);
  });

  it('refuses a value that is not JSON, and names the field', () => {
    const result = canonicalSha256({ a: undefined }, 'rfq');
    expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(!result.ok && result.detail).toContain('rfq.a');
  });
});

describe('proposalDigest', () => {
  const document = JSON.parse('{"a":1,"b":[1,2,{"c":"d"}]}');

  it('puts the salt bytes before the canonical text, and not after it', () => {
    const canonical = '{"a":1,"b":[1,2,{"c":"d"}]}';
    const result = proposalDigest(SALT, document);
    expect(result).toStrictEqual({ ok: true, value: sha256Of(SALT, canonical) });
    expect(sha256Of(SALT, canonical)).not.toBe(createHash('sha256').update(Buffer.concat([Buffer.from(canonical, 'utf8'), Buffer.from(SALT, 'hex')])).digest('hex'));
  });

  it('uses the 32 bytes of the salt, and not its 64 characters', () => {
    const result = proposalDigest(SALT, document);
    expect(result.ok && result.value).not.toBe(createHash('sha256').update(`${SALT}{"a":1,"b":[1,2,{"c":"d"}]}`, 'utf8').digest('hex'));
  });

  it('is not the digest of the document alone', () => {
    const salted = proposalDigest(SALT, document);
    const plain = canonicalSha256(document);
    expect(salted.ok && plain.ok && salted.value !== plain.value).toBe(true);
  });

  it('changes when one byte of the salt changes', () => {
    const other = `${SALT.slice(0, 63)}4`;
    expect(proposalDigest(other, document)).not.toStrictEqual(proposalDigest(SALT, document));
    expect(proposalDigest(other, document).ok).toBe(true);
  });

  it.each([
    ['a value', JSON.parse('{"a":2,"b":[1,2,{"c":"d"}]}')],
    ['a key', JSON.parse('{"x":1,"b":[1,2,{"c":"d"}]}')],
    ['the order of an array', JSON.parse('{"a":1,"b":[2,1,{"c":"d"}]}')],
    ['a nested value', JSON.parse('{"a":1,"b":[1,2,{"c":"e"}]}')],
    ['one more member', JSON.parse('{"a":1,"b":[1,2,{"c":"d"}],"z":null}')],
    ['a type, a number for a text', JSON.parse('{"a":"1","b":[1,2,{"c":"d"}]}')],
  ])('changes when %s changes', (_name, changed) => {
    expect(proposalDigest(SALT, changed)).not.toStrictEqual(proposalDigest(SALT, document));
    expect(proposalDigest(SALT, changed).ok).toBe(true);
  });

  it('is the same for the same document whatever the order of its keys', () => {
    expect(proposalDigest(SALT, JSON.parse('{"b":[1,2,{"c":"d"}],"a":1}'))).toStrictEqual(proposalDigest(SALT, document));
  });

  it('is the same for a document in the NFC form and the same document in the NFD form', () => {
    const nfc = JSON.parse('{"name":"caf\\u00e9"}');
    const nfd = JSON.parse('{"name":"cafe\\u0301"}');
    expect(proposalDigest(SALT, nfd)).toStrictEqual(proposalDigest(SALT, nfc));
  });

  it('is 64 lower-case hex characters', () => {
    const result = proposalDigest(SALT, document);
    expect(result.ok && result.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['a salt in upper case', 'AB'.repeat(32)],
    ['a short salt', 'ab'.repeat(31)],
    ['a long salt', 'ab'.repeat(33)],
    ['an empty salt', ''],
    ['a salt that is not hex', 'zz'.repeat(32)],
    ['a number', 12345],
    ['undefined', undefined],
    ['null', null],
  ])('refuses %s, and names the salt', (_name, salt) => {
    const result = proposalDigest(salt, document);
    expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(!result.ok && result.detail).toContain('salt');
  });

  it.each([
    ['an array', [1]],
    ['null', null],
    ['a string', 'text'],
    ['undefined', undefined],
    ['a document with a value that JSON cannot hold', { a: undefined }],
    ['a document with the key __proto__', JSON.parse('{"__proto__":1}')],
    ['a document that is too deep', nest(40)],
  ])('refuses %s as the document, and names the document', (_name, value) => {
    const result = proposalDigest(SALT, value);
    expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(!result.ok && result.detail).toContain('document');
  });

  it('never repeats the salt or a value in a refusal, and does not throw', () => {
    const badSalt = proposalDigest(BAD_MARKER, document);
    expect(badSalt.ok).toBe(false);
    expect(!badSalt.ok && badSalt.detail).not.toContain(BAD_MARKER);
    const badDocument = proposalDigest(SALT, { a: [MARKER, undefined] });
    expect(badDocument.ok).toBe(false);
    expect(!badDocument.ok && badDocument.detail).not.toContain(MARKER);
    expect(() => proposalDigest(Symbol('s'), 10n)).not.toThrow();
  });
});

function nest(levels: number): unknown {
  let value: unknown = 'leaf';
  for (let i = 0; i < levels; i += 1) value = { k: value };
  return value;
}
