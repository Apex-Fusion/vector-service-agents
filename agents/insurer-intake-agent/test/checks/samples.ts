// agents/insurer-intake-agent/test/checks/samples.ts
// The values that the tests of the hook share and that need no ledger: the DID of the Insurer Intake Agent, an authorization request and the handoff that carries it, and the job context of the runtime. Every
// value has the form that the protocol names. Every record is synthetic, and no value is a key.
import type { JobContext } from '@vsa/service-kit';
import { PRIORAUTH_MODELS, PRIORAUTH_REQUEST_SCHEMA } from '@vsa/usecase-kit/priorauth';
import { HANDOFF_SCHEMA } from '@vsa/usecase-kit/protocol';
import type { Document, Handoff, JsonValue } from '@vsa/usecase-kit/protocol';

/** The DID of the Insurer Intake Agent: the insurer that an authorization request must name. */
export const SELF = `did:vector:${'a1'.repeat(32)}`;
export const OTHER_DID = `did:vector:${'f2'.repeat(32)}`;
/** The advert that the escrow of the samples was posted on, and another advert. */
export const ADVERT_REF = `${'d4'.repeat(32)}#1`;
export const OTHER_ADVERT_REF = `${'d5'.repeat(32)}#1`;
export const ESCROW_REF = `${'e7'.repeat(32)}#0`;
export const BUYER_PKH = '0b'.repeat(28);

/** An authorization request that passes the three checks of the Insurer Intake Agent for the context below: this insurer, and the advert of the context. */
export const PRIOR_REQUEST: Document = {
  schema: PRIORAUTH_REQUEST_SCHEMA, request_number: 'run1-1', tenant: 'run1', order_id: 'ORD-1001', patient_ref: 'SYN-PT-0001', ordering_clinician_ref: 'SYN-CL-0007', service_code: 'SYN-MRI-LS',
  diagnosis_codes: ['M54.16'], justification: 'Criterion C1 is met. The progress note REC-0002 records low back pain for 7 weeks. This text is synthetic.', guideline_refs: ['C1'], record_refs: ['REC-0002'],
  record_set_sha256: 'ab'.repeat(32), insurer_did: SELF, advert_ref: ADVERT_REF,
};

/** The authorization request of the samples with members replaced. */
export const priorRequest = (over: Readonly<Record<string, JsonValue>> = {}): Document => ({ ...PRIOR_REQUEST, ...over });

/** The handoff that carries `document`. The checks of the Insurer Intake Agent read the document and nothing else of it. */
export const handoffOf = (document: Document = PRIOR_REQUEST, over: Partial<Handoff> = {}): Handoff => ({
  schema: HANDOFF_SCHEMA, use_case: 'prior-authorization', sender_did: OTHER_DID, delegation: '5e'.repeat(32), document, salt: '9a'.repeat(32), approval: null, ...over,
});

/** What the runtime says about the escrow: the advert that it was posted on, and the model of that advert. */
export const CONTEXT: JobContext = {
  escrowRef: ESCROW_REF, advertRef: ADVERT_REF, advertModel: PRIORAUTH_MODELS.intake, buyerPkh: BUYER_PKH, paymentLovelace: 2_000_000n, deliverByMs: Date.UTC(2026, 11, 5, 12, 0, 0),
};
