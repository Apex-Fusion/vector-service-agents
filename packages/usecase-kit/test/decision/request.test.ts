// packages/usecase-kit/test/decision/request.test.ts: the call that `decide` makes to hire-kit. `hireModel` is wrapped: it still runs, and each test sees its calls. A decision that passes its checks makes
// exactly one call, with the key and the ports of the caller and the four limits as the caller gave them, each in its own field. A decision that fails a check makes none. The record of a hire is not
// trusted: a record with a check that is not true gives no decision, also when hire-kit says that the hire completed. A result of a hire that has a wrong form is a typed failure that says that the hire
// was paid, or may be. Each refusal has an accepted twin.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as HireKit from '@vsa/hire-kit';
import { FakeChain, TxNotConfirmedError } from '@vsa/buyer-core';
import { hireModel } from '@vsa/hire-kit';
import type { Hired, ModelAnswer } from '@vsa/hire-kit';
import { ALLOWLIST, LLM_ADVERT, T0, escrowNo } from '@vsa/hire-kit/testing';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { decide } from '@vsa/usecase-kit/decision';
import type { DecisionDeps, ModelLimits } from '@vsa/usecase-kit/decision';
import { LIMITS, MEDIUM_LOT, REORDER, STOCK_INPUT, cleanup, lost, promptOf, said, setup, won } from './support.ts';
import type { Run } from './support.ts';

vi.mock('@vsa/hire-kit', async (importOriginal) => {
  const original = await importOriginal<typeof HireKit>();
  return { ...original, hireModel: vi.fn(original.hireModel) };
});

const hires = vi.mocked(hireModel);
afterEach(() => { cleanup(); hires.mockClear(); });

const MARKER = 'ZQ9-marker-7f3';

describe('the call to hireModel', () => {
  it('is one call for a decision, with the key and the ports of the caller, and the request that the checks of decide made', async () => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    const deps: DecisionDeps = { ...run.deps, log: () => undefined, options: { firstSendBy: T0 + 900_000, receiptBy: T0 + 950_000 } };
    won(await decide(deps, REORDER, STOCK_INPUT));
    expect(hires).toHaveBeenCalledTimes(1);
    const [key, ports, request] = hires.mock.calls[0]!;
    expect(key).toBe(run.key);
    // The ports are the ports of the caller. The key and the limits are not among them. The ledger is the ledger of the caller with a note of what it is told, so it is a new object.
    expect(Object.keys(ports).sort()).toStrictEqual(['clock', 'deadlineMs', 'fetchImpl', 'indexerUrl', 'ledger', 'log', 'options', 'sleep']);
    expect([ports.clock, ports.sleep, ports.fetchImpl, ports.log, ports.options]).toStrictEqual([deps.clock, deps.sleep, deps.fetchImpl, deps.log, deps.options]);
    expect(ports.ledger).not.toBe(deps.ledger);
    expect([ports.deadlineMs, ports.indexerUrl]).toStrictEqual([deps.deadlineMs, deps.indexerUrl]);
    expect(request).toStrictEqual({
      input: promptOf(REORDER, STOCK_INPUT),
      label: 'reorder',
      allowlist: [...ALLOWLIST],
      maxPriceLovelace: LIMITS.maxPriceLovelace,
      maxSupplierBondLovelace: LIMITS.maxSupplierBondLovelace,
      maxBuyerBondLovelace: LIMITS.maxBuyerBondLovelace,
      ceilingSetting: 'LLM_MAX_PRICE_LOVELACE',
      minLeftAtTurnMs: 60_000,
    });
  });

  it('gives each call of the ledger to the ledger of the caller, with its argument and in its order', async () => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    const calls: unknown[] = [];
    run.deps.ledger = {
      posted: (post) => { calls.push(['posted', post.lockLovelace, post.feeLovelace]); },
      accepted: (accept) => { calls.push(['accepted', accept.feeLovelace]); },
    };
    won(await decide(run.deps, REORDER, STOCK_INPUT));
    expect(calls).toStrictEqual([['posted', FakeChain.LOCK_LOVELACE, FakeChain.FEE_LOVELACE], ['accepted', expect.any(BigInt)]]);
  });

  it.each<[string, ModelLimits]>([
    ['a price, a supplier bond and no limit for the buyer bond', { allowlist: ['x/y', LLM_ADVERT.model], maxPriceLovelace: 7n, maxSupplierBondLovelace: 3n, maxBuyerBondLovelace: null }],
    ['a price, no limit for the supplier bond and a buyer bond', { allowlist: [LLM_ADVERT.model], maxPriceLovelace: 5n, maxSupplierBondLovelace: null, maxBuyerBondLovelace: 4n }],
    ['limits of 0', { allowlist: [LLM_ADVERT.model], maxPriceLovelace: 0n, maxSupplierBondLovelace: 0n, maxBuyerBondLovelace: 0n }],
  ])('puts each limit in its own field of the request, and null only where the caller wrote null: %s', async (_name, limits) => {
    const run = await setup({}, undefined, limits);
    hires.mockRejectedValueOnce(new Error('stop here'));
    await decide(run.deps, REORDER, STOCK_INPUT);
    const request = hires.mock.calls[0]![2];
    expect([request.allowlist, request.maxPriceLovelace, request.maxSupplierBondLovelace, request.maxBuyerBondLovelace])
      .toStrictEqual([limits.allowlist, limits.maxPriceLovelace, limits.maxSupplierBondLovelace, limits.maxBuyerBondLovelace]);
  });

  it('is no call at all for a decision that fails a check: a limit, the definition or the input', async () => {
    const run = await setup();
    const bad: DecisionDeps = { ...run.deps, limits: { ...LIMITS, maxSupplierBondLovelace: undefined as unknown as null } };
    expect(lost(await decide(bad, REORDER, STOCK_INPUT)).reason).toBe('bad_limit');
    expect(lost(await decide(run.deps, { ...REORDER, name: 'Not A Name' }, STOCK_INPUT)).reason).toBe('bad_decision');
    expect(lost(await decide(run.deps, REORDER, { on_hand: 1n } as unknown as JsonValue)).reason).toBe('bad_input');
    expect(hires).not.toHaveBeenCalled();
    // The twin: a decision that passes its checks makes its call.
    run.m.llm.answer = said(MEDIUM_LOT);
    won(await decide(run.deps, REORDER, STOCK_INPUT));
    expect(hires).toHaveBeenCalledTimes(1);
  });
});

describe('the record of a hire is not trusted', () => {
  /** A hire that completed, as hire-kit gave it, for the tests below to change. */
  async function completed(run: Run): Promise<Hired<ModelAnswer>> {
    run.m.llm.answer = said(MEDIUM_LOT);
    won(await decide(run.deps, REORDER, STOCK_INPUT));
    return await (hires.mock.results[0]!.value as Promise<Hired<ModelAnswer>>);
  }

  it('gives no decision when hire-kit says that the hire completed and one check of the receipt is not true: the failure says that the hire was paid', async () => {
    const run = await setup();
    const hired = await completed(run);
    const { escrow_ref: escrow } = hired.record;
    const verification = { ...hired.record.verification, response_hash_matches: false };
    hires.mockResolvedValueOnce({ ...hired, record: { ...hired.record, verification } });
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.stage, failure.escrow_ref]).toStrictEqual(['inference_failed', 'llm_receipt_failed', 'accept', escrow]);
    // The Accept was made. The failure holds what can be recorded: the escrow, the advert, the supplier and the eight checks, with the check that is not true. It holds no receipt.
    expect(failure.delivery).toStrictEqual({
      sub_job: null, receipt: 'not_recordable', accepted: 'confirmed', escrow_ref: escrow, advert_ref: hired.record.advert_ref, supplier_pkh: hired.record.supplier_pkh, verification,
    });
    expect(failure.detail).toBe(`the model hire for the decision reorder ended with llm_receipt_failed at accept; its escrow ${escrow} was accepted, so the supplier is paid; the receipt did not pass the checks response_hash_matches`);
  });

  it('gives no decision when the record has a member of the wrong form: the failure has no escrow when nothing else names it', async () => {
    const run = await setup();
    const hired = await completed(run);
    hires.mockResolvedValueOnce({ ...hired, record: { ...hired.record, escrow_ref: 'not a reference' } });
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.stage, failure.escrow_ref]).toStrictEqual(['inference_failed', 'llm_bad_result', 'accept', null]);
    expect(failure.delivery).toStrictEqual({
      sub_job: null, receipt: 'not_recordable', accepted: 'confirmed', escrow_ref: null, advert_ref: hired.record.advert_ref, supplier_pkh: hired.record.supplier_pkh,
      verification: hired.record.verification,
    });
    expect(failure.detail).toContain('ended with llm_bad_result at accept; its escrow was accepted, so the supplier is paid; the record of the hire has escrow_ref must be');
    expect(failure.detail).not.toContain('not a reference');
  });

  it('names the escrow that the ledger was told when the record cannot name it', async () => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    const real = hires.getMockImplementation()!;
    hires.mockImplementationOnce(async (...args) => {
      const hired = await real(...args);
      return { ...hired, record: { ...hired.record, escrow_ref: 'not a reference' } };
    });
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.reason, failure.stage, failure.escrow_ref, failure.delivery?.sub_job]).toStrictEqual(['llm_bad_result', 'accept', escrowNo(1), null]);
    expect(failure.detail).toContain(`its escrow ${escrowNo(1)} was accepted, so the supplier is paid`);
  });

  it('gives the decision for the record as it was: the twin', async () => {
    const run = await setup();
    const hired = await completed(run);
    hires.mockResolvedValueOnce(hired);
    const decision = won(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([decision.choice, decision.inference.sub_job.escrow_ref, decision.inference.accepted]).toStrictEqual([MEDIUM_LOT, hired.record.escrow_ref, 'confirmed']);
  });
});

describe('a result of a hire that has a wrong form, after its Accept', () => {
  const E1 = escrowNo(1);
  const unseen = (ref: string): TxNotConfirmedError => new TxNotConfirmedError('The Accept was submitted, but Koios did not report it confirmed.', { txHash: 'ac'.repeat(32), escrowRef: ref, deliverBy: null, validTo: T0 + 606_000, mayLand: true });

  /** The next hire runs as hire-kit runs it, with its Post, its Accept and its calls to the ledger. Then `change` gives the result that hire-kit hands over. */
  function handOver(change: (hired: Hired<ModelAnswer>) => unknown): void {
    const real = hires.getMockImplementation()!;
    hires.mockImplementationOnce(async (...args) => change(await real(...args)) as Hired<ModelAnswer>);
  }

  const FORMS: Array<[string, (hired: Hired<ModelAnswer>) => unknown, string]> = [
    ['a hire that is null', () => null, 'TypeError'],
    ['a record that is null', (hired) => ({ ...hired, record: null }), 'TypeError'],
    ['a record whose verification throws when it is read', (hired) => ({ ...hired, record: { ...hired.record, get verification(): never { throw new Error(`no read ${MARKER}`); } } }), 'Error'],
    ['an answer that is null', (hired) => ({ ...hired, value: null }), 'TypeError'],
    ['an answer whose text is not a text', (hired) => ({ ...hired, value: { ...hired.value, text: 5 } }), 'TypeError'],
    ['an Accept state that is missing', (hired) => ({ ...hired, accepted: undefined }), 'TypeError'],
    ['an Accept state that is another word', (hired) => ({ ...hired, accepted: 'maybe' }), 'TypeError'],
  ];
  const STATES: Array<{ accept: 'confirmed' | 'pending'; wrap: Parameters<typeof setup>[1]; said: string }> = [
    { accept: 'confirmed', wrap: undefined, said: `its escrow ${E1} was accepted, so the supplier is paid` },
    { accept: 'pending', wrap: () => ({ accept: async (ref) => { throw unseen(ref); } }), said: `the Accept of its escrow ${E1} was sent and the chain does not show it yet, so the supplier may be paid` },
  ];

  for (const state of STATES) {
    describe(`with an Accept that is ${state.accept}`, () => {
      it.each(FORMS)('is a failure that says that the hire was paid, or may be, with the escrow and the stage: %s', async (_name, change, kind) => {
        const run = await setup({}, state.wrap);
        run.m.llm.answer = said(MEDIUM_LOT);
        handOver(change);
        const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
        expect([failure.code, failure.reason, failure.stage, failure.escrow_ref]).toStrictEqual(['inference_failed', 'hire_threw', 'accept', E1]);
        expect(failure.detail).toBe(`the model hire for the decision reorder threw ${kind} after its Accept; ${state.said}`);
        // The result is not read again, so the delivery holds the escrow that the ledger was told of, and nothing else.
        expect(failure.delivery).toStrictEqual({ sub_job: null, receipt: 'not_recordable', accepted: state.accept, escrow_ref: E1, advert_ref: null, supplier_pkh: null, verification: null });
        expect(JSON.stringify(failure)).not.toContain(MARKER);
        expect('value' in failure).toBe(false);
        // The hire was made one time, and nothing hires again.
        expect([run.booked.length, run.m.llm.sends.length]).toStrictEqual([1, 1]);
      });

      it('records the decision for a result of the right form: the twin', async () => {
        const run = await setup({}, state.wrap);
        run.m.llm.answer = said(MEDIUM_LOT);
        handOver((hired) => hired);
        const decision = won(await decide(run.deps, REORDER, STOCK_INPUT));
        expect([decision.choice, decision.inference.accepted, decision.inference.sub_job.escrow_ref]).toStrictEqual([MEDIUM_LOT, state.accept, E1]);
      });
    });
  }
});

describe('a call that throws what hire-kit did not make', () => {
  it.each<[string, unknown, string]>([
    ['a text', `a text ${MARKER}`, 'a value that is not an error'],
    ['an object', { message: MARKER }, 'a value that is not an error'],
    ['an error', new TypeError(`broke ${MARKER}`), 'TypeError'],
    ['an error with a name that is not a name', Object.assign(new Error('x'), { name: `Bad Name ${MARKER}\nsecond line` }), 'a value that is not an error'],
  ])('is a failure with the reason hire_threw, and never a pass: %s', async (_name, thrown, what) => {
    const run = await setup();
    hires.mockRejectedValueOnce(thrown);
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.delivery, failure.escrow_ref, failure.stage]).toStrictEqual(['inference_failed', 'hire_threw', null, null, null]);
    expect(failure.detail).toBe(`the model hire for the decision reorder threw ${what}, and the state of its escrow is not known`);
    expect(JSON.stringify(failure)).not.toContain(MARKER);
  });
});
