// packages/usecase-kit/src/checks/index.ts
// The checks of a counterparty: what the Order Desk, the Insurer Intake Agent and the bid desk check before they do the work. The shared checks (the sender, the delegation, the vault
// payment and the approval), the function that runs a list of checks, and the `precheck` option of service-kit.
// Import it as `@vsa/usecase-kit/checks`.
export { CheckUnavailableError, ledgerPortOf } from './ports.ts';
export type { ChecksPorts, LedgerPort } from './ports.ts';
export { runChecks } from './run.ts';
export type { CheckCode, CheckStep, ChecksOutcome, ChecksPassed, ChecksRecord, ChecksRefused, DigestPair, Facts, StepRefused, StepResult } from './run.ts';
export { checkSenderAccountable, checkSenderActive, checkSenderKey } from './sender.ts';
export type { ResolvedSender, SenderFacts } from './sender.ts';
export { checkDelegationNamesSender, checkDelegationUsable, checkVaultPaid } from './delegation.ts';
export { approvalCheckOf, checkApproval } from './approval.ts';
export { SHARED_CHECK_NAMES, sharedChecks } from './shared.ts';
export type { RequestOf, SharedInput } from './shared.ts';
export { precheckOf } from './precheck.ts';
export type { ExtraCheck, PrecheckOptions } from './precheck.ts';
