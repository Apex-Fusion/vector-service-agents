// packages/buyer-core/src/index.ts
// The public surface of @vsa/buyer-core, under stable names: the code the hosted keyless MCP server builds, reads and verifies with,
// and the signing function of the member's local signer (sign.ts; the hosted server never signs), all vendored from
// Apex-Fusion/mcp-server at 651ae93 (see VENDORED-FROM.md). Endpoint defaults are Vector mainnet. The commitments of the fleet jobs (OCR and
// Responses) come from commitments.ts, which composes the Responses code vendored from Apex-Fusion/agents-marketplace at e847a55. The chain
// layer is buyer-core's own: the fleet Post (fleet-build.ts), the Chain interface with RealChain behind createRealChain (chain.ts), the
// in-memory FakeChain the service tests run against (fake-chain.ts), and the fee of a signed transaction (fees.ts). So is the HTTP side of a fleet hire:
// the clients that send a job to a supplier once its Post is made, poll it, and read /capability and /status (fleet-clients.ts), and the choice of the
// chat supplier and the OCR advert from the marketplace indexer (select-supplier.ts). Suppliers are reached only through safeFetch. What a supplier
// returns is checked before an escrow is accepted: verifyReceipt (vendored) is the hosted server's check, which hashes the result text, and verifyFleetReceipt
// (fleet-verify.ts) is the check of a fleet job, whose response hash is the one of a canonical envelope that the buyer recomputes.
export { planPostEscrow, buildPostEscrow, planAccept, buildAccept, planReclaim, buildReclaim, reserveCollateralInputs } from './vendored/mcp/marketplace-build.ts';
export { lucidForAddress } from './vendored/mcp/build.ts';
export { resolveEscrowLineage, readEscrowOutput, readSubmittedOutput, submittedRefsOf } from './vendored/mcp/marketplace-lineage.ts';
export { fetchSuppliers, fetchSupplier, readAdvert, koiosUtxoInfo, koiosTxInputCreds } from './vendored/mcp/marketplace-indexer.ts';
export { verifyReceipt, verifyJob } from './vendored/mcp/marketplace-verify.ts';
export { OgmiosProvider } from './vendored/mcp-shared/provider.ts';
export { signTransaction } from './vendored/signer/sign.ts';
export { rawHexToBech32, buyerIdentityOf } from './signing.ts';
export { ensureSlotConfig, paymentKeyHashOf } from './vendored/mcp/gov-build.ts';
export { ESCROW_REF_UTXO, ACCEPT_WINDOW_MS, DELIVER_BY_BUFFER_MS, MARKETPLACE_MIN_FEE } from './vendored/mcp/marketplace-constants.ts';
export { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from './vendored/mcp-shared/config.ts';
export { ocrPromptHash, ocrResponseHash, responsesPromptHash, responsesResponseHash, responsesOutputText, requestSpecHash } from './commitments.ts';
export { planFleetPostEscrow, buildFleetPostEscrow } from './fleet-build.ts';
export type { FleetPostPlan } from './fleet-build.ts';
export { createRealChain, AcceptWindowClosedError, TxBuildTimeoutError, TxNotConfirmedError, BUILD_TIMEOUT_MS, AWAIT_TIMEOUT_MAX_MS } from './chain.ts';
export type { Chain, ChainEscrowState, PostResult, RealChainOptions } from './chain.ts';
export { FakeChain } from './fake-chain.ts';
export type { FakeChainOptions } from './fake-chain.ts';
export { feeOfSignedTx, TX_FEE_BUDGET_LOVELACE } from './fees.ts';
export { readCapability, probeStatus, sendOcrJob, sendResponsesJob, pollOcrJob, pollResponsesJob } from './fleet-clients.ts';
export type { FetchLike, SupplierCapability, Receipt, SendResult, PollResult } from './fleet-clients.ts';
export { selectLlmSupplier, findOcrAdvert, LLM_SELECTION_BUDGET_MS, LLM_SELECTION_MAX_CANDIDATES } from './select-supplier.ts';
export { verifyFleetReceipt } from './fleet-verify.ts';
export type { FleetVerifyInput, FleetVerification } from './fleet-verify.ts';
