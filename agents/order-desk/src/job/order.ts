// agents/order-desk/src/job/order.ts
// The job of the Order Desk (use case 1, inventory reorder): what it does after the Claim of an escrow. `runOrder` takes the record of the checks that the hook made, gets an X.509-SVID for the service
// key, reads the entry of the SKU in the catalogue of the supplier portal, takes the model decision `availability`, places the order with the SVID, writes the order book, and gives the confirmation.
//
// The steps, in order. A failure ends the job with an `OrderRefusal`, and nothing is written after it.
//   1. The record of the checks, by the escrow reference of the context. No record, or a record whose hash is not the hash of this body, is `precheck_missing`: the hook did not check this body.
//   2. The purchase order of the handoff, and the sender, the approval and the 16 checks of the confirmation from the record. A record that lacks a check, or holds a fact that cannot be read, is
//      `precheck_missing` too. A document that is not a purchase order is a fault of the service (`internal`).
//   3. The X.509-SVID. A failure of the gateway is `svid_failed`.
//   4. The catalogue entry. A refusal or a failure of the portal is `mock_system_failed`. The code of the portal goes to the log, and never to the text that the buyer reads.
//   5. The decision `availability`. A failed decision ends the job with its own code. `confirm: false` is `cannot_supply`, and no order is placed. Only `confirm: true` goes on.
//   6. The order, with the lot and the quantity of the purchase order (or with the fault, the wrong lot and its size). A refusal of the portal for a number that it holds is `duplicate_po`. Any other
//      refusal or failure is `mock_system_failed`. A draft of the confirmation is checked with the parser of the kit BEFORE the order is sent, so that no order is placed for which no valid
//      confirmation can be made. The clock is read BEFORE the order is sent too: the runtime stops waiting 30 seconds before `deliver_by`, and with an order call that could end after that, no order is
//      placed (`deadline`).
//   7. The order book, AFTER the portal took the order. A book that cannot be written is `store_write_failed`. The order exists then, so a caller that hung up during the order gets one line in the log.
//   8. The confirmation, checked by the parser of the kit.
//
// A job writes at most one order: the order call is made one time, and nothing retries it. The portal may hold an order after a call that gave no answer, so the log says so, and the portal itself refuses a
// second order for the same number. No order is placed unless the model said `confirm: true`. The fault changes the lot and the quantity of the order and of the confirmation and nothing else, and the
// fault value is in the confirmation and in no line of the log. The job writes no key, no certificate and no token to a log or to a text: a line holds codes, references and the names of members.
import { DEFAULT_CALL_TIMEOUT_MS, callWithX509Svid, fetchX509Svid, x509Target } from '@vsa/usecase-kit/access';
import type { MockBases, SystemFailed, SystemRefused, X509Target } from '@vsa/usecase-kit/access';
import type { ChecksRecord } from '@vsa/usecase-kit/checks';
import { DECISION_FAILURE_CODES } from '@vsa/usecase-kit/decision';
import type { DecisionFailure, DecisionFailureCode } from '@vsa/usecase-kit/decision';
import { CONFIRMATION_CHECKS, CONFIRMATION_SCHEMA, parseOrderConfirmation, parsePurchaseOrder } from '@vsa/usecase-kit/inventory';
import type { OrderConfirmation, PurchaseOrder } from '@vsa/usecase-kit/inventory';
import { ERROR_STATUS, accepted, canonicalSha256, isPlainObject, parseAttestationId, parseDid, refused } from '@vsa/usecase-kit/protocol';
import type { Decision, Did, Digest, FaultSetting, Handoff, JsonObject, JsonValue, ProtocolResult } from '@vsa/usecase-kit/protocol';
import type { JobContext, Refusal } from '@vsa/service-kit';
import { availabilityInput } from './availability.ts';
import type { AvailabilityChoice } from './availability.ts';
import { orderedOf } from './fault.ts';
import type { OrderedLot } from './fault.ts';
import type { OrderDeps } from './ports.ts';

// --- the refusal -----------------------------------------------------------------------------------------------------------------------------------

/** The status of each code of a refusal of the job: the status of that code in ERROR_STATUS of the protocol, so that the table of the job and the table of the protocol are one. */
export const ORDER_REFUSAL_STATUS = Object.freeze({
  precheck_missing: ERROR_STATUS.precheck_missing,
  svid_failed: ERROR_STATUS.svid_failed,
  mock_system_failed: ERROR_STATUS.mock_system_failed,
  inference_failed: ERROR_STATUS.inference_failed,
  model_output_invalid: ERROR_STATUS.model_output_invalid,
  cannot_supply: ERROR_STATUS.cannot_supply,
  duplicate_po: ERROR_STATUS.duplicate_po,
  store_write_failed: ERROR_STATUS.store_write_failed,
  internal: ERROR_STATUS.internal,
  deadline: ERROR_STATUS.deadline,
} as const);

export type OrderRefusalCode = keyof typeof ORDER_REFUSAL_STATUS;

/**
 * A job that ends with a refusal or a failure. It has the form of the `Refusal` of the service kit: a code, a status, a message and the kind `job`. The status is the status of the code, and a caller cannot
 * choose another one. For a status of 500 or more the service kit tells the buyer the code only and writes the message to its log. For `cannot_supply` and `duplicate_po` the buyer reads the message, so it is
 * fixed text, and for `cannot_supply` the first 120 characters of the note of the model.
 */
export class OrderRefusal extends Error implements Refusal {
  readonly code: OrderRefusalCode;
  readonly status: number;
  readonly kind = 'job' as const;

  constructor(code: OrderRefusalCode, message: string) {
    super(message);
    this.name = 'OrderRefusal';
    this.code = code;
    this.status = ORDER_REFUSAL_STATUS[code];
  }
}

/** The texts of the refusals. Each is fixed: no value of a request, a record or a portal stands in it. */
const TEXT = {
  precheck_missing: 'The job has no record of passed checks for this request.',
  svid_failed: 'The Order Desk could not get an X.509-SVID from the identity gateway.',
  mock_system_failed: 'The supplier portal did not take the call.',
  cannot_supply: 'The Order Desk cannot supply this order.',
  duplicate_po: 'The supplier portal already holds an order for this purchase order number.',
  order_book: 'The order book could not record the order.',
  deadline: 'The caller hung up, and the job stopped before it went on.',
  no_time: 'The job has too little time left to place the order.',
  internal: 'The job stopped on a fault of the service.',
} as const;

const DECISION_TEXT = {
  inference_failed: 'The model hire for the decision availability failed.',
  model_output_invalid: 'The answer of the model for the decision availability cannot be used.',
  store_write_failed: 'The record of the model hire could not be written.',
  internal: 'The decision availability stopped on a fault of the service.',
} as const satisfies Record<DecisionFailureCode, string>;

// --- the note of the model -------------------------------------------------------------------------------------------------------------------------

/** The most characters of the note of the model that the message of `cannot_supply` holds. */
const NOTE_CHARS = 120;
/** A control character, which holds the line breaks, and the two separators of Unicode that some readers take for a line break. */
const BREAKS = /[\p{Cc}\u2028\u2029]/gu;

/** The text cut to `max` characters, and never in the middle of a pair of surrogates. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** The message of `cannot_supply`: the fixed text, and the first 120 characters of the note with each line break turned into a space. A note of white space adds nothing. */
function cannotSupplyText(note: string): string {
  const line = cut(note.replace(BREAKS, ' '), NOTE_CHARS).trim();
  return line === '' ? TEXT.cannot_supply : `${TEXT.cannot_supply} Note of the model: ${line}`;
}

// --- the record of the checks ----------------------------------------------------------------------------------------------------------------------

/** The parts of the confirmation that come from the record of the hook. */
interface FromRecord {
  readonly sender: OrderConfirmation['sender'];
  readonly approval: OrderConfirmation['approval'];
  readonly checks: OrderConfirmation['checks'];
}

/** The end of the approval as the confirmation writes it: null, or the time in UTC with milliseconds that `toISOString` gives for a whole number of milliseconds. */
function endOf(value: unknown): ProtocolResult<string | null> {
  if (value === null) return accepted(null);
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    try {
      return accepted(new Date(value).toISOString());
    } catch {
      // A number beyond the times that a date holds: it is no end of an approval.
    }
  }
  return refused('bad_shape', 'the fact approval_valid_until is not null or a time in milliseconds');
}

/**
 * The sender, the approval and the checks of the confirmation, from the record. Every name of CONFIRMATION_CHECKS must be in the record with the value `true`, and the facts must have the types that the checks
 * of the hook give them. Anything else is a record that cannot be used, and the reason names the check or the fact and never its value. The sender is the sender of the handoff: the checks verified it.
 */
function readRecord(record: ChecksRecord, sender: Did): ProtocolResult<FromRecord> {
  if (!isPlainObject(record) || !isPlainObject(record.checks) || !isPlainObject(record.facts)) return refused('bad_shape', 'the record holds no checks or no facts');
  const { checks, facts } = record;
  for (const name of CONFIRMATION_CHECKS) {
    const passed: unknown = Object.hasOwn(checks, name) ? checks[name] : undefined;
    if (passed !== true) return refused('bad_shape', `the record does not hold the check ${name}`);
  }
  const own = (name: string): unknown => (Object.hasOwn(facts, name) ? facts[name] : undefined);
  const organisation = own('organisation');
  if (organisation !== null && typeof organisation !== 'string') return refused('bad_shape', 'the fact organisation is not null or a text');
  const verified = own('organisation_verified');
  if (typeof verified !== 'boolean') return refused('bad_shape', 'the fact organisation_verified is not true or false');
  const attestation = parseAttestationId(own('approval_attestation'));
  if (!attestation.ok) return refused('bad_shape', 'the fact approval_attestation is not an attestation id');
  const issuerFact = own('approval_issuer_did');
  const issuer = issuerFact === null ? accepted(null) : parseDid(issuerFact);
  if (!issuer.ok) return refused('bad_shape', 'the fact approval_issuer_did is not null or a DID');
  const end = endOf(own('approval_valid_until'));
  if (!end.ok) return end;
  // Each name is in the record with the value true (the loop above), so the entries make the object of the type.
  const confirmed = Object.fromEntries(CONFIRMATION_CHECKS.map((name) => [name, true as const])) as OrderConfirmation['checks'];
  return accepted({
    sender: { did: sender, organisation, organisation_verified: verified },
    approval: { attestation: attestation.value, issuer_did: issuer.value, valid_until: end.value },
    checks: confirmed,
  });
}

// --- the portal ------------------------------------------------------------------------------------------------------------------------------------

const isObject = (value: JsonValue): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The longest order id that the order book and the confirmation hold, in characters. */
const MAX_ORDER_ID_CHARS = 64;

/** What a failed call to the portal says in the log: the status, and the code that the portal gave. Never the detail: a detail repeats a part of the answer. */
function describeFailure(result: SystemRefused | SystemFailed): string {
  if (result.code === 'refused_by_system') return `refused by the portal (status ${result.status}, reason ${result.reason})`;
  const what = !result.sent ? 'not sent' : result.status === null ? 'no answer' : `status ${result.status}`;
  return `failed (${what}${result.systemCode === null ? '' : `, code ${result.systemCode}`})`;
}

/** The refusal of the portal for an order number that it holds: the status 409 and the code `duplicate_po`, as the portal gives them, and no other pair. */
const isDuplicate = (result: SystemRefused | SystemFailed): boolean => result.code === 'mock_system_failed' && result.status === 409 && result.systemCode === 'duplicate_po';

/** The two targets of the portal for a purchase order: the entry of its SKU in the catalogue, and the orders. Both are on the client-certificate host. */
function targetsOf(bases: MockBases, order: PurchaseOrder): ProtocolResult<{ readonly catalogue: X509Target; readonly orders: X509Target }> {
  const catalogue = x509Target(bases, order.tenant, 'supplier.catalogue', { sku: order.sku });
  if (!catalogue.ok) return catalogue;
  const orders = x509Target(bases, order.tenant, 'supplier.orders');
  return orders.ok ? accepted({ catalogue: catalogue.value, orders: orders.value }) : orders;
}

// --- the decision ----------------------------------------------------------------------------------------------------------------------------------

/** The code of a failed decision: one of the four codes of the kit, and `internal` for anything else, so that a result that cannot be read never has a code that the protocol does not list. */
function decisionCodeOf(failure: DecisionFailure): DecisionFailureCode {
  return (DECISION_FAILURE_CODES as readonly unknown[]).includes(failure?.code) ? failure.code : 'internal';
}

/** What a failed decision says in the log: the code of the hire, its stage and its escrow, and whether the supplier of the model was paid. Never the detail, the prompt or the answer. */
function describeDecision(failure: DecisionFailure): string {
  const paid = failure?.delivery?.accepted;
  const parts = [
    `the decision availability failed: reason ${String(failure?.reason)}, stage ${String(failure?.stage)}`,
    typeof failure?.escrow_ref === 'string' ? `escrow ${failure.escrow_ref}` : '',
    paid === undefined ? '' : `the model supplier may be paid (accepted ${String(paid)})`,
  ];
  return parts.filter((part) => part !== '').join(', ');
}

// --- the confirmation ------------------------------------------------------------------------------------------------------------------------------

/** What the confirmation is made of. Each part is checked before it gets here, and the parser of the kit checks the whole. */
interface Parts {
  readonly order: PurchaseOrder;
  readonly poSha256: Digest;
  readonly ordered: OrderedLot;
  readonly choice: AvailabilityChoice;
  readonly decision: Decision<AvailabilityChoice>;
  readonly record: FromRecord;
  readonly mode: FaultSetting<'order-desk'>;
}

/** The order id of the draft of the confirmation. The draft is checked before the order is placed and never leaves this file, so the id of the portal is not known yet. The id has the form that the parser takes. */
const DRAFT_ORDER_ID = 'order-id-not-known-yet';

function confirmationOf(parts: Parts, orderId: string): OrderConfirmation {
  const { order, ordered, choice, record } = parts;
  return {
    schema: CONFIRMATION_SCHEMA,
    outcome: 'done',
    po_number: order.po_number,
    po_sha256: parts.poSha256,
    sku: order.sku,
    lot: ordered.lot,
    quantity: ordered.quantity,
    ship_by: choice.ship_by,
    order_id: orderId,
    sender: record.sender,
    approval: record.approval,
    checks: record.checks,
    decisions: [parts.decision],
    fault_mode: parts.mode,
  };
}

/** The name of an error for a log line. The message of an error is never logged: it can name a path or a host. */
const kindOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** How long before `deliver_by` the runtime stops waiting for the job, in milliseconds. */
const RUNTIME_MARGIN_MS = 30_000;

// --- the job ---------------------------------------------------------------------------------------------------------------------------------------

/**
 * Does the job of an escrow that the Order Desk claimed, and gives the confirmation, or throws an `OrderRefusal`. `request` is the handoff that the server parsed, `context` is what the runtime said of the
 * escrow, and `arrivedAt` is the time of the clock of the service when the job arrived. `signal` aborts when the caller hangs up: the job looks at it before the model is hired and before the order is placed,
 * and again after the order book is written. After that last look the order exists and is booked, so the job goes on and writes one line to the log. It never passes the signal into a hire. See the head of
 * this file for the steps and the codes.
 */
export async function runOrder(deps: OrderDeps, request: Handoff, context: JobContext, arrivedAt: number, signal?: AbortSignal): Promise<OrderConfirmation> {
  const say = (text: string): void => {
    try {
      deps.log(`order desk: ${text} (escrow ${context.escrowRef}, ${deps.clock() - arrivedAt} ms)`);
    } catch {
      // A log that fails changes nothing.
    }
  };
  /** The refusal for a failure, after one line in the log with the reason. The caller throws it. */
  const refuse = (code: OrderRefusalCode, message: string, why: string): OrderRefusal => {
    say(`${code}: ${why}`);
    return new OrderRefusal(code, message);
  };
  const stopIfAbandoned = (before: string): void => {
    if (signal?.aborted === true) throw refuse('deadline', TEXT.deadline, `the caller hung up, so the job stops before ${before}`);
  };

  // The setting of the fault is read one time. Every use below is this value, so an order and a result never come from two reads.
  const mode = deps.fault.mode;

  // 1. The record of the checks, for this escrow and for this body.
  const taken = deps.takeChecks(context.escrowRef);
  if (taken === null) throw refuse('precheck_missing', TEXT.precheck_missing, 'there is no record of passed checks for this escrow');
  const requestHash = canonicalSha256(request);
  const documentHash = canonicalSha256(request.document);
  if (!requestHash.ok || !documentHash.ok || taken.request_sha256 !== requestHash.value) {
    throw refuse('precheck_missing', TEXT.precheck_missing, 'the record of passed checks is for another request');
  }

  // 2. The purchase order, and the parts of the confirmation that come from the record.
  const parsedOrder = parsePurchaseOrder(request.document, 'handoff.document');
  if (!parsedOrder.ok) throw refuse('internal', TEXT.internal, `the document of the handoff is not a purchase order: ${parsedOrder.detail}`);
  const order = parsedOrder.value;
  const fromRecord = readRecord(taken.record, request.sender_did);
  if (!fromRecord.ok) throw refuse('precheck_missing', TEXT.precheck_missing, `the record of passed checks cannot be used: ${fromRecord.detail}`);

  // 3. The X.509-SVID of the service key, for this job.
  const svid = await fetchX509Svid(deps.svid, { did: deps.agent.did, key: deps.agent.authenticationKey });
  if (!svid.ok) throw refuse('svid_failed', TEXT.svid_failed, `the gateway gave no X.509-SVID: ${svid.code} (status ${svid.status})`);

  // 4. The entry of the SKU in the catalogue of the supplier portal.
  const targets = targetsOf(deps.calls.bases, order);
  if (!targets.ok) throw refuse('mock_system_failed', TEXT.mock_system_failed, `the target of a call to the portal cannot be made: ${targets.detail}`);
  const read = await callWithX509Svid(deps.calls, svid.value, targets.value.catalogue);
  if (!read.ok) throw refuse('mock_system_failed', TEXT.mock_system_failed, `the catalogue read ${describeFailure(read)}`);
  const entry = read.body;
  if (!isObject(entry)) throw refuse('mock_system_failed', TEXT.mock_system_failed, 'the answer of the catalogue is not a JSON object');

  // 5. The decision. Only `confirm: true` goes on.
  stopIfAbandoned('the decision');
  const decided = await deps.decide(availabilityInput(order, entry));
  if (decided?.ok !== true) {
    const code = decisionCodeOf(decided);
    throw refuse(code, DECISION_TEXT[code], describeDecision(decided));
  }
  const decision = decided.value;
  const choice = decision.choice;
  const confirm: unknown = choice.confirm;
  if (confirm === false) throw refuse('cannot_supply', cannotSupplyText(choice.note), 'the model did not confirm the order, so no order is placed');
  if (confirm !== true) throw refuse('model_output_invalid', DECISION_TEXT.model_output_invalid, 'the choice of the decision has a confirm that is not true or false');

  // 6. The order. The draft of the confirmation is checked first: no order is placed for which no valid confirmation can be made.
  const ordered = orderedOf(mode, order, deps.lots);
  if (ordered === null) throw refuse('internal', TEXT.internal, 'the lots file has no size for the lot that the order names');
  const parts: Parts = { order, poSha256: documentHash.value, ordered, choice, decision, record: fromRecord.value, mode };
  const draft = parseOrderConfirmation(confirmationOf(parts, DRAFT_ORDER_ID));
  if (!draft.ok) throw refuse('internal', TEXT.internal, `no valid confirmation can be made, so no order is placed: ${draft.detail}`);
  stopIfAbandoned('the order');
  // The runtime stops waiting for the job 30 seconds before `deliver_by`, and the order call may take as long as its limit. An order that the portal takes after that is never confirmed to the buyer, so with
  // too little time left no order is placed. The test is written so that a time that is not a number refuses: a time that is not known is never enough time.
  const callMs = deps.calls.timeoutMs === undefined ? DEFAULT_CALL_TIMEOUT_MS : deps.calls.timeoutMs;
  const now = deps.clock();
  if (!(now + callMs <= context.deliverByMs - RUNTIME_MARGIN_MS)) {
    throw refuse('deadline', TEXT.no_time, `the order call could end after the runtime stops waiting, so no order is placed (${context.deliverByMs - RUNTIME_MARGIN_MS - now} ms are left, and the call may take ${callMs} ms)`);
  }
  const body: JsonValue = { po_number: order.po_number, po_sha256: documentHash.value, sku: order.sku, lot: ordered.lot, quantity: ordered.quantity, ship_by: choice.ship_by };
  const placed = await callWithX509Svid(deps.calls, svid.value, targets.value.orders, body);
  if (!placed.ok) {
    if (isDuplicate(placed)) throw refuse('duplicate_po', TEXT.duplicate_po, 'the portal refused the order: status 409, code duplicate_po');
    const may = placed.code === 'mock_system_failed' && placed.sent ? '; the order may exist at the portal' : '';
    throw refuse('mock_system_failed', TEXT.mock_system_failed, `the order call ${describeFailure(placed)}${may}`);
  }
  const orderId = isObject(placed.body) && Object.hasOwn(placed.body, 'order_id') ? placed.body.order_id : undefined;
  if (typeof orderId !== 'string' || orderId.length < 1 || orderId.length > MAX_ORDER_ID_CHARS) {
    throw refuse('mock_system_failed', TEXT.mock_system_failed, 'the answer of the portal holds no order id that can be read, so the order may exist at the portal');
  }

  // 7. The order book, after the portal took the order.
  try {
    await deps.book.record(order.tenant, order.po_number, orderId);
  } catch (error) {
    throw refuse('store_write_failed', TEXT.order_book, `the order book could not record the order ${orderId} (${kindOf(error)}), and the portal holds the order`);
  }
  // The signal is read after the commitment too. The order exists and is booked, so the job goes on and gives the confirmation, which a caller that hung up does not read.
  if (signal?.aborted === true) say(`the caller hung up while the order was placed: the order ${orderId} exists and is booked`);

  // 8. The confirmation.
  const confirmation = parseOrderConfirmation(confirmationOf(parts, orderId));
  if (!confirmation.ok) throw refuse('internal', TEXT.internal, `the confirmation cannot be made after the order ${orderId} was placed and booked: ${confirmation.detail}`);
  say(`placed the order ${orderId} for the purchase order ${order.po_number}`);
  return confirmation.value;
}
