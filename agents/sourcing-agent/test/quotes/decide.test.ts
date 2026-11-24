// agents/sourcing-agent/test/quotes/decide.test.ts: five checks in code come before the model. The checks refuse a result that is not a quote, a quote from another bidder, a quote for another request,
// a quote from another price list, or a receipt with no supplier key hash. Each refusal has its own failure code. None starts a challenge or asks the model. A quote that passes all five goes to the model.
// Only a no of the model starts a challenge. A decision that fails stops the loop, so the agent pays no later bidders. The Accept rests on the choice that the recorded decision holds.
import { afterEach, describe, expect, it } from 'vitest';
import type { VerifiedDelivery } from '@vsa/usecase-kit/buyer';
import { RECEIPT_CHECKS } from '@vsa/usecase-kit/protocol';
import type { JsonObject } from '@vsa/usecase-kit/protocol';
import { sha256Utf8Hex } from '@vsa/vector-read';
import { judgeQuote } from '../../src/quotes/decide.ts';
import type { Learned } from '../../src/quotes/decide.ts';
import type { QuoteOutcome } from '../../src/quotes/index.ts';
import { ALFA, BRAVO, RFQ, acceptDecision, bidderOf, decisionOf, listOf, priced, quoteDocument, quoteText, rightAnswer } from './support.ts';
import { NOTHING, cleanWorlds, footprint, words, world } from './world.ts';
import type { World } from './world.ts';

afterEach(() => { cleanWorlds(); });

/** A run of the second bidder alone, with the answer of its job given as text. */
async function bravoAnswers(text: string): Promise<{ w: World; outcome: QuoteOutcome }> {
  const w = await world();
  w.desks.bravo.answer = () => text;
  const result = await w.run(w.input({ invited: [bidderOf(BRAVO)] }));
  return { w, outcome: result.outcomes[0]! };
}

describe('the checks in code, before the model is asked', () => {
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['a text that is not a quote', 'this is not a quote', 'quote_invalid'],
    ['a quote with a total that is not the sum of its lines', JSON.stringify(quoteDocument(BRAVO, undefined, { total: 1 })), 'quote_invalid'],
    ['a quote for another request: the identifier of the request differs', JSON.stringify(quoteDocument(BRAVO, undefined, { rfq_id: 'run1-rfq-2' })), 'quote_not_for_rfq'],
    ['a quote for another request: the hash of the request differs', JSON.stringify(quoteDocument(BRAVO, undefined, { rfq_sha256: 'ee'.repeat(32) })), 'quote_not_for_rfq'],
    ['a quote with a line for an item that the request lacks', quoteText(BRAVO, [{ sku: 'XYZ-1', quantity: 100, unit_price: 5, lead_time_days: 3 }]), 'quote_not_for_rfq'],
    ['a quote from another price list', JSON.stringify(quoteDocument(BRAVO, undefined, { price_list_sha256: 'ee'.repeat(32) })), 'quote_not_from_list'],
    ['a quote that names another bidder as its desk', JSON.stringify(quoteDocument(ALFA)), 'quote_not_from_bidder'],
    ['a quote that names another organisation than the bidder', JSON.stringify(quoteDocument(BRAVO, undefined, { organisation: 'other.example.org' })), 'quote_not_from_bidder'],
  ];

  for (const [what, text, code] of CASES) {
    it(`is failed with ${code} for ${what}: the Pay was made, the model is not asked, nothing is challenged and the escrow is not accepted`, async () => {
      const { w, outcome } = await bravoAnswers(text);
      expect(words(outcome)).toBe(`excluded failed ${code}`);
      expect(w.accept.calls).toHaveLength(0);
      expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, asked: 0, challenges: 0, rechecked: 1 });
      expect(w.dispute.calls).toHaveLength(0);
      if (outcome.kind !== 'excluded' || outcome.record === null) throw new Error('the outcome of the test holds no record of the hire');
      expect(outcome).toMatchObject({ decision: null, challenge: null, record: { accepted: 'no', challenge: null } });
      expect(await w.chain.escrowState(outcome.record.escrow_ref)).toBe('Submitted');
      expect(w.booked.accepted).toBe(0);
    });
  }

  it('does not stop the loop for a quote that fails a check in code: the next bidder is hired', async () => {
    const w = await world();
    w.desks.bravo.answer = () => 'this is not a quote';
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded failed quote_invalid', 'accepted']);
    expect(result.stopped).toBeNull();
  });

  it('reports the first check that fails, in the order: a quote, the bidder, the request, the price list', async () => {
    const run = async (document: Record<string, unknown>): Promise<Learned | null> => {
      const judge = judgeQuote({ acceptQuote: async () => ({ ok: false, code: 'unused' }), note: () => undefined }, RFQ, bidderOf(BRAVO), listOf(BRAVO));
      await judge.decide(deliveryOf(JSON.stringify(document)));
      return judge.learned();
    };
    const learned = await Promise.all([
      run(quoteDocument(ALFA, undefined, { rfq_id: 'other', price_list_sha256: 'ee'.repeat(32) })),
      run(quoteDocument(BRAVO, undefined, { rfq_id: 'other', price_list_sha256: 'ee'.repeat(32) })),
      run(quoteDocument(BRAVO, undefined, { price_list_sha256: 'ee'.repeat(32) })),
      run(quoteDocument(BRAVO, undefined, { total: 1, rfq_id: 'other' })),
    ]);
    expect(learned.map((said) => said?.said)).toStrictEqual(['quote_not_from_bidder', 'quote_not_for_rfq', 'quote_not_from_list', 'quote_invalid']);
  });

  it('twin: the right quote goes to the model, with the request, the quote that the kit parsed and the price list of the bidder', async () => {
    const w = await world();
    const result = await w.run(w.input({ invited: [bidderOf(BRAVO)] }));
    expect(result.outcomes.map(words)).toStrictEqual(['accepted']);
    expect(w.accept.calls).toHaveLength(1);
    const asked = w.accept.calls[0]!;
    expect(asked.rfq).toStrictEqual(RFQ);
    expect(asked.list).toBe(listOf(BRAVO).list);
    expect(asked.quote).toStrictEqual(JSON.parse(JSON.stringify(asked.quote)));
    expect(asked.quote.desk_did).toBe(BRAVO.did);
  });

  it('twin: a bidder with no organisation on file takes a quote that names one, because the check compares an organisation only when both exist', async () => {
    const w = await world();
    const result = await w.run(w.input({ invited: [bidderOf(BRAVO, { organisation: null })] }));
    expect(result.outcomes.map(words)).toStrictEqual(['accepted']);
  });
});

describe('the model and the Accept', () => {
  it('accepts the quote when the model says yes: the outcome holds the decision that the model made, and the Accept was made', async () => {
    const w = await world();
    const result = await w.run(w.input({ invited: [bidderOf(BRAVO)] }));
    const outcome = result.outcomes[0]!;
    if (outcome.kind !== 'accepted') throw new Error('the outcome of the test is not accepted');
    expect(outcome.decision).toStrictEqual(acceptDecision(true));
    expect(await w.chain.escrowState(outcome.record.escrow_ref)).toBe('spent');
    expect(w.booked.accepted).toBe(1);
  });

  it('does not make the Accept when the model says no: the escrow stays Submitted, and the decision of the model is on record', async () => {
    const w = await world();
    w.desks.bravo.answer = () => quoteText(BRAVO, priced('SYR-10ML', 30));
    const result = await w.run(w.input({ invited: [bidderOf(BRAVO)] }));
    const outcome = result.outcomes[0]!;
    expect(words(outcome)).toBe('excluded disputed none');
    if (outcome.kind !== 'excluded' || outcome.record === null) throw new Error('the outcome of the test holds no record of the hire');
    expect(outcome.decision).toStrictEqual(acceptDecision(false, ['SYR-10ML']));
    expect(outcome.record.accepted).toBe('no');
    expect(await w.chain.escrowState(outcome.record.escrow_ref)).toBe('Submitted');
    expect(w.booked.accepted).toBe(0);
  });

  it('stops the loop when a decision fails: the bidder is excluded failed decision_failed, the code is the code of the port, and the later bidders are not paid', async () => {
    const w = await world();
    w.accept.answer = (given) => (given.quote.desk_did === BRAVO.did ? { ok: false, code: 'llm_busy' } : rightAnswer(given));
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded failed decision_failed', 'excluded failed not_attempted']);
    expect(result.stopped).toStrictEqual({ code: 'llm_busy' });
    expect(result.outcomes[1]).toMatchObject({ decision: null, challenge: null, record: { accepted: 'no' } });
    expect(result.outcomes[2]).toMatchObject({ record: null, decision: null });
    expect(w.events).toStrictEqual(['recheck alfa', 'pay alfa', 'send alfa', 'ask alfa', 'accept alfa', 'recheck bravo', 'pay bravo', 'send bravo', 'ask bravo']);
    expect(w.desks.charlie.sends).toHaveLength(0);
    expect(footprint(w).challenges).toBe(0);
  });

  it('does not stop the loop for a bidder that fails nothing: the twin of the stop', async () => {
    const w = await world();
    const result = await w.run();
    expect(result.stopped).toBeNull();
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'accepted', 'accepted']);
  });

  // The answer of the model port is read as a value of an unknown type: any answer that is not a decision is a decision that failed, and nothing is accepted.
  const BROKEN: ReadonlyArray<readonly [string, (given: Parameters<World['accept']['answer']>[0]) => unknown, string]> = [
    ['a port that throws', () => { throw new Error('the port broke'); }, 'decision_threw'],
    ['an answer that is not an object', () => 'yes', 'answer_missing'],
    ['an answer with no ok', () => ({ decision: acceptDecision(true), choice: { accept: true, mismatch: [] } }), 'answer_invalid'],
    ['an answer with no decision', () => ({ ok: true, choice: { accept: true, mismatch: [] } }), 'answer_invalid'],
    ['a choice that is no object', () => ({ ok: true, decision: acceptDecision(true), choice: 'accept' }), 'answer_invalid'],
    ['an accept that is no boolean', () => ({ ok: true, decision: decisionOf('accept_quote', { accept: 'yes', mismatch: [] }), choice: { accept: 'yes', mismatch: [] } }), 'choice_invalid'],
    ['a list of SKUs that is no list', () => ({ ok: true, decision: acceptDecision(true), choice: { accept: true, mismatch: 'none' } }), 'choice_invalid'],
    ['a list with a SKU that is no text', () => ({ ok: true, decision: decisionOf('accept_quote', { accept: false, mismatch: [7] }), choice: { accept: false, mismatch: [7] } }), 'choice_invalid'],
    ['an accept with a SKU named', () => ({ ok: true, decision: decisionOf('accept_quote', { accept: true, mismatch: ['SYR-10ML'] }), choice: { accept: true, mismatch: ['SYR-10ML'] } }), 'choice_invalid'],
    ['a no that names no SKU', () => ({ ok: true, decision: acceptDecision(false), choice: { accept: false, mismatch: [] } }), 'choice_invalid'],
    ['a choice that says yes where the recorded decision says no', () => ({ ok: true, decision: acceptDecision(false, ['SYR-10ML']), choice: { accept: true, mismatch: [] } }), 'choice_not_recorded'],
    ['a choice that says no where the recorded decision says yes', () => ({ ok: true, decision: acceptDecision(true), choice: { accept: false, mismatch: ['SYR-10ML'] } }), 'choice_not_recorded'],
    ['a choice that names another SKU than the recorded decision', () => ({ ok: true, decision: acceptDecision(false, ['SYR-10ML']), choice: { accept: false, mismatch: ['MSK-N95'] } }), 'choice_not_recorded'],
    ['a choice with a member that the recorded decision lacks', () => ({ ok: true, decision: acceptDecision(true), choice: { accept: true, mismatch: [], note: 'x' } }), 'choice_not_recorded'],
    ['a failure with a code that is no code', () => ({ ok: false, code: 'The model said: no!' }), 'invalid_code'],
    ['a failure with no code', () => ({ ok: false }), 'invalid_code'],
  ];

  for (const [what, answer, code] of BROKEN) {
    it(`stops the loop for ${what}: decision_failed with the code ${code}, nothing is accepted, and nothing is challenged`, async () => {
      const w = await world();
      w.accept.answer = (given) => (given.quote.desk_did === ALFA.did ? answer(given) : rightAnswer(given));
      const result = await w.run();
      expect(result.outcomes.map(words)).toStrictEqual(['excluded failed decision_failed', 'excluded failed not_attempted', 'excluded failed not_attempted']);
      expect(result.stopped).toStrictEqual({ code });
      expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, asked: 1, challenges: 0, rechecked: 1 });
      expect(w.booked.accepted).toBe(0);
    });
  }

  it('takes the code of a failed decision from the port when it has the form of a code', async () => {
    const w = await world();
    w.accept.answer = () => ({ ok: false, code: 'model_output_invalid' });
    const result = await w.run();
    expect(result.stopped).toStrictEqual({ code: 'model_output_invalid' });
  });

  it('twin: a choice that is the choice of the recorded decision is accepted, for a yes and for a no', async () => {
    const w = await world();
    w.accept.answer = (given) => (given.quote.desk_did === BRAVO.did ? { ok: true, decision: acceptDecision(false, ['SYR-10ML']), choice: { accept: false, mismatch: ['SYR-10ML'] } } : rightAnswer(given));
    w.desks.bravo.answer = () => quoteText(BRAVO, priced('SYR-10ML', 30));
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded disputed none', 'accepted']);
    expect(result.stopped).toBeNull();
  });

  it('asks the model with the objects that the job holds, and never with the text of the delivery', async () => {
    const w = await world();
    await w.run(w.input({ invited: [bidderOf(ALFA)] }));
    expect(Object.keys(w.accept.calls[0]!).sort()).toStrictEqual(['list', 'quote', 'rfq']);
  });

  it('makes no call for a bidder that was never hired: a run with no invitation asks nobody', async () => {
    const w = await world();
    await w.run(w.input({ invited: [] }));
    expect(footprint(w)).toStrictEqual(NOTHING);
  });
});

describe('the delivery that cannot be recorded', () => {
  it('declines a delivery whose receipt names no supplier key hash, with the code of the delivery, and does not ask the model', async () => {
    let asked = 0;
    const judge = judgeQuote({ acceptQuote: async () => { asked += 1; return { ok: false, code: 'unused' }; }, note: () => undefined }, RFQ, bidderOf(BRAVO), listOf(BRAVO));
    const delivery = deliveryOf(quoteText(BRAVO));
    const answer = await judge.decide({ ...delivery, receipt: { ...delivery.receipt, supplier_pkh: 'not a key hash' } });
    expect(answer).toStrictEqual({ accept: false, reason: 'delivery_not_recordable' });
    expect(judge.learned()).toStrictEqual({ said: 'delivery_not_recordable' });
    expect(asked).toBe(0);
  });

  it('twin: the same delivery with the key hash of the supplier goes to the model', async () => {
    let asked = 0;
    const judge = judgeQuote({
      acceptQuote: async (given) => { asked += 1; return rightAnswer(given); }, note: () => undefined,
    }, RFQ, bidderOf(BRAVO), listOf(BRAVO));
    expect(await judge.decide(deliveryOf(quoteText(BRAVO)))).toStrictEqual({ accept: true });
    expect(asked).toBe(1);
  });
});
/** A delivery that passed the eight checks, as the decision of a use case gets it. `text` is the answer of the bidder. */
function deliveryOf(text: string): VerifiedDelivery {
  let result: JsonObject | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    result = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
  } catch {
    result = null;
  }
  return {
    escrow_ref: `${'ab'.repeat(32)}#0`, advert_ref: BRAVO.advertRef, text, result,
    receipt: { escrow_ref: `${'ab'.repeat(32)}#0`, supplier_pkh: '5a'.repeat(28), response_hash: sha256Utf8Hex(text), agent_did: BRAVO.did }, receipt_signature: '9c'.repeat(64),
    verification: Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true])) as VerifiedDelivery['verification'],
  };
}
