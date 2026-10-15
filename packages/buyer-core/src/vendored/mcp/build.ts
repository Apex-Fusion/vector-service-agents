// packages/builder/src/vector/build.ts
//
// Keyless transaction building - the core of the non-custodial split's
// builder side. Every function here takes an already-initialized Lucid
// instance whose wallet was selected with selectWallet.fromAddress (no key
// material anywhere in this package) and returns UNSIGNED CBOR. Signing
// happens on the user's local signer; submission via vector_submit_transaction.
import {
  Lucid, fromText, Data, applyDoubleCborEncoding, validatorToAddress,
  validatorToScriptHash, getAddressDetails,
} from '@lucid-evolution/lucid';
import type { LucidEvolution, Provider, SpendingValidator, TxSignBuilder } from '@lucid-evolution/lucid';
import { lovelaceToAda } from '../mcp-shared/tx.js';
import type {
  TxOutput, VectorUnsignedBuildResult, VectorBuildDeployResult, VectorBuildInteractResult,
} from '../mcp-shared/types.js';

/**
 * Initialize Lucid for keyless building: validate the change address, fetch
 * its UTxOs, and select an address-only wallet (spike-proven: PR-4 spike (a)).
 * Validation happens BEFORE any provider call so a bad address fails fast
 * and cheap.
 */
export async function lucidForAddress(provider: Provider, changeAddress: string): Promise<LucidEvolution> {
  try {
    getAddressDetails(changeAddress);
  } catch (err) {
    throw new Error(`Invalid change address: ${err instanceof Error ? err.message : String(err)}`);
  }
  const lucid = await Lucid(provider, 'Mainnet');
  const utxos = await lucid.utxosAt(changeAddress);
  if (utxos.length === 0) {
    throw new Error(`No UTxOs found at ${changeAddress} - the wallet is empty or the address is wrong`);
  }
  lucid.selectWallet.fromAddress(changeAddress, utxos);
  return lucid;
}

export function toBuildResult(completed: TxSignBuilder): VectorUnsignedBuildResult {
  const txJson = (completed as any).toJSON?.() ?? {};
  const fee = String(txJson?.body?.fee ?? '0');
  return {
    txCbor: completed.toCBOR(),
    txHash: completed.toHash(),
    fee,
    feeAda: lovelaceToAda(fee),
  };
}
