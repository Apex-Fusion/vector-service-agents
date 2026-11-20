// packages/usecase-kit/src/access/signer.ts
// A transaction signer for a raw delegation key. The caller gives the key as 64 lower-case hex characters, the form that the key tool of the agent template prints. This folder reads no key file and
// no environment variable. The key stays in the closure of `sign`: no property of the result, no JSON text and no log line shows it.
import { buyerIdentityOf, rawHexToBech32, signTransaction } from '@vsa/buyer-core';
import type { TxSigner } from './subdelegation.ts';

/** A signer, and the address of the wallet of its key: the enterprise address on mainnet. The wallet pays the fee of a transaction and gets a deposit back. */
export interface RawKeySigner extends TxSigner {
  readonly address: string;
}

/** The signer of a raw Ed25519 key. It throws a TypeError for a text that is not a key, and the message does not repeat the text. */
export function txSignerOfRawKey(privateKeyHex: string): RawKeySigner {
  const { buyerPkh, address } = buyerIdentityOf(privateKeyHex);
  const bech32 = rawHexToBech32(privateKeyHex);
  return { keyHash: buyerPkh, address, sign: (txCborHex) => signTransaction(txCborHex, bech32).signedCborHex };
}
