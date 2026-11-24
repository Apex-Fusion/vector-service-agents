// agents/prior-authorization-agent/src/evidence/index.ts
// The evidence of the Prior Authorization Agent (use case 2, prior authorization): the record set of an order and the guideline of its service, each read through its own subagent, under its own
// sub-delegation and with its own token, one read after the other. Every source of data comes in through a port: this folder reads no environment variable and no key, and it does not import the folders of the
// other jobs (`model`, `propose`, `execute` and `serve`).
//
//   read          `readEvidence`: the two reads in order (src/read.ts)
//   records       the first read: the order and its record set, through `record-reader` (src/records.ts)
//   guideline     the second read: the guideline of the service of the order, through `drafter` (src/guideline.ts)
//   subread       one read through one subagent, the budgets of a read, and `EVIDENCE_FAILURES`, the codes of a failed read (src/subread.ts)
//   bookkeeping   the list of left sub-delegations and the set of the sub-delegations in use, kept in step with each read (src/bookkeeping.ts)
//   ports         `EvidenceDeps` and the types of its members (src/ports.ts)
export { readEvidence } from './read.ts';
export { EVIDENCE_FAILURES } from './subread.ts';
export type {
  DelegationKey, EvidenceDeps, EvidenceRequest, EvidenceResult, EvidenceRun, InFlight, LeftEntry, LeftSink, Subagent, SubagentName,
} from './ports.ts';
