// agents/bid-desk/test/job/fault-run.test.ts: the fault of the Bid Desk in the job. With the value `quote_off_price_list` the first line that the price list prices has a unit price below the list, the totals
// follow the changed line, and the quote says `fault_mode: "quote_off_price_list"`. With the empty setting nothing changes. The fault changes the line and never a check. The questions: is the fault ever on
// with an empty setting? Can a quote leave with totals that are not the arithmetic of its lines? Is the fault value missing from the result? Is it in the log?
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lineChecks, parseQuote, priceFor, quotePriceFacts } from '@vsa/usecase-kit/bids';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { runQuote } from '../../src/job/index.ts';
import type { QuoteChoice } from '../../src/job/index.ts';
import { choosing, expectCleanLog, expectNothingRecorded, makeRig, refusalOf } from './rig.ts';
import { PRICE_LIST, PRICE_LIST_SHA256, T0, choiceOf, hashOf, priceListOf } from './samples.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

const golden = (name: string): unknown => JSON.parse(readFileSync(new URL(`./golden/${name}.json`, import.meta.url), 'utf8'));

/** The choice of a model that follows the list for these items: one line for each, at the listed price of its break. */
function followingList(items: ReadonlyArray<readonly [string, number]>): QuoteChoice {
  return choiceOf({
    lines: items.map(([sku, quantity]) => {
      const listed = priceFor(PRICE_LIST, sku, quantity);
      if (listed === null) throw new Error(`the sample list does not price ${sku}`);
      return { sku, quantity, unit_price: listed.unit_price, lead_time_days: listed.lead_time_days };
    }),
  });
}

describe('the fault on', () => {
  it('gives the quote of the golden file: the first line is below the list, and the totals follow it', async () => {
    const quote = await makeRig({ mode: 'quote_off_price_list' }).run();
    expect(quote).toStrictEqual(golden('quote-off-list'));
    expect(parseQuote(quote)).toStrictEqual({ ok: true, value: quote });
  });

  it('says the fault in the quote: fault_mode is quote_off_price_list, and it is the last member', async () => {
    const quote = await makeRig({ mode: 'quote_off_price_list' }).run();
    expect(quote.fault_mode).toBe('quote_off_price_list');
    expect(Object.keys(quote).at(-1)).toBe('fault_mode');
  });

  it('changes the first line and the three numbers that follow it, and nothing else of the quote', async () => {
    const clean = await makeRig().run();
    const faulty = await makeRig({ mode: 'quote_off_price_list' }).run();
    expect(faulty.lines[0]).toStrictEqual({ sku: 'GLV-NIT-M', quantity: 100, unit_price: 100, line_total: 10_000, lead_time_days: 14 });
    expect(faulty.lines.slice(1)).toStrictEqual(clean.lines.slice(1));
    expect(faulty.total).toBe(clean.total - 2_500);
    expect(faulty.total).toBe(faulty.lines.reduce((sum, line) => sum + line.quantity * line.unit_price, 0));
    expect(faulty.lead_time_days).toBe(clean.lead_time_days);
    const { lines: _lines, total: _total, fault_mode: _mode, ...rest } = faulty;
    const { lines: _cleanLines, total: _cleanTotal, fault_mode: _cleanMode, ...cleanRest } = clean;
    expect(rest).toStrictEqual(cleanRest);
  });

  it('keeps the decision on record as the model gave it: the model chose the listed price, and the line is below it', async () => {
    const quote = await makeRig({ mode: 'quote_off_price_list' }).run();
    expect(quote.decisions[0]?.choice).toStrictEqual(choiceOf());
    expect(quote.lines[0]?.unit_price).toBeLessThan(choiceOf().lines[0]!.unit_price);
  });

  it('shows the fault to the checks of the kit: the first line is off the list, the other lines are on it, and the facts of a challenge exist for the first line only', async () => {
    const quote = await makeRig({ mode: 'quote_off_price_list' }).run();
    const checks = lineChecks(quote, PRICE_LIST);
    expect(checks.map((check) => [check.sku, check.quoted_unit_price, check.listed_unit_price])).toStrictEqual([
      ['GLV-NIT-M', 100, 125],
      ['SYR-10ML', 35, 35],
      ['MSK-N95', 59, 59],
    ]);
    const facts = checks.map((line) => quotePriceFacts({ line, price_list_sha256: PRICE_LIST_SHA256, quote_sha256: hashOf(quote) }));
    expect(facts.map((result) => result.ok)).toStrictEqual([true, false, false]);
  });

  it('takes the faulty price of the LISTED price, and not of the price that the model chose', async () => {
    for (const chosen of [125, 90, 200, 100]) {
      const rig = makeRig({ mode: 'quote_off_price_list' });
      choosing(rig, choiceOf({ lines: [{ ...choiceOf().lines[0]!, unit_price: chosen }] }));
      const quote = await rig.run();
      expect(quote.lines[0]?.unit_price, String(chosen)).toBe(100);
      expect(quote.total).toBe(10_000);
    }
  });

  it('leaves a line before the first priced line as the model chose it, and changes the first line that the list prices', async () => {
    const rig = makeRig({ mode: 'quote_off_price_list', rfq: { items: [{ sku: 'NOT-LISTED-1', quantity: 5 }, { sku: 'SYR-10ML', quantity: 250 }] } });
    choosing(rig, choiceOf({ lines: [{ sku: 'NOT-LISTED-1', quantity: 5, unit_price: 77, lead_time_days: 3 }, { sku: 'SYR-10ML', quantity: 250, unit_price: 35, lead_time_days: 9 }] }));
    const quote = await rig.run();
    expect(quote.lines.map((line) => line.unit_price)).toStrictEqual([77, 28]);
    expect(quote.total).toBe(5 * 77 + 250 * 28);
  });

  const requests: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]> = [
    ['three items at the second break', [['GLV-NIT-M', 100], ['SYR-10ML', 250], ['MSK-N95', 40]]],
    ['one item at the first break', [['SYR-10ML', 1]]],
    ['one item at the highest break', [['MSK-N95', 5_000]]],
    ['two items on the edge of a break', [['GLV-NIT-M', 50], ['MSK-N95', 25]]],
    ['an item and the quantity just below a break', [['GLV-NIT-M', 499], ['SYR-10ML', 999]]],
  ];

  it.each(requests)('gives a first line below the list and no other change, with totals that are the arithmetic of the lines: %s', async (_what, items) => {
    const rig = makeRig({ mode: 'quote_off_price_list', rfq: { items: items.map(([sku, quantity]) => ({ sku, quantity })) } });
    choosing(rig, followingList(items));
    const quote = await rig.run();
    const checks = lineChecks(quote, PRICE_LIST);
    expect(checks.filter((check) => check.quoted_unit_price !== check.listed_unit_price)).toHaveLength(1);
    expect(checks[0]!.quoted_unit_price).toBeLessThan(checks[0]!.listed_unit_price!);
    expect(checks[0]!.quoted_unit_price).toBeGreaterThanOrEqual(1);
    expect(quote.lines.map((line) => line.line_total)).toStrictEqual(quote.lines.map((line) => line.quantity * line.unit_price));
    expect(quote.total).toBe(quote.lines.reduce((sum, line) => sum + line.quantity * line.unit_price, 0));
    expect(quote.lead_time_days).toBe(Math.max(...quote.lines.map((line) => line.lead_time_days)));
  });

  it('is an internal failure (500) when no line is priced by the list: a run never says that a fault was on when it changed nothing', async () => {
    const rig = makeRig({ mode: 'quote_off_price_list', rfq: { items: [{ sku: 'NOT-LISTED-1', quantity: 5 }, { sku: 'NOT-LISTED-2', quantity: 6 }] } });
    choosing(rig, choiceOf({ lines: [{ sku: 'NOT-LISTED-1', quantity: 5, unit_price: 77, lead_time_days: 3 }, { sku: 'NOT-LISTED-2', quantity: 6, unit_price: 78, lead_time_days: 3 }] }));
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'internal', status: 500, kind: 'job' });
    expect(rig.events).toStrictEqual(['take', 'decide']);
    expectNothingRecorded(rig);
    expectCleanLog(rig.logs);
  });

  it('is an internal failure (500) when the first priced line has the price 1, which no lower whole price follows', async () => {
    const cheap = priceListOf({ schema: 'vector.usecase.price-list.v1', items: [{ sku: 'CHEAP-1', lead_time_days: 1, breaks: [{ min_quantity: 1, unit_price: 1 }] }] });
    const rig = makeRig({ mode: 'quote_off_price_list', list: cheap, rfq: { items: [{ sku: 'CHEAP-1', quantity: 3 }] } });
    choosing(rig, choiceOf({ lines: [{ sku: 'CHEAP-1', quantity: 3, unit_price: 1, lead_time_days: 1 }] }));
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'internal', status: 500 });
    expectNothingRecorded(rig);
  });

  it('twin: the same request with the empty setting gives the quote with the listed price', async () => {
    const rig = makeRig({ rfq: { items: [{ sku: 'NOT-LISTED-1', quantity: 5 }] } });
    choosing(rig, choiceOf({ lines: [{ sku: 'NOT-LISTED-1', quantity: 5, unit_price: 77, lead_time_days: 3 }] }));
    expect(await rig.run()).toMatchObject({ outcome: 'done', fault_mode: '' });
  });

  it('puts the fault value in no line of the log, for a quote and for a failure', async () => {
    const quoted = makeRig({ mode: 'quote_off_price_list' });
    await quoted.run();
    expect(quoted.logs).toHaveLength(1);
    expectCleanLog(quoted.logs);
    const failed = makeRig({ mode: 'quote_off_price_list', rfq: { items: [{ sku: 'NOT-LISTED-1', quantity: 5 }] } });
    choosing(failed, choiceOf({ lines: [{ sku: 'NOT-LISTED-1', quantity: 5, unit_price: 77, lead_time_days: 3 }] }));
    await refusalOf(failed.run());
    expectCleanLog(failed.logs);
  });
});

describe('the empty setting', () => {
  it.each([
    ['three items at the second break', [['GLV-NIT-M', 100], ['SYR-10ML', 250], ['MSK-N95', 40]]],
    ['one item at the first break', [['SYR-10ML', 1]]],
    ['one item at the highest break', [['MSK-N95', 5_000]]],
    ['two items on the edge of a break', [['GLV-NIT-M', 50], ['MSK-N95', 25]]],
    ['an item and the quantity just below a break', [['GLV-NIT-M', 499], ['SYR-10ML', 999]]],
  ] as const)('changes no price: every line is at the listed price, and the quote says no fault: %s', async (_what, items) => {
    const rig = makeRig({ rfq: { items: items.map(([sku, quantity]) => ({ sku, quantity })) } });
    choosing(rig, followingList(items));
    const quote = await rig.run();
    expect(quote.fault_mode).toBe('');
    for (const check of lineChecks(quote, PRICE_LIST)) expect(check.quoted_unit_price, check.sku).toBe(check.listed_unit_price);
  });

  it('does not correct a price of the model either: the job neither raises nor lowers it', async () => {
    const rig = makeRig();
    choosing(rig, choiceOf({ lines: [{ ...choiceOf().lines[0]!, unit_price: 90 }] }));
    expect((await rig.run()).lines[0]?.unit_price).toBe(90);
  });

  it('is not changed by the environment: the variable FAULT_MODE in the environment of the process turns nothing on', async () => {
    vi.stubEnv('FAULT_MODE', 'quote_off_price_list');
    expect(await makeRig().run()).toStrictEqual(golden('quote'));
  });

  it('is not changed by the request or the context: the value as an identifier, as the model of the advert, and as the notes of the model turns nothing on', async () => {
    const named = makeRig({ rfq: { rfq_id: 'quote_off_price_list' } });
    const quote = await named.run();
    expect(quote.rfq_id).toBe('quote_off_price_list');
    expect(quote.lines.map((line) => line.unit_price)).toStrictEqual([125, 35, 59]);
    expect(quote.fault_mode).toBe('');
    const rig = makeRig();
    choosing(rig, choiceOf({ notes: 'quote_off_price_list' }));
    const withContext = await runQuote(rig.deps, rig.request, { ...rig.context, advertModel: 'quote_off_price_list' }, T0);
    expect(withContext.lines.map((line) => line.unit_price)).toStrictEqual([125, 35, 59]);
    expect(withContext.fault_mode).toBe('');
  });
});

describe('the switch', () => {
  /** A switch that counts how many times its value is read. */
  function countingSwitch(value: unknown): { readonly fault: FaultSwitch<'bid-desk'>; readonly reads: () => number } {
    let reads = 0;
    const fault = {
      kind: 'bid-desk',
      get mode(): unknown {
        reads += 1;
        return value;
      },
    };
    return { fault: fault as unknown as FaultSwitch<'bid-desk'>, reads: () => reads };
  }

  it.each([
    ['', ''],
    ['quote_off_price_list', 'quote_off_price_list'],
  ])('is read one time for the whole job, for the setting %j: the lines and the quote come from one read', async (value, mode) => {
    const rig = makeRig();
    const counted = countingSwitch(value);
    const quote = await runQuote({ ...rig.deps, fault: counted.fault }, rig.request, rig.context, T0);
    expect(counted.reads()).toBe(1);
    expect(quote.fault_mode).toBe(mode);
  });

  it('is read one time for a job that is refused too, and the refusal does not depend on a second read', async () => {
    const rig = makeRig();
    rig.entry = null;
    const counted = countingSwitch('quote_off_price_list');
    await refusalOf(runQuote({ ...rig.deps, fault: counted.fault }, rig.request, rig.context, T0));
    expect(counted.reads()).toBe(1);
  });

  it('gives the result the value that the one read gave, also when the switch would give another value at a second read', async () => {
    const rig = makeRig();
    let reads = 0;
    const fault = {
      kind: 'bid-desk',
      get mode(): string {
        reads += 1;
        return reads === 1 ? 'quote_off_price_list' : '';
      },
    } as unknown as FaultSwitch<'bid-desk'>;
    const quote = await runQuote({ ...rig.deps, fault }, rig.request, rig.context, T0);
    expect(quote.fault_mode).toBe('quote_off_price_list');
    expect(quote.lines[0]?.unit_price).toBe(100);
  });

  it.each([
    ['another case', 'Quote_Off_Price_List'],
    ['capitals', 'QUOTE_OFF_PRICE_LIST'],
    ['a space before it', ' quote_off_price_list'],
    ['a space after it', 'quote_off_price_list '],
    ['true', 'true'],
    ['on', 'on'],
    ['the value of the Order Desk', 'confirm_wrong_lot'],
    ['null', null],
    ['the number 1', 1],
  ])('is on only for the exact value: %s turns nothing on, and the job never gives a quote that names it', async (_what, value) => {
    const rig = makeRig();
    const counted = countingSwitch(value);
    const refusal = await refusalOf(runQuote({ ...rig.deps, fault: counted.fault }, rig.request, rig.context, T0));
    expect(refusal).toMatchObject({ code: 'internal', status: 500 });
    expectNothingRecorded(rig);
  });
});
