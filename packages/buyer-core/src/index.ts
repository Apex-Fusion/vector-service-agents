// packages/buyer-core/src/index.ts
// The public surface of @vsa/buyer-core, under stable names: the code the hosted keyless MCP server builds, reads and verifies with,
// and the signing function of the member's local signer (sign.ts; the hosted server never signs), all vendored from
// Apex-Fusion/mcp-server at 94bd293, 2d95483 and ebce68a (see VENDORED-FROM.md), both escrow and advert layouts of the drain included (Part 2 sections 6.1 to 6.5).
// Endpoint defaults are Vector mainnet. The identity registry deployment a chain posts to and settles with is read once at start
// (deployment.ts). The commitments of the fleet jobs (OCR and Responses) come from commitments.ts, which composes the Responses code vendored
// from Apex-Fusion/agents-marketplace at 4c95c3f. The chain layer is buyer-core's own: the fleet Post (fleet-build.ts), the Chain interface
// with RealChain behind createRealChain (chain.ts), the in-memory FakeChain the service tests run against (fake-chain.ts), and the fee of a
// signed transaction (fees.ts). So is the HTTP side of a fleet hire: the clients that send a job to a supplier once its Post is made, poll it,
// and read /capability and /status (fleet-clients.ts), and the choice of the chat supplier and the OCR advert from the marketplace indexer
// (select-supplier.ts). Suppliers are reached only through safeFetch. What a supplier returns is checked before an escrow is accepted:
// verifyReceipt (vendored) is the hosted server's check, which hashes the result text, and verifyFleetReceipt (fleet-verify.ts) is the check of a
// fleet job, whose response hash is the one of a canonical envelope that the buyer recomputes.
export {
  planPostEscrow, buildPostEscrow, planAccept, buildAccept, planReclaim, buildReclaim, buildRefundRevoked, refundRevokedRefusal, reserveCollateralInputs, enterpriseAddressOf,
} from './vendored/mcp/marketplace-build.ts';
export { lucidForAddress } from './vendored/mcp/build.ts';
export { resolveEscrowLineage, readEscrowOutput, readSubmittedOutput, submittedRefsOf, isIdentityEscrow } from './vendored/mcp/marketplace-lineage.ts';
export type { EscrowLayout } from './vendored/mcp/marketplace-lineage.ts';
export { fetchSuppliers, fetchSupplier, readAdvert, koiosUtxoInfo, koiosTxInputCreds, rowAgentId } from './vendored/mcp/marketplace-indexer.ts';
export { verifyReceipt, verifyJob, RECEIPT_FIELDS, AGENT_RECEIPT_FIELDS } from './vendored/mcp/marketplace-verify.ts';
export { OgmiosProvider } from './vendored/mcp-shared/provider.ts';
export { signTransaction } from './vendored/signer/sign.ts';
export { rawHexToBech32, buyerIdentityOf } from './signing.ts';
export { ensureSlotConfig, paymentKeyHashOf } from './vendored/mcp/gov-build.ts';
// The vault and delegation builders, vendored from the same source (the vault Pay with `ledgerDecides`, Open and Close of a vault, Delegate and Undelegate), and the types of a build context.
export {
  buildVaultOpen, buildVaultPay, buildVaultClose, readVault, isLedgerRefusal, judgeEvaluation, VaultPayEvaluationError, VaultPayImpossible, VaultPayNotEvaluated, VaultPayRefused,
} from './vendored/mcp/vault-build.ts';
export type {
  ValidatorError, VaultCloseBuild, VaultOpenBuild, VaultOpenParams, VaultOwnerInput, VaultPayAttempt, VaultPayBuild, VaultPayImpossibleReason, VaultPayParams,
} from './vendored/mcp/vault-build.ts';
export {
  HIRE_ACTION, buildDelegate, buildUndelegate, delegationProblems, delegationUseProblems, escrowResource, liveDelegations, narrowingProblems, patternsCover, patternsOf, validActionPattern,
  validResourcePattern,
} from './vendored/mcp/delegation-build.ts';
export type { DelegateBuild, DelegateParams, DelegatorInput, UndelegateBuild, UndelegateParams } from './vendored/mcp/delegation-build.ts';
export type { BuildCommon, IdentityContext } from './vendored/mcp/identity-build.ts';
export { ESCROW_REF_UTXO, ACCEPT_WINDOW_MS, DELIVER_BY_BUFFER_MS, MARKETPLACE_MIN_FEE, MAX_ESCROW_LOVELACE } from './vendored/mcp/marketplace-constants.ts';
export { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from './vendored/mcp-shared/config.ts';
// What the operator scripts of the repo build and read with, so that they import it from the entry: the deployment that the environment describes (or that its parts make), the record
// of an identity and the rules of its status and purposes, the attestation builders, and the vault builders above.
export { identityDeploymentFrom, makeIdentityDeployment } from './vendored/mcp/identity-deployment.ts';
export type { DeployedScript, IdentityDeployment, OutRef, RefName } from './vendored/mcp/identity-deployment.ts';
export { findRecord } from './vendored/mcp/identity-chain.ts';
export type { RecordUtxo, SignedByBuild } from './vendored/mcp/identity-chain.ts';
export { PURPOSE, effectiveStatus } from './vendored/mcp/identity-rules.ts';
export type { Effective, PurposeName } from './vendored/mcp/identity-rules.ts';
export { ATT_TYPES, buildAttest, buildWithdrawAttestation } from './vendored/mcp/attestation-build.ts';
export type { AttestBuild, AttestParams, AttTypeName, IssuerSigner, WithdrawBuild } from './vendored/mcp/attestation-build.ts';
export { envelopeSigStructure, envelopeVerifies } from './vendored/mcp/attestation-build.ts';
export type { EnvelopeFields } from './vendored/mcp/attestation-build.ts';
export { buyerIdentityDeployment, buyerVaultDeployment, BUYER_IDENTITY_SETTINGS, VAULT_PAYER_IDENTITY_SETTINGS } from './deployment.ts';
export { ocrPromptHash, ocrResponseHash, responsesPromptHash, responsesResponseHash, responsesOutputText, requestSpecHash } from './commitments.ts';
export { planFleetPostEscrow, buildFleetPostEscrow, fleetPostTerms, isIdentityAdvert } from './fleet-build.ts';
export type { FleetPostPlan, FleetPostBuild, IdentityPostTerms } from './fleet-build.ts';
export { createRealChain, AcceptWindowClosedError, TxBuildTimeoutError, TxNotConfirmedError, BUILD_TIMEOUT_MS, AWAIT_TIMEOUT_MAX_MS, VAULT_PAY_VALID_MINUTES } from './chain.ts';
export type { Chain, ChainEscrowState, PostResult, RealChainOptions, VaultChain, VaultPayResult } from './chain.ts';
export { FakeChain } from './fake-chain.ts';
export type { FakeChainOptions, FakeVaultView } from './fake-chain.ts';
export { feeOfSignedTx, TX_FEE_BUDGET_LOVELACE } from './fees.ts';
export { readCapability, probeStatus, sendOcrJob, sendResponsesJob, pollOcrJob, pollResponsesJob } from './fleet-clients.ts';
export type { FetchLike, SupplierCapability, Receipt, SendResult, PollResult } from './fleet-clients.ts';
export { selectLlmSupplier, findOcrAdvert, LLM_SELECTION_BUDGET_MS, LLM_SELECTION_MAX_CANDIDATES } from './select-supplier.ts';
export type { LlmSupplierChoice, OcrAdvertListing } from './select-supplier.ts';
// The read and check code of the identity registry and the Module-1 builders, vendored from Apex-Fusion/mcp-server at 2d95483 and ebce68a (VENDORED-FROM.md).
// The reads work on a LedgerEnv (the node, the deployment, Koios) and end inside one budget. The builders take Lucid bound to the wallet, the node
// and the Module-1 deployment, and return an unsigned transaction.
export { calculateMinLovelaceFromUTxO } from '@lucid-evolution/lucid';
export { MAX_PAGE, DEFAULT_PAGE, KOIOS_ANSWER_BYTES, READ_BUDGET_MS, BudgetSpent, TooManyMatches, withinBudget, utxoOfKoiosRow, soleTokenName, credentialOutputs, credentialPage, koiosTipHeight, dataOfKoiosJson, checkPage, pageOf } from './vendored/mcp/ledger-read.ts';
export type { LedgerEnv, ReadSession, CredentialFilter, Page } from './vendored/mcp/ledger-read.ts';
export { readAttestation, readAttestationDatum, attestationState, parseIssuer, issuerMatches, listAttestations, checkAttestation } from './vendored/mcp/attestation-read.ts';
export type { AttestationView, ReadDatum, AttestationState, IssuerRef, AttestationQuery, AttestationPage, CheckResult, CheckLine, AttestationExpectations, AttestationCheck } from './vendored/mcp/attestation-read.ts';
export { readDelegation, readChainRecords, isAction, isResource, checkDelegationUse } from './vendored/mcp/delegation-read.ts';
export type { DelegationView, DelegationUseParams, LinkConfirmations, DelegationUseCheck } from './vendored/mcp/delegation-read.ts';
export { periodAllowance, NOT_ON_NODE, readVaults, escrowPaidFromVault } from './vendored/mcp/vault-read.ts';
export type { VaultOutput, PeriodAllowance, SmallestEscrow, LiveVault, VaultReading, VaultPage, VaultSelector, EscrowVaultReason, EscrowVaultResult } from './vendored/mcp/vault-read.ts';
export { MODULE1_FEE_BUFFER, MAX_URI_BYTES, defaultChallengeWindow, buildSubmitClaim, findClaim, buildOpenChallenge, assertPayoutIsOutputZero, buildWithdrawClaim } from './vendored/mcp/module1-build.ts';
export type { Module1Context, SubmitClaimParams, SubmitClaimBuild, ClaimUtxo, OpenChallengeParams, OpenChallengeBuild, WithdrawClaimParams, WithdrawClaimBuild } from './vendored/mcp/module1-build.ts';
export { buildDocumentPublish } from './vendored/mcp/jury-build.ts';
export type { PublishParams, PublishBuild, JuryBuildCommon } from './vendored/mcp/jury-build.ts';
export { DOCUMENT_LABEL, CHUNK_MAX_BYTES, DOCUMENT_TYPES, DEFAULT_MEDIA_TYPE, MAX_DOCUMENT_BYTES, MAX_FETCH_BYTES, URI_PREFIX, documentHash, documentBytes, documentUri, txHashOfUri, readDocument } from './vendored/mcp/jury-document.ts';
export type { FetchedDocument, DocumentReadOpts } from './vendored/mcp/jury-document.ts';
export { MODULE1_MANIFEST_ENV, MODULE1_NOT_CONFIGURED, JuryConfigError, readManifest, module1FromManifest } from './vendored/mcp/jury-deployment.ts';
export type { Module1Deployment } from './vendored/mcp/jury-deployment.ts';
export { blake2b256Hex, decodeClaimDatum, decodeChallengeDatum } from './vendored/mcp/jury-codec.ts';
export type { ClaimDatum, ChallengeDatum, ClaimState, ChallengeState } from './vendored/mcp/jury-codec.ts';
export { verifyFleetReceipt } from './fleet-verify.ts';
export { flatText, isRecord } from './guards.ts';
export { indexerFetch } from './indexer-fetch.ts';
export type { FleetVerifyInput, FleetVerification } from './fleet-verify.ts';
