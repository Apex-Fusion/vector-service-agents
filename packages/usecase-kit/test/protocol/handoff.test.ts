// packages/usecase-kit/test/protocol/handoff.test.ts: the two messages that a buyer-side agent sends to a counterparty. The handoff carries the approved document, its salt and the approval reference.
// The request for quotation carries no approval, because the buyer approves the ranking and not the request. Each refusal has an accepted twin.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { HANDOFF_SCHEMA, HANDOFF_USE_CASES, PROPOSAL_SCHEMA, RESULT_SCHEMA, RFQ_SCHEMA, parseHandoff, parseRfq } from '@vsa/usecase-kit/protocol';
import type { Handoff, RfqMessage } from '@vsa/usecase-kit/protocol';
import { APPROVAL, BAD_MARKER, DELEGATION, DID_A, DOCUMENT, MARKER, SALT, copy } from './support.ts';

const HANDOFF = { schema: 'vector.usecase.handoff.v1', use_case: 'inventory-reorder', sender_did: DID_A, delegation: DELEGATION, document: DOCUMENT, salt: SALT, approval: APPROVAL };
const RFQ = {
  schema: 'vector.usecase.rfq.v1',
  sender_did: DID_A,
  delegation: DELEGATION,
  rfq: { rfq_id: 'rfq-1', items: [{ sku: 'SKU-100', quantity: 100 }, { sku: 'SKU-200', quantity: 5 }], needed_by: '2026-12-20' },
};

function refusal(result: { ok: boolean; code?: string; detail?: string }): { code: string; detail: string } {
  expect(result.ok).toBe(false);
  return { code: result.code ?? '', detail: result.detail ?? '' };
}

describe('the schema names', () => {
  it('are the names of the protocol, one for each message', () => {
    expect(HANDOFF_SCHEMA).toBe('vector.usecase.handoff.v1');
    expect(RFQ_SCHEMA).toBe('vector.usecase.rfq.v1');
    expect(PROPOSAL_SCHEMA).toBe('vector.usecase.proposal.v1');
    expect(RESULT_SCHEMA).toBe('vector.usecase.result.v1');
  });
});

describe('parseHandoff', () => {
  it('takes a handoff with an approval and gives its members, with the approval as a new object', () => {
    const result = parseHandoff(copy(HANDOFF));
    expect(result).toStrictEqual({ ok: true, value: HANDOFF });
    expect(result.ok && result.value.approval).not.toBe(HANDOFF.approval);
  });

  it('takes a handoff with a null approval, because the buyer-side agent passes a null approval on', () => {
    expect(parseHandoff({ ...copy(HANDOFF), approval: null })).toStrictEqual({ ok: true, value: { ...HANDOFF, approval: null } });
  });

  it.each(HANDOFF_USE_CASES)('takes the use case %s', (useCase) => {
    expect(parseHandoff({ ...copy(HANDOFF), use_case: useCase }).ok).toBe(true);
  });

  it('refuses the use case bid-evaluation, which has no handoff, and takes the other two use cases', () => {
    const refused = parseHandoff({ ...copy(HANDOFF), use_case: 'bid-evaluation' });
    expect(refused).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(!refused.ok && refused.detail).toBe('handoff.use_case must be one of inventory-reorder, prior-authorization');
    for (const useCase of HANDOFF_USE_CASES) expect(parseHandoff({ ...copy(HANDOFF), use_case: useCase }).ok).toBe(true);
  });

  it('takes the members in any order', () => {
    const shuffled = { approval: APPROVAL, salt: SALT, document: DOCUMENT, delegation: DELEGATION, sender_did: DID_A, use_case: 'prior-authorization', schema: HANDOFF_SCHEMA };
    expect(parseHandoff(shuffled).ok).toBe(true);
  });

  it.each([
    ['no schema', (h: Record<string, unknown>) => ({ ...h, schema: undefined }), 'handoff.schema must be "vector.usecase.handoff.v1"'],
    ['the schema of another message', (h: Record<string, unknown>) => ({ ...h, schema: RFQ_SCHEMA }), 'handoff.schema must be "vector.usecase.handoff.v1"'],
    ['the next version of the schema', (h: Record<string, unknown>) => ({ ...h, schema: 'vector.usecase.handoff.v2' }), 'handoff.schema must be'],
    ['a schema in upper case', (h: Record<string, unknown>) => ({ ...h, schema: HANDOFF_SCHEMA.toUpperCase() }), 'handoff.schema must be'],
    ['a use case that is not known', (h: Record<string, unknown>) => ({ ...h, use_case: 'inventory' }), 'handoff.use_case must be one of'],
    ['a use case with underscores', (h: Record<string, unknown>) => ({ ...h, use_case: 'bid_evaluation' }), 'handoff.use_case must be one of'],
    ['a use case that is a number', (h: Record<string, unknown>) => ({ ...h, use_case: 1 }), 'handoff.use_case must be one of'],
    ['a sender that is not a DID', (h: Record<string, unknown>) => ({ ...h, sender_did: 'ab'.repeat(32) }), 'handoff.sender_did must be'],
    ['a delegation that is short', (h: Record<string, unknown>) => ({ ...h, delegation: '11'.repeat(31) }), 'handoff.delegation must be'],
    ['a salt in upper case', (h: Record<string, unknown>) => ({ ...h, salt: 'AB'.repeat(32) }), 'handoff.salt must be'],
    ['a document that is an array', (h: Record<string, unknown>) => ({ ...h, document: [DOCUMENT] }), 'handoff.document must be a JSON object'],
    ['a document with the key __proto__', (h: Record<string, unknown>) => ({ ...h, document: JSON.parse('{"__proto__":1}') }), 'handoff.document.__proto__'],
    ['a document with a value that JSON cannot hold', (h: Record<string, unknown>) => ({ ...h, document: { a: Number.NaN } }), 'handoff.document.a'],
    ['an approval that is a string', (h: Record<string, unknown>) => ({ ...h, approval: 'abc' }), 'handoff.approval must be a JSON object'],
    ['an approval with no issuer', (h: Record<string, unknown>) => ({ ...h, approval: { attestation: APPROVAL.attestation } }), 'handoff.approval has no member "issuer_did"'],
    ['an approval that is undefined', (h: Record<string, unknown>) => ({ ...h, approval: undefined }), 'handoff.approval must be a JSON object'],
    ['an approval with a short attestation', (h: Record<string, unknown>) => ({ ...h, approval: { ...APPROVAL, attestation: 'aa' } }), 'handoff.approval.attestation must be'],
    ['a digest of the proposal, which a handoff does not carry', (h: Record<string, unknown>) => ({ ...h, proposal_digest: SALT }), 'handoff has the member "proposal_digest", which is not allowed'],
    ['a tenant, which a handoff does not carry', (h: Record<string, unknown>) => ({ ...h, tenant: 'run1' }), 'handoff has the member "tenant", which is not allowed'],
  ])('refuses %s, and takes the handoff without that change', (_name, change, expected) => {
    expect(refusal(parseHandoff(change(copy(HANDOFF)))).detail).toContain(expected);
    expect(parseHandoff(copy(HANDOFF)).ok).toBe(true);
  });

  it.each(['schema', 'use_case', 'sender_did', 'delegation', 'document', 'salt', 'approval'])('refuses a handoff with no member %s, and names it', (name) => {
    const handoff: Record<string, unknown> = copy(HANDOFF);
    delete handoff[name];
    expect(refusal(parseHandoff(handoff))).toStrictEqual({ code: 'bad_shape', detail: `handoff has no member "${name}"` });
  });

  it.each([null, undefined, [], [HANDOFF], 'text', 7, true, new Map()])('refuses %s as the handoff', (value) => {
    expect(refusal(parseHandoff(value))).toStrictEqual({ code: 'bad_shape', detail: 'handoff must be a JSON object' });
  });

  it('refuses the key __proto__ as a member', () => {
    const handoff = JSON.parse(`${JSON.stringify(HANDOFF).slice(0, -1)},"__proto__":{"x":1}}`);
    expect(refusal(parseHandoff(handoff)).detail).toBe('handoff has the member "__proto__", which is not allowed');
  });

  it('refuses a request for quotation, and a request for quotation refuses a handoff', () => {
    expect(parseHandoff(copy(RFQ)).ok).toBe(false);
    expect(parseRfq(copy(HANDOFF)).ok).toBe(false);
  });

  it('does not throw on any input, never repeats a value, and keeps the detail short', () => {
    const hostile = JSON.parse(`${'['.repeat(100_000)}${']'.repeat(100_000)}`);
    const circular: Record<string, unknown> = { ...HANDOFF };
    circular.document = circular;
    for (const input of [{ ...HANDOFF, document: hostile }, circular, { ...HANDOFF, ['m'.repeat(100_000)]: 1 }, { ...HANDOFF, salt: BAD_MARKER }, { ...HANDOFF, sender_did: MARKER }]) {
      expect(() => parseHandoff(input)).not.toThrow();
      const result = parseHandoff(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.detail).not.toContain(BAD_MARKER);
        expect(result.detail).not.toContain(MARKER);
        expect(result.detail.length).toBeLessThan(300);
      }
    }
  });

  it('has a type that holds a null approval', () => {
    expectTypeOf<Handoff['approval']>().toEqualTypeOf<{ readonly attestation: string; readonly issuer_did: string } | null>();
    expectTypeOf<Handoff['schema']>().toEqualTypeOf<'vector.usecase.handoff.v1'>();
  });
});

describe('parseRfq', () => {
  it('takes a request for quotation, and the rfq object is a copy', () => {
    const input = copy(RFQ);
    const result = parseRfq(input);
    expect(result).toStrictEqual({ ok: true, value: RFQ });
    expect(result.ok && result.value.rfq).not.toBe(input.rfq);
  });

  it('takes the members in any order', () => {
    expect(parseRfq({ rfq: RFQ.rfq, delegation: DELEGATION, sender_did: DID_A, schema: RFQ_SCHEMA }).ok).toBe(true);
  });

  it.each([
    ['an approval, because a request for quotation carries none', (r: Record<string, unknown>) => ({ ...r, approval: APPROVAL }), 'request has the member "approval", which is not allowed'],
    ['a null approval', (r: Record<string, unknown>) => ({ ...r, approval: null }), 'request has the member "approval", which is not allowed'],
    ['a use case, which belongs to the handoff', (r: Record<string, unknown>) => ({ ...r, use_case: 'bid-evaluation' }), 'request has the member "use_case", which is not allowed'],
    ['a salt', (r: Record<string, unknown>) => ({ ...r, salt: SALT }), 'request has the member "salt", which is not allowed'],
    ['the schema of the handoff', (r: Record<string, unknown>) => ({ ...r, schema: HANDOFF_SCHEMA }), 'request.schema must be "vector.usecase.rfq.v1"'],
    ['no schema', (r: Record<string, unknown>) => ({ ...r, schema: undefined }), 'request.schema must be "vector.usecase.rfq.v1"'],
    ['a sender that is not a DID', (r: Record<string, unknown>) => ({ ...r, sender_did: 'x' }), 'request.sender_did must be'],
    ['a delegation that is not 64 hex characters', (r: Record<string, unknown>) => ({ ...r, delegation: 'x' }), 'request.delegation must be'],
    ['an rfq that is an array', (r: Record<string, unknown>) => ({ ...r, rfq: [1] }), 'request.rfq must be a JSON object'],
    ['an rfq that is a string', (r: Record<string, unknown>) => ({ ...r, rfq: 'rfq-1' }), 'request.rfq must be a JSON object'],
    ['an rfq with the key __proto__', (r: Record<string, unknown>) => ({ ...r, rfq: JSON.parse('{"rfq_id":"a","__proto__":{}}') }), 'request.rfq.__proto__'],
    ['an rfq with a value that JSON cannot hold', (r: Record<string, unknown>) => ({ ...r, rfq: { items: [{ quantity: undefined }] } }), 'request.rfq.items[0].quantity'],
  ])('refuses %s, and takes the request without that change', (_name, change, expected) => {
    expect(refusal(parseRfq(change(copy(RFQ)))).detail).toContain(expected);
    expect(parseRfq(copy(RFQ)).ok).toBe(true);
  });

  it.each(['schema', 'sender_did', 'delegation', 'rfq'])('refuses a request with no member %s, and names it', (name) => {
    const request: Record<string, unknown> = copy(RFQ);
    delete request[name];
    expect(refusal(parseRfq(request))).toStrictEqual({ code: 'bad_shape', detail: `request has no member "${name}"` });
  });

  it.each([null, undefined, [], 'text', 7])('refuses %s as the request', (value) => {
    expect(refusal(parseRfq(value))).toStrictEqual({ code: 'bad_shape', detail: 'request must be a JSON object' });
  });

  it('does not throw on hostile input and never repeats a value', () => {
    const hostile = JSON.parse(`${'['.repeat(100_000)}${']'.repeat(100_000)}`);
    for (const input of [{ ...RFQ, rfq: hostile }, { ...RFQ, sender_did: BAD_MARKER }, { ...RFQ, rfq: { a: [MARKER, undefined] } }]) {
      expect(() => parseRfq(input)).not.toThrow();
      const result = parseRfq(input);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.detail).not.toContain(BAD_MARKER);
      expect(!result.ok && result.detail).not.toContain(MARKER);
    }
  });

  it('has a type with no approval', () => {
    expectTypeOf<RfqMessage>().toHaveProperty('rfq');
    expectTypeOf<RfqMessage>().not.toHaveProperty('approval');
    expectTypeOf<RfqMessage['schema']>().toEqualTypeOf<'vector.usecase.rfq.v1'>();
  });
});
