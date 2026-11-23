// agents/order-desk/test/job/samples.ts
// The values that the tests of the job share and that need no gateway and no portal: the DIDs and references, a purchase order and the handoff that carries it, the lots file, the entry of the catalogue,
// the record of the checks that passed, and the decision `availability` as the kit gives it. Every value has the form that the protocol names. No value is a key.
import type { MockBases } from '@vsa/usecase-kit/access';
import type { ChecksRecord } from '@vsa/usecase-kit/checks';
import type { DecisionFailure } from '@vsa/usecase-kit/decision';
import { CONFIRMATION_CHECKS, PO_SCHEMA, parseLotsFile } from '@vsa/usecase-kit/inventory';
import type { LotsFile } from '@vsa/usecase-kit/inventory';
import { HANDOFF_SCHEMA, canonicalSha256, parseHandoff } from '@vsa/usecase-kit/protocol';
import type { Decision, Digest, Document, Handoff, JsonValue, SubJob } from '@vsa/usecase-kit/protocol';
import type { AvailabilityChoice } from '../../src/job/availability.ts';

/** The two origins of the mock service, for a test with no server. */
export const BASES: MockBases = { publicBase: 'https://mock.example', mtlsBase: 'https://mock-mtls.example' };
/** The supplier that the purchase order names. The job does not compare it with its own DID: check 12 of the hook does. */
export const SUPPLIER_DID = `did:vector:${'a1'.repeat(32)}`;
export const SENDER_DID = `did:vector:${'ec'.repeat(32)}`;
export const ISSUER_DID = `did:vector:${'1f'.repeat(32)}`;
export const ADVERT_REF = `${'d4'.repeat(32)}#1`;
export const ESCROW_REF = `${'e7'.repeat(32)}#0`;
export const DELEGATION_ID = '5e'.repeat(32);
export const ATTESTATION_ID = '9b'.repeat(32);
export const SALT = '9a'.repeat(32);
export const BUYER_PKH = '0b'.repeat(28);
/** The end of the approval as the checks record it, in milliseconds since 1970, and as the confirmation writes it. */
export const VALID_UNTIL_MS = Date.UTC(2026, 10, 24, 10, 0, 0);
export const VALID_UNTIL = '2026-11-24T10:00:00.000Z';
/** The canonical SHA-256 of `PURCHASE_ORDER`, worked out with a few lines of Node that do not use the kit. */
export const PURCHASE_ORDER_SHA256 = 'ee530a49d9ead8b2a2ecbd3896fc6b018e0050a0bf24ddf4dad7f88775585cbc';

const parsedLots = parseLotsFile({
  schema: 'vector.usecase.lots.v1',
  items: [
    { sku: 'GLV-NIT-M', lots: { 'lot-small': 10, 'lot-medium': 50, 'lot-large': 200 } },
    { sku: 'SYR-10ML', lots: { 'lot-small': 25, 'lot-medium': 100, 'lot-large': 400 } },
    { sku: 'MSK-N95', lots: { 'lot-small': 20, 'lot-medium': 100, 'lot-large': 400 } },
  ],
});
if (!parsedLots.ok) throw new Error(parsedLots.detail);
/** The lots file of the Order Desk, with three SKUs. */
export const LOTS: LotsFile = parsedLots.value;

/** A purchase order that passes the checks of the hook for the medium lot of the first SKU. */
export const PURCHASE_ORDER: Document = {
  schema: PO_SCHEMA, po_number: 'run1-0001', tenant: 'run1', sku: 'GLV-NIT-M', lot: 'lot-medium', quantity: 50, needed_by: '2026-12-05', supplier_did: SUPPLIER_DID, advert_ref: ADVERT_REF,
  stock_reading_sha256: 'ab'.repeat(32),
};

/** The purchase order with members replaced. */
export const purchaseOrder = (over: Readonly<Record<string, JsonValue>> = {}): Document => ({ ...PURCHASE_ORDER, ...over });

/** The entry of the catalogue of the portal for the first SKU, as the portal gives it. */
export const CATALOGUE_ENTRY: Document = {
  sku: 'GLV-NIT-M', description: 'Nitrile examination gloves, size M, box of 100', unit: 'box', available: 5000, lot_sizes: { 'lot-small': 10, 'lot-medium': 50, 'lot-large': 200 }, ship_lead_days: 3,
  discontinued: false,
};

/** The catalogue of the portal by SKU. */
export const CATALOGUE: Readonly<Record<string, Document>> = {
  'GLV-NIT-M': CATALOGUE_ENTRY,
  'SYR-10ML': { ...CATALOGUE_ENTRY, sku: 'SYR-10ML', description: 'Syringe 10 ml, luer lock, box of 100', available: 3000, lot_sizes: { 'lot-small': 25, 'lot-medium': 100, 'lot-large': 400 }, ship_lead_days: 2 },
  'MSK-N95': { ...CATALOGUE_ENTRY, sku: 'MSK-N95', description: 'Respirator mask N95, box of 20', available: 150, lot_sizes: { 'lot-small': 20, 'lot-medium': 100, 'lot-large': 400 }, ship_lead_days: 6 },
};

/** The hash of any JSON value as the kit makes it. */
export function hashOf(value: unknown): Digest {
  const hash = canonicalSha256(value);
  if (!hash.ok) throw new Error(hash.detail);
  return hash.value;
}

/** The handoff that the sender sends, as the server of the Order Desk parses it from its JSON text: `over` replaces members of the wire message. */
export function handoffOf(document: Document = PURCHASE_ORDER, over: Readonly<Record<string, JsonValue>> = {}): Handoff {
  const wire = {
    schema: HANDOFF_SCHEMA, use_case: 'inventory-reorder', sender_did: SENDER_DID, delegation: DELEGATION_ID, document, salt: SALT, approval: { attestation: ATTESTATION_ID, issuer_did: ISSUER_DID }, ...over,
  };
  const parsed = parseHandoff(JSON.parse(JSON.stringify(wire)));
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.value;
}

// --- the record of the checks that passed ----------------------------------------------------------------------------------------------------------

/** What the checks of the hook learn: the organisation of the sender, and the approval. */
export const FACTS: Readonly<Record<string, JsonValue>> = {
  organisation: 'buyer.example', organisation_verified: true, approval_attestation: ATTESTATION_ID, approval_issuer_did: ISSUER_DID, approval_issuer_key_hash: '3c'.repeat(28),
  approval_valid_until: VALID_UNTIL_MS,
};

/** The 16 checks, each true, in the order that they run. */
export const CHECKS: Readonly<Record<string, true>> = Object.fromEntries(CONFIRMATION_CHECKS.map((name) => [name, true as const]));

/** The record that the hook keeps for `request`: the 16 checks, the facts, and the hash of the request. `over` replaces a member. */
export function recordFor(
  request: Handoff,
  over: { checks?: Readonly<Record<string, true>>; facts?: Readonly<Record<string, JsonValue>>; request_sha256?: string } = {},
): { readonly record: ChecksRecord; readonly request_sha256: Digest } {
  return { record: { checks: over.checks ?? CHECKS, facts: over.facts ?? FACTS }, request_sha256: over.request_sha256 ?? hashOf(request) };
}

// --- the decision ----------------------------------------------------------------------------------------------------------------------------------

const SUB_JOB: SubJob = {
  capability_id: 'llm.text.generate.v1',
  advert_ref: `${'b3'.repeat(32)}#0`,
  escrow_ref: `${'4c'.repeat(32)}#0`,
  supplier_pkh: '7d'.repeat(28),
  receipt: {
    escrow_ref: `${'4c'.repeat(32)}#0`, supplier_pkh: '7d'.repeat(28), prompt_hash: '33'.repeat(32), response_hash: '44'.repeat(32), model: 'deepseek/deepseek-v4-flash', prompt_tokens: 412,
    completion_tokens: 58, wallclock_ms: 2140,
  },
  receipt_signature: '8e'.repeat(64),
  verification: {
    escrow_ref_matches: true, response_hash_matches: true, supplier_key_matches: true, signature_valid: true, on_chain_hash_matches: true, prompt_hash_matches: true, model_matches: true,
    fields_match: true,
  },
};

/** The decision `availability` as a decision of the kit gives it, for a model that confirms. `over` replaces members of the choice. */
export function decisionOf(over: Partial<AvailabilityChoice> = {}): Decision<AvailabilityChoice> {
  return {
    name: 'availability',
    choice: { confirm: true, ship_by: '2026-11-28', note: 'The catalogue holds enough boxes for this lot.', ...over },
    reasoning: 'The catalogue shows 5000 boxes available and the lot needs 50, so the order can ship in three days.',
    inference: { path: 'marketplace', sub_job: SUB_JOB, accepted: 'confirmed' },
  };
}

/** A failed decision, as `decide` of the kit gives it. */
export function failureOf(code: DecisionFailure['code'], over: Partial<DecisionFailure> = {}): DecisionFailure {
  return { ok: false, code, reason: 'llm_timeout', detail: 'the model hire for the decision availability ended with llm_timeout at poll', delivery: null, escrow_ref: null, stage: 'poll', ...over };
}
