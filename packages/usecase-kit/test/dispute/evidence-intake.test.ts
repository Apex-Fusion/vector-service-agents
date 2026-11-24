// packages/usecase-kit/test/dispute/evidence-intake.test.ts: the intake record as evidence (use case 2). The insurer intake agent returns an intake record that must name the hash of the request that it
// received. A record that names another hash breaks the statement S2 of its claim, so the evidence is about S2 and the challenge looks for a claim whose S2 has the text of the job. The documents here hold the
// request number and hashes, and no other text of the request. The last block keeps the samples equal to the claim constants of the priorauth folder. Each refusal has an accepted twin.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { documentHash, documentUri } from '@vsa/buyer-core';
import { NO_OPEN_CLAIM, canonicalSha256 } from '@vsa/usecase-kit/protocol';
import { MAX_JUROR_DOCUMENT_BYTES, claimDocument, disputedFields, evidenceDocument, evidenceReferences } from '@vsa/usecase-kit/dispute';
import type { ApprovalChallengeInput, ChallengeResult, ClaimView, DeliveryChallengeInput, EvidenceDocumentInput } from '@vsa/usecase-kit/dispute';
import { INTAKE_CLAIM, PRIORAUTH_CAPABILITIES } from '@vsa/usecase-kit/priorauth';
import {
  APPROVAL_JOB, CHALLENGE_TX, DIGEST_FACTS, ESCROW, ESCROW_2, EVIDENCE_TX, INSURER, INSURER_CLAIM, INSURER_S2, INTAKE_CAPABILITY, INTAKE_FACTS, INTAKE_JOB, INTAKE_PARTIES, INTAKE_RECORD, MANIFEST_SHA, ME, ME_ID,
  OTHER, PRIOR_REQUEST, PRIOR_REQUEST_SHA, REF_A, REF_B, TOKEN_A, TOKEN_B, NOW, HOUR, canonical, challengeView, claimView, escrowJob, insurerClaimView, insurerEscrowJob, rig, senderClaimView,
} from './support.ts';
import type { Rig, RigOptions, ScriptedPort } from './support.ts';

const golden = readFileSync(new URL('./golden/intake-record-evidence.txt', import.meta.url), 'utf8');
const MARKER = 'zq9-marker-value-7f3';

const input = (extra: Record<string, unknown> = {}): EvidenceDocumentInput => ({ ...INTAKE_PARTIES, ...INTAKE_FACTS, ...extra }) as unknown as EvidenceDocumentInput;
/** The input with the members of the intake record changed. */
const recordWith = (extra: Record<string, unknown>): EvidenceDocumentInput => input({ intake_record: { ...INTAKE_RECORD, ...extra } });
const documentOf = (value: EvidenceDocumentInput) => {
  const document = evidenceDocument(value);
  if (!document.ok) throw new Error(`${document.code}: ${document.detail}`);
  return document.value;
};
const textOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

/** The row of the document that says what the intake record names. */
const RECORD_ROW = 5;

describe('the evidence document about an intake record', () => {
  it('has the canonical SHA-256 of the request of the samples, and a record that names another hash, so the golden input agrees with itself', () => {
    expect(canonicalSha256(PRIOR_REQUEST, 'request')).toEqual({ ok: true, value: PRIOR_REQUEST_SHA });
    expect(INTAKE_RECORD.request_sha256).not.toBe(PRIOR_REQUEST_SHA);
    expect(INTAKE_RECORD.request_number).toBe(PRIOR_REQUEST.request_number);
  });

  it('is the golden file, with its pinned hash', () => {
    const document = documentOf(input());
    expect(document.text).toBe(golden);
    expect(document.bytes.toString('utf8')).toBe(document.text);
    expect(document.hash).toBe('45f6992551cc88a762763544979969673c6aebc2699884cd37d58ba1a513159f');
    expect(document.hash).toBe(documentHash(document.bytes));
    expect(document.type).toBe('evidence');
    expect(document.media_type).toBe('text/plain');
    expect(document.bytes.length).toBeLessThanOrEqual(MAX_JUROR_DOCUMENT_BYTES);
  });

  it('is about the statement S2: its header and its statement row name S2 and the text of the statement', () => {
    const rows = documentOf(input()).text.split('\n');
    expect(rows[0]).toBe('Evidence about statement S2 of a claim on the Vector marketplace.');
    expect(rows[1]).toBe(`Statement S2 of the claim reads: "${INSURER_S2}"`);
  });

  it('states the request number and the two hashes in full, and names the hash of the record in its references', () => {
    const text = documentOf(input()).text;
    const references = text.indexOf('\nReferences\n');
    expect(text).toContain('The request has the request number "run1-0001".');
    expect(text).toContain(`The SHA-256 of the request that the challenger sent is ${PRIOR_REQUEST_SHA}.`);
    expect(text).toContain(`The intake record names the SHA-256 ${INTAKE_RECORD.request_sha256} for the request that it received.`);
    expect(text).toContain('The two SHA-256 hashes differ.');
    for (const hash of [PRIOR_REQUEST_SHA, INTAKE_RECORD.request_sha256]) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(text.indexOf(hash)).toBeGreaterThan(-1);
      expect(text.indexOf(hash)).toBeLessThan(references);
    }
    expect(text.slice(references)).toContain(`SHA-256 of the intake record: ${INTAKE_FACTS.intake_record_sha256}`);
  });

  it('gives the same bytes for the same input, whatever the order of the members of the request', () => {
    const first = documentOf(input());
    const second = documentOf(input());
    const reversed = documentOf(input({ request: Object.fromEntries(Object.entries(PRIOR_REQUEST).reverse()) }));
    expect(second.bytes.equals(first.bytes)).toBe(true);
    expect(reversed.bytes.equals(first.bytes)).toBe(true);
  });

  it('reads the references back, and the claimer is the insurer intake agent', () => {
    const document = documentOf(input());
    expect(evidenceReferences(document.bytes)).toEqual({ ok: true, value: { claim: REF_A, claim_token: TOKEN_A, against_did: INSURER, by_did: ME, escrow_ref: ESCROW } });
  });

  describe('the hash of the request is computed here', () => {
    it('is the canonical SHA-256 of the request that the caller gives: another request gives another hash in the document', () => {
      const changed = { ...PRIOR_REQUEST, justification: 'Another synthetic justification.' };
      const text = documentOf(input({ request: changed })).text;
      expect(text).toContain(`The SHA-256 of the request that the challenger sent is ${canonical(changed)}.`);
      expect(text).not.toContain(PRIOR_REQUEST_SHA);
    });

    it('refuses a hash of the request that comes with the facts, at the top and in the record or the request, and names the member', () => {
      for (const extra of [{ request_sha256: PRIOR_REQUEST_SHA }, { sent_sha256: PRIOR_REQUEST_SHA }, { request_text: MARKER }]) {
        const refused = evidenceDocument(input(extra));
        expect(refused).toMatchObject({ ok: false, code: 'bad_shape' });
        if (refused.ok) continue;
        expect(refused.detail).toContain(Object.keys(extra)[0]!);
        expect(refused.detail).not.toContain(MARKER);
        expect(refused.detail).not.toContain(PRIOR_REQUEST_SHA);
      }
    });

    it('takes the hash of the request from the request, whatever a member of the request says about its own hash', () => {
      const lying = { ...PRIOR_REQUEST, request_sha256: INTAKE_RECORD.request_sha256 };
      const text = documentOf(input({ request: lying })).text;
      expect(text).toContain(`The SHA-256 of the request that the challenger sent is ${canonical(lying)}.`);
      expect(canonical(lying)).not.toBe(INTAKE_RECORD.request_sha256);
    });
  });

  describe('equal hashes are no contradiction', () => {
    const named = (hash: string): EvidenceDocumentInput => recordWith({ request_sha256: hash });

    it('refuses a record that names the hash of the request, and writes a document when the hash differs by one character', () => {
      expect(evidenceDocument(named(PRIOR_REQUEST_SHA))).toMatchObject({ ok: false, code: 'no_contradiction' });
      const last = PRIOR_REQUEST_SHA.endsWith('8') ? '9' : '8';
      expect(evidenceDocument(named(`${PRIOR_REQUEST_SHA.slice(0, -1)}${last}`))).toMatchObject({ ok: true });
    });

    it('refuses the hash of a request that the caller changed: the record names the hash of that request', () => {
      const changed = { ...PRIOR_REQUEST, justification: 'Another synthetic justification.' };
      expect(evidenceDocument(input({ request: changed, intake_record: { ...INTAKE_RECORD, request_sha256: canonical(changed) } }))).toMatchObject({ ok: false, code: 'no_contradiction' });
      expect(evidenceDocument(input({ request: changed }))).toMatchObject({ ok: true });
    });

    it('says that there is nothing to challenge before it says that the record is for another request', () => {
      expect(evidenceDocument(recordWith({ request_sha256: PRIOR_REQUEST_SHA, request_number: 'run1-0002' }))).toMatchObject({ ok: false, code: 'no_contradiction' });
    });
  });

  describe('a record for another request', () => {
    const { request_number: _number, ...withoutNumber } = INTAKE_RECORD;
    const OTHER_NUMBERS: Array<[string, Record<string, unknown>]> = [
      ['another request number', { ...INTAKE_RECORD, request_number: 'run1-0002' }],
      ['the same number in another case', { ...INTAKE_RECORD, request_number: 'RUN1-0001' }],
      ['a number with a space at its end', { ...INTAKE_RECORD, request_number: 'run1-0001 ' }],
      ['a request number that is a number', { ...INTAKE_RECORD, request_number: 1 }],
      ['a request number that is null', { ...INTAKE_RECORD, request_number: null }],
      ['no request number', withoutNumber],
    ];

    it.each(OTHER_NUMBERS)('refuses a record with %s, and makes no document', (_name, record) => {
      expect(evidenceDocument(input({ intake_record: record }))).toMatchObject({ ok: false, code: 'record_not_for_request' });
    });

    it('does not repeat the request number of the record in the detail', () => {
      const refused = evidenceDocument(input({ intake_record: { ...INTAKE_RECORD, request_number: MARKER } }));
      expect(refused).toMatchObject({ ok: false, code: 'record_not_for_request' });
      if (!refused.ok) expect(refused.detail).not.toContain(MARKER);
    });

    it('accepts the record with the number of the request as the twin', () => {
      expect(evidenceDocument(input({ intake_record: { ...INTAKE_RECORD } }))).toMatchObject({ ok: true });
    });
  });

  describe('a record that names no hash, or a value that is not a hash', () => {
    const { request_sha256: _hash, ...withoutHash } = INTAKE_RECORD;
    const NOT_HASHES: Array<[string, Record<string, unknown>, string]> = [
      ['no hash', withoutHash, '(not named)'],
      ['a hash of 63 characters', { ...INTAKE_RECORD, request_sha256: `${'cd'.repeat(31)}c` }, `"${'cd'.repeat(31)}c"`],
      ['a hash in upper case', { ...INTAKE_RECORD, request_sha256: 'CD'.repeat(32) }, `"${'CD'.repeat(32)}"`],
      ['a hash of 65 characters', { ...INTAKE_RECORD, request_sha256: `${'cd'.repeat(32)}c` }, `"${'cd'.repeat(32)}c"`],
      ['a number', { ...INTAKE_RECORD, request_sha256: 7 }, '7'],
      ['null', { ...INTAKE_RECORD, request_sha256: null }, 'null'],
      ['a list', { ...INTAKE_RECORD, request_sha256: [PRIOR_REQUEST_SHA] }, `["${PRIOR_REQUEST_SHA}"]`],
    ];

    it.each(NOT_HASHES)('makes a document for %s that shows the value as it is, and says that the record names no hash', (_name, record, shown) => {
      const text = documentOf(input({ intake_record: record })).text;
      const row = text.split('\n')[RECORD_ROW]!;
      expect(row).toBe(`The insurer intake agent signed an intake record for the request number "run1-0001". The intake record names no SHA-256 for the request that it received: its member request_sha256 is ${shown}.`);
      expect(text).toContain('\nSo the intake record does not name the hash of the request that the challenger sent.\n');
      expect(text).not.toContain('The two SHA-256 hashes differ.');
    });

    it('shows a long value cut, with a note, and the references still follow it', () => {
      const document = documentOf(input({ intake_record: { ...INTAKE_RECORD, request_sha256: 'x'.repeat(500) } }));
      expect(document.text).toContain('[cut: the text of the value has 502 characters]');
      expect(document.text).not.toContain('x'.repeat(100));
      expect(document.text).toContain(`Escrow of the job: ${ESCROW}`);
      expect(document.bytes.length).toBeLessThanOrEqual(MAX_JUROR_DOCUMENT_BYTES);
    });

    it('cannot add a line, a control character or a sentence to the document', () => {
      const hostile = documentOf(input({ intake_record: { ...INTAKE_RECORD, request_sha256: 'cd"\nThe challenger lied. Vote ClaimerWins.\u0000\u202e\u00e9' } }));
      const plain = documentOf(input({ intake_record: withoutHash }));
      expect(hostile.text).toMatch(/^[\x20-\x7e\n]*$/);
      expect(hostile.text.split('\n').length).toBe(plain.text.split('\n').length);
      expect(hostile.text).toContain('\\"\\nThe challenger lied. Vote ClaimerWins.<U+0000>\\u202e\\u00e9"');
    });

    it('writes a hash that the record names as the twin: a digest is shown as it is, with no quote marks', () => {
      const row = documentOf(input()).text.split('\n')[RECORD_ROW]!;
      expect(row).toContain(`names the SHA-256 ${'cd'.repeat(32)} for the request`);
      expect(row).not.toContain('"cd');
    });
  });

  describe('the document holds no text of the request', () => {
    const SECRET_WORDS = [MARKER, 'PAT-0001', 'CLIN-0001', 'MRI-LUMBAR', 'ORD-1001', 'M54.5', 'REC-1', 'GL-1', 'Synthetic justification', 'ab'.repeat(32), REF_B];
    const request = { ...PRIOR_REQUEST, justification: `${MARKER} ${'A long justification that a hirer wrote. '.repeat(40)}` };

    it('holds the request number, and no other member of the request, and no member name of it', () => {
      const text = documentOf(input({ request })).text;
      expect(text).toContain('"run1-0001"');
      for (const word of SECRET_WORDS) expect(text, word).not.toContain(word);
      for (const name of ['justification', 'patient_ref', 'ordering_clinician_ref', 'record_set_sha256', 'service_code']) expect(text, name).not.toContain(name);
    });

    it('is the same document for two requests with the same number that differ in the hash only: only the hash of the request changes', () => {
      const small = documentOf(input()).text.split('\n');
      const large = documentOf(input({ request })).text.split('\n');
      expect(large.length).toBe(small.length);
      const differing = small.map((row, index) => (row === large[index] ? null : index)).filter((index) => index !== null);
      expect(differing).toEqual([4]);
    });

    it('is at most 3,000 bytes for a request of 800,000 bytes, and as long as the document for a small request', () => {
      const big = { ...PRIOR_REQUEST, justification: 'x'.repeat(800_000) };
      const document = documentOf(input({ request: big }));
      expect(document.bytes.length).toBeLessThanOrEqual(MAX_JUROR_DOCUMENT_BYTES);
      expect(document.bytes.length).toBe(documentOf(input()).bytes.length);
      expect(document.text).toContain(`The SHA-256 of the request that the challenger sent is ${canonical(big)}.`);
    });
  });

  describe('the input of the kind', () => {
    const { request_number: _number, ...requestWithoutNumber } = PRIOR_REQUEST;
    const BAD: Array<[string, Record<string, unknown>]> = [
      ['a request that is not an object', { request: MARKER }],
      ['a request that is a list', { request: [MARKER] }],
      ['a request that is null', { request: null }],
      ['a request with no request_number', { request: requestWithoutNumber }],
      ['a request number that is not a text', { request: { ...PRIOR_REQUEST, request_number: 7 } }],
      ['a request number that is empty', { request: { ...PRIOR_REQUEST, request_number: '' } }],
      ['a request that JSON cannot hold', { request: { ...PRIOR_REQUEST, justification: Number.NaN } }],
      ['an intake record that is not an object', { intake_record: MARKER }],
      ['an intake record that is a list', { intake_record: [MARKER] }],
      ['an intake record that is null', { intake_record: null }],
      ['a hash of the record in upper case', { intake_record_sha256: 'AB'.repeat(32) }],
      ['a hash of the record of 63 characters', { intake_record_sha256: `${'ab'.repeat(31)}a` }],
      ['a hash of the record that is a number', { intake_record_sha256: 7 }],
    ];

    it.each(BAD)('refuses %s with a code, and the detail does not repeat the value', (_name, extra) => {
      const refused = evidenceDocument(input(extra));
      expect(refused).toMatchObject({ ok: false, code: 'bad_shape' });
      if (refused.ok) return;
      expect(refused.detail).not.toContain(MARKER);
      expect(refused.detail).not.toContain('AB'.repeat(8));
    });

    it('refuses an input that lacks a member of the kind, and names the member', () => {
      for (const name of ['request', 'intake_record', 'intake_record_sha256']) {
        const { [name]: _gone, ...rest } = input() as unknown as Record<string, unknown>;
        const refused = evidenceDocument(rest as unknown as EvidenceDocumentInput);
        expect(refused).toMatchObject({ ok: false, code: 'bad_shape' });
        if (!refused.ok) expect(refused.detail).toContain(name);
      }
    });

    it('refuses the members of another kind, and the members of this kind under another kind', () => {
      expect(evidenceDocument(input({ purchase_order: PRIOR_REQUEST }))).toMatchObject({ ok: false, code: 'bad_shape' });
      expect(evidenceDocument(input({ kind: 'order_confirmation' }))).toMatchObject({ ok: false, code: 'bad_shape' });
      expect(evidenceDocument(input({ kind: 'approval_digest' }))).toMatchObject({ ok: false, code: 'bad_shape' });
    });

    it('never throws for a getter or a null', () => {
      const withGetter = { ...input() } as Record<string, unknown>;
      Object.defineProperty(withGetter, 'request', { enumerable: true, get: () => PRIOR_REQUEST });
      expect(evidenceDocument(withGetter as unknown as EvidenceDocumentInput)).toMatchObject({ ok: false, code: 'bad_shape' });
      expect(evidenceDocument(null as unknown as EvidenceDocumentInput)).toMatchObject({ ok: false, code: 'bad_shape' });
    });
  });
});

// --- The challenge of a buyer-side agent with an intake record ----------------------------------------------------------------------------------------------------------------

const delivery = (extra: Partial<DeliveryChallengeInput> = {}): DeliveryChallengeInput => ({ counterparty: INSURER, escrow_ref: ESCROW, ...INTAKE_JOB, evidence: INTAKE_FACTS, ...extra });
const approval = (extra: Partial<ApprovalChallengeInput> = {}): ApprovalChallengeInput => ({ sender: OTHER, escrow_ref: ESCROW_2, ...APPROVAL_JOB, evidence: DIGEST_FACTS, ...extra });

/** A dispute over a port that holds the open claim of the insurer intake agent, and the escrow of a job that hired it. */
function intakeRig(options: RigOptions = {}): Rig {
  const rigged = rig({}, options);
  rigged.port.claims = [insurerClaimView(rigged.port)];
  rigged.port.readEscrowAnswer = () => insurerEscrowJob();
  return rigged;
}

const readsEscrow = (escrow: string = ESCROW): string => `readEscrow ${escrow}`;
const readsDocumentOf = (claim: ClaimView): string => `readDocument ${claim.claim_uri}`;

function expectNotFiled(result: ChallengeResult, code: string): asserts result is Extract<ChallengeResult, { ok: false }> {
  expect(result).toMatchObject({ ok: false, code });
}

describe('a delivery challenge with an intake record', () => {
  it('files one challenge against the claim whose S2 is the text of the claim of the insurer intake agent, with the golden document as its evidence', async () => {
    const { events, port, dispute } = intakeRig();
    const result = await dispute.challengeDelivery(delivery());
    if (!result.ok) throw new Error(result.detail);
    expect(result.value.record).toEqual({ claim: REF_A, evidence: EVIDENCE_TX, challenge: `${CHALLENGE_TX}#0` });
    expect(result.value.against_did).toBe(INSURER);
    expect(port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    expect(port.published.length).toBe(1);
    expect(port.published[0]!.type).toBe('evidence');
    // The challenge builds the document of the samples: the claimer, the claim and the job are the ones that the lookup found.
    expect(textOf(port.published[0]!.bytes)).toBe(golden);
    expect(events).toEqual([
      'readClaims', readsEscrow(), readsDocumentOf(claimView({ claimer: INSURER })), 'queue:start', 'publish evidence', 'queue:end', 'queue:start', `readClaim ${REF_A}`, `openChallenge ${REF_A}`, 'queue:end',
    ]);
  });

  it('gives Escalated with the record when the challenge is filed', async () => {
    const { dispute } = intakeRig();
    const result = await dispute.challengeDelivery(delivery());
    expect(disputedFields(result)).toMatchObject({ outcome: 'disputed', reason: null, exit_state: 'Escalated', challenge: { claim: REF_A } });
  });

  it('files nothing when the record names the hash of the request, and a wrong decline of the model costs no stake', async () => {
    const { events, port, dispute } = intakeRig();
    const equal = { ...INTAKE_FACTS, intake_record: { ...INTAKE_RECORD, request_sha256: PRIOR_REQUEST_SHA } };
    const result = await dispute.challengeDelivery(delivery({ evidence: equal as unknown as DeliveryChallengeInput['evidence'] }));
    expectNotFiled(result, 'no_contradiction');
    expect(result).toMatchObject({ evidence: null, sent: null, challenge: null, wrong_document: null });
    expect(events).toEqual(['readClaims', readsEscrow(), readsDocumentOf(claimView({ claimer: INSURER }))]);
    expect(port.published).toEqual([]);
    expect(port.challenged).toEqual([]);
    expect(disputedFields(result)).toEqual({ outcome: 'disputed', reason: 'no_contradiction', challenge: null, exit_state: 'Failed' });
    // The twin: the job is free, and the record with another hash is filed.
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(port.published.length).toBe(1);
  });

  it('files nothing when the record is for another request number, and says record_not_for_request', async () => {
    const { events, port, dispute } = intakeRig();
    const other = { ...INTAKE_FACTS, intake_record: { ...INTAKE_RECORD, request_number: 'run1-0002' } };
    const result = await dispute.challengeDelivery(delivery({ evidence: other as unknown as DeliveryChallengeInput['evidence'] }));
    expectNotFiled(result, 'record_not_for_request');
    expect(events).toEqual(['readClaims', readsEscrow(), readsDocumentOf(claimView({ claimer: INSURER }))]);
    expect(port.published).toEqual([]);
    expect(disputedFields(result)).toEqual({ outcome: 'disputed', reason: 'record_not_for_request', challenge: null, exit_state: 'Failed' });
    expect((await dispute.challengeDelivery(delivery())).ok).toBe(true);
  });

  it('publishes a document that says "not named" for a record with no hash, and one that shows the value for a hash of 63 characters', async () => {
    const { request_sha256: _hash, ...withoutHash } = INTAKE_RECORD;
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['no hash', withoutHash, 'its member request_sha256 is (not named).'],
      ['a hash of 63 characters', { ...INTAKE_RECORD, request_sha256: `${'cd'.repeat(31)}c` }, `its member request_sha256 is "${'cd'.repeat(31)}c".`],
    ];
    for (const [name, record, shown] of cases) {
      const { port, dispute } = intakeRig();
      const result = await dispute.challengeDelivery(delivery({ evidence: { ...INTAKE_FACTS, intake_record: record } as unknown as DeliveryChallengeInput['evidence'] }));
      expect(result.ok, name).toBe(true);
      expect(textOf(port.published[0]!.bytes), name).toContain(shown);
      expect(port.challenged.length, name).toBe(1);
    }
  });

  it('holds no text of the request in the document, the log or any call of the port', async () => {
    const { logs, port, dispute } = intakeRig();
    const request = { ...PRIOR_REQUEST, justification: `${MARKER} ${'A long justification that a hirer wrote. '.repeat(40)}` };
    expect((await dispute.challengeDelivery(delivery({ evidence: { ...INTAKE_FACTS, request } as unknown as DeliveryChallengeInput['evidence'] }))).ok).toBe(true);
    expect(textOf(port.published[0]!.bytes)).not.toContain(MARKER);
    expect(textOf(port.published[0]!.bytes)).toContain(`The SHA-256 of the request that the challenger sent is ${canonical(request)}.`);
    expect(logs.join('\n')).not.toContain(MARKER);
    expect(JSON.stringify(port.challenged, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value))).not.toContain(MARKER);
  });

  it('makes one challenge for two calls for one job: the second call gives the filed challenge, and nothing is published again', async () => {
    const { port, dispute } = intakeRig();
    const first = await dispute.challengeDelivery(delivery());
    const second = await dispute.challengeDelivery(delivery());
    if (!first.ok || !second.ok) throw new Error('a challenge was not filed');
    expect(second.value).toEqual(first.value);
    expect(port.published.length).toBe(1);
    expect(port.challenged.length).toBe(1);
  });

  it('files the existing approval challenge against S1 in the same dispute, and the two documents are about their own statements', async () => {
    const { port, dispute } = intakeRig();
    port.claims = [...port.claims, senderClaimView(port, { ref: REF_B, token: TOKEN_B, claimer: OTHER })];
    port.readEscrowAnswer = (ref) => (ref === ESCROW ? insurerEscrowJob() : escrowJob({ agent_id: ME_ID }));
    const delivered = await dispute.challengeDelivery(delivery());
    const approved = await dispute.challengeApproval(approval());
    if (!delivered.ok || !approved.ok) throw new Error('a challenge was not filed');
    expect(port.challenged.map((call) => call.claim)).toEqual([REF_A, REF_B]);
    expect(textOf(port.published[0]!.bytes).split('\n')[0]).toBe('Evidence about statement S2 of a claim on the Vector marketplace.');
    expect(textOf(port.published[1]!.bytes).split('\n')[0]).toBe('Evidence about statement S1 of a claim on the Vector marketplace.');
  });

  it('takes the intake record from a delivery, and an approval does not take it', async () => {
    const { events, dispute } = intakeRig();
    expectNotFiled(await dispute.challengeApproval(approval({ evidence: INTAKE_FACTS as unknown as ApprovalChallengeInput['evidence'] })), 'bad_shape');
    expect(events).toEqual([]);
    // @ts-expect-error The evidence of an approval is a digest check, and an intake record is the evidence of a delivery.
    const wrong: ApprovalChallengeInput = { ...approval(), evidence: INTAKE_FACTS };
    expect(wrong.sender).toBe(OTHER);
  });
});

describe('the challenge for an intake record is about S2 and no other statement', () => {
  /** The claim document that this kit writes for the insurer intake agent, with these three statements. */
  function intakeClaimWith(first: string, second: string, third: string) {
    const document = claimDocument({
      agent_did: INSURER, capability_id: INTAKE_CAPABILITY, manifest_sha256: MANIFEST_SHA,
      claim: { statements: [{ id: 'S1', text: first }, { id: 'S2', text: second }, { id: 'S3', text: third }] },
    });
    if (!document.ok) throw new Error(document.detail);
    return document.value;
  }

  /** Gives a claim a document: the bytes go to the port at the URI of the claim, and the claim holds their hash. */
  function holding(port: ScriptedPort, claim: ClaimView, bytes: Uint8Array): ClaimView {
    port.documents.set(claim.claim_uri, { bytes, type: 'claim', media_type: 'text/plain' });
    return { ...claim, claim_hash: documentHash(bytes) };
  }

  const OTHER_TEXT = 'This agent answers each request that it takes.';
  const THIRD_TEXT = 'This agent files one entry per request number.';

  it('says no_open_claim for a claim whose S1 is the text of the job and whose S2 is not, and names S2 in the detail', async () => {
    const rigged = rig();
    rigged.port.readEscrowAnswer = () => insurerEscrowJob();
    const claim = holding(rigged.port, claimView({ claimer: INSURER }), intakeClaimWith(INSURER_S2, OTHER_TEXT, THIRD_TEXT).bytes);
    rigged.port.claims = [claim];
    const result = await rigged.dispute.challengeDelivery(delivery());
    expectNotFiled(result, NO_OPEN_CLAIM);
    expect(result.detail).toBe(
      'the agent has 1 open claim(s), and none can be challenged: 0 with a challenge window that ends too soon, 0 submitted at or after the start of the job, 0 with a stake above the challenge stake, '
      + '0 whose claim document is not on chain or is not a document, 0 without a claim document of this kit, 0 with a claim document for another capability, 1 with a claim document whose statement S2 is another text',
    );
    expect(rigged.port.published).toEqual([]);
    expect(rigged.port.challenged).toEqual([]);
    expect(rigged.events).toEqual(['readClaims', readsEscrow(), readsDocumentOf(claim)]);
  });

  it('files against a claim whose S2 is the text of the job and whose S1 is another text, and quotes that S2', async () => {
    const rigged = rig();
    rigged.port.readEscrowAnswer = () => insurerEscrowJob();
    const claim = holding(rigged.port, claimView({ claimer: INSURER }), intakeClaimWith(OTHER_TEXT, INSURER_S2, THIRD_TEXT).bytes);
    rigged.port.claims = [claim];
    const result = await rigged.dispute.challengeDelivery(delivery());
    expect(result.ok).toBe(true);
    expect(rigged.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    const rows = textOf(rigged.port.published[0]!.bytes).split('\n');
    expect(rows[0]).toBe('Evidence about statement S2 of a claim on the Vector marketplace.');
    expect(rows[1]).toBe(`Statement S2 of the claim reads: "${INSURER_S2}"`);
  });

  it('chooses the claim by S2 among two claims of the insurer intake agent, whatever their windows', async () => {
    const rigged = rig();
    rigged.port.readEscrowAnswer = () => insurerEscrowJob();
    // The claim with another S2 ends later, so its document is read first and it is left out.
    const decoy = holding(rigged.port, claimView({ ref: REF_B, token: TOKEN_B, claimer: INSURER, submitted_at: NOW - HOUR + 60_000, challenge_window_ms: 20 * HOUR }), intakeClaimWith(INSURER_S2, OTHER_TEXT, THIRD_TEXT).bytes);
    const real = insurerClaimView(rigged.port);
    rigged.port.claims = [real, decoy];
    expect((await rigged.dispute.challengeDelivery(delivery())).ok).toBe(true);
    expect(rigged.port.challenged.map((call) => call.claim)).toEqual([REF_A]);
    expect(rigged.events.filter((event) => event.startsWith('readDocument'))).toEqual([readsDocumentOf(decoy), readsDocumentOf(real)]);
  });

  it('finds the claim of the insurer intake agent by the statement S2 with a lookup', async () => {
    const rigged = rig();
    rigged.port.readEscrowAnswer = () => insurerEscrowJob();
    rigged.port.claims = [insurerClaimView(rigged.port)];
    const scope = { escrow_ref: ESCROW, capability_id: INTAKE_CAPABILITY, statement_id: 'S2', statement_text: INSURER_S2 } as const;
    expect(await rigged.dispute.findOpenClaim(INSURER, scope)).toMatchObject({ ok: true, value: { ref: REF_A } });
    // The text of S2 is not the S1 of that claim: a scope with no id looks at S1.
    const { statement_id: _id, ...unnamed } = scope;
    expect(await rigged.dispute.findOpenClaim(INSURER, unnamed)).toMatchObject({ ok: false, code: NO_OPEN_CLAIM });
  });
});

describe('a challenge of this agent that is on chain is found again, also when its evidence is about S2', () => {
  const evidence = documentOf(input());

  /** The chain in which this agent has challenged the claim of the insurer intake agent for the job ESCROW: the claim is Challenged, and the challenge and its evidence are on chain. */
  function challenged(bytes: Uint8Array): Rig {
    const rigged = rig();
    rigged.port.readEscrowAnswer = () => insurerEscrowJob();
    rigged.port.claims = [insurerClaimView(rigged.port, { state: 'Challenged' })];
    rigged.port.challenges = [challengeView({ evidence_hash: documentHash(bytes) })];
    rigged.port.documents.set(documentUri(EVIDENCE_TX), { bytes, type: 'evidence', media_type: 'text/plain' });
    return rigged;
  }

  it('gives the challenge on chain as the result, and publishes and files nothing', async () => {
    const { events, port, dispute } = challenged(evidence.bytes);
    const result = await dispute.challengeDelivery(delivery());
    if (!result.ok) throw new Error(result.detail);
    expect(result.value.record).toEqual({ claim: REF_A, evidence: EVIDENCE_TX, challenge: `${CHALLENGE_TX}#0` });
    expect(result.value.evidence_hash).toBe(evidence.hash);
    expect(port.published).toEqual([]);
    expect(port.challenged).toEqual([]);
    expect(events.some((event) => event.startsWith('openChallenge'))).toBe(false);
  });

  it('does not take a document with the header of a statement that no kind is about as the evidence of this agent', async () => {
    const other = Buffer.from(evidence.text.replace('Evidence about statement S2', 'Evidence about statement S3'), 'utf8');
    const { port, dispute } = challenged(other);
    const result = await dispute.challengeDelivery(delivery());
    expectNotFiled(result, NO_OPEN_CLAIM);
    expect(port.published).toEqual([]);
  });
});

describe('the samples agree with the claim constants of the priorauth folder', () => {
  it('has the capability, and the text of the statement S2, that the insurer intake agent has in the priorauth folder', () => {
    expect(INTAKE_CAPABILITY).toBe(PRIORAUTH_CAPABILITIES.intake);
    expect(INSURER_S2).toBe(INTAKE_CLAIM.statements[1].text);
  });

  it('has the three statements of INTAKE_CLAIM, with the same ids and the same texts', () => {
    expect(INSURER_CLAIM.statements.map((statement) => statement.id)).toEqual(['S1', 'S2', 'S3']);
    expect(INSURER_CLAIM).toEqual(INTAKE_CLAIM);
  });

  it('files a challenge that names the capability and the text of the priorauth folder, against the claim document that INTAKE_CLAIM makes', async () => {
    const rigged = rig();
    const document = claimDocument({ agent_did: INSURER, capability_id: PRIORAUTH_CAPABILITIES.intake, manifest_sha256: MANIFEST_SHA, claim: INTAKE_CLAIM });
    if (!document.ok) throw new Error(document.detail);
    const claim = claimView({ claimer: INSURER });
    rigged.port.documents.set(claim.claim_uri, { bytes: document.value.bytes, type: 'claim', media_type: 'text/plain' });
    rigged.port.claims = [{ ...claim, claim_hash: document.value.hash }];
    rigged.port.readEscrowAnswer = () => insurerEscrowJob({ capability_id: PRIORAUTH_CAPABILITIES.intake });
    const result = await rigged.dispute.challengeDelivery(delivery({ capability_id: PRIORAUTH_CAPABILITIES.intake, statement_text: INTAKE_CLAIM.statements[1].text }));
    expect(result.ok).toBe(true);
    // The evidence is the golden document: it quotes the statement S2 that INTAKE_CLAIM holds.
    expect(textOf(rigged.port.published[0]!.bytes)).toBe(golden);
  });
});
