// agents/order-desk/test/job/record.test.ts: steps 1 and 2 of the job. The hook checks a request before the Claim and keeps a record with the hash of the request. The job takes that record by the escrow
// reference of its context, and it runs only for the body that the hook checked. A job with no record, or with the record of another body, ends with `precheck_missing` and writes nothing: it does not call the
// gateway, the portal, the model or the order book. The confirmation takes its sender, its approval and its 16 checks from the record. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { CONFIRMATION_CHECKS } from '@vsa/usecase-kit/inventory';
import type { Handoff, JsonValue } from '@vsa/usecase-kit/protocol';
import { makeRig, refusalOf } from './rig.ts';
import type { Rig } from './rig.ts';
import { ATTESTATION_ID, CHECKS, FACTS, ISSUER_DID, PURCHASE_ORDER, SENDER_DID, VALID_UNTIL, handoffOf, hashOf, purchaseOrder, recordFor } from './samples.ts';

/** Nothing was done after the record was taken: no call to the gateway, the portal, the model and the order book. */
function expectNothingDone(rig: Rig): void {
  expect(rig.events).toStrictEqual(['take']);
  expect(rig.gateway.requests).toHaveLength(0);
  expect(rig.portal.calls).toHaveLength(0);
  expect(rig.decideInputs).toHaveLength(0);
  expect(rig.booked).toHaveLength(0);
}

/** The twin of a refusal: the rig with no change gives its confirmation. */
async function expectTwinPasses(): Promise<void> {
  const rig = makeRig();
  expect(await rig.run()).toMatchObject({ outcome: 'done', order_id: 'SO-run1-0001' });
  expect(rig.portal.orders.size).toBe(1);
}

const without = <T extends Record<string, JsonValue>>(members: T, name: string): Record<string, JsonValue> => Object.fromEntries(Object.entries(members).filter(([key]) => key !== name));

describe('a job with no record', () => {
  it('is refused with precheck_missing (status 500), and nothing is called', async () => {
    const rig = makeRig();
    rig.entry = null;
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'precheck_missing', status: 500, kind: 'job', message: 'The job has no record of passed checks for this request.' });
    expectNothingDone(rig);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('precheck_missing');
    await expectTwinPasses();
  });

  it('takes the record by the escrow reference of its context, and by nothing else', async () => {
    const rig = makeRig();
    rig.entry = null;
    await refusalOf(rig.run());
    expect(rig.takes).toStrictEqual([rig.context.escrowRef]);
  });

  it('takes the record one time: a second job for the same escrow finds none, so the portal holds one order', async () => {
    const rig = makeRig({ oneShot: true });
    await rig.run();
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'precheck_missing', status: 500 });
    expect(rig.portal.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(rig.portal.orders.size).toBe(1);
    expect(rig.booked).toHaveLength(1);
  });
});

describe('a record of another body is no record', () => {
  const bodies: ReadonlyArray<readonly [string, () => Handoff]> = [
    ['another document', () => handoffOf(purchaseOrder({ quantity: 49 }))],
    ['another purchase order number', () => handoffOf(purchaseOrder({ po_number: 'run1-0002' }))],
    ['another salt', () => handoffOf(PURCHASE_ORDER, { salt: '9b'.repeat(32) })],
    ['another issuer in the approval reference', () => handoffOf(PURCHASE_ORDER, { approval: { attestation: ATTESTATION_ID, issuer_did: `did:vector:${'f3'.repeat(32)}` } })],
    ['another attestation in the approval reference', () => handoffOf(PURCHASE_ORDER, { approval: { attestation: '9c'.repeat(32), issuer_did: ISSUER_DID } })],
    ['no approval reference', () => handoffOf(PURCHASE_ORDER, { approval: null })],
    ['another sender', () => handoffOf(PURCHASE_ORDER, { sender_did: `did:vector:${'f4'.repeat(32)}` })],
    ['another delegation', () => handoffOf(PURCHASE_ORDER, { delegation: '5f'.repeat(32) })],
  ];

  it.each(bodies)('%s: precheck_missing, and nothing is called', async (_what, make) => {
    const rig = makeRig();
    const other = make();
    expect(hashOf(other)).not.toBe(hashOf(rig.request));
    expect(await refusalOf(rig.run({ request: other }))).toMatchObject({ code: 'precheck_missing', status: 500 });
    expectNothingDone(rig);
    expect(rig.logs[0]).toContain('another request');
  });

  it('is the case when the record names the right escrow and the body is the one of another job: the same escrow with another document', async () => {
    const rig = makeRig();
    const other = handoffOf(purchaseOrder({ sku: 'SYR-10ML', quantity: 100 }));
    expect(await refusalOf(rig.run({ request: other }))).toMatchObject({ code: 'precheck_missing' });
    expect(rig.portal.orders.size).toBe(0);
  });

  it('twin: the same body, parsed again from its text, passes', async () => {
    const rig = makeRig();
    expect(await rig.run({ request: handoffOf() })).toMatchObject({ outcome: 'done' });
    expect(rig.portal.orders.size).toBe(1);
  });
});

describe('the hash of the record', () => {
  const right = hashOf(handoffOf());

  it.each([
    ['another hash', 'cd'.repeat(32)],
    ['the right hash in upper case', right.toUpperCase()],
    ['the right hash with a space before it', ` ${right}`],
    ['the empty text', ''],
    ['a number', 7 as never],
    ['null', null as never],
  ])('%s is refused with precheck_missing, and nothing is called', async (_what, hash) => {
    const rig = makeRig();
    rig.entry = { ...recordFor(rig.request), request_sha256: hash };
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'precheck_missing', status: 500 });
    expectNothingDone(rig);
  });

  it('twin: the right hash passes', async () => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { request_sha256: right });
    expect(await rig.run()).toMatchObject({ outcome: 'done' });
  });

  it('is the hash of the whole body: a document of the same purchase order with the same hash in the record of another body is refused', async () => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { request_sha256: hashOf(rig.request.document) });
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'precheck_missing' });
  });
});

describe('the record itself', () => {
  it.each([
    ['null', null],
    ['a text', 'record'],
    ['a record with no checks', { facts: FACTS }],
    ['a record with no facts', { checks: CHECKS }],
    ['checks that are a list', { checks: [], facts: FACTS }],
    ['facts that are null', { checks: CHECKS, facts: null }],
  ])('%s is no record: precheck_missing, and nothing is called', async (_what, record) => {
    const rig = makeRig();
    rig.entry = { record: record as never, request_sha256: hashOf(rig.request) };
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'precheck_missing', status: 500 });
    expectNothingDone(rig);
  });
});

describe('the 16 checks', () => {
  it.each(CONFIRMATION_CHECKS)('a record without the check %s is refused with precheck_missing, and the log names the check', async (name) => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { checks: Object.fromEntries(Object.entries(CHECKS).filter(([key]) => key !== name)) });
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'precheck_missing', status: 500 });
    expect(refusal.message).not.toContain(name);
    expect(rig.logs[0]).toContain(`the check ${name}`);
    expectNothingDone(rig);
  });

  it.each([
    ['false', false],
    ['the text true', 'true'],
    ['the number 1', 1],
    ['null', null],
  ])('a check with the value %s is no passed check', async (_what, value) => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { checks: { ...CHECKS, quantity: value as never } });
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'precheck_missing' });
    expectNothingDone(rig);
  });

  it('twin: a record with all 16 checks passes, and the confirmation holds the 16 names in their order, whatever the order and the extras of the record', async () => {
    const rig = makeRig();
    const reversed = Object.fromEntries(Object.entries(CHECKS).reverse());
    rig.entry = recordFor(rig.request, { checks: { extra_check: true, ...reversed } });
    const confirmation = await rig.run();
    expect(Object.keys(confirmation.checks)).toStrictEqual([...CONFIRMATION_CHECKS]);
    expect(Object.values(confirmation.checks).every((value) => value === true)).toBe(true);
  });
});

describe('the facts of the record', () => {
  const unusable: ReadonlyArray<readonly [string, Record<string, JsonValue>, string]> = [
    ['no organisation', without(FACTS, 'organisation'), 'organisation'],
    ['an organisation that is a number', { ...FACTS, organisation: 5 }, 'organisation'],
    ['an organisation that is an object', { ...FACTS, organisation: { name: 'x' } }, 'organisation'],
    ['no organisation_verified', without(FACTS, 'organisation_verified'), 'organisation_verified'],
    ['an organisation_verified that is the text true', { ...FACTS, organisation_verified: 'true' }, 'organisation_verified'],
    ['an organisation_verified that is 1', { ...FACTS, organisation_verified: 1 }, 'organisation_verified'],
    ['an organisation_verified that is null', { ...FACTS, organisation_verified: null }, 'organisation_verified'],
    ['no attestation', without(FACTS, 'approval_attestation'), 'approval_attestation'],
    ['an attestation of 63 characters', { ...FACTS, approval_attestation: '9b'.repeat(31) + '9' }, 'approval_attestation'],
    ['an attestation in upper case', { ...FACTS, approval_attestation: '9B'.repeat(32) }, 'approval_attestation'],
    ['an attestation that is a number', { ...FACTS, approval_attestation: 9 }, 'approval_attestation'],
    ['no issuer DID', without(FACTS, 'approval_issuer_did'), 'approval_issuer_did'],
    ['an issuer that is not a DID', { ...FACTS, approval_issuer_did: 'did:other:abc' }, 'approval_issuer_did'],
    ['an issuer that is a number', { ...FACTS, approval_issuer_did: 3 }, 'approval_issuer_did'],
    ['no end of the approval', without(FACTS, 'approval_valid_until'), 'approval_valid_until'],
    ['an end of the approval that is a text', { ...FACTS, approval_valid_until: VALID_UNTIL }, 'approval_valid_until'],
    ['an end of the approval that is not a whole number', { ...FACTS, approval_valid_until: 1.5 }, 'approval_valid_until'],
    ['an end of the approval beyond the times that a date holds', { ...FACTS, approval_valid_until: Number.MAX_SAFE_INTEGER }, 'approval_valid_until'],
    ['an end of the approval that is true', { ...FACTS, approval_valid_until: true }, 'approval_valid_until'],
  ];

  it.each(unusable)('%s: precheck_missing, the log names the fact, and nothing is called', async (_what, facts, name) => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { facts });
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'precheck_missing', status: 500 });
    expect(rig.logs[0]).toContain(`the fact ${name}`);
    expectNothingDone(rig);
  });

  it('twin: the sender with no organisation, an issuer with no record and an approval with no end pass, and each gives null', async () => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { facts: { ...FACTS, organisation: null, organisation_verified: false, approval_issuer_did: null, approval_valid_until: null } });
    const confirmation = await rig.run();
    expect(confirmation.sender).toStrictEqual({ did: SENDER_DID, organisation: null, organisation_verified: false });
    expect(confirmation.approval).toStrictEqual({ attestation: ATTESTATION_ID, issuer_did: null, valid_until: null });
  });

  it.each([
    ['the start of 1970', 0, '1970-01-01T00:00:00.000Z'],
    ['a time before 1970', -1, '1969-12-31T23:59:59.999Z'],
    ['a time with milliseconds', Date.UTC(2026, 10, 24, 10, 0, 0, 7), '2026-11-24T10:00:00.007Z'],
    ['a year after 9999', Date.UTC(10_000, 0, 1), '+010000-01-01T00:00:00.000Z'],
  ])('writes the end of the approval for %s as the time that toISOString writes', async (_what, end, text) => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { facts: { ...FACTS, approval_valid_until: end } });
    expect((await rig.run()).approval.valid_until).toBe(text);
  });

  it('takes the sender of the confirmation from the handoff, as the checks of the hook did', async () => {
    const other = `did:vector:${'f4'.repeat(32)}`;
    const rig = makeRig();
    const request = handoffOf(PURCHASE_ORDER, { sender_did: other });
    rig.entry = recordFor(request);
    expect((await rig.run({ request })).sender.did).toBe(other);
  });
});

describe('the purchase order of the handoff', () => {
  it('must be a purchase order: a document that is not one is a fault of the service, internal (500), and nothing is called', async () => {
    const rig = makeRig();
    const bad = handoffOf(purchaseOrder({ quantity: 0 }));
    rig.entry = recordFor(bad);
    const refusal = await refusalOf(rig.run({ request: bad }));
    expect(refusal).toMatchObject({ code: 'internal', status: 500 });
    expect(rig.logs[0]).toContain('purchase order');
    expectNothingDone(rig);
  });

  it('twin: an order of one unit is a purchase order, and the job places it as it is', async () => {
    const rig = makeRig();
    const small = handoffOf(purchaseOrder({ quantity: 1 }));
    rig.entry = recordFor(small);
    const confirmation = await rig.run({ request: small });
    expect(confirmation.quantity).toBe(1);
    expect(rig.portal.orders.size).toBe(1);
  });
});
