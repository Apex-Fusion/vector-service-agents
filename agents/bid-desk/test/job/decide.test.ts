// agents/bid-desk/test/job/decide.test.ts: the decision `quote` through `decide` of the kit, over the stub marketplace of the hire kit, and the job with that `decide` as its port. The kit takes the definition
// of the decision, sends the golden prompt, reads the answer of the model with the parser of the decision, and records a decision whose hire (a real receipt of the stub supplier) the parser of the quote takes.
// So a quote with a decision of the kit passes `parseQuote`. An answer that the parser refuses is `model_output_invalid`, and the supplier of the model is paid.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseQuote } from '@vsa/usecase-kit/bids';
import type { Quote } from '@vsa/usecase-kit/bids';
import { decide } from '@vsa/usecase-kit/decision';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { QUOTE_DECISION, quoteInput, runQuote } from '../../src/job/index.ts';
import { cleanup, promptsSent, said, setup } from './decide-support.ts';
import type { Run } from './decide-support.ts';
import { makeRig, refusalOf } from './rig.ts';
import type { Rig } from './rig.ts';
import { PRICE_LIST, RFQ, T0, TODAY, choiceOf } from './samples.ts';

afterEach(cleanup);

/** The prompt of the golden file: the file ends with a line break and the prompt does not. */
const goldenPrompt = (): string => readFileSync(new URL('./golden/quote-prompt.txt', import.meta.url), 'utf8').slice(0, -1);

/** The rig, and a job with `decide` of the kit as its port: the decision is hired from the stub marketplace. */
function kitJob(run: Run): { readonly rig: Rig; readonly start: () => Promise<Quote> } {
  const rig = makeRig();
  const deps = { ...rig.deps, decide: (input: JsonValue) => decide(run.deps, QUOTE_DECISION, input) };
  return { rig, start: () => runQuote(deps, rig.request, rig.context, T0) };
}

describe('the decision quote through the kit', () => {
  it('is a definition that decide takes: the model that follows the list gives a decision with its choice and its reasoning', async () => {
    const run = await setup();
    run.m.llm.answer = said(choiceOf(), 'The list gives 125 for 100 gloves.');
    const result = await decide(run.deps, QUOTE_DECISION, quoteInput(RFQ, PRICE_LIST, TODAY));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(result.value.name).toBe('quote');
    expect(result.value.choice).toStrictEqual(choiceOf());
    expect(result.value.reasoning).toBe('The list gives 125 for 100 gloves.');
    expect(result.value.inference.path).toBe('marketplace');
  });

  it('sends the golden prompt to the model supplier, one time', async () => {
    const run = await setup();
    run.m.llm.answer = said(choiceOf());
    await decide(run.deps, QUOTE_DECISION, quoteInput(RFQ, PRICE_LIST, TODAY));
    expect(promptsSent(run)).toStrictEqual([goldenPrompt()]);
  });

  it.each([
    ['a unit price of 0', { ...choiceOf(), lines: [{ ...choiceOf().lines[0]!, unit_price: 0 }] }],
    ['a lead time above 365 days', { ...choiceOf(), lines: [{ ...choiceOf().lines[0]!, lead_time_days: 366 }] }],
    ['notes with a hidden character', { ...choiceOf(), notes: 'a\u200bb' }],
    ['a date that does not exist', { ...choiceOf(), valid_until: '2026-02-30' }],
    ['a member more', { ...choiceOf(), extra: true }],
  ])('gives model_output_invalid and no decision for an answer with %s, and the supplier is paid', async (_what, choice) => {
    const run = await setup();
    run.m.llm.answer = said(choice);
    const result = await decide(run.deps, QUOTE_DECISION, quoteInput(RFQ, PRICE_LIST, TODAY));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a decision was recorded, and it must not be');
    expect(result.code).toBe('model_output_invalid');
    expect(result.delivery).not.toBeNull();
  });
});

describe('the job with the decide of the kit', () => {
  it('gives a quote that the parser of the kit takes, with the decision of the real hire in it', async () => {
    const run = await setup();
    run.m.llm.answer = said(choiceOf(), 'The list gives 125 for 100 gloves, 35 for 250 syringes and 59 for 40 masks.');
    const { rig, start } = kitJob(run);
    const quote = await start();
    expect(parseQuote(quote)).toStrictEqual({ ok: true, value: quote });
    expect(quote.decisions).toHaveLength(1);
    expect(quote.decisions[0]?.name).toBe('quote');
    expect(quote.decisions[0]?.choice).toStrictEqual(choiceOf());
    expect(quote.decisions[0]?.inference.path).toBe('marketplace');
    expect(quote.decisions[0]?.inference.sub_job.escrow_ref).toMatch(/^[0-9a-f]{64}#\d+$/);
    expect(quote.total).toBe(23_610);
    expect(rig.booked).toHaveLength(1);
    expect(promptsSent(run)).toStrictEqual([goldenPrompt()]);
  });

  it('ends with model_output_invalid (502) when the model gives a choice that the parser refuses, and the log says that the supplier may be paid', async () => {
    const run = await setup();
    run.m.llm.answer = said({ ...choiceOf(), notes: 'a\u0000b' });
    const { rig, start } = kitJob(run);
    expect(await refusalOf(start())).toMatchObject({ code: 'model_output_invalid', status: 502 });
    expect(rig.events).toStrictEqual(['take']);
    expect(rig.booked).toHaveLength(0);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('the model supplier may be paid');
  });
});
