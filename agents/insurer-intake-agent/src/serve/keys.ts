// agents/insurer-intake-agent/src/serve/keys.ts
// What the service makes of its key, from its value. The value is read in start.ts, the one file that names a key variable, and given here as a parameter: no key is read in this file, and no file. A key becomes a
// signer of transactions (`txSignerOfRawKey` of the kit), a key object (`keyObjectOfRawKey` of the kit, for the subject token and the proof of a call), the function that signs a Module-1 transaction, and its public
// values (the key hash, the address of its wallet and its public key). The object that this file makes has no member that holds the key as text: the key stays in the closures of the signers and in the key object,
// which shows nothing of it to `JSON.stringify`, `inspect` or `toString`.
//
// The service holds one key, the service key. It pays the model hire, signs the claims and the challenges of the dispute code, and signs the subject token of its request for a JWT-SVID. It is not the supplier
// key: that one is the key of the runtime.
import { createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { rawHexToBech32, signTransaction } from '@vsa/buyer-core';
import { txSignerOfRawKey } from '@vsa/usecase-kit/access';
import type { RawKeySigner } from '@vsa/usecase-kit/access';
import { keyObjectOfRawKey } from '@vsa/usecase-kit/live';

/** The keys of the service, by the job of each. */
export const KEY_ROLES = ['service'] as const;
export type KeyRole = (typeof KEY_ROLES)[number];

export interface KeyMaterial {
  /** The key hash: 56 lower-case hex characters. */
  readonly pkh: string;
  /** The mainnet enterprise address of the wallet of the key. */
  readonly address: string;
  /** The public key: 64 lower-case hex characters. */
  readonly publicKeyHex: string;
  /** Signs a transaction. Its key hash is `pkh`. */
  readonly signer: RawKeySigner;
  /** The key as a key object: the key of the subject token and of the proof of a call. */
  readonly keyObject: KeyObject;
  /** The transaction with the witness of the key added, and its hash. It is the signer of the Module-1 code. */
  signUnsigned(unsignedCborHex: string): { readonly signedCborHex: string; readonly txHashHex: string };
  /**
   * Gives the key, as 64 lower-case hex characters, to `use` and to nobody else. The chain of the buyer code takes a key in that form, and this is the one door through which the key leaves this object.
   * The object has no member that holds the key, so `JSON.stringify`, `inspect` and a log line of the object show none.
   */
  withKey<T>(use: (privateKeyHex: string) => T): T;
}

/** The public key of a key object, as 64 lower-case hex characters. */
function publicKeyOf(key: KeyObject): string {
  const x = createPublicKey(key).export({ format: 'jwk' }).x;
  if (typeof x !== 'string') throw new Error('the public key of the key cannot be read');
  return Buffer.from(x, 'base64url').toString('hex');
}

/** The key material of a raw key: 64 lower-case hex characters. A value that is not a key is refused with an error that never repeats it. */
export function keyOf(privateKeyHex: string): KeyMaterial {
  const signer = txSignerOfRawKey(privateKeyHex);
  const keyObject = keyObjectOfRawKey(privateKeyHex);
  const bech32 = rawHexToBech32(privateKeyHex);
  return {
    pkh: signer.keyHash,
    address: signer.address,
    publicKeyHex: publicKeyOf(keyObject),
    signer,
    keyObject,
    signUnsigned: (unsignedCborHex) => signTransaction(unsignedCborHex, bech32),
    withKey: (use) => use(privateKeyHex),
  };
}

/** A key that is the supplier key. */
export interface KeyClash {
  readonly kind: 'supplier';
  readonly role: KeyRole;
}

/**
 * The first key that is the supplier key, or null when each key is a key of its own. The supplier key is the key of the runtime, and a service that held it could sign as the runtime. A key is known by its key
 * hash, in any case.
 */
export function keyClashOf(keys: Readonly<Record<KeyRole, KeyMaterial>>, supplierPkh: string): KeyClash | null {
  const supplier = supplierPkh.toLowerCase();
  const role = KEY_ROLES.find((name) => keys[name].pkh.toLowerCase() === supplier);
  return role === undefined ? null : { kind: 'supplier', role };
}
