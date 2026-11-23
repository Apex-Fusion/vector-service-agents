// agents/order-desk/test/job/fault-run.test.ts: the fault `confirm_wrong_lot` in the job. With the fault the order that the job places and the confirmation that it returns name the wrong lot and its size, and
// the hash of the purchase order is still the hash of the real order. With the empty setting the lot is the ordered lot. The fault changes WHAT the job sends and never a check, never what the model is asked,
// and never whether the model must confirm. The fault value is in the confirmation, and in no log line and no text of a refusal. The question: can the fault be on with an empty setting, and can a result lack it?
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withFaultModeJob } from '@vsa/usecase-kit/fault';
import { parseLotsFile, parseOrderConfirmation } from '@vsa/usecase-kit/inventory';
import { accepted } from '@vsa/usecase-kit/protocol';
import type { Handoff } from '@vsa/usecase-kit/protocol';
import { runOrder, wrongLotOf } from '../../src/job/index.ts';
import type { OrderDeps } from '../../src/job/index.ts';
import { json, makeRig, refusalOf, sentOrder } from './rig.ts';
import type { Rig } from './rig.ts';
import { CHECKS, PURCHASE_ORDER_SHA256, decisionOf, failureOf, hashOf, purchaseOrder, recordFor } from './samples.ts';

const golden = (name: string): unknown => JSON.parse(readFileSync(new URL(`./golden/${name}.json`, import.meta.url), 'utf8'));
const posts = (rig: Rig): number => rig.portal.calls.filter((call) => call.method === 'POST').length;

describe('the job with the fault confirm_wrong_lot', () => {
  it('names the wrong lot and its size in the order and in the confirmation, and the confirmation is the golden file', async () => {
    const rig = makeRig({ mode: 'confirm_wrong_lot' });
    const confirmation = await rig.run();
    expect(confirmation).toStrictEqual(golden('confirmation-wrong-lot'));
    expect(parseOrderConfirmation(confirmation)).toStrictEqual({ ok: true, value: confirmation });
    expect(sentOrder(rig.portal)).toStrictEqual({ po_number: 'run1-0001', po_sha256: PURCHASE_ORDER_SHA256, sku: 'GLV-NIT-M', lot: 'lot-small', quantity: 10, ship_by: '2026-11-28' });
    expect(rig.portal.orders.get('run1-0001')).toMatchObject({ lot: 'lot-small', quantity: 10 });
    expect(rig.booked).toStrictEqual([['run1', 'run1-0001', 'SO-run1-0001']]);
  });

  it('keeps the hash of the real order in the order and in the confirmation: it is not the hash of an order with the wrong lot', async () => {
    const rig = makeRig({ mode: 'confirm_wrong_lot' });
    const confirmation = await rig.run();
    expect(confirmation.po_sha256).toBe(PURCHASE_ORDER_SHA256);
    expect(confirmation.po_sha256).toBe(hashOf(rig.request.document));
    expect(sentOrder(rig.portal).po_sha256).toBe(PURCHASE_ORDER_SHA256);
    expect(hashOf(purchaseOrder({ lot: 'lot-small', quantity: 10 }))).not.toBe(confirmation.po_sha256);
  });

  it('names the value in fault_mode of the confirmation, and the stamp of the service gives the same confirmation', async () => {
    const rig = makeRig({ mode: 'confirm_wrong_lot' });
    const stamped = withFaultModeJob(rig.fault, (request: Handoff) => rig.run({ request }));
    const confirmation = await stamped(rig.request);
    expect(confirmation.fault_mode).toBe('confirm_wrong_lot');
    expect(confirmation).toStrictEqual(golden('confirmation-wrong-lot'));
  });

  const CASES = [
    ['lot-small', 10, 'lot-medium', 50],
    ['lot-medium', 50, 'lot-small', 10],
    ['lot-large', 200, 'lot-small', 10],
  ] as const;

  it.each(CASES)('for an order of %s (%s units) the fault orders and confirms %s (%s units)', async (lot, quantity, wrong, size) => {
    expect(wrongLotOf(lot)).toBe(wrong);
    const rig = makeRig({ mode: 'confirm_wrong_lot', order: { lot, quantity } });
    const confirmation = await rig.run();
    expect(confirmation).toMatchObject({ lot: wrong, quantity: size, fault_mode: 'confirm_wrong_lot' });
    expect(sentOrder(rig.portal)).toMatchObject({ lot: wrong, quantity: size });
    expect(rig.portal.orders.size).toBe(1);
  });

  it.each(CASES)('twin: for an order of %s (%s units) the empty setting orders and confirms the lot of the purchase order', async (lot, quantity) => {
    const rig = makeRig({ mode: '', order: { lot, quantity } });
    const confirmation = await rig.run();
    expect(confirmation).toMatchObject({ lot, quantity, fault_mode: '' });
    expect(sentOrder(rig.portal)).toMatchObject({ lot, quantity });
  });

  it('changes nothing else: the same confirmation but the lot, the quantity and the fault value, the same order but the lot and the quantity, and the same question to the model', async () => {
    const clean = makeRig({ mode: '' });
    const faulty = makeRig({ mode: 'confirm_wrong_lot' });
    const { lot: _cleanLot, quantity: _cleanQuantity, fault_mode: _cleanMode, ...cleanRest } = await clean.run();
    const { lot: _faultLot, quantity: _faultQuantity, fault_mode: _faultMode, ...faultRest } = await faulty.run();
    expect(faultRest).toStrictEqual(cleanRest);
    const { lot: _l1, quantity: _q1, ...cleanOrder } = sentOrder(clean.portal);
    const { lot: _l2, quantity: _q2, ...faultOrder } = sentOrder(faulty.portal);
    expect(faultOrder).toStrictEqual(cleanOrder);
    expect(faulty.decideInputs).toStrictEqual(clean.decideInputs);
    expect(faulty.events).toStrictEqual(clean.events);
    expect(faulty.portal.calls.map((call) => call.url)).toStrictEqual(clean.portal.calls.map((call) => call.url));
  });

  it('places no order that the model did not confirm: a model that says no ends the job with cannot_supply, with the fault too', async () => {
    const rig = makeRig({ mode: 'confirm_wrong_lot' });
    rig.decision = accepted(decisionOf({ confirm: false, note: 'The item is discontinued.' }));
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'cannot_supply', status: 403 });
    expect(posts(rig)).toBe(0);
    expect(rig.portal.orders.size).toBe(0);
    expect(rig.booked).toHaveLength(0);
  });

  it('has no size for the wrong lot of a SKU that the lots file does not list: internal (500) before the order, and the twin with the empty setting does not read the lots file', async () => {
    const lots = parseLotsFile({ schema: 'vector.usecase.lots.v1', items: [{ sku: 'SYR-10ML', lots: { 'lot-small': 25, 'lot-medium': 100, 'lot-large': 400 } }] });
    if (!lots.ok) throw new Error(lots.detail);
    const faulty = makeRig({ mode: 'confirm_wrong_lot', lots: lots.value });
    expect(await refusalOf(faulty.run())).toMatchObject({ code: 'internal', status: 500 });
    expect(faulty.events).toStrictEqual(['take', 'svid', 'catalogue', 'decide']);
    expect(posts(faulty)).toBe(0);
    expect(faulty.booked).toHaveLength(0);
    expect(faulty.logs[0]).toContain('lots file');
    const clean = makeRig({ mode: '', lots: lots.value });
    expect(await clean.run()).toMatchObject({ outcome: 'done', lot: 'lot-medium', quantity: 50 });
  });
});

describe('the fault changes no check', () => {
  const scenarios: ReadonlyArray<readonly [string, (rig: Rig) => void]> = [
    ['no record', (rig) => { rig.entry = null; }],
    ['a record of another body', (rig) => { rig.entry = recordFor(rig.request, { request_sha256: 'cd'.repeat(32) }); }],
    ['a record without a check', (rig) => { rig.entry = recordFor(rig.request, { checks: Object.fromEntries(Object.entries(CHECKS).filter(([name]) => name !== 'lot')) }); }],
    ['a gateway that refuses', (rig) => { rig.gateway.setStatus(rig.agent, 'suspended'); }],
    ['a catalogue that fails', (rig) => { rig.portal.catalogue = json(500, { error: 'internal' }); }],
    ['a decision that fails', (rig) => { rig.decision = failureOf('inference_failed'); }],
    ['a decision of a shape that is not the shape of the confirmation', (rig) => { rig.decision = accepted(decisionOf({ ship_by: 'tomorrow' })); }],
    ['a model that does not confirm', (rig) => { rig.decision = accepted(decisionOf({ confirm: false, note: 'The item is discontinued.' })); }],
    ['a number that the portal holds', (rig) => { rig.portal.preplace('run1-0001'); }],
    ['a portal that fails at the order', (rig) => { rig.portal.order = json(503, { error: 'service_busy' }); }],
    ['an order book that fails', (rig) => { rig.bookError = new Error('the book is full'); }],
  ];

  it.each(scenarios)('%s ends the same with the fault on and off, and the fault value is in no log line and in no text', async (_what, change) => {
    const ends = [];
    for (const mode of ['', 'confirm_wrong_lot'] as const) {
      const rig = makeRig({ mode });
      change(rig);
      const refusal = await refusalOf(rig.run());
      ends.push({ code: refusal.code, status: refusal.status, message: refusal.message, events: rig.events, posts: posts(rig), orders: rig.portal.orders.size, booked: rig.booked.length });
      expect([...rig.logs, refusal.message].join('\n')).not.toMatch(/confirm_wrong_lot|wrong lot/i);
    }
    expect(ends[1]).toStrictEqual(ends[0]);
  });

  it('writes no log line that names the fault value for a job that passes, and the value is in the confirmation', async () => {
    const rig = makeRig({ mode: 'confirm_wrong_lot' });
    const confirmation = await rig.run();
    expect(rig.logs.join('\n')).not.toMatch(/confirm_wrong_lot|wrong lot/i);
    expect(JSON.stringify(confirmation)).toContain('confirm_wrong_lot');
  });
});

describe('the value of the setting', () => {
  it('is in every confirmation, as its last member: the empty text for a clean run and the fault value for a fault run', async () => {
    for (const mode of ['', 'confirm_wrong_lot'] as const) {
      const rig = makeRig({ mode });
      const confirmation = await rig.run();
      expect(confirmation.fault_mode).toBe(rig.fault.mode);
      expect(confirmation.fault_mode).toBe(mode);
      expect(Object.keys(confirmation).at(-1)).toBe('fault_mode');
    }
  });

  it('is read one time, so a value that changes later cannot make an order of one kind with a result of another', async () => {
    for (const [first, later] of [['', 'confirm_wrong_lot'], ['confirm_wrong_lot', '']] as const) {
      const rig = makeRig();
      let reads = 0;
      const changing = { kind: 'order-desk', get mode() { reads += 1; return reads === 1 ? first : later; } };
      const deps: OrderDeps = { ...rig.deps, fault: changing as never };
      const confirmation = await runOrder(deps, rig.request, rig.context, rig.gateway.now());
      expect(reads).toBe(1);
      expect(confirmation.fault_mode).toBe(first);
      const wrong = first === 'confirm_wrong_lot';
      expect(confirmation).toMatchObject({ lot: wrong ? 'lot-small' : 'lot-medium', quantity: wrong ? 10 : 50 });
      expect(sentOrder(rig.portal)).toMatchObject({ lot: wrong ? 'lot-small' : 'lot-medium', quantity: wrong ? 10 : 50 });
    }
  });

  it('comes only from the switch that readFaultSwitch made: an object that a caller wrote by hand does not compile as a switch', () => {
    // @ts-expect-error a hand-made object lacks the sealed member of a fault switch
    const handMade: OrderDeps['fault'] = { kind: 'order-desk', mode: 'confirm_wrong_lot' };
    expect(handMade.mode).toBe('confirm_wrong_lot');
  });

  it('is not turned on by the request: a purchase order that holds the fault value in its number, with the empty setting, orders the lot of the purchase order', async () => {
    const rig = makeRig({ mode: '', order: { po_number: 'confirm_wrong_lot' } });
    expect(await rig.run()).toMatchObject({ lot: 'lot-medium', quantity: 50, fault_mode: '' });
    expect(sentOrder(rig.portal)).toMatchObject({ lot: 'lot-medium', quantity: 50, po_number: 'confirm_wrong_lot' });
  });
});
