// agents/bid-desk/src/serve/keys.ts
// The key of the Bid Desk as a value. This file reads no environment variable and no key file: start.ts reads the service key one time and gives it here as text. What comes out is what the other files need
// and nothing else: the key hash and the address that the key derives, the key object, and the function that signs a transaction. None of them shows the key. The supplier key is the key of the runtime:
// this service holds its key hash and its public key only, and no source of the service names a supplier private key.
import type { KeyObject } from 'node:crypto';
import { buyerIdentityOf, rawHexToBech32, signTransaction } from '@vsa/buyer-core';
import { keyObjectOfRawKey } from '@vsa/usecase-kit/live';
import type { SupplierKey } from './settings.ts';

/** What the service holds of its key. The key itself is in the closures and in the key object, and no member shows it. */
export interface ServiceKey {
  /** The key hash: 56 lower-case hex characters. The manifest publishes it. */
  readonly pkh: string;
  /** The mainnet enterprise address of the key: the wallet that pays for the model hire of each job. */
  readonly address: string;
  /** The Ed25519 key object of the key. */
  readonly authentication: KeyObject;
  /** Adds the signature of the key to an unsigned transaction. */
  readonly sign: (unsignedCborHex: string) => { readonly signedCborHex: string; readonly txHashHex: string };
}

/** The key of a raw Ed25519 key of 64 lower-case hex characters. A key of another form throws, and the message never repeats it. */
export function serviceKeyOf(privateKeyHex: string): ServiceKey {
  const bech32 = rawHexToBech32(privateKeyHex);
  const { buyerPkh, address } = buyerIdentityOf(privateKeyHex);
  return { pkh: buyerPkh, address, authentication: keyObjectOfRawKey(privateKeyHex), sign: (unsignedCborHex) => signTransaction(unsignedCborHex, bech32) };
}

/**
 * True when the service key is the supplier key. The supplier key is the runtime's: a service that held it could sign as the runtime, and the runtime and the service would spend the same outputs. A key is
 * known by its key hash, and the two hashes are compared in lower case.
 */
export function keyClashOf(service: Pick<ServiceKey, 'pkh'>, supplier: SupplierKey): boolean {
  return service.pkh.toLowerCase() === supplier.pkh.toLowerCase();
}
