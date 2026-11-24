// packages/usecase-kit/test/protocol/codes.test.ts: the names that the protocol fixes: the use cases, the operations, the outcomes, the exit states, and every error and refusal code with its HTTP status.
// The tables below are written out from the protocol. A code that is added, removed or moved to another status fails here.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AFTER_CLAIM_REFUSALS, APPROVAL_REFUSALS, COUNTERPARTY_KINDS, COUNTERPARTY_REFUSALS, DELEGATION_REFUSALS, ERROR_STATUS, EXECUTE_OUTCOMES, EXIT_STATES, OPERATIONS, OUTCOMES, PROPOSE_OUTCOMES, REFUSAL_CODES,
  SENDER_REFUSALS, SYSTEM_REFUSALS, SYSTEM_REFUSAL_STATUS, USE_CASES, VAULT_REFUSALS, isErrorCode, isRefusalCode, isSystemRefusal,
} from '@vsa/usecase-kit/protocol';
import type { ErrorBody, ErrorCode, ExecuteOutcome, ExitState, Operation, Outcome, ProposeOutcome, RefusalCode, UseCase } from '@vsa/usecase-kit/protocol';

const EXPECTED_STATUS: Readonly<Record<string, number>> = {
  // 400
  bad_wire: 400,
  request_too_large: 400,
  bad_shape: 400,
  delegation_not_mine: 400,
  // 401
  unauthorized: 401,
  // 403: the refusals of a counterparty, in the order of its checks, then the codes of the page of each counterparty
  sender_not_active: 403,
  sender_unaccountable: 403,
  sender_key_mismatch: 403,
  delegation_invalid: 403,
  delegation_ended: 403,
  not_vault_paid: 403,
  approval_not_found: 403,
  approval_wrong_type: 403,
  approval_wrong_subject: 403,
  approval_wrong_issuer: 403,
  approval_revoked: 403,
  approval_expired: 403,
  approval_issuer_invalid: 403,
  approval_digest_mismatch: 403,
  not_for_this_supplier: 403,
  lot_mismatch: 403,
  quantity_mismatch: 403,
  duplicate_po: 403,
  cannot_supply: 403,
  not_for_this_insurer: 403,
  advert_mismatch: 403,
  duplicate_request: 403,
  duplicate_rfq: 403,
  // 409
  busy: 409,
  // 422
  deadline: 422,
  // 502
  inference_failed: 502,
  model_output_invalid: 502,
  token_failed: 502,
  mock_system_failed: 502,
  hire_failed: 502,
  svid_failed: 502,
  credential_failed: 502,
  // 503
  shutting_down: 503,
  check_unavailable: 503,
  // 500
  store_write_failed: 500,
  precheck_missing: 500,
  internal: 500,
};

describe('ERROR_STATUS', () => {
  it('is the table of the protocol, with its changes', () => {
    expect({ ...ERROR_STATUS }).toStrictEqual(EXPECTED_STATUS);
  });

  it('has the codes of a request that cannot be read at 400, and the code for a delegation that names another agent', () => {
    for (const code of ['bad_wire', 'request_too_large', 'bad_shape', 'delegation_not_mine'] as const) expect(ERROR_STATUS[code]).toBe(400);
  });

  it('gives every code a whole HTTP status of 4xx or 5xx', () => {
    for (const [code, status] of Object.entries(ERROR_STATUS)) {
      expect(Number.isInteger(status), code).toBe(true);
      expect(status >= 400 && status <= 599, code).toBe(true);
    }
  });

  it('names every code in lower case with underscores', () => {
    for (const code of Object.keys(ERROR_STATUS)) expect(code).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
  });
});

describe('the refusal codes', () => {
  it('has the codes of the sender in the order of the checks', () => {
    expect([...SENDER_REFUSALS]).toStrictEqual(['sender_not_active', 'sender_unaccountable', 'sender_key_mismatch']);
  });

  it('has the codes of the delegation in the order of the checks', () => {
    expect([...DELEGATION_REFUSALS]).toStrictEqual(['delegation_invalid', 'delegation_ended']);
  });

  it('has the code for an escrow that the vault of the delegation did not pay', () => {
    expect([...VAULT_REFUSALS]).toStrictEqual(['not_vault_paid']);
  });

  it('has the eight codes of the approval in the order of the checks', () => {
    expect([...APPROVAL_REFUSALS]).toStrictEqual([
      'approval_not_found', 'approval_wrong_type', 'approval_wrong_subject', 'approval_wrong_issuer', 'approval_revoked', 'approval_expired', 'approval_issuer_invalid', 'approval_digest_mismatch',
    ]);
  });

  it('has, for each counterparty, the codes of the protocol and the codes of its own page, in the order of its checks', () => {
    const common = [...SENDER_REFUSALS, ...DELEGATION_REFUSALS, ...VAULT_REFUSALS];
    expect(COUNTERPARTY_REFUSALS['order-desk']).toStrictEqual([...common, ...APPROVAL_REFUSALS, 'not_for_this_supplier', 'lot_mismatch', 'quantity_mismatch', 'duplicate_po', 'cannot_supply']);
    expect(COUNTERPARTY_REFUSALS['insurer-intake-agent']).toStrictEqual([...common, ...APPROVAL_REFUSALS, 'not_for_this_insurer', 'advert_mismatch', 'duplicate_request']);
    expect(COUNTERPARTY_REFUSALS['bid-desk']).toStrictEqual([...common, 'duplicate_rfq']);
  });

  it('gives the bid desk no code of an approval, because a request for quotation carries none', () => {
    for (const code of APPROVAL_REFUSALS) expect(COUNTERPARTY_REFUSALS['bid-desk']).not.toContain(code);
  });

  it('has a table for each kind of counterparty and for no other kind', () => {
    expect(Object.keys(COUNTERPARTY_REFUSALS).sort()).toStrictEqual([...COUNTERPARTY_KINDS].sort());
  });

  it('lists every code once in REFUSAL_CODES, and the list holds exactly the codes that a counterparty can use', () => {
    expect(new Set(REFUSAL_CODES).size).toBe(REFUSAL_CODES.length);
    const used = new Set(Object.values(COUNTERPARTY_REFUSALS).flat());
    expect([...used].sort()).toStrictEqual([...REFUSAL_CODES].sort());
  });

  it('gives every refusal code the status 403, and no other code has 403', () => {
    for (const code of REFUSAL_CODES) expect(ERROR_STATUS[code], code).toBe(403);
    const at403 = Object.entries(ERROR_STATUS).filter(([, status]) => status === 403).map(([code]) => code);
    expect(at403.sort()).toStrictEqual([...REFUSAL_CODES].sort());
  });
});

describe('isErrorCode and isRefusalCode', () => {
  it('take every code of their own list', () => {
    for (const code of Object.keys(ERROR_STATUS)) expect(isErrorCode(code), code).toBe(true);
    for (const code of REFUSAL_CODES) expect(isRefusalCode(code), code).toBe(true);
  });

  it('refuse a refusal code that is an error code of another status, and the reverse', () => {
    for (const code of ['bad_shape', 'busy', 'deadline', 'internal', 'unauthorized', 'shutting_down']) expect(isRefusalCode(code), code).toBe(false);
    for (const code of ['bad_shape', 'busy']) expect(isErrorCode(code), code).toBe(true);
  });

  it.each(['', 'not_a_code', 'BAD_SHAPE', ' bad_shape', 'bad_shape ', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'approval_', 42, null, undefined, {}, ['busy']])(
    'refuses %j',
    (value) => {
      expect(isErrorCode(value)).toBe(false);
      expect(isRefusalCode(value)).toBe(false);
    },
  );
});

describe('check_unavailable', () => {
  it('is a 503 error code, and it is not a refusal code of a rule', () => {
    expect(ERROR_STATUS.check_unavailable).toBe(503);
    expect(isErrorCode('check_unavailable')).toBe(true);
    expect(isRefusalCode('check_unavailable')).toBe(false);
    expect(REFUSAL_CODES).not.toContain('check_unavailable');
    for (const kind of COUNTERPARTY_KINDS) expect(COUNTERPARTY_REFUSALS[kind]).not.toContain('check_unavailable');
    expectTypeOf<'check_unavailable'>().toExtend<ErrorCode>();
    expectTypeOf<'check_unavailable'>().not.toExtend<RefusalCode>();
  });
});

describe('the codes of the job of a counterparty after its Claim', () => {
  it('are precheck_missing (500) and svid_failed (502): error codes, and not refusal codes of a rule', () => {
    expect(ERROR_STATUS.precheck_missing).toBe(500);
    expect(ERROR_STATUS.svid_failed).toBe(502);
    for (const code of ['precheck_missing', 'svid_failed']) {
      expect(isErrorCode(code), code).toBe(true);
      expect(isRefusalCode(code), code).toBe(false);
      expect(REFUSAL_CODES).not.toContain(code);
      expect(AFTER_CLAIM_REFUSALS).not.toContain(code);
      for (const kind of COUNTERPARTY_KINDS) expect(COUNTERPARTY_REFUSALS[kind], code).not.toContain(code);
    }
    expectTypeOf<'precheck_missing'>().toExtend<ErrorCode>();
    expectTypeOf<'svid_failed'>().toExtend<ErrorCode>();
    expectTypeOf<'precheck_missing'>().not.toExtend<RefusalCode>();
    expectTypeOf<'svid_failed'>().not.toExtend<RefusalCode>();
  });
});

describe('credential_failed', () => {
  it('is a 502 error code: the job of a Bid Desk could not get its credential from the identity gateway', () => {
    expect(ERROR_STATUS.credential_failed).toBe(502);
    expect(isErrorCode('credential_failed')).toBe(true);
    expectTypeOf<'credential_failed'>().toExtend<ErrorCode>();
  });

  it('is no refusal code of a rule: no list of refusals holds it, and no refusal of a mock system', () => {
    expect(isRefusalCode('credential_failed')).toBe(false);
    expect(REFUSAL_CODES).not.toContain('credential_failed');
    for (const kind of COUNTERPARTY_KINDS) expect(COUNTERPARTY_REFUSALS[kind], kind).not.toContain('credential_failed');
    expect(SYSTEM_REFUSALS).not.toContain('credential_failed');
    expect(Object.keys(SYSTEM_REFUSAL_STATUS)).not.toContain('credential_failed');
    expect(isSystemRefusal('credential_failed')).toBe(false);
    expect(AFTER_CLAIM_REFUSALS).not.toContain('credential_failed');
    expectTypeOf<'credential_failed'>().not.toExtend<RefusalCode>();
  });
});

describe('AFTER_CLAIM_REFUSALS', () => {
  it('is cannot_supply alone: the decision of the order desk after its Claim', () => {
    expect([...AFTER_CLAIM_REFUSALS]).toStrictEqual(['cannot_supply']);
    expect(COUNTERPARTY_REFUSALS['order-desk']).toContain('cannot_supply');
    expect(isRefusalCode('cannot_supply')).toBe(true);
    expect(ERROR_STATUS.cannot_supply).toBe(403);
  });

  it('names no code of the other counterparties, and no check that comes before the Claim', () => {
    for (const code of AFTER_CLAIM_REFUSALS) {
      expect(COUNTERPARTY_REFUSALS['insurer-intake-agent']).not.toContain(code);
      expect(COUNTERPARTY_REFUSALS['bid-desk']).not.toContain(code);
    }
    const before: readonly string[] = [...SENDER_REFUSALS, ...DELEGATION_REFUSALS, ...VAULT_REFUSALS, ...APPROVAL_REFUSALS];
    for (const code of AFTER_CLAIM_REFUSALS) expect(before).not.toContain(code);
    expectTypeOf<(typeof AFTER_CLAIM_REFUSALS)[number]>().toExtend<RefusalCode>();
  });
});

describe('the refusals of a mock system', () => {
  it('are token_invalid with the status 401, and five codes and the eight codes of an approval with the status 403', () => {
    expect({ ...SYSTEM_REFUSAL_STATUS }).toStrictEqual({
      token_invalid: 401,
      not_covered: 403,
      delegation_ended: 403,
      chain_too_deep: 403,
      supplier_not_active: 403,
      approval_not_found: 403,
      approval_wrong_type: 403,
      approval_wrong_subject: 403,
      approval_wrong_issuer: 403,
      approval_revoked: 403,
      approval_expired: 403,
      approval_issuer_invalid: 403,
      approval_digest_mismatch: 403,
    });
  });

  it('are listed in the order of the protocol, and the list and the table hold the same codes', () => {
    expect([...SYSTEM_REFUSALS]).toStrictEqual(['token_invalid', 'not_covered', 'delegation_ended', 'chain_too_deep', 'supplier_not_active', ...APPROVAL_REFUSALS]);
    expect(Object.keys(SYSTEM_REFUSAL_STATUS).sort()).toStrictEqual([...SYSTEM_REFUSALS].sort());
    expect(new Set(SYSTEM_REFUSALS).size).toBe(SYSTEM_REFUSALS.length);
    expectTypeOf<(typeof SYSTEM_REFUSALS)[number]>().toEqualTypeOf<keyof typeof SYSTEM_REFUSAL_STATUS>();
  });

  it('give the status that ERROR_STATUS gives for the codes that both name, and four codes are only the codes of a mock system', () => {
    for (const code of SYSTEM_REFUSALS) {
      if (isErrorCode(code)) expect(ERROR_STATUS[code], code).toBe(SYSTEM_REFUSAL_STATUS[code]);
      else expect(['token_invalid', 'not_covered', 'chain_too_deep', 'supplier_not_active'], code).toContain(code);
    }
  });
});

describe('isSystemRefusal', () => {
  it('takes every code of the list', () => {
    for (const code of SYSTEM_REFUSALS) expect(isSystemRefusal(code), code).toBe(true);
  });

  it.each(['', 'busy', 'sender_not_active', 'check_unavailable', 'client_certificate_missing', 'TOKEN_INVALID', ' token_invalid', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 42, null, undefined, {}, ['token_invalid']])(
    'refuses %j: a code of a mock system that is not in the list can be a reason, and it is not a refusal that the protocol names',
    (value) => {
      expect(isSystemRefusal(value)).toBe(false);
    },
  );
});

describe('the outcomes', () => {
  it('are the seven of the protocol', () => {
    expect([...OUTCOMES]).toStrictEqual(['proposed', 'completed', 'vault_refused', 'refused_by_counterparty', 'refused_by_system', 'disputed', 'failed']);
  });

  it('are split between the two operations: propose has two, execute has six, and failed is in both', () => {
    expect([...PROPOSE_OUTCOMES]).toStrictEqual(['proposed', 'failed']);
    expect([...EXECUTE_OUTCOMES]).toStrictEqual(['completed', 'vault_refused', 'refused_by_counterparty', 'refused_by_system', 'disputed', 'failed']);
    expect([...new Set([...PROPOSE_OUTCOMES, ...EXECUTE_OUTCOMES])].sort()).toStrictEqual([...OUTCOMES].sort());
    expect(EXECUTE_OUTCOMES).not.toContain('proposed');
    expect(PROPOSE_OUTCOMES).not.toContain('completed');
  });
});

describe('the exit states, the use cases and the operations', () => {
  it('has the six exit states', () => {
    expect([...EXIT_STATES]).toStrictEqual(['Completed', 'Rejected', 'Expired', 'Cancelled', 'Escalated', 'Failed']);
  });

  it('has the three use cases', () => {
    expect([...USE_CASES]).toStrictEqual(['inventory-reorder', 'prior-authorization', 'bid-evaluation']);
  });

  it('has the two operations', () => {
    expect([...OPERATIONS]).toStrictEqual(['propose', 'execute']);
  });
});

describe('the types', () => {
  it('follow the lists', () => {
    expectTypeOf<ErrorCode>().toEqualTypeOf<keyof typeof ERROR_STATUS>();
    expectTypeOf<RefusalCode>().toEqualTypeOf<(typeof REFUSAL_CODES)[number]>();
    expectTypeOf<RefusalCode>().toExtend<ErrorCode>();
    expectTypeOf<Outcome>().toEqualTypeOf<ProposeOutcome | ExecuteOutcome>();
    expectTypeOf<ExecuteOutcome>().toEqualTypeOf<(typeof EXECUTE_OUTCOMES)[number]>();
    expectTypeOf<ExitState>().toEqualTypeOf<(typeof EXIT_STATES)[number]>();
    expectTypeOf<UseCase>().toEqualTypeOf<'inventory-reorder' | 'prior-authorization' | 'bid-evaluation'>();
    expectTypeOf<Operation>().toEqualTypeOf<'propose' | 'execute'>();
    expectTypeOf<'approval_revoked'>().toExtend<RefusalCode>();
    expectTypeOf<'busy'>().not.toExtend<RefusalCode>();
  });

  it('give an error body its code and its message', () => {
    const body: ErrorBody = { error: 'approval_expired', message: 'the approval ended' };
    expect(body.error).toBe('approval_expired');
    // @ts-expect-error a code that the protocol does not have
    const wrong: ErrorBody = { error: 'not_a_code', message: 'x' };
    expect(wrong.message).toBe('x');
  });
});
