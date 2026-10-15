// packages/buyer-core/src/fees.ts
// What a transaction paid. Signing adds a witness and leaves the body as the build made it, so the fee of a signed transaction is the
// fee the build chose, and it is the number the job's accounting adds up.
import { CML } from '@lucid-evolution/lucid';

/** The fee of a signed transaction in lovelace: the fee field of its body. */
export function feeOfSignedTx(signedCborHex: string): bigint {
  return CML.Transaction.from_cbor_hex(signedCborHex).body().fee();
}
