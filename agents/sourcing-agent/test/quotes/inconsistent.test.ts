// agents/sourcing-agent/test/quotes/inconsistent.test.ts: a hire that ends in a way that the decision of the fan-out did not make. In each test the hire kit asks another decision than the one of the fan-out, so the fan-out
// learns nothing from its own decision. A hire that was accepted with no acceptance of the model on record is not a quote, and a quote that was refused with a no that the model never gave files no challenge. Each form has
// its twin.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcceptDecision } from '@vsa/hire-kit';
import type * as Buyer from '@vsa/usecase-kit/buyer';
import type { HireDeps, HireInput, HireStep } from '@vsa/usecase-kit/buyer';
import { BRAVO, acceptDecision, bidderOf, priced, quoteText } from './support.ts';
import { cleanWorlds, footprint, hired, words, world } from './world.ts';

/** The decision that a test puts in place of the decision of the fan-out. `null` leaves the decision of the fan-out. */
const swap = vi.hoisted(() => ({ decide: null as (() => AcceptDecision) | null }));

vi.mock('@vsa/usecase-kit/buyer', async (importOriginal) => {
  const real = await importOriginal<typeof Buyer>();
  return {
    ...real,
    hireCounterparty: (deps: HireDeps, input: HireInput): Promise<HireStep> => real.hireCounterparty(deps, swap.decide === null ? input : { ...input, decide: swap.decide }),
  };
});

afterEach(() => {
  swap.decide = null;
  cleanWorlds();
});

describe('a hire that the decision of the fan-out did not end', () => {
  it('is not a quote when the hire was accepted with no acceptance of the model on record: excluded failed inconsistent_outcome, and the record says that the Accept was made', async () => {
    swap.decide = () => ({ accept: true });
    const w = await world();
    const result = await w.run(w.input({ invited: [bidderOf(BRAVO)] }));
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed inconsistent_outcome']);
    expect(hired(result.outcomes, 0)).toMatchObject({ decision: null, challenge: null, record: { paid_from_vault: true, accepted: 'confirmed' } });
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, asked: 0, challenges: 0, rechecked: 1 });
    expect(result.stopped).toBeNull();
  });

  it('files no challenge for a no that the model never gave: excluded failed inconsistent_outcome', async () => {
    swap.decide = () => ({ accept: false, reason: 'declined_by_model' });
    const w = await world();
    w.desks.bravo.answer = () => quoteText(BRAVO, priced('SYR-10ML', 30));
    const result = await w.run(w.input({ invited: [bidderOf(BRAVO)] }));
    expect(result.outcomes.map(words)).toStrictEqual(['excluded failed inconsistent_outcome']);
    expect(hired(result.outcomes, 0).record.accepted).toBe('no');
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, asked: 0, challenges: 0, rechecked: 1 });
  });

  it('is inconsistent_outcome for a reason that is not one of the reasons of the decision, and for a code of a check that the decision never gave', async () => {
    for (const reason of ['the quote looks wrong to me', 'quote_invalid', 'decision_failed']) {
      swap.decide = () => ({ accept: false, reason });
      const w = await world();
      const result = await w.run(w.input({ invited: [bidderOf(BRAVO)] }));
      expect(result.outcomes.map(words)).toStrictEqual(['excluded failed inconsistent_outcome']);
      expect(result.stopped).toBeNull();
      expect(footprint(w).challenges).toBe(0);
    }
  });

  it('twin: with the decision of the fan-out in place, the same documents give a challenge when the model says no, and a quote when it says yes', async () => {
    const no = await world();
    no.desks.bravo.answer = () => quoteText(BRAVO, priced('SYR-10ML', 30));
    const declined = await no.run(no.input({ invited: [bidderOf(BRAVO)] }));
    expect(declined.outcomes.map(words)).toStrictEqual(['excluded disputed none']);
    expect(hired(declined.outcomes, 0).decision).toStrictEqual(acceptDecision(false, ['SYR-10ML']));
    expect(footprint(no).challenges).toBe(1);
    const yes = await world();
    expect((await yes.run(yes.input({ invited: [bidderOf(BRAVO)] }))).outcomes.map(words)).toStrictEqual(['accepted']);
  });
});
