// agents/prior-authorization-agent/src/propose/index.ts
// The job `propose` of the Prior Authorization Agent (use case 2, prior authorization): the delegation, the paying key, the advert of the insurer, the evidence of the records and the guideline, the model
// decision `justification`, and the authorization request. Every source of data comes in through a port: this folder reads no environment variable and no key, and it does not import the folders of the
// other parts of the agent (`model`, `evidence`, `insurer`, `counter`, `execute` and `serve`).
//
//   propose   `runPropose`, the refusal of a request that it cannot serve, the deadline and the time that it keeps for the decision, and the codes of a failed proposal (src/propose.ts)
//   ports     `ProposeDeps` and the types of its members (src/ports.ts)
export { DECISION_RESERVE_MS, PROPOSE_DEADLINE_MS, PROPOSE_FAILURES, ProposeRefusal, runPropose } from './propose.ts';
export type { DelegationKey, EvidenceRequest, EvidenceResult, EvidenceRun, JustificationChoice, JustifyAnswer, ProposeDeps, ProposeRequest } from './ports.ts';
