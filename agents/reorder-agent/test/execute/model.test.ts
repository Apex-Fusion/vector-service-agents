// agents/reorder-agent/test/execute/model.test.ts: the decision port made of the decision folder of the kit, over the stub model supplier of the hire kit. The model is hired from the service key, it
// answers one JSON object, and the decision that `decide` records goes into the result as the model gave it, with its signed receipt checked. A model hire that fails gives a failed decision, and the
// job accepts nothing and files no challenge. This is the wiring that the service makes, in a test.
import { afterEach, describe, expect, it } from 'vitest';
import { ALLOWLIST, INDEXER, LLM_ADVERT, T0 } from '@vsa/hire-kit/testing';
import type { HireLedger } from '@vsa/hire-kit';
import { decide } from '@vsa/usecase-kit/decision';
import type { ChoiceParser, DecisionDeps, DecisionSpec } from '@vsa/usecase-kit/decision';
import { accepted, checkMembers, isPlainObject, refused } from '@vsa/usecase-kit/protocol';
import type { ExecuteDeps, OrderField } from '../../src/execute/index.ts';
import { cleanWorlds, footprint, hireOf, words, world } from './world.ts';
import type { World } from './world.ts';

afterEach(() => { cleanWorlds(); });

/** The choice of `accept_delivery`. It is a type alias, so that it is JSON data. */
type Choice = { accept: boolean; mismatch: OrderField[] };

const FIELDS: readonly unknown[] = ['sku', 'lot', 'quantity'];
const parseChoice: ChoiceParser<Choice> = (given) => {
  if (!isPlainObject(given)) return refused('bad_shape', 'choice must be a JSON object');
  const members = checkMembers(given, 'choice', ['accept', 'mismatch']);
  if (members !== null) return members;
  if (typeof given.accept !== 'boolean' || !Array.isArray(given.mismatch) || !given.mismatch.every((field) => FIELDS.includes(field))) return refused('bad_shape', 'choice has the wrong shape');
  return accepted(given as Choice);
};
const SPEC: DecisionSpec<Choice> = {
  name: 'accept_delivery',
  instruction: 'You decide whether to accept a delivery. The data holds the SKU, the lot and the quantity of an order and of its confirmation. "choice" has the members "accept" (true when the three agree) and '
    + '"mismatch" (the list of the fields that differ).',
  parse: parseChoice,
};

/** What the model supplier answers: one JSON object with the reasoning and the choice. */
const said = (choice: Choice): string => JSON.stringify({ reasoning: 'The fields were compared.', choice });

/** The deps of the job with a decision port made of `decide`, and the model hires that its ledger booked. */
async function withModel(w: World): Promise<{ deps: ExecuteDeps; booked: { posted: number; accepted: number } }> {
  const key = await w.serviceKey();
  const booked = { posted: 0, accepted: 0 };
  const ledger: HireLedger = { posted: () => { booked.posted += 1; }, accepted: () => { booked.accepted += 1; } };
  const model: DecisionDeps = {
    key, limits: { allowlist: ALLOWLIST, maxPriceLovelace: LLM_ADVERT.price_lovelace, maxSupplierBondLovelace: LLM_ADVERT.supplier_bond_lovelace, maxBuyerBondLovelace: LLM_ADVERT.buyer_bond_lovelace },
    clock: () => w.m.clock.now, sleep: async (ms) => { w.m.clock.now += ms; }, deadlineMs: T0 + 1_000_000, fetchImpl: w.m.fetchImpl, indexerUrl: INDEXER, ledger,
  };
  const deps: ExecuteDeps = {
    ...w.deps,
    acceptDelivery: async (order, confirmation) => {
      const result = await decide(model, SPEC, {
        purchase_order: { sku: order.sku, lot: order.lot, quantity: order.quantity }, confirmation: { sku: confirmation.sku, lot: confirmation.lot, quantity: confirmation.quantity },
      });
      return result.ok ? { ok: true, decision: result.value, choice: result.value.choice } : { ok: false, code: result.reason };
    },
  };
  return { deps, booked };
}

describe('the decision of the real decision folder', () => {
  it('is the decision of a model that was hired from the service key: its record, with the receipt and the eight checks, goes into the result, and the delivery is accepted', async () => {
    const w = await world();
    const { deps, booked } = await withModel(w);
    w.m.llm.answer = said({ accept: true, mismatch: [] });
    const result = await w.run(w.request(), T0, deps);
    expect(words(result)).toBe('completed none Completed');
    expect(result.decisions).toHaveLength(1);
    const [decision] = result.decisions;
    expect(decision).toMatchObject({ name: 'accept_delivery', choice: { accept: true, mismatch: [] }, reasoning: 'The fields were compared.', inference: { path: 'marketplace', accepted: 'confirmed' } });
    expect(decision?.inference.sub_job).toMatchObject({ capability_id: 'llm.text.generate.v1', verification: { signature_valid: true, response_hash_matches: true } });
    expect(booked).toStrictEqual({ posted: 1, accepted: 1 });
    expect(w.m.llm.sends).toHaveLength(1);
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 1, challenges: 0, asked: 0 });
  });

  it('files the challenge with the decision of the model when the model says no: the result holds the decision, and the challenge names the confirmation', async () => {
    const w = await world();
    const { deps } = await withModel(w);
    w.answer({ lot: 'lot-large' });
    w.m.llm.answer = said({ accept: false, mismatch: ['lot'] });
    const result = await w.run(w.request(), T0, deps);
    expect(words(result)).toBe('disputed none Escalated');
    expect(result.decisions[0]).toMatchObject({ name: 'accept_delivery', choice: { accept: false, mismatch: ['lot'] }, inference: { path: 'marketplace', accepted: 'confirmed' } });
    expect(hireOf(result)).toMatchObject({ accepted: 'no' });
    expect(w.dispute.calls).toHaveLength(1);
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 0, challenges: 1, asked: 0 });
  });

  it('is failed with decision_failed and no challenge when the model hire fails: nothing is accepted, and no decision is recorded', async () => {
    const w = await world();
    const { deps } = await withModel(w);
    w.m.llm.steps = ['running', { fail: 'upstream_failure', submitted: false }];
    const result = await w.run(w.request(), T0, deps);
    expect(words(result)).toBe('failed decision_failed Failed');
    expect(result).toMatchObject({ decisions: [], challenge: null, writes: [] });
    expect(await w.m.chain.escrowState(hireOf(result).escrow_ref)).toBe('Submitted');
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 0, challenges: 0, asked: 0 });
  });

  it('is failed with decision_failed and no challenge when the model answers text that is not the choice that it was asked for: the model hire was paid, and no decision is recorded', async () => {
    const w = await world();
    const { deps, booked } = await withModel(w);
    w.m.llm.answer = 'I accept the delivery.';
    const result = await w.run(w.request(), T0, deps);
    expect(words(result)).toBe('failed decision_failed Failed');
    expect(result.decisions).toStrictEqual([]);
    expect(booked).toStrictEqual({ posted: 1, accepted: 1 });
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 0, challenges: 0, asked: 0 });
  });
});
