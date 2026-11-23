// packages/usecase-kit/src/inventory/confirmation.ts
// The order confirmation of use case 1 (inventory reorder). The Order Desk returns it when it placed the order, and the Reorder Agent reads it. Its members, in this order:
//   schema, outcome ("done"), po_number, po_sha256 (the canonical SHA-256 of the purchase order that it received), sku, lot, quantity, ship_by, order_id (the id that the supplier system gave),
//   sender { did, organisation, organisation_verified }, approval { attestation, issuer_did, valid_until }, checks, decisions, fault_mode
//
// `checks` has one member for each name of CONFIRMATION_CHECKS, and each value is true: the 12 shared checks of an order desk, in the order that they run, and then the four checks of the Order Desk.
// A confirmation exists only for a job whose checks all passed, so a check that is false, a check that is missing and a check that is not listed are refused. The list is written out in this file, because
// the folder imports no other folder of the kit. A test holds its first 12 names to the shared checks of the checks folder.
//
// The organisation of the sender is recorded and never a reason to refuse, so it can be null (no party names one). The issuer of the approval is null when the attestation has no issuer record. The end
// of the approval is null when the attestation has no end, and else a time in UTC with milliseconds, as `Date.prototype.toISOString` writes it.
//
// `decisions` holds exactly one decision of the protocol, and its name is `availability`: the model decision of the Order Desk. The Order Desk makes it in every job, also when a fault value is set, so a
// list with no decision, with two decisions, or with a decision of another name is refused. The decision keeps every text as it came, because it holds the words of a model and the signed receipt of
// its supplier. The other members are copies with each text in the NFC form. A member is read one time as data. An accessor, the key `__proto__` and a member that is not listed are refused. The detail
// of a refusal names the field and never repeats the value.
import {
  RECEIPT_CHECKS, accepted, checkMembers, isFaultSetting, parseAttestationId, parseCanonicalDocument, parseDid, parseDigest, parseDocument, parseKeyHash, parseOutputRef, refused,
} from '../protocol/index.ts';
import type { AttestationId, Decision, Did, Digest, FaultSetting, JsonValue, ProtocolResult, ReceiptVerification, SubJob } from '../protocol/index.ts';
import { isList, isLotName, objectOf, parseDay, parseId, parseQuantity, valuesOf } from './lots.ts';
import type { LotName } from './lots.ts';

export const CONFIRMATION_SCHEMA = 'vector.usecase.order-confirmation.v1';

/**
 * The names of `checks`, in the order that the checks run: the 12 shared checks of an order desk (the sender, the delegation, the payment from a vault and the approval), and then `for_this_supplier`,
 * `lot`, `quantity` and `not_duplicate`.
 */
export const CONFIRMATION_CHECKS = [
  'sender_active', 'sender_accountable', 'sender_key', 'delegation', 'delegation_usable', 'vault_paid', 'approval_found', 'approval_type', 'approval_subject', 'approval_issuer', 'approval_valid',
  'approval_digest', 'for_this_supplier', 'lot', 'quantity', 'not_duplicate',
] as const;

type ConfirmationCheck = (typeof CONFIRMATION_CHECKS)[number];

export interface OrderConfirmation {
  readonly schema: typeof CONFIRMATION_SCHEMA;
  readonly outcome: 'done';
  readonly po_number: string;
  readonly po_sha256: Digest;
  readonly sku: string;
  readonly lot: LotName;
  readonly quantity: number;
  readonly ship_by: string;
  readonly order_id: string;
  readonly sender: {
    readonly did: Did;
    /** The organisation that the covering Accountable Party names, or null. */
    readonly organisation: string | null;
    /** True only when the gateway says that it verified the organisation. */
    readonly organisation_verified: boolean;
  };
  readonly approval: {
    readonly attestation: AttestationId;
    /** The record of the issuer, or null when the issuer has no record. */
    readonly issuer_did: Did | null;
    /** The end of the validity as a time in UTC with milliseconds, or null when the attestation has no end. */
    readonly valid_until: string | null;
  };
  readonly checks: { readonly [name in ConfirmationCheck]: true };
  readonly decisions: readonly Decision[];
  readonly fault_mode: FaultSetting<'order-desk'>;
}

type Sender = OrderConfirmation['sender'];
type Approval = OrderConfirmation['approval'];

const MEMBERS = ['schema', 'outcome', 'po_number', 'po_sha256', 'sku', 'lot', 'quantity', 'ship_by', 'order_id', 'sender', 'approval', 'checks', 'decisions', 'fault_mode'] as const;

/** The longest organisation: the longest name that DNS holds. */
const MAX_ORGANISATION_CHARS = 253;
/** Letters, marks, numbers, punctuation and symbols, with single spaces inside. No control character, no line break, and no space at either end. */
const ORGANISATION_WORD = '[\\p{L}\\p{M}\\p{N}\\p{P}\\p{S}]';
const ORGANISATION = new RegExp(`^${ORGANISATION_WORD}(?:[\\p{L}\\p{M}\\p{N}\\p{P}\\p{S} ]*${ORGANISATION_WORD})?$`, 'u');
/** A time in UTC with milliseconds, as `toISOString` writes it for a year of four digits. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The name of the one decision of the Order Desk: the model decides whether the lot can be supplied. */
const AVAILABILITY = 'availability';
/** The signature of a receipt: printable characters with no space. A signature is hex or base64, so no more is asked of it. */
const SIGNATURE = /^[\x21-\x7e]{1,1024}$/;

function parseOrganisation(value: JsonValue, field: string): ProtocolResult<string | null> {
  if (value === null) return accepted(null);
  if (typeof value === 'string' && value.length <= MAX_ORGANISATION_CHARS && ORGANISATION.test(value)) return accepted(value);
  return refused('bad_shape', `${field} must be null or 1 to ${MAX_ORGANISATION_CHARS} characters of plain text: no control character, no line break, and no space at either end`);
}

function parseSender(value: JsonValue, field: string): ProtocolResult<Sender> {
  const sender = objectOf(value, field);
  if (!sender.ok) return sender;
  const members = checkMembers(sender.value, field, ['did', 'organisation', 'organisation_verified']);
  if (members !== null) return members;
  const did = parseDid(sender.value.did, `${field}.did`);
  if (!did.ok) return did;
  const organisation = parseOrganisation(sender.value.organisation, `${field}.organisation`);
  if (!organisation.ok) return organisation;
  const verified = sender.value.organisation_verified;
  if (typeof verified !== 'boolean') return refused('bad_shape', `${field}.organisation_verified must be true or false`);
  return accepted({ did: did.value, organisation: organisation.value, organisation_verified: verified });
}

/** The end of an approval: null, or a time that exists and that `toISOString` gives back as the same text. The text of a time with no milliseconds, or with an offset, is not this form. */
function parseEnd(value: JsonValue, field: string): ProtocolResult<string | null> {
  if (value === null) return accepted(null);
  if (typeof value === 'string' && TIME.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && new Date(ms).toISOString() === value) return accepted(value);
  }
  return refused('bad_shape', `${field} must be null or a time in UTC with milliseconds, as YYYY-MM-DDTHH:MM:SS.mmmZ, that exists`);
}

function parseApproval(value: JsonValue, field: string): ProtocolResult<Approval> {
  const approval = objectOf(value, field);
  if (!approval.ok) return approval;
  const members = checkMembers(approval.value, field, ['attestation', 'issuer_did', 'valid_until']);
  if (members !== null) return members;
  const attestation = parseAttestationId(approval.value.attestation, `${field}.attestation`);
  if (!attestation.ok) return attestation;
  const issuer = approval.value.issuer_did === null ? accepted(null) : parseDid(approval.value.issuer_did, `${field}.issuer_did`);
  if (!issuer.ok) return issuer;
  const end = parseEnd(approval.value.valid_until, `${field}.valid_until`);
  if (!end.ok) return end;
  return accepted({ attestation: attestation.value, issuer_did: issuer.value, valid_until: end.value });
}

function parseChecks(value: JsonValue, field: string): ProtocolResult<OrderConfirmation['checks']> {
  const checks = objectOf(value, field);
  if (!checks.ok) return checks;
  const members = checkMembers(checks.value, field, CONFIRMATION_CHECKS);
  if (members !== null) return members;
  for (const name of CONFIRMATION_CHECKS) {
    if (checks.value[name] !== true) return refused('bad_shape', `${field}.${name} must be true`);
  }
  // Each listed name is a member and its value is true (the loop above), so the entries make the object of the type.
  return accepted(Object.fromEntries(CONFIRMATION_CHECKS.map((name) => [name, true])) as OrderConfirmation['checks']);
}

function parseVerification(value: JsonValue, field: string): ProtocolResult<ReceiptVerification> {
  const verification = objectOf(value, field);
  if (!verification.ok) return verification;
  const members = checkMembers(verification.value, field, RECEIPT_CHECKS);
  if (members !== null) return members;
  for (const name of RECEIPT_CHECKS) {
    if (typeof verification.value[name] !== 'boolean') return refused('bad_shape', `${field}.${name} must be true or false`);
  }
  // Each of the eight checks is a member and a boolean (the loop above), so the entries make the object of the type.
  return accepted(Object.fromEntries(RECEIPT_CHECKS.map((name) => [name, verification.value[name]])) as ReceiptVerification);
}

function parseSubJob(value: JsonValue, field: string): ProtocolResult<SubJob> {
  const subJob = objectOf(value, field);
  if (!subJob.ok) return subJob;
  const members = checkMembers(subJob.value, field, ['capability_id', 'advert_ref', 'escrow_ref', 'supplier_pkh', 'receipt', 'receipt_signature', 'verification']);
  if (members !== null) return members;
  const capability = parseId(subJob.value.capability_id, `${field}.capability_id`);
  if (!capability.ok) return capability;
  const advert = parseOutputRef(subJob.value.advert_ref, `${field}.advert_ref`);
  if (!advert.ok) return advert;
  const escrow = parseOutputRef(subJob.value.escrow_ref, `${field}.escrow_ref`);
  if (!escrow.ok) return escrow;
  const supplier = parseKeyHash(subJob.value.supplier_pkh, `${field}.supplier_pkh`);
  if (!supplier.ok) return supplier;
  const receipt = objectOf(subJob.value.receipt, `${field}.receipt`);
  if (!receipt.ok) return receipt;
  const signature = subJob.value.receipt_signature;
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return refused('bad_shape', `${field}.receipt_signature must be 1 to 1024 printable characters with no space`);
  const verification = parseVerification(subJob.value.verification, `${field}.verification`);
  if (!verification.ok) return verification;
  return accepted({
    capability_id: capability.value, advert_ref: advert.value, escrow_ref: escrow.value, supplier_pkh: supplier.value, receipt: receipt.value, receipt_signature: signature, verification: verification.value,
  });
}

function parseInference(value: JsonValue, field: string): ProtocolResult<Decision['inference']> {
  const inference = objectOf(value, field);
  if (!inference.ok) return inference;
  const members = checkMembers(inference.value, field, ['path', 'sub_job', 'accepted']);
  if (members !== null) return members;
  if (inference.value.path !== 'marketplace') return refused('bad_shape', `${field}.path must be "marketplace"`);
  const how = inference.value.accepted;
  if (how !== 'confirmed' && how !== 'pending') return refused('bad_shape', `${field}.accepted must be "confirmed" or "pending"`);
  const subJob = parseSubJob(inference.value.sub_job, `${field}.sub_job`);
  if (!subJob.ok) return subJob;
  const result: Decision['inference'] = { path: 'marketplace', sub_job: subJob.value, accepted: how };
  return accepted(result);
}

/** One decision of the protocol: its name (`availability`), the choice as the model gave it (any JSON), the reasoning (a text that is not blank), and the hire that bought it. */
function parseDecision(value: JsonValue, field: string): ProtocolResult<Decision> {
  const decision = objectOf(value, field);
  if (!decision.ok) return decision;
  const members = checkMembers(decision.value, field, ['name', 'choice', 'reasoning', 'inference']);
  if (members !== null) return members;
  const { name, choice, reasoning } = decision.value;
  if (name !== AVAILABILITY) return refused('bad_shape', `${field}.name must be "${AVAILABILITY}"`);
  if (typeof reasoning !== 'string' || reasoning.trim() === '') return refused('bad_shape', `${field}.reasoning must be a text that is not blank`);
  const inference = parseInference(decision.value.inference, `${field}.inference`);
  if (!inference.ok) return inference;
  return accepted({ name, choice, reasoning, inference: inference.value });
}

/** The decisions of a confirmation: a list of exactly one decision, the decision `availability`. */
function parseDecisions(value: JsonValue, field: string): ProtocolResult<readonly Decision[]> {
  if (!isList(value)) return refused('bad_shape', `${field} must be a list`);
  if (value.length !== 1) return refused('bad_shape', `${field} must hold exactly one decision, named "${AVAILABILITY}"`);
  return valuesOf(Array.from(value, (entry, index) => parseDecision(entry, `${field}[${index}]`)));
}

/**
 * An order confirmation with exactly the members above, as a new plain object, or a refusal with the code `bad_shape`. `outcome` is `done` and nothing else: the Order Desk answers a refusal or a
 * failure with an error and not with a confirmation. The Reorder Agent compares the SKU, the lot and the quantity with those of the purchase order that it sent.
 */
export function parseOrderConfirmation(value: unknown): ProtocolResult<OrderConfirmation> {
  const field = 'confirmation';
  const whole = parseDocument(value, field);
  if (!whole.ok) return whole;
  const members = checkMembers(whole.value, field, MEMBERS);
  if (members !== null) return members;
  // The members that the Order Desk writes are read in the NFC form. The decisions keep each text as it came.
  const { decisions: listed, ...rest } = whole.value;
  const own = parseCanonicalDocument(rest, field);
  if (!own.ok) return own;
  const record = own.value;
  if (record.schema !== CONFIRMATION_SCHEMA) return refused('bad_shape', `${field}.schema must be "${CONFIRMATION_SCHEMA}"`);
  if (record.outcome !== 'done') return refused('bad_shape', `${field}.outcome must be "done"`);
  const poNumber = parseId(record.po_number, `${field}.po_number`);
  if (!poNumber.ok) return poNumber;
  const poSha = parseDigest(record.po_sha256, `${field}.po_sha256`);
  if (!poSha.ok) return poSha;
  const sku = parseId(record.sku, `${field}.sku`);
  if (!sku.ok) return sku;
  const lot = record.lot;
  if (!isLotName(lot)) return refused('bad_shape', `${field}.lot must be one of the lot names`);
  const quantity = parseQuantity(record.quantity, `${field}.quantity`);
  if (!quantity.ok) return quantity;
  const shipBy = parseDay(record.ship_by, `${field}.ship_by`);
  if (!shipBy.ok) return shipBy;
  const orderId = parseId(record.order_id, `${field}.order_id`);
  if (!orderId.ok) return orderId;
  const sender = parseSender(record.sender, `${field}.sender`);
  if (!sender.ok) return sender;
  const approval = parseApproval(record.approval, `${field}.approval`);
  if (!approval.ok) return approval;
  const checks = parseChecks(record.checks, `${field}.checks`);
  if (!checks.ok) return checks;
  const decisions = parseDecisions(listed, `${field}.decisions`);
  if (!decisions.ok) return decisions;
  const faultMode = record.fault_mode;
  if (!isFaultSetting('order-desk', faultMode)) return refused('bad_shape', `${field}.fault_mode must be the empty text or a fault value of the Order Desk`);
  const confirmation: OrderConfirmation = {
    schema: CONFIRMATION_SCHEMA,
    outcome: 'done',
    po_number: poNumber.value,
    po_sha256: poSha.value,
    sku: sku.value,
    lot,
    quantity: quantity.value,
    ship_by: shipBy.value,
    order_id: orderId.value,
    sender: sender.value,
    approval: approval.value,
    checks: checks.value,
    decisions: decisions.value,
    fault_mode: faultMode,
  };
  return accepted(confirmation);
}
