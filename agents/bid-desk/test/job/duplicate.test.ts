// agents/bid-desk/test/job/duplicate.test.ts: step 5 of the job. The hook refuses a request that the book holds, but it can pass two escrows of one request before the first job writes the book. So the job
// reads the book again, after the decision and before the credential. A request that the book holds is `duplicate_rfq` (403) AFTER the Claim: the escrow stays Claimed, and the buyer reclaims it after the
// deadline. The job gets no credential and writes nothing. The book answers `true` or `false`: any other answer is a book that cannot answer, and it is never a pass. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { runQuote } from '../../src/job/index.ts';
import { QUOTE_TEXT } from '../../src/job/refusal.ts';
import { expectCleanLog, expectNothingRecorded, makeRig, refusalOf } from './rig.ts';
import { DESK_DID, RFQ_VALUE, SENDER_DID, hashOf, messageOf, recordFor } from './samples.ts';

describe('a request that the book holds', () => {
  it('is duplicate_rfq (403) at step 5: the same request twice gives one quote, and the book holds one entry', async () => {
    const rig = makeRig();
    const first = await rig.run();
    const before = rig.events.length;
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'duplicate_rfq', status: 403, kind: 'job', message: QUOTE_TEXT.duplicate_rfq });
    expect(rig.events.slice(before)).toStrictEqual(['take', 'decide', 'has']);
    expect(rig.credentialAsks).toStrictEqual([DESK_DID]);
    expect(rig.booked).toStrictEqual([[SENDER_DID, 'run1-rfq-1', hashOf(first)]]);
  });

  it('asks the model before it reads the book: the decision is step 2, and the second read is step 5', async () => {
    const rig = makeRig();
    await rig.run();
    await refusalOf(rig.run());
    expect(rig.decideInputs).toHaveLength(2);
  });

  it('gives the buyer a fixed text, and no log line holds the identifier of the request', async () => {
    const rig = makeRig();
    await rig.memory.record(SENDER_DID, 'run1-rfq-1', 'ab'.repeat(32));
    const refusal = await refusalOf(rig.run());
    expect(refusal.message).not.toContain('run1-rfq-1');
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('duplicate_rfq');
    expectCleanLog(rig.logs);
  });

  it('is found BEFORE the credential: the job asks the gateway for nothing, and writes nothing', async () => {
    const rig = makeRig();
    await rig.memory.record(SENDER_DID, 'run1-rfq-1', 'ab'.repeat(32));
    await refusalOf(rig.run());
    expect(rig.events).toStrictEqual(['take', 'decide', 'has']);
    expect(rig.credentialAsks).toHaveLength(0);
    expectNothingRecorded(rig);
  });

  it('is found when another job booked the request while this job waited for the model: the book is read again after the decision', async () => {
    const rig = makeRig();
    const deps = {
      ...rig.deps,
      decide: async (input: JsonValue) => {
        const result = await rig.deps.decide(input);
        await rig.memory.record(SENDER_DID, 'run1-rfq-1', 'cd'.repeat(32));
        return result;
      },
    };
    expect(await refusalOf(runQuote(deps, rig.request, rig.context, 0))).toMatchObject({ code: 'duplicate_rfq', status: 403 });
    expect(rig.credentialAsks).toHaveLength(0);
    expectNothingRecorded(rig);
  });

  it('twin: a book that does not hold the request lets the job go on to the credential and the record', async () => {
    const rig = makeRig();
    expect(await rig.run()).toMatchObject({ outcome: 'done' });
    expect(rig.events).toStrictEqual(['take', 'decide', 'has', 'credential', 'record']);
  });
});

describe('the key of the book', () => {
  it('is the sender and the identifier together: the same identifier from another sender is a new request', async () => {
    const rig = makeRig();
    await rig.run();
    const other = messageOf(RFQ_VALUE, { sender_did: `did:vector:${'f2'.repeat(32)}` });
    rig.entry = recordFor(other);
    expect(await rig.run({ request: other })).toMatchObject({ outcome: 'done', sender: { did: `did:vector:${'f2'.repeat(32)}` } });
    expect(rig.booked).toHaveLength(2);
  });

  it('is the sender and the identifier together: another identifier from the same sender is a new request', async () => {
    const rig = makeRig();
    await rig.run();
    const next = messageOf({ ...RFQ_VALUE, rfq_id: 'run1-rfq-2' });
    rig.entry = recordFor(next);
    expect(await rig.run({ request: next })).toMatchObject({ outcome: 'done', rfq_id: 'run1-rfq-2' });
    expect(rig.booked.map(([, id]) => id)).toStrictEqual(['run1-rfq-1', 'run1-rfq-2']);
  });

  it('is the identifier as it was written: two identifiers that differ in the case of a letter are two requests', async () => {
    const rig = makeRig({ rfq: { rfq_id: 'RFQ-7' } });
    await rig.run();
    const lower = messageOf({ ...RFQ_VALUE, rfq_id: 'rfq-7' });
    rig.entry = recordFor(lower);
    expect(await rig.run({ request: lower })).toMatchObject({ outcome: 'done', rfq_id: 'rfq-7' });
    expect(rig.booked).toHaveLength(2);
    const again = makeRig({ rfq: { rfq_id: 'RFQ-7' } });
    await again.run();
    expect(await refusalOf(again.run())).toMatchObject({ code: 'duplicate_rfq' });
  });
});

describe('a book that cannot answer', () => {
  it('ends the job with internal (500), and asks the gateway for nothing and writes nothing: a read that fails is never a pass', async () => {
    const rig = makeRig();
    rig.hasError = new Error('/var/lib/bid-desk/rfq-book.json is damaged');
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'internal', status: 500, kind: 'job', message: QUOTE_TEXT.internal });
    expect(rig.events).toStrictEqual(['take', 'decide', 'has']);
    expectNothingRecorded(rig);
  });

  it('puts the kind of the error in the log, and never its message: the message of a failed read can name a path', async () => {
    const rig = makeRig();
    rig.hasError = new RangeError('/var/lib/bid-desk/rfq-book.json is damaged');
    const refusal = await refusalOf(rig.run());
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('RangeError');
    for (const text of [refusal.message, ...rig.logs]) expect(text).not.toContain('/var/lib');
  });

  it.each([
    ['the text false', 'false'],
    ['the text true', 'true'],
    ['the number 0', 0],
    ['the number 1', 1],
    ['null', null],
    ['an object', {}],
    ['a list', []],
  ])('ends the job with internal (500) for an answer that is %s: only true and false are answers', async (_what, answer) => {
    const rig = makeRig();
    rig.hasAnswer = answer;
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'internal', status: 500 });
    expect(rig.events).toStrictEqual(['take', 'decide', 'has']);
    expectNothingRecorded(rig);
  });

  it('twin: the answer false passes, and the answer true is duplicate_rfq', async () => {
    const pass = makeRig();
    pass.hasAnswer = false;
    expect(await pass.run()).toMatchObject({ outcome: 'done' });
    const held = makeRig();
    held.hasAnswer = true;
    expect(await refusalOf(held.run())).toMatchObject({ code: 'duplicate_rfq' });
  });
});
