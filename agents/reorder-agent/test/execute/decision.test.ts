// agents/reorder-agent/test/execute/decision.test.ts: the decision on a delivery of the Order Desk. Two checks in code come before the model: the text must be an order confirmation, and it must answer this
// order by its number and by its hash (the canonical hash of the order document, with no salt). A confirmation that fails a check is never given to the model. Only the boolean true accepts. Each refusal
// has an accepted twin.
import { describe, expect, it } from 'vitest';
import { proposalDigest } from '@vsa/usecase-kit/protocol';
import { judgeDelivery } from '../../src/execute/decision.ts';
import type { DeliveryJudge } from '../../src/execute/decision.ts';
import { SALT, ScriptedAccept, acceptDecision, confirmationOf, decisionOf, deliveryOf, orderHash, purchaseOrder, typedConfirmation, typedOrder } from './fixtures.ts';

const ORDER = purchaseOrder();

/** A judge for the order of the tests, with the model that the test gives (a perfect model by default), and the lines that it noted. */
function setup(accept = new ScriptedAccept()): { accept: ScriptedAccept; judge: DeliveryJudge; notes: string[] } {
  const notes: string[] = [];
  return { accept, judge: judgeDelivery({ acceptDelivery: accept.acceptDelivery, note: (line) => { notes.push(line); } }, typedOrder(ORDER), orderHash(ORDER)), notes };
}

const salted = (): string => {
  const digest = proposalDigest(SALT, ORDER);
  if (!digest.ok) throw new Error('the salted digest of the test is refused');
  return digest.value;
};

describe('the confirmation of this order', () => {
  it('is given to the model, and the model decides: a confirmation with the same SKU, lot and quantity is accepted, and the decision is kept', async () => {
    const { accept, judge } = setup();
    expect(await judge.decide(deliveryOf(confirmationOf(ORDER)))).toStrictEqual({ accept: true });
    expect(accept.calls).toHaveLength(1);
    expect(accept.calls[0]!.order).toStrictEqual(typedOrder(ORDER));
    expect(accept.calls[0]!.confirmation).toStrictEqual(typedConfirmation(confirmationOf(ORDER)));
    expect(judge.learned()).toStrictEqual({ said: 'accepted', decision: acceptDecision(true) });
  });

  it('is not accepted when the model declines: the reason is declined_by_model, and the decision and the fields that differ are kept', async () => {
    for (const [field, value] of [['sku', 'SKU-200'], ['lot', 'lot-large'], ['quantity', 51]] as const) {
      const { accept, judge } = setup();
      expect(await judge.decide(deliveryOf(confirmationOf(ORDER, { [field]: value })))).toStrictEqual({ accept: false, reason: 'declined_by_model' });
      expect(accept.calls, field).toHaveLength(1);
      expect(judge.learned(), field).toStrictEqual({ said: 'declined_by_model', decision: acceptDecision(false, [field]), mismatch: [field] });
    }
  });
});

describe('a delivery that is no confirmation, or not the confirmation of this order', () => {
  const CASES: Array<[string, () => unknown, 'confirmation_invalid' | 'confirmation_not_for_order']> = [
    ['a text that is not JSON', () => 'the order is placed', 'confirmation_invalid'],
    ['a JSON text that is a list', () => '[1,2,3]', 'confirmation_invalid'],
    ['a JSON text that is a text', () => '"done"', 'confirmation_invalid'],
    ['an object with the members of another document', () => ({ status: 'confirmed', lot: 'lot-1', quantity: 12 }), 'confirmation_invalid'],
    ['a confirmation with a member that is not listed', () => confirmationOf(ORDER, { note: 'extra' }), 'confirmation_invalid'],
    ['a confirmation whose outcome is not done', () => confirmationOf(ORDER, { outcome: 'refused' }), 'confirmation_invalid'],
    ['a confirmation with a check that is false', () => confirmationOf(ORDER, { checks: { ...(confirmationOf(ORDER).checks as object), lot: false } }), 'confirmation_invalid'],
    ['a confirmation with a fault value that the Order Desk does not list', () => confirmationOf(ORDER, { fault_mode: 'invert_scores' }), 'confirmation_invalid'],
    ['a confirmation of another purchase order number', () => confirmationOf(ORDER, { po_number: 'run1-2' }), 'confirmation_not_for_order'],
    ['a confirmation of the same number in another case', () => confirmationOf(ORDER, { po_number: 'RUN1-1' }), 'confirmation_not_for_order'],
    ['a confirmation with the hash of another order', () => confirmationOf(ORDER, { po_sha256: orderHash(purchaseOrder({ po_number: 'run1-2' })) }), 'confirmation_not_for_order'],
    ['a confirmation with the salted digest of the proposal, which is not the hash of the order', () => confirmationOf(ORDER, { po_sha256: salted() }), 'confirmation_not_for_order'],
    ['a confirmation with the right hash and the number of another order', () => confirmationOf(ORDER, { po_number: 'run1-9', po_sha256: orderHash(ORDER) }), 'confirmation_not_for_order'],
    ['a confirmation with the right number and the hash of another order', () => confirmationOf(ORDER, { po_number: 'run1-1', po_sha256: '00'.repeat(32) }), 'confirmation_not_for_order'],
  ];
  for (const [name, make, reason] of CASES) {
    it(`is refused with ${reason} and never given to the model: ${name}`, async () => {
      const { accept, judge, notes } = setup();
      expect(await judge.decide(deliveryOf(make()))).toStrictEqual({ accept: false, reason });
      expect(accept.calls).toHaveLength(0);
      expect(judge.learned()).toStrictEqual({ said: reason });
      expect(notes).toHaveLength(1);
    });
  }

  it('twin: the same order with the right number and the right hash goes to the model', async () => {
    const { accept, judge } = setup();
    expect(await judge.decide(deliveryOf(confirmationOf(ORDER)))).toStrictEqual({ accept: true });
    expect(accept.calls).toHaveLength(1);
  });

  it('does not ask the model when the delivery has no object, and its twin does', async () => {
    const none = setup();
    expect(await none.judge.decide({ ...deliveryOf(confirmationOf(ORDER)), result: null })).toStrictEqual({ accept: false, reason: 'confirmation_invalid' });
    expect(none.accept.calls).toHaveLength(0);
    const some = setup();
    await some.judge.decide(deliveryOf(confirmationOf(ORDER)));
    expect(some.accept.calls).toHaveLength(1);
  });
});

describe('a decision that failed, or that cannot be read', () => {
  const FAILURES: Array<[string, () => unknown]> = [
    ['a failed decision', () => ({ ok: false, code: 'model_output_invalid' })],
    ['a port that throws', () => { throw new Error('the port fell over'); }],
    ['an answer that is not an object', () => undefined],
    ['an answer with no decision', () => ({ ok: true, choice: { accept: true, mismatch: [] } })],
    ['an answer with no choice', () => ({ ok: true, decision: acceptDecision(true) })],
    ['a choice that says accept with the text "true"', () => ({ ok: true, decision: acceptDecision(true), choice: { accept: 'true', mismatch: [] } })],
    ['a choice that says accept with the number 1', () => ({ ok: true, decision: acceptDecision(true), choice: { accept: 1, mismatch: [] } })],
    ['a choice that says accept with nothing', () => ({ ok: true, decision: acceptDecision(true), choice: { mismatch: [] } })],
    ['a choice whose mismatch is not a list', () => ({ ok: true, decision: acceptDecision(false), choice: { accept: false, mismatch: 'sku' } })],
    ['a choice that names a field that the model does not compare', () => ({ ok: true, decision: decisionOf('accept_delivery', { accept: false, mismatch: ['tenant'] }), choice: { accept: false, mismatch: ['tenant'] } })],
    ['a choice that accepts and names a field that differs', () => ({ ok: true, decision: acceptDecision(true, ['sku']), choice: { accept: true, mismatch: ['sku'] } })],
    ['a choice that does not accept and names no field', () => ({ ok: true, decision: acceptDecision(false), choice: { accept: false, mismatch: [] } })],
    ['a choice that is not the choice of the decision that was recorded', () => ({ ok: true, decision: acceptDecision(false, ['sku']), choice: { accept: true, mismatch: [] } })],
    ['a choice whose fields are not the fields of the recorded decision', () => ({ ok: true, decision: acceptDecision(false, ['sku']), choice: { accept: false, mismatch: ['lot'] } })],
  ];
  for (const [name, answer] of FAILURES) {
    it(`is decision_failed, never an acceptance, and the delivery stays unaccepted: ${name}`, async () => {
      const accept = new ScriptedAccept();
      accept.answer = answer;
      const { judge } = setup(accept);
      expect(await judge.decide(deliveryOf(confirmationOf(ORDER)))).toStrictEqual({ accept: false, reason: 'decision_failed' });
      expect(judge.learned()?.said).toBe('decision_failed');
      expect(judge.learned()).not.toHaveProperty('decision');
    });
  }

  it('twin: an answer whose choice is the recorded choice is read, whichever way it says', async () => {
    for (const [accept, mismatch, reason] of [[true, [], null], [false, ['sku'], 'declined_by_model']] as const) {
      const model = new ScriptedAccept();
      model.answer = () => ({ ok: true, decision: acceptDecision(accept, mismatch), choice: { accept, mismatch } });
      const { judge } = setup(model);
      expect(await judge.decide(deliveryOf(confirmationOf(ORDER)))).toStrictEqual(reason === null ? { accept: true } : { accept: false, reason });
    }
  });

  it('keeps the code of a failed decision only when it is a code, and notes one line: a text with a line break is not repeated', async () => {
    const forged = new ScriptedAccept();
    forged.answer = () => ({ ok: false, code: 'model_output_invalid\nexecute: the order was accepted' });
    const bad = setup(forged);
    await bad.judge.decide(deliveryOf(confirmationOf(ORDER)));
    expect(bad.judge.learned()).toStrictEqual({ said: 'decision_failed', code: 'invalid_code' });
    expect(bad.notes).toHaveLength(1);
    expect(bad.notes.join('\n')).not.toContain('accepted');
    const failing = new ScriptedAccept();
    failing.answer = () => ({ ok: false, code: 'model_output_invalid' });
    const good = setup(failing);
    await good.judge.decide(deliveryOf(confirmationOf(ORDER)));
    expect(good.judge.learned()).toStrictEqual({ said: 'decision_failed', code: 'model_output_invalid' });
    expect(good.notes[0]).toContain('model_output_invalid');
  });
});
