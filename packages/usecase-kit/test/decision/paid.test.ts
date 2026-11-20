// packages/usecase-kit/test/decision/paid.test.ts: a paid hire is always in the failure. The Accept pays the supplier, and what fails after it does not undo that. Every failure after a Post has the escrow
// and the stage, and every failure after an Accept says that the hire was paid and holds as much of the delivery as can be recorded. An Accept that was sent and may still land counts too: a store that cannot
// be written for it gives a failure that says that the supplier may be paid. The supplier writes the receipt, so a supplier can make a hire that is paid and whose receipt the protocol refuses. Each case has
// an accepted twin.
import { afterEach, describe, expect, it } from 'vitest';
import { TxNotConfirmedError } from '@vsa/buyer-core';
import { LLM_ADVERT_REF, LLM_KEY, T0, escrowNo } from '@vsa/hire-kit/testing';
import { RECEIPT_CHECKS } from '@vsa/usecase-kit/protocol';
import { decide } from '@vsa/usecase-kit/decision';
import { MEDIUM_LOT, REORDER, STOCK_INPUT, cleanup, lost, said, setup, won } from './support.ts';
import type { Run } from './support.ts';

afterEach(cleanup);

const MARKER = 'ZQ9-marker-7f3';
const E1 = escrowNo(1);
const ALL_TRUE = Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true]));

/** A list nested `levels` deep around 1. */
function nest(levels: number): unknown {
  let value: unknown = 1;
  for (let level = 0; level < levels; level += 1) value = [value];
  return value;
}

const unseen = (ref: string): TxNotConfirmedError => new TxNotConfirmedError('The Accept was submitted, but Koios did not report it confirmed.', {
  txHash: 'ac'.repeat(32), escrowRef: ref, deliverBy: null, validTo: T0 + 606_000, mayLand: true,
});

describe('a receipt that the protocol refuses, after an Accept', () => {
  const PAID = `its escrow ${E1} was accepted, so the supplier is paid`;
  const head = 'the model hire for the decision reorder ended with llm_bad_result at accept';

  it.each<[string, unknown, string]>([
    ['a key that is a whole number', { 1: 1 }, 'holds, at depth 2, a value or a key that JSON data does not allow'],
    ['a key that is a whole number below a key of the supplier', { [`${MARKER}-key`]: { 7: 1 } }, 'holds, at depth 3, a value or a key that JSON data does not allow'],
    ['a key that is not in the NFC form', { [`${MARKER}-cafe\u0301`]: 1 }, 'holds, at depth 2, a value or a key that JSON data does not allow'],
    ['a nest of 40 levels', nest(40), 'is nested deeper than 32 levels'],
  ])('is a failure that says that the escrow was paid, with the escrow, the advert, the supplier and the eight checks: %s', async (_name, tokens, where) => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    run.m.llm.tokens = { prompt_tokens: tokens, completion_tokens: 2 };
    const failure = lost(await decide(run.deps, REORDER, { ...STOCK_INPUT, note: MARKER }));
    expect([failure.code, failure.reason, failure.stage, failure.escrow_ref]).toStrictEqual(['inference_failed', 'llm_bad_result', 'accept', E1]);
    expect(failure.detail).toBe(`${head}; ${PAID}; the record of the hire has a receipt that ${where}`);
    // As much of the delivery as can be recorded, and a typed member that says that the receipt is not recorded.
    expect(failure.delivery).toStrictEqual({
      sub_job: null, receipt: 'not_recordable', accepted: 'confirmed', escrow_ref: E1, advert_ref: LLM_ADVERT_REF, supplier_pkh: LLM_KEY.pkh, verification: ALL_TRUE,
    });
    expect(JSON.stringify(failure)).not.toContain(MARKER);
    // The escrow was accepted: the supplier is paid. One Post, one send, and nothing left for the janitor.
    expect(await run.m.chain.escrowState(E1)).toBe('spent');
    expect([run.booked.length, run.m.llm.sends.length, run.key.stranded.list()]).toStrictEqual([1, 1, []]);
    expect('value' in failure).toBe(false);
  });

  it('records the decision for a receipt with the same members and no fault: the twin', async () => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    run.m.llm.tokens = { prompt_tokens: { [`${MARKER}-key`]: { a: 1 } }, completion_tokens: 2 };
    const decision = won(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([decision.inference.sub_job.escrow_ref, decision.inference.accepted]).toStrictEqual([E1, 'confirmed']);
  });

  it('says that the supplier may be paid when the Accept was sent and is not seen on the chain', async () => {
    const run = await setup({}, () => ({ accept: async (ref) => { throw unseen(ref); } }));
    run.m.llm.answer = said(MEDIUM_LOT);
    run.m.llm.tokens = { prompt_tokens: { 1: 1 }, completion_tokens: 2 };
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.reason, failure.stage, failure.escrow_ref]).toStrictEqual(['llm_bad_result', 'accept', E1]);
    expect(failure.delivery).toMatchObject({ sub_job: null, receipt: 'not_recordable', accepted: 'pending', escrow_ref: E1 });
    expect(failure.detail).toContain(`the Accept of its escrow ${E1} was sent and the chain does not show it yet, so the supplier may be paid`);
  });
});

describe('an answer that cannot be used, after an Accept', () => {
  it('carries the escrow, the stage and the whole sub-job, and says that the supplier is paid', async () => {
    const run = await setup();
    run.m.llm.answer = 'This is not JSON.';
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.stage, failure.escrow_ref]).toStrictEqual(['model_output_invalid', 'model_output_invalid', 'accept', E1]);
    expect(failure.delivery).toMatchObject({ accepted: 'confirmed', sub_job: { escrow_ref: E1, advert_ref: LLM_ADVERT_REF, supplier_pkh: LLM_KEY.pkh, verification: ALL_TRUE } });
    expect(failure.detail).toBe(`the answer of the model is not one JSON object alone: it is not JSON, or it has text before or after the object (an answer of 17 characters); its escrow ${E1} was accepted, so the supplier is paid`);
  });

  it('says that the supplier may be paid when the Accept is pending, and carries the pending state', async () => {
    const run = await setup({}, () => ({ accept: async (ref) => { throw unseen(ref); } }));
    run.m.llm.answer = 'This is not JSON.';
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect(failure.delivery).toMatchObject({ accepted: 'pending', sub_job: { escrow_ref: E1 } });
    expect(failure.detail).toContain(`the Accept of its escrow ${E1} was sent and the chain does not show it yet, so the supplier may be paid`);
  });
});

describe('a port that throws after the Post or after the Accept', () => {
  it('after the Accept: the ledger that books the Accept. The failure says that the escrow was paid, with the escrow and the stage', async () => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    run.deps.ledger = { posted: () => undefined, accepted: () => { throw new Error(`the ledger broke ${MARKER}`); } };
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.stage, failure.escrow_ref]).toStrictEqual(['inference_failed', 'hire_threw', 'accept', E1]);
    expect(failure.detail).toBe(`the model hire for the decision reorder threw Error after its Accept; its escrow ${E1} was accepted, so the supplier is paid`);
    // The record of the hire was never handed over, so the delivery holds the escrow and nothing else.
    expect(failure.delivery).toStrictEqual({
      sub_job: null, receipt: 'not_recordable', accepted: 'confirmed', escrow_ref: E1, advert_ref: null, supplier_pkh: null, verification: null,
    });
    expect(JSON.stringify(failure)).not.toContain(MARKER);
    expect(await run.m.chain.escrowState(E1)).toBe('spent');
    expect(run.key.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([E1]);
  });

  it('after the Post: the sleep of the run throws while the job is polled. The failure has the escrow, and it does not say that the escrow was paid', async () => {
    const run = await setup();
    run.m.llm.steps = ['running', 'done'];
    run.deps.sleep = async () => { throw new Error(`no sleep ${MARKER}`); };
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.stage, failure.escrow_ref, failure.delivery]).toStrictEqual(['inference_failed', 'hire_threw', 'post', E1, null]);
    expect(failure.detail).toBe(`the model hire for the decision reorder threw Error after its Post; its escrow ${E1} stays with the janitor of the key`);
    expect(JSON.stringify(failure)).not.toContain(MARKER);
    expect(run.key.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([E1]);
  });

  it('hires when no port throws: the twin', async () => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    expect(won(await decide(run.deps, REORDER, STOCK_INPUT)).inference.sub_job.escrow_ref).toBe(E1);
  });
});

describe('a hire that fails before its Accept is not paid', () => {
  it('has the escrow and the stage `accept` and no delivery when the Accept keeps failing: the stage alone does not say that the hire was paid', async () => {
    const run: Run = await setup({}, () => ({ accept: async () => { throw new Error(`no node ${MARKER}`); } }));
    run.m.llm.answer = said(MEDIUM_LOT);
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.reason, failure.stage, failure.escrow_ref, failure.delivery]).toStrictEqual(['llm_accept_failed', 'accept', E1, null]);
    expect(failure.detail).toBe(`the model hire for the decision reorder ended with llm_accept_failed at accept; its escrow ${E1} stays with the janitor of the key`);
    expect(await run.m.chain.escrowState(E1)).toBe('Submitted');
  });
});

describe('a stranded store that cannot be written for an Accept that may still land', () => {
  const head = 'the model hire for the decision reorder ended with store_write_failed at accept';
  const MAY_BE_PAID = `the Accept of its escrow ${E1} was sent and the chain does not show it yet, so the supplier may be paid`;

  it.each<[string, boolean, string]>([
    ['the Accept lands later', true, 'spent'],
    ['the Accept never lands', false, 'Submitted'],
  ])('says that the supplier may be paid, with the escrow, the stage and a pending delivery: %s', async (_name, lands, state) => {
    const run = await setup({}, (m) => ({ accept: async (ref) => { if (lands) await m.chain.accept(ref); throw unseen(ref); } }));
    run.m.llm.answer = said(MEDIUM_LOT);
    run.key.stranded.update = () => { throw new Error(`ENOSPC ${MARKER}`); };
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.stage, failure.escrow_ref]).toStrictEqual(['store_write_failed', 'store_write_failed', 'accept', E1]);
    expect(failure.detail).toBe(`${head}; ${MAY_BE_PAID}; the Accept may still land; the stranded store could not be written, so the janitor of the key does not know of the Accept`);
    // The record of the hire is not handed over when the hire kit throws, so the delivery holds the escrow and nothing else.
    expect(failure.delivery).toStrictEqual({ sub_job: null, receipt: 'not_recordable', accepted: 'pending', escrow_ref: E1, advert_ref: null, supplier_pkh: null, verification: null });
    expect(JSON.stringify(failure)).not.toContain(MARKER);
    expect('value' in failure).toBe(false);
    // The failure is the same whichever way the Accept ends. An Accept that lands pays the supplier, and a Submitted escrow cannot be reclaimed.
    expect(await run.m.chain.escrowState(E1)).toBe(state);
    expect([run.booked.length, run.m.llm.sends.length]).toStrictEqual([1, 1]);
  });

  it('records the decision, with the Accept as pending, when the store can be written: the twin', async () => {
    const run = await setup({}, () => ({ accept: async (ref) => { throw unseen(ref); } }));
    run.m.llm.answer = said(MEDIUM_LOT);
    const decision = won(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([decision.choice, decision.inference.accepted]).toStrictEqual([MEDIUM_LOT, 'pending']);
    expect(run.key.stranded.list().map((entry) => [entry.escrow_ref, 'accept_pending' in entry])).toStrictEqual([[E1, true]]);
  });

  // The twins: the same fault of the store, before any Accept. The supplier is not paid, no Accept is sent, and the failure has no delivery.
  const unconfirmedPost = new TxNotConfirmedError('The Post was submitted, but Koios did not report it confirmed.', {
    txHash: 'ee'.repeat(32), escrowRef: `${'ee'.repeat(32)}#0`, deliverBy: T0 + 480_000, validTo: T0 + 180_000, mayLand: true,
  });
  it.each<[string, (run: Run) => void, string, string]>([
    ['a Post that is confirmed: the escrow stays open', () => undefined, E1, 'Open'],
    ['a Post that is signed and not seen confirmed: no escrow is on the chain', (run) => { run.m.chain.failNextPost(unconfirmedPost); }, `${'ee'.repeat(32)}#0`, 'unknown'],
  ])('does not say that the supplier may be paid when the store cannot be written at the Post: %s', async (_name, arrange, escrow, state) => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    arrange(run);
    run.key.stranded.add = () => { throw new Error(`ENOSPC ${MARKER}`); };
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.stage, failure.escrow_ref, failure.delivery]).toStrictEqual(['store_write_failed', 'store_write_failed', 'post', escrow, null]);
    expect(failure.detail).toBe(`the model hire for the decision reorder ended with store_write_failed at post; the stranded store could not be written, so settle its escrow ${escrow} by hand after its deadline`);
    expect(JSON.stringify(failure)).not.toContain(MARKER);
    expect(await run.m.chain.escrowState(escrow)).toBe(state);
    expect(run.m.llm.sends).toHaveLength(0);
  });
});
