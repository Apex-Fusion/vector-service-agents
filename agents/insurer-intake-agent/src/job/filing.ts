// agents/insurer-intake-agent/src/job/filing.ts
// Steps 7 and 8 of the job of the Insurer Intake Agent (use case 2, prior authorization): the filing of the request in the insurer portal, and the intake book. The portal files one entry for each request
// number, and the intake book keeps the entries that the agent made, so the next hook can refuse a number that the agent filed already.
//
//   7. The filing: one POST to the insurer system of the tenant with the JWT-SVID, with `{ request, status, missing }`. The request is the document, and the status and the missing ids are those of the
//      draft of the intake record, so the portal gets what the record will say. The call is made one time and nothing retries it. Before it, in this order: the draft is checked with the parser of the
//      kit (`internal`), so that no entry is filed for which no valid record can be made, and it must name the request number of the document (`internal`); then `checkBeforeFiling`: the signal is read,
//      and a caller that hung up files nothing (`deadline`); and the clock is read, and a call that could end after `deliver_by` less 30 seconds files nothing (`deadline`): the runtime stops waiting
//      then, and an entry that the portal takes after that is never answered to the buyer. A time that is not a number is never enough time: the test is written so that it refuses.
//      The answer. 201 with an intake id and the number of this request is the one good answer: the intake id must have the form of an identifier of the portal, and the body must name this request number.
//      A 409 with the code `duplicate_request` is `duplicate_request`: the portal holds an entry for the number already. Any other refusal or failure, and a 201 that holds no usable entry, is
//      `mock_system_failed`: a code of the portal is never a code of this job. The portal may hold the entry after a call that gave no answer, or an answer that cannot be read, so the log says so. The portal
//      itself refuses a second entry for the number, so a later job for the same request is a `duplicate_request` and never a second entry.
//   8. The intake book, AFTER the portal took the entry: `book.record(tenant, request_number, intake_id)`. A book that cannot be written is `store_write_failed`, and the log says that the entry exists in
//      the portal. Nothing is written after that refusal.
//
// The signal is read before the filing and never passed into the call, because the entry that the portal takes cannot be taken back: a caller that hangs up during the call still gets the entry in the book.
// The log never holds the body of an answer, a message of the portal or of an error, a token, a key or a part of the request: a line has codes, statuses, and the intake id.
import { DEFAULT_CALL_TIMEOUT_MS, callWithJwtSvid, jwtSvidTarget } from '@vsa/usecase-kit/access';
import type { JwtSvidCredential, SystemFailed, SystemRefused } from '@vsa/usecase-kit/access';
import { parseIntakeRecord } from '@vsa/usecase-kit/priorauth';
import type { IntakeRecord, PriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import { isPlainObject } from '@vsa/usecase-kit/protocol';
import type { IntakeDeps } from './ports.ts';
import { INTAKE_REFUSAL_TEXT, refuse } from './refusal.ts';
import type { IntakeRefusalCode } from './refusal.ts';

/** How long before `deliver_by` the runtime stops waiting for the job, in milliseconds. */
export const RUNTIME_MARGIN_MS = 30_000;

/** The fixed texts of the codes that the filing gives, and the text of a caller that hung up. Each is fixed: no value of a request, a record or a portal stands in it. */
export const FILING_TEXT = Object.freeze({
  duplicate_request: 'The insurer portal already holds an entry for this request number.',
  intake_book: 'The intake book could not record the entry.',
  hung_up: 'The caller hung up, and the job stopped before it went on.',
  no_time: 'The job has too little time left to file the request.',
} as const);

/** What one filing needs. */
export interface FilingInput {
  /** The JWT-SVID of the service key for the insurer system of the tenant. It must still be valid for the whole call: the job asks for a new one when it is not. */
  readonly svid: JwtSvidCredential;
  /** The authorization request as the kit parser copied it. It is the `request` of the body. */
  readonly document: PriorAuthRequest;
  /**
   * The intake record with a stand-in `intake_id` that has the form of an identifier. The parser of the kit checks it before the call. Its status and its missing ids are the status and the missing ids of the
   * body, and its request number is the one of the document.
   */
  readonly draft: IntakeRecord;
  /** The `deliver_by` of the escrow, in milliseconds of the clock of the job. */
  readonly deliverBy: number;
  /** Aborts when the caller hangs up. It is read before the filing and after the book is written, and it never goes into the call. */
  readonly signal?: AbortSignal;
}

/** The name of an error for a log line. The message of an error is never logged: it can name a path or a host. */
const kindOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** What a failed call to the portal says in the log: the status and the code that the portal gave, or the fixed reason of the kit for a call that it did not send. Never the detail of a call that was sent. */
function describeFailure(result: SystemRefused | SystemFailed): string {
  if (result.code === 'refused_by_system') return `refused by the portal (status ${result.status}, reason ${result.reason})`;
  if (!result.sent) return `failed (not sent: ${result.detail})`;
  const what = result.status === null ? 'no answer' : `status ${result.status}`;
  return `failed (${what}${result.systemCode === null ? '' : `, code ${result.systemCode}`})`;
}

/** The refusal of the portal for a number that it holds: the status 409 and the code `duplicate_request`, as the portal gives them, and no other pair. */
const isDuplicate = (result: SystemRefused | SystemFailed): boolean => result.code === 'mock_system_failed' && result.status === 409 && result.systemCode === 'duplicate_request';

/** True when the portal may hold the entry although the call failed: the request was sent, and no 4xx status says that the portal refused it. A refusal (401 or 403) is a 4xx too. */
function mayHoldEntry(result: SystemRefused | SystemFailed): boolean {
  if (result.code === 'refused_by_system') return false;
  return result.sent && !(result.status !== null && result.status >= 400 && result.status < 500);
}

/**
 * Refuses a filing that must not start now, and gives nothing when it may start. The signal is read, and a caller that hung up files nothing (`deadline`). The clock is read, and a call that could end after
 * `deliver_by` less 30 seconds files nothing (`deadline`). A time that is not a number is never enough time: the test is written so that it refuses. The job calls it before it asks the gateway for a new
 * JWT-SVID too, so a caller that hung up, or a time that is gone, never costs a call to the gateway and never ends with `svid_failed`. `fileRequest` calls it again before its own call, because the new
 * JWT-SVID takes time.
 */
export function checkBeforeFiling(deps: Pick<IntakeDeps, 'calls' | 'clock' | 'log'>, input: { readonly deliverBy: number; readonly signal?: AbortSignal }): void {
  if (input.signal?.aborted === true) throw refuse(deps.log, 'deadline', FILING_TEXT.hung_up, 'the caller hung up, so the job stops before the filing');
  const callMs = deps.calls.timeoutMs === undefined ? DEFAULT_CALL_TIMEOUT_MS : deps.calls.timeoutMs;
  const now = deps.clock();
  if (!(now + callMs <= input.deliverBy - RUNTIME_MARGIN_MS)) {
    throw refuse(deps.log, 'deadline', FILING_TEXT.no_time, `the filing call could end after the runtime stops waiting, so no request is filed (${input.deliverBy - RUNTIME_MARGIN_MS - now} ms are left, and the call may take ${callMs} ms)`);
  }
}

/**
 * Files the request and records the entry, and gives the `intake_id` of the portal, or throws an `IntakeRefusal`. `deps.calls.timeoutMs` is the longest time of the call (60 seconds when it is not set).
 * See the head of this file for the order of the checks, the answers and the codes.
 */
export async function fileRequest(deps: Pick<IntakeDeps, 'calls' | 'book' | 'clock' | 'log'>, input: FilingInput): Promise<string> {
  const fail = (code: IntakeRefusalCode, message: string, why: string) => refuse(deps.log, code, message, why);
  const { document } = input;

  // The draft of the record is checked first: no entry is filed for which no valid record can be made. The detail of the parser is not logged, because it can name a member of the request. The status, the
  // missing ids and the request number are read one time, from the checked copy of the draft.
  const parsed = parseIntakeRecord(input.draft);
  if (!parsed.ok) throw fail('internal', INTAKE_REFUSAL_TEXT.internal, 'no valid intake record can be made, so no request is filed');
  const draft = parsed.value;
  if (draft.request_number !== document.request_number) throw fail('internal', INTAKE_REFUSAL_TEXT.internal, 'the draft of the intake record is for another request number than the request, so no request is filed');
  checkBeforeFiling(deps, input);

  // 7. The filing: one call, no retry.
  const target = jwtSvidTarget(deps.calls.bases, document.tenant, 'insurer.requests');
  if (!target.ok) throw fail('mock_system_failed', INTAKE_REFUSAL_TEXT.mock_system_failed, `the target of the filing cannot be made: ${target.detail}`);
  const answer = await callWithJwtSvid(deps.calls, input.svid, target.value, { request: { ...document }, status: draft.status, missing: [...draft.missing] });
  if (!answer.ok) {
    if (isDuplicate(answer)) throw fail('duplicate_request', FILING_TEXT.duplicate_request, 'the portal refused the filing: status 409, code duplicate_request');
    const may = mayHoldEntry(answer) ? '; the entry may exist at the portal' : '';
    throw fail('mock_system_failed', INTAKE_REFUSAL_TEXT.mock_system_failed, `the filing ${describeFailure(answer)}${may}`);
  }
  const unusable = (why: string) => fail('mock_system_failed', INTAKE_REFUSAL_TEXT.mock_system_failed, `${why}, so the entry may exist at the portal`);
  if (answer.status !== 201) throw unusable(`the filing was answered with status ${answer.status} and not 201`);
  const { body } = answer;
  const intakeId: unknown = isPlainObject(body) && Object.hasOwn(body, 'intake_id') ? body.intake_id : undefined;
  const named: unknown = isPlainObject(body) && Object.hasOwn(body, 'request_number') ? body.request_number : undefined;
  // The intake id must make a valid record, and the record checks the form of an identifier. Only the id differs from the draft, which passed.
  if (typeof intakeId !== 'string' || !parseIntakeRecord({ ...draft, intake_id: intakeId }).ok) throw unusable('the answer of the portal holds no intake id that can be read');
  if (named !== document.request_number) throw unusable('the answer of the portal names another request number');

  // 8. The intake book, after the portal took the entry.
  try {
    await deps.book.record(document.tenant, document.request_number, intakeId);
  } catch (error) {
    throw fail('store_write_failed', FILING_TEXT.intake_book, `the intake book could not record the entry ${intakeId} (${kindOf(error)}), and the portal holds the entry`);
  }
  // The signal is read after the commitment too. The entry exists and is booked, so the job goes on and gives the record, which a caller that hung up does not read.
  if (input.signal?.aborted === true) {
    try {
      deps.log(`insurer intake: the caller hung up while the request was filed: the entry ${intakeId} exists and is booked`);
    } catch {
      // A log that fails changes nothing.
    }
  }
  return intakeId;
}
