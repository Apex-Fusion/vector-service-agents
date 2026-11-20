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
//   - No hire starts when the time of the run is over. A decision reads the clock before it hires. With the deadline of the run past, or less than HIRE_MIN_MS away, the result is
//     `inference_failed` with the reason `llm_out_of_time`, and nothing is posted. A hire that started late would choose a supplier and Post, the supplier would claim, and the hire would end as
//     out of time with its lock held until the deadline of the escrow. The check is made when the decision starts. A decision that waits in the lane of the key and gets its turn after the
//     deadline is not covered here: the hire kit checks that when the lane gives the turn.
//   - A paid hire is always in the failure. The Accept pays the supplier, and what fails after it does not undo that: the record of the hire cannot be recorded (the supplier writes its receipt), the
//     answer cannot be read, or the ledger of the caller throws. Every failure after an Accept says in its detail that the escrow was paid, and it has a `delivery`: the complete sub-job, or as much
//     of it as can be recorded. Every failure after a Post has the escrow and the stage (see src/decision/result.ts).
//   - The prompt holds the input as data in one marked block (src/decision/prompt.ts). This lowers the risk that the input misleads the model, and it does not remove it.
//
// What a decision costs and locks. The Post locks the price and both bonds of the advert, raised to the floor of the escrow, and the fee of the Post and the fee of the Accept come from the wallet
// of the key. An Accept pays the supplier the price and the supplier bond, and the buyer bond returns. hire-kit accepts an answer that passed the eight checks BEFORE this function reads it, so an
// answer that is not usable (`model_output_invalid`) costs the same as one that is. A hire that failed leaves its escrow with the janitor of the key: it reclaims an Open or Claimed escrow after its
// deadline. A Submitted escrow that was not accepted cannot be reclaimed, and its supplier may release it, and then it takes the price and both bonds.
//
// The messages of hire-kit can hold words of a supplier, so no message of the kit reaches a detail. A detail holds the code of the hire, its stage and its escrow, and never the prompt, the input,
// the answer, a member name that the model, the input or the supplier wrote, or a secret key.
import { hireModel } from '@vsa/hire-kit';
import type { HireFacts, HireLedger, Hired, ModelAnswer, ModelDeps, ModelErrors, ModelRequest, PayingKey } from '@vsa/hire-kit';
import { accepted, parseOutputRef, refused, type JsonValue, type OutputRef, type ProtocolResult } from '../protocol/index.ts';
import { readAnswer } from './answer.ts';
import { LLM_MAX_PRICE_SETTING, checkLimits, type ModelLimits } from './limits.ts';
import { buildPrompt } from './prompt.ts';
import type { DecideResult, DecisionFailure, DecisionFailureCode } from './result.ts';
import { checkSpec, type ChoiceParser, type DecisionSpec } from './spec.ts';
import { subJobOf, unrecordedOf } from './subjob.ts';

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

/**
 * The least time before the deadline of the run with which a decision starts its hire: 60 seconds. A hire needs the Post, the Claim and the work of the supplier, the eight checks and the Accept.
 * A hire that starts with less time left ends as out of time, with its escrow locked until the deadline of the escrow, so `decide` does not start it.
 */
export const HIRE_MIN_MS = 60_000;

/**
 * The time from now to the deadline of the run, in milliseconds: negative when the deadline is past. A clock that throws or does not give a finite number, and a deadline that is not a number,
 * are a refusal with their own reason: the time is not known, and an unknown time is never "enough time".
 */
function timeLeft(ports: Pick<ModelDeps, 'clock' | 'deadlineMs'>): ProtocolResult<number, 'bad_deps'> {
  const { clock, deadlineMs } = ports;
  if (typeof clock !== 'function' || typeof deadlineMs !== 'number' || Number.isNaN(deadlineMs)) return refused('bad_deps', 'the clock of the decision is not a function, or its deadline is not a number: nothing was hired');
  let now: unknown;
  try {
    now = clock();
  } catch {
    return refused('bad_deps', 'the clock of the decision cannot be read: nothing was hired');
  }
  return typeof now === 'number' && Number.isFinite(now) ? accepted(deadlineMs - now) : refused('bad_deps', 'the clock of the decision does not give a finite number: nothing was hired');
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

/** What the ledger of the caller was told during one hire: the escrow that the Post made, and whether an Accept was confirmed. */
interface Seen {
  escrow: OutputRef | null;
  paid: boolean;
}

/**
 * The escrow that hire-kit gives to the ledger with the Post. The type of the port names the two amounts only, and hire-kit passes the whole result of the Post, which holds the reference. When the
 * reference is not there, the failure says that the escrow is not known.
 */
function escrowOf(post: unknown): OutputRef | null {
  let ref: unknown;
  try {
    ref = typeof post === 'object' && post !== null && 'escrowRef' in post ? post.escrowRef : undefined;
  } catch {
    return null;
  }
  const parsed = parseOutputRef(ref, 'escrow_ref');
  return parsed.ok ? parsed.value : null;
}

/**
 * The ledger of the caller, with a note of what it is told. hire-kit calls `posted` when the Post is confirmed and `accepted` when the Accept is confirmed. When the ledger of the caller throws, the
 * hire ends with that error, and the error knows nothing of the escrow. So the note is the one place that knows which escrow was posted, and whether it was paid. The note is made before the call
 * goes on to the ledger of the caller, and the error of that ledger goes on to hire-kit as it is.
 */
function noting(ledger: HireLedger, seen: Seen): HireLedger {
  return {
    posted: (post) => {
      seen.escrow = escrowOf(post);
      ledger.posted(post);
    },
    accepted: (accept) => {
      seen.paid = true;
      ledger.accepted(accept);
    },
  };
}

/** What a detail says of a hire that was paid. An Accept that was sent and is not seen on the chain may still land, so the supplier may be paid. */
function paidText(escrow: OutputRef | null, how: 'confirmed' | 'pending'): string {
  const of = escrow === null ? 'its escrow' : `its escrow ${escrow}`;
  return how === 'confirmed' ? `${of} was accepted, so the supplier is paid` : `the Accept of ${of} was sent and the chain does not show it yet, so the supplier may be paid`;
}

/** The failure of a hire that ended with an error that hire-kit did not make: a port threw. The note of the ledger says how far the hire went. */
function threwFailure(decision: string, error: unknown, seen: Seen): DecisionFailure {
  const kind = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'a value that is not an error';
  const what = `the model hire for the decision ${decision} threw ${kind}`;
  if (seen.paid) {
    const delivery = unrecordedOf(undefined, 'confirmed', seen.escrow);
    return failure('inference_failed', 'hire_threw', `${what} after its Accept; ${paidText(seen.escrow, 'confirmed')}`, { delivery, escrow_ref: seen.escrow, stage: 'accept' });
  }
  if (seen.escrow !== null) {
    return failure('inference_failed', 'hire_threw', `${what} after its Post; its escrow ${seen.escrow} stays with the janitor of the key`, { escrow_ref: seen.escrow, stage: 'post' });
  }
  return failure('inference_failed', 'hire_threw', `${what}, and the state of its escrow is not known`);
}

/**
 * The decision, or the failure, for a hire that completed: its Accept was made, and the supplier is paid. Every failure here says so and carries the delivery: the complete sub-job when the record
 * can be recorded, and as much of it as can be recorded when it cannot.
 */
function afterHire<C extends JsonValue>(name: string, parse: ChoiceParser<C>, hired: Hired<ModelAnswer>, seen: Seen): DecideResult<C> {
  const how = hired.accepted;
  const subJob = subJobOf(hired.record);
  if (!subJob.ok) {
    const delivery = unrecordedOf(hired.record, how, seen.escrow);
    const detail = `the model hire for the decision ${name} ended with ${subJob.code} at accept; ${paidText(delivery.escrow_ref, how)}; ${subJob.detail}`;
    return failure('inference_failed', subJob.code, detail, { delivery, escrow_ref: delivery.escrow_ref, stage: 'accept' });
  }
  const escrow = subJob.value.escrow_ref;
  const answer = readAnswer(hired.value, parse);
  if (!answer.ok) {
    return failure(answer.code === 'model_output_invalid' ? 'model_output_invalid' : 'internal', answer.code, `${answer.detail}; ${paidText(escrow, how)}`, {
      delivery: { sub_job: subJob.value, accepted: how }, escrow_ref: escrow, stage: 'accept',
    });
  }
  return accepted({
    name,
    choice: answer.value.choice,
    reasoning: answer.value.reasoning,
    inference: { path: 'marketplace', sub_job: subJob.value, accepted: how },
  });
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
  const left = timeLeft(ports);
  if (!left.ok) return failure('internal', left.code, left.detail);
  if (left.value < HIRE_MIN_MS) {
    return failure('inference_failed', 'llm_out_of_time', `the model hire for the decision ${name} was not started, because the deadline of the run is past or less than ${HIRE_MIN_MS / 1000} seconds away; nothing was locked for it`);
  }

  const request: ModelRequest = {
    input: prompt.value,
    label: name,
    allowlist: limits.value.allowlist,
    maxPriceLovelace: limits.value.maxPriceLovelace,
    maxSupplierBondLovelace: limits.value.maxSupplierBondLovelace,
    maxBuyerBondLovelace: limits.value.maxBuyerBondLovelace,
    ceilingSetting: LLM_MAX_PRICE_SETTING,
  };
  const seen: Seen = { escrow: null, paid: false };
  let hired: Hired<ModelAnswer>;
  try {
    hired = await hireModel(key, { ...ports, ledger: noting(ports.ledger, seen) }, request, ERRORS);
  } catch (error) {
    if (error instanceof HireEnded) return hireFailure(name, error);
    // Something that hire-kit did not turn into its own error: a port threw. It is a failure and never a pass, and it says how far the hire went.
    return threwFailure(name, error, seen);
  }
  return afterHire(name, parse, hired, seen);
}
