// packages/usecase-kit/src/dispute/index.ts
// The Module-1 path of an agent: the documents for a juror, the claim of a run, the challenge of a buyer-side agent and of a counterparty, and the withdrawal. Import it as `@vsa/usecase-kit/dispute`.
export {
  EVIDENCE_STATEMENT, JUROR_MEDIA_TYPE, JUROR_RECORD_LIMIT_BYTES, MAX_JUROR_DOCUMENT_BYTES, claimDocument, evidenceDocument, evidenceReferences, jurorRecordSize, parseClaimToken, readClaimDocument,
} from './documents.ts';
export type {
  ApprovalDigestFacts, ClaimDocumentInput, DocumentCode, EvidenceDocumentInput, EvidenceFacts, EvidenceParties, EvidenceReferences, JurorDocument, OrderConfirmationFacts, QuotePriceFacts,
} from './documents.ts';
export { MAX_CLAIM_TYPE_BYTES, challengeDeadlineOf, withdrawableFrom } from './ports.ts';
export type {
  ChallengeView, ClaimView, DocumentAbsent, DocumentResult, EscrowJob, EscrowJobResult, Module1Port, NotAnEscrow, OpenChallengeCall, OpenedChallenge, PublishCall, PublishedDocument, ReadDocument,
  SubmitClaimCall, SubmittedClaim, TxNotBuilt, TxNotConfirmed, TxResult, WithdrawClaimCall, WithdrawnClaim,
} from './ports.ts';
export type { SerialQueue as ServiceQueue } from '../protocol/index.ts';
export { MemoryJournal } from './journal.ts';
export type { DisputeJournal, EndedRecord, FiledRecord, JobRecord, JobStep } from './journal.ts';
export { FileJournal } from './file-journal.ts';
export type { FileJournalOptions, JournalFs } from './file-journal.ts';
export { Dispute, LEAST_RESOLUTION_DEADLINE_MS } from './dispute.ts';
export type { ApprovalChallengeInput, ClaimScope, DeliveryChallengeInput, DisputeDeps, DisputeSettings, RunClaimInput, WithdrawClaimInput } from './dispute.ts';
export { disputedFields } from './results.ts';
export type {
  ChallengeCode, ChallengeFiled, ChallengeLanded, ChallengeNotFiled, ChallengeResult, ClaimLookupCode, ClaimWithdrawn, DisputeOutcome, DocumentLanded, RunClaimCode, RunClaimNotStaked,
  RunClaimResult, RunClaimStaked, SentNotConfirmed, WithdrawCode, WithdrawNotDone, WithdrawResult,
} from './results.ts';
export { createModule1Port } from './chain.ts';
export type { Module1PortDeps, Module1Provider } from './chain.ts';
