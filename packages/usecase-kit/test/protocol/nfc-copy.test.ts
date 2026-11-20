// packages/usecase-kit/test/protocol/nfc-copy.test.ts: the document that a parser of a message returns holds each text in the NFC form, the form that the digest binds. So a service works on the same bytes
// that its digest covers. The two parsers of a plain JSON value keep each text as it came, because a text that a model or a supplier wrote is recorded as it was written.
import { createHash } from 'node:crypto';
import { canonicalize } from '@vsa/vector-read';
import { describe, expect, it } from 'vitest';
import {
  accepted, canonicalJson, makeProposal, parseCanonicalDocument, parseDocument, parseHandoff, parseJsonValue, parseProposal, parseRequest, parseRfq, proposalDigest,
} from '@vsa/usecase-kit/protocol';
import type { ProposeFieldsParser } from '@vsa/usecase-kit/protocol';
import { APPROVAL, AUTHORITY, DELEGATION, DID_A, SALT, TENANT } from './support.ts';

/** A document with its texts in the NFD form: a letter, and then a combining mark. The keys are in the NFC form, because the protocol refuses any other key. */
const NFD = {
  schema: 'vector.usecase.po.v1',
  note: 'cafe\u0301 is open',
  lines: [{ sku: 'a\u030a-1', tags: ['e\u0301', 'plain'] }],
  quantity: 5,
  '\u00e9': 'e\u0301',
};

/** The same document with each text in the NFC form. */
const NFC = {
  schema: 'vector.usecase.po.v1',
  note: 'caf\u00e9 is open',
  lines: [{ sku: '\u00e5-1', tags: ['\u00e9', 'plain'] }],
  quantity: 5,
  '\u00e9': '\u00e9',
};

/** The digest of the NFC form. The test fails at once when the digest cannot be made. */
function digestOfNfc(): string {
  const digest = proposalDigest(SALT, NFC);
  if (!digest.ok) throw new Error(`the digest of the sample must be made: ${digest.detail}`);
  return digest.value;
}

function nest(levels: number): unknown {
  let value: unknown = 1;
  for (let level = 0; level < levels; level += 1) value = { a: value };
  return value;
}

describe('parseCanonicalDocument', () => {
  it('writes each text in the NFC form at every depth, and keeps the keys, the numbers and the order of the members', () => {
    const result = parseCanonicalDocument(NFD);
    expect(result).toStrictEqual({ ok: true, value: NFC });
    expect(result.ok && Object.keys(result.value)).toStrictEqual(Object.keys(NFD));
  });

  it('takes a document that is in the NFC form as it is', () => {
    expect(parseCanonicalDocument(NFC)).toStrictEqual({ ok: true, value: NFC });
  });

  it('keeps a lone surrogate, which has no NFC form', () => {
    expect(parseCanonicalDocument({ a: '\ud800', b: ['\udc00 x'] })).toStrictEqual({ ok: true, value: { a: '\ud800', b: ['\udc00 x'] } });
  });

  it('does not change the document that it is given, and shares no object with it', () => {
    const before = JSON.stringify(NFD);
    const result = parseCanonicalDocument(NFD);
    expect(JSON.stringify(NFD)).toBe(before);
    expect(NFD.note).toBe('cafe\u0301 is open');
    expect(result.ok && result.value).not.toBe(NFD);
    expect(result.ok && result.value.lines).not.toBe(NFD.lines);
  });

  it('gives the text that canonicalize of the buyer code writes, for the copy and for the document that it was made from', () => {
    const result = parseCanonicalDocument(NFD);
    expect(result.ok && canonicalize(result.value)).toBe(canonicalize(NFD));
    expect(result.ok && canonicalJson(result.value)).toStrictEqual({ ok: true, value: canonicalize(NFD) });
  });

  it.each([
    ['an array', [1]],
    ['a value that JSON cannot hold', { a: { b: undefined } }],
    ['the key __proto__', JSON.parse('{"__proto__":1}')],
    ['a key that is a whole number', JSON.parse('{"7":1}')],
    ['a key that is not in the NFC form', JSON.parse('{"e\\u0301":1}')],
    ['a document that is too deep', nest(40)],
  ])('refuses %s as parseDocument does, with the same code and detail', (_name, value) => {
    const result = parseCanonicalDocument(value);
    expect(result.ok).toBe(false);
    expect(result).toStrictEqual(parseDocument(value));
  });

  it('names the field that it was given', () => {
    const result = parseCanonicalDocument([], 'proposal.document');
    expect(result.ok === false && result.detail).toContain('proposal.document');
  });
});

describe('a document in the NFD form', () => {
  it('has the digest of its NFC form, and makeProposal returns the NFC copy whose digest that is', () => {
    const digest = digestOfNfc();
    expect(proposalDigest(SALT, NFD)).toStrictEqual({ ok: true, value: digest });
    expect(canonicalJson(NFD)).toStrictEqual(canonicalJson(NFC));
    const made = makeProposal(NFD, SALT);
    expect(made).toStrictEqual({ ok: true, value: { document: NFC, salt: SALT, proposal_digest: digest } });
    expect(made.ok && proposalDigest(SALT, made.value.document)).toStrictEqual({ ok: true, value: digest });
  });

  it('is taken by parseProposal when the digest is the digest of its NFC form, and the proposal holds the NFC copy', () => {
    const digest = digestOfNfc();
    expect(parseProposal({ document: NFD, salt: SALT, proposal_digest: digest })).toStrictEqual({ ok: true, value: { document: NFC, salt: SALT, proposal_digest: digest } });
  });

  it('is refused by parseProposal when one text is another text, as it is for a document in the NFC form', () => {
    const digest = digestOfNfc();
    const other = { ...NFD, note: 'cafe is open' };
    expect(parseProposal({ document: other, salt: SALT, proposal_digest: digest })).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(parseProposal({ document: { ...NFC, note: 'cafe is open' }, salt: SALT, proposal_digest: digest })).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('reaches the use case as the NFC copy in an execute request', () => {
    const request = { op: 'execute', authority: AUTHORITY, tenant: TENANT, proposal: { document: NFD, salt: SALT, proposal_digest: digestOfNfc() }, approval: null };
    const result = parseRequest(request);
    expect(result.ok && result.value.op === 'execute' ? result.value.proposal.document : null).toStrictEqual(NFC);
  });

  it('reaches the counterparty as the NFC copy in a handoff, and the digest of that copy is the digest that the approval names', () => {
    const handoff = { schema: 'vector.usecase.handoff.v1', use_case: 'inventory-reorder', sender_did: DID_A, delegation: DELEGATION, document: NFD, salt: SALT, approval: APPROVAL };
    const result = parseHandoff(handoff);
    expect(result.ok && result.value.document).toStrictEqual(NFC);
    expect(result.ok && proposalDigest(result.value.salt, result.value.document)).toStrictEqual({ ok: true, value: digestOfNfc() });
  });

  it('reaches a bid desk as the NFC copy in a request for quotation', () => {
    const result = parseRfq({ schema: 'vector.usecase.rfq.v1', sender_did: DID_A, delegation: DELEGATION, rfq: NFD });
    expect(result.ok && result.value.rfq).toStrictEqual(NFC);
  });
});

describe('the parsers of a plain JSON value keep each text as it came', () => {
  it('parseDocument and parseJsonValue return the NFD form', () => {
    expect(parseDocument(NFD)).toStrictEqual({ ok: true, value: NFD });
    expect(parseJsonValue(NFD)).toStrictEqual({ ok: true, value: NFD });
  });

  it('the fields of a propose request reach the parser of the use case as they came', () => {
    const parseFields: ProposeFieldsParser<{ note: string }> = (fields) => accepted({ note: String(fields.note) });
    const result = parseRequest({ op: 'propose', authority: AUTHORITY, tenant: TENANT, note: 'cafe\u0301' }, parseFields);
    expect(result.ok && 'note' in result.value ? result.value.note : null).toBe('cafe\u0301');
  });
});

/** A text that the NFC form makes longer: two characters have no composed form, so their NFC form is two characters each (10 characters become 12, and 13 bytes become 18). */
const LONGER = { note: 'qa \u0958 and \u0344', list: ['\u0958'] };
const LONGER_NFC = { note: 'qa \u0915\u093c and \u0308\u0301', list: ['\u0915\u093c'] };

/** A text that the NFC form puts in another order: a mark above and a mark below, which have no composed form, change places. The length stays. */
const REORDERED = { note: 'q\u0307\u0323 and \u00e9' };
const REORDERED_NFC = { note: 'q\u0323\u0307 and \u00e9' };

/** The digest of the salt bytes and the UTF-8 of a canonical text, made with node:crypto alone. */
const digestOf = (text: string): string => createHash('sha256').update(Buffer.from(SALT, 'hex')).update(text, 'utf8').digest('hex');

describe('a text that the NFC form changes in length or in order', () => {
  it.each([
    ['is longer in the NFC form', LONGER, LONGER_NFC],
    ['has its marks in another order in the NFC form', REORDERED, REORDERED_NFC],
  ])('a text that %s gives the NFC copy and the digest of that copy', (_what, given, nfc) => {
    const copy = parseCanonicalDocument(given);
    expect(copy).toStrictEqual({ ok: true, value: nfc });
    expect(JSON.stringify(copy.ok && copy.value)).not.toBe(JSON.stringify(given));
    // The digest is the digest of the NFC form, and the buyer code writes the same canonical text.
    expect(proposalDigest(SALT, given)).toStrictEqual({ ok: true, value: digestOf(canonicalize(given)) });
    expect(proposalDigest(SALT, given)).toStrictEqual(proposalDigest(SALT, nfc));
  });

  it('gives a copy that is longer than the text that was given, and the bytes of the copy are the bytes that the digest covers', () => {
    const copy = parseCanonicalDocument(LONGER);
    expect(copy.ok && typeof copy.value.note === 'string' ? copy.value.note.length : 0).toBe(LONGER.note.length + 2);
    expect(copy.ok && Buffer.byteLength(JSON.stringify(copy.value.note), 'utf8')).toBeGreaterThan(Buffer.byteLength(JSON.stringify(LONGER.note), 'utf8'));
    expect(copy.ok && canonicalJson(copy.value)).toStrictEqual(canonicalJson(LONGER));
  });

  it.each([
    ['is longer in the NFC form', LONGER, LONGER_NFC],
    ['has its marks in another order in the NFC form', REORDERED, REORDERED_NFC],
  ])('a proposal of a text that %s makes a copy that parseProposal takes again, with the same digest', (_what, given, nfc) => {
    const made = makeProposal(given, SALT);
    expect(made.ok && made.value.document).toStrictEqual(nfc);
    if (!made.ok) return;
    expect(parseProposal(made.value)).toStrictEqual(made);
    // The proposal goes over the wire as JSON text, and it is read again.
    expect(parseProposal(JSON.parse(JSON.stringify(made.value)))).toStrictEqual(made);
    // A proposal that holds the text as it was given and the digest of the NFC form is the same proposal.
    expect(parseProposal({ document: given, salt: SALT, proposal_digest: made.value.proposal_digest })).toStrictEqual(made);
  });

  it('keeps a lone surrogate through a proposal and its digest: the canonical text writes it as an escape, and the proposal goes over the wire and back', () => {
    const given = { note: 'a\ud800b', list: ['\udc00'] };
    const canonical = '{"list":["\\udc00"],"note":"a\\ud800b"}';
    expect(canonicalJson(given)).toStrictEqual({ ok: true, value: canonical });
    const made = makeProposal(given, SALT);
    expect(made).toStrictEqual({ ok: true, value: { document: given, salt: SALT, proposal_digest: digestOf(canonical) } });
    // JSON text writes a lone surrogate as an escape, and reading the text gives the lone surrogate back.
    const wire = JSON.stringify(made.ok && made.value);
    expect(wire).toContain('\\ud800');
    expect(parseProposal(JSON.parse(wire))).toStrictEqual(made);
  });
});
