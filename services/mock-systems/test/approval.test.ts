// The decision on the answer of the approval check. Only `ok: true`, the boolean, passes. Each of the eight refusals of the check is a 403 with its own code. An answer of another shape,
// a code that the check does not have, a check that throws and a check that does not answer in its time limit are refusals too (503): an error never turns into a pass.
import { describe, expect, it } from 'vitest';
import { APPROVAL_TIMEOUT_MS, decideApproval } from '../src/approval.ts';
import type { ApprovalAnswer, ApprovalCheck, ApprovalInput } from '../src/approval.ts';
import { APPROVAL_CODES } from '../src/errors.ts';

const INPUT: ApprovalInput = {
  sender: `did:vector:${'a1'.repeat(32)}`, delegation: 'd1'.repeat(32), attestation: '07'.repeat(32), issuerDid: `did:vector:${'b2'.repeat(32)}`, document: { schema: 'x' }, salt: 'f6'.repeat(32), atMs: 1_000,
};
const giving = (answer: unknown): ApprovalCheck => async () => answer as ApprovalAnswer;

describe('decideApproval', () => {
  it('passes for ok: true, and gives the check the input that it was given', async () => {
    const seen: ApprovalInput[] = [];
    const decided = await decideApproval(async (input) => { seen.push(input); return { ok: true }; }, INPUT);
    expect(decided.ok).toBe(true);
    expect(seen).toEqual([INPUT]);
  });
  it('passes for ok: true with more facts in the answer', async () => {
    expect((await decideApproval(giving({ ok: true, issuer: 'x', validUntil: 5 }), INPUT)).ok).toBe(true);
  });
  it.each(APPROVAL_CODES)('refuses with %s, 403, and the rule of that code, with the words of the check', async (code) => {
    const decided = await decideApproval(giving({ ok: false, code, detail: 'the words of the check' }), INPUT);
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.refusal).toEqual({ status: 403, code, rule: `approval.${code}`, message: 'the words of the check' });
  });
  it('cuts a very long detail', async () => {
    const decided = await decideApproval(giving({ ok: false, code: 'approval_expired', detail: 'x'.repeat(1000) }), INPUT);
    if (decided.ok) throw new Error('passed');
    expect(decided.refusal.message).toHaveLength(303);
  });
  it.each([
    ['ok as a text', { ok: 'true' }],
    ['ok as the number 1', { ok: 1 }],
    ['ok as an object', { ok: {} }],
    ['no ok', {}],
    ['undefined', undefined],
    ['null', null],
    ['a text', 'ok'],
    ['true', true],
    ['a refusal with no detail', { ok: false, code: 'approval_expired' }],
    ['a refusal with a detail that is no text', { ok: false, code: 'approval_expired', detail: 5 }],
    ['a refusal with no code', { ok: false, detail: 'x' }],
    ['a code that the check does not have', { ok: false, code: 'approval_great', detail: 'x' }],
    ['the code of another refusal of the service', { ok: false, code: 'token_invalid', detail: 'x' }],
    ['ok: false and a code that is a pass word', { ok: false, code: 'ok', detail: 'x' }],
  ])('refuses with 503 for an answer of another shape: %s', async (_name, answer) => {
    const decided = await decideApproval(giving(answer), INPUT);
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect([decided.refusal.status, decided.refusal.code, decided.refusal.rule]).toEqual([503, 'approval_unavailable', 'approval.bad_answer']);
  });
  it('refuses with 503 for a check that throws, and says why', async () => {
    const decided = await decideApproval(async () => { throw new Error('the ledger is down'); }, INPUT);
    expect(decided.ok).toBe(false);
    if (!decided.ok) {
      expect([decided.refusal.status, decided.refusal.code, decided.refusal.rule]).toEqual([503, 'approval_unavailable', 'approval.failed']);
      expect(decided.refusal.message).toContain('the ledger is down');
    }
  });
  it('refuses with 503 for a check that gives a promise that fails', async () => {
    const decided = await decideApproval(() => Promise.reject(new Error('late failure')), INPUT);
    expect(decided.ok).toBe(false);
  });
  it('refuses with 503 and the rule approval.timeout for a check that does not answer in the limit, and says the limit', async () => {
    const decided = await decideApproval(() => new Promise<ApprovalAnswer>(() => undefined), INPUT, 20);
    expect(decided.ok).toBe(false);
    if (!decided.ok) {
      expect([decided.refusal.status, decided.refusal.code, decided.refusal.rule]).toEqual([503, 'approval_unavailable', 'approval.timeout']);
      expect(decided.refusal.message).toContain('20 ms');
    }
  });
  it('uses a check that answers inside the limit: its pass passes, and its refusal is its refusal', async () => {
    expect((await decideApproval(giving({ ok: true }), INPUT, 5_000)).ok).toBe(true);
    const decided = await decideApproval(giving({ ok: false, code: 'approval_revoked', detail: 'x' }), INPUT, 5_000);
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.refusal.code).toBe('approval_revoked');
  });
  it('uses the limit of 30 seconds when it is given none', () => {
    expect(APPROVAL_TIMEOUT_MS).toBe(30_000);
  });
  it('a pass that comes after the limit changes nothing: the decision is the refusal that was made', async () => {
    let answerLate: (answer: ApprovalAnswer) => void = () => undefined;
    const decided = await decideApproval(() => new Promise<ApprovalAnswer>((resolve) => { answerLate = resolve; }), INPUT, 20);
    answerLate({ ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(decided).toMatchObject({ ok: false, refusal: { status: 503, rule: 'approval.timeout' } });
  });
  it('a failure that comes after the limit raises no error: nobody waits for the check any more', async () => {
    const unhandled: unknown[] = [];
    const watch = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', watch);
    try {
      let failLate: (error: Error) => void = () => undefined;
      const decided = await decideApproval(() => new Promise<ApprovalAnswer>((_resolve, reject) => { failLate = reject; }), INPUT, 20);
      failLate(new Error('late failure'));
      // One turn of the event loop: Node reports an unhandled rejection after it.
      await new Promise((resolve) => setImmediate(resolve));
      expect(decided).toMatchObject({ ok: false, refusal: { rule: 'approval.timeout' } });
    } finally {
      process.off('unhandledRejection', watch);
    }
    expect(unhandled).toEqual([]);
  });
});
