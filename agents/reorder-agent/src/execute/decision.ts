// agents/reorder-agent/src/execute/decision.ts
// The decision on the delivery of the Order Desk. The hire flow asks it after the eight checks of the receipt and before the Accept. It has three parts, in this order, and the first two need no model:
//   1. The text of the delivery must be an order confirmation (`parseOrderConfirmation`). Else the reason is `confirmation_invalid`.
//   2. The confirmation must answer this order: its `po_number` is the number of the order, and its `po_sha256` is the canonical hash of the order document, with no salt (the value that the Order Desk
//      writes). Else the reason is `confirmation_not_for_order`.
//   3. The model decides (`accept_delivery`): it compares the SKU, the lot and the quantity. `declined_by_model` is its no. `decision_failed` is a decision that could not be made or read.
// A delivery that fails the part 1 or the part 2 is never given to the model, and the model is not paid for it. No part is a reason for a challenge except the no of the model: a challenge needs the
// decision of the model as its ground.
//
// The decision accepts only for the boolean `true` of a choice that names no field and that is the choice that the recorded decision holds. Any other answer of the model port, a failure, a throw and a
// value of another type included, is `decision_failed`, and nothing is accepted. The judge keeps what it learned (which of the five ends, and the decision when the model made one), so that the job reads it after the hire.
import type { AcceptDecision } from '@vsa/hire-kit';
import type { DeliveryDecision, VerifiedDelivery } from '@vsa/usecase-kit/buyer';
import { parseOrderConfirmation } from '@vsa/usecase-kit/inventory';
import type { PurchaseOrder } from '@vsa/usecase-kit/inventory';
import { canonicalJson, isPlainObject } from '@vsa/usecase-kit/protocol';
import type { Decision, Digest } from '@vsa/usecase-kit/protocol';
import type { ExecuteDeps, OrderField } from './ports.ts';

/** What the decision tells the hire kit when it does not accept. The job reads the same words back from the step `not_accepted` of the hire. */
export const NOT_ACCEPTED = {
  invalid: 'confirmation_invalid',
  notForOrder: 'confirmation_not_for_order',
  declined: 'declined_by_model',
  failed: 'decision_failed',
} as const;

/** What the decision learned of a delivery. A model that made a decision gives it with `accepted` and with `declined_by_model`. The two checks in code and a failed decision hold no decision. */
export type Learned =
  | { readonly said: 'accepted'; readonly decision: Decision }
  | { readonly said: typeof NOT_ACCEPTED.declined; readonly decision: Decision; readonly mismatch: readonly OrderField[] }
  | { readonly said: typeof NOT_ACCEPTED.invalid }
  | { readonly said: typeof NOT_ACCEPTED.notForOrder }
  | { readonly said: typeof NOT_ACCEPTED.failed; readonly code: string };

export interface DeliveryJudge {
  /** The decision of the hire: it accepts, or it says no with one of the four reasons of `NOT_ACCEPTED`. */
  readonly decide: DeliveryDecision;
  /** What the decision learned, or `null` when it has not run. */
  readonly learned: () => Learned | null;
}

export interface JudgeDeps {
  readonly acceptDelivery: ExecuteDeps['acceptDelivery'];
  /** One line for the log. It never throws. */
  readonly note: (line: string) => void;
}

const FIELDS: readonly OrderField[] = ['sku', 'lot', 'quantity'];
/** A code that may stand in a log line: lower-case letters, digits and "_", 64 characters at most. */
const CODE = /^[a-z0-9_]{1,64}$/;
const INVALID_CODE = 'invalid_code';

/** The code of a failed decision as the model port gave it, when it is a code. The text of a port could be anything, so no other text goes into a result or a log line. */
function codeOf(value: unknown): string {
  return typeof value === 'string' && CODE.test(value) ? value : INVALID_CODE;
}

type Read =
  | { readonly ok: true; readonly decision: Decision; readonly accept: boolean; readonly mismatch: readonly OrderField[] }
  | { readonly ok: false; readonly code: string };

const unreadable = (code: string): Read => ({ ok: false, code });

/**
 * The answer of the model port as a decision that was made, or the code of why it is not one. The answer is read as a value of an unknown type: `ok` must be `true`, the decision must be an object,
 * `accept` must be a boolean, `mismatch` must be a list of the three fields, the choice must not contradict itself (it accepts exactly when `mismatch` is empty), and it must be the choice that the
 * recorded decision holds, so that the Accept never rests on a value that the record does not show.
 */
function readAnswer(answer: unknown): Read {
  if (typeof answer !== 'object' || answer === null) return unreadable('answer_missing');
  const ok: unknown = Reflect.get(answer, 'ok');
  if (ok === false) return unreadable(codeOf(Reflect.get(answer, 'code')));
  if (ok !== true) return unreadable('answer_invalid');
  const decision: unknown = Reflect.get(answer, 'decision');
  const choice: unknown = Reflect.get(answer, 'choice');
  if (typeof decision !== 'object' || decision === null || !isPlainObject(choice)) return unreadable('answer_invalid');
  const accept: unknown = choice.accept;
  const mismatch: unknown = choice.mismatch;
  if (typeof accept !== 'boolean') return unreadable('choice_invalid');
  if (!Array.isArray(mismatch) || !mismatch.every((field): field is OrderField => (FIELDS as readonly unknown[]).includes(field))) return unreadable('choice_invalid');
  // A choice that contradicts itself is no decision: it accepts exactly when it names no field. The Accept cannot be undone, so the job acts on neither side of a contradiction.
  if (accept === (mismatch.length > 0)) return unreadable('choice_invalid');
  const recorded = canonicalJson(Reflect.get(decision, 'choice'));
  const typed = canonicalJson(choice);
  if (!recorded.ok || !typed.ok || recorded.value !== typed.value) return unreadable('choice_not_recorded');
  // The checks above leave an object that has the members of a decision of the protocol: the port gives the record that the model hire made.
  return { ok: true, decision: decision as Decision, accept, mismatch };
}

/** The decision of the hire for the order. `orderSha256` is the canonical hash of the order document. */
export function judgeDelivery(deps: JudgeDeps, order: PurchaseOrder, orderSha256: Digest): DeliveryJudge {
  let learned: Learned | null = null;
  const refuse = (said: typeof NOT_ACCEPTED.invalid | typeof NOT_ACCEPTED.notForOrder, line: string): AcceptDecision => {
    learned = { said };
    deps.note(line);
    return { accept: false, reason: said };
  };
  const decide = async (delivery: VerifiedDelivery): Promise<AcceptDecision> => {
    const confirmation = parseOrderConfirmation(delivery.result);
    if (!confirmation.ok) return refuse(NOT_ACCEPTED.invalid, 'execute: the answer of the Order Desk is not an order confirmation, so the model was not asked');
    if (confirmation.value.po_number !== order.po_number || confirmation.value.po_sha256 !== orderSha256) {
      return refuse(NOT_ACCEPTED.notForOrder, 'execute: the confirmation does not answer this order by its number and its hash, so the model was not asked');
    }
    let read: Read;
    try {
      read = readAnswer(await deps.acceptDelivery(order, confirmation.value));
    } catch {
      read = unreadable('decision_threw');
    }
    if (!read.ok) {
      learned = { said: NOT_ACCEPTED.failed, code: read.code };
      deps.note(`execute: the decision accept_delivery failed (${read.code})`);
      return { accept: false, reason: NOT_ACCEPTED.failed };
    }
    if (read.accept) {
      learned = { said: 'accepted', decision: read.decision };
      deps.note('execute: the model accepts the delivery');
      return { accept: true };
    }
    learned = { said: NOT_ACCEPTED.declined, decision: read.decision, mismatch: read.mismatch };
    deps.note(`execute: the model does not accept the delivery, it names ${read.mismatch.length === 0 ? 'no field' : read.mismatch.join(', ')}`);
    return { accept: false, reason: NOT_ACCEPTED.declined };
  };
  return { decide, learned: () => learned };
}
