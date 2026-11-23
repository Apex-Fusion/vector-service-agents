// agents/reorder-agent/test/execute/dispute.test.ts: the challenge of the job `execute`. Only a no of the model starts a challenge, and the challenge has its ground: the decision of the model, the evidence of
// both documents, the capability and the first claim statement of the Order Desk, and the delegation keys of this agent as the buyer of the escrow. Every other end of a delivery that is not accepted is a
// failure with no challenge and no write of the order. Each form has its twin.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DECISION_WINDOW_MS } from '@vsa/hire-kit';
import { ORDER_DESK_CLAIM } from '@vsa/usecase-kit/inventory';
import { NO_OPEN_CLAIM, RECEIPT_CHECKS, exitStateOf } from '@vsa/usecase-kit/protocol';
import { sha256Utf8Hex } from '@vsa/vector-read';
import { CHALLENGE, SUPPLIER_DID, acceptDecision, challengeNotFiled, confirmationOf, orderHash } from './fixtures.ts';
import type { World } from './world.ts';
import { cleanWorlds, footprint, hireOf, words, world } from './world.ts';

afterEach(() => {
  vi.useRealTimers();
  cleanWorlds();
});

const FIELDS = [['sku', 'SKU-200', 'SKU'], ['lot', 'lot-large', 'lot'], ['quantity', 51, 'quantity']] as const;

/** What a job that did not accept the delivery leaves: the Pay was made and the order was sent, but no Accept was booked and no order was written. */
function expectUnaccepted(w: World): void {
  expect(w.booked.accepted).toBe(0);
  expect(w.store.calls).toHaveLength(0);
}

describe('a delivery that the model does not accept', () => {
  for (const [field, value, label] of FIELDS) {
    it(`files the challenge when the model finds that the ${label} differs: the evidence holds both documents, and the result is disputed and Escalated`, async () => {
      const w = await world();
      w.answer({ [field]: value });
      const request = w.request();
      const result = await w.run(request);
      expect(result).toMatchObject({ outcome: 'disputed', reason: null, exit_state: 'Escalated', challenge: CHALLENGE, writes: [] });
      expect(result.decisions).toStrictEqual([acceptDecision(false, [field])]);
      const escrow = hireOf(result).escrow_ref;
      // The chain posts the escrow with the delegation key of the agent, so the keys that the challenge names hold the buyer that the datum of the escrow names.
      expect(w.dispute.calls[0]?.buyer_pkhs).toContain(w.m.chain.escrowDatum(escrow)?.buyer_pkh);
      const confirmation = confirmationOf(w.document(), { [field]: value });
      expect(hireOf(result)).toMatchObject({ accepted: 'no', paid_from_vault: true, result: confirmation });
      // The Accept was not made, the order was not written, and the escrow stays Submitted.
      expectUnaccepted(w);
      expect(await w.m.chain.escrowState(escrow)).toBe('Submitted');
      expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 0, challenges: 1, asked: 1 });
      // The challenge: the Order Desk, its capability, the first statement of its claim, the delegation keys of this agent, and the evidence.
      expect(ORDER_DESK_CLAIM.statements[0].id).toBe('S1');
      expect(w.dispute.calls).toStrictEqual([{
        counterparty: SUPPLIER_DID,
        escrow_ref: escrow,
        capability_id: 'supplychain.order.accept.v1',
        statement_text: ORDER_DESK_CLAIM.statements[0].text,
        buyer_pkhs: [w.a.testKey.keyHash, w.b.testKey.keyHash],
        evidence: { kind: 'order_confirmation', purchase_order: request.proposal.document, confirmation, confirmation_sha256: sha256Utf8Hex(w.m.agent.answer) },
      }]);
      // The hash of the evidence is the hash that the receipt of the Order Desk commits to.
      expect(hireOf(result).receipt).toMatchObject({ response_hash: sha256Utf8Hex(w.m.agent.answer) });
    });

    it(`gives the dispute folder evidence that a juror can read: the ${label} differs in it, and the other two fields are the same`, async () => {
      const w = await world();
      w.answer({ [field]: value });
      await w.run();
      const document = w.dispute.documents[0];
      expect(document?.ok).toBe(true);
      const text = document?.ok === true ? document.value.text : '';
      for (const [other, , name] of FIELDS) expect(text).toContain(other === field ? `The ${name} differs.` : `The ${name} is the same in both.`);
      expect(text).toContain(`SHA-256 of the purchase order: ${orderHash(w.document())}`);
      expect(text).toContain(`SHA-256 of the confirmation: ${sha256Utf8Hex(w.m.agent.answer)}`);
    });
  }

  it('twin: a confirmation with the same SKU, lot and quantity is accepted, and no challenge is filed', async () => {
    const w = await world();
    expect(words(await w.run())).toBe('completed none Completed');
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 1, challenges: 0, asked: 1 });
  });

  it('files no challenge for a model that says no when the documents do not differ: the evidence cannot state a contradiction, so the dispute folder files nothing', async () => {
    const w = await world();
    w.accept.answer = () => ({ ok: true, decision: acceptDecision(false, ['sku']), choice: { accept: false, mismatch: ['sku'] } });
    const result = await w.run();
    expect(result).toMatchObject({ outcome: 'disputed', reason: 'no_contradiction', exit_state: 'Failed', challenge: null });
    expect(w.dispute.documents[0]?.ok).toBe(false);
    expect(result.decisions).toStrictEqual([acceptDecision(false, ['sku'])]);
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
      w.answer({ lot: 'lot-large' });
      w.dispute.answer = () => challengeNotFiled(code);
      const result = await w.run();
      expect(result).toMatchObject({ outcome: 'disputed', reason: code, exit_state: 'Failed', challenge: null, writes: [] });
      expect(result.exit_state).toBe(exitStateOf({ outcome: 'disputed', reason: code, challenge_filed: false, delegation_ended: false }));
      expect(result.decisions).toStrictEqual([acceptDecision(false, ['lot'])]);
      expect(hireOf(result)).toMatchObject({ accepted: 'no' });
      expectUnaccepted(w);
    });
  }

  it('says no_open_claim when the Order Desk has no open claim: the reason of the protocol, and the exit state Failed', async () => {
    const w = await world();
    w.answer({ quantity: 51 });
    w.dispute.answer = () => challengeNotFiled('no_open_claim');
    const result = await w.run();
    expect(result.reason).toBe(NO_OPEN_CLAIM);
    expect(result.exit_state).toBe('Failed');
    expect(w.dispute.calls).toHaveLength(1);
  });

  it('writes what landed before the step stopped to the log: the evidence, a transaction that was sent, a challenge against another claim, and a document with another hash', async () => {
    const w = await world();
    w.answer({ sku: 'SKU-200' });
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
    filed.answer({ sku: 'SKU-200' });
    await filed.run();
    expect(filed.log.find((entry) => entry.includes('challenge filed'))).toContain(CHALLENGE.claim);
  });

  it('is disputed with port_error when the dispute folder throws, and the text of the error is not in the result or in the log', async () => {
    const w = await world();
    w.answer({ sku: 'SKU-200' });
    w.dispute.failWith = new Error('the node answered with the key k1-secret');
    const result = await w.run();
    expect(result).toMatchObject({ outcome: 'disputed', reason: 'port_error', exit_state: 'Failed', challenge: null });
    expect(`${JSON.stringify(result)}${w.log.join('\n')}`).not.toContain('k1-secret');
  });

  it('is disputed with port_error when the dispute folder gives no answer that can be read', async () => {
    const w = await world();
    w.answer({ sku: 'SKU-200' });
    w.dispute.answer = () => undefined as never;
    expect(await w.run()).toMatchObject({ outcome: 'disputed', reason: 'port_error', exit_state: 'Failed', challenge: null });
  });
});

describe('a delivery that is not accepted for a reason that is not a no of the model', () => {
  /** Each of these ends is a failure with its own reason. None is a ground for a challenge: the model did not decide it, or it did not decide at all. */
  const ENDS: Array<[string, (w: World) => void, string, number]> = [
    ['an answer that is no confirmation', (w) => { w.answer('the order is placed'); }, 'confirmation_invalid', 0],
    ['a confirmation of another purchase order number', (w) => { w.answer({ po_number: 'run1-2' }); }, 'confirmation_not_for_order', 0],
    ['a confirmation with the hash of another order', (w) => { w.answer({ po_sha256: '00'.repeat(32) }); }, 'confirmation_not_for_order', 0],
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
      expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 0, challenges: 0, asked });
      expectUnaccepted(w);
    });
  }

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
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 0, challenges: 0, asked: 1 });
    expect(await w.m.chain.escrowState(hireOf(result).escrow_ref)).toBe('Submitted');
    expectUnaccepted(w);
  });

  it('twin: a model that answers one millisecond before the limit is heard, and the delivery is accepted', async () => {
    vi.useFakeTimers();
    const w = await world();
    const model = w.accept.answer;
    w.accept.answer = (order, confirmation) => {
      vi.advanceTimersByTime(DECISION_WINDOW_MS - 1);
      return model(order, confirmation);
    };
    expect(words(await w.run())).toBe('completed none Completed');
  });

  it('is failed with delivery_not_recordable and no challenge when the delivery cannot be written as JSON data: the model is not asked, and the evidence of use case 1 needs the confirmation', async () => {
    const w = await world();
    w.receipt.depth = 40;
    const result = await w.run();
    expect(words(result)).toBe('failed delivery_not_recordable Failed');
    expect(result).toMatchObject({ challenge: null, writes: [], decisions: [] });
    expect(hireOf(result)).toMatchObject({ accepted: 'no', receipt: null, result: null, verification: Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true])) });
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 0, challenges: 0, asked: 0 });
    expectUnaccepted(w);
    // The twin: a receipt that the reader takes, nested five levels deep, is given to the model, and the delivery is accepted.
    const readable = await world();
    readable.receipt.depth = 5;
    expect(words(await readable.run())).toBe('completed none Completed');
  });

  it('files no challenge on any other end: a refused Pay, a refusal of the Order Desk and a failure of the job', async () => {
    const refused = await world({ lot: 'lot-large' });
    expect(words(await refused.run()).startsWith('vault_refused')).toBe(true);
    const turned = await world();
    turned.m.agent.refuse = { status: 403, code: 'lot_mismatch' };
    expect(words(await turned.run())).toBe('refused_by_counterparty lot_mismatch Rejected');
    const failed = await world();
    failed.m.agent.steps = ['running', { fail: 'upstream_failure', submitted: false }];
    expect(words(await failed.run())).toBe('failed failed Failed');
    for (const w of [refused, turned, failed]) expect(w.dispute.calls).toHaveLength(0);
  });
});
