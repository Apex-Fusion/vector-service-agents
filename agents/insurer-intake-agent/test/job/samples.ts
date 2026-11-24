// agents/insurer-intake-agent/test/job/samples.ts
// The values that the tests of the job share and that need no gateway and no portal: the DIDs and references, an authorization request and the handoff that carries it, the requirement sets of the
// insurer portal, the record of the checks that passed, and the decision `completeness` as the kit gives it. Every value has the form that the protocol names. Every record is synthetic, and no value is a key.
import type { MockBases } from '@vsa/usecase-kit/access';
import type { ChecksRecord } from '@vsa/usecase-kit/checks';
import type { DecisionFailure } from '@vsa/usecase-kit/decision';
import { INTAKE_CHECKS, PRIORAUTH_REQUEST_SCHEMA } from '@vsa/usecase-kit/priorauth';
import { HANDOFF_SCHEMA, canonicalSha256, parseHandoff } from '@vsa/usecase-kit/protocol';
import type { Decision, Digest, Document, Handoff, JsonValue, SubJob } from '@vsa/usecase-kit/protocol';
import type { AttestationReport, CompletenessChoice, TakenChecks } from '../../src/job/ports.ts';

/** The two origins of the mock service, for a test with no server. */
export const BASES: MockBases = { publicBase: 'https://mock.example', mtlsBase: 'https://mock-mtls.example' };
/** The insurer that the request names. The job does not compare it with its own DID: check 13 of the hook does. */
export const INSURER_DID = `did:vector:${'a1'.repeat(32)}`;
export const SENDER_DID = `did:vector:${'ec'.repeat(32)}`;
export const ISSUER_DID = `did:vector:${'1f'.repeat(32)}`;
export const ADVERT_REF = `${'d4'.repeat(32)}#1`;
export const ESCROW_REF = `${'e7'.repeat(32)}#0`;
export const DELEGATION_ID = '5e'.repeat(32);
export const ATTESTATION_ID = '9b'.repeat(32);
export const SALT = '9a'.repeat(32);
export const BUYER_PKH = '0b'.repeat(28);
/** The end of the approval as the checks record it, in milliseconds since 1970, and as the intake record writes it. */
export const VALID_UNTIL_MS = Date.UTC(2026, 10, 24, 10, 0, 0);
export const VALID_UNTIL = '2026-11-24T10:00:00.000Z';
/** The canonical SHA-256 of `PRIOR_REQUEST`, worked out with a few lines of Node that do not use the kit. */
export const PRIOR_REQUEST_SHA256 = '3f113522e166ddab2da7d8093f69622cf10ce6164fb69f9973256db85820cc1d';

/** An authorization request that passes the checks of the hook for the escrow of the samples: this insurer, and the advert of the context. */
export const PRIOR_REQUEST: Document = {
  schema: PRIORAUTH_REQUEST_SCHEMA, request_number: 'run1-1', tenant: 'run1', order_id: 'ORD-1001', patient_ref: 'SYN-PT-0001', ordering_clinician_ref: 'SYN-CL-0007', service_code: 'SYN-MRI-LS',
  diagnosis_codes: ['M54.16', 'M51.16'],
  justification:
    'Criterion C1 is met: the note REC-0002 records low back pain with pain in the left leg for 7 weeks. Criterion C2 is met: the records REC-0003 and REC-0004 show 4 weeks of medication and 3 weeks of physical therapy. This text is synthetic.',
  guideline_refs: ['C1', 'C2'], record_refs: ['REC-0002', 'REC-0003', 'REC-0004'], record_set_sha256: 'ab'.repeat(32), insurer_did: INSURER_DID, advert_ref: ADVERT_REF,
};

/** The authorization request of the samples with members replaced. */
export const priorRequest = (over: Readonly<Record<string, JsonValue>> = {}): Document => ({ ...PRIOR_REQUEST, ...over });

/** The requirement sets of the insurer portal by service code. They are stand-in data written by hand, in the form that the portal gives them. */
export const REQUIREMENTS: Readonly<Record<string, Document>> = {
  'SYN-MRI-LS': {
    service_code: 'SYN-MRI-LS', title: 'Intake requirements for imaging of the lumbar spine',
    requirements: [
      { id: 'R1', text: 'The request names the ordering clinician.' },
      { id: 'R2', text: 'The request has at least one diagnosis code.' },
      { id: 'R3', text: 'The request has a justification that cites the criteria of the guideline.' },
      { id: 'R4', text: 'The request lists the records that support each criterion.' },
      { id: 'R5', text: 'The request states the hash of the set of records that the writer read.' },
    ],
  },
  'SYN-MRI-KN': {
    service_code: 'SYN-MRI-KN', title: 'Intake requirements for imaging of the knee',
    requirements: [
      { id: 'R1', text: 'The request names the ordering clinician.' },
      { id: 'R2', text: 'The request has at least one diagnosis code.' },
      { id: 'R3', text: 'The request has a justification that cites the criteria of the guideline.' },
    ],
  },
};

/** The hash of any JSON value as the kit makes it. */
export function hashOf(value: unknown): Digest {
  const hash = canonicalSha256(value);
  if (!hash.ok) throw new Error(hash.detail);
  return hash.value;
}

/** The handoff that the sender sends, as the server parses it from its JSON text: `over` replaces members of the wire message. */
export function handoffOf(document: Document = PRIOR_REQUEST, over: Readonly<Record<string, JsonValue>> = {}): Handoff {
  const wire = {
    schema: HANDOFF_SCHEMA, use_case: 'prior-authorization', sender_did: SENDER_DID, delegation: DELEGATION_ID, document, salt: SALT, approval: { attestation: ATTESTATION_ID, issuer_did: ISSUER_DID }, ...over,
  };
  const parsed = parseHandoff(JSON.parse(JSON.stringify(wire)));
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.value;
}

// --- the record of the checks that passed ----------------------------------------------------------------------------------------------------------

/** What the checks of the hook learn: the organisation of the sender, and the approval. */
export const FACTS: Readonly<Record<string, JsonValue>> = {
  organisation: 'buyer.example', organisation_verified: true, approval_attestation: ATTESTATION_ID, approval_issuer_did: ISSUER_DID, approval_issuer_key_hash: '3c'.repeat(28),
  approval_valid_until: VALID_UNTIL_MS,
};

/** The 15 checks, each true, in the order that they run. */
export const CHECKS: Readonly<Record<string, true>> = Object.fromEntries(INTAKE_CHECKS.map((name) => [name, true as const]));

/** The record that the hook keeps for `request`: the 15 checks, the facts, and the hash of the request. `over` replaces a member. */
export function recordFor(
  request: Handoff,
  over: { checks?: Readonly<Record<string, true>>; facts?: Readonly<Record<string, JsonValue>>; request_sha256?: string } = {},
): TakenChecks {
  const record: ChecksRecord = { checks: over.checks ?? CHECKS, facts: over.facts ?? FACTS };
  return { record, request_sha256: over.request_sha256 ?? hashOf(request) };
}

// --- the decision and the report -------------------------------------------------------------------------------------------------------------------

const SUB_JOB: SubJob = {
  capability_id: 'llm.text.generate.v1',
  advert_ref: `${'b3'.repeat(32)}#0`,
  escrow_ref: `${'4c'.repeat(32)}#0`,
  supplier_pkh: '7d'.repeat(28),
  receipt: {
    escrow_ref: `${'4c'.repeat(32)}#0`, supplier_pkh: '7d'.repeat(28), prompt_hash: '33'.repeat(32), response_hash: '44'.repeat(32), model: 'deepseek/deepseek-v4-flash', prompt_tokens: 412,
    completion_tokens: 58, wallclock_ms: 2140,
  },
  receipt_signature: '8e'.repeat(64),
  verification: {
    escrow_ref_matches: true, response_hash_matches: true, supplier_key_matches: true, signature_valid: true, on_chain_hash_matches: true, prompt_hash_matches: true, model_matches: true,
    fields_match: true,
  },
};

/** The decision `completeness` as a decision of the kit gives it, for a model that finds the request complete. `over` replaces members of the choice. */
export function decisionOf(over: Partial<CompletenessChoice> = {}): Decision<CompletenessChoice> {
  return {
    name: 'completeness',
    choice: { complete: true, missing: [], ...over },
    reasoning: 'The request names the clinician, lists two diagnosis codes, cites the criteria and the records, and states the hash of the record set, so it meets all five requirements.',
    inference: { path: 'marketplace', sub_job: SUB_JOB, accepted: 'confirmed' },
  };
}

/** A failed decision, as `decide` of the kit gives it. */
export function failureOf(code: DecisionFailure['code'], over: Partial<DecisionFailure> = {}): DecisionFailure {
  return { ok: false, code, reason: 'llm_timeout', detail: 'the model hire for the decision completeness ended with llm_timeout at poll', delivery: null, escrow_ref: null, stage: 'poll', ...over };
}

/** What the report of the attestations of the sender gives when all three are valid. */
export const ATTESTATIONS: AttestationReport = { provenance: 'valid', software: 'valid', principal_binding: 'valid' };
