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
import { INCONSISTENT_OUTCOME, VAULT_REASON_MISSING, settledResult } from '@vsa/usecase-kit/buyer';
import { AGENT_ADVERT_REF, cleanWorlds, expectKind, go, pieces, words, world } from './support.ts';

afterEach(() => { vi.restoreAllMocks(); cleanWorlds(); });

/** The next call of `hireAgent` pays nothing and answers with `outcome`. */
const answers = (outcome: unknown): void => { vi.mocked(hireAgent).mockImplementationOnce(async () => outcome as AgentOutcome); };

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
