import { readFileSync } from 'node:fs';
import { PreconditionError } from '../../../checks/lib/session.ts';
import type { EvidenceDocumentInput } from '../../../../packages/usecase-kit/src/dispute/index.ts';
import { CONFIRMATION_CHECKS, CONFIRMATION_SCHEMA, PO_SCHEMA, lotSizeOf, parseLotsFile } from '../../../../packages/usecase-kit/src/inventory/index.ts';
import type { LotName, LotsFile } from '../../../../packages/usecase-kit/src/inventory/index.ts';
import type { UseCase } from '../contract.ts';
import { INVENTORY_CAPABILITIES, ORDER_DESK_CLAIM, canonicalSha256, claimDocument, evidenceDocument, parseOrderConfirmation, parsePurchaseOrder } from '../platform.ts';
import { SAMPLE_ADVERT_REF, SAMPLE_CLAIM_REF, SAMPLE_CLAIM_TOKEN, SAMPLE_ESCROW_REF, jsonFile, sampleDecision, trialDocument } from './shared.ts';
import type { TrialBuilder, TrialFile } from './shared.ts';

const SAMPLE_ORDER_DESK_DID = `did:vector:${'5a'.repeat(32)}`;
const SAMPLE_REORDER_DID = `did:vector:${'5b'.repeat(32)}`;
const SAMPLE_MANIFEST_SHA256 = '5c'.repeat(32);
const TRIAL_LOT: LotName = 'lot-medium';
/** The lot that the fault `confirm_wrong_lot` of the Order Desk gives for the lot of the trial: the wrong lot of `lot-medium` is `lot-small`. */
const TRIAL_WRONG_LOT: LotName = 'lot-small';

interface TrialCase {
  readonly name: string;
  readonly sku: string;
  readonly lot: LotName;
  readonly quantity: number;
  readonly fault: '' | 'confirm_wrong_lot';
}

/** The SKU and the lot size of the purchase order, and the three confirmations that do not agree with it. */
interface TrialPlan { readonly sku: string; readonly size: number; readonly cases: readonly TrialCase[] }

/** The lots file of the checkout of the repository. A trial runs from a checkout: the image of the pack does not hold the file. */
function readLots(): LotsFile {
  let json: unknown;
  try { json = JSON.parse(readFileSync(new URL('../../../../agents/order-desk/lots.json', import.meta.url), 'utf8')); } catch {
    throw new PreconditionError('the lots file of the Order Desk cannot be read here: run the trial from a checkout of the repository');
  }
  const parsed = parseLotsFile(json);
  if (!parsed.ok) throw new PreconditionError(`the lots file of the Order Desk is refused (${parsed.code}): ${parsed.detail}`);
  return parsed.value;
}

/** The order is for the SKU of the clean run and its medium lot. The confirmations name another lot (the fault), another quantity and another SKU. */
function trialPlan(use: UseCase): TrialPlan {
  const file = readLots();
  const clean = use.runs.find((run) => run.id === 'clean');
  if (clean === undefined) throw new PreconditionError('the data of the use case has no clean run, so it names no SKU for the trial');
  const size = lotSizeOf(file, clean.subject, TRIAL_LOT);
  const wrongSize = lotSizeOf(file, clean.subject, TRIAL_WRONG_LOT);
  if (size === null || wrongSize === null) throw new PreconditionError(`the lots file does not list the SKU ${clean.subject}`);
  const other = use.runs.find((run) => run.id === 'failure' && run.subject !== clean.subject)?.subject ?? file.items.find((item) => item.sku !== clean.subject)?.sku;
  if (other === undefined) throw new PreconditionError('the lots file lists no other SKU for the trial');
  return {
    sku: clean.subject, size,
    cases: [
      { name: 'wrong-lot', sku: clean.subject, lot: TRIAL_WRONG_LOT, quantity: wrongSize, fault: 'confirm_wrong_lot' },
      { name: 'wrong-quantity', sku: clean.subject, lot: TRIAL_LOT, quantity: size * 2, fault: '' },
      { name: 'wrong-sku', sku: other, lot: TRIAL_LOT, quantity: size, fault: '' },
    ],
  };
}

interface TrialIds { readonly order: string; readonly reorder: string; readonly manifest: string }

function trialFiles(plan: TrialPlan, trial: TrialCase, ids: TrialIds): TrialFile[] {
  const order = parsePurchaseOrder({
    schema: PO_SCHEMA, po_number: 'trial-1', tenant: 'trial', sku: plan.sku, lot: TRIAL_LOT, quantity: plan.size, needed_by: '2026-12-31', supplier_did: ids.order, advert_ref: SAMPLE_ADVERT_REF,
    stock_reading_sha256: '5d'.repeat(32),
  });
  if (!order.ok) throw new PreconditionError(`the sample purchase order is refused (${order.code}): ${order.detail}`);
  const orderSha = canonicalSha256(order.value);
  if (!orderSha.ok) throw new PreconditionError('the sample purchase order has no canonical form');
  const confirmed = parseOrderConfirmation({
    schema: CONFIRMATION_SCHEMA, outcome: 'done', po_number: order.value.po_number, po_sha256: orderSha.value, sku: trial.sku, lot: trial.lot, quantity: trial.quantity, ship_by: '2026-12-31',
    order_id: 'ORD-TRIAL-1', sender: { did: ids.reorder, organisation: 'echo.vector.apexfusion.org', organisation_verified: true },
    approval: { attestation: '22'.repeat(32), issuer_did: null, valid_until: null },
    checks: Object.fromEntries(CONFIRMATION_CHECKS.map((name) => [name, true])), decisions: [sampleDecision('availability', 'available', 'The lot is in stock.')], fault_mode: trial.fault,
  });
  if (!confirmed.ok) throw new PreconditionError(`the sample confirmation is refused (${confirmed.code}): ${confirmed.detail}`);
  const confirmationSha = canonicalSha256(confirmed.value);
  if (!confirmationSha.ok) throw new PreconditionError('the sample confirmation has no canonical form');
  const claim = trialDocument(claimDocument({ agent_did: ids.order, capability_id: INVENTORY_CAPABILITIES.order, manifest_sha256: ids.manifest, claim: ORDER_DESK_CLAIM }), `claim document of the case ${trial.name}`);
  const input: EvidenceDocumentInput = {
    kind: 'order_confirmation', claim: SAMPLE_CLAIM_REF, claim_token: SAMPLE_CLAIM_TOKEN, against_did: ids.order, by_did: ids.reorder, escrow_ref: SAMPLE_ESCROW_REF,
    statement_text: ORDER_DESK_CLAIM.statements[0].text, purchase_order: { ...order.value }, confirmation: JSON.parse(JSON.stringify(confirmed.value)), confirmation_sha256: confirmationSha.value,
  };
  const evidence = trialDocument(evidenceDocument(input), `evidence document of the case ${trial.name}`);
  return [
    { file: `${trial.name}.claim.txt`, text: claim.text, juror: claim },
    { file: `${trial.name}.evidence.txt`, text: evidence.text, juror: evidence },
    jsonFile(`${trial.name}.purchase-order.json`, order.value),
    jsonFile(`${trial.name}.confirmation.json`, confirmed.value),
  ];
}

export const inventoryTrial: TrialBuilder = (use, facts) => {
  const ids: TrialIds = {
    order: facts.records['order-desk']?.did ?? SAMPLE_ORDER_DESK_DID, reorder: facts.records['reorder-agent']?.did ?? SAMPLE_REORDER_DID, manifest: facts.manifests['order-desk']?.sha256 ?? SAMPLE_MANIFEST_SHA256,
  };
  const sample = { order_desk_did: facts.records['order-desk'] === undefined, reorder_agent_did: facts.records['reorder-agent'] === undefined, manifest_sha256: facts.manifests['order-desk'] === undefined, references: true };
  const plan = trialPlan(use);
  return {
    sample, subjects: { order_desk_did: ids.order, reorder_agent_did: ids.reorder, manifest_sha256: ids.manifest },
    cases: plan.cases.map((trial) => ({
      name: trial.name,
      fields: {
        purchase_order: { sku: plan.sku, lot: TRIAL_LOT, quantity: plan.size },
        confirmation: { sku: trial.sku, lot: trial.lot, quantity: trial.quantity, fault_mode: trial.fault },
      },
      files: trialFiles(plan, trial, ids),
    })),
  };
};
