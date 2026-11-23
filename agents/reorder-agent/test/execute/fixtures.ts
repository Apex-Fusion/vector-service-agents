// agents/reorder-agent/test/execute/fixtures.ts
// The documents that the tests of the job `execute` share: the purchase order, the order confirmation that the Order Desk signs, the decision of the model, the delivery of a hire, and the answers of
// a challenge. No value is a key. A document is a plain object that a test changes with `over`, so that a test names what it changes.
import { AGENT_ADVERT_REF, AGENT_ID } from '@vsa/hire-kit/testing';
import { CONFIRMATION_CHECKS, parseOrderConfirmation, parsePurchaseOrder } from '@vsa/usecase-kit/inventory';
import type { OrderConfirmation, PurchaseOrder } from '@vsa/usecase-kit/inventory';
import { RECEIPT_CHECKS, canonicalSha256, makeProposal, parseRequest } from '@vsa/usecase-kit/protocol';
import type { ChallengeRecord, Decision, ExecuteRequest, JsonObject, SubJob } from '@vsa/usecase-kit/protocol';
import type { VerifiedDelivery } from '@vsa/usecase-kit/buyer';
import type { ChallengeFiled, ChallengeNotFiled } from '@vsa/usecase-kit/dispute';
import type { AcceptAnswer, OrderField } from '../../src/execute/ports.ts';

export const SUPPLIER_DID = `did:vector:${AGENT_ID}`;
export const PRINCIPAL_DID = `did:vector:${'b2'.repeat(32)}`;
export const SALT = '33'.repeat(32);
export const TENANT = 'run1';
export const APPROVAL = { attestation: '22'.repeat(32), issuer_did: PRINCIPAL_DID } as const;
export { AGENT_ADVERT_REF };

/** The purchase order of the tests. It names the advert of the template supplier of the stub marketplace. */
export function purchaseOrder(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'vector.usecase.po.v1', po_number: 'run1-1', tenant: TENANT, sku: 'SKU-100', lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01', supplier_did: SUPPLIER_DID,
    advert_ref: AGENT_ADVERT_REF, stock_reading_sha256: '55'.repeat(32), ...over,
  };
}

/** The purchase order as the typed value that the job reads. */
export function typedOrder(document: Record<string, unknown> = purchaseOrder()): PurchaseOrder {
  const parsed = parsePurchaseOrder(document);
  if (!parsed.ok) throw new Error(`the purchase order of the test is refused: ${parsed.detail}`);
  return parsed.value;
}

/** The hash that the Order Desk writes into its confirmation: the canonical hash of the order document, with no salt. */
export function orderHash(document: Record<string, unknown> = purchaseOrder()): string {
  const hash = canonicalSha256(document);
  if (!hash.ok) throw new Error(`the purchase order of the test has no hash: ${hash.detail}`);
  return hash.value;
}

/** The sub-job of a model hire, as a decision records it. */
const SUB_JOB: SubJob = {
  capability_id: 'llm.text.generate.v1', advert_ref: `${'b3'.repeat(32)}#0`, escrow_ref: `${'4c'.repeat(32)}#0`, supplier_pkh: '7d'.repeat(28),
  receipt: {
    escrow_ref: `${'4c'.repeat(32)}#0`, supplier_pkh: '7d'.repeat(28), prompt_hash: '33'.repeat(32), response_hash: '44'.repeat(32), model: 'deepseek/deepseek-v4-flash', prompt_tokens: 412, completion_tokens: 58, wallclock_ms: 2140,
  },
  receipt_signature: '8e'.repeat(64),
  verification: Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true])) as SubJob['verification'],
};

/** A decision of the model, as the protocol records it. */
export function decisionOf(name: string, choice: JsonObject, reasoning = 'The documents were compared field by field.'): Decision {
  return { name, choice, reasoning, inference: { path: 'marketplace', sub_job: SUB_JOB, accepted: 'confirmed' } };
}

/** The decision `accept_delivery` with the given choice. */
export const acceptDecision = (accept: boolean, mismatch: readonly OrderField[] = []): Decision => decisionOf('accept_delivery', { accept, mismatch: [...mismatch] });

/** The decision `availability` of the Order Desk, which every confirmation holds. */
const AVAILABILITY = decisionOf('availability', { confirm: true, ship_by: '2026-11-28', note: 'The catalogue holds enough boxes for this lot.' }, 'The catalogue shows enough boxes for this lot.');

/** The order confirmation that the Order Desk returns for an order document: it names the same order, with the 16 checks true. `over` replaces members. */
export function confirmationOf(document: Record<string, unknown> = purchaseOrder(), over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'vector.usecase.order-confirmation.v1', outcome: 'done', po_number: document.po_number, po_sha256: orderHash(document), sku: document.sku, lot: document.lot, quantity: document.quantity,
    ship_by: '2026-11-28', order_id: 'SO-run1-0001',
    sender: { did: `did:vector:${'a1'.repeat(32)}`, organisation: 'org.example', organisation_verified: true },
    approval: { attestation: APPROVAL.attestation, issuer_did: PRINCIPAL_DID, valid_until: '2026-11-24T10:00:00.000Z' },
    checks: Object.fromEntries(CONFIRMATION_CHECKS.map((name) => [name, true])),
    decisions: [AVAILABILITY], fault_mode: '', ...over,
  };
}

/** The confirmation as the typed value that the job reads: the copy that the parser of the kit makes. A test gives a document that the kit accepts. */
export function typedConfirmation(value: Record<string, unknown> = confirmationOf()): OrderConfirmation {
  const parsed = parseOrderConfirmation(value);
  if (!parsed.ok) throw new Error(`the confirmation of the test is refused: ${parsed.detail}`);
  return parsed.value;
}

/** A delivery that passed the eight checks, as the decision of a use case gets it. `value` is the answer of the Order Desk. */
export function deliveryOf(value: unknown = confirmationOf()): VerifiedDelivery {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let result: JsonObject | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    result = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
  } catch {
    result = null;
  }
  return {
    escrow_ref: `${'ab'.repeat(32)}#0`, advert_ref: AGENT_ADVERT_REF, text, result,
    receipt: { escrow_ref: `${'ab'.repeat(32)}#0`, supplier_pkh: '5a'.repeat(28), response_hash: '66'.repeat(32), agent_did: SUPPLIER_DID }, receipt_signature: '9c'.repeat(64),
    verification: Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true])) as VerifiedDelivery['verification'],
  };
}

/** The `execute` request for an order document, as the protocol parser gives it. */
export function executeRequest(document: unknown, delegation: string, approval: unknown = APPROVAL): ExecuteRequest {
  const proposal = makeProposal(document, SALT);
  if (!proposal.ok) throw new Error(`the proposal of the test is refused: ${proposal.detail}`);
  const parsed = parseRequest({ op: 'execute', authority: { principal_did: PRINCIPAL_DID, delegation }, tenant: TENANT, proposal: proposal.value, approval });
  if (!parsed.ok) throw new Error(`the request of the test is refused: ${parsed.detail}`);
  if (parsed.value.op !== 'execute') throw new Error('the request of the test is not an execute request');
  return parsed.value;
}

/** The record of a challenge that was filed. */
export const CHALLENGE: ChallengeRecord = { claim: `${'c1'.repeat(32)}#0`, evidence: 'e1'.repeat(32), challenge: `${'c2'.repeat(32)}#0` };

/** The answer of the dispute folder for a challenge that was filed. */
export function challengeFiled(record: ChallengeRecord = CHALLENGE): { ok: true; value: ChallengeFiled } {
  return {
    ok: true,
    value: {
      record, claim_token: `636c6d5f${'11'.repeat(28)}`, against_did: SUPPLIER_DID, evidence_uri: 'ipfs://evidence', evidence_hash: 'd4'.repeat(32), challenge_tx: record.challenge.split('#')[0]!,
      challenge_token: `636c6d5f${'22'.repeat(28)}`, stake_lovelace: 50_000_000n, deadline: 1_790_000_000_000, fee_lovelace: 1_000_000n, extra_evidence: null,
    },
  };
}

/** The answer of the dispute folder for a challenge that was not filed. `landed` names a transaction that landed before the step failed. */
export function challengeNotFiled(code: ChallengeNotFiled['code'], landed: Partial<Pick<ChallengeNotFiled, 'evidence' | 'sent' | 'challenge' | 'wrong_document'>> = {}): ChallengeNotFiled {
  return { ok: false, code, detail: 'the detail of the dispute folder', evidence: null, sent: null, challenge: null, wrong_document: null, ...landed };
}

/** The model as a function. By default it reads the three fields as a model that reads them right: it accepts when they agree, and it names the fields that differ when they do not. */
export class ScriptedAccept {
  readonly calls: Array<{ order: PurchaseOrder; confirmation: OrderConfirmation }> = [];
  answer: (order: PurchaseOrder, confirmation: OrderConfirmation) => unknown = (order, confirmation) => {
    const mismatch = (['sku', 'lot', 'quantity'] as const).filter((field) => order[field] !== confirmation[field]);
    return { ok: true, decision: acceptDecision(mismatch.length === 0, mismatch), choice: { accept: mismatch.length === 0, mismatch } };
  };

  readonly acceptDelivery = async (order: PurchaseOrder, confirmation: OrderConfirmation): Promise<AcceptAnswer> => {
    this.calls.push({ order, confirmation });
    // A test gives the answer of a port, and it may give an answer that breaks the type, to see what the job does with it.
    return (await this.answer(order, confirmation)) as AcceptAnswer;
  };
}
