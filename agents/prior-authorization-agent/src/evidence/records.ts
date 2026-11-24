// agents/prior-authorization-agent/src/evidence/records.ts
// The first read of the evidence: the order and its record set, through the subagent `record-reader`. The route is `records.order` (action `record.read`, resource `<public base>/t/<tenant>/records`), and
// the parser is the one that the deps give for the record set. The codes of this read are `record_read_timeout` for a job that ran out of time and `record_set_invalid` for a body that the parser refuses. The
// agent itself never reads a record: the token is the token of the subagent, under its own sub-delegation.
import { tokenTarget } from '@vsa/usecase-kit/access';
import type { RecordSet } from '@vsa/usecase-kit/priorauth';
import type { EvidenceDeps, EvidenceRequest, EvidenceRun } from './ports.ts';
import { failedRead, readThroughSubagent } from './subread.ts';
import type { SubreadResult } from './subread.ts';

/**
 * Reads the record set of the order of the request through `record-reader`, and ends its sub-delegation. The result is the record set that `deps.parseRecordSet` checked, or the code of the failure (see
 * `readThroughSubagent`). A tenant or an order id that makes no route is `internal`, and nothing is sent.
 */
export async function readRecords(deps: EvidenceDeps, request: EvidenceRequest, run: EvidenceRun): Promise<SubreadResult<RecordSet>> {
  const target = tokenTarget(deps.calls.bases, request.tenant, 'records.order', { order_id: request.order_id });
  if (target.ok !== true) return failedRead(deps, 'record-reader', 'internal');
  return readThroughSubagent(deps, request, run, {
    name: 'record-reader',
    subagent: deps.subagents.record_reader,
    target: target.value,
    timeoutCode: 'record_read_timeout',
    invalidCode: 'record_set_invalid',
    parse: deps.parseRecordSet,
  });
}
