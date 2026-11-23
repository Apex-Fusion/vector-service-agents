// agents/reorder-agent/test/propose/front.test.ts: the steps of `propose` that come before the sub-delegation: the request, the authority, the paying key and the supplier. Each refusal and each failure has an
// accepted twin, and after each of them nothing was sent to the chain, asked of the gateway, called, recorded or decided.
import { describe, expect, it } from 'vitest';
import { accepted, refused, ERROR_STATUS } from '@vsa/usecase-kit/protocol';
import { PROPOSE_FAILURES, ProposeRefusal } from '../../src/propose/index.ts';
import { LOTS, NOW, PARENT_ID, SKU, STOCK, SUPPLIER, SUPPLIER_DID, TENANT, expectFailed, expectUntouched, json, proposed, world } from './support.ts';

/** What a run throws, or null when it returns. */
const thrownBy = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => null,
    (error: unknown) => error,
  );

describe('the request', () => {
  it.each(['Run1', 'run_1', 'run.1', '-run', 'x'.repeat(49)])('refuses the tenant %s, which a purchase order number cannot hold, as bad_shape and before it does anything', async (tenant) => {
    const w = world();
    const refusal = await thrownBy(w.run({ request: { tenant } }));
    expect(refusal).toBeInstanceOf(ProposeRefusal);
    expect(refusal).toMatchObject({ name: 'ProposeRefusal', code: 'bad_shape', status: ERROR_STATUS.bad_shape });
    expect((refusal as ProposeRefusal).message).not.toContain(tenant);
    expectUntouched(w);
    expect(w.supplierCalls).toStrictEqual([]);
  });

  it('takes the longest tenant that a purchase order number can hold: the twin', async () => {
    const tenant = 'x'.repeat(48);
    const result = proposed(await world().run({ request: { tenant } }));
    expect(result.document).toMatchObject({ tenant, po_number: `${tenant}-1` });
  });
});

describe('the authority', () => {
  it('refuses a delegation that names another agent as its delegate, with the status of its code, before it reads or sends anything', async () => {
    const w = world();
    const other = 'ff'.repeat(32);
    w.script.delegation = async () => ({ delegate: other, chain_whole: true });
    const refusal = await thrownBy(w.run());
    expect(refusal).toBeInstanceOf(ProposeRefusal);
    expect(refusal).toMatchObject({ name: 'ProposeRefusal', code: 'delegation_not_mine', status: ERROR_STATUS.delegation_not_mine });
    expect(ERROR_STATUS.delegation_not_mine).toBe(400);
    const message = (refusal as ProposeRefusal).message;
    expect(message).toMatch(/names another agent/);
    for (const value of [other, PARENT_ID, TENANT, SKU, SUPPLIER_DID]) expect(message).not.toContain(value);
    expectUntouched(w);
    expect(w.supplierCalls).toStrictEqual([]);
    expect(await w.counter.next(TENANT)).toBe(1);
  });

  it('goes on for a delegation that names this agent: the twin', async () => {
    const w = world();
    proposed(await w.run());
    expect(w.supplierCalls).toHaveLength(1);
  });

  it('fails with ledger_unavailable when the delegation cannot be read, or the reading is not a reading, and sends nothing', async () => {
    for (const read of [
      async () => {
        throw new Error('the ledger is down');
      },
      async () => ({}) as never,
      async () => 'a text' as never,
    ]) {
      const w = world();
      w.script.delegation = read;
      expectFailed(await w.run(), 'ledger_unavailable');
      expectUntouched(w);
      expect(w.supplierCalls).toStrictEqual([]);
    }
  });

  it('goes on for a delegation that the first read does not show, because the read of the key decides: the key is found, and the run proposes', async () => {
    const w = world();
    w.script.delegation = async () => null;
    proposed(await w.run());
  });

  it('fails with delegation_not_found when the ledger shows no delegation and no key, and sends nothing', async () => {
    const w = world();
    w.script.delegation = async () => null;
    w.script.delegateKeyOf = async () => null;
    expectFailed(await w.run(), 'delegation_not_found');
    expectUntouched(w);
    expect(w.supplierCalls).toStrictEqual([]);
    expect(PROPOSE_FAILURES).toContain('delegation_not_found');
  });

  it('fails with deadline when the ledger gives no answer until the deadline, and does not call the next port', async () => {
    const w = world();
    w.script.delegation = () => new Promise(() => undefined);
    expectFailed(await w.run(), 'deadline');
    expect(w.clock.now() - NOW).toBe(1_620_000);
    expectUntouched(w);
    expect(w.supplierCalls).toStrictEqual([]);
  });
});

describe('the paying key', () => {
  it('fails with ledger_unavailable when the key of the delegation cannot be read, and sends nothing', async () => {
    const w = world();
    w.script.delegateKeyOf = async () => {
      throw new Error('the ledger is down');
    };
    expectFailed(await w.run(), 'ledger_unavailable');
    expectUntouched(w);
    expect(w.supplierCalls).toStrictEqual([]);
    expect(PROPOSE_FAILURES).toContain('ledger_unavailable');
  });

  it('fails with delegation_key_unknown for a key that this agent does not hold, and for a value that is no key hash, and sends nothing', async () => {
    for (const value of ['ee'.repeat(28), 42 as never]) {
      const w = world();
      w.script.delegateKeyOf = async () => value;
      expectFailed(await w.run(), 'delegation_key_unknown');
      expectUntouched(w);
      expect(w.supplierCalls).toStrictEqual([]);
    }
    expect(PROPOSE_FAILURES).toContain('delegation_key_unknown');
  });

  it('fails with internal when the table of the keys throws, and goes on when it holds the key: the twin', async () => {
    const w = world();
    w.script.findKey = () => {
      throw new Error('the table is broken');
    };
    expectFailed(await w.run(), 'internal');
    expectUntouched(w);
    proposed(await world().run());
  });
});

describe('the supplier', () => {
  const READER_CODES = ['supplier_not_listed', 'supplier_manifest_invalid', 'supplier_lots_invalid', 'sku_not_in_lots', 'supplier_unavailable'];

  it.each(READER_CODES)('fails with %s, the code of the reader, and sends nothing to the chain, and its words are not in the result', async (code) => {
    const w = world();
    w.script.readSupplier = async () => refused(code, 'words that the reader wrote');
    const result = await w.run();
    expectFailed(result, code);
    expect(JSON.stringify(result)).not.toContain('words that the reader wrote');
    expect(w.supplierCalls).toStrictEqual([{ supplier: SUPPLIER_DID, sku: SKU, chainCalls: 0 }]);
    expectUntouched(w);
  });

  it('does not take the words of a reader as a reason: a code that has the form of words is internal', async () => {
    const w = world();
    w.script.readSupplier = async () => refused('Not listed, sorry', 'words');
    expectFailed(await w.run(), 'internal');
    expectUntouched(w);
  });

  it('fails with internal when the reader gives no result at all, and sends nothing', async () => {
    for (const value of [undefined, null, 'a text']) {
      const w = world();
      w.script.readSupplier = async () => value as never;
      expectFailed(await w.run(), 'internal');
      expectUntouched(w);
    }
  });

  it('fails with internal when the reader throws, and with deadline when it gives no answer until the deadline', async () => {
    const throwing = world();
    throwing.script.readSupplier = async () => {
      throw new Error('the reader broke');
    };
    expectFailed(await throwing.run(), 'internal');
    expectUntouched(throwing);
    const silent = world();
    silent.script.readSupplier = () => new Promise(() => undefined);
    expectFailed(await silent.run(), 'deadline');
    expect(silent.clock.now() - NOW).toBe(1_620_000);
    expectUntouched(silent);
  });

  const WRONG: [string, unknown][] = [
    ['null', null],
    ['no adverts', { lots: LOTS }],
    ['no lots', { adverts: SUPPLIER.adverts }],
    ['a lot with no size', { adverts: SUPPLIER.adverts, lots: { 'lot-small': 10, 'lot-medium': 50 } }],
    ['a lot of the size 0', { adverts: SUPPLIER.adverts, lots: { ...LOTS, 'lot-large': 0 } }],
    ['a lot of a fractional size', { adverts: SUPPLIER.adverts, lots: { ...LOTS, 'lot-small': 1.5 } }],
    ['a lot of a size that is a text', { adverts: SUPPLIER.adverts, lots: { ...LOTS, 'lot-small': '10' } }],
    ['an advert with no reference', { adverts: { ...SUPPLIER.adverts, 'lot-small': {} }, lots: LOTS }],
    ['a lot with no advert', { adverts: { 'lot-small': SUPPLIER.adverts['lot-small'], 'lot-medium': SUPPLIER.adverts['lot-medium'] }, lots: LOTS }],
  ];
  it.each(WRONG)('fails with internal when the reader gives %s as a success, before anything is sent to the chain: the model is never asked with such a reading', async (_name, value) => {
    const w = world();
    w.script.readSupplier = async () => accepted(value as never);
    expectFailed(await w.run(), 'internal');
    expectUntouched(w);
  });

  it('reads the supplier of the request for the SKU of the request, once: the twin of every failure above', async () => {
    const w = world();
    w.script.fetch = async () => json({ ...STOCK, sku: 'SYR-10ML' });
    proposed(await w.run({ request: { sku: 'SYR-10ML' } }));
    expect(w.supplierCalls).toStrictEqual([{ supplier: SUPPLIER_DID, sku: 'SYR-10ML', chainCalls: 0 }]);
  });
});
