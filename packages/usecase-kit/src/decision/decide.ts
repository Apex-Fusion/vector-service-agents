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
//     answer cannot be read, the result of the hire has a wrong form, or the ledger of the caller throws. An Accept that was sent and is not seen on the chain may still land, so the supplier may be
//     paid also when the stranded store cannot be written for it. Every failure after an Accept says in its detail that the escrow was paid, or may be paid, and it has a `delivery`: the complete
//     sub-job, or as much of it as can be recorded. Every failure after a Post has the escrow and the stage (see src/decision/result.ts).
//   - `decide` always gives a typed result. It does not throw for a `deps` that is null or has a member that throws when it is read (`bad_limit`), for a clock that cannot be read (`bad_deps`), for a
//     hire that fails, for an answer that is wrong, for a result of the hire that has a wrong form, or for a parser that returns a promise (`bad_decision`). An async function as a parser is refused
//     before the hire, and so is a parser that cannot be read. A function that returns a promise is found when it runs, after the hire, and then the rejection of the promise is handled, so that none
//     stays unhandled (see src/decision/spec.ts for what a caller must hold to).
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
 * every model hire of the agent runs from. The four limits are required, and the caller reads them from its settings. A decision starts its hire only when the clock stands at least HIRE_MIN_MS
 * before the deadline of the run.
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

/**
 * The failure of a hire: the code of the hire as the reason, and what became of its escrow. A store that cannot be written at the stage `accept` is the one failure here after which the supplier may be
 * paid: the Accept was sent, it may still land, and the store could not be told. hire-kit does not hand over the record of the hire when it throws, so that delivery holds the escrow and nothing else.
 */
function hireFailure(decision: string, error: HireEnded): DecisionFailure {
  const { hopCode, facts } = error;
  const escrow = facts?.escrowRef ?? null;
  const at = facts === null ? '' : ` at ${facts.stage}`;
  const what = `the model hire for the decision ${decision} ended with ${hopCode}${at}`;
  if (hopCode === 'store_write_failed' && facts?.stage === 'accept') {
    // A Submitted escrow cannot be reclaimed, so no word here tells the operator to settle it by hand: if the Accept lands, the supplier is paid.
    const detail = `${what}; ${paidText(escrow, 'pending')}; the Accept may still land; the stranded store could not be written, so the janitor of the key does not know of the Accept`;
    return failure('store_write_failed', hopCode, detail, { delivery: unrecordedOf(undefined, 'pending', escrow), escrow_ref: escrow, stage: 'accept' });
  }
  let detail: string;
  if (escrow === null) detail = `${what}; nothing was locked for it`;
  else if (hopCode === 'store_write_failed') detail = `${what}; the stranded store could not be written, so settle its escrow ${escrow} by hand after its deadline`;
  else detail = `${what}; its escrow ${escrow} stays with the janitor of the key`;
  return failure(hopCode === 'store_write_failed' ? 'store_write_failed' : 'inference_failed', hopCode, detail, { escrow_ref: escrow, stage: facts?.stage ?? null });
}

/**
 * What `decide` knows of one hire: the escrow that the ledger of the caller was told of at the Post, and how far the Accept went. The note of the ledger sets `confirmed` when hire-kit tells the ledger that
 * the Accept was confirmed. `decide` sets `pending` for a hire that gave a result and did not tell it: the Accept was sent, and the chain does not show it yet. Null means that no Accept was made.
 */
interface Seen {
  escrow: OutputRef | null;
  accept: 'confirmed' | 'pending' | null;
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
 * hire ends with that error, and the error knows nothing of the escrow. So the note is the one place that knows which escrow was posted, and whether its Accept was confirmed. The note is made before the call
 * goes on to the ledger of the caller, and the error of that ledger goes on to hire-kit as it is.
 */
function noting(ledger: HireLedger, seen: Seen): HireLedger {
  return {
    posted: (post) => {
      seen.escrow = escrowOf(post);
      ledger.posted(post);
    },
    accepted: (accept) => {
      seen.accept = 'confirmed';
      ledger.accepted(accept);
    },
  };
}

/** What a detail says of a hire that was paid. An Accept that was sent and is not seen on the chain may still land, so the supplier may be paid. */
function paidText(escrow: OutputRef | null, how: 'confirmed' | 'pending'): string {
  const of = escrow === null ? 'its escrow' : `its escrow ${escrow}`;
  return how === 'confirmed' ? `${of} was accepted, so the supplier is paid` : `the Accept of ${of} was sent and the chain does not show it yet, so the supplier may be paid`;
}

/**
 * The failure of a hire that ended with an error that hire-kit did not make: a port threw, or the result of the hire could not be read. The note of the ledger says how far the hire went, and a hire
 * that was paid, or may be, says so.
 */
function threwFailure(decision: string, error: unknown, seen: Seen): DecisionFailure {
  const kind = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'a value that is not an error';
  const what = `the model hire for the decision ${decision} threw ${kind}`;
  if (seen.accept !== null) {
    const delivery = unrecordedOf(undefined, seen.accept, seen.escrow);
    return failure('inference_failed', 'hire_threw', `${what} after its Accept; ${paidText(seen.escrow, seen.accept)}`, { delivery, escrow_ref: seen.escrow, stage: 'accept' });
  }
  if (seen.escrow !== null) {
    return failure('inference_failed', 'hire_threw', `${what} after its Post; its escrow ${seen.escrow} stays with the janitor of the key`, { escrow_ref: seen.escrow, stage: 'post' });
  }
  return failure('inference_failed', 'hire_threw', `${what}, and the state of its escrow is not known`);
}

/**
 * The decision, or the failure, for a hire that completed: its Accept was made, and the supplier is paid, or may be. Every failure here says so and carries the delivery: the complete sub-job when the
 * record can be recorded, and as much of it as can be recorded when it cannot. A result of a wrong form throws here, and `decide` gives the failure for it.
 */
function afterHire<C extends JsonValue>(name: string, parse: ChoiceParser<C>, hired: Hired<ModelAnswer>, seen: Seen): DecideResult<C> {
  const how = hired.accepted;
  // The state of the Accept is one of two words, and it goes into the decision. Another value is a result of a wrong form, and it is never recorded.
  if (how !== 'confirmed' && how !== 'pending') throw new TypeError('the hire gave no state of its Accept');
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
 * Makes one decision. The result is `{ ok: true, value }` with the decision, or a failure (see src/decision/result.ts). It does not throw for a hire that fails, for an answer that is wrong, for
 * a limit that is wrong, for deps that cannot be read, for a parser that returns a promise or cannot be read, or for a result of the hire that has a wrong form. The decision holds the name of the
 * definition, the choice and the reasoning of the model, and the sub-job with its receipt, its eight checks and its Accept state.
 */
export async function decide<C extends JsonValue>(deps: DecisionDeps, spec: DecisionSpec<C>, input: JsonValue): Promise<DecideResult<C>> {
  // The deps, the limits, the definition and the input are read one time, as data, and nothing below reads them from the caller's objects again. A `deps` that is null, and a member that throws when it
  // is read, give a failure that names the limits: the limits are the first thing that a decision needs, and they cannot be proven without the deps.
  let key: PayingKey;
  let givenLimits: ModelLimits;
  let ports: Omit<DecisionDeps, 'key' | 'limits'>;
  try {
    ({ key, limits: givenLimits, ...ports } = deps);
  } catch {
    return failure('internal', 'bad_limit', 'the deps of the decision cannot be read, so its limits cannot be read: nothing was hired');
  }
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
  const seen: Seen = { escrow: null, accept: null };
  let hired: Hired<ModelAnswer>;
  try {
    hired = await hireModel(key, { ...ports, ledger: noting(ports.ledger, seen) }, request, ERRORS);
  } catch (error) {
    if (error instanceof HireEnded) return hireFailure(name, error);
    // Something that hire-kit did not turn into its own error: a port threw. It is a failure and never a pass, and it says how far the hire went.
    return threwFailure(name, error, seen);
  }
  try {
    return afterHire(name, parse, hired, seen);
  } catch (error) {
    // The result of the hire has a wrong form: a record that is null, or a member that throws when it is read. The hire kit gave a result, so its Accept was sent. The ledger is told when the Accept is
    // confirmed, so an Accept that it was not told of is not seen on the chain yet. The hire was paid, or may be, and the failure says so. It is a failure and never a pass.
    return threwFailure(name, error, { ...seen, accept: seen.accept ?? 'pending' });
  }
}
