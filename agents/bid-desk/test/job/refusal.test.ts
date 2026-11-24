// agents/bid-desk/test/job/refusal.test.ts: the refusal of the job. `QuoteRefusal` has the form of the `Refusal` of the service kit: a code, a status, a message and the kind `job`. The status of a code is the
// status of that code in ERROR_STATUS of the protocol, and a caller cannot choose another status. Each code of the job is in that table, so the table of the job and the table of the protocol are one. A failed
// decision gives the code of its own failure and the text of that code, and its reason goes to the log only.
import { describe, expect, it } from 'vitest';
import type { Refusal } from '@vsa/service-kit';
import { DECISION_FAILURE_CODES } from '@vsa/usecase-kit/decision';
import type { DecisionFailure } from '@vsa/usecase-kit/decision';
import { COUNTERPARTY_REFUSALS, ERROR_STATUS, REFUSAL_CODES, isErrorCode } from '@vsa/usecase-kit/protocol';
import { DECISION_TEXT, QUOTE_REFUSAL_STATUS, QUOTE_TEXT, QuoteRefusal, decisionCodeOf, describeDecision } from '../../src/job/refusal.ts';
import type { QuoteRefusalCode } from '../../src/job/refusal.ts';

const CODES = Object.keys(QUOTE_REFUSAL_STATUS) as QuoteRefusalCode[];

/** A failed decision as `decide` of the kit gives it. `over` replaces members. */
const failureOf = (over: Partial<DecisionFailure> = {}): DecisionFailure => ({
  ok: false, code: 'inference_failed', reason: 'llm_timeout', detail: 'DETAIL-OF-THE-HIRE: the hire ended at poll', delivery: null, escrow_ref: null, stage: 'poll', ...over,
});

describe('a QuoteRefusal', () => {
  it('is an error with a code, a status, a message and the kind job, and the service kit takes it as a refusal', () => {
    const refusal = new QuoteRefusal('duplicate_rfq', 'The desk holds a quote.');
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.name).toBe('QuoteRefusal');
    const form: Refusal = refusal;
    expect(form).toMatchObject({ code: 'duplicate_rfq', status: 403, message: 'The desk holds a quote.', kind: 'job' });
    expect(refusal.message).toBe('The desk holds a quote.');
    expect(Object.keys(refusal).sort()).toStrictEqual(['code', 'kind', 'name', 'status']);
  });

  it('has the status of its code, and no caller can give another status', () => {
    // @ts-expect-error the status of a code is fixed: the constructor takes the code and the message only
    const refusal = new QuoteRefusal('duplicate_rfq', 'x', 200);
    expect(refusal.status).toBe(403);
  });

  it.each([
    ['precheck_missing', 500],
    ['duplicate_rfq', 403],
    ['credential_failed', 502],
    ['inference_failed', 502],
    ['model_output_invalid', 502],
    ['store_write_failed', 500],
    ['internal', 500],
    ['deadline', 422],
  ] as const)('has the code %s with the status %s', (code, status) => {
    expect(new QuoteRefusal(code, 'x').status).toBe(status);
    expect(QUOTE_REFUSAL_STATUS[code]).toBe(status);
  });

  it('has each code in ERROR_STATUS of the kit with the same status, and the kit knows each one as an error code', () => {
    for (const code of CODES) {
      expect(isErrorCode(code), code).toBe(true);
      expect(QUOTE_REFUSAL_STATUS[code], code).toBe(ERROR_STATUS[code]);
    }
  });

  it('has a table that nothing can change, with the eight codes of the job', () => {
    expect(Object.isFrozen(QUOTE_REFUSAL_STATUS)).toBe(true);
    expect(CODES.slice().sort()).toStrictEqual(
      ['credential_failed', 'deadline', 'duplicate_rfq', 'inference_failed', 'internal', 'model_output_invalid', 'precheck_missing', 'store_write_failed'],
    );
  });

  it('has every code that a failed decision gives, each with the status of the kit', () => {
    for (const code of DECISION_FAILURE_CODES) expect(QUOTE_REFUSAL_STATUS[code], code).toBe(ERROR_STATUS[code]);
  });

  it('has the one refusal code of the Bid Desk that the job gives after the Claim in the list of that agent, and the other codes are error codes that no counterparty lists as a refusal', () => {
    expect(COUNTERPARTY_REFUSALS['bid-desk']).toContain('duplicate_rfq');
    for (const code of ['precheck_missing', 'credential_failed', 'inference_failed', 'model_output_invalid', 'store_write_failed', 'internal', 'deadline'] as const) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(REFUSAL_CODES as readonly string[], code).not.toContain(code);
      for (const list of Object.values(COUNTERPARTY_REFUSALS)) expect(list as readonly string[], code).not.toContain(code);
    }
  });
});

describe('the texts of the refusals', () => {
  it('are one line each, and short enough that the runtime gives the buyer the whole text', () => {
    for (const [name, text] of [...Object.entries(QUOTE_TEXT), ...Object.entries(DECISION_TEXT)]) {
      expect(text.length, name).toBeLessThanOrEqual(200);
      expect(text, name).not.toMatch(/[\n\r]/);
      expect(text.trim(), name).not.toBe('');
    }
  });

  it('name a text for each code of a failed decision', () => {
    expect(Object.keys(DECISION_TEXT).sort()).toStrictEqual([...DECISION_FAILURE_CODES].sort());
  });
});

describe('decisionCodeOf', () => {
  it.each(DECISION_FAILURE_CODES)('gives %s for a failure with that code', (code) => {
    expect(decisionCodeOf(failureOf({ code }))).toBe(code);
  });

  it.each([
    ['a code that is no code of a failed decision', failureOf({ code: 'precheck_missing' as DecisionFailure['code'] })],
    ['the code of a refusal of a rule', failureOf({ code: 'duplicate_rfq' as DecisionFailure['code'] })],
    ['a code that no table has', failureOf({ code: 'made_up' as DecisionFailure['code'] })],
    ['a code that is not a text', failureOf({ code: 7 as unknown as DecisionFailure['code'] })],
    ['no failure: undefined', undefined as unknown as DecisionFailure],
    ['no failure: null', null as unknown as DecisionFailure],
    ['a failure that is a text', 'inference_failed' as unknown as DecisionFailure],
  ])('gives internal for %s, so a result that cannot be read never has a code that the kit does not list', (_what, failure) => {
    expect(decisionCodeOf(failure)).toBe('internal');
  });
});

describe('describeDecision', () => {
  it('names the reason, the stage and the escrow of the hire, and says that the model supplier may be paid when the failure carries a delivery', () => {
    const line = describeDecision(failureOf({
      reason: 'llm_receipt_failed', stage: 'receipt', escrow_ref: `${'4c'.repeat(32)}#0`,
      delivery: { sub_job: null, receipt: 'not_recordable', accepted: 'pending', escrow_ref: null, advert_ref: null, supplier_pkh: null, verification: null },
    }));
    expect(line).toContain('llm_receipt_failed');
    expect(line).toContain('receipt');
    expect(line).toContain(`escrow ${'4c'.repeat(32)}#0`);
    expect(line).toContain('may be paid');
    expect(line).toContain('accepted pending');
  });

  it('says nothing of a payment when the failure has no delivery, and names the reason and the stage', () => {
    const line = describeDecision(failureOf());
    expect(line).toContain('llm_timeout');
    expect(line).toContain('poll');
    expect(line).not.toContain('paid');
    expect(line).not.toContain('escrow');
  });

  it('never holds the detail of the failure: the detail repeats a part of the answer of the model or of a supplier', () => {
    expect(describeDecision(failureOf())).not.toContain('DETAIL-OF-THE-HIRE');
  });

  it('gives a line for a failure that cannot be read, and never throws', () => {
    for (const failure of [undefined, null, 'x', 7, {}] as unknown as DecisionFailure[]) {
      expect(() => describeDecision(failure)).not.toThrow();
      expect(typeof describeDecision(failure)).toBe('string');
    }
  });
});
