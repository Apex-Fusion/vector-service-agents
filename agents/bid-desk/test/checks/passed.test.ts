// agents/bid-desk/test/checks/passed.test.ts: the record of the checks that passed. The hook puts one entry for each escrow, with the hash of the request that it checked, and the job takes it. An entry
// lives for 300 seconds, the store holds 64 entries, and `take` removes the entry. The question: can a job take a record that it must not take (twice, late, or for another escrow)?
import { describe, expect, it } from 'vitest';
import type { ChecksRecord } from '@vsa/usecase-kit/checks';
import { PASSED_CHECKS_LIMIT, PASSED_CHECKS_TTL_MS, PassedChecks } from '../../src/checks/index.ts';
import type { PassedEntry } from '../../src/checks/index.ts';

const T = 1_800_000_000_000;
const HASH = 'ab'.repeat(32);
const OTHER_HASH = 'cd'.repeat(32);
/** The reference of the n-th escrow of a test. */
const refOf = (n: number): string => `${n.toString(16).padStart(64, '0')}#0`;
const record: ChecksRecord = Object.freeze({ checks: Object.freeze({ sender_active: true as const, vault_paid: true as const }), facts: Object.freeze({ organisation: 'buyer.example' }) });
const entryOf = (request_sha256: string = HASH): PassedEntry => ({ record, request_sha256 });
// The members of an entry are read-only for the compiler. A test that writes to one holds the entry as a type with a member that it may write, to show that the store holds its own frozen copy.

describe('the limits', () => {
  it('are 300 seconds and 64 entries', () => {
    expect(PASSED_CHECKS_TTL_MS).toBe(300_000);
    expect(PASSED_CHECKS_LIMIT).toBe(64);
  });
});

describe('put and take', () => {
  it('gives back the record and the hash of the request that were put', () => {
    const store = new PassedChecks();
    store.put(refOf(1), entryOf(), T);
    const taken = store.take(refOf(1), T + 1);
    expect(taken).toEqual({ record, request_sha256: HASH });
    expect(taken?.request_sha256).toBe(HASH);
    expect(taken?.record).toBe(record);
  });

  it('removes the entry when it is taken: a second take gives null', () => {
    const store = new PassedChecks();
    store.put(refOf(1), entryOf(), T);
    expect(store.take(refOf(1), T)).not.toBeNull();
    expect(store.take(refOf(1), T)).toBeNull();
  });

  it('gives null for an escrow that has no entry, and keeps each escrow apart', () => {
    const store = new PassedChecks();
    store.put(refOf(1), entryOf(HASH), T);
    store.put(refOf(2), entryOf(OTHER_HASH), T);
    expect(store.take(refOf(3), T)).toBeNull();
    expect(store.take(refOf(2), T)?.request_sha256).toBe(OTHER_HASH);
    expect(store.take(refOf(1), T)?.request_sha256).toBe(HASH);
  });

  it('gives an entry that no caller changes: the entry is frozen, and a change of the object that was put changes nothing', () => {
    const store = new PassedChecks();
    const given = entryOf();
    const changeable: { request_sha256: string } = given;
    store.put(refOf(1), given, T);
    changeable.request_sha256 = OTHER_HASH;
    const taken = store.take(refOf(1), T);
    if (taken === null) throw new Error('the entry is gone');
    const written: { request_sha256: string } = taken;
    expect(taken.request_sha256).toBe(HASH);
    expect(Object.isFrozen(taken)).toBe(true);
    expect(() => { written.request_sha256 = OTHER_HASH; }).toThrow(TypeError);
  });
});

describe('the time to live', () => {
  it('gives the entry until the last millisecond before the end of its time, and not after', () => {
    const store = new PassedChecks();
    store.put(refOf(1), entryOf(), T);
    store.put(refOf(2), entryOf(), T);
    expect(store.take(refOf(1), T + PASSED_CHECKS_TTL_MS - 1)).not.toBeNull();
    expect(store.take(refOf(2), T + PASSED_CHECKS_TTL_MS)).toBeNull();
  });

  it('removes an entry that has ended when it is taken: it is not there later, and a later time does not bring it back', () => {
    const store = new PassedChecks();
    store.put(refOf(1), entryOf(), T);
    expect(store.take(refOf(1), T + PASSED_CHECKS_TTL_MS + 10)).toBeNull();
    expect(store.take(refOf(1), T)).toBeNull();
  });

  it('counts the time from the put, and a second put for the same escrow starts the time again', () => {
    const store = new PassedChecks();
    store.put(refOf(1), entryOf(HASH), T);
    store.put(refOf(1), entryOf(OTHER_HASH), T + 200_000);
    const taken = store.take(refOf(1), T + 400_000);
    expect(taken?.request_sha256).toBe(OTHER_HASH);
  });

  it('is never kept alive by a time that is not a whole number of milliseconds: the call is a TypeError', () => {
    const store = new PassedChecks();
    store.put(refOf(1), entryOf(), T);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, '5', null, undefined]) {
      expect(() => store.take(refOf(1), bad as number), String(bad)).toThrow(TypeError);
      expect(() => store.put(refOf(2), entryOf(), bad as number), String(bad)).toThrow(TypeError);
    }
    // The entry was not taken by a call that failed.
    expect(store.take(refOf(1), T)).not.toBeNull();
  });
});

describe('the limit of entries', () => {
  const fill = (store: PassedChecks, count: number): void => {
    for (let n = 1; n <= count; n += 1) store.put(refOf(n), entryOf(), T + n);
  };

  it('holds 64 entries, and the 65th drops the oldest', () => {
    const full = new PassedChecks();
    fill(full, PASSED_CHECKS_LIMIT);
    expect(full.take(refOf(1), T + 100)).not.toBeNull();
    const store = new PassedChecks();
    fill(store, PASSED_CHECKS_LIMIT);
    store.put(refOf(65), entryOf(OTHER_HASH), T + 65);
    expect(store.take(refOf(1), T + 100)).toBeNull();
    expect(store.take(refOf(2), T + 100)).not.toBeNull();
    expect(store.take(refOf(65), T + 100)?.request_sha256).toBe(OTHER_HASH);
  });

  it('drops one entry for each entry over the limit, always the oldest', () => {
    const store = new PassedChecks();
    fill(store, PASSED_CHECKS_LIMIT + 3);
    expect([1, 2, 3, 4].map((n) => store.take(refOf(n), T + 100) !== null)).toEqual([false, false, false, true]);
    expect(store.take(refOf(PASSED_CHECKS_LIMIT + 3), T + 100)).not.toBeNull();
  });

  it('counts a second put for an escrow as the newest entry, and it takes no second place', () => {
    const store = new PassedChecks();
    fill(store, PASSED_CHECKS_LIMIT);
    store.put(refOf(1), entryOf(OTHER_HASH), T + 100);
    // The store is still full and nothing was dropped.
    expect(store.take(refOf(2), T + 100)).not.toBeNull();
    store.put(refOf(2), entryOf(), T + 101);
    store.put(refOf(65), entryOf(), T + 102);
    // Now 3 is the oldest.
    expect(store.take(refOf(3), T + 103)).toBeNull();
    expect(store.take(refOf(1), T + 103)?.request_sha256).toBe(OTHER_HASH);
  });

  it('drops the entries that have ended before it counts the limit, so a fresh entry is not dropped for them', () => {
    const store = new PassedChecks();
    for (let n = 1; n <= PASSED_CHECKS_LIMIT - 1; n += 1) store.put(refOf(n), entryOf(), T);
    store.put(refOf(64), entryOf(), T + 200_000);
    store.put(refOf(65), entryOf(), T + PASSED_CHECKS_TTL_MS);
    expect(store.take(refOf(1), T + PASSED_CHECKS_TTL_MS)).toBeNull();
    expect(store.take(refOf(64), T + PASSED_CHECKS_TTL_MS)).not.toBeNull();
    expect(store.take(refOf(65), T + PASSED_CHECKS_TTL_MS)).not.toBeNull();
  });
});

describe('what put refuses', () => {
  it('is an escrow that is not an output reference, a hash that is not a hash, and a record that is not a record', () => {
    const store = new PassedChecks();
    expect(() => store.put(refOf(1), entryOf(), T)).not.toThrow();
    for (const bad of ['', 'abc', `${'AB'.repeat(32)}#0`, `${'ab'.repeat(32)}#`, `${'ab'.repeat(32)}#01`, 5 as unknown as string]) {
      expect(() => store.put(bad, entryOf(), T), String(bad)).toThrow(TypeError);
    }
    for (const hash of ['', 'AB'.repeat(32), 'ab'.repeat(31), `${'ab'.repeat(32)}0`, 7 as unknown as string]) {
      expect(() => store.put(refOf(2), entryOf(hash), T), String(hash)).toThrow(TypeError);
    }
    for (const bad of [null, undefined, {}, { checks: {} }, { facts: {} }, { checks: 1, facts: {} }, { checks: {}, facts: null }]) {
      expect(() => store.put(refOf(3), { record: bad as unknown as ChecksRecord, request_sha256: HASH }, T), JSON.stringify(bad)).toThrow(TypeError);
    }
    expect(() => store.put(refOf(4), null as unknown as PassedEntry, T)).toThrow(TypeError);
    // Nothing that was refused is in the store.
    expect([2, 3, 4].map((n) => store.take(refOf(n), T))).toEqual([null, null, null]);
  });
});
