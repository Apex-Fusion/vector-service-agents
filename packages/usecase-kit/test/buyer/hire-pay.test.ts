// packages/usecase-kit/test/buyer/hire-pay.test.ts: what a hire leaves behind after its Pay. A Pay that was sent and not seen confirmed may still land, and it spends the vault output that it names, so no
// other Pay of the key starts until its validity has ended. A ledger that throws when it books the fee of a confirmed Accept does not turn paid work into a failure. Each refusal has an accepted twin, and
// the clock is the clock port of the test.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TxNotConfirmedError } from '@vsa/buyer-core';
import { HirePayUnconfirmed } from '@vsa/hire-kit';
import { EARLIER_PAY_MAY_LAND, INCONSISTENT_OUTCOME, completedResult, hireCounterparty, settledResult } from '@vsa/usecase-kit/buyer';
import { T0, cleanWorlds, expectKind, go, handoffFor, input, otherKeyDeps, pieces, purchaseOrder, untouched, words, world } from './support.ts';

afterEach(() => { vi.restoreAllMocks(); cleanWorlds(); });

const VALID_TO = T0 + 400_000;
const second = () => handoffFor(purchaseOrder({ po_number: 'run1-0002' }));
/** A Pay that was sent and not seen confirmed. It did not land, and `mayLand` says whether it may still do so. `escrowRef` is the escrow that the Pay opens if it lands. */
const unseen = (mayLand: boolean, escrowRef = `${'ab'.repeat(32)}#0`): TxNotConfirmedError => new TxNotConfirmedError(
  'The Pay was submitted, but Koios did not report it confirmed.', { txHash: 'ab'.repeat(32), escrowRef, deliverBy: T0 + 480_000, validTo: VALID_TO, mayLand },
);

describe('a Pay that may still land', () => {
  it('stops the next job of the key before any read of the vault and any Pay: it is failed with earlier_pay_may_land, and the vault output of the first Pay is still live', async () => {
    const w = await world();
    const pay = vi.spyOn(w.m.chain, 'payFromVault').mockRejectedValueOnce(unseen(true));
    // The second job waits in the lane while the first one runs.
    const [a, b] = await Promise.all([go(w), go(w, { message: second() })]);
    expect(words(a)).toBe('pay_unconfirmed');
    const step = expectKind(b, 'failed');
    expect([step.reason, step.handoff, step.vault_ref]).toStrictEqual([EARLIER_PAY_MAY_LAND, null, null]);
    expect(step.detail).toContain(`${VALID_TO}`);
    expect(step.detail).toContain(w.vault);
    // One Pay was tried in all, and the vault was read one time: for the first job.
    expect(pay).toHaveBeenCalledTimes(1);
    expect(w.reads.calls.liveVaults).toBe(1);
    expect(w.m.agent.sends).toStrictEqual([]);
    expect(w.m.chain.vault(w.vault)).toMatchObject({ kind: 'Live', consumed: false });
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'failed', reason: EARLIER_PAY_MAY_LAND, exit_state: 'Failed', handoff: null });
  });

  it('keeps the next jobs of the key stopped until the validity of the Pay has ended, and pays again at that time, after a new read of the vault', async () => {
    const w = await world();
    vi.spyOn(w.m.chain, 'payFromVault').mockRejectedValueOnce(unseen(true));
    expect(words(await go(w))).toBe('pay_unconfirmed');
    // The twin of the end: one millisecond before the validity ends, the job is stopped. The read of the vault is not made.
    w.m.clock.now = VALID_TO - 1;
    expect(words(await go(w))).toBe(`failed ${EARLIER_PAY_MAY_LAND}`);
    expect(words(await go(w, { message: second() }))).toBe(`failed ${EARLIER_PAY_MAY_LAND}`);
    expect(w.reads.calls.liveVaults).toBe(1);
    // At the end of the validity the Pay cannot land. The vault is read again, and the hire is made from it.
    w.m.clock.now = VALID_TO;
    const done = expectKind(await go(w), 'completed');
    expect(w.reads.calls.liveVaults).toBe(2);
    expect(w.m.chain.vault(w.vault)).toMatchObject({ consumed: true });
    expect(done.vault_ref).not.toBe(w.vault);
  });

  it('does not stop a job for a Pay that certainly did not reach the node: the next job of the key pays from the same vault', async () => {
    const w = await world();
    const pay = vi.spyOn(w.m.chain, 'payFromVault').mockRejectedValueOnce(unseen(false));
    const first = expectKind(await go(w), 'pay_unconfirmed');
    expect(first.may_land).toBe(false);
    expect(words(await go(w, { message: second() }))).toBe('completed');
    expect(pay).toHaveBeenCalledTimes(2);
  });

  it('stops the next job of the key also when the error of the hire kit holds an escrow that is not an output reference: the first step is failed with inconsistent_outcome, and the Pay may land all the same', async () => {
    const NOT_A_REF = 'not an output reference';
    const w = await world();
    const pay = vi.spyOn(w.m.chain, 'payFromVault').mockRejectedValueOnce(unseen(true, NOT_A_REF));
    const first = expectKind(await go(w), 'failed');
    expect([first.reason, first.handoff]).toStrictEqual([INCONSISTENT_OUTCOME, null]);
    expect(first.cause).toBeInstanceOf(HirePayUnconfirmed);
    expect(first.cause).toMatchObject({ mayLand: true, escrowRef: NOT_A_REF, validTo: VALID_TO });
    // The next job of the key is stopped before any read of the vault and any Pay, as it is for a Pay with an escrow that is an output reference.
    const next = expectKind(await go(w, { message: second() }), 'failed');
    expect([next.reason, next.handoff, next.vault_ref]).toStrictEqual([EARLIER_PAY_MAY_LAND, null, null]);
    expect(next.detail).toContain(`${VALID_TO}`);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(w.reads.calls.liveVaults).toBe(1);
    expect(w.m.agent.sends).toStrictEqual([]);
    expect(w.m.chain.vault(w.vault)).toMatchObject({ kind: 'Live', consumed: false });
    // One millisecond before the validity ends the job is still stopped. At the end the key pays again, after a new read of the vault.
    w.m.clock.now = VALID_TO - 1;
    expect(words(await go(w, { message: second() }))).toBe(`failed ${EARLIER_PAY_MAY_LAND}`);
    w.m.clock.now = VALID_TO;
    expect(words(await go(w, { message: second() }))).toBe('completed');
    expect(w.reads.calls.liveVaults).toBe(2);
    // The twin: a Pay with the same escrow that certainly did not reach the node does not stop the next job, and it pays from the same vault.
    const twin = await world();
    const twinPay = vi.spyOn(twin.m.chain, 'payFromVault').mockRejectedValueOnce(unseen(false, NOT_A_REF));
    expect(words(await go(twin))).toBe(`failed ${INCONSISTENT_OUTCOME}`);
    expect(words(await go(twin, { message: second() }))).toBe('completed');
    expect(twinPay).toHaveBeenCalledTimes(2);
  });

  it('stops only the paying key whose Pay may land: another key on the same chain pays at once', async () => {
    const w = await world();
    const other = await otherKeyDeps(w);
    vi.spyOn(w.m.chain, 'payFromVault').mockRejectedValueOnce(unseen(true));
    expect(words(await go(w))).toBe('pay_unconfirmed');
    expect(words(await go(w, { message: second() }))).toBe(`failed ${EARLIER_PAY_MAY_LAND}`);
    expect(words(await hireCounterparty(other, input({ message: second() })))).toBe('completed');
  });

  it('does not stop a job that fails before the Pay for another reason: the stop is for a Pay that was made', async () => {
    const w = await world();
    w.reads.failDelegation = new Error('koios answered 502');
    expect(words(await go(w))).toBe('failed ledger_unavailable');
    w.reads.failDelegation = null;
    expect(untouched(w)).toStrictEqual({ posted: 0, sends: 0, stranded: 0, spent: 0 });
    expect(words(await go(w))).toBe('completed');
  });
});

describe('a ledger that throws when it books the Accept', () => {
  it('does not turn paid work into a failure: the Accept is confirmed on the chain, so the step is completed with the Accept confirmed, and it says that the booking failed', async () => {
    const w = await world();
    const boom = new Error('the ledger is closed');
    w.deps.hire.ledger.accepted = () => { throw boom; };
    const step = expectKind(await go(w), 'completed');
    expect(step.handoff).toMatchObject({ accepted: 'confirmed', paid_from_vault: true });
    expect(step.booking_failed).toStrictEqual({ cause: boom });
    expect(step.booking_failed?.cause).toBe(boom);
    expect(await w.m.chain.escrowState(step.handoff.escrow_ref)).toBe('spent');
    // The hire kit went on after the Accept: its entry in the stranded store is gone, the Post was booked, and the work was sent one time.
    expect(w.key.stranded.list()).toStrictEqual([]);
    expect(w.booked.posted).toHaveLength(1);
    expect(w.m.agent.sends).toHaveLength(1);
    // The result is completed, so nothing invites a second execute of the same work.
    expect(completedResult(pieces({ handoff: step.handoff }))).toMatchObject({ outcome: 'completed', reason: null, exit_state: 'Completed' });
  });

  it('keeps an error that is not an Error object, and its twin: a ledger that books the Accept gives a completed step with no booking failure', async () => {
    const w = await world();
    w.deps.hire.ledger.accepted = () => { throw 'a text'; };
    expect(expectKind(await go(w), 'completed').booking_failed).toStrictEqual({ cause: 'a text' });
    const twin = await world();
    const step = expectKind(await go(twin), 'completed');
    expect(step.booking_failed).toBeNull();
    expect(twin.booked.accepted).toHaveLength(1);
  });

  it('still ends the hire with an error when the ledger throws when it books the Post: no Accept was made, and the work is not done', async () => {
    const w = await world();
    w.deps.hire.ledger.posted = () => { throw new Error('the ledger is closed'); };
    const step = expectKind(await go(w), 'interrupted');
    expect(step.handoff.accepted).toBeNull();
    expect(await w.m.chain.escrowState(step.escrow_ref)).toBe('Open');
  });
});
