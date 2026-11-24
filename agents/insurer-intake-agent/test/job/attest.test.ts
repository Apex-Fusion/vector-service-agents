// agents/insurer-intake-agent/test/job/attest.test.ts: step 5 of the job, the report of the attestations of the sender. The step asks the report port once, with the sender and the delegation, and it gives the
// three words of the intake record. It never refuses the job: a port that throws, a port that never answers, an answer that is no report and too little time all give `unreadable` for the three words, and
// the job goes on. The report gets the time that leaves 150,000 ms for the decision and the filing, at most 45,000 ms, and it is skipped when less than 10,000 ms of that time are left. The report never
// reaches the prompt. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { ATTESTATION_STATES } from '@vsa/usecase-kit/priorauth';
import { DECISION_AND_FILING_MS, REPORT_BUDGET_MS, REPORT_LEAST_MS, attestStep } from '../../src/job/attest.ts';
import type { AttestationReport, IntakeDeps } from '../../src/job/ports.ts';
import { makeRig } from './rig.ts';
import type { Rig } from './rig.ts';
import { DELEGATION_ID, SENDER_DID } from './samples.ts';

const INPUT = { sender: SENDER_DID, delegation: DELEGATION_ID };
const UNREADABLE: AttestationReport = { provenance: 'unreadable', software: 'unreadable', principal_binding: 'unreadable' };
/** A text that no line of the log may repeat: the message of an error that a port throws. */
const MARKER = 'MARKER-OF-THE-ERROR-MESSAGE';

/** The deadline that leaves `leftMs` for the report, after the 150,000 ms for the decision and the filing. */
const deadlineFor = (rig: Rig, leftMs: number): number => rig.deps.clock() + DECISION_AND_FILING_MS + leftMs;

/**
 * The deps of a report that never answers. The clock of the calls ends each wait at once, so the step finds out that the time is over, and it notes the length of each wait. The waits of the report are the
 * only waits in a step, so the notes are its bound.
 */
function hangingDeps(rig: Rig, waits: number[]): IntakeDeps {
  const clock = {
    now: () => rig.deps.clock(),
    sleep: (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
  return { ...rig.deps, calls: { ...rig.deps.calls, clock }, report: () => new Promise<never>(() => undefined) };
}

describe('the report port', () => {
  it('is asked one time, with the sender, the delegation and the time of the clock, and the step gives its three words', async () => {
    const rig = makeRig();
    const report = await attestStep(rig.deps, INPUT, deadlineFor(rig, REPORT_BUDGET_MS));
    expect(rig.reportInputs).toStrictEqual([{ sender: SENDER_DID, delegation: DELEGATION_ID, atMs: rig.deps.clock() }]);
    expect(rig.events).toStrictEqual(['report']);
    expect(report).toStrictEqual({ provenance: 'valid', software: 'valid', principal_binding: 'valid' });
  });

  it.each([
    ['one word that is not valid', { provenance: 'valid', software: 'invalid', principal_binding: 'valid' }],
    ['no attestation of the sender', { provenance: 'absent', software: 'absent', principal_binding: 'absent' }],
    ['a source that could not be read', { provenance: 'valid', software: 'valid', principal_binding: 'unreadable' }],
  ] as const)('gives the words that the report gives, and no other: %s', async (_what, words) => {
    const rig = makeRig();
    rig.attestations = words;
    expect(await attestStep(rig.deps, INPUT, deadlineFor(rig, REPORT_BUDGET_MS))).toStrictEqual(words);
  });

  it.each(ATTESTATION_STATES)('takes the word %s as it is', async (word) => {
    const rig = makeRig();
    rig.attestations = { provenance: word, software: word, principal_binding: word };
    expect(await attestStep(rig.deps, INPUT, deadlineFor(rig, REPORT_BUDGET_MS))).toStrictEqual({ provenance: word, software: word, principal_binding: word });
  });

  it('gives a new object with the three members and no other, so a later change of the answer of the port cannot change the report of the job', async () => {
    const rig = makeRig();
    const answer = { provenance: 'valid', software: 'valid', principal_binding: 'valid', extra: 'a member that the record does not hold' };
    rig.attestations = answer as unknown as AttestationReport;
    const report = await attestStep(rig.deps, INPUT, deadlineFor(rig, REPORT_BUDGET_MS));
    expect(report).not.toBe(answer);
    expect(Object.keys(report)).toStrictEqual(['provenance', 'software', 'principal_binding']);
  });

  it('never reaches the model: the step calls no port but the report', async () => {
    const rig = makeRig();
    await attestStep(rig.deps, INPUT, deadlineFor(rig, REPORT_BUDGET_MS));
    expect(rig.events).toStrictEqual(['report']);
    expect(rig.decideCalls).toHaveLength(0);
    expect(rig.portal.calls).toHaveLength(0);
    expect(rig.gateway.requests).toHaveLength(0);
    expect(rig.booked).toHaveLength(0);
  });
});

describe('a report that cannot be read', () => {
  it.each([
    ['a port that throws', () => { throw new Error(MARKER); }],
    ['a port that rejects', () => Promise.reject(new Error(MARKER))],
    ['a port that is no function', 'not a function'],
  ] as const)('is unreadable for the three words, and the step goes on: %s', async (_what, report) => {
    const rig = makeRig();
    const deps = { ...rig.deps, report } as unknown as IntakeDeps;
    expect(await attestStep(deps, INPUT, deadlineFor(rig, REPORT_BUDGET_MS))).toStrictEqual(UNREADABLE);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('unreadable');
    expect(rig.logs[0]).not.toContain(MARKER);
    // The twin: the rig with no change gives the words of the report.
    expect(await attestStep(makeRig().deps, INPUT, deadlineFor(rig, REPORT_BUDGET_MS))).toStrictEqual({ provenance: 'valid', software: 'valid', principal_binding: 'valid' });
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a text', 'valid'],
    ['a number', 7],
    ['a list of three words', ['valid', 'valid', 'valid']],
    ['an object with no member', {}],
  ])('is unreadable for the three words when the answer is %s', async (_what, answer) => {
    const rig = makeRig();
    rig.attestations = answer as unknown as AttestationReport;
    expect(await attestStep(rig.deps, INPUT, deadlineFor(rig, REPORT_BUDGET_MS))).toStrictEqual(UNREADABLE);
  });

  it('is unreadable for a member that is no word of the four, and the other members keep their words', async () => {
    const rig = makeRig();
    rig.attestations = { provenance: 'valid', software: 'maybe', principal_binding: 3 } as unknown as AttestationReport;
    expect(await attestStep(rig.deps, INPUT, deadlineFor(rig, REPORT_BUDGET_MS))).toStrictEqual({ provenance: 'valid', software: 'unreadable', principal_binding: 'unreadable' });
    expect(rig.logs).toHaveLength(1);
  });

  it('does not take a member that the answer only inherits from its prototype', async () => {
    const rig = makeRig();
    rig.attestations = Object.create({ provenance: 'valid', software: 'valid', principal_binding: 'valid' }) as AttestationReport;
    expect(await attestStep(rig.deps, INPUT, deadlineFor(rig, REPORT_BUDGET_MS))).toStrictEqual(UNREADABLE);
  });

  it('is unreadable for the three words when a member of the answer cannot be read', async () => {
    const rig = makeRig();
    rig.attestations = { get provenance(): string { throw new Error(MARKER); }, software: 'valid', principal_binding: 'valid' } as unknown as AttestationReport;
    expect(await attestStep(rig.deps, INPUT, deadlineFor(rig, REPORT_BUDGET_MS))).toStrictEqual(UNREADABLE);
    expect(rig.logs.join('\n')).not.toContain(MARKER);
  });

  it('is not changed by a log that throws', async () => {
    const rig = makeRig();
    rig.logThrows = true;
    const deps = { ...rig.deps, report: () => Promise.reject(new Error(MARKER)) };
    expect(await attestStep(deps, INPUT, deadlineFor(rig, REPORT_BUDGET_MS))).toStrictEqual(UNREADABLE);
  });

  it('writes no value of the sender, the delegation or the error to the log', async () => {
    const rig = makeRig();
    const deps = { ...rig.deps, report: () => Promise.reject(new Error(`${MARKER} ${SENDER_DID} ${DELEGATION_ID}`)) };
    await attestStep(deps, INPUT, deadlineFor(rig, REPORT_BUDGET_MS));
    await attestStep(rig.deps, INPUT, deadlineFor(rig, 0));
    const text = rig.logs.join('\n');
    expect(rig.logs).toHaveLength(2);
    for (const value of [MARKER, SENDER_DID, DELEGATION_ID]) expect(text).not.toContain(value);
  });
});

describe('the time of the report', () => {
  it.each([
    ['all the time that the budget gives', REPORT_BUDGET_MS, REPORT_BUDGET_MS],
    ['no more than the budget, whatever time is left', 400_000, REPORT_BUDGET_MS],
    ['the time that leaves 150,000 ms for the decision and the filing', 30_000, 30_000],
    ['the least time that it takes', REPORT_LEAST_MS, REPORT_LEAST_MS],
  ])('waits for %s', async (_what, left, wait) => {
    const rig = makeRig();
    const waits: number[] = [];
    const report = await attestStep(hangingDeps(rig, waits), INPUT, deadlineFor(rig, left));
    expect(waits).toStrictEqual([wait]);
    expect(report).toStrictEqual(UNREADABLE);
    expect(rig.logs).toHaveLength(1);
  });

  it('keeps the numbers of the plan: 45,000 ms for the report, 150,000 ms for the decision and the filing, and 10,000 ms at the least', () => {
    expect([REPORT_BUDGET_MS, DECISION_AND_FILING_MS, REPORT_LEAST_MS]).toStrictEqual([45_000, 150_000, 10_000]);
  });

  it('moves with the clock: a later time leaves less time for the report', async () => {
    const rig = makeRig();
    const deadline = deadlineFor(rig, 30_000);
    rig.gateway.advance(5_000);
    const waits: number[] = [];
    await attestStep(hangingDeps(rig, waits), INPUT, deadline);
    expect(waits).toStrictEqual([25_000]);
  });

  it.each([
    ['one millisecond under the least time', REPORT_LEAST_MS - 1],
    ['no time at all', 0],
    ['a time that has passed', -60_000],
  ])('skips the report with %s: no port is called, and the three words are unreadable', async (_what, left) => {
    const rig = makeRig();
    expect(await attestStep(rig.deps, INPUT, deadlineFor(rig, left))).toStrictEqual(UNREADABLE);
    expect(rig.reportInputs).toHaveLength(0);
    expect(rig.events).toStrictEqual([]);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('skipped');
  });

  it('asks the port at the least time, the twin of the report that is skipped', async () => {
    const rig = makeRig();
    expect(await attestStep(rig.deps, INPUT, deadlineFor(rig, REPORT_LEAST_MS))).toStrictEqual({ provenance: 'valid', software: 'valid', principal_binding: 'valid' });
    expect(rig.reportInputs).toHaveLength(1);
    expect(rig.logs).toHaveLength(0);
  });

  it.each([
    ['a deadline that is not a number', Number.NaN],
    ['a deadline that is not given', undefined],
    ['a deadline that is a text', '9999999999999'],
  ])('skips the report for %s: a time that is not known is never enough time', async (_what, deadline) => {
    const rig = makeRig();
    expect(await attestStep(rig.deps, INPUT, deadline as number)).toStrictEqual(UNREADABLE);
    expect(rig.reportInputs).toHaveLength(0);
  });

  it('skips the report when the clock gives no number', async () => {
    const rig = makeRig();
    const deps = { ...rig.deps, clock: () => Number.NaN };
    expect(await attestStep(deps, INPUT, Number.MAX_SAFE_INTEGER)).toStrictEqual(UNREADABLE);
    expect(rig.reportInputs).toHaveLength(0);
  });

  it('gives unreadable, and does not throw, when the clock throws', async () => {
    const rig = makeRig();
    const deps = { ...rig.deps, clock: (): number => { throw new Error(MARKER); } };
    expect(await attestStep(deps, INPUT, Number.MAX_SAFE_INTEGER)).toStrictEqual(UNREADABLE);
    expect(rig.reportInputs).toHaveLength(0);
  });
});
