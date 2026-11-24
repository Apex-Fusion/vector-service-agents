// agents/bid-desk/test/checks/samples.ts
// The values that the tests of the hook share and that need no ledger: the DID of a sender, a request for quotation and the message that carries it, the job context of the runtime, the hash of a quote, and
// the path of the golden price list. Every value has the form that the protocol names. No value is a key.
import { fileURLToPath } from 'node:url';
import type { JobContext } from '@vsa/service-kit';
import { BID_DESK_MODEL } from '@vsa/usecase-kit/bids';
import { RFQ_SCHEMA } from '@vsa/usecase-kit/protocol';
import type { Document, JsonValue, RfqMessage } from '@vsa/usecase-kit/protocol';

/** The golden price list: the bytes that a Bid Desk serves, and the hash that its manifest holds. */
export const PRICE_LIST_PATH = fileURLToPath(new URL('./golden/price-list.json', import.meta.url));

/** The DID of a sender, and the DID of another sender. */
export const SENDER = `did:vector:${'a1'.repeat(32)}`;
export const OTHER_SENDER = `did:vector:${'f2'.repeat(32)}`;
/** The advert that the escrow of the samples was posted on. */
export const ADVERT_REF = `${'d4'.repeat(32)}#1`;
export const ESCROW_REF = `${'e7'.repeat(32)}#0`;
export const BUYER_PKH = '0b'.repeat(28);
export const DELEGATION = '5e'.repeat(32);
/** The hash of a quote that a Bid Desk gave, and the hash of another quote. */
export const QUOTE_SHA256 = 'ab'.repeat(32);
export const OTHER_QUOTE_SHA256 = 'cd'.repeat(32);

/** A request for quotation that passes the check of the Bid Desk: three items, each SKU once. */
export const RFQ: Document = {
  rfq_id: 'run1-rfq-1', items: [{ sku: 'GLV-NIT-M', quantity: 100 }, { sku: 'SYR-10ML', quantity: 250 }, { sku: 'MSK-N95', quantity: 40 }], needed_by: '2026-12-20',
};

/** The request of the samples with members replaced. */
export const rfqOf = (over: Readonly<Record<string, JsonValue>> = {}): Document => ({ ...RFQ, ...over });

/** The message that carries `rfq`. The check of the Bid Desk reads the sender and the request, and nothing else of it. */
export const messageOf = (rfq: Document = RFQ, over: Partial<RfqMessage> = {}): RfqMessage => ({ schema: RFQ_SCHEMA, sender_did: SENDER, delegation: DELEGATION, rfq, ...over });

/** What the runtime says about the escrow: the advert that it was posted on, and the model of that advert. */
export const CONTEXT: JobContext = {
  escrowRef: ESCROW_REF, advertRef: ADVERT_REF, advertModel: BID_DESK_MODEL, buyerPkh: BUYER_PKH, paymentLovelace: 5_000_000n, deliverByMs: Date.UTC(2026, 11, 5, 12, 0, 0),
};
