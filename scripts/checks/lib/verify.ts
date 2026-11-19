// scripts/checks/lib/verify.ts - what a step reads with the hosted tools after it is confirmed.
// The hosted server runs the code that the checks prove for the platform: it reads the delegation, the vault and the attestation from the ledger on its own. A step is verified when each
// tool shows what the step did. The indexers can lag a few seconds behind a block, so the read is asked again for a short time. What the tools answered goes to the evidence file,
// and a tool that failed leaves its message there.
import type { HostedRead } from './evidence.ts';
import { eventually } from './retry.ts';
import type { Session } from './session.ts';

/** One call of a tool, and what its answer must show: the list of what does not match, empty when it does. */
export interface ToolCheck {
  tool: string;
  args: Record<string, unknown>;
  problems(answer: Record<string, unknown>): string[];
}

export const VERIFY_WINDOW = { windowMs: 90_000, pauseMs: 5_000 } as const;

export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationError';
  }
}

/** The answer of a tool as the evidence keeps it: the JSON block, as the tool wrote it. */
const readOf = (check: ToolCheck, answer: { failed: boolean; message: string; json: Record<string, unknown> | null }): HostedRead => ({
  tool: check.tool, arguments: check.args, ok: !answer.failed, ...(answer.failed ? { message: answer.message } : {}), ...(answer.json === null ? {} : { result: answer.json }),
});

/**
 * Calls each tool and checks its answer. Asks again, for a short time, until every tool shows what the step did. Writes the evidence either way, and throws a VerificationError when a
 * tool still shows something else after the window. A tool that cannot be reached throws the HostedError of the call.
 */
export async function verifyWithTools(session: Pick<Session, 'hosted' | 'evidence' | 'clock'>, step: string, checks: readonly ToolCheck[], shows: Record<string, unknown> = {}): Promise<void> {
  const outcome = await eventually(session.clock, VERIFY_WINDOW, async () => {
    const reads: HostedRead[] = [];
    const problems: string[] = [];
    for (const check of checks) {
      const answer = await session.hosted.call(check.tool, check.args);
      reads.push(readOf(check, answer));
      if (answer.failed) problems.push(`${check.tool} failed: ${answer.message}`);
      else if (answer.json === null) problems.push(`${check.tool} gave no JSON block`);
      else problems.push(...check.problems(answer.json));
    }
    return { done: problems.length === 0, value: { reads, problems } };
  });
  const { reads, problems } = outcome.value;
  if (outcome.done) {
    session.evidence.add({ step, status: 'verified', hosted: reads, shows });
    return;
  }
  for (const read of reads) {
    if (!read.ok) session.evidence.add({ step, status: 'tool_refused', expected: false, tool: read.tool, message: read.message ?? 'the tool failed' });
  }
  session.evidence.add({ step, status: 'info', shows: { verification: 'failed', problems, hosted: reads } });
  throw new VerificationError(`the hosted tools do not show the step ${step} as it was made: ${problems.join('; ')}`);
}
