// agents/bid-desk/test/job/samples.ts
// The values that the tests of the job share and that need no gateway and no book: the price list that a Bid Desk serves, a request for quotation, the date of today, the choice of the model decision
// `quote` as a model that follows the price list gives it, the decision as the kit records it, and a quote that holds a choice. Every value has the form that the protocol names. No value is a key.
import { QUOTE_CHECKS, QUOTE_SCHEMA, parsePriceList, parseRfqDocument, priceListSha256, quoteTotals, rfqSha256 } from '@vsa/usecase-kit/bids';
import type { PriceList, RfqDocument } from '@vsa/usecase-kit/bids';
import type { Decision, Digest, Document, SubJob } from '@vsa/usecase-kit/protocol';
import type { QuoteChoice } from '../../src/job/decision.ts';

/** The date of today for the model, and the date of the request. */
export const TODAY = '2026-11-24';

/** The DID and the organisation of the desk, and the DID of a sender. */
export const DESK_DID = `did:vector:${'b2'.repeat(32)}`;
export const DESK_ORGANISATION = 'supplier-alfa.example';
export const SENDER_DID = `did:vector:${'a1'.repeat(32)}`;

/**
 * The price list of the samples, as the object that the file holds: three SKUs with quantity breaks and a lead time each. At 100 units the first SKU costs 125 with a lead time of 14 days, as the
 * example of the Bid Desk page does.
 */
export const PRICE_LIST_VALUE = {
  schema: 'vector.usecase.price-list.v1',
  items: [
    {
      sku: 'GLV-NIT-M',
      lead_time_days: 14,
      breaks: [{ min_quantity: 1, unit_price: 140 }, { min_quantity: 50, unit_price: 132 }, { min_quantity: 100, unit_price: 125 }, { min_quantity: 500, unit_price: 112 }],
    },
    { sku: 'SYR-10ML', lead_time_days: 9, breaks: [{ min_quantity: 1, unit_price: 40 }, { min_quantity: 250, unit_price: 35 }, { min_quantity: 1000, unit_price: 30 }] },
    {
      sku: 'MSK-N95',
      lead_time_days: 20,
      breaks: [{ min_quantity: 1, unit_price: 64 }, { min_quantity: 25, unit_price: 59 }, { min_quantity: 100, unit_price: 53 }, { min_quantity: 1000, unit_price: 46 }],
    },
  ],
};

/** The bytes of the list as the service serves them, and their SHA-256, worked out with `sha256sum` of this text and not with the kit. */
export const PRICE_LIST_TEXT = JSON.stringify(PRICE_LIST_VALUE);
export const PRICE_LIST_SHA256: Digest = '5c64bdfd0cad6b8fe64497afc1229af43d9178ffd5ab033df2585697a9a43e51';

/** The price list as the kit reads it. */
export function priceListOf(value: unknown = PRICE_LIST_VALUE): PriceList {
  const parsed = parsePriceList(value);
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.value;
}
export const PRICE_LIST: PriceList = priceListOf();

/** A request for quotation: three items, each SKU once. The list prices every one of them. */
export const RFQ_VALUE: Document = {
  rfq_id: 'run1-rfq-1', items: [{ sku: 'GLV-NIT-M', quantity: 100 }, { sku: 'SYR-10ML', quantity: 250 }, { sku: 'MSK-N95', quantity: 40 }], needed_by: '2026-12-20',
};

/** The request as the kit reads it. `over` replaces members. */
export function rfqOf(over: Readonly<Record<string, unknown>> = {}): RfqDocument {
  const parsed = parseRfqDocument({ ...RFQ_VALUE, ...over });
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.value;
}
export const RFQ: RfqDocument = rfqOf();

/** The canonical SHA-256 of `RFQ_VALUE`, worked out with `sha256sum` of its canonical text and not with the kit. */
export const RFQ_SHA256: Digest = '42ca167e867b2e8df3a82b7dc4a5b1c2a3a96f523e1f56a3863936a5dceadf35';

/** The choice of a model that follows the price list: one line for each item at the price of its break, and the lead time of its SKU. `over` replaces members. A new object at each call. */
export const choiceOf = (over: Partial<QuoteChoice> = {}): QuoteChoice => ({
  lines: [
    { sku: 'GLV-NIT-M', quantity: 100, unit_price: 125, lead_time_days: 14 },
    { sku: 'SYR-10ML', quantity: 250, unit_price: 35, lead_time_days: 9 },
    { sku: 'MSK-N95', quantity: 40, unit_price: 59, lead_time_days: 20 },
  ],
  valid_until: '2026-12-15',
  notes: 'All three items are on the price list.',
  ...over,
});

/** The credential that the gateway gives a desk: a compact JWS. The three parts are text that only the tests use. */
export const CREDENTIAL =
  'eyJhbGciOiJFZERTQSIsInR5cCI6InZjK2p3dCJ9.eyJpc3MiOiJkaWQ6dmVjdG9yOmdhdGV3YXkiLCJzdWIiOiJkaWQ6dmVjdG9yOmRlc2siLCJ2YyI6eyJ0eXBlIjpbIlZlcmlmaWFibGVDcmVkZW50aWFsIl19fQ.YSBzaWduYXR1cmUgdGhhdCBvbmx5IGEgdGVzdCB1c2Vz';

// --- the decision ----------------------------------------------------------------------------------------------------------------------------------

const SUB_JOB: SubJob = {
  capability_id: 'llm.text.generate.v1',
  advert_ref: `${'b3'.repeat(32)}#0`,
  escrow_ref: `${'4c'.repeat(32)}#0`,
  supplier_pkh: '7d'.repeat(28),
  receipt: {
    escrow_ref: `${'4c'.repeat(32)}#0`, supplier_pkh: '7d'.repeat(28), prompt_hash: '33'.repeat(32), response_hash: '44'.repeat(32), model: 'deepseek/deepseek-v4-flash', prompt_tokens: 912,
    completion_tokens: 164, wallclock_ms: 3120,
  },
  receipt_signature: '8e'.repeat(64),
  verification: {
    escrow_ref_matches: true, response_hash_matches: true, supplier_key_matches: true, signature_valid: true, on_chain_hash_matches: true, prompt_hash_matches: true, model_matches: true,
    fields_match: true,
  },
};

/** The decision `quote` as a decision of the kit gives it: the choice as the model gave it, and the hire that bought it. */
export function decisionOf(choice: QuoteChoice = choiceOf()): Decision<QuoteChoice> {
  return {
    name: 'quote',
    choice,
    reasoning: 'The list gives 125 for 100 gloves, 35 for 250 syringes and 59 for 40 masks, so each line takes the unit price of its break and the lead time of its SKU.',
    inference: { path: 'marketplace', sub_job: SUB_JOB, accepted: 'confirmed' },
  };
}

// --- a quote ---------------------------------------------------------------------------------------------------------------------------------------

/** The 7 checks of a quote, each true, in the order that they run. */
export const CHECKS: Readonly<Record<string, true>> = Object.fromEntries(QUOTE_CHECKS.map((name) => [name, true as const]));

/**
 * A quote that holds `choice` the way a job builds it: the lines with their line totals, the total and the longest lead time from `quoteTotals`, and the rest from the samples. It is null when
 * `quoteTotals` makes no quote of the lines. Whether the kit takes the result is for the test to find out.
 */
export function quoteOf(choice: QuoteChoice): Record<string, unknown> | null {
  const totals = quoteTotals(choice.lines);
  const hash = rfqSha256(RFQ);
  if (totals === null || !hash.ok) return null;
  return {
    schema: QUOTE_SCHEMA,
    outcome: 'done',
    rfq_id: RFQ.rfq_id,
    rfq_sha256: hash.value,
    desk_did: DESK_DID,
    organisation: DESK_ORGANISATION,
    lines: totals.lines,
    total: totals.total,
    lead_time_days: totals.lead_time_days,
    valid_until: choice.valid_until,
    notes: choice.notes,
    price_list_sha256: priceListSha256(PRICE_LIST_TEXT),
    credential: CREDENTIAL,
    sender: { did: SENDER_DID, organisation: 'buyer.example', organisation_verified: true },
    checks: { ...CHECKS },
    decisions: [decisionOf(choice)],
    fault_mode: '',
  };
}
