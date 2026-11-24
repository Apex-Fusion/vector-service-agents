// agents/prior-authorization-agent/src/evidence/read.ts
// The evidence of the Prior Authorization Agent (use case 2, prior authorization): the record set of one order and the guideline of its service, read through TWO subagents. `record-reader` reads the order and
// its records under its own sub-delegation and with its own token. `drafter` then reads the guideline for the service code of that order, under its own sub-delegation and with its own token. The agent never
// reads a record or a guideline with its own token (statement S3 of its claim).
//
// The two reads run ONE AFTER THE OTHER. The guideline code comes from the order that the first read gave, and so the second read cannot start earlier. The first sub-delegation is ended, or recorded for the
// janitor, before the second Delegate is built. So no more than one sub-delegation of a job is alive, and no two Delegates of one key are pending together: a builder takes the id of a Delegate from the
// largest output of the wallet, and two pending Delegates of one key would get one id. The send hook of each read refuses an id that the list of left sub-delegations holds, as a second guard.
//
// A failed first read ends the evidence: the second sub-delegation is never made, and no token is asked for. A failed second read gives its code and none of the first evidence. The second read starts with the
// time that the first read left: it needs the least time of a read, and a first read that took long can leave too little, so the code is `deadline` and nothing is sent. Every failure of a read is the code of the
// read, and the log line of the failure names the subagent. See `subread.ts` for the codes.
import { readGuideline } from './guideline.ts';
import type { EvidenceDeps, EvidenceRequest, EvidenceResult, EvidenceRun } from './ports.ts';
import { readRecords } from './records.ts';
import { failedRead } from './subread.ts';

/** The service code of the order of a record set, or null when the parser gave a value that has no such text. The deps give the parser, so the value is checked here as an unknown value. */
function serviceCodeOf(set: unknown): string | null {
  if (typeof set !== 'object' || set === null) return null;
  const order: unknown = Reflect.get(set, 'order');
  if (typeof order !== 'object' || order === null) return null;
  const code: unknown = Reflect.get(order, 'service_code');
  return typeof code === 'string' ? code : null;
}

/**
 * Reads the record set of the order of the request, and then the guideline of the service of that order. The result holds both documents, or the code of the failure. A hang-up of the caller (`run.signal`)
 * stops the evidence before the next read starts: no Delegate, token or call starts after it, and a sub-delegation that was made is ended. `run.deadline` is a time of the clock of the deps. A throw of the
 * code of a sub-delegation itself is not hidden (see `readThroughSubagent`), and then the second read does not start.
 */
export async function readEvidence(deps: EvidenceDeps, request: EvidenceRequest, run: EvidenceRun): Promise<EvidenceResult> {
  const records = await readRecords(deps, request, run);
  if (records.ok !== true) return { ok: false, code: records.code };
  const serviceCode = serviceCodeOf(records.value);
  if (serviceCode === null) return failedRead(deps, 'record-reader', 'record_set_invalid');
  const guideline = await readGuideline(deps, request, run, serviceCode);
  if (guideline.ok !== true) return { ok: false, code: guideline.code };
  return { ok: true, record_set: records.value, guideline: guideline.value };
}
