// agents/sourcing-agent/src/execute/index.ts
// The job `execute` of the Sourcing Agent (use case 3, supplier bid evaluation): it writes the ranking that the hirer approved to the sourcing record, with one token and one call, and answers with a result
// of the protocol. The job makes no model call, no hire and no vault Pay, and it never checks, makes, replaces or defaults an approval: the sourcing record checks it. Every source of data comes in through
// a port: this folder reads no file, no environment variable and no key, and it does not import the other folders of the agent.
//
//   ports    what the job needs from outside (`ExecuteDeps`)
//   execute  the job, its deadline, its refusal and the closed list of the codes of a failed result
export { EXECUTE_DEADLINE_MS, EXECUTE_FAILURES, ExecuteRefusal, runExecute } from './execute.ts';
export type { DelegationKeyDeps, ExecuteDeps } from './ports.ts';
