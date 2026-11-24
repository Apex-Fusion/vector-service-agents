// agents/insurer-intake-agent/src/job/attest.ts
// Step 5 of the job of the Insurer Intake Agent (use case 2, prior authorization): the report of the attestations of the sender. The agent reads three attestations about the sender and reports what it found,
// one word for each: valid, invalid, absent or unreadable. The words go into `attestations` of the intake record. The step is a report and nothing else: it never refuses the job, it never changes the decision
// of the model, and its result never reaches the prompt, so the model decides the completeness of the request from the request and the requirements only.
//
// The report runs in the job, after the Claim, and never in the hook: the runtime waits only 10 seconds for the hook. The step asks the report port one time with the sender, the delegation that paid for the
// request and the time of the clock. The port reads the root delegator of the delegation itself, so the step never takes an issuer from the request.
//
// The time. The job must still decide and file after the report, so the report gets the time that leaves DECISION_AND_FILING_MS for those two steps, and at most REPORT_BUDGET_MS. With less than
// REPORT_LEAST_MS of that time the report is skipped. A report that does not answer in its time is dropped, and the clock of the calls bounds the wait, so a port that never answers cannot hold the job.
// A time that is not a number is never enough time: the test is written so that it skips the report.
//
// Every failure is `unreadable` for all three words, and a source that cannot be read is never a pass: a port that throws or rejects, a port that does not answer, an answer that is no object, and too little
// time. A member of an answer that is not one of the four words is `unreadable`, and the other members keep their words. The result is a new object with the three members and no other. The log line holds the
// reason as a fixed word or a number, never the message of an error, a value of the report, the sender or the delegation.
import { within } from '@vsa/usecase-kit/access';
import { ATTESTATION_STATES } from '@vsa/usecase-kit/priorauth';
import type { AttestationState } from '@vsa/usecase-kit/priorauth';
import type { DelegationId, Did } from '@vsa/usecase-kit/protocol';
import type { AttestationReport, IntakeDeps } from './ports.ts';

/** The most time that the report gets: 45 seconds. It is the budget of the report of the service, and a test of the service holds the two numbers equal. */
export const REPORT_BUDGET_MS = 45_000;
/** The time that the report leaves for the decision of the model and the filing of the request: 150 seconds. */
export const DECISION_AND_FILING_MS = 150_000;
/** The least time that is worth a report: 10 seconds. With less the report is skipped. */
export const REPORT_LEAST_MS = 10_000;

const KINDS = ['provenance', 'software', 'principal_binding'] as const;
type Kind = (typeof KINDS)[number];

const unreadable = (): AttestationReport => ({ provenance: 'unreadable', software: 'unreadable', principal_binding: 'unreadable' });

const isState = (value: unknown): value is AttestationState => typeof value === 'string' && (ATTESTATION_STATES as readonly string[]).includes(value);

/** The name of an error for a log line. The message of an error is never logged: it can name a path or a host. */
const kindOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/**
 * Reports the provenance, the software and the principal-binding attestation of the sender, or `unreadable` for each when the report cannot be had. `deadline` is the time, in milliseconds of the clock of the
 * job, by which the decision and the filing must be done. It never throws and never refuses the job. See the head of this file for the time and the failures.
 */
export async function attestStep(
  deps: Pick<IntakeDeps, 'report' | 'clock' | 'log' | 'calls'>,
  input: { readonly sender: Did; readonly delegation: DelegationId },
  deadline: number,
): Promise<AttestationReport> {
  const note = (text: string): void => {
    try {
      deps.log(`insurer intake: ${text}`);
    } catch {
      // A log that fails changes nothing.
    }
  };
  try {
    const now: unknown = deps.clock();
    const left = typeof now === 'number' && typeof deadline === 'number' ? Math.min(REPORT_BUDGET_MS, deadline - now - DECISION_AND_FILING_MS) : Number.NaN;
    if (!(left >= REPORT_LEAST_MS)) {
      note('the report of the attestations is skipped because too little time is left for it, so the three attestations are unreadable');
      return unreadable();
    }
    const answered = await within(deps.calls.clock, left, () => deps.report({ sender: input.sender, delegation: input.delegation, atMs: now as number }));
    if (answered.timedOut) {
      note(`the report of the attestations did not answer in ${left} ms, so the three attestations are unreadable`);
      return unreadable();
    }
    const answer: unknown = answered.value;
    const given = (kind: Kind): unknown => (typeof answer === 'object' && answer !== null && Object.hasOwn(answer, kind) ? (answer as Record<string, unknown>)[kind] : undefined);
    const word = (kind: Kind): AttestationState => {
      const value = given(kind);
      return isState(value) ? value : 'unreadable';
    };
    const report: AttestationReport = { provenance: word('provenance'), software: word('software'), principal_binding: word('principal_binding') };
    const odd = KINDS.filter((kind) => !isState(given(kind))).length;
    if (odd > 0) note(`the report of the attestations gave no word of the four for ${odd} of the three attestations, so they are unreadable`);
    return report;
  } catch (error) {
    note(`the report of the attestations failed (${kindOf(error)}), so the three attestations are unreadable`);
    return unreadable();
  }
}
