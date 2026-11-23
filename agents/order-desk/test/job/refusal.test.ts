// agents/order-desk/test/job/refusal.test.ts: the refusal of the job. `OrderRefusal` has the form of the `Refusal` of the service kit: a code, a status, a message and the kind `job`. The status of a code is the
// status of that code in ERROR_STATUS of the protocol, and a caller cannot choose another status. Each code of the job is in that table, so the table of the job and the table of the protocol are one.
import { describe, expect, it } from 'vitest';
import type { Refusal } from '@vsa/service-kit';
import { COUNTERPARTY_REFUSALS, ERROR_STATUS, isErrorCode } from '@vsa/usecase-kit/protocol';
import { ORDER_REFUSAL_STATUS, OrderRefusal } from '../../src/job/index.ts';
import type { OrderRefusalCode } from '../../src/job/index.ts';

const CODES = Object.keys(ORDER_REFUSAL_STATUS) as OrderRefusalCode[];

describe('an OrderRefusal', () => {
  it('is an error with a code, a status, a message and the kind job, and the service kit takes it as a refusal', () => {
    const refusal = new OrderRefusal('duplicate_po', 'The portal holds the number.');
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.name).toBe('OrderRefusal');
    const form: Refusal = refusal;
    expect(form).toMatchObject({ code: 'duplicate_po', status: 403, message: 'The portal holds the number.', kind: 'job' });
    expect(refusal.message).toBe('The portal holds the number.');
    expect(Object.keys(refusal).sort()).toStrictEqual(['code', 'kind', 'name', 'status']);
  });

  it('has the status of its code, and no caller can give another status', () => {
    // @ts-expect-error the status of a code is fixed: the constructor takes the code and the message only
    const refusal = new OrderRefusal('duplicate_po', 'x', 200);
    expect(refusal.status).toBe(403);
  });

  it.each([
    ['precheck_missing', 500],
    ['svid_failed', 502],
    ['mock_system_failed', 502],
    ['inference_failed', 502],
    ['model_output_invalid', 502],
    ['cannot_supply', 403],
    ['duplicate_po', 403],
    ['store_write_failed', 500],
    ['internal', 500],
    ['deadline', 422],
  ] as const)('has the code %s with the status %s', (code, status) => {
    expect(new OrderRefusal(code, 'x').status).toBe(status);
    expect(ORDER_REFUSAL_STATUS[code]).toBe(status);
  });

  it('has each code in ERROR_STATUS of the kit with the same status, and the kit knows each one as an error code', () => {
    for (const code of CODES) {
      expect(isErrorCode(code), code).toBe(true);
      expect(ORDER_REFUSAL_STATUS[code], code).toBe(ERROR_STATUS[code]);
    }
  });

  it('has a table that nothing can change', () => {
    expect(Object.isFrozen(ORDER_REFUSAL_STATUS)).toBe(true);
    expect(Object.keys(ORDER_REFUSAL_STATUS)).toHaveLength(10);
  });

  it('has the two refusal codes of the Order Desk that the job gives after the Claim in the list of that agent, and the others are error codes that no counterparty lists as a refusal', () => {
    for (const code of ['duplicate_po', 'cannot_supply'] as const) expect(COUNTERPARTY_REFUSALS['order-desk']).toContain(code);
    for (const code of ['precheck_missing', 'svid_failed', 'mock_system_failed', 'inference_failed', 'model_output_invalid', 'store_write_failed', 'internal', 'deadline'] as const) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
      for (const list of Object.values(COUNTERPARTY_REFUSALS)) expect(list, code).not.toContain(code);
    }
  });
});
