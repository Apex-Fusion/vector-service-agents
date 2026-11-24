// packages/usecase-kit/src/priorauth/intake.ts
// The intake record of use case 2 (prior authorization). The Insurer Intake Agent returns it when it has filed a request, and the Prior Authorization Agent reads it. Its members, in this order:
//   schema, outcome ("done"), request_number, request_sha256 (the canonical SHA-256 of the request that the agent received), status ("complete" or "incomplete"), missing (the ids of the requirements that
//   the request does not meet), intake_id (the id that the insurer portal gave), sender { did, organisation, organisation_verified }, approval { attestation, issuer_did, valid_until },
//   attestations { provenance, software, principal_binding }, checks, decisions, fault_mode
//
// `checks` has one member for each name of INTAKE_CHECKS, and each value is true: the 12 shared checks of an insurer intake agent, in the order that they run, and then the three checks of the Insurer Intake
// Agent. A record exists only for a job whose checks all passed, so a check that is false, a check that is missing and a check that is not listed are refused. The list is written out in this file, because
// the folder imports no other folder of the kit. A test holds its first 12 names to the shared checks of the checks folder.
//
// `status` and `missing` go together. `complete` has no missing requirement. `incomplete` has 1 to 20 ids, each an identifier of the insurer portal and none twice. The parser does not know the requirement set
// of the insurer, so it does not check that an id names one of its requirements.
//
// `attestations` is what the agent found about the sender. The agent reports it and never refuses a job for it. Each member is one of four words. The fourth word, `unreadable`, means that a source could not
// be read: it is not a pass, and it is not the refusal of a rule.
//
// The agent has no fault value, so `fault_mode` is the empty text. `decisions` holds exactly one decision, and its name is `completeness`: the model decision of the agent. The agent makes it in every job, so a
// list with no decision, with two decisions, or with a decision of another name is refused. The sender, the approval, the checks and the decisions are read by the parsers of `parts.ts`, which are copies of
// the parsers that the order confirmation of use case 1 uses. A member is read one time as data. An accessor, the key `__proto__` and a member that is not listed are refused. The detail of a refusal names
// the field and never repeats the value.
import { accepted, checkMembers, parseDigest, parseDocument, refused } from '../protocol/index.ts';
import type { Decision, Digest, JsonValue, ProtocolResult } from '../protocol/index.ts';
import { objectOf, parseId, parseIds } from './ids.ts';
import { parseApproval, parseChecks, parseDecisions, parseSender } from './parts.ts';
import type { Approval, Sender } from './parts.ts';

export const INTAKE_RECORD_SCHEMA = 'vector.usecase.intake-record.v1';

/** The two statuses of an intake record: the request meets every requirement of the insurer, or it does not. */
export const INTAKE_STATUSES = ['complete', 'incomplete'] as const;

/** What the agent found about one attestation of the sender. `unreadable` means that a source could not be read: it is never a pass and never the refusal of a rule. */
export const ATTESTATION_STATES = ['valid', 'invalid', 'absent', 'unreadable'] as const;

/**
 * The names of `checks`, in the order that the checks run: the 12 shared checks of an insurer intake agent (the sender, the delegation, the payment from a vault and the approval), and then
 * `for_this_insurer`, `advert` and `not_duplicate`.
 */
export const INTAKE_CHECKS = [
  'sender_active', 'sender_accountable', 'sender_key', 'delegation', 'delegation_usable', 'vault_paid', 'approval_found', 'approval_type', 'approval_subject', 'approval_issuer', 'approval_valid',
  'approval_digest', 'for_this_insurer', 'advert', 'not_duplicate',
] as const;

export type IntakeStatus = (typeof INTAKE_STATUSES)[number];
export type AttestationState = (typeof ATTESTATION_STATES)[number];
type IntakeCheck = (typeof INTAKE_CHECKS)[number];

export interface IntakeRecord {
  readonly schema: typeof INTAKE_RECORD_SCHEMA;
  readonly outcome: 'done';
  /** The number of the request that the agent filed. */
  readonly request_number: string;
  /** The canonical SHA-256 of the request that the agent received. A reader computes the hash of the request that it sent, and compares the two. */
  readonly request_sha256: Digest;
  readonly status: IntakeStatus;
  /** The ids of the requirements that the request does not meet: none for `complete`, and 1 to 20 for `incomplete`. */
  readonly missing: readonly string[];
  /** The id that the insurer portal gave to the filed request. */
  readonly intake_id: string;
  readonly sender: Sender;
  readonly approval: Approval;
  readonly attestations: {
    readonly provenance: AttestationState;
    readonly software: AttestationState;
    readonly principal_binding: AttestationState;
  };
  readonly checks: { readonly [name in IntakeCheck]: true };
  readonly decisions: readonly Decision[];
  readonly fault_mode: '';
}

const MEMBERS = [
  'schema', 'outcome', 'request_number', 'request_sha256', 'status', 'missing', 'intake_id', 'sender', 'approval', 'attestations', 'checks', 'decisions', 'fault_mode',
] as const;
const ATTESTATION_KINDS = ['provenance', 'software', 'principal_binding'] as const;
/** The most requirements that a record lists as missing. The insurer portal takes the same number. */
const MAX_MISSING = 20;
/** The name of the one decision of the Insurer Intake Agent: the model decides whether the request meets the requirements of the insurer. */
const COMPLETENESS = 'completeness';
const STATE_WORDS = ATTESTATION_STATES.join(', ');

function isStatus(value: unknown): value is IntakeStatus {
  return typeof value === 'string' && (INTAKE_STATUSES as readonly string[]).includes(value);
}

function isAttestationState(value: unknown): value is AttestationState {
  return typeof value === 'string' && (ATTESTATION_STATES as readonly string[]).includes(value);
}

/** The attestations of the sender: the three kinds, each with one of the four states. */
function parseAttestations(value: JsonValue, field: string): ProtocolResult<IntakeRecord['attestations']> {
  const attestations = objectOf(value, field);
  if (!attestations.ok) return attestations;
  const members = checkMembers(attestations.value, field, ATTESTATION_KINDS);
  if (members !== null) return members;
  const { provenance, software, principal_binding: binding } = attestations.value;
  if (!isAttestationState(provenance)) return refused('bad_shape', `${field}.provenance must be one of ${STATE_WORDS}`);
  if (!isAttestationState(software)) return refused('bad_shape', `${field}.software must be one of ${STATE_WORDS}`);
  if (!isAttestationState(binding)) return refused('bad_shape', `${field}.principal_binding must be one of ${STATE_WORDS}`);
  return accepted({ provenance, software, principal_binding: binding });
}

/**
 * An intake record with exactly the members above, as a new plain object, or a refusal with the code `bad_shape`. `outcome` is `done` and nothing else: the Insurer Intake Agent answers a refusal or a
 * failure with an error and not with a record. The Prior Authorization Agent compares the request number and the request hash with those of the request that it sent.
 */
export function parseIntakeRecord(value: unknown): ProtocolResult<IntakeRecord> {
  const field = 'intake record';
  const whole = parseDocument(value, field);
  if (!whole.ok) return whole;
  const members = checkMembers(whole.value, field, MEMBERS);
  if (members !== null) return members;
  const record = whole.value;
  if (record.schema !== INTAKE_RECORD_SCHEMA) return refused('bad_shape', `${field}.schema must be "${INTAKE_RECORD_SCHEMA}"`);
  if (record.outcome !== 'done') return refused('bad_shape', `${field}.outcome must be "done"`);
  const requestNumber = parseId(record.request_number, `${field}.request_number`);
  if (!requestNumber.ok) return requestNumber;
  const requestSha = parseDigest(record.request_sha256, `${field}.request_sha256`);
  if (!requestSha.ok) return requestSha;
  const status = record.status;
  if (!isStatus(status)) return refused('bad_shape', `${field}.status must be "complete" or "incomplete"`);
  const missing = parseIds(record.missing, `${field}.missing`, 0, MAX_MISSING);
  if (!missing.ok) return missing;
  if ((status === 'complete') !== (missing.value.length === 0)) {
    return refused('bad_shape', `${field}.status must be "complete" when ${field}.missing is empty, and "incomplete" when it lists a requirement`);
  }
  const intakeId = parseId(record.intake_id, `${field}.intake_id`);
  if (!intakeId.ok) return intakeId;
  const sender = parseSender(record.sender, `${field}.sender`);
  if (!sender.ok) return sender;
  const approval = parseApproval(record.approval, `${field}.approval`);
  if (!approval.ok) return approval;
  const attestations = parseAttestations(record.attestations, `${field}.attestations`);
  if (!attestations.ok) return attestations;
  const checks = parseChecks(record.checks, `${field}.checks`, INTAKE_CHECKS);
  if (!checks.ok) return checks;
  const decisions = parseDecisions(record.decisions, `${field}.decisions`, COMPLETENESS);
  if (!decisions.ok) return decisions;
  if (record.fault_mode !== '') return refused('bad_shape', `${field}.fault_mode must be the empty text: the Insurer Intake Agent has no fault value`);
  const intake: IntakeRecord = {
    schema: INTAKE_RECORD_SCHEMA,
    outcome: 'done',
    request_number: requestNumber.value,
    request_sha256: requestSha.value,
    status,
    missing: missing.value,
    intake_id: intakeId.value,
    sender: sender.value,
    approval: approval.value,
    attestations: attestations.value,
    checks: checks.value,
    decisions: decisions.value,
    fault_mode: '',
  };
  return accepted(intake);
}
