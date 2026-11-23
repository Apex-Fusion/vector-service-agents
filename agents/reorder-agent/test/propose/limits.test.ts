// agents/reorder-agent/test/propose/limits.test.ts: the time and the hang-up. Every wait of the job is bounded by the deadline, which comes 1,620,000 ms after the arrival of the job. A job that arrives with too
// little time fails before it sends anything to the chain, a sub-delegation gets a budget that leaves room for its end step inside the deadline, and a caller that hangs up stops the job before its next step: a
// sub-delegation that was made is still ended. Each limit has its twin: the same job one millisecond inside it.
import { describe, expect, it } from 'vitest';
import { accepted } from '@vsa/usecase-kit/protocol';
import { PROPOSE_DEADLINE_MS } from '../../src/propose/index.ts';
import { NOW, SUPPLIER, TENANT, expectFailed, expectRecordedAndEnded, expectUntouched, issued, proposed, world } from './support.ts';

/** The least time that a job needs for a sub-delegation: the least wait for the confirmations, the job under the sub-delegation, and the end step. */
const LEAST_MS = 180_000 + 240_000 + 120_000;

describe('the deadline', () => {
  it('is 1,620,000 ms after the arrival of the job', () => {
    expect(PROPOSE_DEADLINE_MS).toBe(1_620_000);
  });

  it('fails with deadline before it does anything when the deadline is past or the time of the arrival is no number, and goes on for a job that has the time that it needs: the twin', async () => {
    for (const arrivedAt of [NOW - PROPOSE_DEADLINE_MS, NOW - PROPOSE_DEADLINE_MS - 5_000, Number.NaN]) {
      const w = world();
      expectFailed(await w.run({ arrivedAt }), 'deadline');
      expectUntouched(w);
      expect(w.supplierCalls).toStrictEqual([]);
    }
    const twin = world();
    proposed(await twin.run({ arrivedAt: NOW - PROPOSE_DEADLINE_MS + LEAST_MS }));
  });

  it('fails with deadline before it sends anything to the chain when the time left is under the least budget of a sub-delegation, and runs with exactly the least budget: the twin', async () => {
    const short = world();
    expectFailed(await short.run({ arrivedAt: NOW - PROPOSE_DEADLINE_MS + LEAST_MS - 1 }), 'deadline');
    expect(short.supplierCalls).toHaveLength(1);
    expectUntouched(short);
    const exact = world();
    const arrivedAt = NOW - PROPOSE_DEADLINE_MS + LEAST_MS;
    proposed(await exact.run({ arrivedAt }));
    await expectRecordedAndEnded(exact);
    expect(exact.clock.now()).toBeLessThanOrEqual(arrivedAt + PROPOSE_DEADLINE_MS);
  });

  it('trims the wait for the confirmations so that the end step is inside the deadline, and gives the full wait to a job that has the time: the twin', async () => {
    const trimmed = world();
    trimmed.chain.faults.neverConfirm = true;
    const arrivedAt = NOW - 1_000_000;
    expectFailed(await trimmed.run({ arrivedAt }), 'sub_delegation_confirmation_timeout');
    await expectRecordedAndEnded(trimmed);
    expect(trimmed.clock.now()).toBeGreaterThanOrEqual(NOW + 260_000);
    expect(trimmed.clock.now()).toBeLessThan(NOW + 300_000);
    expect(trimmed.clock.now()).toBeLessThanOrEqual(arrivedAt + PROPOSE_DEADLINE_MS);
    const full = world();
    full.chain.faults.neverConfirm = true;
    expectFailed(await full.run(), 'sub_delegation_confirmation_timeout');
    await expectRecordedAndEnded(full);
    expect(full.clock.now()).toBeGreaterThanOrEqual(NOW + 360_000);
    expect(full.clock.now()).toBeLessThan(NOW + 400_000);
  });
});

describe('a caller that hangs up', () => {
  it('stops the job before its first step, and a signal that did not abort is the twin', async () => {
    const hungUp = world();
    const controller = new AbortController();
    controller.abort();
    expectFailed(await hungUp.run({ signal: controller.signal }), 'aborted');
    expectUntouched(hungUp);
    expect(hungUp.supplierCalls).toStrictEqual([]);
    proposed(await world().run({ signal: new AbortController().signal }));
  });

  it('stops the job before the sub-delegation when the caller hangs up during the read of the supplier, and sends nothing to the chain', async () => {
    const w = world();
    const controller = new AbortController();
    w.script.readSupplier = async () => {
      controller.abort();
      return accepted(SUPPLIER);
    };
    expectFailed(await w.run({ signal: controller.signal }), 'aborted');
    expect(w.supplierCalls).toHaveLength(1);
    expectUntouched(w);
  });

  it('still ends the sub-delegation when the caller hangs up during the stock read, and then never asks the model and takes no number', async () => {
    const w = world();
    const controller = new AbortController();
    w.script.requestToken = async (request) => {
      controller.abort();
      return issued(request, w.clock.now());
    };
    expectFailed(await w.run({ signal: controller.signal }), 'aborted');
    await expectRecordedAndEnded(w);
    expect(w.reorderCalls).toStrictEqual([]);
    expect(await w.counter.next(TENANT)).toBe(1);
  });

  it('keeps the proposal when the caller hangs up during the model decision: the decision is paid for', async () => {
    const w = world();
    const controller = new AbortController();
    const decision = w.script.reorder;
    w.script.reorder = async (reading, lots) => {
      controller.abort();
      return decision(reading, lots);
    };
    const result = proposed(await w.run({ signal: controller.signal }));
    expect(result.document.po_number).toBe('run1-1');
  });
});
