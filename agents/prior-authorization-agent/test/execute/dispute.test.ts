// agents/prior-authorization-agent/test/execute/dispute.test.ts: the challenge of the job `execute`. Only a no of the model starts a challenge, and the challenge has its ground: the decision of the model, the evidence
// of the request that was sent and the intake record, the capability and the second claim statement of the Insurer Intake Agent, and the delegation keys of this agent as the buyer of the escrow. Every other end of a
// delivery that is not accepted is a failure with no challenge and no write of the submission. Each form has its twin.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DECISION_WINDOW_MS } from '@vsa/hire-kit';
import { INTAKE_CHECKS, INTAKE_CLAIM } from '@vsa/usecase-kit/priorauth';
import { NO_OPEN_CLAIM, RECEIPT_CHECKS, exitStateOf } from '@vsa/usecase-kit/protocol';
import { sha256Utf8Hex } from '@vsa/vector-read';
import { CHALLENGE, INSURER_DID, acceptDecision, challengeNotFiled, golden, requestDocument, requestHash } from './fixtures.ts';
import type { World } from './world.ts';
import { cleanWorlds, footprint, handoffSent, hireOf, words, world } from './world.ts';

afterEach(() => {
  vi.useRealTimers();
  cleanWorlds();
});

const OTHER_HASH = '00'.repeat(32);

/** What a job that did not accept the delivery leaves: the Pay was made and the request was sent, but no Accept was booked and no submission was written. */
function expectUnaccepted(w: World): void {
  expect(w.booked.accepted).toBe(0);
  expect(w.store.calls).toHaveLength(0);
  expect(w.tokens).toHaveLength(0);
}

describe('a delivery that the model does not accept', () => {
  it('files the challenge when the model finds that the hash differs: the evidence holds the request and the record, and the result is disputed and Escalated', async () => {
    const w = await world();
    w.answer({ request_sha256: OTHER_HASH });
    const request = w.request();
    const result = await w.run(request);
    expect(result).toMatchObject({ outcome: 'disputed', reason: null, exit_state: 'Escalated', challenge: CHALLENGE, writes: [] });
    expect(result.exit_state).toBe(exitStateOf({ outcome: 'disputed', reason: null, challenge_filed: true, delegation_ended: false }));
    expect(result.decisions).toStrictEqual([acceptDecision(false, ['request_sha256'])]);
    const escrow = hireOf(result).escrow_ref;
    // The chain posts the escrow with the delegation key of the agent, so the keys that the challenge names hold the buyer that the datum of the escrow names.
    expect(w.dispute.calls[0]?.buyer_pkhs).toContain(w.m.chain.escrowDatum(escrow)?.buyer_pkh);
    const record = JSON.parse(w.recordFor(w.document(), { request_sha256: OTHER_HASH })) as Record<string, unknown>;
    expect(hireOf(result)).toMatchObject({ accepted: 'no', paid_from_vault: true, result: record });
    // The Accept was not made, the submission was not written, and the escrow stays Submitted.
    expectUnaccepted(w);
    expect(await w.m.chain.escrowState(escrow)).toBe('Submitted');
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 0, challenges: 1, asked: 1 });
    // The challenge: the Insurer Intake Agent, its capability, the second statement of its claim, the delegation keys of this agent, and the evidence. The request in the evidence is the document of the handoff.
    expect(INTAKE_CLAIM.statements[1].id).toBe('S2');
    expect(w.dispute.calls).toStrictEqual([{
      counterparty: INSURER_DID,
      escrow_ref: escrow,
      capability_id: 'health.priorauth.intake.v1',
      statement_text: INTAKE_CLAIM.statements[1].text,
      buyer_pkhs: [w.a.testKey.keyHash, w.b.testKey.keyHash],
      evidence: { kind: 'intake_record', request: handoffSent(w).document, intake_record: record, intake_record_sha256: sha256Utf8Hex(w.m.agent.answer) },
    }]);
    expect(w.dispute.calls[0]!.evidence).toMatchObject({ request: request.proposal.document });
    // The hash of the evidence is the hash that the receipt of the Insurer Intake Agent commits to.
    expect(hireOf(result).receipt).toMatchObject({ response_hash: sha256Utf8Hex(w.m.agent.answer) });
  });

  it('gives the dispute folder evidence that a juror can read: the request number, the hash of the request that was sent, the hash that the record names, and the hash of the record', async () => {
    const w = await world();
    w.answer({ request_sha256: OTHER_HASH });
    await w.run();
    const document = w.dispute.documents[0];
    expect(document?.ok).toBe(true);
    const text = document?.ok === true ? document.value.text : '';
    expect(text.split('\n')[0]).toBe('Evidence about statement S2 of a claim on the Vector marketplace.');
    expect(text).toContain(`Statement S2 of the claim reads: "${INTAKE_CLAIM.statements[1].text}"`);
    expect(text).toContain('The request has the request number "run1-1".');
    expect(text).toContain(`The SHA-256 of the request that the challenger sent is ${requestHash(w.document())}.`);
    expect(text).toContain(`The intake record names the SHA-256 ${OTHER_HASH} for the request that it received.`);
    expect(text).toContain(`SHA-256 of the intake record: ${sha256Utf8Hex(w.m.agent.answer)}`);
    // The evidence holds no text of the request.
    expect(text).not.toContain('low back pain');
    expect(text).not.toContain('SYN-PT-0001');
  });

  it('twin: a record that names the hash of the request is accepted, and no challenge is filed', async () => {
    const w = await world();
    expect(words(await w.run())).toBe('completed none Completed');
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 1, challenges: 0, asked: 1 });
  });

  it('files no challenge for a model that says no when the hashes are equal: the evidence cannot state a contradiction, so the dispute folder files nothing', async () => {
    const w = await world();
    w.accept.answer = () => ({ ok: true, decision: acceptDecision(false, ['request_sha256']), choice: { accept: false, mismatch: ['request_sha256'] } });
    const result = await w.run();
    expect(result).toMatchObject({ outcome: 'disputed', reason: 'no_contradiction', exit_state: 'Failed', challenge: null });
    expect(w.dispute.documents[0]?.ok).toBe(false);
    expect(result.decisions).toStrictEqual([acceptDecision(false, ['request_sha256'])]);
    expectUnaccepted(w);
  });
});

describe('a challenge that is not filed', () => {
  const CODES = [
    NO_OPEN_CLAIM, 'claim_window_closing', 'claim_changed', 'journal_unavailable', 'chain_unavailable', 'job_already_disputed', 'same_agent', 'bad_shape', 'document_too_large', 'evidence_not_built',
    'evidence_not_confirmed', 'challenge_not_built', 'challenge_not_confirmed', 'challenge_wrong_claim', 'port_error',
  ] as const;
  for (const code of CODES) {
    it(`is disputed with the reason ${code} and the exit state Failed: no challenge, and the decision of the model is kept`, async () => {
      const w = await world();
      w.answer({ request_sha256: OTHER_HASH });
      w.dispute.answer = () => challengeNotFiled(code);
      const result = await w.run();
      expect(result).toMatchObject({ outcome: 'disputed', reason: code, exit_state: 'Failed', challenge: null, writes: [] });
      expect(result.exit_state).toBe(exitStateOf({ outcome: 'disputed', reason: code, challenge_filed: false, delegation_ended: false }));
      expect(result.decisions).toStrictEqual([acceptDecision(false, ['request_sha256'])]);
      expect(hireOf(result)).toMatchObject({ accepted: 'no' });
      expectUnaccepted(w);
    });
  }

  it('says no_open_claim when the Insurer Intake Agent has no open claim: the reason of the protocol, and the exit state Failed', async () => {
    const w = await world();
    w.answer({ request_sha256: OTHER_HASH });
    w.dispute.answer = () => challengeNotFiled('no_open_claim');
    const result = await w.run();
    expect(result.reason).toBe(NO_OPEN_CLAIM);
    expect(result.exit_state).toBe('Failed');
    expect(w.dispute.calls).toHaveLength(1);
  });

  it('writes what landed before the step stopped to the log: the evidence, a transaction that was sent, a challenge against another claim, and a document with another hash', async () => {
    const w = await world();
    w.answer({ request_sha256: OTHER_HASH });
    w.dispute.answer = () => challengeNotFiled('claim_changed', {
      evidence: { tx_hash: 'e2'.repeat(32), uri: 'ipfs://evidence', document_hash: 'd5'.repeat(32) },
      sent: { tx_hash: 'f3'.repeat(32), valid_to: 1_790_000_900_000, may_land: true },
    });
    await w.run();
    const line = w.log.find((entry) => entry.includes('challenge not filed'));
    expect(line).toContain('claim_changed');
    expect(line).toContain(`evidence ${'e2'.repeat(32)}`);
    expect(line).toContain(`sent ${'f3'.repeat(32)}`);
    // The twin: a challenge that is filed names its claim, its evidence and its challenge.
    const filed = await world();
    filed.answer({ request_sha256: OTHER_HASH });
    await filed.run();
    expect(filed.log.find((entry) => entry.includes('challenge filed'))).toContain(CHALLENGE.claim);
  });

  it('is disputed with port_error when the dispute folder throws, and the text of the error is not in the result or in the log', async () => {
    const w = await world();
    w.answer({ request_sha256: OTHER_HASH });
    w.dispute.failWith = new Error('the node answered with the key k1-secret');
    const result = await w.run();
    expect(result).toMatchObject({ outcome: 'disputed', reason: 'port_error', exit_state: 'Failed', challenge: null });
    expect(`${JSON.stringify(result)}${w.log.join('\n')}`).not.toContain('k1-secret');
  });

  it('is disputed with port_error when the dispute folder gives no answer that can be read', async () => {
    const w = await world();
    w.answer({ request_sha256: OTHER_HASH });
    w.dispute.answer = () => undefined as never;
    expect(await w.run()).toMatchObject({ outcome: 'disputed', reason: 'port_error', exit_state: 'Failed', challenge: null });
  });
});

describe('a delivery that is not accepted for a reason that is not a no of the model', () => {
  /** Each of these ends is a failure with its own reason. None is a ground for a challenge: the model did not decide it, or it did not decide at all. */
  const ENDS: Array<[string, (w: World) => void, string, number]> = [
    ['an answer that is no intake record', (w) => { w.answer('the request is filed'); }, 'intake_record_invalid', 0],
    ['an intake record with a check that is false', (w) => { w.answer({ checks: Object.fromEntries(INTAKE_CHECKS.map((name) => [name, name !== 'advert'])) }); }, 'intake_record_invalid', 0],
    ['an intake record that names the right hash in upper case', (w) => { w.answer({ request_sha256: requestHash(w.document()).toUpperCase() }); }, 'intake_record_invalid', 0],
    ['an intake record of another request number', (w) => { w.answer({ request_number: 'run1-2' }); }, 'intake_not_for_request', 0],
    ['an intake record of the same request number in another case', (w) => { w.answer({ request_number: 'RUN1-1' }); }, 'intake_not_for_request', 0],
    ['an intake record of another sender', (w) => { w.answer({ sender: { did: `did:vector:${'c4'.repeat(32)}`, organisation: 'org.example', organisation_verified: true } }); }, 'intake_not_for_request', 0],
    ['a decision that failed', (w) => { w.accept.answer = () => ({ ok: false, code: 'llm_supplier_unavailable' }); }, 'decision_failed', 1],
    ['a model port that throws', (w) => { w.accept.answer = () => { throw new Error('the port fell over'); }; }, 'decision_failed', 1],
    ['an answer of the model port that is not a decision', (w) => { w.accept.answer = () => 'accept'; }, 'decision_failed', 1],
  ];
  for (const [name, arrange, code, asked] of ENDS) {
    it(`is failed with ${code} and no challenge: ${name}`, async () => {
      const w = await world();
      arrange(w);
      const result = await w.run();
      expect(words(result)).toBe(`failed ${code} Failed`);
      expect(result).toMatchObject({ challenge: null, writes: [], decisions: [] });
      expect(hireOf(result)).toMatchObject({ accepted: 'no', paid_from_vault: true });
      expect(await w.m.chain.escrowState(hireOf(result).escrow_ref)).toBe('Submitted');
      expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 0, challenges: 0, asked });
      expectUnaccepted(w);
    });
  }

  it('twin: the right hash in lower case is read, goes to the model, and is accepted', async () => {
    const w = await world();
    w.answer({ request_sha256: requestHash(w.document()) });
    expect(words(await w.run())).toBe('completed none Completed');
    expect(footprint(w).asked).toBe(1);
  });

  it('is failed with decision_timeout and no challenge when the model does not answer in time: the model was asked, nothing is accepted, and no decision is recorded', async () => {
    vi.useFakeTimers();
    const w = await world();
    w.accept.answer = () => {
      vi.advanceTimersByTime(DECISION_WINDOW_MS);
      return new Promise<never>(() => undefined);
    };
    const result = await w.run();
    expect(words(result)).toBe('failed decision_timeout Failed');
    expect(result).toMatchObject({ challenge: null, writes: [], decisions: [] });
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 0, challenges: 0, asked: 1 });
    expect(await w.m.chain.escrowState(hireOf(result).escrow_ref)).toBe('Submitted');
    expectUnaccepted(w);
  });

  it('twin: a model that answers one millisecond before the limit is heard, and the delivery is accepted', async () => {
    vi.useFakeTimers();
    const w = await world();
    const model = w.accept.answer;
    w.accept.answer = (sent, received) => {
      vi.advanceTimersByTime(DECISION_WINDOW_MS - 1);
      return model(sent, received);
    };
    expect(words(await w.run())).toBe('completed none Completed');
  });

  it('is failed with delivery_not_recordable and no challenge when the delivery cannot be written as JSON data: the model is not asked, and the evidence needs the record', async () => {
    const w = await world();
    w.receipt.depth = 40;
    const result = await w.run();
    expect(words(result)).toBe('failed delivery_not_recordable Failed');
    expect(result).toMatchObject({ challenge: null, writes: [], decisions: [] });
    expect(hireOf(result)).toMatchObject({ accepted: 'no', receipt: null, result: null, verification: Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true])) });
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 0, challenges: 0, asked: 0 });
    expectUnaccepted(w);
    // The twin: a receipt that the reader takes, nested five levels deep, is given to the model, and the delivery is accepted.
    const readable = await world();
    readable.receipt.depth = 5;
    expect(words(await readable.run())).toBe('completed none Completed');
  });

  it('files no challenge on any other end: a refused Pay, a refusal of the Insurer Intake Agent and a failure of the job', async () => {
    const refused = await world({ limit: { perTx: 3_000_000n, total: 4_000_000n, periodMs: 86_400_000 } });
    expect(words(await refused.run()).startsWith('vault_refused')).toBe(true);
    const turned = await world();
    turned.m.agent.refuse = { status: 403, code: 'not_for_this_insurer' };
    expect(words(await turned.run())).toBe('refused_by_counterparty not_for_this_insurer Rejected');
    const failed = await world();
    failed.m.agent.steps = ['running', { fail: 'upstream_failure', submitted: false }];
    expect(words(await failed.run())).toBe('failed failed Failed');
    for (const w of [refused, turned, failed]) expect(w.dispute.calls).toHaveLength(0);
  });
});

describe('the request in the evidence', () => {
  it('is the document of the handoff, which is the approved request, byte for byte, when the setting of the fault is empty', async () => {
    const w = await world();
    w.answer({ request_sha256: OTHER_HASH });
    await w.run();
    expect(w.dispute.calls[0]!.evidence).toHaveProperty('request', requestDocument());
    expect(w.dispute.calls[0]!.evidence).toHaveProperty('request', golden('request.json'));
  });
});
