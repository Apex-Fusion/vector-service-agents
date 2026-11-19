// packages/service-kit/test/slot.test.ts
// The job slot and its reservation. The slot has no clock: each call that has to know the time is given it, so these tests move the time by hand.
import { describe, test, expect } from 'vitest';
import { JobSlot, RESERVATION_MS } from '../src/slot.ts';

const X = `${'a1'.repeat(32)}#0`;
const Y = `${'b2'.repeat(32)}#3`;
const T = 1_000_000;

describe('JobSlot, one job at a time', () => {
  test('without a reservation it is the slot it was: a job takes it, a second one is busy, a release frees it, a drain ends it', () => {
    const slot = new JobSlot();
    expect(slot.busy).toBe(false);
    expect([slot.take(), slot.take()]).toStrictEqual(['taken', 'busy']);
    expect(slot.busy).toBe(true);
    slot.release();
    expect(slot.busy).toBe(false);
    // An escrow reference that no reservation names is no matter.
    expect(slot.take(X, T)).toBe('taken');
    expect(slot.take(X, T)).toBe('busy');
    slot.release();
    slot.drain();
    expect([slot.take(), slot.take(X, T)]).toStrictEqual(['draining', 'draining']);
  });

  test('draining outranks busy, as before', () => {
    const slot = new JobSlot();
    expect(slot.take()).toBe('taken');
    slot.drain();
    expect(slot.take()).toBe('draining');
    slot.release();
    expect(slot.take()).toBe('draining');
  });

  test('a reservation is no job: the slot is not busy, and idle() does not wait for it', async () => {
    const slot = new JobSlot();
    expect(slot.reserve(X, T)).toBe('reserved');
    expect(slot.busy).toBe(false);
    await slot.idle();
    expect(slot.reservedFor(T)).toBe(X);
  });
});

describe('JobSlot, the reservation', () => {
  test('the length of a reservation is 120 seconds', () => {
    expect(RESERVATION_MS).toBe(120_000);
  });

  test('a reservation holds the slot for its escrow: the job of that escrow takes it, a job of another escrow or of none is held off', () => {
    const slot = new JobSlot();
    expect(slot.reserve(X, T)).toBe('reserved');
    expect(slot.reservedFor(T)).toBe(X);
    expect(slot.take(Y, T)).toBe('held');
    expect(slot.take(undefined, T)).toBe('held');
    expect(slot.busy, 'a job that is held off does not take the slot').toBe(false);
    expect(slot.reservedFor(T), 'and does not end the reservation').toBe(X);
    // The twin: the escrow of the reservation takes the slot.
    expect(slot.take(X, T)).toBe('taken');
    expect(slot.busy).toBe(true);
  });

  test('a taken reservation is gone: it is not taken twice, and once the job ends the slot is free for any escrow', () => {
    const slot = new JobSlot();
    slot.reserve(X, T);
    expect(slot.take(X, T)).toBe('taken');
    expect(slot.reservedFor(T)).toBeUndefined();
    // While the job runs, the same escrow is busy, as any other.
    expect([slot.take(X, T), slot.take(Y, T)]).toStrictEqual(['busy', 'busy']);
    slot.release();
    // After it, nothing is held for X: another escrow takes the slot, and X itself is no better off than Y.
    expect(slot.take(Y, T)).toBe('taken');
    slot.release();
    expect(slot.take(X, T)).toBe('taken');
  });

  test('a reservation is made only on a slot that is free: not while a job runs, not for another escrow, not while draining', () => {
    const slot = new JobSlot();
    expect(slot.take()).toBe('taken');
    expect(slot.reserve(X, T)).toBe('busy');
    expect(slot.reservedFor(T)).toBeUndefined();
    slot.release();
    // The twin: the same call on the free slot.
    expect(slot.reserve(X, T)).toBe('reserved');
    expect(slot.reserve(Y, T)).toBe('held');
    expect(slot.reservedFor(T), 'the refused call changes nothing').toBe(X);
    slot.drain();
    expect(slot.reserve(X, T)).toBe('draining');
    expect(slot.reserve(Y, T)).toBe('draining');
  });

  test('a reservation for the escrow that holds it is renewed: the 120 seconds start again', () => {
    const slot = new JobSlot();
    slot.reserve(X, T);
    expect(slot.reserve(X, T + 100_000)).toBe('reserved');
    expect(slot.reservedFor(T + 100_000 + RESERVATION_MS - 1)).toBe(X);
    expect(slot.reservedFor(T + 100_000 + RESERVATION_MS)).toBeUndefined();
  });

  test('a reservation that no job takes ends after 120 seconds, to the millisecond', () => {
    const slot = new JobSlot();
    slot.reserve(X, T);
    expect(slot.reservedFor(T + RESERVATION_MS - 1)).toBe(X);
    expect(slot.take(Y, T + RESERVATION_MS - 1)).toBe('held');
    expect(slot.reserve(Y, T + RESERVATION_MS - 1)).toBe('held');
    // At 120 seconds it has ended: any escrow takes the slot or reserves it.
    expect(slot.reservedFor(T + RESERVATION_MS)).toBeUndefined();
    expect(slot.reserve(Y, T + RESERVATION_MS)).toBe('reserved');
    expect(slot.reservedFor(T + RESERVATION_MS)).toBe(Y);
    const other = new JobSlot();
    other.reserve(X, T);
    expect(other.take(Y, T + RESERVATION_MS)).toBe('taken');
  });

  test('an ended reservation does not come back when the clock is set back', () => {
    const slot = new JobSlot();
    slot.reserve(X, T);
    expect(slot.reservedFor(T + 500_000)).toBeUndefined(); // seen as ended
    expect(slot.reservedFor(T + 1)).toBeUndefined(); // the clock is set back into its window: it is not alive again
    expect(slot.take(Y, T + 1)).toBe('taken');
  });

  test('a clock that was set back before the reservation was made ends it at once, so that the slot is never held for an hour', () => {
    const slot = new JobSlot();
    slot.reserve(X, T);
    expect(slot.reservedFor(T - 1)).toBeUndefined();
    const again = new JobSlot();
    again.reserve(X, T);
    expect(again.take(Y, T - 3_600_000)).toBe('taken');
  });

  test('draining outranks a reservation, for the escrow that holds it too', () => {
    const slot = new JobSlot();
    slot.reserve(X, T);
    slot.drain();
    expect([slot.take(X, T), slot.take(Y, T)]).toStrictEqual(['draining', 'draining']);
  });

  test('canTake looks and changes nothing: it says what take would say, and a free slot stays free', () => {
    const slot = new JobSlot();
    expect(slot.canTake(X, T)).toBe('free');
    expect(slot.reservedFor(T)).toBeUndefined();
    expect(slot.busy).toBe(false);
    slot.reserve(X, T);
    expect([slot.canTake(X, T), slot.canTake(Y, T), slot.canTake(undefined, T)]).toStrictEqual(['free', 'held', 'held']);
    expect(slot.reservedFor(T), 'the look did not take the reservation').toBe(X);
    slot.take(X, T);
    expect([slot.canTake(X, T), slot.canTake(Y, T)]).toStrictEqual(['busy', 'busy']);
    slot.release();
    slot.drain();
    expect(slot.canTake(X, T)).toBe('draining');
  });

  test('release frees the slot and wakes the stop that waits for it, as before', async () => {
    const slot = new JobSlot();
    slot.reserve(X, T);
    slot.take(X, T);
    let idle = false;
    const wait = slot.idle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    slot.release();
    await wait;
    expect(idle).toBe(true);
  });
});
