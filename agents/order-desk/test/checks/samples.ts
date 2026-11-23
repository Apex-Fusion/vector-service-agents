// agents/order-desk/test/checks/samples.ts
// The values that the tests of the hook share and that need no ledger: the DID of the Order Desk, a purchase order and the handoff that carries it, the job context of the runtime, and the path of the
// lots file of the package. Every value has the form that the protocol names. No value is a key.
import { fileURLToPath } from 'node:url';
import type { JobContext } from '@vsa/service-kit';
import { PO_SCHEMA } from '@vsa/usecase-kit/inventory';
import { HANDOFF_SCHEMA } from '@vsa/usecase-kit/protocol';
import type { Document, Handoff, JsonValue } from '@vsa/usecase-kit/protocol';

/** The lots file of the package, as the Order Desk serves it. */
export const LOTS_PATH = fileURLToPath(new URL('../../lots.json', import.meta.url));

/** The DID of the Order Desk: the supplier that a purchase order must name. */
export const SELF = `did:vector:${'a1'.repeat(32)}`;
export const OTHER_DID = `did:vector:${'f2'.repeat(32)}`;
/** The advert that the escrow of the samples was posted on, and another advert. */
export const ADVERT_REF = `${'d4'.repeat(32)}#1`;
export const OTHER_ADVERT_REF = `${'d5'.repeat(32)}#1`;
export const ESCROW_REF = `${'e7'.repeat(32)}#0`;
export const BUYER_PKH = '0b'.repeat(28);

/** A purchase order that passes the four checks of the Order Desk for the context below: this supplier, the advert of the context, and the size of the medium lot of the SKU. */
export const PURCHASE_ORDER: Document = {
  schema: PO_SCHEMA, po_number: 'run1-0001', tenant: 'run1', sku: 'GLV-NIT-M', lot: 'lot-medium', quantity: 50, needed_by: '2026-12-05', supplier_did: SELF, advert_ref: ADVERT_REF,
  stock_reading_sha256: 'ab'.repeat(32),
};

/** The purchase order of the samples with members replaced. */
export const purchaseOrder = (over: Readonly<Record<string, JsonValue>> = {}): Document => ({ ...PURCHASE_ORDER, ...over });

/** The handoff that carries `document`. The checks of the Order Desk read the document and nothing else of it. */
export const handoffOf = (document: Document = PURCHASE_ORDER, over: Partial<Handoff> = {}): Handoff => ({
  schema: HANDOFF_SCHEMA, use_case: 'inventory-reorder', sender_did: OTHER_DID, delegation: '5e'.repeat(32), document, salt: '9a'.repeat(32), approval: null, ...over,
});

/** What the runtime says about the escrow: the advert that it was posted on, and the model of that advert, which is the lot. */
export const CONTEXT: JobContext = {
  escrowRef: ESCROW_REF, advertRef: ADVERT_REF, advertModel: 'lot-medium', buyerPkh: BUYER_PKH, paymentLovelace: 5_000_000n, deliverByMs: Date.UTC(2026, 11, 5, 12, 0, 0),
};
