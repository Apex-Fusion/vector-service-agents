// agents/sourcing-agent/src/scoring/scoring.ts
// The scorers of the Sourcing Agent (use case 3, supplier bid evaluation). One scorer reads the vendor master for each accepted quote, through a sub-delegation, and takes the decision `score` for it. The three
// scorers start together. Nothing is paid here except the decisions, and a decision is a model hire through a port.
//
// One scorer, in this order. A failure of a step is a typed code, and no step reads success from a text.
//   1. Before anything is sent: the caller still waits (`aborted`), and `deadline_ms` leaves `SCORER_NEED_MS` (`deadline`). The same two checks run again inside the hook before the Delegate is sent, after the
//      turn of the wallet queue: a scorer that waited long for its turn may have no time left, and then it sends nothing.
//   2. The sub-delegation, through `withSubDelegation` of the kit: one action (`vendor.read`) on one resource, one hop below the delegation of the hirer, no value, made by the live delegation key of the agent
//      and the delegation key of the scorer. The three Delegates go through the one queue of the wallet, one at a time, and their waits for 30 confirmations overlap. The sub-delegation is ENDED in every case:
//      after the score, after a refusal, after a failure, after a throw and after a timeout.
//   3. The token of the scorer under the sub-delegation (two links: the scorer under the agent), the call `GET /vendors`, the strict parse of the list, and the entry of the bidder (by its verified organisation).
//   4. The decision `score`, once, through the port. The signal of the caller is read before it and never passed into it. The answer is built into a score only when the choice EQUALS the choice that the
//      decision records, and from the checked copy: no code changes what the model chose. The fault `invert_scores` is applied to the choice of the first scorer after that check, and the recorded decision
//      stays as it is.
//
// Any failure of a scorer ends the scoring with its code, and the code of the FIRST failed scorer, in the order of the subjects, is the code of the result. Every other scorer still runs to its end, so its
// sub-delegation is ended, and every decision that a scorer made is in the result: it was paid for.
//
// The records of a sub-delegation. The hook first reads the list of left sub-delegations: an entry with the id of this sub-delegation means that an earlier Delegate of the same key is on its way, because the
// builder takes the id from the largest output of the wallet, and the run then sends nothing and records nothing. The read has a bound of its own inside the bound of the hook, so that a late answer never finds
// a run that ended. One damaged file of the list does not block the run, but a damaged file with the name of this sub-delegation does. Each stop writes one line with its cause to the log. Else the hook adds the
// id to the set of the sub-delegations that a run uses, and it stores the entry in the list, both BEFORE the Delegate is sent. After the run, an end that is `ended` or `not_made` removes the entry, and an end
// that is `not_ended` stores the entry again with the Undelegate that was tried. Then the id leaves the set, on every path. So the janitor never ends the sub-delegation of a run that still waits, and a run that
// did not end its sub-delegation leaves an entry for the janitor. A failure to update the list after the run changes no result: the entry that the hook stored stays, and the janitor ends it or drops it.
//
// Time. A scorer needs `SCORER_NEED_MS` left when its Delegate is sent: the least wait for 30 confirmations, the job, and the end step. Every wait of a scorer is trimmed to `deadline_ms`. The update of the list
// after the run has a bound of its own, because the end of a sub-delegation must be recorded also when the time is out.
import {
  DEFAULT_CONFIRMATION_WAIT_MS, DEFAULT_END_TIMEOUT_MS, DEFAULT_POLL_MS, DEFAULT_STEP_TIMEOUT_MS, SUB_DELEGATION_FAILURES, askWhileTooYoung, callWithToken, requestSubagentToken, tokenTarget, withSubDelegation, within,
} from '@vsa/usecase-kit/access';
import type { RouteTokenResult, SubDelegationEnd, SubDelegationHandle, TokenTarget } from '@vsa/usecase-kit/access';
import { parseComponents, parseScoreValue } from '@vsa/usecase-kit/bids';
import { DamagedLeftEntriesError } from '@vsa/usecase-kit/janitor';
import { canonicalJson, checkMembers, isPlainObject } from '@vsa/usecase-kit/protocol';
import type { Decision, DelegationId, JsonValue } from '@vsa/usecase-kit/protocol';
import { scoreFaultOf } from './fault.ts';
import type { ScoreFault } from './fault.ts';
import type { LeftEntry, ScoreChoice, ScoreSubject, ScoredQuote, Scorer, ScoringDeps, ScoringInput, ScoringResult } from './ports.ts';
import { parseVendors, vendorFor } from './vendors.ts';

/** How long a sub-delegation of a scorer stays valid, in milliseconds. The end step ends it earlier. The kit takes 300,000 to 86,400,000. */
export const SUB_DELEGATION_VALID_MS = 1_800_000;
/** The longest time of the job under a sub-delegation: the token, the read of the vendor master, and the decision, which may wait behind the decisions of the other two scorers. */
export const SCORER_JOB_TIMEOUT_MS = 420_000;
/** The least wait that makes sense for 30 confirmations: they take about two minutes, so a shorter wait would end before the gateway can issue a token. */
export const MIN_CONFIRMATION_WAIT_MS = 180_000;
/** The longest time of the end step of a sub-delegation: the default of the access folder. */
export const END_TIMEOUT_MS = DEFAULT_END_TIMEOUT_MS;
/**
 * The time that must be left when a Delegate is sent: the least wait for 30 confirmations, the job, and the end step. The Reorder Agent applies the same rule to one sub-delegation. The caller adds the time of
 * its own steps after the scoring to this number.
 */
export const SCORER_NEED_MS = MIN_CONFIRMATION_WAIT_MS + SCORER_JOB_TIMEOUT_MS + END_TIMEOUT_MS;

/** The longest time that the scorer keeps asking for a token while the gateway says that the delegation is too young: the gateway reads the ledger by itself, and it may see the 30 confirmations later than this agent. */
const TOKEN_PATIENCE_MS = 120_000;
/** The bound of one update of the list of left sub-delegations after the run. */
const BOOKKEEPING_TIMEOUT_MS = DEFAULT_STEP_TIMEOUT_MS;
/** The longest wait for the read of the list inside the hook before the send. The hook has the bound `DEFAULT_STEP_TIMEOUT_MS` in the access folder, so this wait is a third of it: a read that answers later never finds a run that is still waiting. */
const LIST_TIMEOUT_MS = DEFAULT_STEP_TIMEOUT_MS / 3;
/** The most subjects of one scoring: one for each scorer. */
const MAX_SUBJECTS = 3;

/** The codes of a failed scoring that this folder writes itself. The code of a failed decision passes through from the port, and it is not in this list. */
const OWN_FAILURES = [
  'deadline', 'aborted', 'vendors_refused', 'vendors_failed', 'vendors_invalid', 'scorer_token_failed', 'scorer_threw', 'scorer_timed_out', 'decision_mismatch', 'score_invalid', 'internal',
] as const;

/**
 * Every code that `runScoring` writes as the code of a failed scoring, except the code of a failed decision, which passes through from the port. A failure of a sub-delegation is `sub_delegation_` and the code
 * of the access folder. The page of the agent and its README hold their tables to this list.
 */
export const SCORING_FAILURES: readonly string[] = Object.freeze([...OWN_FAILURES, ...SUB_DELEGATION_FAILURES.map((code) => `sub_delegation_${code}`)]);

/** Why a scorer sends nothing: the caller hung up, or the time left is not enough. */
type Stop = 'aborted' | 'deadline';

/** What one scoring knows from its start: its deps, its input, the target of its calls, its deadline, the signal of the caller and the fault, which was read one time. */
interface Run {
  readonly deps: ScoringDeps;
  readonly input: ScoringInput;
  readonly target: TokenTarget;
  readonly deadline: number;
  readonly signal: AbortSignal | undefined;
  readonly fault: ScoreFault;
}

/** What one scorer gave: its score, or its code and the decision that it made before it failed, when it made one. */
type ScorerOutcome = { readonly ok: true; readonly scored: ScoredQuote } | { readonly ok: false; readonly code: string; readonly decision: Decision | null };

const failed = (code: string, decision: Decision | null = null): ScorerOutcome => ({ ok: false, code, decision });

/** A code with the form of a code: lower-case letters, digits and `_`, 64 characters at most. Any other text, such as the words of a model, becomes `internal`. */
const CODE_FORM = /^[a-z0-9_]{1,64}$/;
const codeOf = (code: unknown): string => (typeof code === 'string' && CODE_FORM.test(code) ? code : 'internal');

/** The name of an error for a log line. The message of an error is never logged: it can name a path or repeat a part of a request. */
const kindOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** Writes one line to the log of the deps. A log that throws changes no result: the line is lost, and the scoring goes on. */
function note(run: Run, line: string): void {
  try {
    run.deps.log(line);
  } catch {
    // The line is lost.
  }
}

/** True when a decision holds the sub-job that bought it, which `sub_jobs` of the result of the job lists. */
function isDecision(value: unknown): value is Decision {
  if (typeof value !== 'object' || value === null) return false;
  const inference: unknown = Reflect.get(value, 'inference');
  if (typeof inference !== 'object' || inference === null) return false;
  const subJob: unknown = Reflect.get(inference, 'sub_job');
  return typeof subJob === 'object' && subJob !== null;
}

/**
 * Why a scorer must not send at the time `now`, or null. The caller hung up (`aborted`), or `deadline_ms` leaves less than `SCORER_NEED_MS` (`deadline`). A clock or a deadline that is not a number counts as no
 * time left: a time that is not known is never enough time.
 */
function stopOf(run: Run, now: number): Stop | null {
  if (run.signal?.aborted === true) return 'aborted';
  return run.deadline - now >= SCORER_NEED_MS ? null : 'deadline';
}

/**
 * Updates the list of left sub-delegations after the run. An end that is `ended` or `not_made` removes the entry of the id that the hook stored. An end that is `not_ended` stores the entry with the Undelegate
 * that was tried. A failure changes no result: the entry that the hook stored stays, and the janitor reads the ledger and ends the sub-delegation or drops the entry.
 */
async function updateList(run: Run, id: DelegationId | null, end: SubDelegationEnd): Promise<void> {
  const { clock, leftSink } = run.deps;
  let write: () => Promise<void>;
  if (end.state === 'not_ended') {
    const entry: LeftEntry = { left: end.left, signer_key_hash: run.deps.agentKey.signer.keyHash };
    write = () => leftSink.put(entry);
  } else if (id !== null) {
    write = () => leftSink.remove(id);
  } else {
    return;
  }
  try {
    await within(clock, BOOKKEEPING_TIMEOUT_MS, write);
  } catch {
    // The entry of the hook stays. See the head of this file.
  }
}

/**
 * The check inside the hook before the send: the list of left sub-delegations must hold no entry with the id of this sub-delegation. It throws when an entry has this id, and when it cannot tell: the read fails,
 * gives no list, or does not answer within `LIST_TIMEOUT_MS`. Each throw has one line in the log with its cause. The read has a bound of its own inside the bound of the hook of the access folder, so that no
 * answer comes after the run gave up: a late answer would add the id to the set of the runs in use and store the entry of a Delegate that was never sent, and nothing would take them away. One damaged file of
 * the list does not block the scorer: the entries that could be read are checked. A damaged file with the name of this sub-delegation does, because it may hold the entry of an earlier Delegate with this id.
 */
async function checkFree(run: Run, number: number, id: DelegationId): Promise<void> {
  const { clock, leftSink } = run.deps;
  const head = `scoring: scorer ${number}: no Delegate was sent`;
  let held: readonly LeftEntry[] | null;
  try {
    const listed = await within(clock, LIST_TIMEOUT_MS, () => leftSink.list());
    held = listed.timedOut ? null : listed.value;
  } catch (error) {
    if (!(error instanceof DamagedLeftEntriesError)) {
      note(run, `${head}: the list of left sub-delegations cannot be read`);
      throw error;
    }
    if (error.damaged.some((damaged) => damaged.file === `${id}.json`)) {
      note(run, `${head} for the sub-delegation ${id}: a damaged file of the list has the name of this sub-delegation`);
      throw error;
    }
    held = error.entries;
  }
  if (held === null) {
    note(run, `${head}: the list of left sub-delegations did not answer within ${LIST_TIMEOUT_MS} ms`);
    throw new Error('the list of left sub-delegations did not answer in time');
  }
  const entries: unknown = held;
  if (!Array.isArray(entries)) {
    note(run, `${head}: the list of left sub-delegations cannot be read`);
    throw new Error('the list of left sub-delegations is not a list');
  }
  if (entries.some((entry: LeftEntry) => entry.left.id === id)) {
    note(run, `${head} for the sub-delegation ${id}: the list of left sub-delegations holds an entry with this id, so an earlier Delegate of this key may be on its way, and the janitor ends or drops that entry`);
    throw new Error('the list of left sub-delegations holds an entry with the id of this sub-delegation');
  }
}

/** The choice of the decision as a score: exactly the members `components` and `score`, the four components and the score each from 0 to 100. Null for any other choice. */
function scoreChoiceOf(value: JsonValue): ScoreChoice | null {
  if (!isPlainObject(value) || checkMembers(value, 'choice', ['components', 'score']) !== null) return null;
  const components = parseComponents(value.components, 'choice.components');
  const score = parseScoreValue(value.score, 'choice.score');
  return components.ok && score.ok ? { components: components.value, score: score.value } : null;
}

/**
 * The outcome of one answer of the decision `score`. A failed answer is its own code. A decision that holds no sub-job is `internal`. The choice must EQUAL the choice that the decision records (`decision_mismatch`
 * for any difference), and it must be a score (`score_invalid`): the checked copy of the recorded choice is what the result holds, and never an object of the port. The fault is applied to that copy, last:
 * the decision that the result holds is the one that the model made.
 */
function outcomeOf(run: Run, index: number, subject: ScoreSubject, answer: unknown): ScorerOutcome {
  if (typeof answer !== 'object' || answer === null) return failed('internal');
  const ok: unknown = Reflect.get(answer, 'ok');
  if (ok !== true) return failed(codeOf(Reflect.get(answer, 'code')));
  const made: unknown = Reflect.get(answer, 'decision');
  if (!isDecision(made)) return failed('internal');
  const given = canonicalJson(Reflect.get(answer, 'choice'), 'choice');
  const recorded = canonicalJson(made.choice, 'decision.choice');
  if (given.ok !== true || recorded.ok !== true || given.value !== recorded.value) return failed('decision_mismatch', made);
  // From here on the scorer uses the copy that it checked, and never an object of the port.
  const chosen: JsonValue = JSON.parse(given.value);
  const decision: Decision = { ...made, choice: chosen };
  const score = scoreChoiceOf(chosen);
  if (score === null) return failed('score_invalid', decision);
  return { ok: true, scored: { did: subject.did, decision, choice: run.fault(index, score) } };
}

/** The caller hung up before a step of the job started. */
class HungUp extends Error {}

/**
 * The job of one scorer under its sub-delegation: a token for the vendor route, the call `GET /vendors`, the parse of the list, the entry of the bidder, and the decision `score`. The gateway may need some time
 * to see the 30 confirmations, so a token request that gets `delegation_too_young` is asked again for the patience of the job, and never beyond `deadline_ms`. The call is made once. A job that ran past its time
 * makes no further request: the sub-delegation is ended by then. The signal of the caller is read before each token request, before the call and before the decision, and a hang-up gives `aborted`.
 */
async function scorerJob(run: Run, index: number, scorer: Scorer, subject: ScoreSubject, handle: SubDelegationHandle): Promise<ScorerOutcome> {
  const { deps, input } = run;
  const head = `scoring: scorer ${index + 1}`;
  const hungUp = (): boolean => run.signal?.aborted === true;
  const patienceMs = Math.min(TOKEN_PATIENCE_MS, Math.max(0, Math.floor(run.deadline - deps.clock.now())));
  let token: RouteTokenResult;
  try {
    token = await askWhileTooYoung(
      deps.clock,
      () => {
        if (hungUp()) throw new HungUp();
        if (handle.signal.aborted) throw new Error('the time of the job ended');
        return requestSubagentToken(deps.tokens, {
          target: run.target,
          subagent: { did: scorer.did, authenticationKey: scorer.authenticationKey, delegationKey: scorer.delegationKey },
          subDelegation: handle.id,
        });
      },
      { waitMs: patienceMs, pollMs: DEFAULT_POLL_MS },
    );
  } catch (error) {
    if (error instanceof HungUp) return failed('aborted');
    throw error;
  }
  if (token.ok !== true) {
    note(run, `${head}: the gateway gave no token: ${token.code} (status ${token.status})`);
    return failed('scorer_token_failed');
  }
  if (handle.signal.aborted) throw new Error('the time of the job ended');
  if (hungUp()) return failed('aborted');
  const read = await callWithToken(deps.calls, token.value, run.target);
  if (read.ok !== true) {
    if (read.code === 'refused_by_system') {
      note(run, `${head}: the vendor master refused the read: ${read.reason} (status ${read.status})`);
      return failed('vendors_refused');
    }
    note(run, `${head}: the read of the vendor master failed (status ${read.status ?? 'none'}${read.systemCode === null ? '' : `, code ${read.systemCode}`}, sent ${String(read.sent)})`);
    return failed('vendors_failed');
  }
  const vendors = parseVendors(read.body);
  if (!vendors.ok) {
    note(run, `${head}: the vendor list is not valid: ${vendors.detail}`);
    return failed('vendors_invalid');
  }
  // The decision is a paid hire. It starts only while the caller waits and the time of the job is not out, and the signal is never passed into it.
  if (handle.signal.aborted) throw new Error('the time of the job ended');
  if (hungUp()) return failed('aborted');
  const answer: unknown = await deps.score({ today: input.today, weights: input.weights, rfq: input.rfq, quote: subject.quote, file: subject.file, vendor: vendorFor(vendors.value, subject.organisation) });
  const outcome = outcomeOf(run, index, subject, answer);
  if (!outcome.ok) note(run, `${head}: the decision gave no score: ${outcome.code}`);
  return outcome;
}

/**
 * One scorer: the checks before anything is sent, the sub-delegation with its records, and the job. The id of the sub-delegation leaves the set of the runs in use on every path, after the list is up to date.
 * A throw of the code under the scorer is `internal`, and its line in the log names the error and never its message.
 */
async function runScorer(run: Run, index: number): Promise<ScorerOutcome> {
  const { deps, input } = run;
  const sent: { id: DelegationId | null } = { id: null };
  const flag: { stop: Stop | null } = { stop: null };
  const head = `scoring: scorer ${index + 1}`;
  try {
    const scorer = deps.scorers[index];
    const subject = input.subjects[index];
    if (scorer === undefined || subject === undefined) return failed('internal');
    // One read of the clock decides both: a scorer that passes the check has at least `MIN_CONFIRMATION_WAIT_MS` for the confirmations. The wait for the turn of the wallet, the Delegate and the 30
    // confirmations take what the budget says, and the job and the end step come after them, all inside `deadline_ms`.
    const now = deps.clock.now();
    const before = stopOf(run, now);
    if (before !== null) {
      note(run, `${head}: no Delegate was sent: ${before}`);
      return failed(before);
    }
    const left = Math.floor(run.deadline - now);
    const confirmationWaitMs = Math.min(DEFAULT_CONFIRMATION_WAIT_MS, left - SCORER_JOB_TIMEOUT_MS - END_TIMEOUT_MS);
    const result = await withSubDelegation(
      {
        ...deps.subDelegation,
        walletQueue: deps.agentKey.queue,
        beforeSend: async (reference) => {
          // The turn of the wallet may have come late, so the checks of the start are made again right before the send. The hook throws before this run takes the id: nothing is sent, this run records nothing, and
          // it removes nothing.
          const stop = stopOf(run, deps.clock.now());
          if (stop !== null) {
            flag.stop = stop;
            note(run, `${head}: no Delegate was sent for the sub-delegation ${reference.id}: ${stop}`);
            throw new Error(`no Delegate is sent: ${stop}`);
          }
          await checkFree(run, index + 1, reference.id);
          sent.id = reference.id;
          deps.inFlight.add(reference.id);
          await deps.leftSink.put({ left: reference, signer_key_hash: deps.agentKey.signer.keyHash });
        },
      },
      {
        target: run.target,
        parent: input.delegation,
        agent: { signer: deps.agentKey.signer, walletAddress: deps.agentKey.walletAddress },
        subagent: { did: scorer.did, signer: scorer.signer },
        validForMs: SUB_DELEGATION_VALID_MS,
      },
      { jobTimeoutMs: SCORER_JOB_TIMEOUT_MS, confirmationWaitMs, endTimeoutMs: END_TIMEOUT_MS },
      (handle) => scorerJob(run, index, scorer, subject, handle),
    );
    await updateList(run, sent.id, result.end);
    if (result.kind === 'returned') return result.value;
    if (result.kind === 'timed_out') {
      note(run, `${head}: the job did not end within ${SCORER_JOB_TIMEOUT_MS} ms`);
      return failed('scorer_timed_out');
    }
    if (result.kind === 'threw') {
      note(run, `${head}: the job threw an error of the kind ${kindOf(result.error)}`);
      return failed('scorer_threw');
    }
    // The hook gave the stop, and the kit read it as a journal that cannot be written: the flag tells the two apart.
    if (flag.stop !== null && result.failure.code === 'journal_failed') return failed(flag.stop);
    note(run, `${head}: the sub-delegation failed: ${result.failure.code}`);
    return failed(`sub_delegation_${result.failure.code}`);
  } catch (error) {
    note(run, `${head}: stopped in its own code: an error of the kind ${kindOf(error)}`);
    return failed('internal');
  } finally {
    if (sent.id !== null) deps.inFlight.delete(sent.id);
  }
}

/**
 * Scores the subjects of `input` with one scorer for each, in the order of the subjects, and gives one score for each, or the code of the first scorer that failed with every decision that a scorer made. A
 * sub-delegation that a scorer made is ended or recorded for the janitor before this function returns. `signal` aborts when the caller hangs up: no Delegate, no token request and no decision starts after
 * that, a sub-delegation that is made is ended, and a decision that was already paid for is kept. The switch of the fault is read one time, here.
 */
export async function runScoring(deps: ScoringDeps, input: ScoringInput, signal?: AbortSignal): Promise<ScoringResult> {
  const refused = (code: string): ScoringResult => ({ ok: false, code, decisions: [] });
  if (!Array.isArray(input.subjects) || input.subjects.length < 1 || input.subjects.length > MAX_SUBJECTS) return refused('internal');
  const target = tokenTarget(deps.calls.bases, input.tenant, 'vendors.list');
  if (target.ok !== true) return refused('internal');
  let fault: ScoreFault;
  try {
    fault = scoreFaultOf(deps.fault);
  } catch {
    return refused('internal');
  }
  const run: Run = { deps, input, target: target.value, deadline: deps.deadline_ms, signal, fault };
  const settled = await Promise.allSettled(input.subjects.map((_subject, index) => runScorer(run, index)));
  const outcomes = settled.map((one, index): ScorerOutcome => {
    if (one.status === 'fulfilled') return one.value;
    note(run, `scoring: scorer ${index + 1}: stopped in its own code: an error of the kind ${kindOf(one.reason)}`);
    return failed('internal');
  });
  const decisions: Decision[] = [];
  const scores: ScoredQuote[] = [];
  let code: string | null = null;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      decisions.push(outcome.scored.decision);
      scores.push(outcome.scored);
    } else {
      code ??= outcome.code;
      if (outcome.decision !== null) decisions.push(outcome.decision);
    }
  }
  return code === null ? { ok: true, scores } : { ok: false, code, decisions };
}
