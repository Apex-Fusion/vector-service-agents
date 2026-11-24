// agents/prior-authorization-agent/src/execute/decision.ts
// The decision on the delivery of the Insurer Intake Agent. The hire flow asks it after the eight checks of the receipt and before the Accept. It has three parts, in this order, and the first two need no model:
//   1. The text of the delivery must be an intake record (`parseIntakeRecord`, which takes a hash in lower case only). Else the reason is `intake_record_invalid`.
//   2. The record must answer this request: its `request_number` is the number of the request that was SENT, and its sender is this agent. Else the reason is `intake_not_for_request`.
//   3. The model decides (`accept_delivery`): it compares the hash of the request that was sent with the hash that the record names. `declined_by_model` is its no. `decision_failed` is a decision that could not
//      be made or read.
// A delivery that fails the part 1 or the part 2 is never given to the model, and the model is not paid for it. No part is a reason for a challenge except the no of the model: a challenge needs the decision
// of the model as its ground. The record is read before the model and before any challenge, so a hash that is right and in upper case never reaches the evidence as a contradiction.
//
// The model gets two request numbers and two hashes, and nothing else: the number and the hash of the request that was sent (the hash is computed by the job from the document of the handoff, and never taken from the
// record), and the number and the hash that the record names. No free text of the Insurer Intake Agent reaches the model.
//
// The decision accepts only for the boolean `true` of a choice that names no value and that is the choice that the recorded decision holds. Any other answer of the model port, a failure, a throw and a value of
// another type included, is `decision_failed`, and nothing is accepted. The judge keeps what it learned (which of the five ends, the decision when the model made one, and the record when the model accepted), so
// that the job reads it after the hire.
import type { AcceptDecision } from '@vsa/hire-kit';
import type { DeliveryDecision, VerifiedDelivery } from '@vsa/usecase-kit/buyer';
import { parseIntakeRecord } from '@vsa/usecase-kit/priorauth';
import type { IntakeRecord } from '@vsa/usecase-kit/priorauth';
import { canonicalJson, isPlainObject } from '@vsa/usecase-kit/protocol';
import type { Decision, Did } from '@vsa/usecase-kit/protocol';
import type { ExecuteDeps, MismatchName, RequestSide } from './ports.ts';

/** What the decision tells the hire kit when it does not accept. The job reads the same words back from the step `not_accepted` of the hire. */
export const NOT_ACCEPTED = {
  invalid: 'intake_record_invalid',
  notForRequest: 'intake_not_for_request',
  declined: 'declined_by_model',
  failed: 'decision_failed',
} as const;

/**
 * What the decision learned of a delivery. A model that made a decision gives it with `accepted` and with `declined_by_model`. `accepted` also holds the record that the model judged: the submission is written from
 * it. The two checks in code and a failed decision hold no decision.
 */
export type Learned =
  | { readonly said: 'accepted'; readonly decision: Decision; readonly record: IntakeRecord }
  | { readonly said: typeof NOT_ACCEPTED.declined; readonly decision: Decision; readonly mismatch: readonly MismatchName[] }
  | { readonly said: typeof NOT_ACCEPTED.invalid }
  | { readonly said: typeof NOT_ACCEPTED.notForRequest }
  | { readonly said: typeof NOT_ACCEPTED.failed; readonly code: string };

export interface DeliveryJudge {
  /** The decision of the hire: it accepts, or it says no with one of the four reasons of `NOT_ACCEPTED`. */
  readonly decide: DeliveryDecision;
  /** What the decision learned, or `null` when it has not run. */
  readonly learned: () => Learned | null;
}

export interface JudgeDeps {
  readonly acceptDelivery: ExecuteDeps['acceptDelivery'];
  /** The DID of this agent: the sender that an intake record for this request names. */
  readonly agent: Did;
  /** One line for the log. It never throws. */
  readonly note: (line: string) => void;
}

/** A code that may stand in a log line: lower-case letters, digits and "_", 64 characters at most. */
const CODE = /^[a-z0-9_]{1,64}$/;
const INVALID_CODE = 'invalid_code';

/** The code of a failed decision as the model port gave it, when it is a code. The text of a port could be anything, so no other text goes into a result or a log line. */
function codeOf(value: unknown): string {
  return typeof value === 'string' && CODE.test(value) ? value : INVALID_CODE;
}

type Read =
  | { readonly ok: true; readonly decision: Decision; readonly accept: boolean; readonly mismatch: readonly MismatchName[] }
  | { readonly ok: false; readonly code: string };

const unreadable = (code: string): Read => ({ ok: false, code });

/**
 * The answer of the model port as a decision that was made, or the code of why it is not one. The answer is read as a value of an unknown type: `ok` must be `true`, the decision must be an object, `accept` must
 * be a boolean, `mismatch` must be a list of at most one name and the name is `request_sha256`, the choice must not contradict itself (it accepts exactly when `mismatch` is empty), and it must be the choice that the
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
  if (!Array.isArray(mismatch) || mismatch.length > 1 || !mismatch.every((name): name is MismatchName => name === 'request_sha256')) return unreadable('choice_invalid');
  // A choice that contradicts itself is no decision: it accepts exactly when it names no value. The Accept cannot be undone, so the job acts on neither side of a contradiction.
  if (accept === (mismatch.length > 0)) return unreadable('choice_invalid');
  const recorded = canonicalJson(Reflect.get(decision, 'choice'));
  const typed = canonicalJson(choice);
  if (!recorded.ok || !typed.ok || recorded.value !== typed.value) return unreadable('choice_not_recorded');
  // The checks above leave an object that has the members of a decision of the protocol: the port gives the record that the model hire made.
  return { ok: true, decision: decision as Decision, accept, mismatch };
}

/** The decision of the hire for the request that was sent. `sent` holds the number of that request and the canonical hash of the document of the handoff. */
export function judgeDelivery(deps: JudgeDeps, sent: RequestSide): DeliveryJudge {
  let learned: Learned | null = null;
  const refuse = (said: typeof NOT_ACCEPTED.invalid | typeof NOT_ACCEPTED.notForRequest, line: string): AcceptDecision => {
    learned = { said };
    deps.note(line);
    return { accept: false, reason: said };
  };
  const decide = async (delivery: VerifiedDelivery): Promise<AcceptDecision> => {
    const parsed = delivery.result === null ? null : parseIntakeRecord(delivery.result);
    if (parsed === null || !parsed.ok) return refuse(NOT_ACCEPTED.invalid, 'execute: the answer of the Insurer Intake Agent is not an intake record, so the model was not asked');
    const record = parsed.value;
    // The number must be the number of the request that was sent, letter for letter, and the sender must be this agent. A record for another request is no ground for a challenge: the evidence could not state it.
    if (record.request_number !== sent.request_number || record.sender.did !== deps.agent) {
      return refuse(NOT_ACCEPTED.notForRequest, 'execute: the intake record does not answer this request by its number and its sender, so the model was not asked');
    }
    let read: Read;
    try {
      read = readAnswer(
        await deps.acceptDelivery(
          { request_number: sent.request_number, request_sha256: sent.request_sha256 },
          { request_number: record.request_number, request_sha256: record.request_sha256 },
        ),
      );
    } catch {
      read = unreadable('decision_threw');
    }
    if (!read.ok) {
      learned = { said: NOT_ACCEPTED.failed, code: read.code };
      deps.note(`execute: the decision accept_delivery failed (${read.code})`);
      return { accept: false, reason: NOT_ACCEPTED.failed };
    }
    if (read.accept) {
      learned = { said: 'accepted', decision: read.decision, record };
      deps.note('execute: the model accepts the delivery');
      return { accept: true };
    }
    learned = { said: NOT_ACCEPTED.declined, decision: read.decision, mismatch: read.mismatch };
    deps.note(`execute: the model does not accept the delivery, it names ${read.mismatch.length === 0 ? 'no value' : read.mismatch.join(', ')}`);
    return { accept: false, reason: NOT_ACCEPTED.declined };
  };
  return { decide, learned: () => learned };
}
