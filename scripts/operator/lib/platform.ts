// scripts/operator/lib/platform.ts - the one place where the operator pack imports the packages of this repository. The pack is no workspace package, so it reaches each package by the path of
// its entry file. This file gives everything that the checks give (`../../checks/lib/platform.ts`: the builders of buyer-core, the decoder, the gateway client) and adds the names that the tasks
// of the pack call: the kit of the use-case agents, more builders of buyer-core, and the envelope of an attestation. `ATT_TYPES`, `readVaults` and `createGatewayClient` come with the checks.
export * from '../../checks/lib/platform.ts';

// The kit of the use-case agents. `isFaultSetting` is in the entry of the protocol, and the entry of the fault switch does not give it.
export { Dispute, MAX_CLAIM_TYPE_BYTES, claimDocument, createModule1Port, evidenceDocument, withdrawableFrom } from '../../../packages/usecase-kit/src/dispute/index.ts';
export { addToAllowlist, parseAllowlist } from '../../../packages/usecase-kit/src/cosign/index.ts';
export { FAULT_MODE_VARIABLE, checkCleanRun, checkFaultRun } from '../../../packages/usecase-kit/src/fault/index.ts';
export {
  INVENTORY_CAPABILITIES, LOT_NAMES, ORDER_DESK_CLAIM, REORDER_CLAIM, parseOrderConfirmation, parsePurchaseOrder,
} from '../../../packages/usecase-kit/src/inventory/index.ts';
export { canonicalJson, canonicalSha256, isFaultSetting } from '../../../packages/usecase-kit/src/protocol/index.ts';
export { requestRouteToken } from '../../../packages/usecase-kit/src/access/index.ts';
export { keyObjectOfRawKey } from '../../../packages/usecase-kit/src/live/index.ts';

// More of buyer-core. `ensureSlotConfig` sets the slot clock of Vector: a task calls it before it sets a `validTo`.
export {
  ensureSlotConfig, buildDocumentPublish, buildSubmitClaim, buildWithdrawClaim, checkAttestation, envelopeSigStructure, envelopeVerifies, liveDelegations, module1FromManifest, readDelegation,
  readManifest, escrowPaidFromVault, verifyReceipt,
} from '../../../packages/buyer-core/src/index.ts';
export type { LedgerEnv } from '../../../packages/buyer-core/src/index.ts';
