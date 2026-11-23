// agents/reorder-agent/test/execute/inconsistent.test.ts: a hire that ends in a way that the decision on the delivery did not make. In each test the hire kit asks another decision than the one of the job,
// so the job learns nothing from its own decision. A hire that was accepted with no acceptance of the model on record does not write the order, and a delivery that was refused with a no that the model never
// gave files no challenge. Each form has its twin.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcceptDecision } from '@vsa/hire-kit';
import type * as Buyer from '@vsa/usecase-kit/buyer';
import type { HireDeps, HireInput, HireStep } from '@vsa/usecase-kit/buyer';
import { cleanWorlds, footprint, hireOf, words, world } from './world.ts';

/** The decision that a test puts in place of the decision of the job. `null` leaves the decision of the job. */
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

describe('a hire that the decision of the job did not end', () => {
  it('does not write the order for a hire that was accepted with no acceptance of the model on record: failed with inconsistent_outcome, and the record says that the Accept was made', async () => {
    swap.decide = () => ({ accept: true });
    const w = await world();
    const result = await w.run();
    expect(words(result)).toBe('failed inconsistent_outcome Failed');
    expect(result).toMatchObject({ decisions: [], writes: [], challenge: null });
    expect(hireOf(result)).toMatchObject({ paid_from_vault: true, accepted: 'confirmed' });
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 0, challenges: 0, asked: 0 });
    expect(w.tokens).toHaveLength(0);
  });

  it('files no challenge for a no that the model never gave: failed with inconsistent_outcome', async () => {
    swap.decide = () => ({ accept: false, reason: 'declined_by_model' });
    const w = await world();
    w.answer({ lot: 'lot-large' });
    const result = await w.run();
    expect(words(result)).toBe('failed inconsistent_outcome Failed');
    expect(result).toMatchObject({ decisions: [], writes: [], challenge: null });
    expect(hireOf(result)).toMatchObject({ accepted: 'no' });
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 0, challenges: 0, asked: 0 });
  });

  it('files no challenge for a reason that is not one of the four of the decision: failed with inconsistent_outcome', async () => {
    swap.decide = () => ({ accept: false, reason: 'the lot looks wrong to me' });
    const w = await world();
    w.answer({ lot: 'lot-large' });
    const result = await w.run();
    expect(words(result)).toBe('failed inconsistent_outcome Failed');
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 0, challenges: 0, asked: 0 });
  });

  it('twin: with the decision of the job in place, the same documents give a challenge when the model says no, and the order when it says yes', async () => {
    const no = await world();
    no.answer({ lot: 'lot-large' });
    expect(words(await no.run())).toBe('disputed none Escalated');
    expect(footprint(no).challenges).toBe(1);
    const yes = await world();
    expect(words(await yes.run())).toBe('completed none Completed');
  });
});
