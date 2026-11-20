// The bodies of the writes. Each reader gives a new object with the fields that it knows. A document that names another tenant than the one of the URL is refused. Each refusal has its
// accepted twin, and a value of the wrong type is an error that names its path.
import { describe, expect, it } from 'vitest';
import { parseIntake, parsePurchaseOrder, parseRanking, parseSubmission, parseSupplierOrder } from '../src/documents.ts';
import { Invalid } from '../src/validate.ts';

const DID_A = `did:vector:${'a1'.repeat(32)}`;
const DID_B = `did:vector:${'b2'.repeat(32)}`;
const REF = `${'c3'.repeat(32)}#0`;

const problem = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(Invalid);
    return (error as Invalid).message;
  }
  throw new Error('the document was accepted');
};

const purchaseOrder = () => ({
  schema: 'vector.usecase.po.v1', po_number: 'run1-1', tenant: 'run1', sku: 'GLV-NIT-M', lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01', supplier_did: DID_A, advert_ref: REF,
  stock_reading_sha256: 'd4'.repeat(32),
});

describe('the purchase order of the PO store', () => {
  it('is read field by field', () => {
    expect(parsePurchaseOrder(purchaseOrder(), 'run1')).toEqual(purchaseOrder());
  });
  it('refuses another tenant, another schema, a field that is not named and a missing field', () => {
    expect(problem(() => parsePurchaseOrder(purchaseOrder(), 'run2'))).toBe('body.tenant must be the tenant of the URL');
    expect(problem(() => parsePurchaseOrder({ ...purchaseOrder(), schema: 'vector.usecase.po.v2' }, 'run1'))).toBe('body.schema must be vector.usecase.po.v1');
    expect(problem(() => parsePurchaseOrder({ ...purchaseOrder(), note: 'x' }, 'run1'))).toBe('body.note is not a field of this object');
    const { lot: _lot, ...short } = purchaseOrder();
    expect(problem(() => parsePurchaseOrder(short, 'run1'))).toBe('body.lot is required');
  });
  it('refuses a value of the wrong type or form', () => {
    expect(problem(() => parsePurchaseOrder({ ...purchaseOrder(), quantity: '50' }, 'run1'))).toBe('body.quantity must be a whole number from 1 to 1000000');
    expect(problem(() => parsePurchaseOrder({ ...purchaseOrder(), quantity: 0 }, 'run1'))).toBe('body.quantity must be a whole number from 1 to 1000000');
    expect(problem(() => parsePurchaseOrder({ ...purchaseOrder(), lot: 'lot-huge' }, 'run1'))).toBe('body.lot must be one of lot-small, lot-medium, lot-large');
    expect(problem(() => parsePurchaseOrder({ ...purchaseOrder(), needed_by: '2026-12-32' }, 'run1'))).toBe('body.needed_by must be a date that exists');
    expect(problem(() => parsePurchaseOrder({ ...purchaseOrder(), supplier_did: 'did:vector:x' }, 'run1'))).toMatch(/^body\.supplier_did must be a DID/);
    expect(problem(() => parsePurchaseOrder({ ...purchaseOrder(), advert_ref: 'abc#0' }, 'run1'))).toMatch(/^body\.advert_ref must be a reference/);
    expect(problem(() => parsePurchaseOrder({ ...purchaseOrder(), po_number: 'a b' }, 'run1'))).toMatch(/^body\.po_number must be 1 to 64/);
  });
});

describe('the order of the supplier portal', () => {
  const order = () => ({ po_number: 'run1-1', po_sha256: 'e5'.repeat(32), sku: 'GLV-NIT-M', lot: 'lot-medium', quantity: 50, ship_by: '2026-11-28' });
  it('is read field by field', () => {
    expect(parseSupplierOrder(order())).toEqual(order());
  });
  it('refuses the wrong type, a field that is not named and a lot that is not one of the three', () => {
    expect(problem(() => parseSupplierOrder({ ...order(), quantity: 50.5 }))).toBe('body.quantity must be a whole number from 1 to 1000000');
    expect(problem(() => parseSupplierOrder({ ...order(), tenant: 'run1' }))).toBe('body.tenant is not a field of this object');
    expect(problem(() => parseSupplierOrder({ ...order(), lot: 'medium' }))).toBe('body.lot must be one of lot-small, lot-medium, lot-large');
  });
});

describe('the submission of the records system', () => {
  it('has a request number and an intake reference, and a status or none', () => {
    expect(parseSubmission({ request_number: 'run1-1', intake_id: 'INT-run1-0001' })).toEqual({ request_number: 'run1-1', intake_id: 'INT-run1-0001', status: null });
    expect(parseSubmission({ request_number: 'run1-1', intake_id: 'INT-run1-0001', status: 'incomplete' }).status).toBe('incomplete');
  });
  it('refuses a status that is not one of the two, and a missing reference', () => {
    expect(problem(() => parseSubmission({ request_number: 'run1-1', intake_id: 'INT-run1-0001', status: 'done' }))).toBe('body.status must be one of complete, incomplete');
    expect(problem(() => parseSubmission({ request_number: 'run1-1' }))).toBe('body.intake_id is required');
  });
});

describe('the request of the insurer portal', () => {
  const request = () => ({ schema: 'vector.usecase.priorauth-request.v1', request_number: 'run1-1', tenant: 'run1', service_code: 'SYN-MRI-LS', justification: 'text' });
  it('keeps the request as it came, and reads the status and the list of what is missing', () => {
    const body = { request: request(), status: 'incomplete', missing: ['R3'] };
    const parsed = parseIntake(body, 'run1');
    expect(parsed.request).toBe(body.request);
    expect(parsed).toMatchObject({ request_number: 'run1-1', service_code: 'SYN-MRI-LS', status: 'incomplete', missing: ['R3'] });
  });
  it('refuses another tenant, another schema, a status that is not one of the two and a list that is a text', () => {
    expect(problem(() => parseIntake({ request: request(), status: 'complete', missing: [] }, 'run2'))).toBe('body.request.tenant must be the tenant of the URL');
    expect(problem(() => parseIntake({ request: { ...request(), schema: 'x' }, status: 'complete', missing: [] }, 'run1'))).toBe('body.request.schema must be vector.usecase.priorauth-request.v1');
    expect(problem(() => parseIntake({ request: request(), status: 'maybe', missing: [] }, 'run1'))).toBe('body.status must be one of complete, incomplete');
    expect(problem(() => parseIntake({ request: request(), status: 'complete', missing: 'R3' }, 'run1'))).toBe('body.missing must be a list');
    expect(problem(() => parseIntake({ request: 'text', status: 'complete', missing: [] }, 'run1'))).toBe('body.request must be a JSON object');
  });
});

describe('the ranking of the sourcing record', () => {
  const ranking = () => ({
    schema: 'vector.usecase.ranking.v1', rfq_id: 'rfq-1', tenant: 'run1', ranked: [{ rank: 2, desk_did: DID_B, organisation: 'bravo.example.org' }, { rank: 1, desk_did: DID_A, organisation: 'alfa.example.org' }], excluded: [],
  });
  const body = () => ({ ranking: ranking(), salt: 'f6'.repeat(32), approval: { attestation: '07'.repeat(32), issuer_did: DID_B } });

  it('takes the supplier of rank 1, and keeps the ranking exactly as it was sent: its digest depends on it', () => {
    const sent = body();
    const parsed = parseRanking(sent, 'run1');
    expect(parsed.ranking).toBe(sent.ranking);
    expect(parsed).toMatchObject({ rfq_id: 'rfq-1', top: DID_A, topOrganisation: 'alfa.example.org', salt: 'f6'.repeat(32), approval: { attestation: '07'.repeat(32), issuer_did: DID_B } });
  });
  it('takes a null approval as null, so that the route can refuse it', () => {
    expect(parseRanking({ ...body(), approval: null }, 'run1').approval).toBeNull();
  });
  it('refuses a body with no approval field: null says that none was given, and a missing field says nothing', () => {
    const { approval: _approval, ...without } = body();
    expect(problem(() => parseRanking(without, 'run1'))).toBe('body.approval is required');
  });
  it('refuses another tenant, another schema, no entry of rank 1, two of them, and two entries of one rank', () => {
    expect(problem(() => parseRanking(body(), 'run2'))).toBe('body.ranking.tenant must be the tenant of the URL');
    expect(problem(() => parseRanking({ ...body(), ranking: { ...ranking(), schema: 'x' } }, 'run1'))).toBe('body.ranking.schema must be vector.usecase.ranking.v1');
    expect(problem(() => parseRanking({ ...body(), ranking: { ...ranking(), ranked: [{ rank: 2, desk_did: DID_A }] } }, 'run1'))).toBe('body.ranking.ranked must have one entry with rank 1');
    expect(problem(() => parseRanking({ ...body(), ranking: { ...ranking(), ranked: [{ rank: 1, desk_did: DID_A }, { rank: 1, desk_did: DID_B }] } }, 'run1'))).toBe('body.ranking.ranked has the rank 1 two times');
    expect(problem(() => parseRanking({ ...body(), ranking: { ...ranking(), ranked: [] } }, 'run1'))).toBe('body.ranking.ranked must have 1 to 20 items');
  });
  it('refuses a rank that is not a whole number, a desk that is no DID, a salt that is not 64 hex characters, and an approval of the wrong form', () => {
    expect(problem(() => parseRanking({ ...body(), ranking: { ...ranking(), ranked: [{ rank: '1', desk_did: DID_A }] } }, 'run1'))).toBe('body.ranking.ranked[0].rank must be a whole number from 1 to 1000');
    expect(problem(() => parseRanking({ ...body(), ranking: { ...ranking(), ranked: [{ rank: 1, desk_did: 'did:vector:abc' }] } }, 'run1'))).toMatch(/^body\.ranking\.ranked\[0\]\.desk_did must be a DID/);
    expect(problem(() => parseRanking({ ...body(), salt: 'abc' }, 'run1'))).toBe('body.salt must have 64 characters');
    expect(problem(() => parseRanking({ ...body(), salt: 'zz'.repeat(32) }, 'run1'))).toBe('body.salt must be 64 lower case hex characters');
    expect(problem(() => parseRanking({ ...body(), approval: { attestation: '07'.repeat(32) } }, 'run1'))).toBe('body.approval.issuer_did is required');
    expect(problem(() => parseRanking({ ...body(), approval: 'yes' }, 'run1'))).toBe('body.approval must be a JSON object');
    expect(problem(() => parseRanking({ ...body(), approval: { attestation: '07'.repeat(32), issuer_did: DID_B, extra: 1 } }, 'run1'))).toBe('body.approval.extra is not a field of this object');
  });
});
