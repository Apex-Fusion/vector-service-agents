// agents/order-desk/test/job/order.test.ts: steps 6 to 8 of the job. The job places the order with the SVID: the lot and the quantity of the purchase order, and the date of the model. The portal gives the id of the
// order. A refusal of the portal for a number that it holds (409, `duplicate_po`) is `duplicate_po` (403). Any other refusal or failure is `mock_system_failed` (502). The order book is written AFTER the portal took
// the order, and never on a refusal. A book that cannot be written ends the job with `store_write_failed` (500). A job writes at most one order. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { accepted } from '@vsa/usecase-kit/protocol';
import { runOrder } from '../../src/job/index.ts';
import { expectNoSecrets, json, makeRig, refusalOf, sentOrder } from './rig.ts';
import type { Reply, Rig } from './rig.ts';
import { PURCHASE_ORDER_SHA256, decisionOf } from './samples.ts';

const posts = (rig: Rig): number => rig.portal.calls.filter((call) => call.method === 'POST').length;

/** The job stopped at the order call: the order was sent one time, and the order book got nothing. */
function expectStoppedAtOrder(rig: Rig): void {
  expect(rig.events).toStrictEqual(['take', 'svid', 'catalogue', 'decide', 'order']);
  expect(posts(rig)).toBe(1);
  expect(rig.booked).toHaveLength(0);
}

describe('the order', () => {
  it('has the lot and the quantity of the purchase order, its SKU and number, the hash of the purchase order, and the date of the model', async () => {
    const rig = makeRig({ order: { lot: 'lot-large', quantity: 200, po_number: 'run1-0009' } });
    const confirmation = await rig.run();
    expect(sentOrder(rig.portal)).toStrictEqual({
      po_number: 'run1-0009', po_sha256: confirmation.po_sha256, sku: 'GLV-NIT-M', lot: 'lot-large', quantity: 200, ship_by: '2026-11-28',
    });
    expect(confirmation).toMatchObject({ lot: 'lot-large', quantity: 200, po_number: 'run1-0009' });
    expect(rig.booked).toStrictEqual([['run1', 'run1-0009', 'SO-run1-0001']]);
  });

  it('is sent with the date that the model chose, and with no other date', async () => {
    const rig = makeRig();
    rig.decision = accepted(decisionOf({ ship_by: '2027-01-15' }));
    const confirmation = await rig.run();
    expect(sentOrder(rig.portal).ship_by).toBe('2027-01-15');
    expect(confirmation.ship_by).toBe('2027-01-15');
  });

  it('is sent to the tenant of the purchase order', async () => {
    const rig = makeRig({ order: { tenant: 'run7', po_number: 'run7-0001' } });
    const confirmation = await rig.run();
    expect(rig.portal.calls.map((call) => call.url)).toStrictEqual([
      'https://mock-mtls.example/t/run7/supplier/catalogue/GLV-NIT-M', 'https://mock-mtls.example/t/run7/supplier/orders',
    ]);
    expect(confirmation.order_id).toBe('SO-run7-0001');
    expect(rig.booked).toStrictEqual([['run7', 'run7-0001', 'SO-run7-0001']]);
  });

  it('is the one order of the job: the portal gets one POST, and a job that fails after it gets no second one', async () => {
    const ok = makeRig();
    await ok.run();
    expect(posts(ok)).toBe(1);
    const failed = makeRig();
    failed.bookError = new Error('the book is full');
    await refusalOf(failed.run());
    expect(posts(failed)).toBe(1);
    expect(failed.portal.orders.size).toBe(1);
  });
});

describe('a purchase order number that the portal holds', () => {
  it('is refused with duplicate_po (403), the order book is not written, and the log keeps the status and the code of the portal', async () => {
    const rig = makeRig();
    rig.portal.preplace('run1-0001');
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'duplicate_po', status: 403, kind: 'job', message: 'The supplier portal already holds an order for this purchase order number.' });
    expectStoppedAtOrder(rig);
    expect(rig.portal.orders.size).toBe(1);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('duplicate_po');
    expect(rig.logs[0]).toContain('409');
    expect(refusal.message).not.toContain('run1-0001');
  });

  it('is refused also when the portal holds the number in other letters: the portal counts a number without regard to case', async () => {
    const rig = makeRig();
    rig.portal.preplace('RUN1-0001');
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'duplicate_po', status: 403 });
    expectStoppedAtOrder(rig);
  });

  it('twin: a number that the portal does not hold is placed, and the order book holds it', async () => {
    const rig = makeRig();
    rig.portal.preplace('run1-0002');
    expect(await rig.run()).toMatchObject({ outcome: 'done', po_number: 'run1-0001' });
    expect(rig.portal.orders.size).toBe(2);
    expect(rig.booked).toHaveLength(1);
  });

  it.each([
    ['the status 409 with another code', json(409, { error: 'tenant_changed', message: 'x' }), 'tenant_changed'],
    ['the status 403 with the code duplicate_po', json(403, { error: 'duplicate_po', message: 'x' }), 'duplicate_po'],
    ['the status 500 with the code duplicate_po', json(500, { error: 'duplicate_po', message: 'x' }), 'duplicate_po'],
    ['the status 409 with no code', json(409, { message: 'x' }), 'status 409'],
    ['the status 409 with a body that is not JSON', { status: 409, body: 'conflict' }, 'status 409'],
  ] as ReadonlyArray<readonly [string, Reply, string]>)('is not a duplicate for %s: mock_system_failed (502)', async (_what, reply, logged) => {
    const rig = makeRig();
    rig.portal.order = reply;
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'mock_system_failed', status: 502 });
    expectStoppedAtOrder(rig);
    expect(rig.logs[0]).toContain(logged);
  });
});

describe('a portal that does not take the order', () => {
  const failures: ReadonlyArray<readonly [string, Reply, string]> = [
    ['a refusal of the certificate (401)', json(401, { error: 'svid_invalid', message: 'the certificate is not valid' }), 'svid_invalid'],
    ['a refusal of the organisation (403)', json(403, { error: 'organisation_mismatch', message: 'x' }), 'organisation_mismatch'],
    ['an item that is not in the catalogue (404)', json(404, { error: 'sku_not_found', message: 'x' }), 'sku_not_found'],
    ['an order with other members (400)', json(400, { error: 'bad_request', message: 'x' }), 'bad_request'],
    ['a failure of the portal (500)', json(500, { error: 'internal', message: 'x' }), 'status 500'],
    ['a portal that is busy (503)', json(503, { error: 'service_busy' }), 'service_busy'],
    ['an answer 201 that is not JSON', { status: 201, body: 'created' }, 'status 201'],
    ['an answer 201 with no order id', json(201, { po_number: 'run1-0001', status: 'placed' }), 'order id'],
    ['an answer 201 with an order id that is a number', json(201, { order_id: 5 }), 'order id'],
    ['an answer 201 with an empty order id', json(201, { order_id: '' }), 'order id'],
    ['an answer 201 with an order id of 65 characters', json(201, { order_id: 'S'.repeat(65) }), 'order id'],
    ['an answer 201 that is a list', json(201, [{ order_id: 'SO-run1-0001' }]), 'order id'],
    ['no answer at all', { throws: new Error('socket hang up at 203.0.113.9:443') }, 'no answer'],
  ];

  it.each(failures)('%s ends the job with mock_system_failed (502), writes nothing to the order book, and keeps the code of the portal in the log', async (_what, reply, logged) => {
    const rig = makeRig();
    rig.portal.order = reply;
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'mock_system_failed', status: 502, kind: 'job', message: 'The supplier portal did not take the call.' });
    expectStoppedAtOrder(rig);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('mock_system_failed');
    expect(rig.logs[0]).toContain(logged);
    expect(rig.logs[0]).not.toContain('203.0.113.9');
    expect(refusal.message).not.toContain(logged);
    expectNoSecrets(rig, [...rig.logs, refusal.message]);
  });

  it('says in the log that the order may exist when no answer came for it', async () => {
    const rig = makeRig();
    rig.portal.order = { throws: new Error('socket hang up') };
    await refusalOf(rig.run());
    expect(rig.logs[0]).toContain('may exist');
  });

  it('twin: the portal that answers 201 with an id gives the confirmation, and the order book holds the id that the portal gave', async () => {
    const rig = makeRig();
    rig.portal.order = json(201, { order_id: 'SO-run1-0042', po_number: 'run1-0001', status: 'placed', recorded_at: '2026-11-23T12:00:00.000Z' });
    const confirmation = await rig.run();
    expect(confirmation.order_id).toBe('SO-run1-0042');
    expect(rig.booked).toStrictEqual([['run1', 'run1-0001', 'SO-run1-0042']]);
  });
});

describe('the order book', () => {
  it('is written after the portal took the order, with the tenant, the purchase order number and the id that the portal gave', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.events.slice(-2)).toStrictEqual(['order', 'book']);
    expect(rig.booked).toStrictEqual([['run1', 'run1-0001', 'SO-run1-0001']]);
  });

  it('is not written for a refusal or a failure of the portal, nor for a model that does not confirm: the twin of the golden run', async () => {
    const duplicate = makeRig();
    duplicate.portal.preplace('run1-0001');
    await refusalOf(duplicate.run());
    const failed = makeRig();
    failed.portal.order = json(500, { error: 'internal' });
    await refusalOf(failed.run());
    expect(duplicate.booked).toHaveLength(0);
    expect(failed.booked).toHaveLength(0);
    expect(duplicate.events).not.toContain('book');
    expect(failed.events).not.toContain('book');
  });

  it('ends the job with store_write_failed (500) when it cannot be written: the order exists at the portal, and the log says so', async () => {
    const rig = makeRig();
    rig.bookError = new TypeError('disk full at /var/lib/secret-folder/orders.json');
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'store_write_failed', status: 500, kind: 'job', message: 'The order book could not record the order.' });
    expect(rig.events).toStrictEqual(['take', 'svid', 'catalogue', 'decide', 'order', 'book']);
    expect(rig.portal.orders.size).toBe(1);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('store_write_failed');
    expect(rig.logs[0]).toContain('SO-run1-0001');
    expect(rig.logs[0]).toContain('TypeError');
    expect(rig.logs[0]).toContain('holds the order');
    expect(rig.logs[0]).not.toContain('secret-folder');
    expect(refusal.message).not.toContain('secret-folder');
  });

  it('ends the job with store_write_failed also for a book that throws at once, and for a book that throws a value that is not an error', async () => {
    const sync = makeRig();
    const syncDeps = { ...sync.deps, book: { record: (): Promise<void> => { throw new Error('sync'); } } };
    expect(await refusalOf(runOrder(syncDeps, sync.request, sync.context, sync.gateway.now()))).toMatchObject({ code: 'store_write_failed', status: 500 });
    const odd = makeRig();
    const oddDeps = { ...odd.deps, book: { record: (): Promise<void> => Promise.reject('a text') } };
    expect(await refusalOf(runOrder(oddDeps, odd.request, odd.context, odd.gateway.now()))).toMatchObject({ code: 'store_write_failed', status: 500 });
    expect(odd.logs[0]).toContain('string');
  });

  it('twin: a book that can be written gives the confirmation', async () => {
    const rig = makeRig();
    expect(await rig.run()).toMatchObject({ outcome: 'done' });
  });
});

describe('the confirmation', () => {
  it('is checked by the parser of the kit after the order too: an order id that the confirmation cannot hold ends the job with internal (500), and the order and the order book keep the id', async () => {
    const rig = makeRig();
    rig.portal.order = json(201, { order_id: 'has a space', po_number: 'run1-0001', status: 'placed' });
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'internal', status: 500 });
    expect(rig.events).toStrictEqual(['take', 'svid', 'catalogue', 'decide', 'order', 'book']);
    expect(rig.booked).toStrictEqual([['run1', 'run1-0001', 'has a space']]);
    expect(rig.logs[0]).toContain('order_id');
    expect(rig.logs[0]).toContain('has a space');
  });

  it('twin: an order id of the form that the portal gives is held', async () => {
    const rig = makeRig();
    rig.portal.order = json(201, { order_id: 'SO.run1_0001-a', po_number: 'run1-0001', status: 'placed' });
    expect((await rig.run()).order_id).toBe('SO.run1_0001-a');
  });

  it('holds the hash of the purchase order as it was received, in the order and in the confirmation', async () => {
    const rig = makeRig();
    const confirmation = await rig.run();
    expect(confirmation.po_sha256).toBe(PURCHASE_ORDER_SHA256);
    expect(sentOrder(rig.portal).po_sha256).toBe(PURCHASE_ORDER_SHA256);
  });
});
