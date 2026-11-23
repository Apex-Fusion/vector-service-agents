// packages/usecase-kit/test/buyer/message.test.ts: the message that a buyer-side agent sends to a counterparty, and the two size checks before the Pay: the wire payload that a service takes, and the
// body of the call that the runtime takes. The handoff holds the approved document, its salt and the approval reference exactly as the hirer gave them, and the approval can be null. The wire payload and
// the body are the ones that the hire kit builds after the Pay; the flow builds them before the Pay.
import { describe, expect, it } from 'vitest';
import { canonicalize, wirePayloadFor } from '@vsa/vector-read';
import { RUNTIME_BODY_LIMIT_BYTES as KIT_BODY_LIMIT_BYTES } from '@vsa/hire-kit';
import { HANDOFF_SCHEMA, MAX_REQUEST_BYTES, RFQ_SCHEMA, RUNTIME_BODY_LIMIT_BYTES, parseHandoff, parseRfq } from '@vsa/usecase-kit/protocol';
import { BODY_ESCROW_REF, checkRuntimeBody, checkWirePayload, handoffOf, messageOf, requestText, runtimeBody } from '@vsa/usecase-kit/buyer';
import { APPROVAL, BUYER_DID, COUNTERPARTY_DID, DELEGATION, PRINCIPAL_DID, SALT, executeRequest, purchaseOrder } from './support.ts';

const bodyBytes = (text: string): number => Buffer.byteLength(runtimeBody(text), 'utf8');

describe('handoffOf', () => {
  it('makes the handoff of the protocol from the request: the document, the salt and the approval are those of the hirer', () => {
    const request = executeRequest(purchaseOrder());
    const made = handoffOf({ use_case: 'inventory-reorder', agent_did: BUYER_DID, request });
    expect(made).toStrictEqual({
      ok: true,
      value: {
        schema: HANDOFF_SCHEMA, use_case: 'inventory-reorder', sender_did: BUYER_DID, delegation: DELEGATION, document: purchaseOrder(), salt: SALT, approval: APPROVAL,
      },
    });
    // The protocol parser takes the result: the counterparty reads the same message.
    if (!made.ok) throw new Error('refused');
    expect(parseHandoff(JSON.parse(requestText(made.value)))).toStrictEqual(made);
  });

  it('passes a null approval on as null: the agent does not check the approval, and the counterparty refuses it', () => {
    const made = handoffOf({ use_case: 'inventory-reorder', agent_did: BUYER_DID, request: executeRequest(purchaseOrder(), null) });
    expect(made.ok && made.value.approval).toBeNull();
    // The twin: an approval reference is passed on as it is, even one whose attestation is not the approval of this document.
    const other = { attestation: '99'.repeat(32), issuer_did: PRINCIPAL_DID };
    const withOther = handoffOf({ use_case: 'inventory-reorder', agent_did: BUYER_DID, request: executeRequest(purchaseOrder(), other) });
    expect(withOther.ok && withOther.value.approval).toStrictEqual(other);
  });

  it('makes a handoff for use case 2 (prior authorization) too, and refuses use case 3 (supplier bid evaluation), which has no handoff', () => {
    const request = executeRequest({ schema: 'vector.usecase.priorauth-request.v1', request_number: 'run1-0001', insurer_did: COUNTERPARTY_DID });
    expect(handoffOf({ use_case: 'prior-authorization', agent_did: BUYER_DID, request })).toMatchObject({ ok: true, value: { use_case: 'prior-authorization' } });
    expect(handoffOf({ use_case: 'bid-evaluation' as never, agent_did: BUYER_DID, request })).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('refuses a proposal whose digest is not the digest of its document and its salt: nothing that the hirer did not approve is sent', () => {
    const request = executeRequest(purchaseOrder());
    const changed = { ...request, proposal: { ...request.proposal, document: { ...request.proposal.document, quantity: 5_000 } } };
    expect(handoffOf({ use_case: 'inventory-reorder', agent_did: BUYER_DID, request: changed })).toMatchObject({ ok: false, code: 'bad_shape' });
    const wrongSalt = { ...request, proposal: { ...request.proposal, salt: '44'.repeat(32) } };
    expect(handoffOf({ use_case: 'inventory-reorder', agent_did: BUYER_DID, request: wrongSalt })).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(handoffOf({ use_case: 'inventory-reorder', agent_did: BUYER_DID, request })).toMatchObject({ ok: true });
  });

  it('refuses a DID of the agent that has not the form of the protocol', () => {
    const request = executeRequest(purchaseOrder());
    expect(handoffOf({ use_case: 'inventory-reorder', agent_did: 'did:vector:abc', request })).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('gives a copy: a change of the handoff does not change the request', () => {
    const request = executeRequest(purchaseOrder());
    const made = handoffOf({ use_case: 'inventory-reorder', agent_did: BUYER_DID, request });
    if (!made.ok) throw new Error('refused');
    (made.value.document as Record<string, unknown>).quantity = 1;
    expect(request.proposal.document.quantity).toBe(50);
  });
});

describe('messageOf', () => {
  const rfq = { schema: RFQ_SCHEMA, sender_did: BUYER_DID, delegation: DELEGATION, rfq: { rfq_id: 'rfq-1', items: [{ sku: 'SKU-100', quantity: 5 }] } };

  it('takes a handoff and a request for quotation, by their schema, and gives checked copies', () => {
    const handoff = handoffOf({ use_case: 'inventory-reorder', agent_did: BUYER_DID, request: executeRequest(purchaseOrder()) });
    expect(messageOf(handoff.ok ? handoff.value : null)).toStrictEqual(handoff);
    expect(messageOf(rfq)).toStrictEqual(parseRfq(rfq));
    expect(messageOf(rfq)).toMatchObject({ ok: true });
  });

  it('refuses a message of another schema, no schema, or no object', () => {
    for (const value of [undefined, null, 7, 'x', [], {}, { ...rfq, schema: 'vector.usecase.po.v1' }, { ...rfq, schema: undefined }]) {
      expect(messageOf(value), JSON.stringify(value)).toMatchObject({ ok: false, code: 'bad_shape' });
    }
  });

  it('refuses a message of the right schema whose members are wrong, and names no value', () => {
    const refused = messageOf({ ...rfq, sender_did: 'not a did SECRET-TEXT' });
    expect(refused).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(JSON.stringify(refused)).not.toContain('SECRET-TEXT');
  });
});

describe('requestText', () => {
  it('is the canonical text of the message: the order of the members of the document does not change it', () => {
    const a = handoffOf({ use_case: 'inventory-reorder', agent_did: BUYER_DID, request: executeRequest(purchaseOrder()) });
    const b = handoffOf({ use_case: 'inventory-reorder', agent_did: BUYER_DID, request: executeRequest(Object.fromEntries(Object.entries(purchaseOrder()).reverse())) });
    if (!a.ok || !b.ok) throw new Error('refused');
    expect(requestText(a.value)).toBe(requestText(b.value));
    expect(requestText(a.value)).toBe(canonicalize(a.value));
    expect(JSON.parse(requestText(a.value))).toStrictEqual(a.value);
  });
});

describe('runtimeBody and checkRuntimeBody', () => {
  it('builds the body as the hire kit sends it: the escrow reference of output 0, and the wire payload of the text', () => {
    const body = JSON.parse(runtimeBody('{"a":1}')) as Record<string, unknown>;
    expect(Object.keys(body)).toStrictEqual(['escrow_ref', 'payload']);
    expect(body.escrow_ref).toBe(BODY_ESCROW_REF);
    expect(body.payload).toBe(wirePayloadFor('{"a":1}'));
    expect(BODY_ESCROW_REF).toMatch(/^[0-9a-f]{64}#0$/);
  });

  it('counts bytes of UTF-8 and the escapes of the body: a quote mark is four bytes, and a character of three bytes is three', () => {
    const base = bodyBytes('');
    expect(bodyBytes('a'.repeat(10))).toBe(base + 10);
    expect(bodyBytes('"'.repeat(10))).toBe(base + 40);
    expect(bodyBytes('\\'.repeat(10))).toBe(base + 40);
    expect(bodyBytes('€'.repeat(10))).toBe(base + 30);
    expect(bodyBytes('\n'.repeat(10))).toBe(base + 30);
    expect(bodyBytes('\u0001'.repeat(10))).toBe(base + 70);
  });

  it('takes a body at the limit of the runtime and refuses a body of one byte more', () => {
    const base = bodyBytes('');
    const atLimit = 'a'.repeat(RUNTIME_BODY_LIMIT_BYTES - base);
    expect(bodyBytes(atLimit)).toBe(RUNTIME_BODY_LIMIT_BYTES);
    expect(checkRuntimeBody(atLimit)).toStrictEqual({ ok: true, value: RUNTIME_BODY_LIMIT_BYTES });
    const over = checkRuntimeBody(`${atLimit}a`);
    expect(over).toMatchObject({ ok: false, code: 'request_too_large' });
    expect(over.ok ? '' : over.detail).toBe(`the call to the counterparty has ${RUNTIME_BODY_LIMIT_BYTES + 1} bytes, and the runtime takes at most ${RUNTIME_BODY_LIMIT_BYTES} bytes`);
  });

  it('has the limit that the hire kit checks again before it pays: the number of the protocol and the number of the kit are the same', () => {
    expect(KIT_BODY_LIMIT_BYTES).toBe(RUNTIME_BODY_LIMIT_BYTES);
    expect(KIT_BODY_LIMIT_BYTES).toBe(1_048_576);
  });

  it('counts the bytes and not the characters at the limit', () => {
    const base = bodyBytes('');
    const fits = '€'.repeat(Math.floor((RUNTIME_BODY_LIMIT_BYTES - base) / 3));
    expect(checkRuntimeBody(fits).ok).toBe(true);
    // One more character of three bytes is over the limit, and it is far fewer characters than the limit.
    const over = checkRuntimeBody(`${fits}€`);
    expect(over).toMatchObject({ ok: false, code: 'request_too_large' });
    expect(fits.length).toBeLessThan(RUNTIME_BODY_LIMIT_BYTES / 2);
  });

  it('refuses a text of quote marks that is far below the limit as a text and far above it as a body', () => {
    const quotes = '"'.repeat(RUNTIME_BODY_LIMIT_BYTES / 4);
    expect(Buffer.byteLength(quotes)).toBeLessThan(RUNTIME_BODY_LIMIT_BYTES);
    expect(checkRuntimeBody(quotes)).toMatchObject({ ok: false, code: 'request_too_large' });
    expect(checkRuntimeBody('"'.repeat(1_000)).ok).toBe(true);
  });
});

describe('checkWirePayload', () => {
  const wireBytes = (text: string): number => Buffer.byteLength(wirePayloadFor(text), 'utf8');

  it('takes a wire payload at the limit of a service and refuses one byte more, with the detail of the protocol', () => {
    const atLimit = 'a'.repeat(MAX_REQUEST_BYTES - wireBytes(''));
    expect(wireBytes(atLimit)).toBe(MAX_REQUEST_BYTES);
    expect(checkWirePayload(atLimit)).toStrictEqual({ ok: true, value: MAX_REQUEST_BYTES });
    expect(checkWirePayload(`${atLimit}a`)).toStrictEqual({
      ok: false, code: 'request_too_large', detail: `the request has ${MAX_REQUEST_BYTES + 1} bytes, and a service takes at most ${MAX_REQUEST_BYTES} bytes`,
    });
  });

  it('counts the bytes of the wire payload and not the text: a quote mark is two bytes of it, and a character of three bytes is three', () => {
    const base = wireBytes('');
    expect(wireBytes('"'.repeat(10))).toBe(base + 20);
    expect(wireBytes('€'.repeat(10))).toBe(base + 30);
    // A text of quote marks that is under the limit as a text and over it as a wire payload.
    const quotes = '"'.repeat(MAX_REQUEST_BYTES / 2);
    expect(Buffer.byteLength(quotes)).toBeLessThan(MAX_REQUEST_BYTES);
    expect(checkWirePayload(quotes)).toMatchObject({ ok: false, code: 'request_too_large' });
    expect(checkWirePayload('"'.repeat(1_000)).ok).toBe(true);
  });
});
