// agents/order-desk/test/job/fault.test.ts: the fault of the Order Desk, `confirm_wrong_lot`. The fault changes WHAT the job sends: the lot and the quantity of the order and of the confirmation. It never
// changes a check, and it is on only for the value `confirm_wrong_lot`: the empty setting is a clean run. The question: can the fault be on with an empty setting?
import { describe, expect, it } from 'vitest';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import { LOT_NAMES, lotSizeOf, parseLotsFile, parsePurchaseOrder } from '@vsa/usecase-kit/inventory';
import type { LotName, PurchaseOrder } from '@vsa/usecase-kit/inventory';
import { wrongLotOf as exportedWrongLotOf } from '../../src/job/index.ts';
import { orderedOf, wrongLotOf } from '../../src/job/fault.ts';
import { LOTS, purchaseOrder } from './samples.ts';

function orderOf(over: Record<string, string | number> = {}): PurchaseOrder {
  const parsed = parsePurchaseOrder(purchaseOrder(over));
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.value;
}

describe('wrongLotOf', () => {
  it.each([
    ['lot-small', 'lot-medium'],
    ['lot-medium', 'lot-small'],
    ['lot-large', 'lot-small'],
  ] as const)('gives %s the lot %s', (lot, wrong) => {
    expect(wrongLotOf(lot)).toBe(wrong);
  });

  it('never gives the lot that it was given, and always gives a lot name', () => {
    for (const lot of LOT_NAMES) {
      expect(wrongLotOf(lot)).not.toBe(lot);
      expect(LOT_NAMES).toContain(wrongLotOf(lot));
    }
  });

  it('is the function that the folder exports', () => {
    expect(exportedWrongLotOf).toBe(wrongLotOf);
  });
});

describe('the lot and the quantity of an order, for the empty setting', () => {
  it.each(LOT_NAMES)('are those of the purchase order for %s', (lot) => {
    const order = orderOf({ lot, quantity: lotSizeOf(LOTS, 'GLV-NIT-M', lot) ?? 0 });
    expect(orderedOf('', order, LOTS)).toStrictEqual({ lot, quantity: order.quantity });
  });

  it('are those of the purchase order also when the lots file does not list the SKU: the clean run reads no lots file', () => {
    const order = orderOf({ sku: 'UNLISTED-1', quantity: 7 });
    expect(orderedOf('', order, LOTS)).toStrictEqual({ lot: 'lot-medium', quantity: 7 });
  });

  it('are not changed by a quantity that differs from the size of the lot: the job orders what the purchase order says', () => {
    expect(orderedOf('', orderOf({ quantity: 49 }), LOTS)).toStrictEqual({ lot: 'lot-medium', quantity: 49 });
  });
});

describe('the lot and the quantity of an order, for the value confirm_wrong_lot', () => {
  it.each([
    ['GLV-NIT-M', 'lot-small', 'lot-medium', 50],
    ['GLV-NIT-M', 'lot-medium', 'lot-small', 10],
    ['GLV-NIT-M', 'lot-large', 'lot-small', 10],
    ['SYR-10ML', 'lot-small', 'lot-medium', 100],
    ['SYR-10ML', 'lot-medium', 'lot-small', 25],
    ['MSK-N95', 'lot-large', 'lot-small', 20],
  ] as const)('are the wrong lot and its size for %s ordered as %s: %s and %s units', (sku, lot, wrong, size) => {
    const order = orderOf({ sku, lot, quantity: lotSizeOf(LOTS, sku, lot) ?? 0 });
    const ordered = orderedOf('confirm_wrong_lot', order, LOTS);
    expect(ordered).toStrictEqual({ lot: wrong, quantity: size });
    expect(ordered?.lot).not.toBe(order.lot);
    expect(ordered?.quantity).not.toBe(order.quantity);
  });

  it('are the size of the wrong lot in the lots file, as the lots file says it', () => {
    const order = orderOf();
    const ordered = orderedOf('confirm_wrong_lot', order, LOTS);
    expect(ordered?.quantity).toBe(lotSizeOf(LOTS, order.sku, wrongLotOf(order.lot)));
  });

  it('give no size for a SKU that the lots file does not list, and the twin with the empty setting gives the order', () => {
    const order = orderOf({ sku: 'UNLISTED-1', quantity: 7 });
    expect(orderedOf('confirm_wrong_lot', order, LOTS)).toBeNull();
    expect(orderedOf('', order, LOTS)).toStrictEqual({ lot: 'lot-medium', quantity: 7 });
  });

  it('use the lots file that the job was given, and not a file of their own', () => {
    const other = parseLotsFile({ schema: 'vector.usecase.lots.v1', items: [{ sku: 'GLV-NIT-M', lots: { 'lot-small': 3, 'lot-medium': 50, 'lot-large': 200 } }] });
    if (!other.ok) throw new Error(other.detail);
    expect(orderedOf('confirm_wrong_lot', orderOf(), other.value)).toStrictEqual({ lot: 'lot-small', quantity: 3 });
  });
});

describe('the value of the setting', () => {
  it('is empty or confirm_wrong_lot for the Order Desk: the switch keeps the value that was read', () => {
    expect(readFaultSwitch('order-desk', '').mode).toBe('');
    expect(readFaultSwitch('order-desk', undefined).mode).toBe('');
    expect(readFaultSwitch('order-desk', 'confirm_wrong_lot').mode).toBe('confirm_wrong_lot');
  });

  it('refuses the value of another kind at the start: alter_after_approval throws and names the variable and the allowed values', () => {
    expect(() => readFaultSwitch('order-desk', 'alter_after_approval')).toThrow(/FAULT_MODE.*confirm_wrong_lot/);
  });

  it.each([
    ['another case', 'Confirm_Wrong_Lot'],
    ['a space before it', ' confirm_wrong_lot'],
    ['a space after it', 'confirm_wrong_lot '],
    ['a value that no kind lists', 'wrong_lot'],
    ['a value of the Bid Desk', 'quote_off_price_list'],
    ['null', null],
    ['true', true],
    ['the number 1', 1],
  ])('refuses %s at the start: it is never read as no fault, and it is never read as the fault', (_what, value) => {
    expect(() => readFaultSwitch('order-desk', value)).toThrow(/FAULT_MODE/);
  });

  it('is a fault only for the exact value: no other text turns the fault on', () => {
    const order = orderOf();
    for (const mode of ['', 'confirm_wrong_lot'] as const) {
      const ordered = orderedOf(mode, order, LOTS);
      expect(ordered?.lot === wrongLotOf(order.lot), mode).toBe(mode === 'confirm_wrong_lot');
    }
    // A value that the types do not allow, as a caller in plain JavaScript could give it: it is no fault either.
    for (const mode of ['CONFIRM_WRONG_LOT', 'confirm_wrong_lot ', 'true', 'on'] as unknown as ('' | 'confirm_wrong_lot')[]) {
      expect(orderedOf(mode, order, LOTS), String(mode)).toStrictEqual({ lot: order.lot, quantity: order.quantity });
    }
  });
});

describe('the lot names', () => {
  it('are the three names that the wrong lot is chosen from', () => {
    const names: readonly LotName[] = LOT_NAMES;
    expect(names).toStrictEqual(['lot-small', 'lot-medium', 'lot-large']);
  });
});
