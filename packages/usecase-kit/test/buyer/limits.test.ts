// packages/usecase-kit/test/buyer/limits.test.ts: the three limits of a hire. A limit is a bigint of at least 0, or `null` when the caller chooses no limit. Nothing is filled in: a limit that is
// missing, a number, a text or any other value is refused, and its refusal names the limit and its type and never repeats its value.
import { describe, expect, it } from 'vitest';
import { LIMIT_NAMES, checkLimits } from '@vsa/usecase-kit/buyer';

const ALL = { maxPriceLovelace: 500_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: null };

describe('checkLimits', () => {
  it('names the three limits of the hire kit, in its order', () => {
    expect([...LIMIT_NAMES]).toStrictEqual(['maxPriceLovelace', 'maxSupplierBondLovelace', 'maxBuyerBondLovelace']);
  });

  it('takes a bigint or null for each limit, and returns the values it checked as a new object', () => {
    expect(checkLimits(ALL)).toStrictEqual({ ok: true, value: ALL });
    expect(checkLimits({ maxPriceLovelace: null, maxSupplierBondLovelace: null, maxBuyerBondLovelace: null })).toStrictEqual({
      ok: true, value: { maxPriceLovelace: null, maxSupplierBondLovelace: null, maxBuyerBondLovelace: null },
    });
    const given = { ...ALL, extra: 1 };
    const checked = checkLimits(given);
    expect(checked.ok && checked.value).not.toBe(given);
    expect(checked.ok && Object.keys(checked.value)).toStrictEqual([...LIMIT_NAMES]);
  });

  it('takes a limit of 0, which allows an advert that is free, and refuses a negative limit', () => {
    expect(checkLimits({ ...ALL, maxPriceLovelace: 0n }).ok).toBe(true);
    const refused = checkLimits({ ...ALL, maxPriceLovelace: -1n });
    expect(refused).toMatchObject({ ok: false, code: 'bad_limit' });
    expect(refused.ok ? '' : refused.detail).toContain('maxPriceLovelace');
  });

  for (const name of LIMIT_NAMES) {
    it(`refuses ${name} when it is missing, and it never counts a missing limit as no limit`, () => {
      const given: Record<string, unknown> = { ...ALL };
      delete given[name];
      const refused = checkLimits(given);
      expect(refused).toMatchObject({ ok: false, code: 'bad_limit' });
      expect(refused.ok ? '' : refused.detail).toBe(`${name} must be a bigint or null, and it is missing`);
      // The twin: the same limit given as null is the choice of no limit.
      expect(checkLimits({ ...given, [name]: null }).ok).toBe(true);
    });

    it(`refuses ${name} when it is undefined, a number, a text, a boolean, an object or a list, and names the type and not the value`, () => {
      const wrong: Array<[unknown, string]> = [
        [undefined, 'missing'], [1_000_000, 'a number'], ['1000000', 'a text'], [true, 'a boolean'], [{ lovelace: 1n }, 'an object'], [[1n], 'a list'], [Symbol('x'), 'a symbol'],
        [() => 1n, 'a function'], [Number.NaN, 'a number'],
      ];
      for (const [value, kind] of wrong) {
        const refused = checkLimits({ ...ALL, [name]: value });
        expect(refused).toMatchObject({ ok: false, code: 'bad_limit' });
        expect(refused.ok ? '' : refused.detail).toBe(`${name} must be a bigint or null, and it is ${kind}`);
      }
      expect(checkLimits({ ...ALL, [name]: 1_000_000n }).ok).toBe(true);
    });
  }

  it('refuses a value that is not an object of limits, and the detail repeats nothing', () => {
    for (const value of [undefined, null, 7, 'limits', [], [500_000n, 1n, null]]) {
      const refused = checkLimits(value);
      expect(refused).toMatchObject({ ok: false, code: 'bad_limit' });
      expect(refused.ok ? '' : refused.detail).toBe('the limits must be an object with the three limits of a hire');
    }
  });

  it('reads each limit one time: a getter that gives another value at the second read cannot change what was checked', () => {
    let reads = 0;
    const given = {
      get maxPriceLovelace(): unknown { reads += 1; return reads === 1 ? 7n : 'no limit'; },
      maxSupplierBondLovelace: null, maxBuyerBondLovelace: null,
    };
    const checked = checkLimits(given);
    expect(checked).toStrictEqual({ ok: true, value: { maxPriceLovelace: 7n, maxSupplierBondLovelace: null, maxBuyerBondLovelace: null } });
    expect(reads).toBe(1);
  });

  it('refuses a limit that cannot be read, names the limit, and repeats nothing of the error: a getter that throws, and a Proxy that throws', () => {
    for (const name of LIMIT_NAMES) {
      const given = { ...ALL, get [name](): never { throw new Error('SECRET-SETTING'); } };
      const refused = checkLimits(given);
      expect(refused).toStrictEqual({ ok: false, code: 'bad_limit', detail: `${name} cannot be read` });
      expect(JSON.stringify(refused)).not.toContain('SECRET-SETTING');
    }
    const proxy = new Proxy({}, { get: () => { throw new Error('SECRET-SETTING'); } });
    expect(checkLimits(proxy)).toStrictEqual({ ok: false, code: 'bad_limit', detail: 'maxPriceLovelace cannot be read' });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(checkLimits(revoked.proxy)).toStrictEqual({ ok: false, code: 'bad_limit', detail: 'the limits must be an object with the three limits of a hire' });
    // The twin: limits that can be read are taken.
    expect(checkLimits(ALL).ok).toBe(true);
  });
});
