// scripts/checks/lib/platform.ts
// The one place where the mainnet checks import the packages of this repository (the hire kit is the one other, in hire-adapter.ts). A script of this folder is no workspace package, so
// it cannot name a package: this file reaches each package by the path of its entry file, and no other file of lib does. Each name below is one that a check calls. Two files of vector-read
// have no name in its entry: the checked decoder of a transaction and the codec of the identity datums.
export {
  ACCEPT_WINDOW_MS, ATT_TYPES, AcceptWindowClosedError, DELIVER_BY_BUFFER_MS, HIRE_ACTION, OgmiosProvider, TxNotConfirmedError, VAULT_PAY_VALID_MINUTES, VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL,
  VECTOR_SUBMIT_URL, VaultPayImpossible, VaultPayNotEvaluated, VaultPayRefused, blake2b256Hex, buildAccept, buildAttest, buildDelegate, buildReclaim, buildUndelegate, buildVaultClose,
  buildVaultOpen, buildVaultPay, buildWithdrawAttestation, buyerIdentityOf, effectiveStatus, enterpriseAddressOf, escrowResource, feeOfSignedTx, fetchSuppliers, findRecord, identityDeploymentFrom,
  koiosUtxoInfo, lucidForAddress, makeIdentityDeployment, PURPOSE, rawHexToBech32, readAdvert, readVaults, resolveEscrowLineage, signTransaction, validActionPattern, validResourcePattern,
} from '../../../packages/buyer-core/src/index.ts';
export type {
  AttestBuild, BuildCommon, Chain, ChainEscrowState, DelegateBuild, DelegateParams, IdentityContext, IdentityDeployment, PostResult, RecordUtxo, UndelegateBuild, VaultChain, VaultCloseBuild,
  VaultOpenBuild, VaultPayBuild, VaultPayResult, WithdrawBuild,
} from '../../../packages/buyer-core/src/index.ts';

export { decodeTransaction } from '../../../packages/vector-read/src/guarded-decode.ts';
export { decodeIdentityEscrowDatum, formatOutRef, parseOutRef } from '../../../packages/vector-read/src/index.ts';
export type { AdvertDatum, IdentityAdvertDatum } from '../../../packages/vector-read/src/index.ts';
export { decodeVaultDatum } from '../../../packages/vector-read/src/identity-codec.ts';
export type { ValueLimit } from '../../../packages/vector-read/src/identity-codec.ts';

export { createGatewayClient, createVerifier, keyHashOf, presentToken } from '../../../packages/id-kit/src/index.ts';
export type { GatewayClient, GatewayResult, Verifier } from '../../../packages/id-kit/src/index.ts';

import type { RecordUtxo } from '../../../packages/buyer-core/src/index.ts';

/** An output of the ledger as Lucid and the builders hold it. */
export type Utxo = RecordUtxo['utxo'];
