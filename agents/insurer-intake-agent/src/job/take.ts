// agents/insurer-intake-agent/src/job/take.ts
// Steps 1 and 2 of the job of the Insurer Intake Agent (use case 2, prior authorization): the record of the checks that the hook made, read back. The hook checks a request before the runtime claims the
// escrow, and it keeps one record for each escrow with the hash of the request that it checked. The job runs after the Claim, and it goes on only for the body that the hook checked.
//
//   1. The record of the checks, by the escrow reference of the context (`takeChecks`, which removes it). No record, or a record whose hash is not `canonicalSha256` of this handoff, is `precheck_missing`: the
//      hook did not check this body.
//   2. The authorization request of the handoff, and the sender, the approval and the 15 checks of the intake record from the record. A record that lacks a check of INTAKE_CHECKS, or holds a fact that
//      cannot be read, is `precheck_missing` too. A document that is no authorization request is a fault of the service (`internal`): the service parsed it before the hook.
//
// A failure throws an `IntakeRefusal`, and nothing is written after it. This step calls no port but `takeChecks`, so no call to the gateway, the insurer portal, the model or the intake book comes before the
// record is taken and compared. The record is taken one time: the store removes it, and a second job for the same escrow finds none. Every reason goes to the log as a code, or as the name of a check or a fact
// of the record, and that name is written in this file. The log never holds the detail of a parser, because that detail can name a member of the request, and no value of the record or of the request goes to
// the log or to a text.
import type { JobContext } from '@vsa/service-kit';
import type { ChecksRecord } from '@vsa/usecase-kit/checks';
import { INTAKE_CHECKS, parsePriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import type { IntakeRecord, PriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import { accepted, canonicalSha256, isPlainObject, parseAttestationId, parseDid, refused } from '@vsa/usecase-kit/protocol';
import type { DelegationId, Did, Digest, Handoff, ProtocolResult } from '@vsa/usecase-kit/protocol';
import type { IntakeDeps } from './ports.ts';
import { INTAKE_REFUSAL_TEXT, refuse } from './refusal.ts';

/** What the job takes from the handoff and from the record of the hook, and what the later steps use. */
export interface TakenJob {
  /** The authorization request of the handoff, as the kit parses it. */
  readonly document: PriorAuthRequest;
  /** The `canonicalSha256` of the document as it was received, with no salt: the hash that the intake record names for the request. */
  readonly request_sha256: Digest;
  /** The delegation that paid for the request. The report of the attestations reads its root delegator. */
  readonly delegation: DelegationId;
  readonly sender: IntakeRecord['sender'];
  readonly approval: IntakeRecord['approval'];
  /** The 15 checks of the intake record, each true, in the order that they run. */
  readonly checks: IntakeRecord['checks'];
}

/** The parts of the intake record that come from the record of the hook. */
interface FromRecord {
  readonly sender: IntakeRecord['sender'];
  readonly approval: IntakeRecord['approval'];
  readonly checks: IntakeRecord['checks'];
}

/** The end of the approval as the intake record writes it: null, or the time in UTC with milliseconds that `toISOString` gives for a whole number of milliseconds. */
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
 * The sender, the approval and the checks of the intake record, from the record of the hook. Every name of INTAKE_CHECKS must be in the record with the value `true`, and the facts must have the types that the
 * checks of the hook give them. Anything else is a record that cannot be used, and the reason names the check or the fact and never its value. The sender is the sender of the handoff: the checks verified it.
 */
function readRecord(record: ChecksRecord, sender: Did): ProtocolResult<FromRecord> {
  if (!isPlainObject(record) || !isPlainObject(record.checks) || !isPlainObject(record.facts)) return refused('bad_shape', 'the record holds no checks or no facts');
  const { checks, facts } = record;
  for (const name of INTAKE_CHECKS) {
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
  const confirmed = Object.fromEntries(INTAKE_CHECKS.map((name) => [name, true as const])) as IntakeRecord['checks'];
  return accepted({
    sender: { did: sender, organisation, organisation_verified: verified },
    approval: { attestation: attestation.value, issuer_did: issuer.value, valid_until: end.value },
    checks: confirmed,
  });
}

/**
 * Takes the record of the hook for the escrow of `context`, checks that it is the record of this body, and reads the request, the sender, the approval and the checks from them, or throws an
 * `IntakeRefusal`. `request` is the handoff that the server parsed, and `context` is what the runtime said of the escrow. See the head of this file for the steps and the codes.
 */
export function takeJob(deps: Pick<IntakeDeps, 'takeChecks' | 'log'>, request: Handoff, context: JobContext): TakenJob {
  // 1. The record of the checks, for this escrow and for this body. A value that is no record is no record.
  const taken = deps.takeChecks(context.escrowRef);
  if (typeof taken !== 'object' || taken === null) throw refuse(deps.log, 'precheck_missing', INTAKE_REFUSAL_TEXT.precheck_missing, 'there is no record of passed checks for this escrow');
  const requestHash = canonicalSha256(request);
  const documentHash = canonicalSha256(request.document);
  if (!requestHash.ok || !documentHash.ok || taken.request_sha256 !== requestHash.value) {
    throw refuse(deps.log, 'precheck_missing', INTAKE_REFUSAL_TEXT.precheck_missing, 'the record of passed checks is for another request');
  }

  // 2. The authorization request, and the parts of the intake record that come from the record.
  const parsed = parsePriorAuthRequest(request.document, 'handoff.document');
  if (!parsed.ok) throw refuse(deps.log, 'internal', INTAKE_REFUSAL_TEXT.internal, 'the document of the handoff is not an authorization request');
  const fromRecord = readRecord(taken.record, request.sender_did);
  if (!fromRecord.ok) throw refuse(deps.log, 'precheck_missing', INTAKE_REFUSAL_TEXT.precheck_missing, `the record of passed checks cannot be used: ${fromRecord.detail}`);
  return {
    document: parsed.value,
    request_sha256: documentHash.value,
    delegation: request.delegation,
    sender: fromRecord.value.sender,
    approval: fromRecord.value.approval,
    checks: fromRecord.value.checks,
  };
}
