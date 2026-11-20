// packages/usecase-kit/test/protocol/support.ts
// The samples that the tests of the protocol share. Every value has the form that the protocol names. No value is a key or a real reference.

export const ID_A = 'ab'.repeat(32);
export const ID_B = 'cd'.repeat(32);
export const DID_A = `did:vector:${ID_A}`;
export const DID_B = `did:vector:${ID_B}`;
export const DELEGATION = '11'.repeat(32);
export const ATTESTATION = '22'.repeat(32);
export const SALT = '33'.repeat(32);
export const TXID = '44'.repeat(32);
export const REF = `${TXID}#0`;
export const TENANT = 'run1';

/** A purchase order, as the first use case writes it. */
export const DOCUMENT = {
  schema: 'vector.usecase.po.v1',
  po_number: 'run1-0001',
  tenant: TENANT,
  sku: 'SKU-100',
  lot: 'lot-medium',
  quantity: 50,
  needed_by: '2026-12-01',
  supplier_did: DID_B,
  advert_ref: REF,
  stock_reading_sha256: '55'.repeat(32),
} as const;

export const AUTHORITY = { principal_did: DID_A, delegation: DELEGATION } as const;
export const APPROVAL = { attestation: ATTESTATION, issuer_did: DID_A } as const;

/** A fresh deep copy, so that a test can change a member without changing the sample. */
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Text that is not in any sample: a refusal must never repeat the value that failed. */
export const MARKER = 'zq9-marker-value-7f3';

/** Text that no identifier form takes: it has a space, a slash and a hash sign. A refusal must never repeat it. */
export const BAD_MARKER = 'zq9 marker/value#7f3';
