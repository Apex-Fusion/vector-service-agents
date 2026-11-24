// agents/bid-desk/test/job/record.test.ts: step 1 of the job. The hook checks a request before the Claim and keeps a record with the hash of the request. The job takes that record by the escrow reference of its
// context, and it runs only for the body that the hook checked. A job with no record, or with the record of another body, ends with `precheck_missing` and writes nothing: it does not ask the model, the book or
// the gateway. The quote takes its sender and its 7 checks from the record, so a record that lacks a check, or holds a fact that cannot be read, is no record. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { QUOTE_CHECKS } from '@vsa/usecase-kit/bids';
import type { RfqMessage } from '@vsa/usecase-kit/protocol';
import { PASSED_CHECKS_TTL_MS, PassedChecks } from '../../src/checks/index.ts';
import { runQuote } from '../../src/job/index.ts';
import { expectNothingRecorded, makeRig, refusalOf } from './rig.ts';
import type { Rig } from './rig.ts';
import { CHECKS, DELEGATION, ESCROW_REF, FACTS, RFQ_VALUE, SENDER_DID, T0, hashOf, messageOf, recordFor } from './samples.ts';

/** Nothing was done after the record was taken: no model hire, no read of the book, no credential, and no record in the book. */
function expectNothingDone(rig: Rig): void {
  expect(rig.events).toStrictEqual(['take']);
  expect(rig.decideInputs).toHaveLength(0);
  expect(rig.credentialAsks).toHaveLength(0);
  expectNothingRecorded(rig);
}

/** The twin of a refusal: the rig with no change gives its quote. */
async function expectTwinPasses(): Promise<void> {
  const rig = makeRig();
  expect(await rig.run()).toMatchObject({ outcome: 'done', rfq_id: 'run1-rfq-1' });
  expect(rig.booked).toHaveLength(1);
}

describe('a job with no record', () => {
  it('is refused with precheck_missing (status 500), and nothing is asked', async () => {
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

  it('takes the record one time: a second job for the same escrow finds none, so the book holds one quote', async () => {
    const rig = makeRig({ oneShot: true });
    await rig.run();
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'precheck_missing', status: 500 });
    expect(rig.booked).toHaveLength(1);
    expect(rig.decideInputs).toHaveLength(1);
  });
});

describe('a record of another body is no record', () => {
  const bodies: ReadonlyArray<readonly [string, () => RfqMessage]> = [
    ['another quantity of an item', () => messageOf({ ...RFQ_VALUE, items: [{ sku: 'GLV-NIT-M', quantity: 99 }, { sku: 'SYR-10ML', quantity: 250 }, { sku: 'MSK-N95', quantity: 40 }] })],
    ['another request identifier', () => messageOf({ ...RFQ_VALUE, rfq_id: 'run1-rfq-2' })],
    ['another date', () => messageOf({ ...RFQ_VALUE, needed_by: '2026-12-21' })],
    ['another item', () => messageOf({ ...RFQ_VALUE, items: [{ sku: 'GLV-NIT-M', quantity: 100 }] })],
    ['the same items in another order', () => messageOf({ ...RFQ_VALUE, items: [{ sku: 'SYR-10ML', quantity: 250 }, { sku: 'GLV-NIT-M', quantity: 100 }, { sku: 'MSK-N95', quantity: 40 }] })],
    ['another sender', () => messageOf(RFQ_VALUE, { sender_did: `did:vector:${'f4'.repeat(32)}` })],
    ['another delegation', () => messageOf(RFQ_VALUE, { delegation: '5f'.repeat(32) })],
  ];

  it.each(bodies)('%s: precheck_missing, and nothing is asked', async (_what, make) => {
    const rig = makeRig();
    const other = make();
    expect(hashOf(other)).not.toBe(hashOf(rig.request));
    expect(await refusalOf(rig.run({ request: other }))).toMatchObject({ code: 'precheck_missing', status: 500 });
    expectNothingDone(rig);
    expect(rig.logs[0]).toContain('another request');
  });

  it('twin: the same body, parsed again from its text, passes', async () => {
    const rig = makeRig();
    expect(await rig.run({ request: messageOf(RFQ_VALUE, { delegation: DELEGATION }) })).toMatchObject({ outcome: 'done' });
    expect(rig.booked).toHaveLength(1);
  });
});

describe('the hash of the record', () => {
  const right = hashOf(makeRig().request);

  it.each([
    ['another hash', 'cd'.repeat(32)],
    ['the right hash in upper case', right.toUpperCase()],
    ['the right hash with a space before it', ` ${right}`],
    ['the empty text', ''],
    ['a number', 7 as never],
    ['null', null as never],
  ])('%s is refused with precheck_missing, and nothing is asked', async (_what, hash) => {
    const rig = makeRig();
    rig.entry = { ...recordFor(rig.request), request_sha256: hash };
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'precheck_missing', status: 500 });
    expectNothingDone(rig);
  });

  it('is the hash of the whole body: the hash of the request for quotation alone is refused', async () => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { request_sha256: hashOf(rig.request.rfq) });
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'precheck_missing' });
    expectNothingDone(rig);
  });

  it('twin: the right hash passes', async () => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { request_sha256: right });
    expect(await rig.run()).toMatchObject({ outcome: 'done' });
  });
});

describe('the record itself', () => {
  it.each(QUOTE_CHECKS)('refuses a record that lacks the check %s: precheck_missing, and nothing is asked', async (name) => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { checks: Object.fromEntries(Object.entries(CHECKS).filter(([key]) => key !== name)) as Record<string, true> });
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'precheck_missing', status: 500 });
    expectNothingDone(rig);
    expect(rig.logs[0]).toContain(name);
  });

  it.each(QUOTE_CHECKS)('refuses a record in which the check %s is not true', async (name) => {
    for (const value of [false, 'true', 1, null]) {
      const rig = makeRig();
      rig.entry = recordFor(rig.request, { checks: { ...CHECKS, [name]: value } as unknown as Record<string, true> });
      expect(await refusalOf(rig.run()), `${name} ${String(value)}`).toMatchObject({ code: 'precheck_missing' });
      expectNothingDone(rig);
    }
  });

  it('refuses a check that the record only inherits: the name must be a member of the record', async () => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { checks: Object.create(CHECKS) as Record<string, true> });
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'precheck_missing' });
    expectNothingDone(rig);
  });

  it('twin: a record with one more check than the quote names passes, and the quote holds the 7 names and no other', async () => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { checks: { ...CHECKS, extra_check: true } });
    const quote = await rig.run();
    expect(Object.keys(quote.checks)).toStrictEqual([...QUOTE_CHECKS]);
  });

  it.each([
    ['an organisation that is a number', { ...FACTS, organisation: 7 }],
    ['an organisation that is true', { ...FACTS, organisation: true }],
    ['an organisation that is an object', { ...FACTS, organisation: {} }],
    ['an organisation of 1025 characters', { ...FACTS, organisation: 'o'.repeat(1025) }],
    ['an organisation that NFC makes longer than 1024 characters', { ...FACTS, organisation: `${'x'.repeat(1023)}\u0958` }],
    ['no organisation fact', { organisation_verified: true }],
    ['a verification that is a text', { ...FACTS, organisation_verified: 'true' }],
    ['a verification that is a number', { ...FACTS, organisation_verified: 1 }],
    ['a verification that is null', { ...FACTS, organisation_verified: null }],
    ['no verification fact', { organisation: 'buyer.example' }],
    ['no fact at all', {}],
  ])('refuses a record with %s: precheck_missing, and nothing is asked', async (_what, facts) => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { facts: facts as never });
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'precheck_missing', status: 500 });
    expectNothingDone(rig);
    expect(rig.logs[0]).toMatch(/organisation/);
  });

  it.each([
    ['an organisation of 1024 characters', { ...FACTS, organisation: 'o'.repeat(1024) }],
    ['an organisation with letters of other scripts', { ...FACTS, organisation: 'Käufer GmbH, 買い手' }],
    ['an organisation that is null', { ...FACTS, organisation: null }],
    ['a verification that is false', { ...FACTS, organisation_verified: false }],
    ['a fact that the quote does not read', { ...FACTS, approval_attestation: 'x' }],
  ])('twin: a record with %s passes', async (_what, facts) => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { facts: facts as never });
    expect(await rig.run()).toMatchObject({ outcome: 'done' });
  });

  it('refuses a record that is no record: no checks, no facts, null, a text', async () => {
    for (const record of [null, 'x', 7, {}, { checks: CHECKS }, { facts: FACTS }, { checks: null, facts: FACTS }, { checks: CHECKS, facts: [] }]) {
      const rig = makeRig();
      rig.entry = { record: record as never, request_sha256: hashOf(rig.request) };
      expect(await refusalOf(rig.run()), JSON.stringify(record)).toMatchObject({ code: 'precheck_missing' });
      expectNothingDone(rig);
    }
  });

  it('takes the sender of the quote from the request that the hook checked, and not from the record', async () => {
    const rig = makeRig();
    const other = messageOf(RFQ_VALUE, { sender_did: `did:vector:${'f4'.repeat(32)}` });
    rig.entry = recordFor(other);
    const quote = await rig.run({ request: other });
    expect(quote.sender.did).toBe(`did:vector:${'f4'.repeat(32)}`);
    expect(quote.sender.did).not.toBe(SENDER_DID);
  });
});

describe('the real store of the hook', () => {
  it('fits the port: a record that the hook put is taken once for its escrow, and the second job finds none', async () => {
    const rig = makeRig();
    const passed = new PassedChecks();
    passed.put(ESCROW_REF, rig.entry!, T0);
    const deps = { ...rig.deps, takeChecks: (escrowRef: string) => passed.take(escrowRef, T0) };
    expect(await runQuote(deps, rig.request, rig.context, T0)).toMatchObject({ outcome: 'done' });
    expect(await refusalOf(runQuote(deps, rig.request, rig.context, T0))).toMatchObject({ code: 'precheck_missing' });
  });

  it('gives no record for an entry that has ended: the job gets none and is refused', async () => {
    const rig = makeRig();
    const passed = new PassedChecks();
    passed.put(ESCROW_REF, rig.entry!, T0);
    const deps = { ...rig.deps, takeChecks: (escrowRef: string) => passed.take(escrowRef, T0 + PASSED_CHECKS_TTL_MS) };
    expect(await refusalOf(runQuote(deps, rig.request, rig.context, T0))).toMatchObject({ code: 'precheck_missing' });
  });
});
