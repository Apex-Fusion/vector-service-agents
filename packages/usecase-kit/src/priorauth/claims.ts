// packages/usecase-kit/src/priorauth/claims.ts
// The capabilities, the model names and the claim statements of the two agents of use case 2 (prior authorization). The two agents are two packages and they do not import each other, so the kit holds what
// both read.
//
// The manifest of an agent, its claim document and the challenge of the other agent all use these constants. A challenge names the text of a statement, and the text must be the text that the claim
// document of the other agent holds, so there is one text for each statement and it stands here. A claim has three statements with the ids S1, S2 and S3 and no reference to a claim: a claim is staked
// for each run. Each text is plain: one line, no control character, and no space at either end.
//
// The constants are frozen, so that no code changes a text that two agents compare.
import type { ManifestClaim } from '../protocol/index.ts';

/** The capability of the Prior Authorization Agent (`draft`) and the capability of the Insurer Intake Agent (`intake`). A job of the Prior Authorization Agent hires the Insurer Intake Agent, and a challenge names both. */
export const PRIORAUTH_CAPABILITIES = Object.freeze({ draft: 'health.priorauth.draft.v1', intake: 'health.priorauth.intake.v1' } as const);

/** The model of the advert and of the receipt of each agent: `draft` for the Prior Authorization Agent, and `intake` for the Insurer Intake Agent. */
export const PRIORAUTH_MODELS = Object.freeze({ draft: 'prior-authorization-agent-v1', intake: 'insurer-intake-agent-v1' } as const);

function claimOf(first: string, second: string, third: string): ManifestClaim {
  return Object.freeze({
    statements: Object.freeze([Object.freeze({ id: 'S1', text: first }), Object.freeze({ id: 'S2', text: second }), Object.freeze({ id: 'S3', text: third })] as const),
  });
}

/** The claim of the Prior Authorization Agent. */
export const PRIORAUTH_CLAIM: ManifestClaim = claimOf(
  'A request this agent submits is byte-identical to the document whose digest its hirer approved.',
  'The record set hash in a request is the hash of the set its drafter was given.',
  'This agent reads records and guidelines only through its subagents, each with its own token under its own sub-delegation.',
);

/** The claim of the Insurer Intake Agent. */
export const INTAKE_CLAIM: ManifestClaim = claimOf(
  'This agent issues an intake record only for a request with a valid sign-off by the party whose delegation paid for it.',
  'An intake record names the hash of the request this agent received.',
  'This agent files one entry per request number.',
);
