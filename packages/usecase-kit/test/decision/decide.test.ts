// packages/usecase-kit/test/decision/decide.test.ts: `decide` against the in-memory marketplace of hire-kit. One decision is one hire of a model. The choice is in the result exactly as the model gave
// it. A failed hire, a receipt that failed a check and an answer of another shape each give a typed failure and no decision. A failed hire is not tried again. Each refusal has an accepted twin.
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChain, TxNotConfirmedError, responsesPromptHash } from '@vsa/buyer-core';
import { LLM_ADVERT, LLM_ADVERT_REF, LLM_CAPABILITY, LLM_ENDPOINT, LLM_KEY, INDEXER, T0, escrowNo, indexerRow } from '@vsa/hire-kit/testing';
import { RECEIPT_CHECKS, accepted } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import { decide } from '@vsa/usecase-kit/decision';
import type { ChoiceParser, DecisionSpec } from '@vsa/usecase-kit/decision';
import {
  ACCEPT_DELIVERY, AVAILABILITY, CATALOGUE_INPUT, DELIVERY_INPUT, GOOD_SCORE, LIMITS, MEDIUM_LOT, REORDER, SCORE, SCORE_INPUT, SCORE_IN_RANGE, STOCK_INPUT, cleanup, lost, promptOf, said, setup, won,
} from './support.ts';
import type { Run } from './support.ts';

afterEach(cleanup);

/** Text that must never appear in a detail: a supplier puts it in its words, and the model puts it in its answer. */
const MARKER = 'ZQ9-marker-7f3';

describe('decide: a decision that the model gave', () => {
  it('hires the model from the service key and records the decision as the model gave it, with the sub-job, its receipt and its eight checks', async () => {
    const run = await setup();
    const reasoning = 'The stock lasts three days and the lead time is seven. A medium lot covers it.';
    run.m.llm.answer = said(MEDIUM_LOT, reasoning);
    const decision = won(await decide(run.deps, REORDER, STOCK_INPUT));
    const prompt = promptOf(REORDER, STOCK_INPUT);

    expect([decision.name, decision.choice, decision.reasoning, decision.inference.path, decision.inference.accepted]).toStrictEqual(['reorder', MEDIUM_LOT, reasoning, 'marketplace', 'confirmed']);
    const subJob = decision.inference.sub_job;
    expect([subJob.capability_id, subJob.advert_ref, subJob.escrow_ref, subJob.supplier_pkh]).toStrictEqual([LLM_CAPABILITY, LLM_ADVERT_REF, escrowNo(1), LLM_KEY.pkh]);
    expect(subJob.verification).toStrictEqual(Object.fromEntries(RECEIPT_CHECKS.map((check) => [check, true])));
    // The receipt names the prompt that decide built: the escrow commits to it.
    expect(subJob.receipt).toMatchObject({ escrow_ref: escrowNo(1), supplier_pkh: LLM_KEY.pkh, prompt_hash: responsesPromptHash({ input: prompt }) });
    expect(subJob.receipt_signature).toMatch(/^[0-9a-f]{128}$/);
    // One hire: one Post, one send of the prompt and nothing else, an escrow that is accepted, and nothing left for the janitor.
    expect(run.booked).toStrictEqual([{ lockLovelace: FakeChain.LOCK_LOVELACE, feeLovelace: FakeChain.FEE_LOVELACE }]);
    expect(run.m.llm.sends.map((send) => [send.escrowRef, JSON.parse(send.body)])).toStrictEqual([[escrowNo(1), { input: prompt }]]);
    expect(await run.m.chain.escrowState(escrowNo(1))).toBe('spent');
    expect(run.key.stranded.list()).toStrictEqual([]);
  });

  it('serves a counterparty in the same way: a choice of `confirm: false` is a decision, and it is recorded as it is', async () => {
    const run = await setup();
    const choice = { confirm: false, ship_by: '2026-11-28', note: 'The lot is not in stock.' };
    run.m.llm.answer = said(choice);
    const decision = won(await decide(run.deps, AVAILABILITY, CATALOGUE_INPUT));
    expect([decision.name, decision.choice]).toStrictEqual(['availability', choice]);
  });

  it('records the Accept as pending when it was sent and not seen confirmed', async () => {
    const unseen = (ref: string): TxNotConfirmedError => new TxNotConfirmedError('The Accept was submitted, but Koios did not report it confirmed.', { txHash: 'ac'.repeat(32), escrowRef: ref, deliverBy: null, validTo: T0 + 606_000, mayLand: true });
    const run = await setup({}, () => ({ accept: async (ref) => { throw unseen(ref); } }));
    run.m.llm.answer = said(MEDIUM_LOT);
    const decision = won(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([decision.choice, decision.inference.accepted]).toStrictEqual([MEDIUM_LOT, 'pending']);
    expect(run.key.stranded.list().map((entry) => [entry.escrow_ref, 'accept_pending' in entry])).toStrictEqual([[escrowNo(1), true]]);
  });
});

describe('decide: the choice is the model\'s', () => {
  // A careless code would correct each of these. The shape of the decision permits each one, so it stays as the model gave it.
  it.each<[string, DecisionSpec, JsonValue, unknown]>([
    ['a quantity of 0', REORDER, STOCK_INPUT, { lot: 'lot-small', quantity: 0, needed_by: '2026-12-01' }],
    ['a quantity that is not the size of the lot', REORDER, STOCK_INPUT, { lot: 'lot-small', quantity: 7, needed_by: '2026-12-01' }],
    ['accept with a mismatch', ACCEPT_DELIVERY, DELIVERY_INPUT, { accept: true, mismatch: ['quantity'] }],
    ['no accept and no mismatch', ACCEPT_DELIVERY, DELIVERY_INPUT, { accept: false, mismatch: [] }],
    ['scores above and below the range that the prompt asked for', SCORE, SCORE_INPUT, { components: { price: 130, lead_time: -5, reliability: 0, compliance: 100.5 }, score: 1e6 }],
    ['a text that is not in the NFC form', AVAILABILITY, CATALOGUE_INPUT, { confirm: true, ship_by: '2026-11-28', note: 'cafe\u0301 is on the shelf' }],
    ['a list in the order that the model wrote', ACCEPT_DELIVERY, DELIVERY_INPUT, { accept: false, mismatch: ['sku', 'lot', 'quantity', 'lot'] }],
  ])('keeps %s', async (_name, spec, input, choice) => {
    const run = await setup();
    run.m.llm.answer = said(choice);
    const decision = won(await decide(run.deps, spec, input));
    expect(decision.choice).toStrictEqual(choice);
    // Byte for byte: the text of the choice that is recorded is the text that the model wrote.
    expect(JSON.stringify(decision.choice)).toBe(JSON.stringify(choice));
  });

  it('keeps the reasoning as the model wrote it, with its white space and its line breaks', async () => {
    const run = await setup();
    const reasoning = '  The stock is low.\n\n  Reorder one lot.  \n';
    run.m.llm.answer = said(MEDIUM_LOT, reasoning);
    expect(won(await decide(run.deps, REORDER, STOCK_INPUT)).reasoning).toBe(reasoning);
  });

  it('refuses a score outside the range when the shape names the range, and keeps it when the shape does not: the shape is the only gate', async () => {
    const outside = { components: { price: 130, lead_time: 70, reliability: 90, compliance: 100 }, score: 84 };
    const named = await setup();
    named.m.llm.answer = said(outside);
    const failure = lost(await decide(named.deps, SCORE_IN_RANGE, SCORE_INPUT));
    expect([failure.code, failure.reason]).toStrictEqual(['model_output_invalid', 'model_output_invalid']);
    const open = await setup();
    open.m.llm.answer = said(outside);
    expect(won(await decide(open.deps, SCORE, SCORE_INPUT)).choice).toStrictEqual(outside);
    // The twin: a score inside the range passes the shape that names it.
    const inside = await setup();
    inside.m.llm.answer = said(GOOD_SCORE);
    expect(won(await decide(inside.deps, SCORE_IN_RANGE, SCORE_INPUT)).choice).toStrictEqual(GOOD_SCORE);
  });
});

describe('decide: a parser that does not return the choice that it was given', () => {
  const wrong = { lot: 'lot-small', quantity: 0, needed_by: '2026-12-01' };
  const members = (given: JsonValue): Record<string, JsonValue> => given as Record<string, JsonValue>;
  /** Each case: what the parser does, the parser, and the choice that the model gave (`wrong` unless the case says another). */
  const careless: Array<[string, ChoiceParser<JsonValue>, unknown?]> = [
    ['clamps a number', (given) => accepted({ ...members(given), quantity: 1 })],
    ['changes its own copy in place', (given) => { members(given).quantity = 1; return accepted(given); }],
    ['leaves a member out', (given) => accepted({ lot: members(given).lot!, quantity: members(given).quantity! })],
    ['adds a default member', (given) => accepted({ ...members(given), note: 'a default' })],
    ['returns another type', () => accepted(0)],
    ['returns null', () => accepted(null)],
    ['returns a list', () => accepted([1, 2, 3])],
    ['returns a value that JSON cannot hold', () => accepted(Number.NaN)],
    ['returns nothing', () => accepted(undefined as unknown as JsonValue)],
    ['writes a text in the NFC form', (given) => accepted({ ...members(given), note: String(members(given).note).normalize('NFC') }), { ...wrong, note: 'cafe\u0301' }],
    ['rounds a number', (given) => accepted({ ...members(given), quantity: Math.round(members(given).quantity as number) }), { ...wrong, quantity: 7.4 }],
    ['sorts a list', (given) => accepted({ ...members(given), mismatch: [...(members(given).mismatch as JsonValue[])].sort() }), { ...wrong, mismatch: ['quantity', 'lot'] }],
    ['removes a repeated entry of a list', (given) => accepted({ ...members(given), mismatch: [...new Set(members(given).mismatch as JsonValue[])] }), { ...wrong, mismatch: ['lot', 'lot'] }],
    ['changes an entry of a list inside a member', (given) => accepted({ ...members(given), lots: [{ size: 10 }, { size: 51 }] }), { ...wrong, lots: [{ size: 10 }, { size: 50 }] }],
    ['adds an entry to a list', (given) => accepted({ ...members(given), mismatch: [...(members(given).mismatch as JsonValue[]), 'quantity'] }), { ...wrong, mismatch: ['lot'] }],
  ];
  it.each(careless)('records no decision when a parser %s', async (_name, parse, choice = wrong) => {
    const run = await setup();
    run.m.llm.answer = said(choice);
    const spec: DecisionSpec = { name: 'reorder', instruction: REORDER.instruction, parse };
    const failure = lost(await decide(run.deps, spec, STOCK_INPUT));
    expect([failure.code, failure.reason]).toStrictEqual(['internal', 'choice_changed']);
    // The hire was made and paid, so the sub-job is real and the failure carries it.
    expect(failure.delivery).toMatchObject({ accepted: 'confirmed', sub_job: { escrow_ref: escrowNo(1) } });
    expect(await run.m.chain.escrowState(escrowNo(1))).toBe('spent');
    expect('value' in failure).toBe(false);
  });

  it('records the decision when the parser returns the value that it was given: the twin of every case above', async () => {
    const run = await setup();
    run.m.llm.answer = said(wrong);
    const identity: ChoiceParser<JsonValue> = (given) => accepted(given);
    expect(won(await decide(run.deps, { name: 'reorder', instruction: REORDER.instruction, parse: identity }, STOCK_INPUT)).choice).toStrictEqual(wrong);
  });

  it('does not let a parser that keeps a reference change the decision later', async () => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    const kept: { object: Record<string, JsonValue> | null } = { object: null };
    const parse: ChoiceParser<JsonValue> = (given) => { kept.object = given as Record<string, JsonValue>; return accepted(given); };
    const decision = won(await decide(run.deps, { name: 'reorder', instruction: REORDER.instruction, parse }, STOCK_INPUT));
    expect(kept.object).not.toBeNull();
    kept.object!.quantity = 999;
    expect(decision.choice).toStrictEqual(MEDIUM_LOT);
  });
});

describe('decide: an answer of another shape', () => {
  const lot = { lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01' };
  const wrapped = (choice: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ reasoning: `reasons ${MARKER}`, choice, ...extra });
  it.each<[string, string]>([
    ['text that is not JSON', `${MARKER} is not JSON`],
    ['text with no object', '[1, 2, 3]'],
    ['an empty answer', ''],
    ['JSON that is cut', `{"reasoning":"${MARKER}","choice":{"lot":"lot-medium"`],
    ['two objects', `${wrapped(lot)} ${wrapped(lot)}`],
    ['words before and after the object', `Here is my answer.\n${wrapped(lot)}\nI hope it helps.`],
    ['the object in a list', `[${wrapped(lot)}]`],
    ['no choice', JSON.stringify({ reasoning: MARKER })],
    ['no reasoning', JSON.stringify({ choice: lot })],
    ['a reasoning that is not a text', JSON.stringify({ reasoning: 7, choice: lot })],
    ['a reasoning of white space only', JSON.stringify({ reasoning: ' \n ', choice: lot })],
    ['a member beside the reasoning and the choice', wrapped(lot, { confidence: 0.9 })],
    ['a choice of another shape', wrapped({ lot: 'lot-huge', quantity: 50, needed_by: '2026-12-01' })],
    ['a choice with a member that the shape does not name', wrapped({ ...lot, note: MARKER })],
    ['a choice that is a text', wrapped(`lot-medium ${MARKER}`)],
    ['a quantity that is not a whole number', wrapped({ ...lot, quantity: 50.5 })],
    ['a quantity that is not finite', `{"reasoning":"${MARKER}","choice":{"lot":"lot-medium","quantity":1e999,"needed_by":"2026-12-01"}}`],
    ['a key that is __proto__', `{"reasoning":"${MARKER}","choice":{"__proto__":{"x":1},"lot":"lot-medium","quantity":50,"needed_by":"2026-12-01"}}`],
  ])('is model_output_invalid, with no decision: %s', async (_name, text) => {
    const run = await setup();
    run.m.llm.answer = text;
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.stage]).toStrictEqual(['model_output_invalid', 'model_output_invalid', null]);
    expect('value' in failure).toBe(false);
    // The hire was made and paid. The failure carries the real sub-job, so the agent can name it in its failed result.
    expect(failure.delivery).toMatchObject({ accepted: 'confirmed', sub_job: { escrow_ref: escrowNo(1), supplier_pkh: LLM_KEY.pkh } });
    expect(failure.escrow_ref).toBe(escrowNo(1));
    expect(await run.m.chain.escrowState(escrowNo(1))).toBe('spent');
    // No second hire, and no word of the answer in the detail.
    expect([run.booked.length, run.m.llm.sends.length]).toStrictEqual([1, 1]);
    expect(await run.m.chain.escrowState(escrowNo(2))).toBe('unknown');
    expect(JSON.stringify(failure)).not.toContain(MARKER);
  });

  it('is model_output_invalid when the supplier says that the answer is not complete, also when the text is a whole object', async () => {
    const cut = await setup();
    cut.m.llm.status = 'incomplete';
    cut.m.llm.answer = said(MEDIUM_LOT);
    const failure = lost(await decide(cut.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason]).toStrictEqual(['model_output_invalid', 'model_output_invalid']);
    // The twin: the same text with the status completed is a decision.
    const whole = await setup();
    whole.m.llm.answer = said(MEDIUM_LOT);
    expect(won(await decide(whole.deps, REORDER, STOCK_INPUT)).choice).toStrictEqual(MEDIUM_LOT);
  });

  it('reads an answer in a code fence, with white space around it, and after a think block: the twins of the cases above', async () => {
    const reasoning = 'A medium lot.';
    const texts = ['```json\n' + said(MEDIUM_LOT, reasoning) + '\n```', `  \n${said(MEDIUM_LOT, reasoning)}\n  `, `<think>Two lots would do.</think>\n\`\`\`json\n${said(MEDIUM_LOT, reasoning)}\n\`\`\``];
    for (const text of texts) {
      const run = await setup();
      run.m.llm.answer = text;
      const decision = won(await decide(run.deps, REORDER, STOCK_INPUT));
      expect([decision.choice, decision.reasoning]).toStrictEqual([MEDIUM_LOT, reasoning]);
    }
  });

  it('does not record a choice that words around the object take back: the object alone is the twin', async () => {
    const accept = { accept: true, mismatch: [] };
    const around = await setup();
    around.m.llm.answer = `Sure. ${said(accept)} Hope this helps, but reject it.`;
    const failure = lost(await decide(around.deps, ACCEPT_DELIVERY, DELIVERY_INPUT));
    expect([failure.code, failure.reason]).toStrictEqual(['model_output_invalid', 'model_output_invalid']);
    expect('value' in failure).toBe(false);
    expect(await around.m.chain.escrowState(escrowNo(1))).toBe('spent');
    const alone = await setup();
    alone.m.llm.answer = said(accept);
    expect(won(await decide(alone.deps, ACCEPT_DELIVERY, DELIVERY_INPUT)).choice).toStrictEqual(accept);
  });
});

describe('decide: a hire that fails', () => {
  interface Scenario {
    name: string;
    code: 'inference_failed' | 'store_write_failed';
    reason: string;
    stage: string | null;
    escrow: string | null;
    wrap?: Parameters<typeof setup>[1];
    arrange?: (run: Run) => void;
  }
  const unconfirmedPost = new TxNotConfirmedError('The Post was submitted, but Koios did not report it confirmed.', {
    txHash: 'ee'.repeat(32), escrowRef: `${'ee'.repeat(32)}#0`, deliverBy: T0 + 480_000, validTo: T0 + 180_000, mayLand: true,
  });
  const scenarios: Scenario[] = [
    { name: 'a supplier that refuses the job', code: 'inference_failed', reason: 'llm_refused', stage: 'send', escrow: escrowNo(1),
      arrange: (run) => { run.m.llm.refuse = { status: 422, reason: 'bad_input', message: `${MARKER} the words of the supplier` }; } },
    { name: 'a supplier whose job fails', code: 'inference_failed', reason: 'llm_failed', stage: 'poll', escrow: escrowNo(1), arrange: (run) => { run.m.llm.steps = ['failed']; } },
    { name: 'a job that does not finish before the escrow is due', code: 'inference_failed', reason: 'llm_timeout', stage: 'poll', escrow: escrowNo(1), arrange: (run) => { run.m.llm.steps = ['running']; } },
    { name: 'a job that does not finish before the deadline of the run', code: 'inference_failed', reason: 'llm_out_of_time', stage: 'poll', escrow: escrowNo(1),
      arrange: (run) => { run.m.llm.steps = ['running']; run.deps.deadlineMs = T0 + 4_000; } },
    { name: 'an answer that cannot be read', code: 'inference_failed', reason: 'llm_bad_result', stage: 'answer', escrow: escrowNo(1),
      arrange: (run) => { run.m.llm.answerText = (body) => JSON.stringify({ ...body, output: `${MARKER} text` }); } },
    { name: 'an Accept that keeps failing', code: 'inference_failed', reason: 'llm_accept_failed', stage: 'accept', escrow: escrowNo(1), wrap: () => ({ accept: async () => { throw new Error(`no node ${MARKER}`); } }) },
    { name: 'a Post that fails before it is signed', code: 'inference_failed', reason: 'llm_post_failed', stage: 'post', escrow: null, wrap: () => ({ postEscrow: async () => { throw new Error(`no node ${MARKER}`); } }) },
    { name: 'a Post that is signed and not seen confirmed', code: 'inference_failed', reason: 'llm_post_failed', stage: 'post', escrow: `${'ee'.repeat(32)}#0`,
      arrange: (run) => { run.m.chain.failNextPost(unconfirmedPost); } },
    { name: 'a stranded store that cannot be written', code: 'store_write_failed', reason: 'store_write_failed', stage: 'post', escrow: escrowNo(1),
      arrange: (run) => { run.key.stranded.add = () => { throw new Error(`ENOSPC ${MARKER}`); }; } },
  ];

  it.each(scenarios)('gives its code and no decision: $name', async (scenario) => {
    const run = await setup({}, scenario.wrap);
    // A second supplier that the indexer lists: a fallback would find it. Nothing may call it.
    run.m.rows.push(indexerRow(`${'d4'.repeat(32)}#0`, { ...LLM_ADVERT, endpoint_url: 'https://203.0.113.32' }));
    scenario.arrange?.(run);
    const failure = lost(await decide(run.deps, REORDER, { ...STOCK_INPUT, note: MARKER }));
    expect([failure.code, failure.reason, failure.stage, failure.escrow_ref, failure.delivery]).toStrictEqual([scenario.code, scenario.reason, scenario.stage, scenario.escrow, null]);
    // The words of a detail: the code, the stage, and what became of the escrow.
    const what = `the model hire for the decision reorder ended with ${scenario.reason}${scenario.stage === null ? '' : ` at ${scenario.stage}`}`;
    const tail = scenario.escrow === null ? 'nothing was locked for it'
      : scenario.code === 'store_write_failed' ? `the stranded store could not be written, so settle its escrow ${scenario.escrow} by hand after its deadline`
        : `its escrow ${scenario.escrow} stays with the janitor of the key`;
    expect(failure.detail).toBe(`${what}; ${tail}`);
    expect('value' in failure).toBe(false);
    // The detail holds the code, the stage and the escrow. It never holds a word of the supplier, of the error of a port or of the input.
    expect(JSON.stringify(failure)).not.toContain(MARKER);
    // One decision is one hire, and a failed hire is not tried again: no second escrow, at most one send, no other supplier and no provider outside the marketplace.
    expect(await run.m.chain.escrowState(escrowNo(2))).toBe('unknown');
    expect(run.m.llm.sends.length).toBeLessThanOrEqual(1);
    expect([...new Set(run.m.calls.map((call) => new URL(call.url).origin))].sort()).toStrictEqual([INDEXER, LLM_ENDPOINT].sort());
    expect(run.key.lane.busy).toBe(false);
  });

  it('gives a decision for the same run when nothing fails: the twin of every case above', async () => {
    const run = await setup();
    run.m.rows.push(indexerRow(`${'d4'.repeat(32)}#0`, { ...LLM_ADVERT, endpoint_url: 'https://203.0.113.32' }));
    run.m.llm.answer = said(MEDIUM_LOT);
    expect(won(await decide(run.deps, REORDER, STOCK_INPUT)).choice).toStrictEqual(MEDIUM_LOT);
  });

  it('is a typed failure, and not an exception, when a port of the hire throws: the ledger that books the Post', async () => {
    const run = await setup();
    run.deps.ledger = { posted: () => { throw new Error(`the ledger broke ${MARKER}`); }, accepted: () => undefined };
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.delivery]).toStrictEqual(['inference_failed', 'hire_threw', null]);
    expect(failure.detail).toContain('Error');
    expect(JSON.stringify(failure)).not.toContain(MARKER);
    // The Post was made before the ledger threw. The escrow is recorded for the janitor, and nothing hires again.
    expect(run.key.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([escrowNo(1)]);
    expect(run.m.llm.sends).toHaveLength(0);
  });

  it('does not try a failed hire again: the next decision is a new hire for a new question, and the failed one stays one escrow', async () => {
    const run = await setup();
    run.m.llm.refuse = { status: 422, reason: 'bad_input' };
    expect(lost(await decide(run.deps, REORDER, STOCK_INPUT)).reason).toBe('llm_refused');
    expect([run.m.llm.sends.length, run.booked.length]).toStrictEqual([1, 1]);
    run.m.llm.refuse = null;
    run.m.llm.answer = said(MEDIUM_LOT);
    const next = won(await decide(run.deps, REORDER, STOCK_INPUT));
    expect(next.inference.sub_job.escrow_ref).toBe(escrowNo(2));
    expect([run.m.llm.sends.length, run.booked.length]).toStrictEqual([2, 2]);
  });
});

describe('decide: a receipt that fails a check', () => {
  it.each<[string, (run: Run) => void]>([
    ['a receipt signed with another key', (run) => { run.m.llm.forge = true; }],
    ['an answer that changed after the supplier signed it', (run) => {
      run.m.llm.answerText = (body) => JSON.stringify({ ...body, output: [{ type: 'message', id: 'msg_x', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: said(MEDIUM_LOT), annotations: [] }] }] });
    }],
  ])('gives no decision and does not accept the escrow: %s', async (_name, arrange) => {
    const run = await setup();
    run.m.llm.answer = said({ ...MEDIUM_LOT, quantity: 5 });
    arrange(run);
    const failure = lost(await decide(run.deps, REORDER, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.stage, failure.delivery]).toStrictEqual(['inference_failed', 'llm_receipt_failed', 'receipt', null]);
    expect('value' in failure).toBe(false);
    // The escrow is Submitted and recorded, and it is not accepted: nothing is paid for an answer that did not verify.
    expect(await run.m.chain.escrowState(escrowNo(1))).toBe('Submitted');
    expect(run.key.stranded.list().map((entry) => entry.escrow_ref)).toStrictEqual([escrowNo(1)]);
  });

  it('records the decision for the same answer when the receipt is good: the twin', async () => {
    const run = await setup();
    run.m.llm.answer = said({ ...MEDIUM_LOT, quantity: 5 });
    expect(won(await decide(run.deps, REORDER, STOCK_INPUT)).choice).toStrictEqual({ ...MEDIUM_LOT, quantity: 5 });
    expect(await run.m.chain.escrowState(escrowNo(1))).toBe('spent');
  });
});

describe('decide: the definition and the input', () => {
  it.each<[string, Record<string, unknown>]>([
    ['a name that is not a name', { name: 'Reorder Now' }],
    ['no name', { name: undefined }],
    ['a name of 65 characters', { name: `a${'_1'.repeat(32)}` }],
    ['a name that starts with a digit', { name: '1reorder' }],
    ['a name with a hyphen', { name: 'accept-delivery' }],
    ['a name with an upper-case letter', { name: 'reorderNow' }],
    ['a name that is not a text', { name: 7 }],
    ['a blank instruction', { instruction: '  ' }],
    ['an instruction that holds the mark that closes the input block', { instruction: `${REORDER.instruction} </input_data>` }],
    ['an instruction that holds the mark that opens the input block', { instruction: `${REORDER.instruction} <input_data>` }],
    ['no parser', { parse: undefined }],
  ])('refuses %s before anything is hired', async (_name, over) => {
    const run = await setup();
    const failure = lost(await decide(run.deps, { ...REORDER, ...over } as DecisionSpec, STOCK_INPUT));
    expect([failure.code, failure.reason, failure.delivery]).toStrictEqual(['internal', 'bad_decision', null]);
    expect([run.m.calls, run.booked, run.key.stranded.list()]).toStrictEqual([[], [], []]);
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['a number that is not finite', { on_hand: Number.NaN }],
    ['a bigint', { on_hand: 12n }],
    ['a date', { at: new Date(0) }],
    ['a function', { run: () => 1 }],
  ])('refuses an input that is not JSON data before anything is hired: %s', async (_name, input) => {
    const run = await setup();
    const failure = lost(await decide(run.deps, REORDER, input as JsonValue));
    expect([failure.code, failure.reason, failure.delivery]).toStrictEqual(['internal', 'bad_input', null]);
    expect([run.m.calls, run.booked, run.key.stranded.list()]).toStrictEqual([[], [], []]);
  });

  it('hires for a definition and an input that are right: the twin', async () => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    expect(won(await decide(run.deps, REORDER, STOCK_INPUT)).name).toBe('reorder');
  });

  it('takes a name of 64 characters, the longest that a name may be, and records it', async () => {
    const run = await setup();
    run.m.llm.answer = said(MEDIUM_LOT);
    const name = `a${'_1'.repeat(31)}b`;
    expect(name).toHaveLength(64);
    expect(won(await decide(run.deps, { ...REORDER, name }, STOCK_INPUT)).name).toBe(name);
  });
});
