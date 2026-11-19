// scripts/checks/lib/platform.ts
// The one place where the mainnet checks import the packages of this repository. A script of this folder is no workspace package, so it cannot name a package: this file reaches
// each package by its path, and no other file of lib does. Each name below is one that a check calls.
//
// Names that the package index does not export yet (a deep import of a copy that the package holds): the delegation builders (`buildDelegate`, `buildUndelegate`), the vault builders
// (`buildVaultOpen`, `buildVaultClose`, `buildVaultPay` and the three errors of a refused Pay), the attestation builders (`buildAttest`, `buildWithdrawAttestation`), the deployment
// reader (`identityDeploymentFrom`, `makeIdentityDeployment`), the hash `blake2b256Hex`, and the IdentityContext and BuildCommon types. When the index of a package exports a name,
// move it to the first block of its package.
import type { RecordUtxo } from '../../../packages/buyer-core/src/vendored/mcp/identity-chain.ts';

export {
  AcceptWindowClosedError, ACCEPT_WINDOW_MS, DELIVER_BY_BUFFER_MS, OgmiosProvider, TxNotConfirmedError, VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, buildAccept, buildReclaim,
  buyerIdentityOf, enterpriseAddressOf, feeOfSignedTx, fetchSuppliers, koiosUtxoInfo, lucidForAddress, rawHexToBech32, readAdvert, resolveEscrowLineage, signTransaction,
} from '../../../packages/buyer-core/src/index.ts';
export type { Chain, ChainEscrowState, IdentityDeployment, PostResult } from '../../../packages/buyer-core/src/index.ts';

export { HIRE_ACTION, buildDelegate, buildUndelegate, escrowResource } from '../../../packages/buyer-core/src/vendored/mcp/delegation-build.ts';
export type { DelegateBuild, DelegateParams, UndelegateBuild } from '../../../packages/buyer-core/src/vendored/mcp/delegation-build.ts';
export { VaultPayImpossible, VaultPayNotEvaluated, VaultPayRefused, buildVaultClose, buildVaultOpen, buildVaultPay } from '../../../packages/buyer-core/src/vendored/mcp/vault-build.ts';
export type { VaultCloseBuild, VaultOpenBuild, VaultPayBuild } from '../../../packages/buyer-core/src/vendored/mcp/vault-build.ts';
export { ATT_TYPES, buildAttest, buildWithdrawAttestation } from '../../../packages/buyer-core/src/vendored/mcp/attestation-build.ts';
export type { AttestBuild, WithdrawBuild } from '../../../packages/buyer-core/src/vendored/mcp/attestation-build.ts';
export { identityDeploymentFrom, makeIdentityDeployment } from '../../../packages/buyer-core/src/vendored/mcp/identity-deployment.ts';
export { blake2b256Hex } from '../../../packages/buyer-core/src/vendored/mcp/jury-codec.ts';
export type { BuildCommon, IdentityContext } from '../../../packages/buyer-core/src/vendored/mcp/identity-build.ts';

export { decodeTransaction } from '../../../packages/vector-read/src/guarded-decode.ts';
export { decodeIdentityEscrowDatum, formatOutRef, parseOutRef } from '../../../packages/vector-read/src/index.ts';
export type { AdvertDatum, IdentityAdvertDatum } from '../../../packages/vector-read/src/index.ts';
export { decodeVaultDatum } from '../../../packages/vector-read/src/identity-codec.ts';
export type { ValueLimit } from '../../../packages/vector-read/src/identity-codec.ts';

export { createGatewayClient, createVerifier, keyHashOf, presentToken } from '../../../packages/id-kit/src/index.ts';
export type { GatewayClient, GatewayResult, Verifier } from '../../../packages/id-kit/src/index.ts';

/** An output of the ledger as Lucid and the builders hold it. */
export type Utxo = RecordUtxo['utxo'];
