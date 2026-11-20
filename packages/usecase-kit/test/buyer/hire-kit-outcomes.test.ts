// packages/usecase-kit/test/buyer/hire-kit-outcomes.test.ts: what the flow does with an answer that the real hire kit does not give. The hire kit is the real one, except that a test can make one call of
// `hireAgent` answer with the outcome that the test names. The questions: does an outcome that does not hold together become a typed step and a result, and is it never a pass?
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as HireKit from '@vsa/hire-kit';

vi.mock('@vsa/hire-kit', async (importOriginal) => {
  const real = await importOriginal<typeof HireKit>();
  return { ...real, hireAgent: vi.fn(real.hireAgent) };
});
import { hireAgent } from '@vsa/hire-kit';
import type { AgentOutcome } from '@vsa/hire-kit';
import { LLM_ADVERT_REF } from '@vsa/hire-kit/testing';
import { INCONSISTENT_OUTCOME, VAULT_REASON_MISSING, settledResult } from '@vsa/usecase-kit/buyer';
import { AGENT_ADVERT_REF, cleanWorlds, expectKind, go, pieces, words, world } from './support.ts';

afterEach(() => { vi.restoreAllMocks(); cleanWorlds(); });

/** The next call of `hireAgent` pays nothing and answers with `outcome`. */
const answers = (outcome: unknown): void => { vi.mocked(hireAgent).mockImplementationOnce(async () => outcome as AgentOutcome); };

type Completed = Extract<AgentOutcome, { outcome: 'completed' }>;

/** The next call of `hireAgent` runs the real hire kit: the Pay, the send, the checks and the Accept happen. It answers with the outcome that `change` makes of the real one. */
const changes = (change: (outcome: Completed) => unknown): void => {
  vi.mocked(hireAgent).mockImplementationOnce(async (key, deps, request, errors) => {
    const kit = await vi.importActual<typeof HireKit>('@vsa/hire-kit');
    const outcome = await kit.hireAgent(key, deps, request, errors);
    if (outcome.outcome !== 'completed') throw new Error('the hire of the test did not complete');
    return change(outcome) as AgentOutcome;
  });
};

describe('a completed outcome that does not hold together', () => {
  it('is a failed step and not a pass, although the real hire was paid and accepted: an outcome for another advert than the document names', async () => {
    const w = await world();
    changes((outcome) => ({ ...outcome, advertRef: LLM_ADVERT_REF }));
    const step = expectKind(await go(w), 'failed');
    expect([step.reason, step.handoff?.advert_ref, step.handoff?.accepted]).toStrictEqual([INCONSISTENT_OUTCOME, LLM_ADVERT_REF, null]);
    // The money moved: the Pay was made and the Accept was confirmed. The step keeps the escrow, so that the money is not lost from the record.
    expect(await w.m.chain.escrowState(step.handoff?.escrow_ref ?? '')).toBe('spent');
    expect(step.vault_ref).not.toBeNull();
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'failed', reason: INCONSISTENT_OUTCOME, exit_state: 'Failed' });
  });

  it('keeps the escrow in the step when the record of the outcome is missing, and when the receipt and the signature are hollow', async () => {
    for (const change of [
      (outcome: Completed) => ({ ...outcome, record: undefined }),
      (outcome: Completed) => ({ ...outcome, record: { ...outcome.record, receipt: {}, receipt_signature: '' } }),
    ]) {
      const w = await world();
      changes(change);
      const step = expectKind(await go(w), 'failed');
      expect(step.reason).toBe(INCONSISTENT_OUTCOME);
      expect(step.handoff).toMatchObject({ advert_ref: AGENT_ADVERT_REF, accepted: null, receipt: null });
      expect(await w.m.chain.escrowState(step.handoff?.escrow_ref ?? '')).toBe('spent');
    }
  });

  it('is a failed step and not a pass when the hire kit says that the wallet paid: the flow hires from the Live vault, so the step keeps the escrow, says that no Accept is known, and says that the vault did not pay', async () => {
    const w = await world();
    changes((outcome) => ({ ...outcome, paidFrom: 'wallet' }));
    const step = expectKind(await go(w), 'failed');
    expect([step.reason, step.handoff?.paid_from_vault, step.handoff?.accepted, step.handoff?.receipt]).toStrictEqual([INCONSISTENT_OUTCOME, false, null, null]);
    // The money moved: the Pay was made and the Accept was confirmed. The step keeps the escrow, so that the money is not lost from the record.
    expect(await w.m.chain.escrowState(step.handoff?.escrow_ref ?? '')).toBe('spent');
    expect(step.vault_ref).not.toBeNull();
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'failed', reason: INCONSISTENT_OUTCOME, exit_state: 'Failed' });
    // The twin: the outcome that the real hire kit gives, which says that the vault paid, is completed.
    const twin = await world();
    changes((outcome) => outcome);
    expect(expectKind(await go(twin), 'completed').handoff).toMatchObject({ paid_from_vault: true, accepted: 'confirmed' });
  });

  it('is a failed step and not a pass when the receipt is not the receipt of this hire: it names another agent than the counterparty of the document, no agent, or another advert than the advert of the document', async () => {
    const receiptOf = (outcome: Completed): Record<string, unknown> => ({ ...outcome.record.receipt });
    const withReceipt = (outcome: Completed, receipt: Record<string, unknown>): unknown => ({ ...outcome, record: { ...outcome.record, receipt } });
    const NOT_THIS_HIRE: Array<[string, (outcome: Completed) => unknown]> = [
      ['another agent', (outcome) => withReceipt(outcome, { ...receiptOf(outcome), agent_did: `did:vector:${'cc'.repeat(32)}` })],
      ['no agent', (outcome) => withReceipt(outcome, Object.fromEntries(Object.entries(receiptOf(outcome)).filter(([member]) => member !== 'agent_did')))],
      ['another advert', (outcome) => withReceipt(outcome, { ...receiptOf(outcome), advert_ref: LLM_ADVERT_REF })],
    ];
    for (const [name, change] of NOT_THIS_HIRE) {
      const w = await world();
      changes(change);
      const step = expectKind(await go(w), 'failed');
      expect([step.reason, step.handoff?.accepted, step.handoff?.receipt], name).toStrictEqual([INCONSISTENT_OUTCOME, null, null]);
      // The money moved: the Pay was made and the Accept was confirmed. The step keeps the escrow, so that the money is not lost from the record.
      expect(await w.m.chain.escrowState(step.handoff?.escrow_ref ?? ''), name).toBe('spent');
      expect(settledResult(step, pieces()), name).toMatchObject({ outcome: 'failed', reason: INCONSISTENT_OUTCOME, exit_state: 'Failed' });
    }
    // The twins: the receipt that the real hire kit gives, and the same receipt with the advert of the document in it, are completed.
    for (const change of [(outcome: Completed) => outcome, (outcome: Completed) => withReceipt(outcome, { ...receiptOf(outcome), advert_ref: AGENT_ADVERT_REF })]) {
      const twin = await world();
      changes(change);
      expect(expectKind(await go(twin), 'completed').handoff).toMatchObject({ paid_from_vault: true, accepted: 'confirmed' });
    }
  });

  it('twin: the outcome that the real hire kit gives is completed', async () => {
    const w = await world();
    changes((outcome) => outcome);
    expect(words(await go(w))).toBe('completed');
  });
});

describe('an outcome that the hire kit does not give', () => {
  it('is a failed step with inconsistent_outcome when the outcome is null or undefined, and the result is made: the flow does not throw', async () => {
    for (const outcome of [null, undefined]) {
      const w = await world();
      answers(outcome);
      const step = expectKind(await go(w), 'failed');
      expect([step.reason, step.handoff], String(outcome)).toStrictEqual([INCONSISTENT_OUTCOME, null]);
      expect(settledResult(step, pieces())).toMatchObject({ outcome: 'failed', reason: INCONSISTENT_OUTCOME, exit_state: 'Failed' });
      // The delegation is read again only after a refused Pay.
      expect(w.reads.calls.delegation).toBe(1);
    }
    // The twin: when no outcome is made up, the real hire kit answers and the hire completes.
    expect(words(await go(await world()))).toBe('completed');
  });

  it('is a failed step with inconsistent_outcome when the outcome member cannot be read: the flow does not reject, it reads no delegation, and the error is the cause of the step', async () => {
    const boom = new Error('a member that throws');
    const w = await world();
    answers({ get outcome(): string { throw boom; }, advertRef: AGENT_ADVERT_REF, message: 'kit words' });
    const step = expectKind(await go(w), 'failed');
    expect([step.reason, step.cause, step.handoff]).toStrictEqual([INCONSISTENT_OUTCOME, boom, null]);
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'failed', reason: INCONSISTENT_OUTCOME, exit_state: 'Failed' });
    // The delegation is read again only after a refused Pay, and an outcome that cannot be read is not known to be one.
    expect(w.reads.calls.delegation).toBe(1);
    // The twin: the same kind of outcome with a member that can be read, and that says vault_refused, is a refused Pay, and the delegation is read again.
    const twin = await world();
    answers({ get outcome(): string { return 'vault_refused'; }, advertRef: AGENT_ADVERT_REF, message: 'kit words', refusal: { kind: 'ledger', evaluationError: '3010 script error', validators: [], body: 'a1b2', attempt: undefined } });
    expect(expectKind(await go(twin), 'vault_refused')).toMatchObject({ reason: '3010 script error', delegation: 'live' });
    expect(twin.reads.calls.delegation).toBe(2);
  });

  it('is a vault_refused step with a fixed reason when the node gave no evaluation error, and the result is made', async () => {
    const w = await world();
    answers({ outcome: 'vault_refused', advertRef: AGENT_ADVERT_REF, message: 'kit words', refusal: { kind: 'ledger', evaluationError: '', validators: [], body: 'a1b2', attempt: undefined } });
    const step = expectKind(await go(w), 'vault_refused');
    expect([step.refusal, step.reason, step.delegation]).toStrictEqual(['ledger', VAULT_REASON_MISSING, 'live']);
    expect(settledResult(step, pieces())).toMatchObject({ outcome: 'vault_refused', reason: VAULT_REASON_MISSING, exit_state: 'Failed' });
    expect(w.reads.calls.delegation).toBe(2);
    // The twin: an evaluation error of the node is the reason.
    const twin = await world();
    answers({ outcome: 'vault_refused', advertRef: AGENT_ADVERT_REF, message: 'kit words', refusal: { kind: 'ledger', evaluationError: '3010 script error', validators: [], body: 'a1b2', attempt: undefined } });
    expect(expectKind(await go(twin), 'vault_refused').reason).toBe('3010 script error');
  });
});
