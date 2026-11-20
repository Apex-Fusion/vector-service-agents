// packages/usecase-kit/src/checks/run.ts
// The run of an ordered list of checks. It runs the checks one after the other, it stops at the first refusal, and it records which checks passed and what they learned.
//
// A check never throws a rule. It answers `{ ok: true, value }`, with the facts that it learned, or `{ ok: false, code, detail }`. The run reads success from `ok` and from nothing else: an answer that is
// neither `ok: true` nor `ok: false` is a fault of the check, and the run throws it. A fault is never a pass. A check that could not read its source throws CheckUnavailableError, or answers the
// code `check_unavailable`: the run ends with that code, which is never the code of a rule.
import { accepted, isPlainObject, isRefusalCode, parseDigest, parseDocument, refused } from '../protocol/index.ts';
import type { Accepted, Digest, JsonValue, RefusalCode, Refused } from '../protocol/index.ts';
import { CheckUnavailableError } from './ports.ts';

/** The code of a refusal of a check: a refusal code of a counterparty, or `check_unavailable`. */
export type CheckCode = RefusalCode | 'check_unavailable';

/** What a check that passed learned: plain JSON data, so that a service can put it in its answer. */
export type Facts = { readonly [name: string]: JsonValue };

/** The two digests of an approval whose digest is not the digest of the document that was received. A later step uses them as the evidence of a challenge. */
export interface DigestPair {
  /** The digest that the attestation holds. */
  readonly expected_digest: Digest;
  /** The digest of the document and the salt that were received. */
  readonly observed_digest: Digest;
}

export interface StepRefused extends Refused<CheckCode> {
  /** Only for `approval_digest_mismatch`. */
  readonly digests?: DigestPair;
}

export type StepResult = Accepted<Facts> | StepRefused;

/** One check of a list. A step can stand for several checks that pass or fail together. */
export interface CheckStep {
  /** The name of each check that a pass of this step records. Each name is unique in the list. */
  readonly names: readonly [string, ...string[]];
  readonly run: () => Promise<StepResult>;
}

/** What a run learned about the checks that passed. */
export interface ChecksRecord {
  /** The name of each check that passed, in the order that they ran. Each value is `true`. */
  readonly checks: Readonly<Record<string, true>>;
  /** What the checks that passed learned. */
  readonly facts: Readonly<Record<string, JsonValue>>;
}

export interface ChecksPassed {
  readonly ok: true;
  readonly record: ChecksRecord;
}

export interface ChecksRefused {
  readonly ok: false;
  readonly code: CheckCode;
  readonly detail: string;
  /** Only for `approval_digest_mismatch`, and null for every other code. */
  readonly digests: DigestPair | null;
  /** The checks that passed before the refusal. */
  readonly record: ChecksRecord;
}

export type ChecksOutcome = ChecksPassed | ChecksRefused;

function assertSteps(steps: readonly CheckStep[]): void {
  if (!Array.isArray(steps) || steps.length === 0) throw new TypeError('a run needs at least one check: a run with no check would pass everything');
  const seen = new Set<string>();
  for (const step of steps) {
    if (!isPlainObject(step) || typeof step.run !== 'function' || !Array.isArray(step.names) || step.names.length === 0) throw new TypeError('a check has names and a run function');
    for (const name of step.names) {
      if (typeof name !== 'string' || name === '') throw new TypeError('the name of a check is a text that is not empty');
      if (seen.has(name)) throw new TypeError(`two checks have the name ${name}`);
      seen.add(name);
    }
  }
}

/** The answer of a step, read strictly. Anything that is not `ok: true` or `ok: false` with the right members is a fault. */
function readResult(result: unknown, name: string): StepResult {
  if (!isPlainObject(result)) throw new TypeError(`the check ${name} must answer an object with ok true or ok false`);
  if (result.ok === true) {
    const facts = parseDocument(result.value, 'facts');
    if (!facts.ok) throw new TypeError(`the facts of the check ${name} are not plain JSON data (${facts.detail})`);
    return accepted(facts.value);
  }
  if (result.ok !== false) throw new TypeError(`the check ${name} must answer ok true or ok false`);
  const { code, detail } = result;
  if (!(code === 'check_unavailable' || isRefusalCode(code))) throw new TypeError(`the check ${name} refused with a code that is not a refusal code of a counterparty`);
  if (typeof detail !== 'string') throw new TypeError(`the check ${name} refused with a detail that is not a text`);
  if (result.digests === undefined) return refused(code as CheckCode, detail);
  const pair = isPlainObject(result.digests) ? result.digests : {};
  const expected = parseDigest(pair.expected_digest, 'expected_digest');
  const observed = parseDigest(pair.observed_digest, 'observed_digest');
  if (!expected.ok || !observed.ok) throw new TypeError(`the check ${name} gave digests that are not digests`);
  return { ...refused(code as CheckCode, detail), digests: { expected_digest: expected.value, observed_digest: observed.value } };
}

async function runStep(step: CheckStep): Promise<StepResult> {
  let result: unknown;
  try {
    result = await step.run();
  } catch (error) {
    if (error instanceof CheckUnavailableError) return refused('check_unavailable', error.message);
    throw error;
  }
  return readResult(result, step.names[0]);
}

/**
 * Runs the checks in the order of the list. The first refusal ends the run, and the checks after it do not run. The run passes only when every check passed.
 * It throws a TypeError for a list that is wrong (empty, or two checks with one name) and for an answer that is not `ok: true` or `ok: false`.
 */
export async function runChecks(steps: readonly CheckStep[]): Promise<ChecksOutcome> {
  assertSteps(steps);
  const checks: Record<string, true> = {};
  const facts: Record<string, JsonValue> = {};
  const record = (): ChecksRecord => ({ checks: Object.freeze({ ...checks }), facts: Object.freeze({ ...facts }) });
  for (const step of steps) {
    const result = await runStep(step);
    if (!result.ok) return { ok: false, code: result.code, detail: result.detail, digests: result.digests ?? null, record: record() };
    for (const name of step.names) checks[name] = true;
    for (const [key, value] of Object.entries(result.value)) {
      if (Object.hasOwn(facts, key)) throw new TypeError(`two checks learned a fact with the name ${key}`);
      facts[key] = value;
    }
  }
  return { ok: true, record: record() };
}
