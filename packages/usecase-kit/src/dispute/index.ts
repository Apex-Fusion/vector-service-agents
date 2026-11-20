// packages/usecase-kit/src/dispute/index.ts
// The Module-1 path of an agent: the documents for a juror, the claim of a run, the challenge of a buyer-side agent and of a counterparty, and the withdrawal. Import it as `@vsa/usecase-kit/dispute`.
export { EVIDENCE_STATEMENT, JUROR_MEDIA_TYPE, JUROR_RECORD_LIMIT_BYTES, MAX_JUROR_DOCUMENT_BYTES, claimDocument, evidenceDocument, jurorRecordSize, parseClaimToken } from './documents.ts';
export type {
  ApprovalDigestFacts, ClaimDocumentInput, DocumentCode, EvidenceDocumentInput, EvidenceFacts, EvidenceParties, JurorDocument, OrderConfirmationFacts, QuotePriceFacts,
} from './documents.ts';
export { challengeDeadlineOf, withdrawableFrom } from './ports.ts';
export type {
  ClaimView, Module1Port, OpenChallengeCall, OpenedChallenge, PublishCall, PublishedDocument, ServiceQueue, SubmitClaimCall, SubmittedClaim, TxNotBuilt, TxNotConfirmed, TxResult,
  WithdrawClaimCall, WithdrawnClaim,
} from './ports.ts';
export { Dispute } from './dispute.ts';
export type { ApprovalChallengeInput, DeliveryChallengeInput, DisputeDeps, DisputeSettings, RunClaimInput, WithdrawClaimInput } from './dispute.ts';
export { disputedFields } from './results.ts';
export type {
  ChallengeCode, ChallengeFiled, ChallengeNotFiled, ChallengeResult, ClaimLookupCode, ClaimWithdrawn, DisputeOutcome, DocumentLanded, RunClaimCode, RunClaimNotStaked, RunClaimResult,
  RunClaimStaked, SentNotConfirmed, WithdrawCode, WithdrawNotDone, WithdrawResult,
} from './results.ts';
export { createModule1Port } from './chain.ts';
export type { Module1PortDeps, Module1Provider } from './chain.ts';
