// agents/reorder-agent/src/execute/index.ts
// The job `execute` of the Reorder Agent (use case 1, inventory reorder): it pays the Order Desk from the vault of the delegation, decides whether the confirmation is the one that it paid for, writes the
// order to the PO store, and answers with a result of the protocol. When the model does not accept the delivery, it files a challenge against the open claim of the Order Desk. Every source of data
// comes in through a port: this folder reads no file, no environment variable and no key, and it does not import the other folders of the agent.
//
//   ports     what the job needs from outside (`ExecuteDeps`)
//   decision  the decision on the delivery: two checks in code, and then the model
//   execute   the job and its refusal
export { JOB_DEADLINE_MS, ExecuteRefusal, runExecute } from './execute.ts';
export type { AcceptAnswer, AcceptChoice, DelegationKeyDeps, DelegationKeys, ExecuteDeps, OrderField } from './ports.ts';
