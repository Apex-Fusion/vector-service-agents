// packages/usecase-kit/src/buyer/index.ts
// The flow of a buyer-side agent: the two operations, the authority check, the Live vault of the delegation, the handoff to the counterparty from the vault, the size check before the Pay, the
// map from the outcome of the hire kit to a step, and the results. Import it as `@vsa/usecase-kit/buyer`.
export { checkLimits, LIMIT_NAMES } from './limits.ts';
export type { HireLimits } from './limits.ts';
export { ledgerReadsFrom } from './ports.ts';
export type { DelegationReading, LedgerReads, LiveVaults } from './ports.ts';
export { checkAuthority, delegationAfter, readingOf } from './authority.ts';
export type { AuthorityRefusal, DelegationAfter, DelegationState } from './authority.ts';
export { findLiveVault } from './vault.ts';
export type { VaultRefusal, VaultSearch } from './vault.ts';
export { BODY_ESCROW_REF, checkRuntimeBody, handoffOf, messageOf, requestText, runtimeBody } from './message.ts';
export type { CounterpartyMessage, HandoffSource } from './message.ts';
export { COUNTERPARTY_REFUSED, INCONSISTENT_OUTCOME, afterClaimRefusalIn, deliveryOf, failure, recordOf, stepOfOutcome } from './outcome.ts';
export type { AfterClaimRefusal, StepContext } from './outcome.ts';
export { hireCounterparty } from './hire.ts';
export type { DeliveryDecision, HandoffHireInput, HireDeps, HireInput, QuoteHireInput } from './hire.ts';
export type {
  CompletedStep, FailedStep, HireStep, InterruptedStep, InterruptionCause, NotAcceptedStep, PayUnconfirmedStep, RefusedByCounterpartyStep, RefusedCode, RefusedStep, VaultRefusedStep,
  VerifiedDelivery,
} from './steps.ts';
export {
  BAD_DOCUMENT, INTERRUPTION_REASONS, PAY_UNCONFIRMED, completedResult, disputedResult, failedProposalResult, failedResult, proposedResult, refusedResult, settledResult, vaultRefusedResult,
} from './results.ts';
export type { ProposalPieces, ResultPieces, SettledStep } from './results.ts';
