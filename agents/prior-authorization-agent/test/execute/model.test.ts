// agents/prior-authorization-agent/test/execute/model.test.ts: the decision port made of the decision folder of the kit, over the stub model supplier of the hire kit. The model is hired from the service key, it answers
// one JSON object, and the decision that `decide` records goes into the result as the model gave it, with its signed receipt checked. A model hire that fails gives a failed decision, and the job accepts nothing and
// files no challenge. This is the wiring that the service makes, in a test. The prompt of the decision is a test text here: the real one belongs to the model folder of the agent.
import { afterEach, describe, expect, it } from 'vitest';
import { ALLOWLIST, INDEXER, LLM_ADVERT, T0 } from '@vsa/hire-kit/testing';
import type { HireLedger } from '@vsa/hire-kit';
import { decide } from '@vsa/usecase-kit/decision';
import type { ChoiceParser, DecisionDeps, DecisionSpec } from '@vsa/usecase-kit/decision';
import { accepted, checkMembers, isPlainObject, refused } from '@vsa/usecase-kit/protocol';
import type { ExecuteDeps, MismatchName } from '../../src/execute/index.ts';
import { cleanWorlds, footprint, hireOf, words, world } from './world.ts';
import type { World } from './world.ts';

afterEach(() => { cleanWorlds(); });

const OTHER_HASH = '00'.repeat(32);

/** The choice of `accept_delivery`. It is a type alias, so that it is JSON data. */
type Choice = { accept: boolean; mismatch: MismatchName[] };

const parseChoice: ChoiceParser<Choice> = (given) => {
  if (!isPlainObject(given)) return refused('bad_shape', 'choice must be a JSON object');
  const members = checkMembers(given, 'choice', ['accept', 'mismatch']);
  if (members !== null) return members;
  if (typeof given.accept !== 'boolean' || !Array.isArray(given.mismatch) || given.mismatch.length > 1 || !given.mismatch.every((name) => name === 'request_sha256')) {
    return refused('bad_shape', 'choice has the wrong shape');
  }
  return accepted(given as Choice);
};
const SPEC: DecisionSpec<Choice> = {
  name: 'accept_delivery',
  instruction: 'You decide whether to accept a delivery. The data holds the number and the hash of a request that was sent ("sent"), and the number and the hash that an intake record names ("record"). "choice" has the members '
    + '"accept" (true when the two hashes are equal) and "mismatch" (the list with the name "request_sha256" when they differ).',
  parse: parseChoice,
};

/** What the model supplier answers: one JSON object with the reasoning and the choice. */
const said = (choice: Choice): string => JSON.stringify({ reasoning: 'The hashes were compared.', choice });

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
    acceptDelivery: async (sent, received) => {
      const result = await decide(model, SPEC, {
        sent: { request_number: sent.request_number, request_sha256: sent.request_sha256 },
        record: { request_number: received.request_number, request_sha256: received.request_sha256 },
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
    expect(decision).toMatchObject({ name: 'accept_delivery', choice: { accept: true, mismatch: [] }, reasoning: 'The hashes were compared.', inference: { path: 'marketplace', accepted: 'confirmed' } });
    expect(decision?.inference.sub_job).toMatchObject({ capability_id: 'llm.text.generate.v1', verification: { signature_valid: true, response_hash_matches: true } });
    expect(booked).toStrictEqual({ posted: 1, accepted: 1 });
    expect(w.m.llm.sends).toHaveLength(1);
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 1, challenges: 0, asked: 0 });
  });

  it('files the challenge with the decision of the model when the model says no: the result holds the decision, and the challenge names the intake record', async () => {
    const w = await world();
    const { deps } = await withModel(w);
    w.answer({ request_sha256: OTHER_HASH });
    w.m.llm.answer = said({ accept: false, mismatch: ['request_sha256'] });
    const result = await w.run(w.request(), T0, deps);
    expect(words(result)).toBe('disputed none Escalated');
    expect(result.decisions[0]).toMatchObject({ name: 'accept_delivery', choice: { accept: false, mismatch: ['request_sha256'] }, inference: { path: 'marketplace', accepted: 'confirmed' } });
    expect(hireOf(result)).toMatchObject({ accepted: 'no' });
    expect(w.dispute.calls).toHaveLength(1);
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 0, challenges: 1, asked: 0 });
  });

  it('is failed with decision_failed and no challenge when the model hire fails: nothing is accepted, and no decision is recorded', async () => {
    const w = await world();
    const { deps } = await withModel(w);
    w.m.llm.steps = ['running', { fail: 'upstream_failure', submitted: false }];
    const result = await w.run(w.request(), T0, deps);
    expect(words(result)).toBe('failed decision_failed Failed');
    expect(result).toMatchObject({ decisions: [], challenge: null, writes: [] });
    expect(await w.m.chain.escrowState(hireOf(result).escrow_ref)).toBe('Submitted');
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 0, challenges: 0, asked: 0 });
  });

  it('is failed with decision_failed and no challenge when the model answers text that is not the choice that it was asked for: the model hire was paid, and no decision is recorded', async () => {
    const w = await world();
    const { deps, booked } = await withModel(w);
    w.m.llm.answer = 'I accept the delivery.';
    const result = await w.run(w.request(), T0, deps);
    expect(words(result)).toBe('failed decision_failed Failed');
    expect(result.decisions).toStrictEqual([]);
    expect(booked).toStrictEqual({ posted: 1, accepted: 1 });
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 0, challenges: 0, asked: 0 });
  });

  it('does not ask the model for a record that fails a check in code: no model hire is made, and nothing is paid to the model supplier', async () => {
    const w = await world();
    const { deps, booked } = await withModel(w);
    w.answer({ request_number: 'run1-2' });
    const result = await w.run(w.request(), T0, deps);
    expect(words(result)).toBe('failed intake_not_for_request Failed');
    expect(booked).toStrictEqual({ posted: 0, accepted: 0 });
    expect(w.m.llm.sends).toHaveLength(0);
  });

  it('is failed with decision_failed when the model accepts a record that names another hash than the hash of the request that was sent: the model hire was paid, nothing is accepted, nothing is written and nothing is challenged', async () => {
    const w = await world();
    const { deps, booked } = await withModel(w);
    w.answer({ request_sha256: OTHER_HASH });
    w.m.llm.answer = said({ accept: true, mismatch: [] });
    const result = await w.run(w.request(), T0, deps);
    expect(words(result)).toBe('failed decision_failed Failed');
    expect(result).toMatchObject({ decisions: [], challenge: null, writes: [] });
    expect(hireOf(result)).toMatchObject({ accepted: 'no', paid_from_vault: true });
    expect(await w.m.chain.escrowState(hireOf(result).escrow_ref)).toBe('Submitted');
    expect(booked).toStrictEqual({ posted: 1, accepted: 1 });
    expect(w.booked.accepted).toBe(0);
    expect(w.store.calls).toHaveLength(0);
    expect(w.tokens).toHaveLength(0);
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 0, challenges: 0, asked: 0 });
    // The twin: the same model that accepts a record that names the right hash is heard.
    const right = await world();
    const again = await withModel(right);
    right.m.llm.answer = said({ accept: true, mismatch: [] });
    expect(words(await right.run(right.request(), T0, again.deps))).toBe('completed none Completed');
  });
});
