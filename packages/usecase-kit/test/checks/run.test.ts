// packages/usecase-kit/test/checks/run.test.ts: the run of an ordered list of checks. The run stops at the first refusal, records what passed, and reads success from `ok` and from nothing else.
import { describe, expect, it } from 'vitest';
import { CheckUnavailableError, runChecks } from '../../src/checks/index.ts';
import type { CheckStep, StepResult } from '../../src/checks/index.ts';
import { accepted, refused } from '../../src/protocol/index.ts';

const DIGEST_A = 'ab'.repeat(32);
const DIGEST_B = 'cd'.repeat(32);

/** A step that answers as the test says, and counts its runs. */
function step(names: readonly [string, ...string[]], result: () => unknown | Promise<unknown>, runs: string[] = []): CheckStep {
  return { names, run: async () => { runs.push(names[0]); return (await result()) as StepResult; } };
}

describe('the order and the first refusal', () => {
  it('runs the checks in the order of the list and passes when every check passed', async () => {
    const runs: string[] = [];
    const outcome = await runChecks([step(['one'], () => accepted({}), runs), step(['two'], () => accepted({}), runs), step(['three'], () => accepted({}), runs)]);
    expect(runs).toEqual(['one', 'two', 'three']);
    expect(outcome).toEqual({ ok: true, record: { checks: { one: true, two: true, three: true }, facts: {} } });
    expect(Object.keys(outcome.record.checks)).toEqual(['one', 'two', 'three']);
  });

  it('stops at the first refusal: the checks after it do not run, and the record holds only the checks that passed', async () => {
    const runs: string[] = [];
    const outcome = await runChecks([
      step(['one'], () => accepted({ seen: 1 }), runs), step(['two'], () => refused('sender_not_active', 'the sender is not Active'), runs), step(['three'], () => accepted({}), runs),
    ]);
    expect(runs).toEqual(['one', 'two']);
    expect(outcome).toEqual({ ok: false, code: 'sender_not_active', detail: 'the sender is not Active', digests: null, record: { checks: { one: true }, facts: { seen: 1 } } });
  });

  it('refuses at the first check when the first check refuses, with an empty record', async () => {
    const outcome = await runChecks([step(['one'], () => refused('delegation_ended', 'ended')), step(['two'], () => accepted({}))]);
    expect(outcome).toMatchObject({ ok: false, code: 'delegation_ended', record: { checks: {}, facts: {} } });
  });

  it('gives the same list the same answer each time, and does not keep a record between two runs', async () => {
    const steps = [step(['one'], () => accepted({ a: 1 })), step(['two'], () => refused('not_vault_paid', 'no'))];
    const first = await runChecks(steps);
    const second = await runChecks(steps);
    expect(second).toEqual(first);
    expect(await runChecks([steps[0]])).toEqual({ ok: true, record: { checks: { one: true }, facts: { a: 1 } } });
  });
});

describe('what the checks that passed learned', () => {
  it('records the facts of each check that passed, and the name of each check of a step that stands for several checks', async () => {
    const outcome = await runChecks([
      step(['sender_active'], () => accepted({})), step(['sender_accountable'], () => accepted({ organisation: 'a.example', organisation_verified: false })),
      step(['approval_found', 'approval_type'], () => accepted({ approval_valid_until: null, tags: ['x', 1, { y: true }] })),
    ]);
    expect(outcome).toEqual({
      ok: true,
      record: {
        checks: { sender_active: true, sender_accountable: true, approval_found: true, approval_type: true },
        facts: { organisation: 'a.example', organisation_verified: false, approval_valid_until: null, tags: ['x', 1, { y: true }] },
      },
    });
  });

  it('does not record the facts or the names of the step that refused', async () => {
    const outcome = await runChecks([step(['one'], () => accepted({ one: 1 })), step(['two', 'three'], () => refused('lot_mismatch', 'no'))]);
    expect(outcome).toMatchObject({ ok: false, record: { checks: { one: true }, facts: { one: 1 } } });
  });

  it('gives a record that nobody can change', async () => {
    const outcome = await runChecks([step(['one'], () => accepted({ a: 1 }))]);
    expect(Object.isFrozen(outcome.record)).toBe(true);
    expect(Object.isFrozen(outcome.record.checks)).toBe(true);
    expect(Object.isFrozen(outcome.record.facts)).toBe(true);
    expect(() => Object.assign(outcome.record.checks, { two: true })).toThrow(TypeError);
  });
});

describe('a list or an answer that is wrong is an error, and never a pass', () => {
  it('throws a TypeError for a list with no check: a run with no check would pass everything', async () => {
    await expect(runChecks([])).rejects.toBeInstanceOf(TypeError);
    await expect(runChecks(undefined as unknown as CheckStep[])).rejects.toBeInstanceOf(TypeError);
  });

  it('throws a TypeError for two checks with one name, and for a step with no name or no function', async () => {
    await expect(runChecks([step(['one'], () => accepted({})), step(['two', 'one'], () => accepted({}))])).rejects.toBeInstanceOf(TypeError);
    await expect(runChecks([{ names: [] as unknown as [string], run: async () => accepted({}) }])).rejects.toBeInstanceOf(TypeError);
    await expect(runChecks([{ names: [''], run: async () => accepted({}) }])).rejects.toBeInstanceOf(TypeError);
    await expect(runChecks([{ names: ['one'] } as unknown as CheckStep])).rejects.toBeInstanceOf(TypeError);
    await expect(runChecks([step(['one'], () => accepted({})), step(['two'], () => accepted({}))])).resolves.toMatchObject({ ok: true });
  });

  it('does not run any check of a list that is wrong', async () => {
    const runs: string[] = [];
    await expect(runChecks([step(['one'], () => accepted({}), runs), step(['one'], () => accepted({}), runs)])).rejects.toBeInstanceOf(TypeError);
    expect(runs).toEqual([]);
  });

  it.each([
    ['no answer', undefined], ['null', null], ['an empty object', {}], ['ok as a text', { ok: 'true', value: {} }], ['ok as a number', { ok: 1, value: {} }], ['ok as a truthy object', { ok: {}, value: {} }],
    ['a pass with no facts', { ok: true }], ['a pass with facts that are not JSON data', { ok: true, value: { a: undefined } }], ['a pass whose facts are not an object', { ok: true, value: 'yes' }],
    ['a pass whose facts hold a function', { ok: true, value: { a: () => 1 } }], ['a refusal with no code', { ok: false, detail: 'x' }], ['a refusal with a code that is not a refusal code', { ok: false, code: 'nope', detail: 'x' }],
    ['a refusal with ok as a text', { ok: 'false', code: 'sender_not_active', detail: 'x' }], ['a refusal with no ok', { code: 'sender_not_active', detail: 'x' }],
    ['a refusal with a code of a mock system', { ok: false, code: 'token_invalid', detail: 'x' }], ['a refusal with no detail', { ok: false, code: 'sender_not_active' }],
    ['a refusal with a detail that is not a text', { ok: false, code: 'sender_not_active', detail: 5 }], ['a refusal with digests that are not digests', { ok: false, code: 'approval_digest_mismatch', detail: 'x', digests: { expected_digest: 'a', observed_digest: DIGEST_B } }],
    ['a refusal with digests that are not an object', { ok: false, code: 'approval_digest_mismatch', detail: 'x', digests: 'ab' }],
  ])('throws a TypeError for %s', async (_what, answer) => {
    await expect(runChecks([step(['one'], () => answer)])).rejects.toBeInstanceOf(TypeError);
  });

  it('throws a TypeError when two checks learn a fact with one name', async () => {
    await expect(runChecks([step(['one'], () => accepted({ a: 1 })), step(['two'], () => accepted({ a: 2 }))])).rejects.toBeInstanceOf(TypeError);
  });

  it('does not turn an error of a check into a refusal or a pass: the run rejects with that error', async () => {
    const error = new RangeError('a bug in a check');
    await expect(runChecks([step(['one'], () => { throw error; })])).rejects.toBe(error);
    await expect(runChecks([step(['one'], () => accepted({}))])).resolves.toMatchObject({ ok: true });
  });
});

describe('a source that could not be read', () => {
  it('turns CheckUnavailableError into the code check_unavailable, with the fixed text of the error', async () => {
    const outcome = await runChecks([step(['one'], () => accepted({})), step(['two'], () => { throw new CheckUnavailableError('delegation'); }), step(['three'], () => accepted({}))]);
    expect(outcome).toEqual({ ok: false, code: 'check_unavailable', detail: 'the delegation could not be read', digests: null, record: { checks: { one: true }, facts: {} } });
  });

  it('gives a refusal with the code check_unavailable as it is', async () => {
    expect(await runChecks([step(['one'], () => refused('check_unavailable', 'the answer is not usable'))])).toMatchObject({ ok: false, code: 'check_unavailable', detail: 'the answer is not usable' });
  });
});

describe('the digests of an approval that does not match', () => {
  it('carry through the run for the refusal that has them, and are null for every other refusal', async () => {
    const mismatch = { ...refused('approval_digest_mismatch', 'the digest is not the digest of the document'), digests: { expected_digest: DIGEST_A, observed_digest: DIGEST_B } };
    expect(await runChecks([step(['one'], () => mismatch)])).toMatchObject({ ok: false, code: 'approval_digest_mismatch', digests: { expected_digest: DIGEST_A, observed_digest: DIGEST_B } });
    expect(await runChecks([step(['one'], () => refused('approval_expired', 'no'))])).toMatchObject({ ok: false, digests: null });
  });
});
