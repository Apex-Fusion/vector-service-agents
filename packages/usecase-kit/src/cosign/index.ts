// packages/usecase-kit/src/cosign/index.ts
// The co-signature route of a buyer-side agent: `POST /cosign/delegate`. A member builds a Delegate transaction for the agent. The agent signs it with one of its delegation keys, only when the transaction is
// the one Delegate that the rule allows, and it adds that one witness and changes nothing else. Import it as `@vsa/usecase-kit/cosign`.
export {
  COSIGN_PATH, COSIGN_REFUSALS, COSIGN_STATUS, MAX_COSIGN_REQUEST_BYTES, MAX_SPENT_OUTPUTS, MAX_TRANSACTION_HEX, MAX_WINDOW_MS, RESERVATION_MARGIN_MS, SLOT_MS,
} from './codes.ts';
export type { CosignCode, CosignErrorBody, CosignRefusal } from './codes.ts';
export { Allowlist, MAX_ALLOWLIST_BYTES, MAX_ALLOWLIST_KEYS, addToAllowlist, parseAllowlist } from './allowlist.ts';
export { COSIGN_SETTINGS, DEFAULT_LIMITS, checkCosignSettings, parseCosignSettings } from './settings.ts';
export type { CosignLimits, CosignSettings } from './settings.ts';
export { providerLedger } from './ledger.ts';
export type { CosignLedger, LedgerOutput } from './ledger.ts';
export { KeyReservations } from './register.ts';
export type { ClaimResult, KeyClaim, KeyRegister } from './register.ts';
export { COSIGN_MANIFEST, createCosignRoute } from './route.ts';
export type { CosignConfig, CosignRoute, CosignSigned, DelegationKey } from './route.ts';
export type { CosignHandler, CosignHttpRequest, CosignHttpResponse } from './http.ts';
