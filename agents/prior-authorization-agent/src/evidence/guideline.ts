// agents/prior-authorization-agent/src/evidence/guideline.ts
// The second read of the evidence: the guideline of one service, through the subagent `drafter`. The route is `guidelines.read` (action `guideline.read`, resource `<public base>/t/<tenant>/guidelines`), and
// the parser is the one that the deps give for the guideline. The codes of this read are `guideline_read_timeout` for a job that ran out of time and `guideline_invalid` for a body that the parser refuses.
// The service code comes from the order that the first read gave, so this read can start only after the first read ended. The agent itself never reads a guideline: the token is the token of the subagent,
// under its own sub-delegation, and it is not the token of the first read.
import { tokenTarget } from '@vsa/usecase-kit/access';
import type { Guideline } from '@vsa/usecase-kit/priorauth';
import type { EvidenceDeps, EvidenceRequest, EvidenceRun } from './ports.ts';
import { failedRead, readThroughSubagent } from './subread.ts';
import type { SubreadResult } from './subread.ts';

/**
 * Reads the guideline of the service `serviceCode` through `drafter`, and ends its sub-delegation. The result is the guideline that `deps.parseGuideline` checked, or the code of the failure (see
 * `readThroughSubagent`). A tenant or a service code that makes no route is `internal`, and nothing is sent. The read starts with the time that the caller leaves: it needs the same least time as the first
 * read, so a first read that took long can leave too little time and the code is then `deadline`.
 */
export async function readGuideline(deps: EvidenceDeps, request: EvidenceRequest, run: EvidenceRun, serviceCode: string): Promise<SubreadResult<Guideline>> {
  const target = tokenTarget(deps.calls.bases, request.tenant, 'guidelines.read', { code: serviceCode });
  if (target.ok !== true) return failedRead(deps, 'drafter', 'internal');
  return readThroughSubagent(deps, request, run, {
    name: 'drafter',
    subagent: deps.subagents.drafter,
    target: target.value,
    timeoutCode: 'guideline_read_timeout',
    invalidCode: 'guideline_invalid',
    parse: deps.parseGuideline,
  });
}
