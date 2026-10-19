// packages/hire-kit/test/budget.test.ts
// The waits of one hire (src/budget.ts): the four numbers, and the three rules that hold a wait to its limit and to the deadline, each of which now takes
// the error of the limit and the error of the deadline from its caller. The waits of a whole hire are held through hireOne in test/hire.test.ts and, for
// the Document Pipeline, in agents/document-pipeline/test/orchestrate.test.ts.
import { describe, expect, test } from 'vitest';
import { BUSY_RETRY_MS, POLL_INTERVAL_MS, RECEIPT_HASH_WAIT_MS, SEND_CUTOFF_MS, checkWithin, fit, waitWithin } from '../src/budget.ts';
import type { Clocked } from '../src/budget.ts';

/** A clock at `now` with its deadline at 100, whose sleep moves it and is counted. */
function clocked(now: number): Clocked & { now: number; slept: number[] } {
  const t = { now, slept: [] as number[], deadlineMs: 100, clock: () => t.now, sleep: async (ms: number) => { t.slept.push(ms); t.now += ms; } };
  return t;
}
const limitError = (): Error => new Error('past the limit');
const deadlineError = (): Error => new Error('past the deadline');

describe('the waits of a hire', () => {
  test('a send again every 15 s until 90 s before deliver_by, a poll every 3 s, and 120 s for the hash of a receipt to show on chain', () => {
    expect([BUSY_RETRY_MS, SEND_CUTOFF_MS, POLL_INTERVAL_MS, RECEIPT_HASH_WAIT_MS]).toStrictEqual([15_000, 90_000, 3_000, 120_000]);
  });

  test('fit: a moment equal to a limit is in time; past it, the limit or the deadline that ends first, the deadline when they are the same moment', () => {
    const t = clocked(0);
    expect([fit(t, 80, 80), fit(t, 81, 80), fit(t, 100, 120), fit(t, 101, 120), fit(t, 101, 100)]).toStrictEqual(['in time', 'past the limit', 'in time', 'past the deadline', 'past the deadline']);
  });

  test('checkWithin throws what onLimit makes past the limit and what onDeadline makes past the deadline, and nothing in time', () => {
    const t = clocked(0);
    expect(() => checkWithin(t, 81, 80, limitError, deadlineError)).toThrow('past the limit');
    expect(() => checkWithin(t, 101, 120, limitError, deadlineError)).toThrow('past the deadline');
    expect(() => checkWithin(t, 80, 80, limitError, deadlineError)).not.toThrow();
  });

  test('waitWithin sleeps when the moment after the sleep is in time, and throws without sleeping when it is not', async () => {
    const t = clocked(90);
    await waitWithin(t, 10, 120, limitError, deadlineError);
    expect([t.now, t.slept]).toStrictEqual([100, [10]]);
    await expect(waitWithin(t, 1, 120, limitError, deadlineError)).rejects.toThrow('past the deadline');
    const early = clocked(0);
    await expect(waitWithin(early, 81, 80, limitError, deadlineError)).rejects.toThrow('past the limit');
    expect([t.slept, early.slept]).toStrictEqual([[10], []]);
  });
});
