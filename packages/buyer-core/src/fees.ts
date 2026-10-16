// packages/buyer-core/src/fees.ts
// What a transaction paid, and what a buyer counts for one before it is built. Signing adds a witness and leaves the body as the build made it, so the
// fee of a signed transaction is the fee the build chose, and it is the number the job's accounting adds up.
import { CML } from '@lucid-evolution/lucid';
import { MARKETPLACE_MIN_FEE } from './vendored/mcp/marketplace-constants.ts';

/** The fee of a signed transaction in lovelace: the fee field of its body. */
export function feeOfSignedTx(signedCborHex: string): bigint {
  return CML.Transaction.from_cbor_hex(signedCborHex).body().fee();
}

/**
 * The fee a buyer counts for one marketplace transaction (a Post, an Accept) when it checks its float before it posts anything: the marketplace fee
 * floor, 500000 lovelace, which every marketplace transaction is built with (setMinFee in the vendored builders and in fleet-build.ts). A build chooses
 * more only for a transaction too large or too costly for the floor to pay, so this is what a Post or an Accept of a fleet job pays, and a margin above
 * it is the caller's to keep.
 */
export const TX_FEE_BUDGET_LOVELACE: bigint = MARKETPLACE_MIN_FEE;
