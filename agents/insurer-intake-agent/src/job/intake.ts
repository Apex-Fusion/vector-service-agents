// agents/insurer-intake-agent/src/job/intake.ts
// The job of the Insurer Intake Agent (use case 2, prior authorization): what it does after the Claim of an escrow. `runIntake` takes the record of the checks that the hook made, gets a JWT-SVID for the
// service key, reads the requirement set of the insurer for the service of the request, reports the attestations of the sender, takes the model decision `completeness`, files the request in the insurer
// portal, writes the intake book, and gives the intake record. It makes an intake decision and no coverage decision: a request that is not complete is filed with the status `incomplete`, and it is answered.
//
// The steps, in order. A failure ends the job with an `IntakeRefusal`, and nothing is written after it.
//   1. and 2.  The record of the checks, the request, the sender, the approval and the 15 checks (take.ts). A body that the hook did not check is `precheck_missing`, and no later port is called.
//   3.         The JWT-SVID of the service key for the insurer system of the tenant (svid.ts).
//   4.         The requirement set of the insurer for the service code of the request (requirements.ts).
//   5.         The report of the attestations of the sender (attest.ts). It never refuses the job and never reaches the prompt.
//   6.         The decision `completeness`, one hire of a model (completeness.ts). A failed decision ends the job with its own code. The typed choice is checked again against the requirement ids, and the
//              status and the missing ids of the record are made from that checked copy: `complete: true` is `complete` with no missing id, and `complete: false` is `incomplete` with the ids.
//   7. and 8.  The filing and the intake book (filing.ts). A JWT-SVID lasts at most five minutes, and the report and the decision come before the filing, so the job asks for a new JWT-SVID when the one that it
//              has would end less than one call before the filing could end. The kit refuses a call with a JWT-SVID that has ended, and that refusal after a paid decision would file nothing.
//   9.         The intake record, checked by the parser of the kit before it goes out.
//
// A job files at most one entry, and it files nothing unless the model decided. The signal is read before the decision and before the filing, and it is never passed into a hire or a call: both are
// commitments that cannot be taken back. A line of the log has the escrow and the time of the job at its end, and it has codes, statuses and references: never a key, a token, a body of the portal or a part
// of the request.
//
// The time of the job, step by step. The first call to the gateway and the read of the requirements are bound by the client of the gateway and by `calls.timeoutMs`. The report gets at most 45,000 ms and leaves
// 150,000 ms for the decision and the filing. The decision is bound by the deadline of the service (the kit starts no hire with less than 60,000 ms left). The filing is bound by `calls.timeoutMs`, and it
// starts only when it can end 30,000 ms before `deliver_by`.
import type { JobContext } from '@vsa/service-kit';
import { DEFAULT_CALL_TIMEOUT_MS } from '@vsa/usecase-kit/access';
import { DECISION_FAILURE_CODES } from '@vsa/usecase-kit/decision';
import type { DecisionFailure, DecisionFailureCode, TypedDecision } from '@vsa/usecase-kit/decision';
import { INTAKE_RECORD_SCHEMA, parseIntakeRecord } from '@vsa/usecase-kit/priorauth';
import type { IntakeRecord, IntakeStatus } from '@vsa/usecase-kit/priorauth';
import type { Handoff } from '@vsa/usecase-kit/protocol';
import { attestStep } from './attest.ts';
import { completenessDecision, completenessInput } from './completeness.ts';
import { FILING_TEXT, RUNTIME_MARGIN_MS, fileRequest } from './filing.ts';
import type { AttestationReport, CompletenessChoice, IntakeDeps } from './ports.ts';
import { INTAKE_REFUSAL_TEXT, refuse } from './refusal.ts';
import type { IntakeRefusal, IntakeRefusalCode } from './refusal.ts';
import { readRequirements } from './requirements.ts';
import { fetchSvid } from './svid.ts';
import { takeJob } from './take.ts';
import type { TakenJob } from './take.ts';

/** The texts of the codes of a failed decision. Each is fixed: no value of a request, a record or a portal stands in it. */
const DECISION_TEXT = {
  inference_failed: 'The model hire for the decision completeness failed.',
  model_output_invalid: 'The answer of the model for the decision completeness cannot be used.',
  store_write_failed: 'The record of the model hire could not be written.',
  internal: 'The decision completeness stopped on a fault of the service.',
} as const satisfies Record<DecisionFailureCode, string>;

/** The code of a failed decision: one of the four codes of the kit, and `internal` for anything else, so that a result that cannot be read never has a code that the protocol does not list. */
function decisionCodeOf(failure: DecisionFailure): DecisionFailureCode {
  return (DECISION_FAILURE_CODES as readonly unknown[]).includes(failure?.code) ? failure.code : 'internal';
}

/** What a failed decision says in the log: the code of the hire, its stage and its escrow, and whether the supplier of the model was paid. Never the detail, the prompt or the answer. */
function describeDecision(failure: DecisionFailure): string {
  const paid = failure?.delivery?.accepted;
  const parts = [
    `the decision completeness failed: reason ${String(failure?.reason)}, stage ${String(failure?.stage)}`,
    typeof failure?.escrow_ref === 'string' ? `escrow ${failure.escrow_ref}` : '',
    paid === undefined ? '' : `the model supplier may be paid (accepted ${String(paid)})`,
  ];
  return parts.filter((part) => part !== '').join(', ');
}

/** What the intake record is made of. Each part is checked before it gets here, and the parser of the kit checks the whole. */
interface Parts {
  readonly job: TakenJob;
  readonly status: IntakeStatus;
  readonly missing: readonly string[];
  readonly attestations: AttestationReport;
  readonly decision: TypedDecision<CompletenessChoice>;
}

/** The intake id of the draft of the record. The draft is checked before the request is filed and never leaves the job, so the id of the portal is not known yet. The id has the form that the parser takes. */
const DRAFT_INTAKE_ID = 'intake-id-not-known-yet';

function recordOf(parts: Parts, intakeId: string): IntakeRecord {
  const { job } = parts;
  return {
    schema: INTAKE_RECORD_SCHEMA,
    outcome: 'done',
    request_number: job.document.request_number,
    request_sha256: job.request_sha256,
    status: parts.status,
    missing: [...parts.missing],
    intake_id: intakeId,
    sender: job.sender,
    approval: job.approval,
    attestations: parts.attestations,
    checks: job.checks,
    decisions: [parts.decision],
    fault_mode: '',
  };
}

/**
 * Does the job of an escrow that the Insurer Intake Agent claimed, and gives the intake record, or throws an `IntakeRefusal`. `request` is the handoff that the server parsed, `context` is what the runtime said
 * of the escrow, and `arrivedAt` is the time of the clock of the service when the job arrived. `signal` aborts when the caller hangs up: the job looks at it before the model is hired and before the request is
 * filed, and again after the intake book is written. After that last look the entry exists and is booked, so the job goes on and writes one line to the log. It never passes the signal into a hire or a call.
 * See the head of this file for the steps and the codes.
 */
export async function runIntake(deps: IntakeDeps, request: Handoff, context: JobContext, arrivedAt: number, signal?: AbortSignal): Promise<IntakeRecord> {
  const say = (line: string): void => {
    try {
      deps.log(`${line} (escrow ${context.escrowRef}, ${deps.clock() - arrivedAt} ms)`);
    } catch {
      // A log that fails changes nothing.
    }
  };
  // The steps write their lines through `say`, so each line names the escrow and the time of the job.
  const steps: IntakeDeps = { ...deps, log: say };
  const fail = (code: IntakeRefusalCode, message: string, why: string): IntakeRefusal => refuse(say, code, message, why);

  // 1 and 2. The record of the checks, for this escrow and for this body.
  const job = takeJob(steps, request, context);
  const { document } = job;

  // 3. The JWT-SVID of the service key, for the insurer system of the tenant.
  const first = await fetchSvid(steps, document.tenant);

  // 4. The requirement set of the insurer for the service of the request.
  const requirements = await readRequirements(steps, first, document.tenant, document.service_code);

  // 5. The report of the attestations. It has the time that leaves enough for the decision and the filing before the runtime stops waiting.
  const attestations = await attestStep(steps, { sender: job.sender.did, delegation: job.delegation }, context.deliverByMs - RUNTIME_MARGIN_MS);

  // 6. The decision. The model reads the request and the requirements, and nothing else: the report, the sender and the checks stay out of the input.
  if (signal?.aborted === true) throw fail('deadline', FILING_TEXT.hung_up, 'the caller hung up, so the job stops before the decision');
  const ids = requirements.requirements.map((requirement) => requirement.id);
  const decided = await deps.decide(completenessInput(document, requirements), ids);
  if (decided?.ok !== true) {
    const code = decisionCodeOf(decided);
    throw fail(code, DECISION_TEXT[code], describeDecision(decided));
  }
  const decision = decided.value;
  if (typeof decision !== 'object' || decision === null) throw fail('internal', INTAKE_REFUSAL_TEXT.internal, 'the decision has no value');
  // The typed choice is checked again against the requirement ids of this job, and the status and the missing ids are made from the checked copy. The parser gives back the value that it was given.
  const checked = completenessDecision(ids).parse(decision.choice);
  if (!checked.ok) throw fail('model_output_invalid', DECISION_TEXT.model_output_invalid, 'the choice of the decision is not a choice of the decision completeness');
  const status: IntakeStatus = checked.value.complete ? 'complete' : 'incomplete';
  const parts: Parts = { job, status, missing: [...checked.value.missing], attestations, decision };

  // 7 and 8. The filing and the intake book. The JWT-SVID must outlive the call: the report and the decision came after it was issued. A time that is not known asks for a new JWT-SVID.
  const callMs = deps.calls.timeoutMs === undefined ? DEFAULT_CALL_TIMEOUT_MS : deps.calls.timeoutMs;
  const svid = first.expiresAt - deps.clock() >= callMs ? first : await fetchSvid(steps, document.tenant);
  const intakeId = await fileRequest(steps, { svid, document, status, missing: parts.missing, draft: recordOf(parts, DRAFT_INTAKE_ID), deliverBy: context.deliverByMs, signal });

  // 9. The intake record, checked by the parser of the kit.
  const record = parseIntakeRecord(recordOf(parts, intakeId));
  if (!record.ok) throw fail('internal', INTAKE_REFUSAL_TEXT.internal, `the intake record cannot be made after the entry ${intakeId} was filed and booked`);
  say(`insurer intake: filed the entry ${intakeId} with the status ${status} and ${parts.missing.length} missing`);
  return record.value;
}
