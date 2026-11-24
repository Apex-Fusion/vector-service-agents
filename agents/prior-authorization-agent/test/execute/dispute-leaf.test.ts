// agents/prior-authorization-agent/test/execute/dispute-leaf.test.ts: `disputeDelivery`, the leaf that builds the call of the challenge. It takes plain inputs and a port, and it gives the kit result as it is. The call
// names the capability of the Insurer Intake Agent, the text of the statement S2 of its claim (the statement that the evidence of an intake record is about), the buyer keys, and the evidence with the request that
// was sent, the intake record and the hash of its text. Each test has its twin.
import { describe, expect, it } from 'vitest';
import { EVIDENCE_STATEMENTS } from '@vsa/usecase-kit/dispute';
import type { ChallengeResult, DeliveryChallengeInput } from '@vsa/usecase-kit/dispute';
import { INTAKE_CLAIM, PRIORAUTH_CAPABILITIES } from '@vsa/usecase-kit/priorauth';
import type { JsonObject } from '@vsa/usecase-kit/protocol';
import { disputeDelivery } from '../../src/execute/dispute.ts';
import { CHALLENGE, INSURER_DID, challengeFiled, challengeNotFiled, intakeRecordOf, requestDocument } from './fixtures.ts';

const ESCROW = `${'ab'.repeat(32)}#0`;
const KEYS = ['11'.repeat(28), '22'.repeat(28)];
const REQUEST = requestDocument();
const RECORD = intakeRecordOf(REQUEST, { request_sha256: '00'.repeat(32) }) as JsonObject;
const RECORD_SHA = '9d'.repeat(32);
const INPUT = { counterparty: INSURER_DID, escrow_ref: ESCROW, request: REQUEST as JsonObject, intake_record: RECORD, intake_record_sha256: RECORD_SHA };

/** A dispute folder that records its calls and answers `answer`. */
function recorder(answer: () => ChallengeResult | Promise<ChallengeResult>): { calls: DeliveryChallengeInput[]; dispute: { challengeDelivery: (input: DeliveryChallengeInput) => Promise<ChallengeResult> } } {
  const calls: DeliveryChallengeInput[] = [];
  return { calls, dispute: { challengeDelivery: async (input) => { calls.push(input); return answer(); } } };
}

describe('the call of the challenge', () => {
  it('names the Insurer Intake Agent, its capability, the statement S2, the buyer keys and the evidence of the intake record: every member', async () => {
    const { calls, dispute } = recorder(() => challengeFiled());
    await disputeDelivery({ dispute }, INPUT, KEYS);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toStrictEqual({
      counterparty: INSURER_DID,
      escrow_ref: ESCROW,
      capability_id: 'health.priorauth.intake.v1',
      statement_text: INTAKE_CLAIM.statements[1].text,
      buyer_pkhs: KEYS,
      evidence: { kind: 'intake_record', request: REQUEST, intake_record: RECORD, intake_record_sha256: RECORD_SHA },
    });
  });

  it('uses the capability of the intake advert and the text of the statement S2 that the kit holds, and not the text of the statement S1 or S3', async () => {
    const { calls, dispute } = recorder(() => challengeFiled());
    await disputeDelivery({ dispute }, INPUT, KEYS);
    const call = calls[0]!;
    expect(call.capability_id).toBe(PRIORAUTH_CAPABILITIES.intake);
    // The evidence kind is about one statement, and the text of the call is the text of that statement of the claim of the Insurer Intake Agent.
    expect(call.evidence.kind).toBe('intake_record');
    const about = EVIDENCE_STATEMENTS[call.evidence.kind];
    expect(about).toBe('S2');
    expect(INTAKE_CLAIM.statements[1].id).toBe(about);
    expect(call.statement_text).toBe(INTAKE_CLAIM.statements.find((statement) => statement.id === about)?.text);
    expect(call.statement_text).not.toBe(INTAKE_CLAIM.statements[0].text);
    expect(call.statement_text).not.toBe(INTAKE_CLAIM.statements[2].text);
  });

  it('passes the buyer keys that it is given, and the evidence members as it is given them, and nothing else', async () => {
    const { calls, dispute } = recorder(() => challengeFiled());
    const other = [...KEYS, '33'.repeat(28)];
    await disputeDelivery({ dispute }, { ...INPUT, escrow_ref: `${'cd'.repeat(32)}#1`, intake_record_sha256: '7e'.repeat(32) }, other);
    expect(calls[0]?.buyer_pkhs).toStrictEqual(other);
    expect(calls[0]?.escrow_ref).toBe(`${'cd'.repeat(32)}#1`);
    expect(calls[0]?.evidence).toStrictEqual({ kind: 'intake_record', request: REQUEST, intake_record: RECORD, intake_record_sha256: '7e'.repeat(32) });
    expect(Object.keys(calls[0]!).sort()).toStrictEqual(['buyer_pkhs', 'capability_id', 'counterparty', 'escrow_ref', 'evidence', 'statement_text']);
    expect(Object.keys(calls[0]!.evidence).sort()).toStrictEqual(['intake_record', 'intake_record_sha256', 'kind', 'request']);
  });

  it('does not add a hash of the request: the evidence holds the request itself, and the kit computes its hash', async () => {
    const { calls, dispute } = recorder(() => challengeFiled());
    await disputeDelivery({ dispute }, INPUT, KEYS);
    expect(Object.keys(calls[0]!.evidence)).not.toContain('request_sha256');
    expect(calls[0]!.evidence).toHaveProperty('request', REQUEST);
  });
});

describe('the result of the challenge', () => {
  it('is the result of the dispute folder as it is: the same object for a challenge that was filed', async () => {
    const filed = challengeFiled();
    const { dispute } = recorder(() => filed);
    const result = await disputeDelivery({ dispute }, INPUT, KEYS);
    expect(result).toBe(filed);
    expect(result.ok && result.value.record).toStrictEqual(CHALLENGE);
  });

  it('is the result of the dispute folder as it is: the same object for a challenge that was not filed', async () => {
    const refused = challengeNotFiled('no_open_claim');
    const { dispute } = recorder(() => refused);
    expect(await disputeDelivery({ dispute }, INPUT, KEYS)).toBe(refused);
  });

  it('makes one call of the dispute folder, and the error of that call is not caught here', async () => {
    const failing = recorder(() => { throw new Error('the node fell over'); });
    await expect(disputeDelivery({ dispute: failing.dispute }, INPUT, KEYS)).rejects.toThrow('the node fell over');
    expect(failing.calls).toHaveLength(1);
    const working = recorder(() => challengeFiled());
    await disputeDelivery({ dispute: working.dispute }, INPUT, KEYS);
    expect(working.calls).toHaveLength(1);
  });
});
