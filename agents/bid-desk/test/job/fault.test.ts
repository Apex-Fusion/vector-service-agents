// agents/bid-desk/test/job/fault.test.ts: the fault of the Bid Desk, `quote_off_price_list`. The fault changes WHAT the job sends: the unit price of the first line that the price list prices. It never changes
// a check, and it is on only for the exact value `quote_off_price_list`: the empty setting is a clean run. The job reads the switch one time. The question: can the fault be on with an empty setting?
import { describe, expect, it } from 'vitest';
import { priceFor } from '@vsa/usecase-kit/bids';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { faultyPriceOf, pricedLines, readFault } from '../../src/job/fault.ts';
import { PRICE_LIST, choiceOf, priceListOf } from './samples.ts';

/** A switch that counts how many times its value is read. The value is whatever the test says, also one that no switch of the kit holds. */
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

describe('faultyPriceOf', () => {
  it.each([
    [10, 8],
    [11, 8],
    [1000, 800],
    [2, 1],
    [3, 2],
    [5, 4],
    [6, 4],
    [125, 100],
    [1_000_000, 800_000],
  ])('gives the price %s the faulty price %s', (listed, faulty) => {
    expect(faultyPriceOf(listed)).toBe(faulty);
  });

  it('gives a whole number of at least 1 that is below the listed price, for every listed price from 2 to 2,000', () => {
    for (let listed = 2; listed <= 2000; listed += 1) {
      const faulty = faultyPriceOf(listed);
      expect(Number.isInteger(faulty), String(listed)).toBe(true);
      expect(faulty, String(listed)).toBeGreaterThanOrEqual(1);
      expect(faulty, String(listed)).toBeLessThan(listed);
      expect(listed - faulty, String(listed)).toBe(Math.ceil(listed / 5));
    }
  });

  it.each([
    ['1, which no lower whole price follows', 1],
    ['0', 0],
    ['a negative number', -3],
    ['a number with a fraction', 2.5],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['minus infinity', Number.NEGATIVE_INFINITY],
    ['a number that a number cannot hold exactly', 2 ** 53],
    ['a text', '10'],
    ['null', null],
    ['undefined', undefined],
    ['a bigint', 10n],
  ])('throws a RangeError for %s, and the message does not repeat it', (_what, listed) => {
    let error: unknown;
    try {
      faultyPriceOf(listed as number);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RangeError);
    expect((error as RangeError).message).not.toContain('2.5');
  });

  it('twin: the least price that has a lower price, 2, gives 1', () => {
    expect(() => faultyPriceOf(2)).not.toThrow();
  });
});

describe('the switch', () => {
  it('reads the value of the switch one time, and gives that value and whether the fault is on', () => {
    const counted = countingSwitch('quote_off_price_list');
    const reading = readFault(counted.fault);
    expect(counted.reads()).toBe(1);
    expect(reading).toStrictEqual({ mode: 'quote_off_price_list', on: true });
    const clean = countingSwitch('');
    expect(readFault(clean.fault)).toStrictEqual({ mode: '', on: false });
    expect(clean.reads()).toBe(1);
  });

  it('is on for the exact value of the kit and for no other value: the empty setting is a clean run', () => {
    expect(readFault(readFaultSwitch('bid-desk', '')).on).toBe(false);
    expect(readFault(readFaultSwitch('bid-desk', undefined)).on).toBe(false);
    expect(readFault(readFaultSwitch('bid-desk', 'quote_off_price_list')).on).toBe(true);
  });

  it.each([
    ['the empty text', ''],
    ['another case', 'Quote_Off_Price_List'],
    ['capitals', 'QUOTE_OFF_PRICE_LIST'],
    ['a space before it', ' quote_off_price_list'],
    ['a space after it', 'quote_off_price_list '],
    ['hyphens', 'quote-off-price-list'],
    ['a part of it', 'quote_off'],
    ['true', 'true'],
    ['on', 'on'],
    ['1', '1'],
    ['the value of the Order Desk', 'confirm_wrong_lot'],
    ['the value of the Sourcing Agent', 'invert_scores'],
    ['undefined', undefined],
    ['null', null],
    ['the boolean true', true],
    ['the number 1', 1],
    ['an object', {}],
    ['a list with the value', ['quote_off_price_list']],
    ['an object with a toString that gives the value', { toString: () => 'quote_off_price_list' }],
  ])('is not on for %s', (_what, value) => {
    expect(readFault(countingSwitch(value).fault).on).toBe(false);
  });

  it('keeps the value that it read: a later change of the switch changes nothing in the reading, and the reading cannot be changed', () => {
    let value: unknown = 'quote_off_price_list';
    const fault = { kind: 'bid-desk', get mode(): unknown { return value; } } as unknown as FaultSwitch<'bid-desk'>;
    const reading = readFault(fault);
    value = '';
    expect(reading).toStrictEqual({ mode: 'quote_off_price_list', on: true });
    expect(Object.isFrozen(reading)).toBe(true);
  });

  it('is refused at the start for any value that the kit does not list for the Bid Desk, and it is never read as no fault', () => {
    for (const value of ['Quote_Off_Price_List', ' quote_off_price_list', 'confirm_wrong_lot', 'invert_scores', 'alter_after_approval', null, true, 1]) {
      expect(() => readFaultSwitch('bid-desk', value), String(value)).toThrow(/FAULT_MODE/);
    }
  });
});

describe('the lines with the fault off', () => {
  it('are the lines of the choice, as new objects, whatever the price list says', () => {
    const choice = choiceOf();
    const lines = pricedLines(false, choice.lines, PRICE_LIST);
    expect(lines).toStrictEqual(choiceOf().lines);
    expect(lines).not.toBe(choice.lines);
    lines?.forEach((line, index) => expect(line).not.toBe(choice.lines[index]));
  });

  it('keep a price that is not the listed price: the model decides, and the job does not change or check it', () => {
    const choice = choiceOf({ lines: [{ sku: 'GLV-NIT-M', quantity: 100, unit_price: 90, lead_time_days: 14 }, { sku: 'SYR-10ML', quantity: 250, unit_price: 36, lead_time_days: 9 }] });
    expect(pricedLines(false, choice.lines, PRICE_LIST)).toStrictEqual(choice.lines);
  });

  it('read no price list: a list that carries none of the SKUs changes nothing, and an empty list of lines is an empty list', () => {
    const other = priceListOf({ schema: 'vector.usecase.price-list.v1', items: [{ sku: 'OTHER-1', lead_time_days: 1, breaks: [{ min_quantity: 1, unit_price: 50 }] }] });
    expect(pricedLines(false, choiceOf().lines, other)).toStrictEqual(choiceOf().lines);
    expect(pricedLines(false, [], PRICE_LIST)).toStrictEqual([]);
  });
});

describe('the lines with the fault on', () => {
  it('change the unit price of the first line that the list prices to the faulty price of the listed price, and no other member of any line', () => {
    const choice = choiceOf();
    const lines = pricedLines(true, choice.lines, PRICE_LIST);
    expect(lines).toStrictEqual([
      { sku: 'GLV-NIT-M', quantity: 100, unit_price: 100, lead_time_days: 14 },
      { sku: 'SYR-10ML', quantity: 250, unit_price: 35, lead_time_days: 9 },
      { sku: 'MSK-N95', quantity: 40, unit_price: 59, lead_time_days: 20 },
    ]);
  });

  it('gives a price that is below the listed price for that SKU and quantity', () => {
    for (const line of choiceOf().lines) {
      const listed = priceFor(PRICE_LIST, line.sku, line.quantity)!.unit_price;
      const lines = pricedLines(true, [line], PRICE_LIST)!;
      expect(lines[0]!.unit_price).toBe(faultyPriceOf(listed));
      expect(lines[0]!.unit_price).toBeLessThan(listed);
      expect(lines[0]!.unit_price).toBeGreaterThanOrEqual(1);
    }
  });

  it.each([
    ['the listed price', 125],
    ['a price below the list', 90],
    ['a price above the list', 200],
    ['the faulty price already', 100],
  ])('takes the faulty price of the LISTED price when the model chose %s, and not a price of the model', (_what, chosen) => {
    const choice = choiceOf({ lines: [{ sku: 'GLV-NIT-M', quantity: 100, unit_price: chosen, lead_time_days: 14 }] });
    expect(pricedLines(true, choice.lines, PRICE_LIST)![0]!.unit_price).toBe(100);
  });

  it('changes the first line that the list prices and no line before it: a line that the list does not carry stays as it is', () => {
    const choice = choiceOf({
      lines: [{ sku: 'NOT-LISTED-1', quantity: 5, unit_price: 77, lead_time_days: 3 }, { sku: 'SYR-10ML', quantity: 250, unit_price: 35, lead_time_days: 9 }, { sku: 'MSK-N95', quantity: 40, unit_price: 59, lead_time_days: 20 }],
    });
    expect(pricedLines(true, choice.lines, PRICE_LIST)).toStrictEqual([
      { sku: 'NOT-LISTED-1', quantity: 5, unit_price: 77, lead_time_days: 3 },
      { sku: 'SYR-10ML', quantity: 250, unit_price: 28, lead_time_days: 9 },
      { sku: 'MSK-N95', quantity: 40, unit_price: 59, lead_time_days: 20 },
    ]);
  });

  it('changes one line only, and keeps the order of the lines', () => {
    const lines = pricedLines(true, choiceOf().lines, PRICE_LIST)!;
    expect(lines.map((line) => line.sku)).toStrictEqual(['GLV-NIT-M', 'SYR-10ML', 'MSK-N95']);
    expect(lines.filter((line, index) => line.unit_price !== choiceOf().lines[index]!.unit_price)).toHaveLength(1);
  });

  it('does not change the choice that it was given, so the decision on record stays what the model said', () => {
    const choice = choiceOf();
    const lines = pricedLines(true, choice.lines, PRICE_LIST);
    expect(choice).toStrictEqual(choiceOf());
    expect(lines).not.toBe(choice.lines);
    expect(lines![0]).not.toBe(choice.lines[0]);
  });

  it('gives null when no line is priced by the list: a run never says that the fault was on when it changed nothing', () => {
    const none = choiceOf({ lines: [{ sku: 'NOT-LISTED-1', quantity: 5, unit_price: 77, lead_time_days: 3 }, { sku: 'NOT-LISTED-2', quantity: 6, unit_price: 78, lead_time_days: 3 }] });
    expect(pricedLines(true, none.lines, PRICE_LIST)).toBeNull();
    expect(pricedLines(true, [], PRICE_LIST)).toBeNull();
  });

  it('gives null when the first line that the list prices has the price 1: no lower whole price exists', () => {
    const cheap = priceListOf({ schema: 'vector.usecase.price-list.v1', items: [{ sku: 'CHEAP-1', lead_time_days: 1, breaks: [{ min_quantity: 1, unit_price: 1 }] }] });
    const lines = [{ sku: 'CHEAP-1', quantity: 3, unit_price: 1, lead_time_days: 1 }];
    expect(pricedLines(true, lines, cheap)).toBeNull();
  });

  it('twin: a list with the price 2 gives the price 1', () => {
    const cheap = priceListOf({ schema: 'vector.usecase.price-list.v1', items: [{ sku: 'CHEAP-2', lead_time_days: 1, breaks: [{ min_quantity: 1, unit_price: 2 }] }] });
    expect(pricedLines(true, [{ sku: 'CHEAP-2', quantity: 3, unit_price: 2, lead_time_days: 1 }], cheap)![0]!.unit_price).toBe(1);
  });

  it('takes the listed price of the break that holds for the quantity', () => {
    for (const [quantity, faulty] of [[1, 112], [49, 112], [50, 105], [99, 105], [100, 100], [499, 100], [500, 89]] as const) {
      const lines = pricedLines(true, [{ sku: 'GLV-NIT-M', quantity, unit_price: 1, lead_time_days: 14 }], PRICE_LIST)!;
      expect(lines[0]!.unit_price, String(quantity)).toBe(faulty);
    }
  });
});
