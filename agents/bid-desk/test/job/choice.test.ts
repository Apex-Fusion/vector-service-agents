// agents/bid-desk/test/job/choice.test.ts: steps 2 to 4 of the job. The model decides `quote`. A failed decision ends the job with the code of the failure and the status of that code, and nothing is written.
// The code checks the choice against the request: at least one line, each line an item of the request (its SKU and its quantity), each SKU once. It never clamps, adds or removes a line, and it never changes
// a price: the model decides the unit prices, and the arithmetic of the kit is the only computation. A choice that no quote can hold is `model_output_invalid` BEFORE the quote is built, so the job never
// ends `internal` for a choice after the Claim. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { MAX_ITEM_QUANTITY, MAX_RFQ_ITEMS } from '@vsa/usecase-kit/bids';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { DECISION_TEXT } from '../../src/job/refusal.ts';
import type { QuoteChoice } from '../../src/job/index.ts';
import { choosing, expectCleanLog, expectNothingRecorded, makeRig, refusalOf, todayOf } from './rig.ts';
import type { Rig } from './rig.ts';
import { choiceOf, failureOf, quoteOf } from './samples.ts';

/** The job stopped at the decision or at the choice: the record and the model were reached, and nothing else. No read of the book, no credential, no record in the book. */
function expectStoppedAtDecision(rig: Rig): void {
  expect(rig.events).toStrictEqual(['take', 'decide']);
  expect(rig.credentialAsks).toHaveLength(0);
  expectNothingRecorded(rig);
}

/** `count` items with SKUs `S01`, `S02`, and so on, each with the same quantity. */
const itemsOf = (count: number, quantity: number): JsonValue => Array.from({ length: count }, (_, index) => ({ sku: `S${String(index + 1).padStart(2, '0')}`, quantity }));

/** The same SKUs as lines at one price. */
const linesOf = (count: number, quantity: number, unitPrice: number, leadTime: number): QuoteChoice['lines'] =>
  Array.from({ length: count }, (_, index) => ({ sku: `S${String(index + 1).padStart(2, '0')}`, quantity, unit_price: unitPrice, lead_time_days: leadTime }));

describe('a decision that failed', () => {
  it.each([
    ['inference_failed', 502],
    ['model_output_invalid', 502],
    ['store_write_failed', 500],
    ['internal', 500],
  ] as const)('ends the job with %s and its status %s, asks no book and no gateway, and the log names the hire', async (code, status) => {
    const rig = makeRig();
    rig.decision = failureOf(code);
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code, status, kind: 'job', message: DECISION_TEXT[code] });
    expectStoppedAtDecision(rig);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain(`${code}: the decision quote failed`);
    expect(rig.logs[0]).toContain('llm_timeout');
    expect(rig.logs[0]).toContain('poll');
  });

  it('twin: the model that answers passes, and the job gives the quote', async () => {
    const rig = makeRig();
    expect(await rig.run()).toMatchObject({ outcome: 'done' });
    expect(rig.booked).toHaveLength(1);
  });

  it('says in the log that the model supplier was paid when the failure carries a delivery', async () => {
    const rig = makeRig();
    rig.decision = failureOf('model_output_invalid', {
      reason: 'model_output_invalid', stage: 'accept', escrow_ref: `${'4c'.repeat(32)}#0`,
      delivery: { sub_job: null, receipt: 'not_recordable', accepted: 'confirmed', escrow_ref: null, advert_ref: null, supplier_pkh: null, verification: null },
    });
    await refusalOf(rig.run());
    expect(rig.logs[0]).toContain('the model supplier may be paid (accepted confirmed)');
    expect(rig.logs[0]).toContain(`escrow ${'4c'.repeat(32)}#0`);
  });

  it('gives a text with no detail of the failure to the buyer: the code and the stage stay in the log, and the detail stays out of both', async () => {
    const rig = makeRig();
    rig.decision = failureOf('inference_failed', { detail: 'DETAIL-OF-THE-HIRE: the supplier said a thing' });
    const refusal = await refusalOf(rig.run());
    for (const text of [refusal.message, ...rig.logs]) expect(text).not.toContain('DETAIL-OF-THE-HIRE');
    expect(refusal.message).not.toContain('llm_timeout');
    expect(refusal.message).not.toContain('poll');
  });

  it.each([
    ['no result: undefined', undefined],
    ['no result: null', null],
    ['a failure with no code', { ok: false }],
    ['a failure with a code that is no code of a failed decision', { ...failureOf('internal'), code: 'precheck_missing' }],
    ['a result whose ok is the text true', { ok: 'true', value: {} }],
  ])('ends the job with internal (500) for %s, and asks no book and no gateway', async (_what, result) => {
    const rig = makeRig();
    rig.decision = result as never;
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'internal', status: 500, message: DECISION_TEXT.internal });
    expectStoppedAtDecision(rig);
  });
});

describe('the date of today', () => {
  it('is the date of the clock in UTC, for the model', async () => {
    const rig = makeRig({ deliverInMs: 40 * 86_400_000 });
    rig.now = Date.UTC(2026, 11, 31, 23, 59, 59);
    await rig.run();
    expect(todayOf(rig.decideInputs[0])).toBe('2026-12-31');
  });

  it.each([
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['a time that no date has', 8.64e15 + 1],
    ['a text', '2026-11-24'],
    ['null', null],
  ])('ends the job with internal for a clock that gives %s, before the model is hired', async (_what, now) => {
    const rig = makeRig();
    rig.now = now as number;
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'internal', status: 500 });
    expect(rig.events).toStrictEqual(['take']);
    expect(rig.decideInputs).toHaveLength(0);
    expectNothingRecorded(rig);
    expect(rig.logs[0]).toContain('clock');
  });
});

describe('the choice and the request', () => {
  const threeItems = { items: [{ sku: 'GLV-NIT-M', quantity: 100 }, { sku: 'SYR-10ML', quantity: 250 }, { sku: 'MSK-N95', quantity: 40 }] };
  const [glove, syringe, mask] = choiceOf().lines;

  const bad: ReadonlyArray<readonly [string, QuoteChoice, Record<string, JsonValue>]> = [
    ['no line', choiceOf({ lines: [] }), threeItems],
    ['a line for an item that the request lacks', choiceOf(), { items: [{ sku: 'GLV-NIT-M', quantity: 100 }, { sku: 'SYR-10ML', quantity: 250 }] }],
    ['a line for a SKU that no request holds', choiceOf({ lines: [glove!, { sku: 'NO-SUCH-SKU', quantity: 5, unit_price: 10, lead_time_days: 1 }] }), threeItems],
    ['a line with the quantity of another item', choiceOf({ lines: [{ ...glove!, quantity: 250 }] }), threeItems],
    ['a line with a quantity that is not the quantity of its item', choiceOf({ lines: [{ ...glove!, quantity: 99 }, syringe!] }), threeItems],
    ['a SKU two times with the quantity of its item', choiceOf({ lines: [glove!, syringe!, { ...glove! }] }), threeItems],
    ['a SKU two times at two prices', choiceOf({ lines: [glove!, { ...glove!, unit_price: 90 }] }), threeItems],
  ];

  it.each(bad)('ends with model_output_invalid (502) for %s: the choice is not changed, no quote is made, and nothing is written', async (_what, choice, rfq) => {
    const rig = makeRig({ rfq });
    choosing(rig, choice);
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'model_output_invalid', status: 502, kind: 'job', message: DECISION_TEXT.model_output_invalid });
    expectStoppedAtDecision(rig);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('model_output_invalid');
    expect(rig.logs[0]).not.toContain('NO-SUCH-SKU');
    expectCleanLog(rig.logs);
  });

  it('twin: a choice that is a line for each item passes', async () => {
    const rig = makeRig();
    expect(await rig.run()).toMatchObject({ outcome: 'done' });
  });

  it('never adds a line: a model that leaves an item out gives a quote without it, with the totals of the lines that it gave', async () => {
    const rig = makeRig();
    choosing(rig, choiceOf({ lines: [glove!, syringe!], notes: 'MSK-N95 is not on the list.' }));
    const quote = await rig.run();
    expect(quote.lines.map((line) => line.sku)).toStrictEqual(['GLV-NIT-M', 'SYR-10ML']);
    expect(quote.total).toBe(12_500 + 8_750);
    expect(quote.lead_time_days).toBe(14);
    expect(quote.notes).toBe('MSK-N95 is not on the list.');
  });

  it('never removes a line: a line for an item that the list does not carry stays, with the price of the model', async () => {
    const rig = makeRig({ rfq: { items: [{ sku: 'GLV-NIT-M', quantity: 100 }, { sku: 'NOT-LISTED-1', quantity: 5 }] } });
    choosing(rig, choiceOf({ lines: [glove!, { sku: 'NOT-LISTED-1', quantity: 5, unit_price: 77, lead_time_days: 3 }] }));
    const quote = await rig.run();
    expect(quote.lines).toStrictEqual([
      { sku: 'GLV-NIT-M', quantity: 100, unit_price: 125, line_total: 12_500, lead_time_days: 14 },
      { sku: 'NOT-LISTED-1', quantity: 5, unit_price: 77, line_total: 385, lead_time_days: 3 },
    ]);
  });

  it.each([
    ['a price below the list', 90],
    ['a price above the list', 200],
    ['the price 1', 1],
    ['the highest price', 1_000_000],
  ])('never changes a price: %s is the unit price of the line, and the totals follow it', async (_what, price) => {
    const rig = makeRig();
    choosing(rig, choiceOf({ lines: [{ ...glove!, unit_price: price }, syringe!, mask!] }));
    const quote = await rig.run();
    expect(quote.lines[0]).toMatchObject({ unit_price: price, line_total: 100 * price });
    expect(quote.total).toBe(100 * price + 8_750 + 2_360);
  });

  it('keeps the order of the lines of the model, and not the order of the request', async () => {
    const rig = makeRig();
    choosing(rig, choiceOf({ lines: [mask!, glove!, syringe!] }));
    expect((await rig.run()).lines.map((line) => line.sku)).toStrictEqual(['MSK-N95', 'GLV-NIT-M', 'SYR-10ML']);
  });

  it('keeps the lead time that the model chose for each line, and the quote takes the longest', async () => {
    const rig = makeRig();
    choosing(rig, choiceOf({ lines: [{ ...glove!, lead_time_days: 0 }, { ...syringe!, lead_time_days: 365 }, { ...mask!, lead_time_days: 3 }] }));
    const quote = await rig.run();
    expect(quote.lines.map((line) => line.lead_time_days)).toStrictEqual([0, 365, 3]);
    expect(quote.lead_time_days).toBe(365);
  });

  it('gives the valid_until and the notes of the model as they are', async () => {
    const rig = makeRig();
    choosing(rig, choiceOf({ valid_until: '2027-02-28', notes: 'Prices hold for three months.' }));
    expect(await rig.run()).toMatchObject({ valid_until: '2027-02-28', notes: 'Prices hold for three months.' });
  });
});

describe('a choice that no quote can hold', () => {
  const [glove, syringe, mask] = choiceOf().lines;
  const withFirst = (over: Record<string, unknown>): QuoteChoice => choiceOf({ lines: [{ ...glove!, ...over }, syringe!, mask!] });
  const HIDDEN: ReadonlyArray<readonly [string, string]> = [
    ['a null character', 'a\u0000b'],
    ['a line feed', 'one\ntwo'],
    ['a zero width space', 'a\u200bb'],
    ['a right to left override', 'a\u202eb'],
    ['a line separator', 'a\u2028b'],
    ['a variation selector', 'a\ufe0fb'],
    ['a tag character', 'a\u{e0041}b'],
    ['a surrogate that stands alone', 'a\ud800b'],
  ];

  const bad: ReadonlyArray<readonly [string, QuoteChoice]> = [
    ['a unit price of 0', withFirst({ unit_price: 0 })],
    ['a unit price above the limit', withFirst({ unit_price: 1_000_001 })],
    ['a unit price with a fraction', withFirst({ unit_price: 12.5 })],
    ['a unit price that is a text', withFirst({ unit_price: '125' })],
    ['a lead time below 0', withFirst({ lead_time_days: -1 })],
    ['a lead time above 365 days', withFirst({ lead_time_days: 366 })],
    ['a quantity of 0', withFirst({ quantity: 0 })],
    ['a line with a member more', withFirst({ line_total: 12_500 })],
    ['a valid_until that does not exist', choiceOf({ valid_until: '2026-02-30' })],
    ['notes of 501 characters', choiceOf({ notes: 'n'.repeat(501) })],
    ['notes that NFC makes longer than 500 characters', choiceOf({ notes: `${'x'.repeat(499)}\u0958` })],
    ...HIDDEN.map(([what, notes]) => [`notes with ${what}`, choiceOf({ notes })] as const),
  ];

  it.each(bad)('ends with model_output_invalid, and never with internal, for %s: no quote is built and nothing is written', async (_what, choice) => {
    const rig = makeRig();
    choosing(rig, choice);
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'model_output_invalid', status: 502, message: DECISION_TEXT.model_output_invalid });
    expectStoppedAtDecision(rig);
    expectCleanLog(rig.logs);
  });

  it.each([
    ['a unit price of 1', withFirst({ unit_price: 1 })],
    ['a unit price at the limit', withFirst({ unit_price: 1_000_000 })],
    ['a lead time of 0', withFirst({ lead_time_days: 0 })],
    ['a lead time of 365 days', withFirst({ lead_time_days: 365 })],
    ['notes of 500 characters', choiceOf({ notes: 'n'.repeat(500) })],
    ['notes that NFC makes 500 characters long', choiceOf({ notes: `${'x'.repeat(498)}\u0958` })],
    ['a valid_until on 29 February of a leap year', choiceOf({ valid_until: '2028-02-29' })],
  ])('twin: %s passes', async (_what, choice) => {
    const rig = makeRig();
    choosing(rig, choice);
    expect(await rig.run()).toMatchObject({ outcome: 'done' });
  });

  it('refuses every choice that the parser of the quote would refuse, and passes every choice that it takes: the job and the kit agree', async () => {
    for (const [what, choice] of [...bad.slice(0, 11), ['the sample choice', choiceOf()] as const]) {
      const rig = makeRig();
      choosing(rig, choice);
      const draft = quoteOf(choice);
      const passes = draft !== null && (await rig.run().then(() => true, () => false));
      expect(passes, what).toBe(what === 'the sample choice');
    }
  });
});

describe('the arithmetic', () => {
  /** The three numbers by plain arithmetic: the sum of quantity times unit price for each line, and the longest lead time. */
  const arithmetic = (lines: QuoteChoice['lines']): { totals: number[]; total: number; lead: number } => ({
    totals: lines.map((line) => line.quantity * line.unit_price),
    total: lines.reduce((sum, line) => sum + line.quantity * line.unit_price, 0),
    lead: Math.max(...lines.map((line) => line.lead_time_days)),
  });

  const requests: ReadonlyArray<readonly [string, QuoteChoice['lines']]> = [
    ['the sample prices', choiceOf().lines],
    ['lower prices', [{ sku: 'GLV-NIT-M', quantity: 100, unit_price: 90, lead_time_days: 14 }, { sku: 'SYR-10ML', quantity: 250, unit_price: 30, lead_time_days: 9 }, { sku: 'MSK-N95', quantity: 40, unit_price: 50, lead_time_days: 20 }]],
    ['higher prices', [{ sku: 'GLV-NIT-M', quantity: 100, unit_price: 210, lead_time_days: 1 }, { sku: 'SYR-10ML', quantity: 250, unit_price: 55, lead_time_days: 2 }, { sku: 'MSK-N95', quantity: 40, unit_price: 99, lead_time_days: 3 }]],
    ['one line', [{ sku: 'SYR-10ML', quantity: 250, unit_price: 35, lead_time_days: 9 }]],
    ['the price 1 and the lead time 0', [{ sku: 'GLV-NIT-M', quantity: 100, unit_price: 1, lead_time_days: 0 }, { sku: 'SYR-10ML', quantity: 250, unit_price: 1, lead_time_days: 0 }]],
  ];

  it.each(requests)('gives each line total, the total and the longest lead time of the lines as plain arithmetic: %s', async (_what, lines) => {
    const rig = makeRig();
    choosing(rig, choiceOf({ lines }));
    const quote = await rig.run();
    const expected = arithmetic(lines);
    expect(quote.lines.map((line) => line.line_total)).toStrictEqual(expected.totals);
    expect(quote.total).toBe(expected.total);
    expect(quote.lead_time_days).toBe(expected.lead);
    expect(quote.lines.map((line) => [line.sku, line.quantity, line.unit_price, line.lead_time_days])).toStrictEqual(lines.map((line) => [line.sku, line.quantity, line.unit_price, line.lead_time_days]));
  });

  it('holds for the largest quote: 20 lines of the most units at the highest price, in a sum that a number holds exactly', async () => {
    const lines = linesOf(MAX_RFQ_ITEMS, MAX_ITEM_QUANTITY, 1_000_000, 365);
    const rig = makeRig({ rfq: { items: itemsOf(MAX_RFQ_ITEMS, MAX_ITEM_QUANTITY) } });
    choosing(rig, choiceOf({ lines }));
    const quote = await rig.run();
    expect(quote.total).toBe(20 * 1_000_000 * 1_000_000);
    expect(Number.isSafeInteger(quote.total)).toBe(true);
    expect(quote.lines.every((line) => line.line_total === 1_000_000_000_000)).toBe(true);
  });
});
