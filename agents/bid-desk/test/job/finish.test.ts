// agents/bid-desk/test/job/finish.test.ts: steps 7 and 8 of the job. The quote is checked with the parser of the kit BEFORE anything is recorded: a draft that fails is `internal`. Then the job reads the clock, and
// with less than 30,000 ms until `deliver_by` it ends `deadline` and records nothing, because a quote that nobody will read must not use up the key of the request. It reads the signal, and a caller that has
// hung up gets no record. The book records the request AFTER the credential, and a book that cannot write is `store_write_failed`. The signal is read and never passed into a port. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import type { Digest, Did, JsonValue } from '@vsa/usecase-kit/protocol';
import { runQuote } from '../../src/job/index.ts';
import type { QuoteDeps } from '../../src/job/index.ts';
import { QUOTE_TEXT } from '../../src/job/refusal.ts';
import { expectCleanLog, expectNothingRecorded, makeRig, refusalOf } from './rig.ts';
import type { Rig } from './rig.ts';
import { SENDER_DID, T0, hashOf, messageOf, recordFor } from './samples.ts';

/** The job with the ports of the rig and some of them replaced. */
const runWith = (rig: Rig, over: Partial<QuoteDeps>, signal?: AbortSignal) => runQuote({ ...rig.deps, ...over }, rig.request, rig.context, T0, signal);

describe('a draft that the parser of the kit refuses', () => {
  const draftFaults: ReadonlyArray<readonly [string, Partial<QuoteDeps>, string]> = [
    ['an organisation of the desk that is no domain name', { agent: { did: makeRig().deps.agent.did, organisation: 'Supplier Alfa' } }, 'organisation'],
    ['a DID of the desk that is no DID', { agent: { did: 'did:vector:xyz', organisation: 'supplier-alfa.example' } }, 'desk_did'],
    ['a hash of the price list that is no hash', { priceList: { list: makeRig().deps.priceList.list, sha256: 'not-a-hash' } }, 'price_list_sha256'],
    ['a fault value that the Bid Desk does not list', { fault: { kind: 'bid-desk', mode: 'bogus' } as unknown as FaultSwitch<'bid-desk'> }, 'fault_mode'],
  ];

  it.each(draftFaults)('ends with internal (500) for %s, and nothing is recorded', async (_what, over, field) => {
    const rig = makeRig();
    const refusal = await refusalOf(runWith(rig, over));
    expect(refusal).toMatchObject({ code: 'internal', status: 500, kind: 'job', message: QUOTE_TEXT.internal });
    expect(rig.events).toStrictEqual(['take', 'decide', 'has', 'credential']);
    expectNothingRecorded(rig);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('no valid quote can be made');
    expect(rig.logs[0]).toContain(field);
  });

  it('never repeats the value that failed, in the log or in the text for the buyer', async () => {
    const rig = makeRig();
    const refusal = await refusalOf(runWith(rig, { agent: { did: makeRig().deps.agent.did, organisation: 'Supplier Alfa DESK-SECRET' } }));
    for (const text of [refusal.message, ...rig.logs]) expect(text).not.toContain('DESK-SECRET');
  });

  it('twin: the desk with every member right passes', async () => {
    const rig = makeRig();
    expect(await rig.run()).toMatchObject({ outcome: 'done' });
  });

  it('is also the end for a request that is no request for quotation: the job stops before it asks the model', async () => {
    const rig = makeRig();
    const wrong = messageOf({ rfq_id: 'run1-rfq-1', items: [{ sku: 'GLV-NIT-M', quantity: 0 }], needed_by: '2026-12-20' });
    rig.entry = recordFor(wrong);
    expect(await refusalOf(rig.run({ request: wrong }))).toMatchObject({ code: 'internal', status: 500 });
    expect(rig.events).toStrictEqual(['take']);
    expect(rig.decideInputs).toHaveLength(0);
    expectNothingRecorded(rig);
  });
});

describe('the time that is left until deliver_by', () => {
  it.each([
    [300_000, true],
    [30_001, true],
    [30_000, true],
    [29_999, false],
    [1, false],
    [0, false],
    [-1, false],
  ])('with %s ms left at step 8 the job gives the quote: %s', async (left, gives) => {
    const rig = makeRig({ deliverInMs: left });
    if (gives) {
      expect(await rig.run()).toMatchObject({ outcome: 'done' });
      expect(rig.booked).toHaveLength(1);
    } else {
      const refusal = await refusalOf(rig.run());
      expect(refusal).toMatchObject({ code: 'deadline', status: 422, kind: 'job', message: QUOTE_TEXT.no_time });
      expect(rig.events).toStrictEqual(['take', 'decide', 'has', 'credential']);
      expectNothingRecorded(rig);
    }
  });

  it('is read at step 8, after the model and the gateway took their time: the clock of the job decides, and not the time of the arrival', async () => {
    const rig = makeRig({ deliverInMs: 300_000 });
    const slow = async (did: Did) => {
      rig.now += 280_000;
      return rig.deps.credential(did);
    };
    expect(await refusalOf(runWith(rig, { credential: slow }))).toMatchObject({ code: 'deadline', status: 422 });
    expectNothingRecorded(rig);
    expect(rig.logs[0]).toContain('20000 ms');
  });

  it('refuses a time that is not a number: a time that is not known is never enough time', async () => {
    for (const deliverByMs of [Number.NaN, Number.POSITIVE_INFINITY * -1, undefined as unknown as number]) {
      const rig = makeRig();
      const refusal = await refusalOf(runQuote(rig.deps, rig.request, { ...rig.context, deliverByMs }, T0));
      expect(refusal).toMatchObject({ code: 'deadline', status: 422 });
      expectNothingRecorded(rig);
    }
  });

  it('gives the buyer a fixed text, and the log says how many ms were left', async () => {
    const rig = makeRig({ deliverInMs: 12_345 });
    const refusal = await refusalOf(rig.run());
    expect(refusal.message).toBe(QUOTE_TEXT.no_time);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('12345 ms');
    expectCleanLog(rig.logs);
  });
});

describe('a caller that has hung up', () => {
  it('gets no decision and no record when it hangs up before step 2 (deadline, status 422)', async () => {
    const rig = makeRig();
    const hungUp = new AbortController();
    hungUp.abort();
    const refusal = await refusalOf(rig.run({ signal: hungUp.signal }));
    expect(refusal).toMatchObject({ code: 'deadline', status: 422, kind: 'job', message: QUOTE_TEXT.deadline });
    expect(rig.events).toStrictEqual(['take']);
    expect(rig.decideInputs).toHaveLength(0);
    expectNothingRecorded(rig);
    expect(rig.logs[0]).toContain('hung up');
  });

  it.each([
    ['the model is hired', 'decide'],
    ['the book is read', 'has'],
    ['the gateway is asked for the credential', 'credential'],
  ] as const)('gets no record when it hangs up while %s: the signal is read again before step 8', async (_when, port) => {
    const rig = makeRig();
    const hungUp = new AbortController();
    const deps: Partial<QuoteDeps> = {
      decide: async (input) => {
        const result = await rig.deps.decide(input);
        if (port === 'decide') hungUp.abort();
        return result;
      },
      book: {
        has: async (sender, rfqId) => {
          const known = await rig.deps.book.has(sender, rfqId);
          if (port === 'has') hungUp.abort();
          return known;
        },
        record: rig.deps.book.record,
      },
      credential: async (did) => {
        const issued = await rig.deps.credential(did);
        if (port === 'credential') hungUp.abort();
        return issued;
      },
    };
    expect(await refusalOf(runWith(rig, deps, hungUp.signal))).toMatchObject({ code: 'deadline', status: 422, message: QUOTE_TEXT.deadline });
    expect(rig.events).toStrictEqual(['take', 'decide', 'has', 'credential']);
    expectNothingRecorded(rig);
  });

  it('keeps the quote that it booked when it hangs up during the write: the job goes on, and one more line in the log says so', async () => {
    const rig = makeRig();
    const hungUp = new AbortController();
    const book = {
      has: rig.deps.book.has,
      record: async (sender: Did, rfqId: string, hash: Digest) => {
        await rig.deps.book.record(sender, rfqId, hash);
        hungUp.abort();
      },
    };
    const quote = await runWith(rig, { book }, hungUp.signal);
    expect(quote).toMatchObject({ outcome: 'done' });
    expect(rig.booked).toHaveLength(1);
    expect(rig.logs).toHaveLength(2);
    expect(rig.logs[0]).toContain('hung up');
    expect(rig.logs[0]).toContain('booked');
  });

  it('twin: a caller that stays, with a signal that never aborts and with no signal, gets the quote and the record', async () => {
    const stays = makeRig();
    expect(await stays.run({ signal: new AbortController().signal })).toMatchObject({ outcome: 'done' });
    expect(stays.booked).toHaveLength(1);
    const none = makeRig();
    expect(await none.run()).toMatchObject({ outcome: 'done' });
    expect(none.booked).toHaveLength(1);
  });

  it('never passes the signal into a port: each port is called with its own arguments and nothing more', async () => {
    const rig = makeRig();
    const counts: Record<string, number> = {};
    const note = (name: string, count: number): void => {
      counts[name] = count;
    };
    const deps: Partial<QuoteDeps> = {
      takeChecks: (...args: [string]) => {
        note('takeChecks', args.length);
        return rig.deps.takeChecks(...args);
      },
      decide: (...args: [JsonValue]) => {
        note('decide', args.length);
        return rig.deps.decide(...args);
      },
      credential: (...args: [Did]) => {
        note('credential', args.length);
        return rig.deps.credential(...args);
      },
      book: {
        has: (...args: [Did, string]) => {
          note('has', args.length);
          return rig.deps.book.has(...args);
        },
        record: (...args: [Did, string, Digest]) => {
          note('record', args.length);
          return rig.deps.book.record(...args);
        },
      },
    };
    await runWith(rig, deps, new AbortController().signal);
    expect(counts).toStrictEqual({ takeChecks: 1, decide: 1, has: 2, record: 3, credential: 1 });
  });
});

describe('a book that cannot write', () => {
  it('ends the job with store_write_failed (500), and the log holds the kind of the error and never its message', async () => {
    const rig = makeRig();
    rig.bookError = new RangeError('/var/lib/bid-desk/rfq-book.json could not be written');
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'store_write_failed', status: 500, kind: 'job', message: QUOTE_TEXT.rfq_book });
    expect(rig.events).toStrictEqual(['take', 'decide', 'has', 'credential', 'record']);
    expect(rig.booked).toHaveLength(0);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('RangeError');
    for (const text of [refusal.message, ...rig.logs]) expect(text).not.toContain('/var/lib');
  });

  it('is store_write_failed also when the book rejects with something that is no error', async () => {
    const rig = makeRig();
    rig.bookError = 'the disk is full' as unknown as Error;
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'store_write_failed', status: 500 });
    expect(rig.logs[0]).toContain('string');
    expect(rig.logs[0]).not.toContain('the disk is full');
  });

  it('twin: after a failed write the book holds nothing, and a second try gives the quote and records it', async () => {
    const rig = makeRig();
    rig.bookError = new Error('disk');
    await refusalOf(rig.run());
    expect(await rig.memory.has(SENDER_DID, 'run1-rfq-1')).toBe(false);
    rig.bookError = null;
    const quote = await rig.run();
    expect(rig.booked).toStrictEqual([[SENDER_DID, 'run1-rfq-1', hashOf(quote)]]);
  });

  it('records the request AFTER the credential and the check of the draft, and one time', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.events.indexOf('record')).toBeGreaterThan(rig.events.indexOf('credential'));
    expect(rig.events.filter((event) => event === 'record')).toHaveLength(1);
  });
});
