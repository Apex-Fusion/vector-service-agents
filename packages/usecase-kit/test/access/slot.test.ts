// packages/usecase-kit/test/access/slot.test.ts: the slot rule of the identity deployment. The slot clock of buyer-core is set one time for a process, from the first node that gives a usable system start.
// So the test of a node that gives none comes first: it sets nothing.
import { describe, expect, it } from 'vitest';
import { deploymentSlotAt } from '../../src/access/index.ts';
import { NOW, ZERO_TIME, slotOf } from './support.ts';

describe('the slot rule of the identity deployment', () => {
  it('rejects when the node cannot be read, and when it gives a system start that is not a number', async () => {
    await expect(deploymentSlotAt({ getSystemStartMs: () => Promise.reject(new Error('the node is down')) })(NOW)).rejects.toThrow('the node is down');
    for (const start of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(deploymentSlotAt({ getSystemStartMs: async () => start })(NOW)).rejects.toThrow('did not report a usable chain start time');
    }
  });

  it('gives the slot that contains a time: slot 0 starts at the system start of the node, a slot lasts one second, and a time is rounded down', async () => {
    const slotAt = deploymentSlotAt({ getSystemStartMs: async () => ZERO_TIME });
    expect(await slotAt(ZERO_TIME)).toBe(0);
    expect(await slotAt(ZERO_TIME + 999)).toBe(0);
    expect(await slotAt(ZERO_TIME + 1_000)).toBe(1);
    expect(await slotAt(NOW)).toBe(38_690_400);
    expect(await slotAt(NOW + 1_799_999)).toBe(38_692_199);
    expect(await slotAt(NOW + 1_800_000)).toBe(38_692_200);
  });

  it('is the rule of the fake ledger of the tests, so that the fake builder and the real builder agree', async () => {
    const slotAt = deploymentSlotAt({ getSystemStartMs: async () => ZERO_TIME });
    for (const ms of [NOW, NOW + 1, NOW + 999, NOW + 123_456_789]) expect(await slotAt(ms), String(ms)).toBe(slotOf(ms));
  });
});
