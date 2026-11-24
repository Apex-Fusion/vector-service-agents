// agents/sourcing-agent/test/scoring/table.test.ts: the closed list of the codes of a failed scoring. Each page and README of the agent holds its table of reasons to `SCORING_FAILURES`, so the list must be exactly
// what the code writes: this test runs one failure for each code of the list, and holds the codes that it saw equal to the list, in both directions. It also holds each failure to the rule that a sub-delegation is
// ended or recorded, and that no id stays in use.
import { DEFAULT_END_TIMEOUT_MS, MAX_SUB_DELEGATION_MS, MIN_SUB_DELEGATION_MS, SUB_DELEGATION_FAILURES } from '@vsa/usecase-kit/access';
import { describe, expect, it } from 'vitest';
import { END_TIMEOUT_MS, SCORER_JOB_TIMEOUT_MS, SCORER_NEED_MS, SCORING_FAILURES, SUB_DELEGATION_VALID_MS } from '../../src/scoring/index.ts';
import type { ScoreAnswer } from '../../src/scoring/index.ts';
import { AGENT_KEY, BIDDERS, NOW, PARENT_ID, gatewayRefused, json, never, scoreAnswerFor } from './support.ts';
import { expectSettled, world } from './world.ts';
import type { RunOptions, World } from './world.ts';

/** A failure: the code that it must give, and how the world is set up for it. The setup may give options for the run. */
type Row = readonly [code: string, setup: (w: World) => RunOptions | void];

/** The decision of the second bidder as the port gives it, with another choice than the one that the decision records. */
const secondDecides = (w: World, answer: (golden: Extract<ScoreAnswer, { ok: true }>) => unknown): void => {
  w.script.score = async (request) => {
    const golden = scoreAnswerFor(request.file.did);
    if (request.file.did !== BIDDERS[1].did || !golden.ok) return golden;
    // The port is typed, and a port in JavaScript can give any value.
    return answer(golden) as ScoreAnswer;
  };
};

const OWN: Row[] = [
  ['deadline', () => ({ deps: { deadline_ms: NOW + SCORER_NEED_MS - 1 } })],
  ['aborted', () => ({ signal: AbortSignal.abort() })],
  ['vendors_refused', (w) => void (w.script.fetch = async () => json({ error: 'not_covered' }, 403))],
  ['vendors_failed', (w) => void (w.script.fetch = async () => json({}, 500))],
  ['vendors_invalid', (w) => void (w.script.fetch = async () => json({ vendors: [] }))],
  ['scorer_token_failed', (w) => void (w.script.requestToken = () => Promise.resolve(gatewayRefused(403, 'access_denied', 'no')))],
  [
    'scorer_threw',
    (w) =>
      void (w.script.score = async () => {
        throw new Error('the model hire broke');
      }),
  ],
  ['scorer_timed_out', (w) => void (w.script.score = () => never())],
  ['decision_mismatch', (w) => secondDecides(w, (golden) => ({ ...golden, choice: { ...golden.choice, score: golden.choice.score + 1 } }))],
  ['score_invalid', (w) => secondDecides(w, (golden) => ({ ...golden, decision: { ...golden.decision, choice: { ...golden.choice, score: 101 } }, choice: { ...golden.choice, score: 101 } }))],
  ['internal', (w) => ({ input: { subjects: w.input.subjects.slice(0, 0) } })],
];

/** One failure of the sub-delegation of the access folder for each of its codes. The code of the result is `sub_delegation_` and the code of the folder. */
const SUB: Row[] = [
  ['sub_delegation_bad_request', (w) => ({ deps: { agentKey: { ...w.deps.agentKey, walletAddress: 'not an address' } } })],
  ['sub_delegation_parent_unreadable', (w) => void (w.chain.faults.readThrows = true)],
  ['sub_delegation_parent_not_live', (w) => void (w.chain.parent = null)],
  ['sub_delegation_parent_exhausted', (w) => void (w.chain.parent = { ...w.chain.parent!, remaining: 0 })],
  ['sub_delegation_parent_expiring', (w) => void (w.chain.parent = { ...w.chain.parent!, notAfter: NOW + 100_000 })],
  ['sub_delegation_build_refused', (w) => void (w.chain.faults.buildDelegateThrows = true)],
  ['sub_delegation_build_mismatch', (w) => void (w.chain.tamper = (datum) => ({ ...datum, remaining: 1 }))],
  ['sub_delegation_missing_signer', (w) => void (w.chain.faults.extraSigner = '77'.repeat(28))],
  [
    'sub_delegation_sign_failed',
    (w) => ({
      deps: {
        agentKey: {
          ...w.deps.agentKey,
          signer: {
            keyHash: AGENT_KEY,
            sign: () => {
              throw new Error('the key broke');
            },
          },
        },
      },
    }),
  ],
  ['sub_delegation_submit_failed', (w) => void (w.chain.faults.submitDelegateThrows = true)],
  ['sub_delegation_confirmation_timeout', (w) => void (w.chain.faults.neverConfirm = true)],
  ['sub_delegation_ledger_unreadable', (w) => void (w.chain.faults.readinessThrows = true)],
  ['sub_delegation_sub_delegation_unusable', (w) => void (w.chain.faults.unusable = true)],
  ['sub_delegation_journal_failed', (w) => void w.sink.failPutAt.add(1)],
  [
    'sub_delegation_step_timeout',
    (w) => {
      const readDelegation = w.chain.readDelegation.bind(w.chain);
      w.chain.readDelegation = (id) => (id === PARENT_ID ? never() : readDelegation(id));
    },
  ],
  ['sub_delegation_internal', (w) => ({ deps: { agentKey: { ...w.deps.agentKey, queue: { run: () => Promise.reject(new Error('the queue broke')) } } } })],
];

const ROWS: Row[] = [...OWN, ...SUB];

describe('the codes of a failed scoring', () => {
  it.each(ROWS)('gives %s, ends or records every sub-delegation that it sent, and leaves no id in use', async (code, setup) => {
    const w = world();
    const options = setup(w) ?? {};
    const result = await w.run(options);
    expect(result).toMatchObject({ ok: false, code });
    expect(SCORING_FAILURES).toContain(code);
    await expectSettled(w);
  });

  it('is exactly the list of the codes that the failures give, in both directions', async () => {
    const seen = new Set<string>();
    for (const [, setup] of ROWS) {
      const w = world();
      const result = await w.run(setup(w) ?? {});
      if (!result.ok) seen.add(result.code);
    }
    expect([...seen].sort()).toStrictEqual([...SCORING_FAILURES].sort());
    expect(new Set(SCORING_FAILURES).size).toBe(SCORING_FAILURES.length);
    expect(ROWS.map(([code]) => code).sort()).toStrictEqual([...SCORING_FAILURES].sort());
  });

  it('is a frozen list, with the prefixed code of each code of the access folder written out and no other prefixed code', () => {
    expect(Object.isFrozen(SCORING_FAILURES)).toBe(true);
    expect(SCORING_FAILURES.filter((code) => code.startsWith('sub_delegation_')).map((code) => code.slice('sub_delegation_'.length)).sort()).toStrictEqual([...SUB_DELEGATION_FAILURES].sort());
    for (const code of SCORING_FAILURES) expect(code).toMatch(/^[a-z0-9_]{1,64}$/);
  });
});

describe('the numbers of the scoring', () => {
  it('hold the sub-delegation inside the limits of the kit, and the end step at the default of the kit', () => {
    expect(SUB_DELEGATION_VALID_MS).toBe(1_800_000);
    expect(SUB_DELEGATION_VALID_MS).toBeGreaterThanOrEqual(MIN_SUB_DELEGATION_MS);
    expect(SUB_DELEGATION_VALID_MS).toBeLessThanOrEqual(MAX_SUB_DELEGATION_MS);
    expect(END_TIMEOUT_MS).toBe(DEFAULT_END_TIMEOUT_MS);
    expect(SCORER_JOB_TIMEOUT_MS).toBe(420_000);
  });
});
