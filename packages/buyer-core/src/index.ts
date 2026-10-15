// packages/buyer-core/src/index.ts
// The public surface of @vsa/buyer-core, under stable names: the code the hosted keyless MCP server builds, reads and verifies with,
// and the signing function of the member's local signer (sign.ts; the hosted server never signs), all vendored from
// Apex-Fusion/mcp-server at 651ae93 (see VENDORED-FROM.md). Endpoint defaults are Vector mainnet.
export { planPostEscrow, buildPostEscrow, planAccept, buildAccept, planReclaim, buildReclaim, reserveCollateralInputs } from './vendored/mcp/marketplace-build.ts';
export { lucidForAddress } from './vendored/mcp/build.ts';
export { resolveEscrowLineage, readEscrowOutput, readSubmittedOutput, submittedRefsOf } from './vendored/mcp/marketplace-lineage.ts';
export { fetchSuppliers, fetchSupplier, readAdvert, koiosUtxoInfo, koiosTxInputCreds } from './vendored/mcp/marketplace-indexer.ts';
export { verifyReceipt, verifyJob } from './vendored/mcp/marketplace-verify.ts';
export { OgmiosProvider } from './vendored/mcp-shared/provider.ts';
export { signTransaction } from './vendored/signer/sign.ts';
export { rawHexToBech32 } from './signing.ts';
export { ensureSlotConfig, paymentKeyHashOf } from './vendored/mcp/gov-build.ts';
export { ESCROW_REF_UTXO, ACCEPT_WINDOW_MS, DELIVER_BY_BUFFER_MS, MARKETPLACE_MIN_FEE } from './vendored/mcp/marketplace-constants.ts';
export { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from './vendored/mcp-shared/config.ts';
