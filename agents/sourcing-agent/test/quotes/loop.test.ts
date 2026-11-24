// agents/sourcing-agent/test/quotes/loop.test.ts: the loop of the quote fan-out and the checks that come before a Pay. The bidders are hired one after the other, in the order of the invitation. A bidder whose status
// was not read as active right before its Pay, a bidder with no price list, a bidder that the deadline leaves no time for, and every bidder after a hang-up are not paid. Each refusal has an accepted twin.
import { afterEach, describe, expect, it } from 'vitest';
import { BID_CAPABILITIES } from '@vsa/usecase-kit/bids';
import { QUOTE_HIRE_RESERVE_MS } from '../../src/quotes/index.ts';
import type { BidderStatus, QuotesDeps, QuotesInput } from '../../src/quotes/index.ts';
import { ALFA, BRAVO, CHARLIE, DESKS, LIST, bidderOf, priced, quoteDocument, quoteText, rightAnswer } from './support.ts';
import { NOTHING, T0, cleanWorlds, footprint, words, world } from './world.ts';
import type { World } from './world.ts';

afterEach(() => { cleanWorlds(); });

/** The events of one bidder that a hire that was paid and accepted writes, in order. */
const HIRED = (name: string): string[] => [`recheck ${name}`, `pay ${name}`, `send ${name}`, `ask ${name}`, `accept ${name}`];

describe('the order of the hires', () => {
  it('hires three bidders one after the other: the status, the Pay, the send, the question to the model and the Accept of one come before the status of the next', async () => {
    const w = await world();
    const result = await w.run();
    expect(result.stopped).toBeNull();
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'accepted', 'accepted']);
    expect(result.outcomes.map((outcome) => outcome.did)).toStrictEqual(DESKS.map((spec) => spec.did));
    expect(w.events).toStrictEqual([...HIRED('alfa'), ...HIRED('bravo'), ...HIRED('charlie')]);
    expect(footprint(w)).toStrictEqual({ paid: 3, sends: 3, asked: 3, challenges: 0, rechecked: 3 });
    expect(w.booked).toStrictEqual({ posted: 3, accepted: 3 });
  });

  it('gives each accepted quote with its record, its sub-job and the decision that the model made for it', async () => {
    const w = await world();
    const result = await w.run();
    for (const [index, outcome] of result.outcomes.entries()) {
      if (outcome.kind !== 'accepted') throw new Error('the outcome of the test is not accepted');
      const spec = DESKS[index]!;
      expect(outcome.quote.desk_did).toBe(spec.did);
      expect(outcome.record).toMatchObject({ desk_did: spec.did, advert_ref: spec.advertRef, paid_from_vault: true, accepted: 'confirmed', challenge: null });
      expect(outcome.record.result).toStrictEqual(JSON.parse(JSON.stringify(quoteDocument(spec))));
      expect(outcome.sub_job).toMatchObject({ capability_id: BID_CAPABILITIES.quote, advert_ref: spec.advertRef, escrow_ref: outcome.record.escrow_ref, supplier_pkh: outcome.record.receipt?.supplier_pkh });
      expect(outcome.sub_job.receipt).toStrictEqual(outcome.record.receipt);
      expect(outcome.decision).toMatchObject({ name: 'accept_quote', choice: { accept: true, mismatch: [] } });
    }
    expect(new Set(result.outcomes.map((outcome) => (outcome.kind === 'accepted' ? outcome.record.escrow_ref : '')))).toHaveProperty('size', 3);
  });

  it('asks the model for the next quote only after the Accept of the first: the second hire starts after the first Accept', async () => {
    const w = await world();
    await w.run();
    const at = (word: string): number => w.events.indexOf(word);
    expect(at('accept alfa')).toBeLessThan(at('recheck bravo'));
    expect(at('accept bravo')).toBeLessThan(at('recheck charlie'));
    expect(w.desks.alfa.sends).toHaveLength(1);
    expect(w.desks.bravo.sends).toHaveLength(1);
    expect(w.desks.charlie.sends).toHaveLength(1);
  });

  it('gives no outcome for an empty invitation, and pays nothing', async () => {
    const w = await world();
    expect(await w.run(w.input({ invited: [] }))).toStrictEqual({ outcomes: [], stopped: null });
    expect(footprint(w)).toStrictEqual(NOTHING);
  });
});

describe('the status of a bidder, read again right before its Pay', () => {
  for (const status of ['suspended', 'revoked', 'retired', 'not_found'] as const) {
    it(`does not pay a bidder whose record is ${status}: excluded not_active ${status}, and the other two are paid`, async () => {
      const w = await world();
      w.status.set(BRAVO.did, status);
      const result = await w.run();
      expect(result.outcomes.map(words)).toStrictEqual(['accepted', `excluded not_active ${status}`, 'accepted']);
      expect(result.outcomes[1]).toMatchObject({ record: null, decision: null, challenge: null });
      expect(w.events).toStrictEqual([...HIRED('alfa'), 'recheck bravo', ...HIRED('charlie')]);
      expect(w.desks.bravo.sends).toHaveLength(0);
      expect(footprint(w)).toStrictEqual({ paid: 2, sends: 2, asked: 2, challenges: 0, rechecked: 3 });
      expect(result.stopped).toBeNull();
    });
  }

  it('does not pay a bidder whose status cannot be read: a read that gives unreadable, a read that throws and a word that is no status are each excluded failed status_unreadable', async () => {
    const unreadable: Array<BidderStatus | Error> = ['unreadable', new Error('the gateway did not answer'), 'maybe' as never];
    for (const given of unreadable) {
      const w = await world();
      w.status.set(BRAVO.did, given);
      const result = await w.run();
      expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded failed status_unreadable', 'accepted']);
      expect(w.desks.bravo.sends).toHaveLength(0);
      expect(footprint(w).paid).toBe(2);
    }
  });

  it('twin: the same bidder is paid when its status is active, and the status is read once for each bidder', async () => {
    const w = await world();
    w.status.set(BRAVO.did, 'active');
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'accepted', 'accepted']);
    expect(footprint(w).rechecked).toBe(3);
  });

  it('reads the status of a bidder after the hire of the bidder before it, so that a status that changed in that time is seen', async () => {
    const w = await world();
    const deps: QuotesDeps = {
      ...w.deps,
      recheck: async (did) => {
        // The first hire is over when the second bidder is read: its Accept is on the chain.
        if (did === BRAVO.did) expect(w.events).toContain('accept alfa');
        return did === BRAVO.did ? 'suspended' : 'active';
      },
    };
    const result = await w.run(w.input(), deps);
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded not_active suspended', 'accepted']);
    expect(footprint(w).paid).toBe(2);
  });
});

describe('the price list of a bidder', () => {
  it('does not pay a bidder with no price list: excluded failed no_price_list, and its status is not even read', async () => {
    const w = await world();
    const result = await w.run(w.input({ invited: [bidderOf(BRAVO, { price_list: null })] }));
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed no_price_list']);
    expect(footprint(w)).toStrictEqual(NOTHING);
    expect(w.desks.bravo.sends).toHaveLength(0);
  });

  it('pays the other two bidders when one has no price list', async () => {
    const w = await world();
    const result = await w.run(w.input({ invited: [bidderOf(ALFA), bidderOf(BRAVO, { price_list: null }), bidderOf(CHARLIE)] }));
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded failed no_price_list', 'accepted']);
    expect(w.events).toStrictEqual([...HIRED('alfa'), ...HIRED('charlie')]);
  });

  it('twin: a bidder with a price list is paid', async () => {
    const w = await world();
    const result = await w.run(w.input({ invited: [bidderOf(BRAVO)] }));
    expect(result.outcomes.map(words)).toStrictEqual(['accepted']);
    expect(footprint(w).paid).toBe(1);
  });

  it('does not pay a bidder whose price list has no hash that is a digest: a quote could never be checked against that list, so it would fail a check after the Pay', async () => {
    const w = await world();
    const result = await w.run(w.input({ invited: [bidderOf(BRAVO, { price_list: { list: LIST, sha256: 'not a digest' } })] }));
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed no_price_list']);
    expect(footprint(w)).toStrictEqual(NOTHING);
  });
});

describe('the deadline', () => {
  it('starts a hire only when the deadline leaves the time of a hire and the time that the caller keeps: with one millisecond less, no bidder is paid', async () => {
    const w = await world();
    const result = await w.run(w.input({ deadline_ms: T0 + QUOTE_HIRE_RESERVE_MS + 840_000 - 1 }));
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed deadline', 'excluded failed deadline', 'excluded failed deadline']);
    expect(footprint(w)).toStrictEqual(NOTHING);
    expect(result.stopped).toBeNull();
  });

  it('twin: with exactly that time left the first bidder is paid, and the time of that hire leaves too little for the next two', async () => {
    const w = await world();
    const result = await w.run(w.input({ deadline_ms: T0 + QUOTE_HIRE_RESERVE_MS + 840_000 }));
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded failed deadline', 'excluded failed deadline']);
    expect(footprint(w).paid).toBe(1);
    expect(w.events).toStrictEqual([...HIRED('alfa')]);
  });

  it('keeps the time that the caller asks for: a larger keep_ms stops the hires that a smaller one allows', async () => {
    const deadline = T0 + 3_420_000;
    const small = await world();
    expect((await small.run(small.input({ deadline_ms: deadline, keep_ms: 840_000 }))).outcomes.map(words)).toStrictEqual(['accepted', 'accepted', 'accepted']);
    const large = await world();
    expect((await large.run(large.input({ deadline_ms: deadline, keep_ms: 3_420_000 - QUOTE_HIRE_RESERVE_MS + 1 }))).outcomes.map(words)).toStrictEqual([
      'excluded failed deadline', 'excluded failed deadline', 'excluded failed deadline',
    ]);
  });

  it('reads the time of the clock port for each bidder, and a clock that gives no number is a deadline that has passed', async () => {
    const w = await world();
    const result = await w.run(w.input(), { ...w.deps, clock: () => Number.NaN });
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed deadline', 'excluded failed deadline', 'excluded failed deadline']);
    expect(footprint(w)).toStrictEqual(NOTHING);
  });

  it('keeps a reserve that covers the whole window of the advert and what follows the last possible answer: the work, the buffer of deliver_by, and the decision and the Accept, which end 600,000 ms after the answer', () => {
    expect(QUOTE_HIRE_RESERVE_MS).toBe(480_000 + 180_000 + 600_000);
  });

  it('reads the deadline again right before the Pay: a read of the status that takes 60 s must not lead to a Pay with less than the reserve left', async () => {
    const w = await world();
    const slow: QuotesDeps = { ...w.deps, recheck: async (did) => { w.clock.now += 60_000; return w.deps.recheck(did); } };
    // The deadline leaves the reserve and 30 s: the first read of the deadline passes, and the one right before the Pay does not.
    const result = await w.run(w.input({ invited: [bidderOf(ALFA)], deadline_ms: T0 + QUOTE_HIRE_RESERVE_MS + 840_000 + 30_000 }), slow);
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed deadline']);
    expect(footprint(w)).toStrictEqual({ ...NOTHING, rechecked: 1 });
    expect(result.stopped).toBeNull();
  });

  it('twin: the same read of 60 s with 90 s to spare leads to a Pay', async () => {
    const w = await world();
    const slow: QuotesDeps = { ...w.deps, recheck: async (did) => { w.clock.now += 60_000; return w.deps.recheck(did); } };
    const result = await w.run(w.input({ invited: [bidderOf(ALFA)], deadline_ms: T0 + QUOTE_HIRE_RESERVE_MS + 840_000 + 90_000 }), slow);
    expect(result.outcomes.map(words)).toStrictEqual(['accepted']);
    expect(footprint(w).paid).toBe(1);
  });
});

describe('a hang-up', () => {
  it('pays nobody when the caller hung up before the loop: each bidder is excluded failed aborted, and no status is read', async () => {
    const w = await world();
    const controller = new AbortController();
    controller.abort();
    const result = await w.run(w.input(), w.deps, controller.signal);
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed aborted', 'excluded failed aborted', 'excluded failed aborted']);
    expect(footprint(w)).toStrictEqual(NOTHING);
    expect(result.stopped).toBeNull();
  });

  it('does not pay the second bidder when the caller hangs up during the hire of the first: the first hire runs to its end, and the two after it are aborted', async () => {
    const w = await world();
    const controller = new AbortController();
    w.accept.answer = (given) => {
      controller.abort();
      return rightAnswer(given);
    };
    const result = await w.run(w.input(), w.deps, controller.signal);
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded failed aborted', 'excluded failed aborted']);
    expect(w.events).toStrictEqual(HIRED('alfa'));
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, asked: 1, challenges: 0, rechecked: 1 });
  });

  it('does not pay a bidder when the caller hangs up while its status is read: the signal is read again right before the Pay', async () => {
    const w = await world();
    const controller = new AbortController();
    const deps: QuotesDeps = {
      ...w.deps,
      recheck: async (did) => {
        w.events.push(`recheck ${did === BRAVO.did ? 'bravo' : 'other'}`);
        if (did === BRAVO.did) controller.abort();
        return 'active';
      },
    };
    const result = await w.run(w.input({ invited: [bidderOf(ALFA), bidderOf(BRAVO), bidderOf(CHARLIE)] }), deps, controller.signal);
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded failed aborted', 'excluded failed aborted']);
    expect(w.desks.bravo.sends).toHaveLength(0);
    expect(footprint(w).paid).toBe(1);
  });

  it('twin: a signal that is not aborted changes nothing', async () => {
    const w = await world();
    const result = await w.run(w.input(), w.deps, new AbortController().signal);
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'accepted', 'accepted']);
  });
});

describe('an input that no hire can carry', () => {
  const refused = async (change: (w: World) => { input?: QuotesInput; deps?: QuotesDeps }): Promise<World> => {
    const w = await world();
    const given = change(w);
    await expect(w.run(given.input ?? w.input(), given.deps ?? w.deps)).rejects.toThrow(TypeError);
    return w;
  };

  it('throws before any read and any Pay when a limit is missing: a limit is never filled in', async () => {
    const w = await refused((made) => ({ deps: { ...made.deps, limits: { ...made.deps.limits, maxSupplierBondLovelace: undefined as never } } }));
    expect(w.events).toStrictEqual([]);
    expect(footprint(w)).toStrictEqual(NOTHING);
  });

  it('throws before any read and any Pay when the request is no request for quotation: a quote could never be checked against it', async () => {
    const w = await refused((made) => ({ input: made.input({ rfq: { ...made.input().rfq, items: [] } }) }));
    expect(w.events).toStrictEqual([]);
  });

  it('throws before any read and any Pay when the deadline is no number', async () => {
    const w = await refused((made) => ({ input: made.input({ deadline_ms: Number.NaN }) }));
    expect(w.events).toStrictEqual([]);
  });

  it('twin: the same input with checked limits, a request and a deadline is carried', async () => {
    const w = await world();
    expect((await w.run()).outcomes.map(words)).toStrictEqual(['accepted', 'accepted', 'accepted']);
  });
});

describe('the log', () => {
  it('holds counts, codes and references, and no quote, no price list, no credential and no text of a bidder', async () => {
    const w = await world();
    w.desks.bravo.answer = () => quoteText(BRAVO, priced('SYR-10ML', 30));
    w.desks.charlie.refuse = { status: 403, code: 'duplicate_rfq' };
    await w.run();
    const log = w.log.join('\n');
    expect(w.log.length).toBeGreaterThan(5);
    for (const secret of ['All lines are at the listed price', 'eyJhbGciOiJFZERTQSIs', '"breaks"', 'min_quantity', 'unit_price', 'alfa.example.org', 'echo.example']) {
      expect(log, secret).not.toContain(secret);
    }
    expect(log).toContain('the model does not accept the quote');
    expect(log).toContain('challenge filed against claim');
    expect(log).toContain('the bidder refused (duplicate_rfq, before_claim)');
  });
});
