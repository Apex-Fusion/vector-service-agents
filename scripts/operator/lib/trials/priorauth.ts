import { createHash } from 'node:crypto';
import {
  INTAKE_CHECKS, INTAKE_RECORD_SCHEMA, PRIORAUTH_REQUEST_SCHEMA, parseIntakeRecord, parsePriorAuthRequest, parseRecordSet, recordSetSha256, requestNumberOf,
} from '../../../../packages/usecase-kit/src/priorauth/index.ts';
import { canonicalSha256, parseApprovalRef, parseDocument, proposalDigest } from '../../../../packages/usecase-kit/src/protocol/index.ts';
import { SAMPLE_ADVERT_REF, claimFile, evidenceFile, jsonFile, requireBuilt, sampleDecision, trialAgent, trialSubjects } from './shared.ts';
import type { TrialBuilder } from './shared.ts';

export const priorAuthTrial: TrialBuilder = (use, facts) => {
  const priorAuth = trialAgent(use, facts, 'prior-authorization-agent', '6a', '6b');
  const intake = trialAgent(use, facts, 'insurer-intake-agent', '6c', '6d');
  const records = requireBuilt(parseRecordSet({
    order: {
      order_id: 'ORD-1001', patient_ref: 'SYN-PT-0001', service_code: 'SYN-MRI-LS', service_description: 'Magnetic resonance imaging of the lumbar spine, without contrast',
      diagnosis_codes: ['M54.16', 'M51.16'], ordering_clinician_ref: 'SYN-CL-0007', ordered_at: '2026-10-22',
    },
    records: [
      { record_id: 'REC-0001', type: 'imaging', recorded_at: '2026-08-10', summary: 'Plain X-ray of the lumbar spine. Mild narrowing of the disc space at L4-L5. No fracture.' },
      { record_id: 'REC-0005', type: 'progress_note', recorded_at: '2026-10-21', summary: 'Pain in the left leg continues at 7 weeks. New numbness in the left foot. Weakness of ankle dorsiflexion, 4 of 5.' },
    ],
  }), 'sample record set');
  const { order } = records;
  const approved = requireBuilt(parsePriorAuthRequest({
    schema: PRIORAUTH_REQUEST_SCHEMA, request_number: requestNumberOf('trial', 1), tenant: 'trial', order_id: order.order_id, patient_ref: order.patient_ref,
    ordering_clinician_ref: order.ordering_clinician_ref, service_code: order.service_code, diagnosis_codes: order.diagnosis_codes,
    justification: 'The chart records pain and foot numbness. The request is for imaging without contrast.',
    guideline_refs: ['C3', 'C4'], record_refs: records.records.map(({ record_id }) => record_id),
    record_set_sha256: recordSetSha256(records), insurer_did: intake.claim.agent_did, advert_ref: SAMPLE_ADVERT_REF,
  }), 'approved sample request');
  const sent = requireBuilt(parsePriorAuthRequest({
    ...approved, justification: 'The chart records pain and foot numbness. The request is for imaging with contrast.',
  }), 'changed sample request');
  const salt = '1f'.repeat(32);
  const approval = requireBuilt(parseApprovalRef({ attestation: '2e'.repeat(32), issuer_did: `did:vector:${'6e'.repeat(32)}` }), 'sample approval reference');
  const expected = requireBuilt(proposalDigest(salt, approved), 'digest of the approved request');
  const observed = requireBuilt(proposalDigest(salt, sent), 'digest of the sent request');
  const approvalCase = 'approval-digest';
  const approvalEvidence = evidenceFile(approvalCase, priorAuth, intake, {
    kind: 'approval_digest', use_case: 'prior-authorization', approval,
    mismatch: { ok: false, code: 'approval_digest_mismatch', detail: 'The digest of the request does not match the approval.', expected_digest: expected, observed_digest: observed },
  });

  // This record names the right request number but commits to the other version of the request.
  const record = requireBuilt(parseIntakeRecord({
    schema: INTAKE_RECORD_SCHEMA, outcome: 'done', request_number: sent.request_number,
    request_sha256: requireBuilt(canonicalSha256(approved), 'hash of the approved request'), status: 'complete', missing: [], intake_id: 'INTAKE-TRIAL-1',
    sender: { did: priorAuth.claim.agent_did, organisation: null, organisation_verified: false },
    approval: { ...approval, valid_until: '2026-12-31T12:00:00.000Z' }, attestations: { provenance: 'absent', software: 'absent', principal_binding: 'absent' },
    checks: Object.fromEntries(INTAKE_CHECKS.map((name) => [name, true])),
    decisions: [sampleDecision('completeness', { complete: true, missing: [] }, 'The request meets the requirements.')], fault_mode: '',
  }), 'sample intake record');
  const intakeCase = 'intake-record';
  const intakeRecord = jsonFile(`${intakeCase}.record.json`, record);
  const intakeEvidence = evidenceFile(intakeCase, intake, priorAuth, {
    kind: 'intake_record', request: requireBuilt(parseDocument(sent), 'document of the sent request'), intake_record: requireBuilt(parseDocument(record), 'document of the intake record'),
    intake_record_sha256: createHash('sha256').update(intakeRecord.text, 'utf8').digest('hex'),
  });
  return {
    ...trialSubjects(priorAuth, intake),
    cases: [
      {
        name: approvalCase, fields: { kind: 'approval_digest', claimer: priorAuth.id, challenger: intake.id },
        files: [
          claimFile(approvalCase, priorAuth), approvalEvidence,
          jsonFile(`${approvalCase}.record-set.json`, records), jsonFile(`${approvalCase}.approved-request.json`, approved), jsonFile(`${approvalCase}.sent-request.json`, sent),
          jsonFile(`${approvalCase}.approval.json`, { approval, salt, expected_digest: expected, observed_digest: observed }),
        ],
      },
      {
        name: intakeCase, fields: { kind: 'intake_record', claimer: intake.id, challenger: priorAuth.id },
        files: [claimFile(intakeCase, intake), intakeEvidence, jsonFile(`${intakeCase}.sent-request.json`, sent), intakeRecord],
      },
    ],
  };
};
