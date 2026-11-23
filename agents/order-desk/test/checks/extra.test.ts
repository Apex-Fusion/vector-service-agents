// agents/order-desk/test/checks/extra.test.ts: the four checks of the Order Desk that follow the shared checks of the kit. Each refusal has an accepted twin. The advert and the lot of a purchase order
// are compared with the job context of the runtime and never with a member that the body chooses. A book that cannot be read is never a pass. The question: does a wrong supplier, lot, quantity or a
// purchase order number that exists ever pass?
import { describe, expect, it } from 'vitest';
import { CheckUnavailableError } from '@vsa/usecase-kit/checks';
import type { ExtraCheck, StepResult } from '@vsa/usecase-kit/checks';
import { CONFIRMATION_CHECKS, LOTS_SCHEMA, parseLotsFile } from '@vsa/usecase-kit/inventory';
import type { LotsFile } from '@vsa/usecase-kit/inventory';
import type { Handoff } from '@vsa/usecase-kit/protocol';
import { MemoryOrderBook, orderChecks } from '../../src/checks/index.ts';
import type { OrderBook } from '../../src/checks/index.ts';
import { CONTEXT, OTHER_ADVERT_REF, OTHER_DID, PURCHASE_ORDER, SELF, handoffOf, purchaseOrder } from './samples.ts';

const lots = (): LotsFile => {
  const parsed = parseLotsFile({
    schema: LOTS_SCHEMA,
    items: [
      { sku: 'GLV-NIT-M', lots: { 'lot-small': 10, 'lot-medium': 50, 'lot-large': 200 } },
      { sku: 'SYR-10ML', lots: { 'lot-small': 25, 'lot-medium': 100, 'lot-large': 400 } },
    ],
  });
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.value;
};

interface Rig {
  readonly book: OrderBook;
  readonly faults: Array<[string, unknown]>;
  readonly supplier: ExtraCheck<Handoff>;
  readonly lot: ExtraCheck<Handoff>;
  readonly quantity: ExtraCheck<Handoff>;
  readonly duplicate: ExtraCheck<Handoff>;
}

/** The four checks over a book. The faults list gets each source and cause that the checks report. */
function rig(book: OrderBook = new MemoryOrderBook()): Rig {
  const faults: Array<[string, unknown]> = [];
  const [supplier, lot, quantity, duplicate] = orderChecks({ lots: lots(), book, self: SELF, onFault: (source, cause) => { faults.push([source, cause]); } });
  return { book, faults, supplier, lot, quantity, duplicate };
}

const ACCEPTED: StepResult = { ok: true, value: {} };
const refusalOf = (result: StepResult): { code: string; detail: string } => {
  if (result.ok) throw new Error('the check passed');
  return { code: result.code, detail: result.detail };
};

describe('the list of checks', () => {
  it('has the four checks of the page, with their names, in the order of the page', () => {
    const checks = orderChecks({ lots: lots(), book: new MemoryOrderBook(), self: SELF });
    expect(checks.map((check) => check.names)).toEqual([['for_this_supplier'], ['lot'], ['quantity'], ['not_duplicate']]);
    // The confirmation lists the same four names, after the shared checks.
    expect(CONFIRMATION_CHECKS.slice(-4)).toEqual(['for_this_supplier', 'lot', 'quantity', 'not_duplicate']);
  });

  it('is a TypeError for a wrong input: a supplier that is no DID, a lots file that is no lots file, and a book that cannot answer', () => {
    const book = new MemoryOrderBook();
    expect(() => orderChecks({ lots: lots(), book, self: SELF })).not.toThrow();
    expect(() => orderChecks({ lots: lots(), book, self: 'did:vector:abc' })).toThrow(TypeError);
    expect(() => orderChecks({ lots: lots(), book, self: SELF.toUpperCase() })).toThrow(TypeError);
    expect(() => orderChecks({ lots: { schema: LOTS_SCHEMA, items: [] } as unknown as LotsFile, book, self: SELF })).toThrow(TypeError);
    expect(() => orderChecks({ lots: lots(), book: {} as unknown as OrderBook, self: SELF })).toThrow(TypeError);
    expect(() => orderChecks(null as never)).toThrow(TypeError);
    expect(() => orderChecks({ lots: lots(), book, self: SELF, onFault: 'yes' as never })).toThrow(TypeError);
  });

  it('keeps its own copy of the lots file: a change of the file that was given changes no check', async () => {
    const given = lots();
    const [, , quantity] = orderChecks({ lots: given, book: new MemoryOrderBook(), self: SELF });
    (given.items[0]!.lots as Record<string, number>)['lot-medium'] = 51;
    expect(await quantity!.run(handoffOf(), CONTEXT)).toEqual(ACCEPTED);
  });
});

describe('check 12, for_this_supplier', () => {
  it('passes a purchase order that names this supplier', async () => {
    expect(await rig().supplier.run(handoffOf(), CONTEXT)).toEqual(ACCEPTED);
  });

  it('refuses a purchase order that names another supplier with not_for_this_supplier', async () => {
    const refusal = refusalOf(await rig().supplier.run(handoffOf(purchaseOrder({ supplier_did: OTHER_DID })), CONTEXT));
    expect(refusal.code).toBe('not_for_this_supplier');
    expect(refusal.detail).not.toContain(OTHER_DID);
  });
});

describe('check 13, lot', () => {
  it('passes a purchase order for the advert that the escrow was posted on and for the lot of that advert', async () => {
    expect(await rig().lot.run(handoffOf(), CONTEXT)).toEqual(ACCEPTED);
  });

  it('refuses a body that names another advert than the context, with the same lot', async () => {
    const body = handoffOf(purchaseOrder({ advert_ref: OTHER_ADVERT_REF }));
    expect(refusalOf(await rig().lot.run(body, CONTEXT)).code).toBe('lot_mismatch');
    // The twin: the same body passes when the escrow was posted on the advert that the body names.
    expect(await rig().lot.run(body, { ...CONTEXT, advertRef: OTHER_ADVERT_REF })).toEqual(ACCEPTED);
  });

  it('refuses a body that names the right advert and a lot that is not the model of the advert', async () => {
    const body = handoffOf(purchaseOrder({ lot: 'lot-large' }));
    expect(refusalOf(await rig().lot.run(body, CONTEXT)).code).toBe('lot_mismatch');
    expect(await rig().lot.run(body, { ...CONTEXT, advertModel: 'lot-large' })).toEqual(ACCEPTED);
  });

  it('takes the lot from the model of the advert: every other lot of the three is refused for an advert of one lot', async () => {
    for (const lot of ['lot-small', 'lot-medium', 'lot-large']) {
      const results = await Promise.all(['lot-small', 'lot-medium', 'lot-large'].map(async (model) => (await rig().lot.run(handoffOf(purchaseOrder({ lot })), { ...CONTEXT, advertModel: model })).ok));
      expect(results, lot).toEqual(['lot-small', 'lot-medium', 'lot-large'].map((model) => model === lot));
    }
  });

  it('refuses an advert whose model is not a lot name', async () => {
    for (const model of ['gpt-4', 'LOT-MEDIUM', 'lot-medium ', '', 'constructor']) {
      expect(refusalOf(await rig().lot.run(handoffOf(), { ...CONTEXT, advertModel: model })).code, model).toBe('lot_mismatch');
    }
  });
});

describe('check 14, quantity', () => {
  it('passes the size of the lot of the advert for the SKU', async () => {
    expect(await rig().quantity.run(handoffOf(), CONTEXT)).toEqual(ACCEPTED);
    expect(await rig().quantity.run(handoffOf(purchaseOrder({ sku: 'SYR-10ML', lot: 'lot-small', quantity: 25 })), { ...CONTEXT, advertModel: 'lot-small' })).toEqual(ACCEPTED);
  });

  it('refuses another quantity with quantity_mismatch, the one above and the one below', async () => {
    for (const quantity of [49, 51, 1, 200, 1_000_000]) {
      expect(refusalOf(await rig().quantity.run(handoffOf(purchaseOrder({ quantity })), CONTEXT)).code, String(quantity)).toBe('quantity_mismatch');
    }
  });

  it('refuses a SKU that the lots file does not list with the same code', async () => {
    const refusal = refusalOf(await rig().quantity.run(handoffOf(purchaseOrder({ sku: 'MSK-N95' })), CONTEXT));
    expect(refusal.code).toBe('quantity_mismatch');
    // A SKU is compared as it is written.
    expect(refusalOf(await rig().quantity.run(handoffOf(purchaseOrder({ sku: 'glv-nit-m' })), CONTEXT)).code).toBe('quantity_mismatch');
  });

  it('takes the size from the lot of the advert and not from the lot that the body names', async () => {
    // The body names the medium lot and its size (50). The escrow was paid for the large lot (200).
    expect(refusalOf(await rig().quantity.run(handoffOf(), { ...CONTEXT, advertModel: 'lot-large' })).code).toBe('quantity_mismatch');
    expect(await rig().quantity.run(handoffOf(purchaseOrder({ quantity: 200 })), { ...CONTEXT, advertModel: 'lot-large' })).toEqual(ACCEPTED);
  });

  it('refuses an advert whose model is not a lot name', async () => {
    expect(refusalOf(await rig().quantity.run(handoffOf(), { ...CONTEXT, advertModel: 'constructor' })).code).toBe('quantity_mismatch');
    expect(refusalOf(await rig().quantity.run(handoffOf(), { ...CONTEXT, advertModel: '__proto__' })).code).toBe('quantity_mismatch');
  });
});

describe('check 15, not_duplicate', () => {
  it('passes a purchase order number that the book does not hold, and refuses it with duplicate_po once the book holds it', async () => {
    const { duplicate, book } = rig();
    expect(await duplicate.run(handoffOf(), CONTEXT)).toEqual(ACCEPTED);
    await book.record('run1', 'run1-0001', 'SO-run1-0001');
    expect(refusalOf(await duplicate.run(handoffOf(), CONTEXT)).code).toBe('duplicate_po');
  });

  it('counts a purchase order number without regard to case, as the supplier portal does', async () => {
    const { duplicate, book } = rig();
    await book.record('run1', 'RUN1-0001', 'SO-run1-0001');
    expect(refusalOf(await duplicate.run(handoffOf(), CONTEXT)).code).toBe('duplicate_po');
    await book.record('run1', 'run1-0002', 'SO-run1-0002');
    expect(refusalOf(await duplicate.run(handoffOf(purchaseOrder({ po_number: 'RUN1-0002' })), CONTEXT)).code).toBe('duplicate_po');
    // The twin: another number passes.
    expect(await duplicate.run(handoffOf(purchaseOrder({ po_number: 'run1-0003' })), CONTEXT)).toEqual(ACCEPTED);
  });

  it('keeps the tenants apart: the number of one tenant is a new number for another', async () => {
    const { duplicate, book } = rig();
    await book.record('run2', 'run1-0001', 'SO-run2-0001');
    expect(await duplicate.run(handoffOf(), CONTEXT)).toEqual(ACCEPTED);
    await book.record('run1', 'run1-0001', 'SO-run1-0001');
    expect(refusalOf(await duplicate.run(handoffOf(), CONTEXT)).code).toBe('duplicate_po');
  });

  it('is check_unavailable and never a pass when the book cannot be read, and tells the service the cause', async () => {
    const cause = new Error('EIO: the disk of /data/orders.json failed, key=secret-token-123');
    const book: OrderBook = { has: () => Promise.reject(cause), record: async () => undefined };
    const { duplicate, faults } = rig(book);
    const failure = await duplicate.run(handoffOf(), CONTEXT).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(CheckUnavailableError);
    expect((failure as CheckUnavailableError).code).toBe('check_unavailable');
    expect((failure as CheckUnavailableError).message).toBe('the order book could not be read');
    expect(faults).toEqual([['order book', cause]]);
  });

  it('is check_unavailable when the book gives an answer that is not true or false: only false is a pass', async () => {
    for (const answer of [undefined, null, 0, 1, '', 'false', 'true', {}, []]) {
      const book = { has: () => Promise.resolve(answer), record: async () => undefined } as unknown as OrderBook;
      const { duplicate, faults } = rig(book);
      await expect(duplicate.run(handoffOf(), CONTEXT), String(answer)).rejects.toBeInstanceOf(CheckUnavailableError);
      expect(faults).toHaveLength(1);
    }
  });

  it('is check_unavailable when the book throws at once, without a promise', async () => {
    const book = { has: () => { throw new Error('the book is closed'); }, record: async () => undefined } as unknown as OrderBook;
    await expect(rig(book).duplicate.run(handoffOf(), CONTEXT)).rejects.toBeInstanceOf(CheckUnavailableError);
  });

  it('is still check_unavailable when the hook for faults fails', async () => {
    const book: OrderBook = { has: () => Promise.reject(new Error('no')), record: async () => undefined };
    const [, , , duplicate] = orderChecks({ lots: lots(), book, self: SELF, onFault: () => { throw new Error('the log is closed'); } });
    await expect(duplicate!.run(handoffOf(), CONTEXT)).rejects.toBeInstanceOf(CheckUnavailableError);
  });

  it('asks the book with the tenant and the number of the purchase order and with nothing from the context', async () => {
    const asked: unknown[][] = [];
    const book: OrderBook = { has: async (...args) => { asked.push(args); return false; }, record: async () => undefined };
    await rig(book).duplicate.run(handoffOf(purchaseOrder({ tenant: 'run7', po_number: 'Run7-0004' })), CONTEXT);
    expect(asked).toEqual([['run7', 'Run7-0004']]);
  });
});

describe('a document that is not a purchase order', () => {
  it('is a fault of the service in each check: a throw, never a pass and never a refusal of a rule', async () => {
    const { supplier, lot, quantity, duplicate } = rig();
    const broken = handoffOf(purchaseOrder({ quantity: 0 }));
    for (const check of [supplier, lot, quantity, duplicate]) {
      await expect(check.run(broken, CONTEXT), check.names[0]).rejects.toBeInstanceOf(TypeError);
      expect(await check.run(handoffOf(), CONTEXT).then((result) => result.ok, () => false), check.names[0]).toBe(true);
    }
  });

  it('is refused with a message that names the member and never repeats the value', async () => {
    const failure = await rig().supplier.run(handoffOf(purchaseOrder({ sku: 'secret value?' })), CONTEXT).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).message).not.toContain('secret value');
    expect((failure as TypeError).message).toContain('sku');
  });

  it('is a document with a member that the purchase order does not list, or without a member that it lists', async () => {
    const { lot } = rig();
    await expect(lot.run(handoffOf({ ...PURCHASE_ORDER, advert_model: 'lot-medium' }), CONTEXT)).rejects.toBeInstanceOf(TypeError);
    const missing = Object.fromEntries(Object.entries(PURCHASE_ORDER).filter(([name]) => name !== 'advert_ref'));
    await expect(lot.run(handoffOf(missing), CONTEXT)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('a handoff for another use case', () => {
  it('is a fault of the service in each check: a throw, never a pass, also when the purchase order that it carries passes the check', async () => {
    const { supplier, lot, quantity, duplicate } = rig();
    const other = handoffOf(PURCHASE_ORDER, { use_case: 'prior-authorization' });
    for (const check of [supplier, lot, quantity, duplicate]) {
      await expect(check.run(other, CONTEXT), check.names[0]).rejects.toBeInstanceOf(TypeError);
      // The twin: the same purchase order in a handoff for use case 1 (inventory reorder) passes.
      expect(await check.run(handoffOf(), CONTEXT).then((result) => result.ok, () => false), check.names[0]).toBe(true);
    }
  });

  it('is refused with a message that names the use case that is right and not the value that came', async () => {
    const failure = await rig().supplier.run(handoffOf(PURCHASE_ORDER, { use_case: 'prior-authorization' }), CONTEXT).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).message).toContain('use case 1 (inventory reorder)');
    expect((failure as TypeError).message).not.toContain('prior');
  });
});
