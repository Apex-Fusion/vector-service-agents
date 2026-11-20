// packages/usecase-kit/src/decision/decide.ts
// One decision is one hire of a model. `decide(deps, spec, input)` builds the prompt from the fixed text of the decision and its input, hires a model from the service key with `hireModel` of
// hire-kit, reads the answer with the parser of the decision, and returns the `Decision` of the protocol. A buyer-side agent decides (`reorder`, `accept_delivery`, the scores of use case 3), and
// a counterparty decides (`availability`, `completeness`). Both use this function.
//
// The rules of this file:
//   - A decision is recorded only when the model gave it. The result `{ ok: true }` has exactly one place: the end of this function. Every other way out is a failure, and a failure holds no decision.
//     The choice is the model's. Nothing here changes, clamps or computes it again (see src/decision/spec.ts and src/decision/answer.ts).
//   - A hire is made only inside the limits. The four limits are required parameters, checked before anything else. A limit that is missing or has the wrong type is a refusal, and nothing is hired.
//     This code never fills in a missing limit and never passes `null` by itself. A model that is not on the allowlist, a price above the ceiling and a bond above its limit are never hired: hire-kit
//     refuses the advert on the chain, before the Post.
//   - There is no second try. One decision is one call of `hireModel`: one supplier, one Post, one job. A hire that fails ends the decision with its code as the reason. An answer that is not
//     usable is `model_output_invalid`. Nothing hires again, nothing tries another supplier, and nothing falls back to a provider outside the marketplace.
//   - Decisions run one after the other. `hireModel` runs each hire in the lane of the service key, so two decisions that start at one time never post two escrows at one time. The second decision
//     waits until the first has ended, however it ended.
//   - The prompt holds the input as data in one marked block (src/decision/prompt.ts). This lowers the risk that the input misleads the model, and it does not remove it.
//
// What a decision costs and locks. The Post locks the price and both bonds of the advert, raised to the floor of the escrow, and the fee of the Post and the fee of the Accept come from the wallet
// of the key. An Accept pays the supplier the price and the supplier bond, and the buyer bond returns. hire-kit accepts an answer that passed the eight checks BEFORE this function reads it, so an
// answer that is not usable (`model_output_invalid`) costs the same as one that is. A hire that failed leaves its escrow with the janitor of the key: it reclaims an Open or Claimed escrow after its
// deadline. A Submitted escrow that was not accepted cannot be reclaimed, and its supplier may release it, and then it takes the price and both bonds.
//
// The messages of hire-kit can hold words of a supplier, so no message of the kit reaches a detail. A detail holds the code of the hire, its stage and its escrow, and never the prompt, the input,
// the answer or a key.
import { hireModel } from '@vsa/hire-kit';
import type { HireFacts, Hired, ModelAnswer, ModelDeps, ModelErrors, ModelRequest, PayingKey } from '@vsa/hire-kit';
import { accepted, type JsonValue } from '../protocol/index.ts';
import { readAnswer } from './answer.ts';
import { LLM_MAX_PRICE_SETTING, checkLimits, type ModelLimits } from './limits.ts';
import { buildPrompt } from './prompt.ts';
import type { DecideResult, DecisionFailure, DecisionFailureCode } from './result.ts';
import { checkSpec, type DecisionSpec } from './spec.ts';
import { subJobOf } from './subjob.ts';

/**
 * What a decision needs. The ports are the ones of a hire: the fetch, the clock, the sleep, the deadline of the run, the ledger and the indexer. The key is the service key, the one key that
 * every model hire of the agent runs from. The four limits are required, and the caller reads them from its settings.
 */
export interface DecisionDeps extends ModelDeps {
  /** The service key. Its lane runs one hire at a time, so decisions run one after the other. */
  readonly key: PayingKey;
  /** The allowlist, the price ceiling and the limits of the two bonds. */
  readonly limits: ModelLimits;
}

/** The error that the factory below makes for hire-kit: the code of the hire and what the kit knew. It keeps no message of the kit. */
class HireEnded extends Error {
  readonly hopCode: string;
  readonly facts: HireFacts | null;
  constructor(hopCode: string, facts: HireFacts | null) {
    super(hopCode);
    this.name = 'HireEnded';
    this.hopCode = hopCode;
    this.facts = facts;
  }
}

/** The codes of hire-kit: `llm_<what>` for a failure of the hire, `llm_out_of_time` for the deadline, `store_write_failed`, and `llm_supplier_unavailable` when no advert passes the limits. */
const ERRORS: ModelErrors<HireEnded> = {
  failure: (kind, what, _message, facts) => new HireEnded(`${kind}_${what}`, facts),
  deadline: (_doing, facts) => new HireEnded('llm_out_of_time', facts),
  storeWrite: (_message, facts) => new HireEnded('store_write_failed', facts),
  unavailable: () => new HireEnded('llm_supplier_unavailable', null),
};

function failure(code: DecisionFailureCode, reason: string, detail: string, rest: Partial<Pick<DecisionFailure, 'delivery' | 'escrow_ref' | 'stage'>> = {}): DecisionFailure {
  return { ok: false, code, reason, detail, delivery: rest.delivery ?? null, escrow_ref: rest.escrow_ref ?? null, stage: rest.stage ?? null };
}

/** The failure of a hire: the code of the hire as the reason, and what became of its escrow. */
function hireFailure(decision: string, error: HireEnded): DecisionFailure {
  const { hopCode, facts } = error;
  const escrow = facts?.escrowRef ?? null;
  const at = facts === null ? '' : ` at ${facts.stage}`;
  const what = `the model hire for the decision ${decision} ended with ${hopCode}${at}`;
  let detail: string;
  if (escrow === null) detail = `${what}; nothing was locked for it`;
  else if (hopCode === 'store_write_failed') detail = `${what}; the stranded store could not be written, so settle its escrow ${escrow} by hand after its deadline`;
  else detail = `${what}; its escrow ${escrow} stays with the janitor of the key`;
  return failure(hopCode === 'store_write_failed' ? 'store_write_failed' : 'inference_failed', hopCode, detail, { escrow_ref: escrow, stage: facts?.stage ?? null });
}

/**
 * Makes one decision. The result is `{ ok: true, value }` with the decision, or a failure (see src/decision/result.ts). It does not throw for a hire that fails, for an answer that is wrong or for
 * a limit that is wrong. The decision holds the name of the definition, the choice and the reasoning of the model, and the sub-job with its receipt, its eight checks and its Accept state.
 */
export async function decide<C extends JsonValue>(deps: DecisionDeps, spec: DecisionSpec<C>, input: JsonValue): Promise<DecideResult<C>> {
  // The limits, the definition and the input are read one time, as data, and nothing below reads them from the caller's objects again.
  const { key, limits: givenLimits, ...ports } = deps;
  const limits = checkLimits(givenLimits);
  if (!limits.ok) return failure('internal', limits.code, limits.detail);
  const definition = checkSpec(spec);
  if (!definition.ok) return failure('internal', definition.code, definition.detail);
  const prompt = buildPrompt(definition.value, input);
  if (!prompt.ok) return failure('internal', prompt.code, prompt.detail);
  const { name, parse } = definition.value;

  const request: ModelRequest = {
    input: prompt.value,
    label: name,
    allowlist: limits.value.allowlist,
    maxPriceLovelace: limits.value.maxPriceLovelace,
    maxSupplierBondLovelace: limits.value.maxSupplierBondLovelace,
    maxBuyerBondLovelace: limits.value.maxBuyerBondLovelace,
    ceilingSetting: LLM_MAX_PRICE_SETTING,
  };
  let hired: Hired<ModelAnswer>;
  try {
    hired = await hireModel(key, ports, request, ERRORS);
  } catch (error) {
    if (error instanceof HireEnded) return hireFailure(name, error);
    // Something that hire-kit did not turn into its own error: a port threw. The state of the hire is not known, so it is a failure and never a pass.
    const kind = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'a value that is not an error';
    return failure('inference_failed', 'hire_threw', `the model hire for the decision ${name} threw ${kind}, and the state of its escrow is not known`);
  }

  const subJob = subJobOf(hired.record);
  if (!subJob.ok) return failure('inference_failed', subJob.code, subJob.detail);
  const answer = readAnswer(hired.value, parse);
  if (!answer.ok) {
    return failure(answer.code === 'choice_changed' ? 'internal' : 'model_output_invalid', answer.code, answer.detail, {
      delivery: { sub_job: subJob.value, accepted: hired.accepted }, escrow_ref: subJob.value.escrow_ref,
    });
  }
  return accepted({
    name,
    choice: answer.value.choice,
    reasoning: answer.value.reasoning,
    inference: { path: 'marketplace', sub_job: subJob.value, accepted: hired.accepted },
  });
}
