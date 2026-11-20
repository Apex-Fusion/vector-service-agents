// packages/usecase-kit/test/dispute/documents.test.ts: the claim documents and the evidence documents that a juror reads. Each of the three use cases has a golden claim document and a golden evidence
// document. The golden files are the exact bytes, and the pinned hashes were made with another implementation of blake2b-256.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { documentHash } from '@vsa/buyer-core';
import { canonicalSha256 } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { EVIDENCE_STATEMENT, JUROR_RECORD_LIMIT_BYTES, MAX_JUROR_DOCUMENT_BYTES, claimDocument, evidenceDocument, evidenceReferences, jurorRecordSize, readClaimDocument } from '@vsa/usecase-kit/dispute';
import type { ClaimDocumentInput, EvidenceDocumentInput } from '@vsa/usecase-kit/dispute';
import {
  APPROVAL, BID_DESK, BID_DESK_CLAIM, CONFIRMATION, DIGEST_FACTS, ESCROW, HIRER, MANIFEST_SHA, MISMATCH, ME, ORDER_DESK_CLAIM, ORDER_FACTS, OTHER, PARTIES, PRIOR_AUTHORIZATION_CLAIM,
  PURCHASE_ORDER, PURCHASE_ORDER_SHA, QUOTE_FACTS, REF_A, REORDER_AGENT_S1, STATEMENT_S1, THIRD, TOKEN_A,
} from './support.ts';

const golden = (name: string): string => readFileSync(new URL(`./golden/${name}.txt`, import.meta.url), 'utf8');
const MARKER = 'zq9-marker-value-7f3';

const claimInput = (extra: Partial<ClaimDocumentInput> = {}): ClaimDocumentInput => ({
  agent_did: OTHER, capability_id: 'supplychain.order.accept.v1', manifest_sha256: MANIFEST_SHA, claim: ORDER_DESK_CLAIM, ...extra,
});

const evidenceInput = (extra: Record<string, unknown> = {}): EvidenceDocumentInput => ({ ...PARTIES, ...ORDER_FACTS, ...extra }) as unknown as EvidenceDocumentInput;

/** The canonical SHA-256 of a JSON value. */
const sha = (value: unknown): string => {
  const digest = canonicalSha256(value, 'value');
  if (!digest.ok) throw new Error(digest.detail);
  return digest.value;
};

describe('the claim document of an agent', () => {
  const CLAIMS = [
    ['inventory-reorder', OTHER, 'supplychain.order.accept.v1', ORDER_DESK_CLAIM, 'efba5d4cbc44aa500504642b66f8b2a5128ea911494888c424bbf019340f85cf'],
    ['prior-authorization', THIRD, 'health.priorauth.draft.v1', PRIOR_AUTHORIZATION_CLAIM, '1d79727ca795b8feaa5dca2efde1b65985b0b985854c735dee926025bc24d26e'],
    ['bid-evaluation', BID_DESK, 'supplychain.rfq.quote.v1', BID_DESK_CLAIM, 'a0c60aedc1a3a12b2c4a287529a4a7b4bd50489e485ba973e2bc8c6115ec2c96'],
  ] as const;

  it.each(CLAIMS)('is the golden file of use case %s, with its pinned hash', (useCase, agent, capability, claim, hash) => {
    const document = claimDocument({ agent_did: agent, capability_id: capability, manifest_sha256: MANIFEST_SHA, claim });
    if (!document.ok) throw new Error(document.detail);
    expect(document.value.text).toBe(golden(`claim-${useCase}`));
    expect(document.value.bytes.toString('utf8')).toBe(document.value.text);
    expect(document.value.hash).toBe(hash);
    expect(document.value.type).toBe('claim');
    expect(document.value.media_type).toBe('text/plain');
  });

  it('gives the same bytes for the same input, and other bytes for another agent', () => {
    const first = claimDocument(claimInput());
    const second = claimDocument(claimInput());
    const other = claimDocument(claimInput({ agent_did: THIRD }));
    if (!first.ok || !second.ok || !other.ok) throw new Error('a document was refused');
    expect(first.value.bytes.equals(second.value.bytes)).toBe(true);
    expect(first.value.hash).toBe(second.value.hash);
    expect(other.value.hash).not.toBe(first.value.hash);
  });

  /** The statement `S3` with `length` characters of letters, as a claim input. */
  const withLastStatement = (text: string): ClaimDocumentInput => claimInput({ claim: { statements: [ORDER_DESK_CLAIM.statements[0], ORDER_DESK_CLAIM.statements[1], { id: 'S3', text }] } });

  it('has the limits that the rules name: 3,000 bytes for a document and 4,300 bytes for its record', () => {
    expect(MAX_JUROR_DOCUMENT_BYTES).toBe(3_000);
    expect(JUROR_RECORD_LIMIT_BYTES).toBe(4_300);
  });

  it('accepts a document of exactly the most bytes and refuses one byte more, and it never cuts', () => {
    const short = claimDocument(withLastStatement('x'));
    if (!short.ok) throw new Error(short.detail);
    const fill = MAX_JUROR_DOCUMENT_BYTES - short.value.bytes.length + 1;
    const exact = claimDocument(withLastStatement('x'.repeat(fill)));
    if (!exact.ok) throw new Error(exact.detail);
    expect(exact.value.bytes.length).toBe(MAX_JUROR_DOCUMENT_BYTES);
    expect(exact.value.text).toContain(`S3: ${'x'.repeat(fill)}\n`);
    const over = claimDocument(withLastStatement('x'.repeat(fill + 1)));
    expect(over).toMatchObject({ ok: false, code: 'document_too_large' });
  });

  it('refuses a statement that is longer than any document, before it scans it', () => {
    expect(claimDocument(withLastStatement('x'.repeat(MAX_JUROR_DOCUMENT_BYTES + 1)))).toMatchObject({ ok: false, code: 'document_too_large' });
    expect(claimDocument(withLastStatement('x'.repeat(MAX_JUROR_DOCUMENT_BYTES - 1000)))).toMatchObject({ ok: true });
  });

  it('refuses a document that a juror would read cut, although it has fewer bytes than the most', () => {
    const quotes = (count: number): string => '"'.repeat(count);
    const heavy = claimDocument(claimInput({ claim: { statements: [{ id: 'S1', text: quotes(700) }, { id: 'S2', text: quotes(700) }, ORDER_DESK_CLAIM.statements[2]] } }));
    expect(heavy).toMatchObject({ ok: false, code: 'document_too_large' });
    if (heavy.ok) return;
    expect(heavy.detail).toContain(String(JUROR_RECORD_LIMIT_BYTES));
    // The same number of bytes in letters is a document of the same size that fits the record of a juror.
    const light = claimDocument(claimInput({ claim: { statements: [{ id: 'S1', text: 'a'.repeat(700) }, { id: 'S2', text: 'a'.repeat(700) }, ORDER_DESK_CLAIM.statements[2]] } }));
    expect(light).toMatchObject({ ok: true });
  });

  it('measures the record of a juror as the text escaped twice as a JSON string', () => {
    expect(jurorRecordSize('abc')).toBe(3);
    expect(jurorRecordSize('a"b\n')).toBe(9);
  });

  it('accepts a document whose record is exactly the most bytes, and refuses a record of one byte more', () => {
    const withTail = (letters: number): ClaimDocumentInput => claimInput({
      claim: { statements: [ORDER_DESK_CLAIM.statements[0], ORDER_DESK_CLAIM.statements[1], { id: 'S3', text: `${'"'.repeat(800)}${'a'.repeat(letters)}` }] },
    });
    const probe = claimDocument(withTail(1));
    if (!probe.ok) throw new Error(probe.detail);
    // Each letter is one byte in the document and one byte in the record, so the tail that makes the record the most is known.
    const letters = 1 + JUROR_RECORD_LIMIT_BYTES - jurorRecordSize(probe.value.text);
    const exact = claimDocument(withTail(letters));
    if (!exact.ok) throw new Error(exact.detail);
    expect(jurorRecordSize(exact.value.text)).toBe(JUROR_RECORD_LIMIT_BYTES);
    expect(exact.value.bytes.length).toBeLessThan(MAX_JUROR_DOCUMENT_BYTES);
    expect(claimDocument(withTail(letters + 1))).toMatchObject({ ok: false, code: 'document_too_large' });
  });

  const BAD_CLAIMS: Array<[string, Partial<ClaimDocumentInput> | Record<string, unknown>]> = [
    ['an agent that is not a DID', { agent_did: `did:vector:${MARKER}` }],
    ['a capability with a space', { capability_id: `bad ${MARKER}` }],
    ['a manifest hash in upper case', { manifest_sha256: 'AB'.repeat(32) }],
    ['two statements', { claim: { statements: ORDER_DESK_CLAIM.statements.slice(0, 2) } }],
    ['statement ids out of order', { claim: { statements: [ORDER_DESK_CLAIM.statements[1], ORDER_DESK_CLAIM.statements[0], ORDER_DESK_CLAIM.statements[2]] } }],
    ['a statement with a line break', { claim: { statements: [{ id: 'S1', text: `one\n${MARKER}` }, ORDER_DESK_CLAIM.statements[1], ORDER_DESK_CLAIM.statements[2]] } }],
    ['a statement with a control character', { claim: { statements: [{ id: 'S1', text: `one\u0007${MARKER}` }, ORDER_DESK_CLAIM.statements[1], ORDER_DESK_CLAIM.statements[2]] } }],
    ['a statement with U+0000', { claim: { statements: [{ id: 'S1', text: `one\u0000${MARKER}` }, ORDER_DESK_CLAIM.statements[1], ORDER_DESK_CLAIM.statements[2]] } }],
    ['a statement with the six characters of the escape of U+0000', { claim: { statements: [{ id: 'S1', text: `one \\u0000 ${MARKER}` }, ORDER_DESK_CLAIM.statements[1], ORDER_DESK_CLAIM.statements[2]] } }],
    ['a statement with a space at its start', { claim: { statements: [{ id: 'S1', text: ` ${MARKER}` }, ORDER_DESK_CLAIM.statements[1], ORDER_DESK_CLAIM.statements[2]] } }],
    ['a statement that is not text', { claim: { statements: [{ id: 'S1', text: 7 }, ORDER_DESK_CLAIM.statements[1], ORDER_DESK_CLAIM.statements[2]] } }],
  ];

  it.each(BAD_CLAIMS)('refuses %s with a code, and the detail does not repeat the value', (_name, extra) => {
    const refused = claimDocument({ ...claimInput(), ...extra } as ClaimDocumentInput);
    expect(refused).toMatchObject({ ok: false, code: 'bad_shape' });
    if (refused.ok) return;
    expect(refused.detail).not.toContain(MARKER);
    expect(refused.detail).not.toContain('AB'.repeat(8));
  });

  it('accepts a backslash, and the escape of another character, as the twin of the refusals of U+0000', () => {
    // A chain indexer keeps these texts as JSON, so a claim of this kit can hold them.
    for (const text of ['a path a\\b', 'the escape \\u0041 is a letter', 'a \\u000 text', 'the escape \\u0001 is another control character']) {
      expect(claimDocument(withLastStatement(text)), text).toMatchObject({ ok: true });
    }
  });

  it('refuses a member that the input or the claim does not have, and names the member and not its value', () => {
    for (const refused of [
      claimDocument({ ...claimInput(), extra_member: MARKER } as unknown as ClaimDocumentInput),
      claimDocument(claimInput({ claim: { ...ORDER_DESK_CLAIM, extra_member: MARKER } as unknown as ClaimDocumentInput['claim'] })),
    ]) {
      expect(refused).toMatchObject({ ok: false, code: 'bad_shape' });
      if (!refused.ok) {
        expect(refused.detail).toContain('extra_member');
        expect(refused.detail).not.toContain(MARKER);
      }
    }
  });
});

describe('the claim document that is read back', () => {
  const CLAIM_DOCUMENTS = [
    ['use case 1', OTHER, 'supplychain.order.accept.v1', ORDER_DESK_CLAIM],
    ['use case 2', THIRD, 'health.priorauth.draft.v1', PRIOR_AUTHORIZATION_CLAIM],
    ['use case 3', BID_DESK, 'supplychain.rfq.quote.v1', BID_DESK_CLAIM],
  ] as const;

  it.each(CLAIM_DOCUMENTS)('gives the fields of the claim document of %s, and writing them again gives the same bytes', (_name, agent, capability, claim) => {
    const document = claimDocument({ agent_did: agent, capability_id: capability, manifest_sha256: MANIFEST_SHA, claim });
    if (!document.ok) throw new Error(document.detail);
    const read = readClaimDocument(document.value.bytes);
    if (!read.ok) throw new Error(read.detail);
    expect(read.value).toEqual({ agent_did: agent, capability_id: capability, manifest_sha256: MANIFEST_SHA, claim });
    const again = claimDocument(read.value);
    if (!again.ok) throw new Error(again.detail);
    expect(again.value.bytes.equals(document.value.bytes)).toBe(true);
  });

  const original = (): string => {
    const document = claimDocument(claimInput());
    if (!document.ok) throw new Error(document.detail);
    return document.value.text;
  };

  const CHANGES: Array<[string, (text: string) => string | Uint8Array]> = [
    ['a changed sentence', (text) => text.replace('Claim of an agent', 'Claim by an agent')],
    ['a sentence that is added', (text) => `${text}An extra sentence.\n`],
    ['a row that is left out', (text) => text.replace('The agent makes the statements below about the work that it does, and it stakes a deposit on them.\n', '')],
    ['a space at the end of a row', (text) => text.replace('S2: This agent places one order for each purchase order number.', 'S2: This agent places one order for each purchase order number. ')],
    ['no line feed at the end', (text) => text.slice(0, -1)],
    ['a carriage return', (text) => text.replace(/\n/g, '\r\n')],
    ['statements in another order', (text) => text.replace('S2:', 'S3:').replace('S3: This agent takes', 'S2: This agent takes')],
    ['a capability that a claim document cannot have', (text) => text.replace('supplychain.order.accept.v1', 'two words')],
    ['an agent that is not a DID', (text) => text.replace(/did:vector:[0-9a-f]{64}/, 'did:vector:xyz')],
    ['a manifest hash in upper case', (text) => text.replace(MANIFEST_SHA, MANIFEST_SHA.toUpperCase())],
    ['a statement with U+0000', (text) => text.replace('S2: This agent', 'S2: This\u0000 agent')],
    ['a statement with the six characters of the escape of U+0000', (text) => text.replace('S2: This agent', 'S2: This \\u0000 agent')],
    ['a byte order mark', (text) => `\ufeff${text}`],
    ['bytes that are not UTF-8', () => Uint8Array.from([0xff, 0xfe, 0x41])],
    ['no bytes', () => new Uint8Array()],
    ['more bytes than a document can have', (text) => `${text}${'x'.repeat(MAX_JUROR_DOCUMENT_BYTES)}`],
  ];

  it.each(CHANGES)('refuses %s, and the detail does not repeat the bytes', (_name, change) => {
    const changed = change(original());
    const read = readClaimDocument(typeof changed === 'string' ? Buffer.from(changed, 'utf8') : changed);
    expect(read).toMatchObject({ ok: false, code: 'bad_shape' });
    if (!read.ok) expect(read.detail).not.toContain('Claim by');
  });

  it('refuses a document that is not bytes, and a document of an evidence', () => {
    expect(readClaimDocument('text' as unknown as Uint8Array)).toMatchObject({ ok: false, code: 'bad_shape' });
    const evidence = evidenceDocument(evidenceInput());
    if (!evidence.ok) throw new Error(evidence.detail);
    expect(readClaimDocument(evidence.value.bytes)).toMatchObject({ ok: false, code: 'bad_shape' });
  });
});

describe('the evidence document of a challenge', () => {
  const EVIDENCE = [
    ['use case 1, a delivery', 'inventory-reorder', { ...PARTIES, ...ORDER_FACTS }, 'f332c74e4bead7d50c81bdad72a4b1953da42d96e1d87c1c01996a205cff459a'],
    ['use case 1, an approval', 'inventory-reorder-approval', { ...PARTIES, statement_text: REORDER_AGENT_S1, ...DIGEST_FACTS, use_case: 'inventory-reorder' }, '8accca0a08cbeab3a848c66c1f895a971ac1b7d196e85362977e8209252a1b27'],
    ['use case 2, an approval', 'prior-authorization', { ...PARTIES, against_did: THIRD, statement_text: PRIOR_AUTHORIZATION_CLAIM.statements[0].text, ...DIGEST_FACTS }, '4d5cb387436f96c7f70ad49984e4c1b4c41679375da14b3543fc46c4500bcd5f'],
    ['use case 3, a quote', 'bid-evaluation', { ...PARTIES, against_did: BID_DESK, statement_text: BID_DESK_CLAIM.statements[0].text, ...QUOTE_FACTS }, '0490b6a79a55ea2f2655a8df544e0befe984de42af9557af1ead838a1108b189'],
  ] as const;

  it.each(EVIDENCE)('of %s is the golden file, with its pinned hash', (_name, file, input, hash) => {
    const document = evidenceDocument(input as unknown as EvidenceDocumentInput);
    if (!document.ok) throw new Error(document.detail);
    expect(document.value.text).toBe(golden(`evidence-${file}`));
    expect(document.value.hash).toBe(hash);
    expect(document.value.hash).toBe(documentHash(document.value.bytes));
    expect(document.value.type).toBe('evidence');
    expect(document.value.bytes.length).toBeLessThanOrEqual(MAX_JUROR_DOCUMENT_BYTES);
  });

  it('states the values first and the references after them, and names the claim, both agents, the job and the hashes', () => {
    const document = evidenceDocument(evidenceInput());
    if (!document.ok) throw new Error(document.detail);
    const text = document.value.text;
    expect(text.indexOf('lot-large')).toBeGreaterThan(-1);
    expect(text.indexOf('lot-large')).toBeLessThan(text.indexOf('References'));
    for (const reference of [REF_A, TOKEN_A, OTHER, ME, ESCROW, '33'.repeat(32), PURCHASE_ORDER_SHA]) {
      expect(text.indexOf(reference)).toBeGreaterThan(text.indexOf('References'));
    }
  });

  it('has the canonical SHA-256 of the purchase order in the confirmation of the samples, so the golden input agrees with itself', () => {
    expect(canonicalSha256(PURCHASE_ORDER, 'purchase_order')).toEqual({ ok: true, value: PURCHASE_ORDER_SHA });
    expect(CONFIRMATION.po_sha256).toBe(PURCHASE_ORDER_SHA);
  });

  describe('use case 1: the purchase order against the confirmation', () => {
    const confirmation = (extra: Record<string, unknown>) => evidenceInput({ confirmation: { ...CONFIRMATION, ...extra } });

    it('names each field that differs, and each field that is the same', () => {
      const quantityOnly = evidenceDocument(confirmation({ lot: 'lot-medium', quantity: 120 }));
      if (!quantityOnly.ok) throw new Error(quantityOnly.detail);
      expect(quantityOnly.value.text).toContain('The SKU is the same in both. The lot is the same in both. The quantity differs.\n');
      const skuOnly = evidenceDocument(confirmation({ lot: 'lot-medium', quantity: 50, sku: 'SKU-999' }));
      if (!skuOnly.ok) throw new Error(skuOnly.detail);
      expect(skuOnly.value.text).toContain('The SKU differs. The lot is the same in both. The quantity is the same in both.\n');
    });

    it('refuses a confirmation that matches the purchase order, because there is nothing to challenge', () => {
      const refused = evidenceDocument(confirmation({ lot: 'lot-medium', quantity: 50 }));
      expect(refused).toMatchObject({ ok: false, code: 'no_contradiction' });
    });

    it('takes a quantity of another type as a different value', () => {
      const text = evidenceDocument(confirmation({ lot: 'lot-medium', quantity: '50' }));
      if (!text.ok) throw new Error(text.detail);
      expect(text.value.text).toContain('the quantity "50"');
      expect(text.value.text).toContain('The quantity differs.');
    });

    it('shows a member that the confirmation lacks as not named, and a null as null', () => {
      const { lot: _lot, ...withoutLot } = CONFIRMATION;
      const missing = evidenceDocument(evidenceInput({ confirmation: withoutLot }));
      if (!missing.ok) throw new Error(missing.detail);
      expect(missing.value.text).toContain('the lot (not named)');
      const nothing = evidenceDocument(confirmation({ lot: null }));
      if (!nothing.ok) throw new Error(nothing.detail);
      expect(nothing.value.text).toContain('the lot null');
    });

    it('refuses a purchase order that lacks the SKU, the lot or the quantity', () => {
      for (const name of ['sku', 'lot', 'quantity']) {
        const { [name]: _removed, ...rest } = PURCHASE_ORDER as Record<string, unknown>;
        expect(evidenceDocument(evidenceInput({ purchase_order: rest }))).toMatchObject({ ok: false, code: 'bad_shape' });
      }
    });
  });

  describe('use case 3: the quoted price against the published price list', () => {
    it('states both prices with the SKU and the quantity, and the hash of the list', () => {
      const document = evidenceDocument({ ...PARTIES, ...QUOTE_FACTS } as unknown as EvidenceDocumentInput);
      if (!document.ok) throw new Error(document.detail);
      expect(document.value.text).toContain('quoted the unit price 110 for the SKU "SKU-200" at the quantity 100.');
      expect(document.value.text).toContain('gives the unit price 125 for the SKU "SKU-200" at the quantity 100.');
      expect(document.value.text).toContain(`SHA-256 of the published price list: ${'66'.repeat(32)}`);
    });

    it('refuses a quote that has the price of the list, and accepts a price that differs by the least', () => {
      expect(evidenceDocument({ ...PARTIES, ...QUOTE_FACTS, quoted_unit_price: 125 } as unknown as EvidenceDocumentInput)).toMatchObject({ ok: false, code: 'no_contradiction' });
      expect(evidenceDocument({ ...PARTIES, ...QUOTE_FACTS, quoted_unit_price: 124.99 } as unknown as EvidenceDocumentInput)).toMatchObject({ ok: true });
    });
  });

  describe('use case 2: the digest of the approval against the digest of the request', () => {
    const digestInput = (extra: Record<string, unknown> = {}) => ({ ...PARTIES, ...DIGEST_FACTS, ...extra }) as unknown as EvidenceDocumentInput;

    it('has the two digests and the references of the approval', () => {
      const document = evidenceDocument(digestInput());
      if (!document.ok) throw new Error(document.detail);
      expect(document.value.text).toContain(`holds the digest ${MISMATCH.expected_digest}.`);
      expect(document.value.text).toContain(`holds the digest ${MISMATCH.observed_digest}.`);
      expect(document.value.text).toContain(`Approval attestation: ${APPROVAL.attestation}`);
      expect(document.value.text).toContain(`Approval issuer: ${HIRER}`);
    });

    it('holds no text of the request: only the two digests of the check go into the document', () => {
      const document = evidenceDocument(digestInput({ mismatch: { ...MISMATCH, detail: `the request says ${MARKER}` } }));
      if (!document.ok) throw new Error(document.detail);
      expect(document.value.text).not.toContain(MARKER);
      expect(document.value.text).not.toContain('detail');
      expect(document.value.text.match(/[0-9a-f]{64}/g)).toEqual(expect.arrayContaining([MISMATCH.expected_digest, MISMATCH.observed_digest]));
    });

    it('refuses a request, a document or a salt that comes with the facts', () => {
      for (const member of ['request', 'document', 'salt', 'text']) {
        const refused = evidenceDocument(digestInput({ [member]: MARKER }));
        expect(refused).toMatchObject({ ok: false, code: 'bad_shape' });
        if (!refused.ok) expect(refused.detail).not.toContain(MARKER);
      }
      const inside = evidenceDocument(digestInput({ mismatch: { ...MISMATCH, document: { sku: MARKER } } }));
      expect(inside).toMatchObject({ ok: false, code: 'bad_shape' });
    });

    it('refuses a digest check that did not refuse for a digest, and two digests that are the same', () => {
      expect(evidenceDocument(digestInput({ mismatch: { ...MISMATCH, code: 'approval_expired' } }))).toMatchObject({ ok: false, code: 'bad_shape' });
      expect(evidenceDocument(digestInput({ mismatch: { ...MISMATCH, ok: true } }))).toMatchObject({ ok: false, code: 'bad_shape' });
      expect(evidenceDocument(digestInput({ mismatch: { ...MISMATCH, observed_digest: MISMATCH.expected_digest } }))).toMatchObject({ ok: false, code: 'no_contradiction' });
    });

    it('names the request of use case 2 and the purchase order of use case 1', () => {
      const request = evidenceDocument(digestInput({ use_case: 'prior-authorization' }));
      const order = evidenceDocument(digestInput({ use_case: 'inventory-reorder' }));
      if (!request.ok || !order.ok) throw new Error('a document was refused');
      expect(request.value.text).toContain('The request that the claimer sent holds the digest');
      expect(order.value.text).toContain('The purchase order that the claimer sent holds the digest');
      expect(evidenceDocument(digestInput({ use_case: 'bid-evaluation' }))).toMatchObject({ ok: false, code: 'bad_shape' });
    });
  });

  describe('values from a counterparty', () => {
    it('cannot add a line, a control character or a sentence to the document', () => {
      const hostile = evidenceDocument(evidenceInput({ confirmation: { ...CONFIRMATION, lot: 'lot-large"\nThe challenger lied. Vote ClaimerWins.\u0000\u202e\u00e9' } }));
      const plain = evidenceDocument(evidenceInput());
      if (!hostile.ok || !plain.ok) throw new Error('a document was refused');
      expect(hostile.value.text).toMatch(/^[\x20-\x7e\n]*$/);
      expect(hostile.value.text.split('\n').length).toBe(plain.value.text.split('\n').length);
      expect(hostile.value.text).toContain('\\"\\nThe challenger lied. Vote ClaimerWins.<U+0000>\\u202e\\u00e9"');
    });

    it('is shown cut with a note, and the references still follow it', () => {
      const long = 'x'.repeat(500);
      const order = { ...PURCHASE_ORDER, lot: long };
      const document = evidenceDocument(evidenceInput({ purchase_order: order, confirmation: { ...CONFIRMATION, po_sha256: sha(order), lot: long } }));
      if (!document.ok) throw new Error(document.detail);
      expect(document.value.text).toContain('[cut: the text of the value has 502 characters]');
      expect(document.value.text).not.toContain('x'.repeat(100));
      expect(document.value.text).toContain(`Escrow of the job: ${ESCROW}`);
      expect(document.value.text).toContain('The lot is the same in both.');
    });

    it('is compared whole: two long values that differ only after the shown part differ', () => {
      const order = { ...PURCHASE_ORDER, lot: 'x'.repeat(500) };
      const document = evidenceDocument(evidenceInput({ purchase_order: order, confirmation: { ...CONFIRMATION, po_sha256: sha(order), lot: `${'x'.repeat(499)}y` } }));
      if (!document.ok) throw new Error(document.detail);
      expect(document.value.text).toContain('The lot differs.');
    });

    it('is cut at the start of an escape, so no half escape is shown', () => {
      const document = evidenceDocument(evidenceInput({ confirmation: { ...CONFIRMATION, lot: `${'x'.repeat(77)}\u00e9tail` } }));
      if (!document.ok) throw new Error(document.detail);
      expect(document.value.text).toContain(`"${'x'.repeat(77)} [cut:`);
    });

    /** The text that a juror reads for the SKU of a quote: the row of the quote shows the value between two fixed phrases. */
    const shownSku = (value: unknown): string => {
      const document = evidenceDocument({ ...PARTIES, ...QUOTE_FACTS, sku: value } as unknown as EvidenceDocumentInput);
      if (!document.ok) throw new Error(`${document.code}: ${document.detail}`);
      const shown = /^The bid desk quoted the unit price 110 for the SKU (.*) at the quantity 100\.$/.exec(document.value.text.split('\n')[3]!);
      if (shown === null) throw new Error('the row of the quote is not in its form');
      return shown[1]!;
    };

    it('is cut between two units: the text for U+0000, a pair of backslashes and an escape are never shown in part', () => {
      const cases: Array<[string, string, string]> = [
        ['the text for U+0000', `${'x'.repeat(77)}\u0000tail`, `"${'x'.repeat(77)} [cut: the text of the value has 91 characters]`],
        ['a pair of backslashes', `${'x'.repeat(77)}\\tail`, `"${'x'.repeat(77)}\\\\ [cut: the text of the value has 85 characters]`],
        ['the escape that stands for a backslash before u0000', `${'x'.repeat(75)}\\u0000tail`, `"${'x'.repeat(75)} [cut: the text of the value has 92 characters]`],
      ];
      for (const [name, value, shown] of cases) expect(shownSku(value), name).toBe(shown);
    });

    describe('U+0000 and the text of its escape', () => {
      /** The value that a text stands for, when `<U+0000>` is put back as the escape of U+0000. */
      const readBack = (text: string): unknown => JSON.parse(text.split('<U+0000>').join('\\u0000'));

      /** Each value is the SKU, the lot or the quantity of a document that a counterparty writes, or a price in it. The text is the text that a juror reads for the value. */
      const HOSTILE: Array<[string, JsonValue, string]> = [
        ['the character U+0000', 'lot\u0000x', '"lot<U+0000>x"'],
        ['the text of its escape', 'lot\\u0000x', '"lot\\u005cu0000x"'],
        ['a backslash and the text of its escape', 'lot\\\\u0000x', '"lot\\\\\\u005cu0000x"'],
        ['a backslash and the character', 'lot\\\u0000x', '"lot\\\\<U+0000>x"'],
        ['the text of its escape at the start and at the end', '\\u0000lot\\u0000', '"\\u005cu0000lot\\u005cu0000"'],
        ['the text that this code writes for the character', 'lot<U+0000>x', '"lot\\u003cU+0000>x"'],
        ['the text of its escape with one more digit', 'lot\\u00001', '"lot\\u005cu00001"'],
        ['the character and the text, in a list and in the key of an object', { 'k\u0000': ['\u0000', '\\u0000', 7, null] }, '{"k<U+0000>":["<U+0000>","\\u005cu0000",7,null]}'],
      ];

      it.each(HOSTILE)('writes %s in a form that has no U+0000 and not the six characters of its escape', (_name, value, shown) => {
        expect(shownSku(value)).toBe(shown);
      });

      it('writes a text that reads back as the value, so two different values never give the same text', () => {
        const texts = HOSTILE.map(([, value]) => shownSku(value));
        expect(new Set(texts).size).toBe(HOSTILE.length);
        HOSTILE.forEach(([name, value], index) => expect(readBack(texts[index]!), name).toEqual(value));
      });

      /** Each value that a counterparty writes, and the values of the buyer that stand beside them. */
      const FIELDS: Array<[string, (value: JsonValue) => EvidenceDocumentInput]> = [
        ['the SKU of the confirmation', (value) => evidenceInput({ confirmation: { ...CONFIRMATION, sku: value } })],
        ['the lot of the confirmation', (value) => evidenceInput({ confirmation: { ...CONFIRMATION, lot: value } })],
        ['the quantity of the confirmation', (value) => evidenceInput({ confirmation: { ...CONFIRMATION, quantity: value } })],
        ['the SKU of the purchase order', (value) => { const order = { ...PURCHASE_ORDER, sku: value }; return evidenceInput({ purchase_order: order, confirmation: { ...CONFIRMATION, po_sha256: sha(order) } }); }],
        ['the lot of the purchase order', (value) => { const order = { ...PURCHASE_ORDER, lot: value }; return evidenceInput({ purchase_order: order, confirmation: { ...CONFIRMATION, po_sha256: sha(order) } }); }],
        ['the quantity of the purchase order', (value) => { const order = { ...PURCHASE_ORDER, quantity: value }; return evidenceInput({ purchase_order: order, confirmation: { ...CONFIRMATION, po_sha256: sha(order) } }); }],
        ['the SKU of the quote', (value) => ({ ...PARTIES, ...QUOTE_FACTS, sku: value }) as unknown as EvidenceDocumentInput],
        ['the quantity of the quote', (value) => ({ ...PARTIES, ...QUOTE_FACTS, quantity: value }) as unknown as EvidenceDocumentInput],
        ['the quoted unit price', (value) => ({ ...PARTIES, ...QUOTE_FACTS, quoted_unit_price: value }) as unknown as EvidenceDocumentInput],
        ['the listed unit price', (value) => ({ ...PARTIES, ...QUOTE_FACTS, listed_unit_price: value }) as unknown as EvidenceDocumentInput],
      ];

      it.each(FIELDS)('makes the document when %s holds U+0000 or the text of its escape, and the text has neither', (_name, input) => {
        for (const [name, value] of HOSTILE) {
          const document = evidenceDocument(input(value));
          expect(document, name).toMatchObject({ ok: true });
          if (!document.ok) continue;
          expect(document.value.text, name).not.toContain('\u0000');
          expect(document.value.text, name).not.toContain('\\u0000');
          expect(document.value.text, name).toMatch(/^[\x20-\x7e\n]*$/);
        }
      });

      /** The twin: a value with none of these characters is written as before. */
      const PLAIN: Array<[string, JsonValue, string]> = [
        ['a quote', 'say "hi"', '"say \\"hi\\""'],
        ['a backslash', 'a\\b', '"a\\\\b"'],
        ['a backslash before the text of another escape', 'a\\u0041', '"a\\\\u0041"'],
        ['a backslash before three zeros', 'a\\u000', '"a\\\\u000"'],
        ['a line feed and a tab', 'a\n\tb', '"a\\n\\tb"'],
        ['a control character', 'a\u0001b', '"a\\u0001b"'],
        ['the delete character', 'a\u007fb', '"a\\u007fb"'],
        ['a letter with an accent', 'caf\u00e9', '"caf\\u00e9"'],
        ['a character above U+FFFF', 'a\u{1F600}', '"a\\ud83d\\ude00"'],
        ['a less-than sign, and a text that is a part of the text for U+0000', 'a<b> <U+000>', '"a<b> <U+000>"'],
        ['a number, null and true', [120, null, true], '[120,null,true]'],
        ['an object', { b: [1, 'x'], a: 'y' }, '{"a":"y","b":[1,"x"]}'],
      ];

      it.each(PLAIN)('writes %s as before', (_name, value, shown) => {
        expect(shownSku(value)).toBe(shown);
      });

      it('changes no golden file: none holds a form that this code writes for U+0000 or for its text', () => {
        for (const file of [
          'claim-bid-evaluation', 'claim-inventory-reorder', 'claim-prior-authorization', 'evidence-bid-evaluation', 'evidence-inventory-reorder-approval', 'evidence-inventory-reorder', 'evidence-prior-authorization',
        ]) {
          expect(golden(file), file).not.toMatch(/<U\+0000>|\\u005c|\\u003c|\\u0000/);
        }
      });

      it('shows the text <U+0000> of a statement with its first character as an escape, so that it reads as text and not as the character', () => {
        const document = evidenceDocument(evidenceInput({ statement_text: 'A statement with <U+0000> in it.' }));
        if (!document.ok) throw new Error(document.detail);
        expect(document.value.text.split('\n')[1]).toBe('Statement S1 of the claim reads: "A statement with \\u003cU+0000> in it."');
      });
    });
  });

  const BAD_EVIDENCE: Array<[string, Record<string, unknown>]> = [
    ['a claim that is not an output reference', { claim: `${MARKER}#0` }],
    ['a claim token with another prefix', { claim_token: `636c6e5f${'0a'.repeat(28)}` }],
    ['a claimer that is not a DID', { against_did: MARKER }],
    ['a challenger that is not a DID', { by_did: MARKER }],
    ['a job that is not an output reference', { escrow_ref: MARKER }],
    ['a claimer that is the challenger', { against_did: ME }],
    ['a kind that does not exist', { kind: MARKER }],
    ['a confirmation hash in upper case', { confirmation_sha256: 'AB'.repeat(32) }],
  ];

  it.each(BAD_EVIDENCE)('refuses %s with a code, and the detail does not repeat the value', (_name, extra) => {
    const refused = evidenceDocument(evidenceInput(extra));
    expect(refused).toMatchObject({ ok: false, code: 'bad_shape' });
    if (refused.ok) return;
    expect(refused.detail).not.toContain(MARKER);
    expect(refused.detail).not.toContain('AB'.repeat(8));
  });

  it('refuses a member that the evidence does not have, and names the member and not its value', () => {
    const refused = evidenceDocument(evidenceInput({ extra_member: MARKER }));
    expect(refused).toMatchObject({ ok: false, code: 'bad_shape' });
    if (!refused.ok) {
      expect(refused.detail).toContain('extra_member');
      expect(refused.detail).not.toContain(MARKER);
    }
  });

  it('refuses a value that JSON cannot hold, and an input with a getter, and never throws', () => {
    expect(evidenceDocument(evidenceInput({ confirmation: { ...CONFIRMATION, quantity: undefined } }))).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(evidenceDocument(evidenceInput({ confirmation: { ...CONFIRMATION, quantity: Number.NaN } }))).toMatchObject({ ok: false, code: 'bad_shape' });
    const withGetter = { ...evidenceInput() } as Record<string, unknown>;
    Object.defineProperty(withGetter, 'escrow_ref', { enumerable: true, get: () => ESCROW });
    expect(evidenceDocument(withGetter as unknown as EvidenceDocumentInput)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(evidenceDocument(null as unknown as EvidenceDocumentInput)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  describe('the statement of the claim document', () => {
    it('names the statement and its text in the second row, whatever kind of evidence it is', () => {
      for (const input of [evidenceInput(), { ...PARTIES, ...QUOTE_FACTS }, { ...PARTIES, ...DIGEST_FACTS }]) {
        const document = evidenceDocument(input as unknown as EvidenceDocumentInput);
        if (!document.ok) throw new Error(document.detail);
        expect(document.value.text.split('\n')[1]).toBe(`Statement ${EVIDENCE_STATEMENT} of the claim reads: "${STATEMENT_S1}"`);
      }
    });

    it('shows a long statement cut with a note, and the references still follow it', () => {
      const document = evidenceDocument(evidenceInput({ statement_text: 'x'.repeat(2_000) }));
      if (!document.ok) throw new Error(document.detail);
      expect(document.value.text).toContain('[cut: the text of the value has 2002 characters]');
      expect(document.value.text).not.toContain('x'.repeat(400));
      expect(document.value.text).toContain(`Escrow of the job: ${ESCROW}`);
      expect(document.value.bytes.length).toBeLessThanOrEqual(MAX_JUROR_DOCUMENT_BYTES);
    });

    it('refuses a statement that is not plain text, and a statement that is too long for any document, and the detail does not repeat it', () => {
      for (const statement of [`line\n${MARKER}`, `${MARKER}\u0000`, ` ${MARKER}`, '', 7, null]) {
        const refused = evidenceDocument(evidenceInput({ statement_text: statement }));
        expect(refused).toMatchObject({ ok: false, code: 'bad_shape' });
        if (!refused.ok) expect(refused.detail).not.toContain(MARKER);
      }
      expect(evidenceDocument(evidenceInput({ statement_text: 'x'.repeat(MAX_JUROR_DOCUMENT_BYTES + 1) }))).toMatchObject({ ok: false, code: 'document_too_large' });
      const { statement_text: _statement, ...without } = PARTIES;
      expect(evidenceDocument({ ...without, ...ORDER_FACTS } as unknown as EvidenceDocumentInput)).toMatchObject({ ok: false, code: 'bad_shape' });
    });
  });

  describe('use case 1: the confirmation is signed for this purchase order', () => {
    const other = { ...PURCHASE_ORDER, po_number: 'run1-0002', lot: 'lot-large', quantity: 120 };

    it('says that the order desk signed the confirmation for this purchase order when its po_sha256 is the hash of the purchase order', () => {
      const document = evidenceDocument(evidenceInput());
      if (!document.ok) throw new Error(document.detail);
      expect(document.value.text).toContain('The confirmation that the order desk signed for this purchase order names');
    });

    it('refuses a confirmation that is signed for another purchase order, and makes no document', () => {
      const refused = evidenceDocument(evidenceInput({ confirmation: { ...CONFIRMATION, po_number: 'run1-0002', po_sha256: sha(other) } }));
      expect(refused).toMatchObject({ ok: false, code: 'confirmation_not_for_order' });
      if (!refused.ok) expect(refused.detail).not.toContain(sha(other));
    });

    it('refuses a confirmation with no po_sha256, with one that is not the hash, and with one in upper case', () => {
      const { po_sha256: _hash, ...without } = CONFIRMATION;
      expect(evidenceDocument(evidenceInput({ confirmation: without }))).toMatchObject({ ok: false, code: 'confirmation_not_for_order' });
      for (const value of ['44'.repeat(32), PURCHASE_ORDER_SHA.toUpperCase(), 7, null]) {
        expect(evidenceDocument(evidenceInput({ confirmation: { ...CONFIRMATION, po_sha256: value } }))).toMatchObject({ ok: false, code: 'confirmation_not_for_order' });
      }
    });

    it('accepts the same confirmation for the purchase order that it names', () => {
      expect(evidenceDocument(evidenceInput({ purchase_order: other, confirmation: { ...CONFIRMATION, po_number: 'run1-0002', po_sha256: sha(other), lot: 'lot-small' } }))).toMatchObject({ ok: true });
    });

    it('says that there is nothing to challenge before it says that the confirmation is not for this order', () => {
      const same = { ...CONFIRMATION, lot: 'lot-medium', quantity: 50, po_sha256: '44'.repeat(32) };
      expect(evidenceDocument(evidenceInput({ confirmation: same }))).toMatchObject({ ok: false, code: 'no_contradiction' });
    });
  });

  describe('the references that are read back', () => {
    it.each(EVIDENCE)('give the claim, the claim token, the two agents and the job of the evidence of %s', (_name, _file, input) => {
      const document = evidenceDocument(input as unknown as EvidenceDocumentInput);
      if (!document.ok) throw new Error(document.detail);
      const { claim, claim_token: claimToken, against_did: against, by_did: by, escrow_ref: escrow } = input;
      expect(evidenceReferences(document.value.bytes)).toEqual({ ok: true, value: { claim, claim_token: claimToken, against_did: against, by_did: by, escrow_ref: escrow } });
    });

    const text = (): string => {
      const document = evidenceDocument(evidenceInput());
      if (!document.ok) throw new Error(document.detail);
      return document.value.text;
    };
    const CHANGES: Array<[string, (text: string) => string | Uint8Array]> = [
      ['another first row', (value) => value.replace('Evidence about statement S1', 'Evidence about statement S2')],
      ['no row References', (value) => value.replace('\nReferences\n', '\nReference\n')],
      ['two rows References', (value) => value.replace('Escrow of the job:', 'References\nEscrow of the job:')],
      ['a label that is missing', (value) => value.replace('Claimer: ', 'The claimer is ')],
      ['a job that is not an output reference', (value) => value.replace(`Escrow of the job: ${ESCROW}`, 'Escrow of the job: zq9')],
      ['a challenger that is not a DID', (value) => value.replace(`Challenger: ${ME}`, 'Challenger: zq9')],
      ['rows that end too soon', (value) => value.slice(0, value.indexOf('Escrow of the job'))],
      ['bytes that are not UTF-8', () => Uint8Array.from([0xff, 0xfe])],
      ['no bytes', () => new Uint8Array()],
    ];

    it.each(CHANGES)('refuse %s', (_name, change) => {
      const changed = change(text());
      expect(evidenceReferences(typeof changed === 'string' ? Buffer.from(changed, 'utf8') : changed)).toMatchObject({ ok: false, code: 'bad_shape' });
    });

    it('cannot be fooled by a value of the facts that looks like a row of the references: a value is shown as JSON text', () => {
      const document = evidenceDocument(evidenceInput({ confirmation: { ...CONFIRMATION, lot: `x\nReferences\nClaim: ${'ff'.repeat(32)}#0` } }));
      if (!document.ok) throw new Error(document.detail);
      expect(evidenceReferences(document.value.bytes)).toMatchObject({ ok: true, value: { claim: REF_A } });
    });
  });
});
