// agents/sourcing-agent/test/quotes/challenge.test.ts: the challenge of a quote that the model did not accept. It is filed only after a recorded no of the model, with the facts of a line that the model named and whose unit
// price is not the listed price, against the claim of that bidder. The model names SKUs; the code reads each name as a line of the quote. A name that is no line, a line with no listed price and a line at the listed
// price give no evidence, so no challenge is made, and the decision stays on record. A challenge that is not filed gives its code, and a challenge that throws is `port_error`. Each form has its twin.
import { afterEach, describe, expect, it } from 'vitest';
import { BID_CAPABILITIES, BID_DESK_CLAIM } from '@vsa/usecase-kit/bids';
import { sha256Utf8Hex } from '@vsa/vector-read';
import { CHALLENGE_CODES } from '../../src/quotes/ports.ts';
import type { BidderToHire, QuotesResult } from '../../src/quotes/index.ts';
import { BRAVO, CHALLENGE, LIST_SHA, acceptDecision, bidderOf, challengeFiled, challengeNotFiled, listOf, listedLines, priced, quoteText, rightAnswer } from './support.ts';
import type { Chosen } from './support.ts';
import { BUYER_PKH, cleanWorlds, footprint, hired, words, world } from './world.ts';
import type { World } from './world.ts';

afterEach(() => { cleanWorlds(); });

/** The lines of the request with the unit price of each SKU that `over` names changed. */
const lines = (over: Readonly<Record<string, number>>): readonly Chosen[] => listedLines(BRAVO).map((line) => ({ ...line, unit_price: over[line.sku] ?? line.unit_price }));

/** A model that holds the SKUs `named` to differ, whatever the prices are, and gives the decision for that no. */
const naming = (named: readonly string[]) => () => ({ ok: true, decision: acceptDecision(false, named), choice: { accept: false, mismatch: [...named] } });

/** The second bidder quotes `chosen`, and the model says what `answer` says. The bidder is hired alone. */
async function declined(chosen: readonly Chosen[], named: readonly string[] | null = null, bidder: BidderToHire = bidderOf(BRAVO)): Promise<{ w: World; text: string; result: QuotesResult }> {
  const w = await world();
  const text = quoteText(BRAVO, chosen);
  w.desks.bravo.answer = () => text;
  if (named !== null) w.accept.answer = naming(named);
  return { w, text, result: await w.run(w.input({ invited: [bidder] })) };
}

describe('a challenge with the facts of the line that the model named', () => {
  it('files the challenge against the bidder with the first statement of its claim, the capability of the quote, the delegation key as the buyer, and the facts of the line that differs', async () => {
    const { w, text, result } = await declined(priced('SYR-10ML', 30));
    expect(result.outcomes.map(words)).toStrictEqual(['excluded disputed none']);
    const outcome = hired(result.outcomes, 0);
    expect(w.dispute.calls).toStrictEqual([{
      counterparty: BRAVO.did, escrow_ref: outcome.record.escrow_ref, capability_id: BID_CAPABILITIES.quote, statement_text: BID_DESK_CLAIM.statements[0].text, buyer_pkhs: [BUYER_PKH],
      evidence: { kind: 'quote_price', sku: 'SYR-10ML', quantity: 250, quoted_unit_price: 30, listed_unit_price: 36, price_list_sha256: listOf(BRAVO).sha256, quote_sha256: sha256Utf8Hex(text) },
    }]);
    // The hash of the quote is the hash that the receipt commits to for the text of the delivery.
    expect(outcome.record.receipt?.response_hash).toBe(sha256Utf8Hex(text));
    expect(outcome.challenge).toStrictEqual(CHALLENGE);
    expect(outcome.record).toMatchObject({ accepted: 'no', challenge: CHALLENGE });
    expect(outcome.decision).toStrictEqual(acceptDecision(false, ['SYR-10ML']));
    expect(await w.chain.escrowState(outcome.record.escrow_ref)).toBe('Submitted');
    expect(w.booked.accepted).toBe(0);
  });

  it('builds an evidence document that the real function of the kit accepts, and that names the quoted price and the listed price', async () => {
    const { w } = await declined(priced('SYR-10ML', 30));
    const document = w.dispute.documents[0]!;
    if (!document.ok) throw new Error(`the evidence document of the test is refused: ${document.code}`);
    expect(document.value.text).toContain('The bid desk quoted the unit price 30 for the SKU "SYR-10ML" at the quantity 250.');
    expect(document.value.text).toContain('The published price list of the bid desk gives the unit price 36 for the SKU "SYR-10ML" at the quantity 250.');
  });

  it('takes a quoted price above the listed price as evidence too', async () => {
    const { w, result } = await declined(priced('SYR-10ML', 44));
    expect(result.outcomes.map(words)).toStrictEqual(['excluded disputed none']);
    expect(w.dispute.calls[0]?.evidence).toMatchObject({ sku: 'SYR-10ML', quoted_unit_price: 44, listed_unit_price: 36 });
  });

  it('takes the line that the model named and not the line that the quote has first: a line that differs and is not named is never the evidence', async () => {
    const { w, result } = await declined(lines({ 'GLV-NIT-M': 120, 'SYR-10ML': 30 }), ['SYR-10ML']);
    expect(result.outcomes.map(words)).toStrictEqual(['excluded disputed none']);
    expect(w.dispute.calls).toHaveLength(1);
    expect(w.dispute.calls[0]?.evidence).toMatchObject({ sku: 'SYR-10ML', quoted_unit_price: 30, listed_unit_price: 36 });
  });

  it('takes the first line of the quote that the model named, whatever the order of the names is', async () => {
    for (const named of [['GLV-NIT-M', 'SYR-10ML'], ['SYR-10ML', 'GLV-NIT-M']]) {
      const { w } = await declined(lines({ 'GLV-NIT-M': 120, 'SYR-10ML': 30 }), named);
      expect(w.dispute.calls).toHaveLength(1);
      expect(w.dispute.calls[0]?.evidence).toMatchObject({ sku: 'GLV-NIT-M', quoted_unit_price: 120, listed_unit_price: 128 });
    }
  });

  it('takes the first named line whose price differs: a named line at the listed price is passed over', async () => {
    const { w } = await declined(priced('SYR-10ML', 30), ['GLV-NIT-M', 'SYR-10ML']);
    expect(w.dispute.calls[0]?.evidence).toMatchObject({ sku: 'SYR-10ML' });
  });

  it('takes the price list of the bidder whose quote was not accepted, and no other list: Bravo has its own list, and its quote at the price that the other two list is the evidence', async () => {
    const w = await world();
    // Alfa and Charlie list 125 for GLV-NIT-M at 100. Bravo lists 128, so its quote at 125 breaks its own list, and the model, which reads the list of the bidder, names the line.
    w.desks.bravo.answer = () => quoteText(BRAVO, lines({ 'GLV-NIT-M': 125 }));
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded disputed none', 'accepted']);
    expect(w.accept.calls[1]?.list).toBe(listOf(BRAVO).list);
    expect(w.dispute.calls).toHaveLength(1);
    expect(w.dispute.calls[0]?.evidence).toMatchObject({ sku: 'GLV-NIT-M', quoted_unit_price: 125, listed_unit_price: 128, price_list_sha256: listOf(BRAVO).sha256 });
    expect(listOf(BRAVO).sha256).not.toBe(LIST_SHA);
  });

  it('twin: a model that accepts files no challenge', async () => {
    const { w, result } = await declined(lines({}));
    expect(result.outcomes.map(words)).toStrictEqual(['accepted']);
    expect(w.dispute.calls).toHaveLength(0);
  });
});

describe('no evidence, so no challenge', () => {
  const NO_EVIDENCE: ReadonlyArray<readonly [string, readonly Chosen[], readonly string[]]> = [
    ['a SKU that is no line of the quote', priced('SYR-10ML', 30), ['XYZ-9']],
    ['a SKU that is no line of the quote, named with a line that differs', priced('SYR-10ML', 30), ['SYR-10ML', 'XYZ-9']],
    ['a line at the listed price', lines({}), ['GLV-NIT-M']],
    ['a line at the listed price, while another line differs and is not named', priced('SYR-10ML', 30), ['GLV-NIT-M']],
    ['a name that is a SKU of a member of the prototype', priced('SYR-10ML', 30), ['constructor']],
  ];
  for (const [what, chosen, named] of NO_EVIDENCE) {
    it(`makes no challenge for ${what}: excluded disputed no_evidence, the decision of the model stays on record, and the escrow is not accepted`, async () => {
      const { w, result } = await declined(chosen, named);
      expect(words(result.outcomes[0]!)).toBe('excluded disputed no_evidence');
      expect(w.dispute.calls).toHaveLength(0);
      const outcome = hired(result.outcomes, 0);
      expect(outcome).toMatchObject({ challenge: null, record: { accepted: 'no', challenge: null } });
      expect(outcome.decision).toStrictEqual(acceptDecision(false, named));
      expect(await w.chain.escrowState(outcome.record.escrow_ref)).toBe('Submitted');
      expect(footprint(w).challenges).toBe(0);
    });
  }

  it('makes no challenge for a line that the price list does not price: the line has no listed price', async () => {
    const own = listOf(BRAVO);
    const withoutMask = { ...own.list, items: own.list.items.filter((entry) => entry.sku !== 'MSK-N95') };
    const { w, result } = await declined(lines({}), ['MSK-N95'], bidderOf(BRAVO, { price_list: { list: withoutMask, sha256: own.sha256 } }));
    expect(words(result.outcomes[0]!)).toBe('excluded disputed no_evidence');
    expect(w.dispute.calls).toHaveLength(0);
  });

  it('makes no challenge when the model says no and names nothing', async () => {
    // A no that names no SKU contradicts itself, and the decision is read as a decision that failed: it stops the loop and files nothing.
    const { w, result } = await declined(priced('SYR-10ML', 30), []);
    expect(words(result.outcomes[0]!)).toBe('excluded failed decision_failed');
    expect(result.stopped).toStrictEqual({ code: 'choice_invalid' });
    expect(w.dispute.calls).toHaveLength(0);
  });

  it('twin: the model that names the line that differs gets the challenge filed', async () => {
    const { w } = await declined(priced('SYR-10ML', 30), ['SYR-10ML']);
    expect(w.dispute.calls).toHaveLength(1);
  });
});

describe('a challenge that is not filed', () => {
  it('is excluded disputed no_open_claim when the bidder has no open claim: the decision stays on record, and the record holds no challenge', async () => {
    const w = await world();
    w.desks.bravo.answer = () => quoteText(BRAVO, priced('SYR-10ML', 30));
    w.dispute.answer = () => challengeNotFiled('no_open_claim');
    const result = await w.run(w.input({ invited: [bidderOf(BRAVO)] }));
    expect(words(result.outcomes[0]!)).toBe('excluded disputed no_open_claim');
    expect(hired(result.outcomes, 0)).toMatchObject({ challenge: null, record: { accepted: 'no', challenge: null } });
    expect(hired(result.outcomes, 0).decision).toStrictEqual(acceptDecision(false, ['SYR-10ML']));
    expect(w.log.some((line) => line.includes('challenge not filed (no_open_claim), nothing landed'))).toBe(true);
    expect(result.stopped).toBeNull();
  });

  for (const code of CHALLENGE_CODES) {
    it(`is excluded disputed ${code} when the challenge gives that code, and the next bidder is hired`, async () => {
      const w = await world();
      w.desks.bravo.answer = () => quoteText(BRAVO, priced('SYR-10ML', 30));
      w.dispute.answer = () => challengeNotFiled(code, code === 'evidence_not_confirmed' ? { sent: { tx_hash: 'ab'.repeat(32), may_land: true, valid_to: 1_790_000_300_000 } } : {});
      const result = await w.run();
      expect(result.outcomes.map(words)).toStrictEqual(['accepted', `excluded disputed ${code}`, 'accepted']);
      expect(hired(result.outcomes, 1).challenge).toBeNull();
      if (code === 'evidence_not_confirmed') expect(w.log.some((line) => line.includes('may land true'))).toBe(true);
    });
  }

  it('turns a code that a challenge of a quote cannot give into port_error: the codes of the evidence of the other use cases, and a code that the dispute folder does not have', async () => {
    for (const code of ['confirmation_not_for_order', 'record_not_for_request', 'because_i_said_so']) {
      const w = await world();
      w.desks.bravo.answer = () => quoteText(BRAVO, priced('SYR-10ML', 30));
      w.dispute.answer = () => challengeNotFiled(code as never);
      const result = await w.run(w.input({ invited: [bidderOf(BRAVO)] }));
      expect(words(result.outcomes[0]!)).toBe('excluded disputed port_error');
    }
  });

  it('is excluded disputed port_error when the challenge throws, and the log says that a transaction may have landed', async () => {
    const w = await world();
    w.desks.bravo.answer = () => quoteText(BRAVO, priced('SYR-10ML', 30));
    w.dispute.failWith = new Error('the chain port broke');
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded disputed port_error', 'accepted']);
    expect(hired(result.outcomes, 1)).toMatchObject({ challenge: null, record: { challenge: null } });
    expect(hired(result.outcomes, 1).decision).toStrictEqual(acceptDecision(false, ['SYR-10ML']));
    expect(w.log.some((line) => line.includes('a transaction may have landed'))).toBe(true);
    expect(w.log.some((line) => line.includes('the chain port broke'))).toBe(false);
    expect(result.stopped).toBeNull();
  });

  it('is excluded disputed port_error when the challenge is filed and its record is not a record: the log says so, and the result holds no challenge', async () => {
    const w = await world();
    w.desks.bravo.answer = () => quoteText(BRAVO, priced('SYR-10ML', 30));
    w.dispute.answer = () => {
      const filed = challengeFiled();
      return { ok: true, value: { ...filed.value, record: { claim: 'not a reference', evidence: 'x', challenge: 'y' } } };
    };
    const result = await w.run(w.input({ invited: [bidderOf(BRAVO)] }));
    expect(words(result.outcomes[0]!)).toBe('excluded disputed port_error');
    expect(hired(result.outcomes, 0).challenge).toBeNull();
    expect(w.log.some((line) => line.includes('its record is not in the form of a record'))).toBe(true);
  });

  it('twin: a challenge that is filed gives its record, and the code is null', async () => {
    const { result } = await declined(priced('SYR-10ML', 30));
    expect(hired(result.outcomes, 0)).toMatchObject({ code: null, challenge: CHALLENGE });
  });
});

describe('the challenge follows the decision of the model only', () => {
  it('files no challenge for a quote that failed a check in code, and none for a decision that failed: the model said no to neither', async () => {
    const w = await world();
    w.desks.bravo.answer = () => quoteText(BRAVO, priced('SYR-10ML', 30), { price_list_sha256: 'ee'.repeat(32) });
    w.desks.charlie.answer = () => quoteText(BRAVO, priced('SYR-10ML', 30));
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded failed quote_not_from_list', 'excluded failed quote_not_from_bidder']);
    expect(w.dispute.calls).toHaveLength(0);
    const failing = await world();
    failing.desks.bravo.answer = () => quoteText(BRAVO, priced('SYR-10ML', 30));
    failing.accept.answer = (given) => (given.quote.desk_did === BRAVO.did ? { ok: false, code: 'llm_busy' } : rightAnswer(given));
    const stopped = await failing.run();
    expect(stopped.outcomes.map(words)).toStrictEqual(['accepted', 'excluded failed decision_failed', 'excluded failed not_attempted']);
    expect(failing.dispute.calls).toHaveLength(0);
  });
});
