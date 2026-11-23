// agents/order-desk/test/job/decision.test.ts: step 5 of the job, and the guards before the order. The model decides `availability`. A failed decision ends the job with the code of the failure and the status of
// that code, and the job places no order. A model that does not confirm ends the job with `cannot_supply` (403): no order, and a message of fixed text and at most 120 characters of the note of the model, with
// no line break. No order is placed unless the model said `confirm: true`. A confirmation that the parser of the kit would refuse is found before the order is placed. A caller that has hung up gets no
// decision and no order. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { AFTER_CLAIM_REFUSALS, COUNTERPARTY_REFUSALS, ERROR_STATUS, accepted } from '@vsa/usecase-kit/protocol';
import type { Decision, JsonValue } from '@vsa/usecase-kit/protocol';
import { runOrder } from '../../src/job/index.ts';
import type { AvailabilityChoice } from '../../src/job/index.ts';
import { makeRig, refusalOf } from './rig.ts';
import type { Rig } from './rig.ts';
import { ESCROW_REF, FACTS, decisionOf, failureOf, recordFor } from './samples.ts';

const FIXED = 'The Order Desk cannot supply this order.';

/** The job stopped at the decision: the record, the SVID, the catalogue and the decision happened, and the portal got the read only. No order, no order book record. */
function expectStoppedAtDecision(rig: Rig): void {
  expect(rig.events).toStrictEqual(['take', 'svid', 'catalogue', 'decide']);
  expect(rig.portal.calls).toHaveLength(1);
  expect(rig.portal.calls[0]?.method).toBe('GET');
  expect(rig.portal.orders.size).toBe(0);
  expect(rig.booked).toHaveLength(0);
}

describe('a decision that failed', () => {
  it.each([
    ['inference_failed', 502],
    ['model_output_invalid', 502],
    ['store_write_failed', 500],
    ['internal', 500],
  ] as const)('ends the job with %s and its status %s, places no order, and the log names the hire', async (code, status) => {
    const rig = makeRig();
    rig.decision = failureOf(code, { reason: 'llm_busy', stage: 'send', escrow_ref: ESCROW_REF });
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code, status, kind: 'job' });
    expect(status).toBe(ERROR_STATUS[code]);
    expectStoppedAtDecision(rig);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain(code);
    expect(rig.logs[0]).toContain('llm_busy');
    expect(rig.logs[0]).toContain('send');
    expect(rig.logs[0]).toContain(ESCROW_REF);
  });

  it('twin: the model that answers passes, and the job places the order', async () => {
    const rig = makeRig();
    expect(await rig.run()).toMatchObject({ outcome: 'done' });
    expect(rig.portal.orders.size).toBe(1);
  });

  it('says in the log that the model supplier was paid when the failure carries a delivery', async () => {
    const rig = makeRig();
    const { sub_job: subJob } = decisionOf().inference;
    rig.decision = failureOf('model_output_invalid', { reason: 'model_output_invalid', stage: 'accept', delivery: { sub_job: subJob, accepted: 'pending' }, escrow_ref: ESCROW_REF });
    await refusalOf(rig.run());
    expect(rig.logs[0]).toContain('accepted pending');
    const clean = makeRig();
    clean.decision = failureOf('inference_failed');
    await refusalOf(clean.run());
    expect(clean.logs[0]).not.toContain('accepted');
  });

  it('gives a text with no detail of the failure to the buyer: the code and the stage stay in the log', async () => {
    const rig = makeRig();
    rig.decision = failureOf('inference_failed', { reason: 'llm_timeout', detail: 'the escrow and the answer of the supplier: SECRET-DETAIL' });
    const refusal = await refusalOf(rig.run());
    expect(refusal.message).not.toContain('llm_timeout');
    expect(refusal.message).not.toContain('SECRET-DETAIL');
    expect(rig.logs.join('\n')).not.toContain('SECRET-DETAIL');
  });

  it.each([
    ['a code that is not a code of a failed decision', { ok: false, code: 'cannot_supply', reason: 'x', detail: 'x', delivery: null, escrow_ref: null, stage: null }],
    ['a result with no ok', {}],
    ['a result that says ok with a text', { ok: 'yes', value: decisionOf() }],
    ['null', null],
  ])('ends the job with internal (500) for %s, and places no order', async (_what, result) => {
    const rig = makeRig();
    rig.decision = result as never;
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'internal', status: 500 });
    expectStoppedAtDecision(rig);
  });
});

describe('a model that does not confirm', () => {
  it('ends the job with cannot_supply (403), places no order, and writes nothing to the portal or to the order book', async () => {
    const rig = makeRig();
    rig.decision = accepted(decisionOf({ confirm: false, note: 'The item is discontinued.' }));
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'cannot_supply', status: 403, kind: 'job', message: `${FIXED} Note of the model: The item is discontinued.` });
    expectStoppedAtDecision(rig);
    expect(rig.portal.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('cannot_supply');
  });

  it('twin: the same model that confirms places one order', async () => {
    const rig = makeRig();
    rig.decision = accepted(decisionOf({ confirm: true, note: 'The item is in stock.' }));
    expect(await rig.run()).toMatchObject({ outcome: 'done' });
    expect(rig.portal.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('is a code of the Order Desk that comes after the Claim, and its status is the status of the protocol', () => {
    expect(AFTER_CLAIM_REFUSALS).toContain('cannot_supply');
    expect(COUNTERPARTY_REFUSALS['order-desk']).toContain('cannot_supply');
    expect(ERROR_STATUS.cannot_supply).toBe(403);
  });

  describe('the message', () => {
    const messageOf = async (note: string): Promise<string> => {
      const rig = makeRig();
      rig.decision = accepted(decisionOf({ confirm: false, note }));
      return (await refusalOf(rig.run())).message;
    };
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

    it('is the fixed text alone for an empty note and for a note of white space', async () => {
      expect(await messageOf('')).toBe(FIXED);
      expect(await messageOf('   \n\t \r\n ')).toBe(FIXED);
    });

    it('holds the first 120 characters of a long note, and no more', async () => {
      const message = await messageOf(`${'a'.repeat(120)}${'b'.repeat(80)}`);
      expect(message).toBe(`${FIXED} Note of the model: ${'a'.repeat(120)}`);
    });

    it('holds a note of exactly 120 characters whole, and a note of 119 characters whole', async () => {
      expect(await messageOf('c'.repeat(120))).toBe(`${FIXED} Note of the model: ${'c'.repeat(120)}`);
      expect(await messageOf('d'.repeat(119))).toBe(`${FIXED} Note of the model: ${'d'.repeat(119)}`);
    });

    it.each([
      ['a line feed', 'first\nsecond'],
      ['a carriage return and a line feed', 'first\r\nsecond'],
      ['a carriage return', 'first\rsecond'],
      ['a tab', 'first\tsecond'],
      ['a vertical tab and a form feed', 'first\v\fsecond'],
      ['the next line character', 'first\u0085second'],
      ['the line separator', 'first\u2028second'],
      ['the paragraph separator', 'first\u2029second'],
    ])('holds no line break and no control character: %s becomes a space', async (_what, note) => {
      const message = await messageOf(note);
      expect(message).not.toMatch(/[\p{Cc}\u2028\u2029]/u);
      expect(message.startsWith(`${FIXED} Note of the model: first`)).toBe(true);
      expect(message.endsWith('second')).toBe(true);
    });

    it('holds a note that starts with line breaks as at most 120 characters that start with the text', async () => {
      const message = await messageOf(`\n\n${'y'.repeat(150)}`);
      const note = message.slice(`${FIXED} Note of the model: `.length);
      expect(note.length).toBeLessThanOrEqual(120);
      expect(note.startsWith('y')).toBe(true);
      expect(message).not.toMatch(/[\p{Cc}\u2028\u2029]/u);
    });

    it('never splits a pair of surrogates at the cut: the emoji that stands at the end of the 120 characters is left out whole', async () => {
      const message = await messageOf(`${'e'.repeat(119)}\u{1f600}${'f'.repeat(10)}`);
      expect(message).toBe(`${FIXED} Note of the model: ${'e'.repeat(119)}`);
      expect(message).not.toMatch(lone);
      const whole = await messageOf(`${'e'.repeat(118)}\u{1f600}${'f'.repeat(10)}`);
      expect(whole).toBe(`${FIXED} Note of the model: ${'e'.repeat(118)}\u{1f600}`);
      expect(whole).not.toMatch(lone);
    });

    it('holds nothing else of the answer: no reasoning, no hire, no reference', async () => {
      const rig = makeRig();
      rig.decision = accepted(decisionOf({ confirm: false, note: 'short' }));
      const refusal = await refusalOf(rig.run());
      const decision = rig.decision.ok ? rig.decision.value : null;
      expect(refusal.message).not.toContain(decision?.reasoning ?? 'missing');
      expect(refusal.message).not.toContain(decision?.inference.sub_job.escrow_ref ?? 'missing');
    });
  });
});

describe('a choice that is not confirm true or confirm false', () => {
  it.each([
    ['the text yes', 'yes'],
    ['the text true', 'true'],
    ['the number 1', 1],
    ['null', null],
  ])('%s is model_output_invalid (502): the job places no order', async (_what, confirm) => {
    const rig = makeRig();
    rig.decision = accepted(decisionOf({ confirm: confirm as never }));
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'model_output_invalid', status: 502 });
    expectStoppedAtDecision(rig);
  });

  it('twin: confirm true and confirm false are the two answers that the job reads', async () => {
    const yes = makeRig();
    expect(await yes.run()).toMatchObject({ outcome: 'done' });
    const no = makeRig();
    no.decision = accepted(decisionOf({ confirm: false }));
    expect(await refusalOf(no.run())).toMatchObject({ code: 'cannot_supply' });
  });
});

describe('a confirmation that the parser of the kit would refuse', () => {
  const broken: ReadonlyArray<readonly [string, (decision: Decision<AvailabilityChoice>) => Decision<AvailabilityChoice>, string]> = [
    ['a decision with another name', (d) => ({ ...d, name: 'reorder' }), 'decisions[0].name'],
    ['a decision with a reasoning of white space', (d) => ({ ...d, reasoning: '   ' }), 'decisions[0].reasoning'],
    ['a choice with a date that does not exist', (d) => ({ ...d, choice: { ...d.choice, ship_by: '2026-02-30' } }), 'ship_by'],
    ['a choice with a text in place of a date', (d) => ({ ...d, choice: { ...d.choice, ship_by: 'tomorrow' } }), 'ship_by'],
    ['an Accept that is neither confirmed nor pending', (d) => ({ ...d, inference: { ...d.inference, accepted: 'maybe' as never } }), 'accepted'],
    ['a path that is not the marketplace', (d) => ({ ...d, inference: { ...d.inference, path: 'direct' as never } }), 'path'],
    ['a sub-job with no escrow reference', (d) => ({ ...d, inference: { ...d.inference, sub_job: { ...d.inference.sub_job, escrow_ref: 'none' } } }), 'escrow_ref'],
    ['a receipt check that is not true or false', (d) => ({ ...d, inference: { ...d.inference, sub_job: { ...d.inference.sub_job, verification: { ...d.inference.sub_job.verification, signature_valid: 1 as never } } } }), 'signature_valid'],
  ];

  it.each(broken)('%s ends the job with internal (500) before the order is placed, and the log names the member', async (_what, change, member) => {
    const rig = makeRig();
    rig.decision = accepted(change(decisionOf()));
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'internal', status: 500 });
    expectStoppedAtDecision(rig);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain(member);
  });

  it('is found before the order also for an organisation that the confirmation cannot hold: a text of 1025 characters, and the twin of 1024', async () => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { facts: { ...FACTS, organisation: 'o'.repeat(1025) } });
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'internal', status: 500 });
    expectStoppedAtDecision(rig);
    const fine = makeRig();
    fine.entry = recordFor(fine.request, { facts: { ...FACTS, organisation: 'o'.repeat(1024) } });
    expect(await fine.run()).toMatchObject({ outcome: 'done' });
  });

  it('is found before the order for a fault setting that the kit does not list: a switch that a caller made by hand', async () => {
    const rig = makeRig();
    const wrong = { ...rig.deps, fault: { kind: 'order-desk', mode: 'wrong_lot' } as never };
    expect(await refusalOf(runOrder(wrong, rig.request, rig.context, rig.gateway.now()))).toMatchObject({ code: 'internal', status: 500 });
    expectStoppedAtDecision(rig);
    expect(rig.logs[0]).toContain('fault_mode');
  });

  it('twin: the decision with every member right passes', async () => {
    const rig = makeRig();
    rig.decision = accepted(decisionOf({ ship_by: '2026-12-01' }));
    expect(await rig.run()).toMatchObject({ outcome: 'done', ship_by: '2026-12-01' });
  });
});

describe('a caller that has hung up', () => {
  it('gets no decision and no order: the signal is looked at before the model is hired (deadline, status 422)', async () => {
    const rig = makeRig();
    const hungUp = new AbortController();
    hungUp.abort();
    const refusal = await refusalOf(rig.run({ signal: hungUp.signal }));
    expect(refusal).toMatchObject({ code: 'deadline', status: 422, kind: 'job' });
    expect(rig.events).toStrictEqual(['take', 'svid', 'catalogue']);
    expect(rig.decideInputs).toHaveLength(0);
    expect(rig.portal.orders.size).toBe(0);
    expect(rig.booked).toHaveLength(0);
    expect(rig.logs[0]).toContain('hung up');
  });

  it('gets no order when it hangs up while the model is hired: the signal is looked at again before the order', async () => {
    const rig = makeRig();
    const hungUp = new AbortController();
    const deps = {
      ...rig.deps,
      decide: async (input: JsonValue) => {
        const result = await rig.deps.decide(input);
        hungUp.abort();
        return result;
      },
    };
    const refusal = await refusalOf(runOrder(deps, rig.request, rig.context, rig.gateway.now(), hungUp.signal));
    expect(refusal).toMatchObject({ code: 'deadline', status: 422 });
    expect(rig.events).toStrictEqual(['take', 'svid', 'catalogue', 'decide']);
    expect(rig.portal.orders.size).toBe(0);
    expect(rig.portal.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect(rig.booked).toHaveLength(0);
  });

  it('twin: a caller that stays, with a signal that never aborts and with no signal, gets the order', async () => {
    const stays = makeRig();
    expect(await stays.run({ signal: new AbortController().signal })).toMatchObject({ outcome: 'done' });
    expect(stays.portal.orders.size).toBe(1);
    const none = makeRig();
    expect(await none.run()).toMatchObject({ outcome: 'done' });
    expect(none.portal.orders.size).toBe(1);
  });
});
