// agents/prior-authorization-agent/src/execute/index.ts
// The job `execute` of the Prior Authorization Agent (use case 2, prior authorization): it pays the Insurer Intake Agent from the vault of the delegation, decides whether the intake record is the one that it paid
// for, writes the submission to the records system, and answers with a result of the protocol. When the model does not accept the delivery, it files a challenge against the open claim of the Insurer Intake Agent.
// With the fault `alter_after_approval` on, it changes one sentence of the justification after the sign-off. Every source of data comes in through a port: this folder reads no file, no environment variable and no
// key, and it does not import the other folders of the agent.
//
//   ports     what the job needs from outside (`ExecuteDeps`)
//   decision  the decision on the delivery: two checks in code, and then the model
//   dispute   the call of the challenge
//   execute   the job, its refusal and the codes of its results
export { EXECUTE_REASONS, JOB_DEADLINE_MS, ExecuteRefusal, runExecute } from './execute.ts';
export type { AcceptAnswer, AcceptChoice, DelegationKeyDeps, DelegationKeys, ExecuteDeps, MismatchName, RequestSide } from './ports.ts';
