// packages/usecase-kit/test/decision/serial.test.ts: decisions of one agent run one after the other from the one service key. Two decisions that start at one time never post two escrows at one time:
// the second Post waits for the Accept of the first. The decisions of two keys do not wait for each other. A decision that fails frees the lane for the next one.
import { afterEach, describe, expect, it } from 'vitest';
import { escrowNo } from '@vsa/hire-kit/testing';
import { decide } from '@vsa/usecase-kit/decision';
import { ACCEPT_DELIVERY, DELIVERY_INPUT, GOOD_SCORE, MEDIUM_LOT, REORDER, SCORE, SCORE_INPUT, STOCK_INPUT, cleanup, deferred, lost, promptsSent, said, setup, won } from './support.ts';

afterEach(cleanup);

describe('decisions of one key', () => {
  it('runs two decisions that start at one time one after the other: the second Post waits for the Accept of the first, and each decision gets its own answer', async () => {
    const events: string[] = [];
    const gate = deferred();
    const reached = deferred();
    let held = true;
    const run = await setup({}, (m) => ({
      postEscrow: async (args) => { events.push('post'); return m.chain.postEscrow(args); },
      accept: async (ref) => {
        events.push('accept');
        if (held) { held = false; reached.resolve(); await gate.promise; }
        return m.chain.accept(ref);
      },
    }));
    run.m.llm.answer = said(MEDIUM_LOT);
    const first = decide(run.deps, REORDER, STOCK_INPUT);
    const second = decide(run.deps, ACCEPT_DELIVERY, DELIVERY_INPUT);
    await reached.promise;
    // The first decision is in its Accept, held. The second has not posted: it waits for the lane of the key.
    expect(events).toStrictEqual(['post', 'accept']);
    expect(run.key.lane.busy).toBe(true);
    expect(await run.m.chain.escrowState(escrowNo(2))).toBe('unknown');
    run.m.llm.answer = said({ accept: true, mismatch: [] });
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(events).toStrictEqual(['post', 'accept', 'post', 'accept']);
    expect([won(a).name, won(a).inference.sub_job.escrow_ref, won(a).choice]).toStrictEqual(['reorder', escrowNo(1), MEDIUM_LOT]);
    expect([won(b).name, won(b).inference.sub_job.escrow_ref, won(b).choice]).toStrictEqual(['accept_delivery', escrowNo(2), { accept: true, mismatch: [] }]);
    expect(run.key.lane.busy).toBe(false);
  });

  it('runs three decisions that start at one time, as the three scorers of use case 3 do, with one escrow in play at a time and in the order they started', async () => {
    let open = 0;
    let most = 0;
    const events: string[] = [];
    const run = await setup({}, (m) => ({
      postEscrow: async (args) => { open += 1; most = Math.max(most, open); events.push('post'); return m.chain.postEscrow(args); },
      accept: async (ref) => { const done = await m.chain.accept(ref); open -= 1; events.push('accept'); return done; },
    }));
    run.m.llm.answer = said(GOOD_SCORE);
    const results = await Promise.all([1, 2, 3].map((n) => decide(run.deps, SCORE, { ...SCORE_INPUT, scorer: n })));
    expect(results.map((result) => won(result).inference.sub_job.escrow_ref)).toStrictEqual([escrowNo(1), escrowNo(2), escrowNo(3)]);
    expect(events).toStrictEqual(['post', 'accept', 'post', 'accept', 'post', 'accept']);
    expect(most).toBe(1);
    expect(run.booked).toHaveLength(3);
    // The prompts are the three questions, in the order of the calls.
    expect(promptsSent(run).map((prompt) => [1, 2, 3].filter((n) => prompt.includes(`"scorer":${n}`)))).toStrictEqual([[1], [2], [3]]);
  });

  it('does not make the decisions of two keys wait for each other: the twin', async () => {
    const heldGate = deferred();
    const heldReached = deferred();
    const a = await setup({ buyerPkh: 'aa'.repeat(28) }, (m) => ({ accept: async (ref) => { heldReached.resolve(); await heldGate.promise; return m.chain.accept(ref); } }));
    const b = await setup({ buyerPkh: 'dd'.repeat(28) });
    a.m.llm.answer = said(MEDIUM_LOT);
    b.m.llm.answer = said(MEDIUM_LOT);
    const holding = decide(a.deps, REORDER, STOCK_INPUT);
    await heldReached.promise;
    // Key a is in its Accept. Key b has a lane of its own, and its decision completes meanwhile.
    expect(won(await decide(b.deps, REORDER, STOCK_INPUT)).inference.accepted).toBe('confirmed');
    expect(a.key.lane.busy).toBe(true);
    heldGate.resolve();
    expect(won(await holding).inference.accepted).toBe('confirmed');
  });

  it('frees the lane when a decision fails: the next decision runs, with its own hire', async () => {
    const run = await setup();
    // The first job fails at its poll. The second job finishes.
    run.m.llm.plans = [['failed'], ['running', 'done']];
    run.m.llm.answer = said(MEDIUM_LOT);
    const [first, second] = await Promise.all([decide(run.deps, REORDER, STOCK_INPUT), decide(run.deps, REORDER, STOCK_INPUT)]);
    expect([lost(first).reason, lost(first).escrow_ref]).toStrictEqual(['llm_failed', escrowNo(1)]);
    expect(won(second).inference.sub_job.escrow_ref).toBe(escrowNo(2));
    expect(run.key.lane.busy).toBe(false);
    // The failed escrow stays with the janitor, and the second was a new hire: the first was not tried again.
    expect(run.key.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([escrowNo(1)]);
  });

  it('frees the lane when the answer is not usable: the next decision runs', async () => {
    const run = await setup();
    run.m.llm.answer = 'not JSON';
    expect(lost(await decide(run.deps, REORDER, STOCK_INPUT)).reason).toBe('model_output_invalid');
    expect(run.key.lane.busy).toBe(false);
    run.m.llm.answer = said(MEDIUM_LOT);
    expect(won(await decide(run.deps, REORDER, STOCK_INPUT)).inference.sub_job.escrow_ref).toBe(escrowNo(2));
  });
});
