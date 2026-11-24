// agents/sourcing-agent/test/quotes/steps.test.ts: each end of a hire and the outcome that it gives. A refusal of the bidder is `refused` with the code of the refusal and the record of the hire, and its escrow stays
// Open. A Pay that the vault refused, a Pay that was not seen confirmed, a job that failed, a receipt that did not verify, an Accept that did not land and an error after the Pay are each `failed` with their own code,
// and none of them is ever a quote. Each form has its twin: the same run with a bidder that does what it should is accepted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcceptWindowClosedError, TxNotConfirmedError } from '@vsa/buyer-core';
import { DECISION_WINDOW_MS } from '@vsa/hire-kit';
import { COUNTERPARTY_REFUSALS } from '@vsa/usecase-kit/protocol';
import { ALFA, BRAVO, DELEGATION, acceptDecision, bidderOf } from './support.ts';
import { NOTHING, T0, cleanWorlds, footprint, hired, lockOf, words, world } from './world.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanWorlds();
});

describe('a bidder that refuses before its Claim', () => {
  for (const code of COUNTERPARTY_REFUSALS['bid-desk']) {
    it(`is excluded refused ${code} when the bidder answers 403 with that code: the record names the escrow, the escrow stays Open, and the other bidders are paid`, async () => {
      const w = await world();
      w.desks.bravo.refuse = { status: 403, code };
      const result = await w.run();
      expect(result.outcomes.map(words)).toStrictEqual(['accepted', `excluded refused ${code}`, 'accepted']);
      const refused = hired(result.outcomes, 1);
      expect(refused).toMatchObject({ decision: null, challenge: null, record: { desk_did: BRAVO.did, advert_ref: BRAVO.advertRef, paid_from_vault: true, accepted: null, receipt: null, receipt_signature: null, verification: null, result: null, challenge: null } });
      expect(await w.chain.escrowState(refused.record.escrow_ref)).toBe('Open');
      expect(w.accept.calls).toHaveLength(2);
      expect(footprint(w).challenges).toBe(0);
      expect(result.stopped).toBeNull();
    });
  }

  // A bidder that answers before its Claim with something that the protocol does not list as a refusal of a Bid Desk is a failed job, and never a refusal.
  const NOT_REFUSALS: ReadonlyArray<readonly [string, number, string, string]> = [
    ['a refusal code of another counterparty', 403, 'not_for_this_supplier', 'not_for_this_supplier'],
    ['a code that the protocol does not list', 403, 'because_i_said_so', 'counterparty_refused'],
    ['an answer with the status 503, which is a send that was lost and not a refusal', 503, 'check_unavailable', 'send_lost'],
  ];
  for (const [what, status, code, expected] of NOT_REFUSALS) {
    it(`is excluded failed ${expected} for ${what}: the escrow stays Open`, async () => {
      const w = await world();
      w.desks.bravo.refuse = { status, code };
      const result = await w.run();
      expect(result.outcomes.map(words)).toStrictEqual(['accepted', `excluded failed ${expected}`, 'accepted']);
      expect(await w.chain.escrowState(hired(result.outcomes, 1).record.escrow_ref)).toBe('Open');
    });
  }
});

describe('a Pay that the vault refuses', () => {
  it('is excluded failed vault_refused for the bidder that the vault cannot pay a third time: it has no record, no send and no question to the model, and the two before it are paid', async () => {
    const lock = await lockOf();
    const w = await world({ limit: { perTx: lock, total: 2n * lock, periodMs: 86_400_000 } });
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'accepted', 'excluded failed vault_refused']);
    expect(result.outcomes[2]).toMatchObject({ record: null, decision: null, challenge: null });
    expect(footprint(w)).toStrictEqual({ paid: 2, sends: 2, asked: 2, challenges: 0, rechecked: 3 });
    expect(w.desks.charlie.sends).toHaveLength(0);
    expect(w.log.some((line) => line.includes('the vault refused the Pay'))).toBe(true);
    expect(result.stopped).toBeNull();
  });

  it('is excluded failed vault_refused for each bidder when each Pay is above per_tx: nothing is posted and nothing is accepted', async () => {
    const lock = await lockOf();
    const w = await world({ limit: { perTx: lock - 1n, total: 14_000_000n, periodMs: 86_400_000 } });
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed vault_refused', 'excluded failed vault_refused', 'excluded failed vault_refused']);
    expect(footprint(w)).toStrictEqual({ paid: 0, sends: 0, asked: 0, challenges: 0, rechecked: 3 });
    expect(w.booked).toStrictEqual({ posted: 0, accepted: 0 });
  });

  it('twin: a vault that can pay three times pays three times', async () => {
    const lock = await lockOf();
    const w = await world({ limit: { perTx: lock, total: 3n * lock, periodMs: 86_400_000 } });
    expect((await w.run()).outcomes.map(words)).toStrictEqual(['accepted', 'accepted', 'accepted']);
  });
});

describe('a Pay that was sent and not seen confirmed', () => {
  it('is excluded failed pay_unconfirmed, and the bidders after it are not paid while that Pay may still land: earlier_pay_may_land, no Pay and no read of a vault', async () => {
    const w = await world();
    const real = w.chain.payFromVault.bind(w.chain);
    vi.spyOn(w.chain, 'payFromVault').mockImplementationOnce(async (args) => {
      const paid = await real(args);
      throw new TxNotConfirmedError('The Pay was submitted, but Koios did not report it confirmed.', { txHash: paid.txHash, escrowRef: paid.escrowRef, deliverBy: paid.deliverBy, validTo: T0 + 400_000, mayLand: true });
    });
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed pay_unconfirmed', 'excluded failed earlier_pay_may_land', 'excluded failed earlier_pay_may_land']);
    expect(hired(result.outcomes, 0).record).toMatchObject({ desk_did: ALFA.did, paid_from_vault: true, accepted: null, receipt: null });
    expect(result.outcomes[1]).toMatchObject({ record: null });
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 0, asked: 0, challenges: 0, rechecked: 3 });
    expect(w.log.some((line) => line.includes('may land true'))).toBe(true);
  });

  it('twin: a Pay that the node confirms is paid, sent and accepted', async () => {
    const w = await world();
    expect((await w.run()).outcomes.map(words)).toStrictEqual(['accepted', 'accepted', 'accepted']);
  });
});

describe('a hire that fails', () => {
  it('is excluded failed failed when the job of the bidder fails after its Claim: the record names the escrow, the model is not asked, and the next bidder is paid', async () => {
    const w = await world();
    w.desks.bravo.failJob = true;
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded failed failed', 'accepted']);
    expect(hired(result.outcomes, 1)).toMatchObject({ decision: null, challenge: null, record: { accepted: null, receipt: null } });
    expect(await w.chain.escrowState(hired(result.outcomes, 1).record.escrow_ref)).toBe('Claimed');
    expect(footprint(w).asked).toBe(2);
  });

  it('is excluded failed receipt_failed when the receipt does not verify: the model is not asked, nothing is accepted, and the record keeps the checks', async () => {
    const w = await world();
    w.desks.bravo.forge = true;
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['accepted', 'excluded failed receipt_failed', 'accepted']);
    const failed = hired(result.outcomes, 1);
    expect(failed.record.verification).toMatchObject({ signature_valid: false });
    expect(failed.record.accepted).toBeNull();
    expect(failed.decision).toBeNull();
    expect(footprint(w).asked).toBe(2);
  });

  it('is excluded failed accept_failed when the Accept does not land after the model said yes: the decision of the model is on record, and the escrow stays Submitted', async () => {
    const w = await world();
    w.chain.failNextAccepts(1, new AcceptWindowClosedError('The accept window of the escrow has closed.'));
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed accept_failed', 'accepted', 'accepted']);
    const failed = hired(result.outcomes, 0);
    expect(failed.decision).toStrictEqual(acceptDecision(true));
    expect(failed.record.accepted).toBeNull();
    expect(await w.chain.escrowState(failed.record.escrow_ref)).toBe('Submitted');
  });

  it('is excluded failed advert_not_counterparty when the advert is no advert of the bidder: nothing is paid, and the outcome holds no record', async () => {
    const w = await world();
    const result = await w.run(w.input({ invited: [bidderOf(BRAVO, { did: ALFA.did })] }));
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed advert_not_counterparty']);
    expect(result.outcomes[0]).toMatchObject({ record: null, decision: null });
    expect(footprint(w)).toStrictEqual({ ...NOTHING, rechecked: 1 });
  });

  it('is excluded failed no_live_vault when the delegation has no Live vault: nothing is paid', async () => {
    const w = await world();
    const result = await w.run(w.input(), { ...w.deps, reads: { delegation: (id) => w.reads.delegation(id), liveVaults: async () => ({ refs: [], complete: true }) } });
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed no_live_vault', 'excluded failed no_live_vault', 'excluded failed no_live_vault']);
    expect(footprint(w)).toStrictEqual({ ...NOTHING, rechecked: 3 });
  });

  it('is excluded failed delegation_not_mine for each bidder when the delegation names another agent: nothing is paid and the model is not asked', async () => {
    const w = await world();
    w.reads.delegations.set(DELEGATION, { delegate: 'ff'.repeat(32), chain_whole: true });
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed delegation_not_mine', 'excluded failed delegation_not_mine', 'excluded failed delegation_not_mine']);
    expect(footprint(w)).toStrictEqual({ ...NOTHING, rechecked: 3 });
  });
});

describe('an error after the Pay was confirmed', () => {
  it('is excluded failed store_write_failed when the stranded record of the Pay cannot be written: the record names the escrow', async () => {
    const w = await world();
    vi.spyOn(w.deps.key.stranded, 'add').mockImplementationOnce(() => { throw new Error('the disk is full'); });
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed store_write_failed', 'accepted', 'accepted']);
    expect(hired(result.outcomes, 0).record).toMatchObject({ accepted: null, receipt: null });
  });

  it('is excluded failed hire_interrupted when the ledger of the service throws after the Pay', async () => {
    const w = await world();
    const posted = w.deps.hire.ledger.posted;
    w.deps.hire.ledger.posted = (post) => {
      w.deps.hire.ledger.posted = posted;
      throw new Error('the ledger is closed');
    };
    const result = await w.run();
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed hire_interrupted', 'accepted', 'accepted']);
  });

  it('is excluded failed timeout when the deadline of the job comes while the job of the bidder runs: the record names the escrow, and no bidder after it is paid', async () => {
    const w = await world();
    w.desks.alfa.running = 2;
    const deps = { ...w.deps, hire: { ...w.deps.hire, sleep: async (ms: number): Promise<void> => { w.clock.now += ms + 2_000_000; } } };
    const result = await w.run(w.input({ deadline_ms: T0 + 1_500_000 }), deps);
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed timeout', 'excluded failed deadline', 'excluded failed deadline']);
    expect(hired(result.outcomes, 0).record).toMatchObject({ accepted: null, receipt: null });
    expect(result.outcomes[1]).toMatchObject({ record: null });
    expect(footprint(w).paid).toBe(1);
  });
});

describe('a fee that the ledger does not book', () => {
  it('is still an accepted quote when the ledger throws while it books the fee of the Accept: the failure goes to the log and changes nothing', async () => {
    const w = await world();
    const booked = w.deps.hire.ledger.accepted;
    w.deps.hire.ledger.accepted = (accept) => {
      w.deps.hire.ledger.accepted = booked;
      throw new Error('the ledger is closed');
    };
    const result = await w.run(w.input({ invited: [bidderOf(ALFA)] }));
    expect(result.outcomes.map(words)).toStrictEqual(['accepted']);
    expect(w.log.some((line) => line.includes('the ledger did not book the fee of the Accept'))).toBe(true);
    expect(w.log.some((line) => line.includes('the ledger is closed'))).toBe(false);
  });
});

describe('a decision that does not answer in time', () => {
  it('is excluded failed decision_timeout when the model does not answer before the limit: the escrow stays Submitted, nothing is challenged, and no decision is recorded', async () => {
    vi.useFakeTimers();
    const w = await world();
    w.accept.answer = () => {
      vi.advanceTimersByTime(DECISION_WINDOW_MS);
      return new Promise<never>(() => undefined);
    };
    const result = await w.run(w.input({ invited: [bidderOf(ALFA)] }));
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed decision_timeout']);
    const failed = hired(result.outcomes, 0);
    expect(failed).toMatchObject({ decision: null, challenge: null, record: { accepted: 'no' } });
    expect(await w.chain.escrowState(failed.record.escrow_ref)).toBe('Submitted');
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, asked: 1, challenges: 0, rechecked: 1 });
    expect(result.stopped).toBeNull();
  });

  it('twin: a model that answers one millisecond before the limit is heard, and the quote is accepted', async () => {
    vi.useFakeTimers();
    const w = await world();
    const model = w.accept.answer;
    w.accept.answer = (given) => {
      vi.advanceTimersByTime(DECISION_WINDOW_MS - 1);
      return model(given);
    };
    expect((await w.run(w.input({ invited: [bidderOf(ALFA)] }))).outcomes.map(words)).toStrictEqual(['accepted']);
  });
});
