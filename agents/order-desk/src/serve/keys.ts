// agents/order-desk/src/serve/keys.ts
// The keys of the Order Desk as values. This file reads no environment variable and no key file: start.ts reads the service key one time and gives it here as text. What comes out is what the other files need
// and nothing else: the key hash and the address that the key derives, the key object that signs the request for the X.509-SVID, and the function that signs a transaction. None of them shows the key. The
// three supplier keys are the keys of the runtimes: this service holds their key hashes and public keys only, and no source of the service names a supplier private key.
import type { KeyObject } from 'node:crypto';
import { buyerIdentityOf, rawHexToBech32, signTransaction } from '@vsa/buyer-core';
import { LOT_NAMES } from '@vsa/usecase-kit/inventory';
import type { LotName } from '@vsa/usecase-kit/inventory';
import { keyObjectOfRawKey } from '@vsa/usecase-kit/live';
import type { SupplierKey } from './settings.ts';

/** What the service holds of its key. The key itself is in the closures and in the key object, and no member shows it. */
export interface ServiceKey {
  /** The key hash: 56 lower-case hex characters. The manifest publishes it. */
  readonly pkh: string;
  /** The mainnet enterprise address of the key: the wallet that pays for the model hires and the transactions of the dispute code. */
  readonly address: string;
  /** The Ed25519 key object that signs the request for the X.509-SVID. */
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

/** Two keys that must differ and do not: the service key and the key of a runtime, or the keys of two runtimes. */
export type KeyClash = { readonly kind: 'service'; readonly lot: LotName } | { readonly kind: 'runtimes'; readonly first: LotName; readonly second: LotName };

/**
 * The first clash among the keys, or null. The service key is not the key of a runtime: the supplier keys are the runtimes', and a service that held one could sign as a runtime. Each runtime has a key of its
 * own: two runtimes with one key can spend the same outputs. A key is known by its key hash.
 */
export function keyClashOf(service: Pick<ServiceKey, 'pkh'>, suppliers: Readonly<Record<LotName, SupplierKey>>): KeyClash | null {
  for (const lot of LOT_NAMES) if (suppliers[lot].pkh === service.pkh) return { kind: 'service', lot };
  for (const [index, second] of LOT_NAMES.entries()) {
    const first = LOT_NAMES.slice(0, index).find((lot) => suppliers[lot].pkh === suppliers[second].pkh || suppliers[lot].pubKeyHex === suppliers[second].pubKeyHex);
    if (first !== undefined) return { kind: 'runtimes', first, second };
  }
  return null;
}
