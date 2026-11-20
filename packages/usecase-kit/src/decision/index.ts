// packages/usecase-kit/src/decision/index.ts
// The model decisions of the use-case agents: one decision is one hire of a model from the service key, with the limits as required parameters, no second try, and the choice as the model gave it.
// A buyer-side agent and a counterparty both use it. Import it as `@vsa/usecase-kit/decision`.
//
//   decide                  makes one decision and returns the `Decision` of the protocol, or a typed failure that holds no decision
//   DecisionSpec            the definition of one decision: its name, its fixed instruction and the parser of its choice
//   ModelLimits             the four limits of a hire, all required: the allowlist, the price ceiling and the limits of the two bonds
//   checkLimits             the check that `decide` makes of the limits; parseModelAllowlist and parseMaxPrice read the two settings
//   buildPrompt             the prompt of a decision: the fixed text, the rules and the input as data in one marked block
export { decide } from './decide.ts';
export type { DecisionDeps } from './decide.ts';
export { DECISION_FAILURE_CODES } from './result.ts';
export type { DecideResult, DecisionFailure, DecisionFailureCode, Delivery, TypedDecision } from './result.ts';
export type { ChoiceParser, DecisionSpec } from './spec.ts';
export { LLM_MAX_PRICE_SETTING, LLM_MODEL_ALLOWLIST_SETTING, checkLimits, parseMaxPrice, parseModelAllowlist } from './limits.ts';
export type { ModelLimits } from './limits.ts';
export { INPUT_CLOSE, INPUT_OPEN, buildPrompt } from './prompt.ts';
