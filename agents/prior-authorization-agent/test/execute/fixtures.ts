// agents/prior-authorization-agent/test/execute/fixtures.ts
// The documents that the tests of the job `execute` share: the authorization request, the intake record that the Insurer Intake Agent signs, the decision of the model, the delivery of a hire, and the
// answers of a challenge. Every record is synthetic, and no value is a key. A document is a plain object that a test changes with `over`, so that a test names what it changes.
import { readFileSync } from 'node:fs';
import { AGENT_ADVERT_REF, AGENT_ID } from '@vsa/hire-kit/testing';
import { INTAKE_CHECKS, parseIntakeRecord, parsePriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import type { IntakeRecord, PriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import { RECEIPT_CHECKS, canonicalSha256, makeProposal, parseRequest } from '@vsa/usecase-kit/protocol';
import type { ChallengeRecord, Decision, ExecuteRequest, JsonObject, SubJob } from '@vsa/usecase-kit/protocol';
import type { VerifiedDelivery } from '@vsa/usecase-kit/buyer';
import type { ChallengeFiled, ChallengeNotFiled } from '@vsa/usecase-kit/dispute';
import type { AcceptAnswer, MismatchName, RequestSide } from '../../src/execute/ports.ts';

export const INSURER_DID = `did:vector:${AGENT_ID}`;
export const PRINCIPAL_DID = `did:vector:${'b2'.repeat(32)}`;
/** The agent of the unit tests of the decision. A test with a world uses the DID of the agent of that world. */
export const AGENT_DID = `did:vector:${'a1'.repeat(32)}`;
export const SALT = '33'.repeat(32);
export const TENANT = 'run1';
export const APPROVAL = { attestation: '22'.repeat(32), issuer_did: PRINCIPAL_DID } as const;
export { AGENT_ADVERT_REF };

/** The text of a golden file of this folder. */
export const goldenText = (name: string): string => readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8');
/** The value of a golden JSON file of this folder. */
export const golden = (name: string): unknown => JSON.parse(goldenText(name));

/** The authorization request of the tests. It names the advert of the template supplier of the stub marketplace, which plays the Insurer Intake Agent. */
export function requestDocument(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'vector.usecase.priorauth-request.v1', request_number: 'run1-1', tenant: TENANT, order_id: 'ORD-1001', patient_ref: 'SYN-PT-0001', ordering_clinician_ref: 'SYN-CLN-0001', service_code: 'SYN-MRI-LS',
    diagnosis_codes: ['M54.16'],
    justification: 'The synthetic patient has had low back pain with leg pain for seven weeks. Physical therapy and naproxen gave little relief. A new weakness of the left ankle is recorded.',
    guideline_refs: ['C1', 'C2'], record_refs: ['REC-0002', 'REC-0004', 'REC-0005'], record_set_sha256: '55'.repeat(32), insurer_did: INSURER_DID, advert_ref: AGENT_ADVERT_REF, ...over,
  };
}

/** The request as the typed value that the job reads. */
export function typedRequest(document: Record<string, unknown> = requestDocument()): PriorAuthRequest {
  const parsed = parsePriorAuthRequest(document);
  if (!parsed.ok) throw new Error(`the request of the test is refused: ${parsed.detail}`);
  return parsed.value;
}

/** The hash that the Insurer Intake Agent writes into its record: the canonical hash of the document that it received, with no salt. */
export function requestHash(document: unknown = requestDocument()): string {
  const hash = canonicalSha256(document);
  if (!hash.ok) throw new Error(`the request of the test has no hash: ${hash.detail}`);
  return hash.value;
}

/** The two values that one side of the comparison holds, for a request document. */
export const sideOf = (document: Record<string, unknown> = requestDocument()): RequestSide => ({ request_number: String(document.request_number), request_sha256: requestHash(document) });

/** The sub-job of a model hire, as a decision records it. */
const SUB_JOB: SubJob = {
  capability_id: 'llm.text.generate.v1', advert_ref: `${'b3'.repeat(32)}#0`, escrow_ref: `${'4c'.repeat(32)}#0`, supplier_pkh: '7d'.repeat(28),
  receipt: {
    escrow_ref: `${'4c'.repeat(32)}#0`, supplier_pkh: '7d'.repeat(28), prompt_hash: '33'.repeat(32), response_hash: '44'.repeat(32), model: 'deepseek/deepseek-v4-flash', prompt_tokens: 412, completion_tokens: 58, wallclock_ms: 2140,
  },
  receipt_signature: '8e'.repeat(64),
  verification: Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true])) as SubJob['verification'],
};

/** A decision of the model, as the protocol records it. */
export function decisionOf(name: string, choice: JsonObject, reasoning = 'The two values were compared one by one.'): Decision {
  return { name, choice, reasoning, inference: { path: 'marketplace', sub_job: SUB_JOB, accepted: 'confirmed' } };
}

/** The decision `accept_delivery` with the given choice. */
export const acceptDecision = (accept: boolean, mismatch: readonly MismatchName[] = []): Decision => decisionOf('accept_delivery', { accept, mismatch: [...mismatch] });

/** The decision `completeness` of the Insurer Intake Agent, which every intake record holds. */
export const completenessDecision = (complete: boolean, missing: readonly string[] = []): Decision =>
  decisionOf('completeness', { complete, missing: [...missing] }, 'The request meets the requirements of the insurer.');

/**
 * The intake record that the Insurer Intake Agent returns for a request document: it names the same request number and the canonical hash of that document, it is complete, and it holds the 15 checks true.
 * `over` replaces members. The sender is the agent of the unit tests unless `over` names another.
 */
export function intakeRecordOf(document: Record<string, unknown> = requestDocument(), over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'vector.usecase.intake-record.v1', outcome: 'done', request_number: document.request_number, request_sha256: requestHash(document), status: 'complete', missing: [], intake_id: 'INT-run1-0001',
    sender: { did: AGENT_DID, organisation: 'org.example', organisation_verified: true },
    approval: { attestation: APPROVAL.attestation, issuer_did: PRINCIPAL_DID, valid_until: '2026-11-24T10:00:00.000Z' },
    attestations: { provenance: 'valid', software: 'valid', principal_binding: 'absent' },
    checks: Object.fromEntries(INTAKE_CHECKS.map((name) => [name, true])),
    decisions: [completenessDecision(true)], fault_mode: '', ...over,
  };
}

/** The record as the typed value that the job reads: the copy that the parser of the kit makes. A test gives a record that the kit accepts. */
export function typedRecord(value: Record<string, unknown> = intakeRecordOf()): IntakeRecord {
  const parsed = parseIntakeRecord(value);
  if (!parsed.ok) throw new Error(`the intake record of the test is refused: ${parsed.detail}`);
  return parsed.value;
}

/** A delivery that passed the eight checks, as the decision of a use case gets it. `value` is the answer of the Insurer Intake Agent. */
export function deliveryOf(value: unknown = intakeRecordOf()): VerifiedDelivery {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let result: JsonObject | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    result = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
  } catch {
    result = null;
  }
  return {
    escrow_ref: `${'ab'.repeat(32)}#0`, advert_ref: AGENT_ADVERT_REF, text, result,
    receipt: { escrow_ref: `${'ab'.repeat(32)}#0`, supplier_pkh: '5a'.repeat(28), response_hash: '66'.repeat(32), agent_did: INSURER_DID }, receipt_signature: '9c'.repeat(64),
    verification: Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true])) as VerifiedDelivery['verification'],
  };
}

/** The `execute` request for a request document, as the protocol parser gives it. The tenant of the request is the tenant of the tests unless another is given. */
export function executeRequest(document: unknown, delegation: string, approval: unknown = APPROVAL, tenant: string = TENANT): ExecuteRequest {
  const proposal = makeProposal(document, SALT);
  if (!proposal.ok) throw new Error(`the proposal of the test is refused: ${proposal.detail}`);
  const parsed = parseRequest({ op: 'execute', authority: { principal_did: PRINCIPAL_DID, delegation }, tenant, proposal: proposal.value, approval });
  if (!parsed.ok) throw new Error(`the request of the test is refused: ${parsed.detail}`);
  if (parsed.value.op !== 'execute') throw new Error('the request of the test is not an execute request');
  return parsed.value;
}

/** The record of a challenge that was filed. */
export const CHALLENGE: ChallengeRecord = { claim: `${'c1'.repeat(32)}#0`, evidence: 'e1'.repeat(32), challenge: `${'c2'.repeat(32)}#0` };

/** The answer of the dispute folder for a challenge that was filed. */
export function challengeFiled(record: ChallengeRecord = CHALLENGE): { ok: true; value: ChallengeFiled } {
  return {
    ok: true,
    value: {
      record, claim_token: `636c6d5f${'11'.repeat(28)}`, against_did: INSURER_DID, evidence_uri: 'ipfs://evidence', evidence_hash: 'd4'.repeat(32), challenge_tx: record.challenge.split('#')[0]!,
      challenge_token: `636c6d5f${'22'.repeat(28)}`, stake_lovelace: 50_000_000n, deadline: 1_790_000_000_000, fee_lovelace: 1_000_000n, extra_evidence: null,
    },
  };
}

/** The answer of the dispute folder for a challenge that was not filed. `landed` names a transaction that landed before the step failed. */
export function challengeNotFiled(code: ChallengeNotFiled['code'], landed: Partial<Pick<ChallengeNotFiled, 'evidence' | 'sent' | 'challenge' | 'wrong_document'>> = {}): ChallengeNotFiled {
  return { ok: false, code, detail: 'the detail of the dispute folder', evidence: null, sent: null, challenge: null, wrong_document: null, ...landed };
}

/**
 * The model as a function. By default it compares the two hashes as a model that reads them right: it accepts when they are equal, and it names `request_sha256` when they differ. `calls` holds the exact
 * arguments of each question.
 */
export class ScriptedAccept {
  readonly calls: Array<{ sent: RequestSide; received: RequestSide }> = [];
  answer: (sent: RequestSide, received: RequestSide) => unknown = (sent, received) => {
    const mismatch: MismatchName[] = sent.request_sha256 === received.request_sha256 ? [] : ['request_sha256'];
    return { ok: true, decision: acceptDecision(mismatch.length === 0, mismatch), choice: { accept: mismatch.length === 0, mismatch } };
  };

  readonly acceptDelivery = async (sent: RequestSide, received: RequestSide): Promise<AcceptAnswer> => {
    this.calls.push({ sent, received });
    // A test gives the answer of a port, and it may give an answer that breaks the type, to see what the job does with it.
    return (await this.answer(sent, received)) as AcceptAnswer;
  };
}
