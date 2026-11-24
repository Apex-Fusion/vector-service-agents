// agents/sourcing-agent/test/execute/refusals.test.ts: a sourcing record that refuses the ranking. The record checks the approval (the eight codes of the checks) and the status of the top-ranked supplier, and it checks the
// credential of the call. A refusal is `refused_by_system` with the code of the record as the reason, and the exit state is the one that `exitStateOf` gives for that code. Nothing is written, and the result holds no hire
// and no decision. The words of the record never reach the result or the log. Each refusal has its twin that is accepted.
import { describe, expect, it } from 'vitest';
import { exitStateOf } from '@vsa/usecase-kit/protocol';
import { ONE_CALL, footprint, jsonResponse, words, world } from './world.ts';

const WORDS = 'words of the record';

/** Status, code and exit state of each refusal that the sourcing record gives. */
const REFUSALS: Array<[number, string, string]> = [
  [403, 'approval_not_found', 'Rejected'],
  [403, 'approval_wrong_type', 'Rejected'],
  [403, 'approval_wrong_subject', 'Rejected'],
  [403, 'approval_wrong_issuer', 'Rejected'],
  [403, 'approval_revoked', 'Rejected'],
  [403, 'approval_expired', 'Expired'],
  [403, 'approval_issuer_invalid', 'Rejected'],
  // A counterparty that refuses with this code also challenges the claim of the sender, and its refusal is Escalated. A record is no counterparty: its refusal is Rejected.
  [403, 'approval_digest_mismatch', 'Rejected'],
  [403, 'delegation_ended', 'Cancelled'],
  [403, 'supplier_not_active', 'Rejected'],
  [403, 'not_covered', 'Rejected'],
  [403, 'chain_too_deep', 'Rejected'],
  [403, 'actor_not_active', 'Rejected'],
  [401, 'token_invalid', 'Rejected'],
  [409, 'tenant_changed', 'Rejected'],
  [400, 'bad_request', 'Rejected'],
  [404, 'tenant_not_found', 'Rejected'],
];

describe('a sourcing record that refuses the ranking', () => {
  for (const [status, code, state] of REFUSALS) {
    it(`is refused_by_system with ${code} (${status}) and the exit state ${state}: nothing is written, and the words of the record are not kept`, async () => {
      const w = world();
      w.record.answer = () => jsonResponse(status, { error: code, message: WORDS });
      const result = await w.run();
      expect(words(result)).toBe(`refused_by_system ${code} ${state}`);
      expect(result.exit_state).toBe(exitStateOf({ outcome: 'refused_by_system', reason: code, challenge_filed: false, delegation_ended: false }));
      expect(result).toMatchObject({ schema: 'vector.usecase.result.v1', use_case: 'bid-evaluation', handoff: null, writes: [], decisions: [], challenge: null, fault_mode: '' });
      expect(footprint(w)).toStrictEqual(ONE_CALL);
      expect(w.record.written).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain(WORDS);
      expect(w.log.join('\n')).not.toContain(WORDS);
    });
  }

  it('twin: a record that writes the ranking gives completed with the one write', async () => {
    const w = world();
    const result = await w.run();
    expect(words(result)).toBe('completed none Completed');
    expect(result.writes).toHaveLength(1);
    expect(result.reason).toBeNull();
  });

  it('names the code of the record in the log, with the status', async () => {
    const w = world();
    w.record.answer = () => jsonResponse(403, { error: 'supplier_not_active', message: WORDS });
    await w.run();
    expect(w.log.join('\n')).toContain('supplier_not_active');
    expect(w.log.join('\n')).toContain('403');
  });
});

describe('a refusal of the record that names no code', () => {
  it('has the reason refusal_without_code when the body holds no code: a 403 with a message only', async () => {
    const w = world();
    w.record.answer = () => jsonResponse(403, { message: WORDS });
    const result = await w.run();
    expect(words(result)).toBe('refused_by_system refusal_without_code Rejected');
    expect(footprint(w)).toStrictEqual(ONE_CALL);
  });

  it('has the reason refusal_without_code when the code is a sentence that does not start as a code, so that the reason is always a code of the form of a code', async () => {
    for (const error of ['Not Covered!', ' approval_expired', '', 7, null]) {
      const w = world();
      w.record.answer = () => jsonResponse(403, { error, message: WORDS });
      expect(words(await w.run())).toBe('refused_by_system refusal_without_code Rejected');
    }
  });

  it('keeps the leading run of a code that a sentence follows, and never the sentence', async () => {
    const w = world();
    w.record.answer = () => jsonResponse(403, { error: 'approval_expired: the approval ended', message: WORDS });
    const result = await w.run();
    expect(words(result)).toBe('refused_by_system approval_expired Expired');
    expect(JSON.stringify(result)).not.toContain('the approval ended');
  });
});
